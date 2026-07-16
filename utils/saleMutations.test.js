const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateItemQuantities, calculateStockDeltas } = require("./saleMutations");

test("duplicate product lines are aggregated before stock mutation", () => {
  assert.equal(aggregateItemQuantities([
    { productId: "p1", quantity: 2 }, { productId: "p1", quantity: 3 },
  ]).get("p1"), 5);
});

test("editing calculates one exact stock delta per product", () => {
  assert.deepEqual(calculateStockDeltas(
    [{ productId: "p1", quantity: 5 }, { productId: "removed", quantity: 2 }],
    [{ productId: "p1", quantity: 7 }, { productId: "new", quantity: 4 }],
  ), [
    { productId: "p1", delta: -2 },
    { productId: "removed", delta: 2 },
    { productId: "new", delta: -4 },
  ]);
});
