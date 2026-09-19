const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generateBarcodeToken,
  isValidBarcodeToken,
  formatReceiptNumber,
  isMatchingReceiptIdentity,
  encodeBase32,
  TOKEN_CHAR_LENGTH,
  CROCKFORD_ALPHABET,
} = require("./barcodeId");

test("generateBarcodeToken: produces a token of the expected length and charset", () => {
  const token = generateBarcodeToken();
  assert.equal(token.length, TOKEN_CHAR_LENGTH);
  for (const char of token) {
    assert.ok(CROCKFORD_ALPHABET.includes(char), `unexpected character "${char}" in token`);
  }
  assert.ok(isValidBarcodeToken(token));
});

test("generateBarcodeToken: excludes ambiguous Crockford characters (I, L, O, U)", () => {
  assert.ok(!CROCKFORD_ALPHABET.includes("I"));
  assert.ok(!CROCKFORD_ALPHABET.includes("L"));
  assert.ok(!CROCKFORD_ALPHABET.includes("O"));
  assert.ok(!CROCKFORD_ALPHABET.includes("U"));
});

test("generateBarcodeToken: is deterministic given the same random source (collision-resistant, not random-seeded)", () => {
  const fixedBytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const tokenA = generateBarcodeToken(() => fixedBytes);
  const tokenB = generateBarcodeToken(() => fixedBytes);
  assert.equal(tokenA, tokenB);
});

test("generateBarcodeToken: 5000 samples never collide (sanity check on real crypto.randomBytes)", () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) {
    const token = generateBarcodeToken();
    assert.ok(!seen.has(token), `unexpected collision on sample ${i}`);
    seen.add(token);
  }
});

test("isValidBarcodeToken: rejects wrong length, lowercase, and excluded characters", () => {
  assert.equal(isValidBarcodeToken("ABCDEFGHJKMN"), true); // 12 valid chars
  assert.equal(isValidBarcodeToken("ABCDEFGHJKM"), false); // 11 chars, too short
  assert.equal(isValidBarcodeToken("abcdefghjkmn"), false); // lowercase
  assert.equal(isValidBarcodeToken("ABCDEFGHIJKM"), false); // contains excluded "I"
  assert.equal(isValidBarcodeToken(""), false);
  assert.equal(isValidBarcodeToken(null), false);
  assert.equal(isValidBarcodeToken(undefined), false);
  assert.equal(isValidBarcodeToken(12345), false);
});

test("formatReceiptNumber: dash-groups a valid token into 4-4-4 and is deterministic", () => {
  assert.equal(formatReceiptNumber("ABCDEFGHJKMN"), "ABCD-EFGH-JKMN");
  assert.equal(formatReceiptNumber("ABCDEFGHJKMN"), formatReceiptNumber("ABCDEFGHJKMN"));
});

test("formatReceiptNumber: returns null for a malformed token instead of throwing", () => {
  assert.equal(formatReceiptNumber("not-a-token"), null);
  assert.equal(formatReceiptNumber(""), null);
});

test("receipt identity requires the human number to match the permanent barcode token", () => {
  assert.equal(isMatchingReceiptIdentity("ABCDEFGHJKMN", "ABCD-EFGH-JKMN"), true);
  assert.equal(isMatchingReceiptIdentity("ABCDEFGHJKMN", "ZZZZ-ZZZZ-ZZZZ"), false);
  assert.equal(isMatchingReceiptIdentity("invalid", "ABCD-EFGH-JKMN"), false);
});

test("encodeBase32: empty buffer yields empty string", () => {
  assert.equal(encodeBase32(Buffer.alloc(0)), "");
});
