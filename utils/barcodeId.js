const crypto = require("crypto");

// Crockford Base32: excludes I, L, O, U so a hand-typed receipt number can't
// be confused with 1/L, 0/O, or misread U as V. The barcode itself doesn't
// care about readability, but reusing one alphabet keeps token and receipt
// number visibly related.
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_BYTE_LENGTH = 8; // 64 bits of randomness sourced from crypto.randomBytes
const TOKEN_CHAR_LENGTH = 12; // 60 bits kept (4 groups of 4-4-4), collision risk negligible at retail scale

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buffer.length; i += 1) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

// Opaque, collision-resistant identifier encoded into the CODE128 barcode.
// Never derived from customer/product/total data — purely random.
function generateBarcodeToken(randomBytesFn = crypto.randomBytes) {
  const buffer = randomBytesFn(TOKEN_BYTE_LENGTH);
  return encodeBase32(buffer).slice(0, TOKEN_CHAR_LENGTH);
}

const BARCODE_TOKEN_PATTERN = new RegExp(`^[${CROCKFORD_ALPHABET}]{${TOKEN_CHAR_LENGTH}}$`);

function isValidBarcodeToken(token) {
  return typeof token === "string" && BARCODE_TOKEN_PATTERN.test(token);
}

// Human-readable rendering of the same token (dash-grouped), not a second
// random value — its uniqueness is inherited from the token's uniqueness.
function formatReceiptNumber(token) {
  if (!isValidBarcodeToken(token)) return null;
  return [token.slice(0, 4), token.slice(4, 8), token.slice(8, 12)].join("-");
}

function isMatchingReceiptIdentity(token, receiptNumber) {
  return isValidBarcodeToken(token) && receiptNumber === formatReceiptNumber(token);
}

module.exports = {
  CROCKFORD_ALPHABET,
  TOKEN_CHAR_LENGTH,
  generateBarcodeToken,
  isValidBarcodeToken,
  formatReceiptNumber,
  isMatchingReceiptIdentity,
  encodeBase32,
};
