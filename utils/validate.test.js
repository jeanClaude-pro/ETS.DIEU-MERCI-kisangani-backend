const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isObjectId, escapeRegex, toFiniteNumber, toPositiveAmount, cleanString, capLimit,
  isValidEmail, passwordPolicyError, saleItemError, saleChargesError,
} = require("./validate");

const VALID_ID = "507f1f77bcf86cd799439011";

test("isObjectId: accepts 24-hex strings only", () => {
  assert.equal(isObjectId(VALID_ID), true);
  assert.equal(isObjectId("not-an-id"), false);
  assert.equal(isObjectId({ $ne: null }), false);
  assert.equal(isObjectId(123), false);
});

test("toFiniteNumber: rejects NaN, Infinity, objects and partially numeric strings", () => {
  assert.equal(toFiniteNumber(NaN), null);
  assert.equal(toFiniteNumber(Infinity), null);
  assert.equal(toFiniteNumber("12abc"), null);
  assert.equal(toFiniteNumber({ $gt: 0 }), null);
  assert.equal(toFiniteNumber("abc"), null);
  assert.equal(toFiniteNumber("12.5"), 12.5);
  assert.equal(toFiniteNumber(3), 3);
});

test("toPositiveAmount: zero, negative and absurd values are rejected", () => {
  assert.equal(toPositiveAmount(0), null);
  assert.equal(toPositiveAmount(-5), null);
  assert.equal(toPositiveAmount(1e12), null);
  assert.equal(toPositiveAmount("10"), 10);
});

test("saleItemError: rejects tampered quantities and prices", () => {
  assert.equal(saleItemError({ productId: VALID_ID, quantity: 2, price: 5 }), null);
  assert.match(saleItemError({ productId: VALID_ID, quantity: "abc", price: 5 }), /quantity/);
  assert.match(saleItemError({ productId: VALID_ID, quantity: -1, price: 5 }), /quantity/);
  assert.match(saleItemError({ productId: VALID_ID, quantity: Infinity, price: 5 }), /quantity/);
  assert.match(saleItemError({ productId: VALID_ID, quantity: 1e9, price: 5 }), /quantity/);
  assert.match(saleItemError({ productId: VALID_ID, quantity: 1, price: -1 }), /price/);
  assert.match(saleItemError({ productId: VALID_ID, quantity: 1, price: 1e12 }), /price/);
  assert.match(saleItemError({ productId: { $ne: null }, quantity: 1, price: 1 }), /productId/);
});

test("saleChargesError: negative or non-numeric discounts are rejected", () => {
  assert.equal(saleChargesError({}), null);
  assert.equal(saleChargesError({ discount: 2 }), null);
  assert.match(saleChargesError({ discount: -2 }), /discount/);
  assert.match(saleChargesError({ tax: "free" }), /tax/);
});

test("capLimit: a limit of 1000000 is capped", () => {
  assert.equal(capLimit("1000000", { max: 50 }), 50);
  assert.equal(capLimit(undefined, { defaultLimit: 10 }), 10);
  assert.equal(capLimit("-3", { defaultLimit: 10 }), 10);
});

test("escapeRegex: wildcard and ReDoS characters are neutralised", () => {
  const pattern = new RegExp(escapeRegex(".*(a+)+$"));
  assert.equal(pattern.test(".*(a+)+$"), true);
  assert.equal(pattern.test("anything"), false);
});

test("cleanString: enforces type and length", () => {
  assert.equal(cleanString(undefined, 5), undefined);
  assert.equal(cleanString("  ok ", 5), "ok");
  assert.equal(cleanString("toolong", 5), null);
  assert.equal(cleanString({ a: 1 }, 5), null);
});

test("password policy: at least 8 characters", () => {
  assert.match(passwordPolicyError("short"), /at least 8/);
  assert.equal(passwordPolicyError("long enough"), null);
  assert.match(passwordPolicyError(undefined), /at least 8/);
});

test("isValidEmail", () => {
  assert.equal(isValidEmail("cashier@shop.cd"), true);
  assert.equal(isValidEmail("not-an-email"), false);
});
