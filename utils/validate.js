const mongoose = require("mongoose");

// Shared request-input validation helpers. Deliberately tiny and dependency-
// free: routes call these at the request layer so new rules never make
// existing (legacy) documents fail schema validation on their next save.

const MAX_MONEY = 1e9;
const MAX_QUANTITY = 1e6;

function isObjectId(value) {
  return typeof value === "string" && /^[a-f\d]{24}$/i.test(value) && mongoose.isValidObjectId(value);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

// Accepts a real number, or a strict numeric string ("12.5", not "12abc").
// Returns the number, or null when the value is not a finite number within
// [min, max]. `exclusiveMin` rejects the bound itself (e.g. amount > 0).
function toFiniteNumber(value, { min = -Infinity, max = Infinity, exclusiveMin = false } = {}) {
  let number;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) number = Number(value);
  else return null;
  if (!Number.isFinite(number)) return null;
  if (exclusiveMin ? number <= min : number < min) return null;
  if (number > max) return null;
  return number;
}

function toPositiveAmount(value) {
  return toFiniteNumber(value, { min: 0, max: MAX_MONEY, exclusiveMin: true });
}

// Optional string fields: undefined/null stay undefined so callers keep
// their existing defaults; anything else must be a string (or number, which
// legacy clients sometimes send for phones) within the length limit.
function cleanString(value, maxLength) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text.length > maxLength ? null : text;
}

function capLimit(raw, { defaultLimit = 10, max = 50 } = {}) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultLimit;
  return Math.min(parsed, max);
}

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
function isValidEmail(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL_PATTERN.test(value);
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
function passwordPolicyError(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

// Validates one incoming sale line. Returns an error message or null.
function saleItemError(item) {
  const { productId, quantity, price } = item || {};
  if (!isObjectId(String(productId || ""))) return "Each item requires a valid productId";
  if (toFiniteNumber(quantity, { min: 0, max: MAX_QUANTITY, exclusiveMin: true }) === null) {
    return "Each item requires a numeric quantity greater than 0";
  }
  // Price 0 is rejected exactly as before (existing business rule).
  if (toFiniteNumber(price, { min: 0, max: MAX_MONEY, exclusiveMin: true }) === null) {
    return "Each item requires a numeric price greater than 0";
  }
  return null;
}

// Optional sale-level charges: absent is fine, present must be a finite
// non-negative amount.
function saleChargesError(values) {
  for (const field of ["discount", "tax", "transportCost", "otherCharges"]) {
    const value = values[field];
    if (value === undefined || value === null || value === "") continue;
    if (toFiniteNumber(value, { min: 0, max: MAX_MONEY }) === null) {
      return `${field} must be a non-negative number`;
    }
  }
  return null;
}

module.exports = {
  MAX_MONEY,
  MAX_QUANTITY,
  MIN_PASSWORD_LENGTH,
  isObjectId,
  escapeRegex,
  toFiniteNumber,
  toPositiveAmount,
  cleanString,
  capLimit,
  isValidEmail,
  passwordPolicyError,
  saleItemError,
  saleChargesError,
};
