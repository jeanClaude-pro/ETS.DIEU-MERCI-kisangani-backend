const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveSaleCustomer, WALKIN_CUSTOMER_NAME } = require("./walkInCustomer");

test("a walk-in customer may provide an optional name", () => {
  const customer = resolveSaleCustomer({ name: "Amina", phone: "", isWalkIn: true });
  assert.equal(customer.name, "Amina");
  assert.equal(customer.isWalkIn, true);
});

test("an unnamed walk-in customer keeps the standard label", () => {
  assert.equal(resolveSaleCustomer({ isWalkIn: true }).name, WALKIN_CUSTOMER_NAME);
});

test("a name without a phone is still a walk-in customer", () => {
  assert.equal(resolveSaleCustomer({ name: "Patrick" }).isWalkIn, true);
});
