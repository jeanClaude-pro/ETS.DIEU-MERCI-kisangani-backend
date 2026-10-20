// Short, human-friendly sale code printed on receipts and used to find a
// sale again in the system:  V-261020-K7QM3
//   V        → vente (sale)
//   261020   → business date (UTC+2) the transaction happened: 20 Oct 2026
//   K7QM3    → first 5 characters of the sale's random identity token
//
// It is derived only from data fixed at creation (type, transaction time,
// token), so the code printed by an offline device is exactly the code the
// server stores when that sale synchronizes. Keep in sync with the client
// twin in client/src/utils/saleCode.ts.
const { isValidBarcodeToken } = require("./barcodeId");

const OFFSET_MS = 2 * 60 * 60 * 1000;
const SALE_CODE_PATTERN = /^V-\d{6}-[0-9A-HJKMNP-TV-Z]{5}$/;

function businessDateDigits(date) {
  const shifted = new Date(date.getTime() + OFFSET_MS).toISOString();
  return `${shifted.slice(2, 4)}${shifted.slice(5, 7)}${shifted.slice(8, 10)}`;
}

function saleCodeFor({ occurredAt, barcodeToken }) {
  if (!isValidBarcodeToken(barcodeToken)) return null;
  const date = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return null;
  return `V-${businessDateDigits(date)}-${barcodeToken.slice(0, 5)}`;
}

function isSaleCode(value) {
  return typeof value === "string" && SALE_CODE_PATTERN.test(value);
}

/** Accepts "v-261020-k7qm3", "V261020K7QM3" or " V 261020 K7QM3 " → canonical code. */
function canonicalSaleCode(value) {
  const compact = String(value || "").toUpperCase().replace(/[\s-]/g, "");
  if (!/^V\d{6}[0-9A-Z]{5}$/.test(compact)) return null;
  const code = `${compact[0]}-${compact.slice(1, 7)}-${compact.slice(7)}`;
  return isSaleCode(code) ? code : null;
}

/**
 * Regex source that finds a sale code from a partial search typed with or
 * without dashes ("261020", "K7QM3", "V261020K7"). Returns null for terms
 * that cannot be part of a code.
 */
function saleCodeSearchSource(term) {
  const compact = String(term || "").toUpperCase().replace(/[\s-]/g, "");
  if (compact.length < 3 || !/^[0-9A-Z]+$/.test(compact)) return null;
  return compact.split("").join("-?");
}

module.exports = { SALE_CODE_PATTERN, saleCodeFor, isSaleCode, canonicalSaleCode, saleCodeSearchSource, businessDateDigits };
