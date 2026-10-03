const test = require("node:test");
const assert = require("node:assert/strict");
const { saleEditDenial, stripCostFields, stripCostFieldsFromList, canSeeCosts } = require("./saleAccess");

const admin = { role: "admin" };
const manager = { role: "manager" };
const staff = { role: "staff" };
const completedSale = { type: "sale", status: "completed" };

test("saleEditDenial: staff and manager cannot edit a completed sale (403)", () => {
  assert.equal(saleEditDenial(staff, completedSale).status, 403);
  assert.equal(saleEditDenial(manager, completedSale).status, 403);
});

test("saleEditDenial: admin can edit a completed sale", () => {
  assert.equal(saleEditDenial(admin, completedSale), null);
  assert.equal(saleEditDenial(admin, completedSale, "sale"), null);
});

test("saleEditDenial: a sale can never be turned into an expense, even by admin", () => {
  assert.equal(saleEditDenial(admin, completedSale, "expense").status, 400);
  assert.equal(saleEditDenial(staff, completedSale, "expense").status, 400);
});

test("saleEditDenial: an expense record stays an expense and is admin-only", () => {
  const expense = { type: "expense", status: "expense" };
  assert.equal(saleEditDenial(staff, expense).status, 403);
  assert.equal(saleEditDenial(admin, expense), null);
  assert.equal(saleEditDenial(admin, expense, "sale").status, 400);
});

test("saleEditDenial: existing reservation rules are preserved", () => {
  const pending = { type: "reservation", status: "pending" };
  const done = { type: "reservation", status: "completed" };
  assert.equal(saleEditDenial(manager, pending), null);
  assert.equal(saleEditDenial(staff, pending).status, 403);
  assert.equal(saleEditDenial(manager, done).status, 403);
  assert.equal(saleEditDenial(admin, done), null);
});

test("saleEditDenial: voided sales cannot be edited", () => {
  assert.equal(saleEditDenial(admin, { type: "sale", status: "voided" }).status, 400);
});

test("stripCostFields: staff never receive cost or margin data", () => {
  const sale = {
    _id: "1", total: 10, cost: 6, profit: 4,
    items: [{ name: "Riz", price: 10, unitCost: 6, cost: 6, profit: 4, quantity: 1 }],
  };
  const stripped = stripCostFields(sale, staff);
  assert.equal(stripped.cost, undefined);
  assert.equal(stripped.profit, undefined);
  assert.equal(stripped.items[0].unitCost, undefined);
  assert.equal(stripped.items[0].cost, undefined);
  assert.equal(stripped.items[0].profit, undefined);
  assert.equal(stripped.total, 10);
  assert.equal(stripped.items[0].price, 10);
  // The original object is not mutated.
  assert.equal(sale.cost, 6);
});

test("stripCostFields: admin and manager keep cost data", () => {
  const sale = { cost: 6, profit: 4, items: [{ unitCost: 6 }] };
  assert.equal(stripCostFields(sale, admin).cost, 6);
  assert.equal(stripCostFieldsFromList([sale], manager)[0].items[0].unitCost, 6);
  assert.equal(canSeeCosts(staff), false);
});
