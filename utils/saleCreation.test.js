const test = require("node:test");
const assert = require("node:assert/strict");
const { validateClientOccurredAt, salePayloadMatches } = require("./saleCreation");

test("validateClientOccurredAt: no value is valid (online sales never send one)", () => {
  const result = validateClientOccurredAt(undefined);
  assert.equal(result.ok, true);
  assert.equal(result.date, null);
});

test("validateClientOccurredAt: accepts a plausible past ISO timestamp", () => {
  const iso = "2026-09-18T10:00:00.000Z";
  const result = validateClientOccurredAt(iso);
  assert.equal(result.ok, true);
  assert.equal(result.date.toISOString(), iso);
});

test("validateClientOccurredAt: rejects a value that doesn't parse as a date", () => {
  const result = validateClientOccurredAt("not-a-date");
  assert.equal(result.ok, false);
  assert.match(result.error, /valid date/);
});

test("validateClientOccurredAt: rejects a timestamp far in the future", () => {
  const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
  const result = validateClientOccurredAt(farFuture);
  assert.equal(result.ok, false);
  assert.match(result.error, /future/);
});

test("validateClientOccurredAt: allows small clock-skew just inside the tolerance window", () => {
  const now = 1_000_000_000_000;
  const slightlyAhead = new Date(now + 60 * 1000).toISOString(); // +1 minute
  const result = validateClientOccurredAt(slightlyAhead, now);
  assert.equal(result.ok, true);
});

test("validateClientOccurredAt: rejects a timestamp just outside the tolerance window", () => {
  const now = 1_000_000_000_000;
  const justOutside = new Date(now + 6 * 60 * 1000).toISOString(); // +6 minutes
  const result = validateClientOccurredAt(justOutside, now);
  assert.equal(result.ok, false);
});

test("validateClientOccurredAt: preserves the exact original transaction time (Part T)", () => {
  // An offline sale synced hours later must still report the moment it
  // actually happened, not the sync time.
  const trueOccurrence = "2026-09-19T06:15:00.000Z";
  const muchLaterNow = new Date("2026-09-19T12:00:00.000Z").getTime();
  const result = validateClientOccurredAt(trueOccurrence, muchLaterNow);
  assert.equal(result.ok, true);
  assert.equal(result.date.toISOString(), trueOccurrence);
});

function existingSale(overrides = {}) {
  return {
    items: [{ productId: "p1", quantity: 2, price: 10 }, { productId: "p2", quantity: 1, price: 30 }],
    customer: { name: "Walk-in Customer", phone: "WALK-IN" },
    total: 50,
    paymentMethod: "cash",
    ...overrides,
  };
}

function incomingPayload(overrides = {}) {
  return {
    items: [{ productId: "p1", quantity: 2, price: 10 }, { productId: "p2", quantity: 1, price: 30 }],
    customer: { name: "Walk-in Customer", phone: "WALK-IN" },
    total: 50,
    paymentMethod: "cash",
    ...overrides,
  };
}

test("salePayloadMatches: an exact replay of the same transaction matches", () => {
  assert.equal(salePayloadMatches(existingSale(), incomingPayload()), true);
});

test("salePayloadMatches: item order doesn't matter (still the same transaction)", () => {
  const reordered = incomingPayload({
    items: [{ productId: "p2", quantity: 1, price: 30 }, { productId: "p1", quantity: 2, price: 10 }],
  });
  assert.equal(salePayloadMatches(existingSale(), reordered), true);
});

test("salePayloadMatches: a different quantity on the same clientSaleId is a conflict", () => {
  const mismatched = incomingPayload({ items: [{ productId: "p1", quantity: 5, price: 10 }, { productId: "p2", quantity: 1, price: 30 }] });
  assert.equal(salePayloadMatches(existingSale(), mismatched), false);
});

test("salePayloadMatches: a different price on the same clientSaleId is a conflict", () => {
  const mismatched = incomingPayload({ items: [{ productId: "p1", quantity: 2, price: 12 }, { productId: "p2", quantity: 1, price: 30 }] });
  assert.equal(salePayloadMatches(existingSale(), mismatched), false);
});

test("salePayloadMatches: a different item count on the same clientSaleId is a conflict", () => {
  const mismatched = incomingPayload({ items: [{ productId: "p1", quantity: 2, price: 10 }] });
  assert.equal(salePayloadMatches(existingSale(), mismatched), false);
});

test("salePayloadMatches: a different customer is a conflict", () => {
  const mismatched = incomingPayload({ customer: { name: "Someone Else", phone: "+243999" } });
  assert.equal(salePayloadMatches(existingSale(), mismatched), false);
});

test("salePayloadMatches: a different total is a conflict", () => {
  const mismatched = incomingPayload({ total: 999 });
  assert.equal(salePayloadMatches(existingSale(), mismatched), false);
});

test("salePayloadMatches: a different payment method is a conflict", () => {
  const mismatched = incomingPayload({ paymentMethod: "card" });
  assert.equal(salePayloadMatches(existingSale(), mismatched), false);
});

test("salePayloadMatches: floating point cent rounding noise doesn't create a false conflict", () => {
  const mismatched = incomingPayload({ total: 50.0000001, items: [{ productId: "p1", quantity: 2, price: 10.0000001 }, { productId: "p2", quantity: 1, price: 30 }] });
  assert.equal(salePayloadMatches(existingSale(), mismatched), true);
});
