const test = require("node:test");
const assert = require("node:assert/strict");
const rejectMongoOperators = require("./rejectMongoOperators");

function run(body) {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  let nextCalled = false;
  rejectMongoOperators({ body }, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test("rejectMongoOperators: operator keys anywhere in the body are a 400", () => {
  assert.equal(run({ email: { $ne: null }, password: "x" }).res.statusCode, 400);
  assert.equal(run({ items: [{ productId: { $gt: "" } }] }).res.statusCode, 400);
  assert.equal(run({ clientSaleId: { $gt: "" } }).res.statusCode, 400);
});

test("rejectMongoOperators: dotted keys are a 400", () => {
  assert.equal(run({ "customer.phone": "123" }).res.statusCode, 400);
});

test("rejectMongoOperators: ordinary sale payloads pass through", () => {
  const { res, nextCalled } = run({
    customer: { name: "Jean", phone: "0990000000" },
    items: [{ productId: "507f1f77bcf86cd799439011", quantity: 2, price: 4.5 }],
    notes: "Prix $5 négocié",
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test("rejectMongoOperators: empty bodies pass through", () => {
  assert.equal(run(undefined).nextCalled, true);
});
