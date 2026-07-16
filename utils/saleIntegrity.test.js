const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCanonicalSaleItem,
  calculateRegionTotal,
  allocateSaleFinancialsToItems,
  buildEditedSaleItem,
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
    price: 12.5, subtotal: 25, total: 25, unitCost: 0, cost: 0,
    profit: 25, discount: 0, tax: 0, transportCost: 0, otherCharges: 0,
    region: "China", regionCode: "Cnnn",
  });
});

test("invalid product region pairs are rejected", () => {
  assert.throws(() => buildCanonicalSaleItem(
    { _id: "p", name: "P", region: "China", regionCode: "Bbbb" },
    { price: 1, quantity: 1 }
  ), /invalid region assignment/);
});

test("mixed receipt discount and charges are allocated without duplicating them", () => {
  const sale = {
    subtotal: 100,
    discount: 10,
    tax: 5,
    total: 95,
    items: [
      { regionCode: "Bbbb", price: 40, quantity: 1 },
      { regionCode: "Cnnn", price: 60, quantity: 1 },
    ],
  };
  const butembo = calculateRegionTotal(sale, "Bbbb");
  const china = calculateRegionTotal(sale, "Cnnn");
  assert.equal(butembo, 38);
  assert.equal(china, 57);
  assert.equal(butembo + china, sale.total);
});

test("unresolved legacy items are never assigned to a known region", () => {
  const sale = { total: 30, items: [{ price: 30, quantity: 1 }] };
  assert.equal(calculateRegionTotal(sale, "Bbbb"), 0);
  assert.equal(calculateRegionTotal(sale, "Cnnn"), 0);
});

test("item-level discount, charge, cost, net, and profit snapshots reconcile", () => {
  const items = [
    { subtotal: 40, cost: 10 },
    { subtotal: 60, cost: 20 },
  ];
  const allocated = allocateSaleFinancialsToItems(items, {
    discount: 10, tax: 5, transportCost: 3, otherCharges: 2,
  });
  assert.equal(allocated.reduce((sum, item) => sum + item.discount, 0), 10);
  assert.equal(allocated.reduce((sum, item) => sum + item.netTotal, 0), 100);
  assert.equal(allocated.reduce((sum, item) => sum + item.profit, 0), 70);
});

test("editing preserves the original region and cost snapshot even if the product moved", () => {
  const oldItem = { name: "Original", region: "Butembo", regionCode: "Bbbb", unitCost: 3 };
  const currentProduct = { _id: "p", name: "Original", region: "China", regionCode: "Cnnn", unitCost: 9 };
  const edited = buildEditedSaleItem(currentProduct, oldItem, { productId: "p", quantity: 2, price: 10 });
  assert.equal(edited.regionCode, "Bbbb");
  assert.equal(edited.unitCost, 3);
  assert.equal(edited.cost, 6);
});

test("an existing sale item remains editable after its product was deleted", () => {
  const oldItem = { name: "Deleted product", region: "China", regionCode: "Cnnn", unitCost: 4 };
  const edited = buildEditedSaleItem(null, oldItem, { productId: "deleted", quantity: 1, price: 12 });
  assert.equal(edited.name, "Deleted product");
  assert.equal(edited.regionCode, "Cnnn");
});
