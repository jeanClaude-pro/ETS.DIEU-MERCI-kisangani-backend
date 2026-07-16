const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCanonicalSaleItem,
  calculateRegionTotal,
} = require("./saleIntegrity");

test("region totals never include lines from the other region", () => {
  const sale = { items: [
    { regionCode: "Cnnn", price: 10, quantity: 2, total: 999 },
    { regionCode: "Bbbb", price: 7, quantity: 3, total: 999 },
  ] };
  assert.equal(calculateRegionTotal(sale, "Cnnn"), 20);
  assert.equal(calculateRegionTotal(sale, "Bbbb"), 21);
});

test("canonical sale items ignore translated client names and region fields", () => {
  const product = {
    _id: "product-1", name: "Original Name", originalName: "Original Name",
    region: "China", regionCode: "Cnnn",
  };
  const item = {
    name: "Nom traduit", region: "Butembo", regionCode: "Bbbb",
    price: 12.5, quantity: 2,
  };
  assert.deepEqual(buildCanonicalSaleItem(product, item), {
    productId: "product-1", name: "Original Name", quantity: 2,
    price: 12.5, total: 25, region: "China", regionCode: "Cnnn",
  });
});

test("invalid product region pairs are rejected", () => {
  assert.throws(() => buildCanonicalSaleItem(
    { _id: "p", name: "P", region: "China", regionCode: "Bbbb" },
    { price: 1, quantity: 1 }
  ), /invalid region assignment/);
});
