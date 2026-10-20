const test = require("node:test");
const assert = require("node:assert/strict");
const { saleCodeFor, isSaleCode, canonicalSaleCode, saleCodeSearchSource } = require("./saleCode");

// Shared vectors: client/src/utils/saleCode.test.ts asserts the same values.
const VECTORS = [
  [{ type: "sale", occurredAt: "2026-10-20T08:12:00.000Z", barcodeToken: "K7QM3XRT9PNW" }, "V-261020-K7QM3"],
  // 22:30 UTC on 31 Dec is already 1 Jan in Kisangani.
  [{ type: "sale", occurredAt: "2026-12-31T22:30:00.000Z", barcodeToken: "0123456789AB" }, "V-270101-01234"],
  [{ type: "sale", occurredAt: "2026-02-28T21:59:59.999Z", barcodeToken: "ZYXWVTSRQPNM" }, "V-260228-ZYXWV"],
];

test("sale codes are derived from type, business date and identity token", () => {
  for (const [input, expected] of VECTORS) assert.equal(saleCodeFor(input), expected);
  assert.ok(isSaleCode("V-261020-K7QM3"));
  assert.equal(isSaleCode("V-261020-K7QL3"), false); // L is not in the alphabet
});

test("sale codes need a valid token and date", () => {
  assert.equal(saleCodeFor({ type: "sale", occurredAt: "2026-10-20T08:00:00Z", barcodeToken: "short" }), null);
  assert.equal(saleCodeFor({ type: "sale", occurredAt: "not a date", barcodeToken: "K7QM3XRT9PNW" }), null);
});

test("typed codes are normalised, with or without dashes", () => {
  assert.equal(canonicalSaleCode("v261020k7qm3"), "V-261020-K7QM3");
  assert.equal(canonicalSaleCode(" V-261020-K7QM3 "), "V-261020-K7QM3");
  assert.equal(canonicalSaleCode("X-261020-K7QM3"), null);
  const source = saleCodeSearchSource("261020k7");
  assert.ok(new RegExp(source).test("V-261020-K7QM3"));
  assert.ok(new RegExp(saleCodeSearchSource("K7QM3")).test("V-261020-K7QM3"));
  assert.equal(saleCodeSearchSource("ab"), null);
  assert.equal(saleCodeSearchSource("Amina K."), null);
});
