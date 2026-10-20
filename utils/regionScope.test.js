const test = require("node:test");
const assert = require("node:assert/strict");
const {
  userRegionScope, regionScopeError, resolveRegion, saleInRegion, projectSaleForScope,
  regionScopePlugin, runWithRegionScope, withoutRegionScope, currentRegionScope,
} = require("./regionScope");

test("admins always see both regions; others see their assigned region", () => {
  assert.equal(userRegionScope({ role: "admin", regionScope: "Bbbb" }), null);
  assert.equal(userRegionScope({ role: "manager", regionScope: "Cnnn" }), "Cnnn");
  assert.equal(userRegionScope({ role: "staff", regionScope: "all" }), null);
  assert.equal(userRegionScope({ role: "staff" }), null); // legacy accounts
});

test("shareholders need exactly one region; admins can never be limited", () => {
  assert.match(regionScopeError("shareholder", "all"), /exactly one region/);
  assert.equal(regionScopeError("shareholder", "Bbbb"), null);
  assert.match(regionScopeError("admin", "Cnnn"), /both regions/);
  assert.equal(regionScopeError("cashier_supervisor", "Cnnn"), null);
  assert.match(regionScopeError("staff", "Kinshasa"), /Invalid region/);
});

test("a scoped user is always given their region and refused the other one", () => {
  const butembo = { role: "shareholder", regionScope: "Bbbb" };
  assert.equal(resolveRegion(butembo, ""), "Bbbb");
  assert.equal(resolveRegion(butembo, "Bbbb"), "Bbbb");
  assert.throws(() => resolveRegion(butembo, "Cnnn"), (error) => error.status === 403);
  assert.equal(resolveRegion({ role: "manager", regionScope: "all" }, "Cnnn"), "Cnnn");
  assert.equal(resolveRegion({ role: "admin" }, ""), "");
  assert.throws(() => resolveRegion({ role: "admin" }, "XX"), (error) => error.status === 400);
});

const mixedSale = {
  _id: "s1", total: 100,
  items: [
    { name: "A", regionCode: "Bbbb", subtotal: 60, quantity: 1, price: 60 },
    { name: "B", region: "China", subtotal: 40, quantity: 1, price: 40 },
  ],
};

test("mixed sales: visible if any line is in the region, changeable only if all are", () => {
  assert.equal(saleInRegion(mixedSale, "Bbbb", "any"), true);
  assert.equal(saleInRegion(mixedSale, "Cnnn", "any"), true); // legacy `region` name is understood
  assert.equal(saleInRegion(mixedSale, "Bbbb", "all"), false);
  assert.equal(saleInRegion({ items: [{ regionCode: "Bbbb" }] }, "Bbbb", "all"), true);
  assert.equal(saleInRegion({ items: [{ regionCode: "Cnnn" }] }, "Bbbb", "any"), false);
  assert.equal(saleInRegion(mixedSale, null, "all"), true);
});

test("a scoped viewer sees only their lines and their region's share of the total", () => {
  const projected = projectSaleForScope(mixedSale, "Bbbb");
  assert.deepEqual(projected.items.map((item) => item.name), ["A"]);
  assert.equal(projected.total, 60);
  assert.equal(projected.regionScoped, true);
  assert.equal(projectSaleForScope(mixedSale, null), mixedSale);
});

function capturePlugin() {
  const hooks = [];
  regionScopePlugin({ pre: (event, fn) => hooks.push({ event, fn }) });
  return {
    query: hooks.find((hook) => hook.event instanceof RegExp).fn,
    aggregate: hooks.find((hook) => hook.event === "aggregate").fn,
    save: hooks.find((hook) => hook.event === "save").fn,
  };
}

test("every Entry/Expense/Product query in a scoped request is limited to that region", () => {
  const { query, aggregate, save } = capturePlugin();
  const conditions = [];
  const fakeQuery = { where: (condition) => conditions.push(condition) };
  const pipeline = [{ $match: { status: "active" } }];
  const fakeAggregate = { pipeline: () => pipeline };

  runWithRegionScope("Cnnn", () => {
    query.call(fakeQuery);
    aggregate.call(fakeAggregate);
  });
  assert.deepEqual(conditions, [{ regionCode: "Cnnn" }]);
  assert.deepEqual(pipeline[0], { $match: { regionCode: "Cnnn" } });

  // No scope (admin or both regions): nothing is added.
  runWithRegionScope(null, () => query.call(fakeQuery));
  assert.equal(conditions.length, 1);

  // A scoped request can never save a record for the other region.
  let saveError;
  runWithRegionScope("Bbbb", () => save.call({ regionCode: "Cnnn" }, (error) => { saveError = error; }));
  assert.equal(saveError?.status, 403);
  runWithRegionScope("Bbbb", () => save.call({ regionCode: "Bbbb" }, (error) => { saveError = error; }));
  assert.equal(saveError, undefined);
});

test("the scope follows async work and can be lifted for internal maintenance", async () => {
  await runWithRegionScope("Bbbb", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(currentRegionScope(), "Bbbb");
    await withoutRegionScope(async () => assert.equal(currentRegionScope(), null));
    assert.equal(currentRegionScope(), "Bbbb");
  });
  assert.equal(currentRegionScope(), null);
});
