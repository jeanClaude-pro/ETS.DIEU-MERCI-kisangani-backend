const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const Product = require("../models/Product");
const {
  buildCanonicalSaleItem,
  calculateSaleFinancials,
  allocateSaleFinancialsToItems,
} = require("./saleIntegrity");
const { aggregateItemQuantities } = require("./saleMutations");
const { generateBarcodeToken, formatReceiptNumber } = require("./barcodeId");

class MutationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Returned instead of throwing when a clientSaleId has already been fully
// processed — the caller (route handler) should respond as if the sale had
// just been created, not as an error.
class IdempotentReplay {
  constructor(existingSale) {
    this.existingSale = existingSale;
  }
}

const MAX_IDENTITY_ATTEMPTS = 3;

// Best-effort pre-check to avoid a wasted transaction; the unique index on
// barcodeToken is the real guarantee against a collision slipping through.
async function generateUniqueIdentity() {
  for (let attempt = 0; attempt < MAX_IDENTITY_ATTEMPTS; attempt += 1) {
    const barcodeToken = generateBarcodeToken();
    // eslint-disable-next-line no-await-in-loop
    const exists = await Sale.exists({ barcodeToken });
    if (!exists) return { barcodeToken, receiptNumber: formatReceiptNumber(barcodeToken) };
  }
  throw new Error("Failed to generate a unique barcode identity after several attempts");
}

function centsOf(value) {
  return Math.round((Number(value) || 0) * 100);
}

// Semantic replay check for a repeated clientSaleId (Part idempotency §21):
// equality is never decided by clientSaleId alone. Compares only the fields
// that define the business transaction — never transport/timing metadata —
// so a genuine retry of the exact same sale is recognized, while a
// different sale that happens to reuse an id (a bug, or tampering) is not.
function salePayloadMatches(existingSale, { items, customer, total, paymentMethod }) {
  const existingItems = (existingSale.items || [])
    .map((item) => ({ productId: String(item.productId || ""), quantity: Number(item.quantity), price: centsOf(item.price) }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
  const incomingItems = (Array.isArray(items) ? items : [])
    .map((item) => ({ productId: String(item?.productId || ""), quantity: Number(item?.quantity), price: centsOf(item?.price) }))
    .sort((a, b) => a.productId.localeCompare(b.productId));

  if (existingItems.length !== incomingItems.length) return false;
  for (let i = 0; i < existingItems.length; i += 1) {
    const a = existingItems[i];
    const b = incomingItems[i];
    if (a.productId !== b.productId || a.quantity !== b.quantity || a.price !== b.price) return false;
  }

  const existingCustomer = existingSale.customer || {};
  const incomingCustomer = customer || {};
  if (String(existingCustomer.name || "").trim() !== String(incomingCustomer.name || "").trim()) return false;
  if (String(existingCustomer.phone || "").trim() !== String(incomingCustomer.phone || "").trim()) return false;

  if (total !== undefined && centsOf(existingSale.total) !== centsOf(total)) return false;
  if (paymentMethod !== undefined && String(existingSale.paymentMethod || "") !== String(paymentMethod || "")) return false;

  return true;
}

function legacySaleId() {
  return `SALE-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
}

function legacySaleNumber() {
  return `SN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

const CLIENT_OCCURRED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// Pure validation of the offline sale's true transaction time (Part T):
// must be a real date and not suspiciously in the future (small clock-skew
// tolerance only — this is a sanity check, not a security boundary).
function validateClientOccurredAt(clientOccurredAt, now = Date.now()) {
  if (!clientOccurredAt) return { ok: true, date: null };
  const parsed = new Date(clientOccurredAt);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "clientOccurredAt is not a valid date" };
  }
  if (parsed.getTime() > now + CLIENT_OCCURRED_AT_FUTURE_TOLERANCE_MS) {
    return { ok: false, error: "clientOccurredAt cannot be in the future" };
  }
  return { ok: true, date: parsed };
}

/**
 * Shared authoritative sale-creation core used by both the online
 * `POST /api/sales` and offline `POST /api/sales/sync` endpoints. Never
 * trusts client product/financial data — items are re-validated and
 * reloaded from Product; only quantity+price are taken from the caller.
 *
 * `identity`, when provided (offline sync), supplies the exact
 * barcodeToken/receiptNumber/clientSaleId to use — they are never
 * regenerated once a sale has been printed. When omitted (online path),
 * a fresh identity is generated here.
 *
 * `updateCustomerData`/`recalculateCustomerStats` are injected by the
 * caller (routes/sales.js) so this module reuses the exact same
 * customer-upsert/stat-recalculation logic as the edit/void/delete
 * endpoints instead of duplicating it.
 */
async function createSaleTransaction({
  items,
  safeCustomer,
  salesPerson,
  paymentMethod,
  type,
  reservationDate,
  reservationTime,
  notes,
  exchangeRateSnapshot,
  discount,
  tax,
  transportCost,
  otherCharges,
  identity,
  createdAtOverride,
  origin,
  updateCustomerData,
  recalculateCustomerStats,
}) {
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new MutationError(400, "Sale must contain at least one item");
  }

  let subtotal = 0;
  const enrichedItems = [];
  for (const item of items) {
    const { productId, quantity, price } = item || {};
    if (!productId || !quantity || quantity <= 0 || !price || price < 0) {
      throw new MutationError(400, "Each item requires productId, quantity>0, and price>=0");
    }

    // eslint-disable-next-line no-await-in-loop
    const product = await Product.findById(productId).lean();
    if (!product) throw new MutationError(400, `Product not found: ${productId}`);

    if (typeof product.stock !== "number" || product.stock < quantity) {
      throw new MutationError(400, `Insufficient stock for ${product.name || productId}. Available: ${product.stock ?? 0}`);
    }

    if (!product.region || !product.regionCode) {
      throw new MutationError(400, `Product "${product.name || productId}" has no region assigned. Contact an administrator.`);
    }

    const canonicalItem = buildCanonicalSaleItem(product, { quantity, price });
    subtotal += canonicalItem.total;
    enrichedItems.push(canonicalItem);
  }

  const financials = calculateSaleFinancials(subtotal, { discount, tax, transportCost, otherCharges });
  const allocatedItems = allocateSaleFinancialsToItems(enrichedItems, financials);
  const total = financials.total;

  const resolvedIdentity = identity?.barcodeToken
    ? identity
    : await generateUniqueIdentity();

  const saleData = {
    saleId: legacySaleId(),
    saleNumber: legacySaleNumber(),
    barcodeToken: resolvedIdentity.barcodeToken,
    receiptNumber: resolvedIdentity.receiptNumber,
    ...(identity?.clientSaleId && { clientSaleId: identity.clientSaleId }),
    origin: origin || "online",
    ...(origin === "offline" && { syncedAt: new Date() }),
    customer: safeCustomer,
    customerId: null,
    items: allocatedItems,
    ...financials,
    cost: allocatedItems.reduce((sum, item) => sum + item.cost, 0),
    profit: total - allocatedItems.reduce((sum, item) => sum + item.cost, 0),
    paymentMethod,
    status: type === "reservation" ? "pending" : "completed",
    salesPerson: salesPerson || "Admin",
    type: type || "sale",
    reservationDate: reservationDate || null,
    reservationTime: reservationTime || null,
    notes: notes || "",
    ...(exchangeRateSnapshot && {
      exchangeRateSnapshot: {
        rateId: exchangeRateSnapshot.rateId || null,
        rate: exchangeRateSnapshot.rate || null,
        effectiveFrom: exchangeRateSnapshot.effectiveFrom
          ? new Date(exchangeRateSnapshot.effectiveFrom)
          : null,
      },
    }),
    // Only the offline-sync path ever supplies this — it preserves the true
    // transaction time instead of the later sync time. Mongoose only
    // auto-populates createdAt when it isn't already present on the doc.
    ...(createdAtOverride && { createdAt: createdAtOverride }),
  };

  const session = await mongoose.startSession();
  let savedSale;
  try {
    await session.withTransaction(async () => {
      if (!safeCustomer.isWalkIn && safeCustomer.phone) {
        saleData.customerId = await updateCustomerData(safeCustomer, session);
      }
      for (const [productId, quantity] of aggregateItemQuantities(enrichedItems)) {
        // eslint-disable-next-line no-await-in-loop
        const updated = await Product.findOneAndUpdate(
          { _id: productId, stock: { $gte: quantity } },
          { $inc: { stock: -quantity } },
          { new: true, session }
        );
        if (!updated) throw new MutationError(409, "Stock changed for an item. Please refresh and try again.");
      }
      [savedSale] = await Sale.create([saleData], { session });
      if (saleData.customerId) await recalculateCustomerStats(saleData.customerId, session);
    });
  } catch (error) {
    // A clientSaleId race: two concurrent requests for the same offline sale
    // both passed the pre-check in the caller, and this one lost. The
    // transaction aborted atomically (stock decrement included), so no
    // double-processing occurred — the caller should treat this as a
    // successful idempotent replay, not a failure.
    if (error?.code === 11000 && identity?.clientSaleId && String(error.message || "").includes("clientSaleId")) {
      const existingSale = await Sale.findOne({ clientSaleId: identity.clientSaleId });
      if (existingSale) {
        await session.endSession();
        return new IdempotentReplay(existingSale);
      }
    }
    await session.endSession();
    throw error;
  }
  await session.endSession();
  return savedSale;
}

module.exports = {
  MutationError,
  IdempotentReplay,
  createSaleTransaction,
  generateUniqueIdentity,
  validateClientOccurredAt,
  salePayloadMatches,
};
