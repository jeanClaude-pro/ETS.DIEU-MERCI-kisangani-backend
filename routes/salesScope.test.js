const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const Sale = require("../models/Sale");
const salesRouter = require("./sales");

const handler = (method, path) => salesRouter.stack
  .find((layer) => layer.route?.path === path && layer.route.methods[method])
  .route.stack.at(-1).handle;

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

const chinaSale = { _id: "507f1f77bcf86cd799439012", saleId: "S-1", type: "sale", status: "completed", total: 50, items: [{ name: "X", regionCode: "Cnnn", subtotal: 50 }] };
const mixedSale = { ...chinaSale, items: [{ name: "B", regionCode: "Bbbb", subtotal: 30 }, { name: "C", regionCode: "Cnnn", subtotal: 20 }] };

async function withSale(sale, fn) {
  const originalFindById = Sale.findById;
  const originalFind = Sale.find;
  const originalUpdate = Sale.findByIdAndUpdate;
  const chain = { select: () => chain, lean: async () => sale };
  Sale.findById = () => chain;
  Sale.find = () => ({ select: () => ({ lean: async () => [] }) });
  let updated = false;
  Sale.findByIdAndUpdate = async () => { updated = true; return { ...sale, status: "completed" }; };
  try { return { result: await fn(), updated: () => updated }; } finally {
    Sale.findById = originalFindById; Sale.find = originalFind; Sale.findByIdAndUpdate = originalUpdate;
  }
}

const butemboUser = { role: "manager", regionScope: "Bbbb", _id: "u1", userId: "u1" };

test("a Butembo account cannot open a China-only sale", async () => {
  const res = fakeRes();
  await withSale(chinaSale, () => handler("get", "/:id")({ params: { id: chinaSale._id }, user: butemboUser, regionScope: "Bbbb" }, res));
  assert.equal(res.statusCode, 404);
});

test("a mixed sale shows only the viewer's region lines and share", async () => {
  const res = fakeRes();
  await withSale(mixedSale, () => handler("get", "/:id")({ params: { id: mixedSale._id }, user: butemboUser, regionScope: "Bbbb" }, res));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.items.map((item) => item.name), ["B"]);
  assert.equal(res.body.data.total, 30);
});

test("the reservation endpoints no longer exist", () => {
  const paths = salesRouter.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  for (const removed of ["/reservations/all", "/:id/complete", "/:id/pending"]) {
    assert.equal(paths.includes(removed), false, removed);
  }
});

test("listing refuses the other region for a scoped account", async () => {
  const res = fakeRes();
  await handler("get", "/")({ query: { region: "Cnnn" }, user: butemboUser, regionScope: "Bbbb" }, res);
  assert.equal(res.statusCode, 403);
});
