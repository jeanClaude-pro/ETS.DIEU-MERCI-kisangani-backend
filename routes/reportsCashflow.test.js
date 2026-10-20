const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const Sale = require("../models/Sale");
const Entry = require("../models/Entry");
const Expense = require("../models/Expense");
const Product = require("../models/Product");
const reportsRouter = require("./reports");

// The final handler of GET /cashflow (auth and module gates run before it
// and are covered by their own tests).
const cashflowHandler = reportsRouter.stack
  .find((layer) => layer.route?.path === "/cashflow" && layer.route.methods.get)
  .route.stack.at(-1).handle;

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

const hasGroupBucket = (pipeline) => pipeline.some((stage) => stage.$group && typeof stage.$group._id === "object" && stage.$group._id?.$dateToString);
const hasUnwind = (pipeline) => pipeline.some((stage) => stage.$unwind);
const hasLookup = (pipeline) => pipeline.some((stage) => stage.$lookup);
const hasProfitGroup = (pipeline) => pipeline.some((stage) => stage.$group?.coveredItemCount && stage.$group._id === null);

async function runCashflow({ query, role = "admin", regionScope, capture = {} }) {
  const originals = {
    saleAggregate: Sale.aggregate, saleDistinct: Sale.distinct,
    entryAggregate: Entry.aggregate, expenseAggregate: Expense.aggregate,
    productCount: Product.countDocuments,
  };
  capture.salePipelines = [];
  capture.productQueries = [];
  Sale.aggregate = async (pipeline) => {
    capture.salePipelines.push(pipeline);
    if (hasGroupBucket(pipeline)) {
      return [{ _id: "2026-10-10T09", amount: 100, count: 2 }, { _id: "2026-10-10T15", amount: 50.5, count: 1 }];
    }
    if (hasLookup(pipeline)) {
      return [{ _id: "SHOES", revenue: 120, quantity: 3, grossProfit: 40, itemCount: 3, coveredItemCount: 3 },
        { _id: null, revenue: 30.5, quantity: 1, grossProfit: 0, itemCount: 1, coveredItemCount: 0 }];
    }
    if (hasProfitGroup(pipeline)) return [{ grossProfit: 40, coveredRevenue: 120, itemCount: 4, coveredItemCount: 3 }];
    if (hasUnwind(pipeline)) return [{ _id: { productId: "p1", name: "SANDALE" }, quantity: 3, revenue: 120 }];
    return [{ amount: 150.5, count: 3 }];
  };
  Sale.distinct = async () => ["p1"];
  Entry.aggregate = async (pipeline) => (hasGroupBucket(pipeline)
    ? [{ _id: "2026-10-10T11", amount: 20, count: 1 }]
    : [{ amount: 20, count: 1 }]);
  Expense.aggregate = async (pipeline) => {
    capture.expenseMatch = pipeline[0].$match;
    return hasGroupBucket(pipeline) ? [{ _id: "2026-10-10T15", amount: 10, count: 1 }] : [{ amount: 10, count: 1 }];
  };
  Product.countDocuments = async (filter) => { capture.productQueries.push(filter); return filter.$expr ? 2 : filter._id ? 5 : 9; };

  const res = fakeRes();
  try {
    await cashflowHandler({ query, user: { role, regionScope, _id: "u1" } }, res);
  } finally {
    Sale.aggregate = originals.saleAggregate;
    Sale.distinct = originals.saleDistinct;
    Entry.aggregate = originals.entryAggregate;
    Expense.aggregate = originals.expenseAggregate;
    Product.countDocuments = originals.productCount;
  }
  return res;
}

test("cashflow: one day is returned as 24 hourly buckets with matching totals", async () => {
  const res = await runCashflow({ query: { date: "2026-10-10" } });
  assert.equal(res.statusCode, 200);
  const { body } = res;
  assert.equal(body.granularity, "hour");
  assert.equal(body.series.length, 24);
  const nine = body.series.find((row) => row.key === "2026-10-10T09");
  assert.deepEqual([nine.sales, nine.salesCount], [100, 2]);
  const three = body.series.find((row) => row.key === "2026-10-10T15");
  assert.equal(three.net, 40.5);
  // Chart totals are the sum of the plotted buckets — no separate maths.
  assert.deepEqual(body.totals, { sales: 150.5, salesCount: 3, entries: 20, entriesCount: 1, expenses: 10, expensesCount: 1 });
  assert.equal(body.comparison.current.sales, 150.5);
  assert.equal(body.stock.lowStockCount, 2);
  assert.equal(body.stock.unsoldProducts, 5);
});

test("cashflow: only validated expenses and the analytics sale matcher are used", async () => {
  const capture = {};
  await runCashflow({ query: { date: "2026-10-10" }, capture });
  assert.equal(capture.expenseMatch.status, "validated");
  const saleMatch = capture.salePipelines[0][0].$match;
  assert.deepEqual(saleMatch.type, { $in: ["sale", "reservation"] });
  assert.deepEqual(saleMatch.status, { $in: ["completed", "pending", null] });
});

test("cashflow: admins get gross profit; roles without cost access never do", async () => {
  const admin = await runCashflow({ query: { date: "2026-10-10" }, role: "admin" });
  assert.equal(admin.body.profit.current.grossProfit, 40);
  assert.equal(admin.body.profit.current.coverage, 0.75);
  assert.equal(admin.body.categories[0].grossProfit, 40);

  const capture = {};
  const cashier = await runCashflow({ query: { date: "2026-10-10" }, role: "cashier_supervisor", capture });
  assert.equal(cashier.body.profit, null);
  assert.equal("grossProfit" in cashier.body.categories[0], false);
  assert.equal(capture.salePipelines.some(hasProfitGroup), false);
});

test("cashflow: deleted products are reported as uncategorised, not guessed", async () => {
  const res = await runCashflow({ query: { date: "2026-10-10" } });
  assert.equal(res.body.categories[1].category, null);
});

test("cashflow: region filter is applied to entries, expenses and products", async () => {
  const capture = {};
  await runCashflow({ query: { date: "2026-10-10", region: "Bbbb" }, capture });
  assert.equal(capture.expenseMatch.regionCode, "Bbbb");
  assert.ok(capture.productQueries.every((filter) => filter.regionCode === "Bbbb"));
});

test("cashflow: invalid region and invalid dates are client errors", async () => {
  assert.equal((await runCashflow({ query: { region: "XX" } })).statusCode, 400);
  const bad = await runCashflow({ query: { date: "2026-13-01" } });
  assert.equal(bad.statusCode, 400);
});

test("cashflow: a Butembo shareholder only ever gets Butembo figures, without profit", async () => {
  const capture = {};
  const res = await runCashflow({ query: { date: "2026-10-10" }, role: "shareholder", regionScope: "Bbbb", capture });
  assert.equal(res.statusCode, 200);
  assert.equal(capture.expenseMatch.regionCode, "Bbbb");
  assert.equal(res.body.filtersApplied.region, "Bbbb");
  assert.equal(res.body.profit, null);
  const refused = await runCashflow({ query: { date: "2026-10-10", region: "Cnnn" }, role: "shareholder", regionScope: "Bbbb" });
  assert.equal(refused.statusCode, 403);
});
