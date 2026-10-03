// routes/sales.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");
const requireModulePermission = require("../middleware/requireModulePermission");
const { WALKIN_CUSTOMER_NAME, WALKIN_CUSTOMER_PHONE, resolveSaleCustomer } = require("../utils/walkInCustomer");
const { VALID_REGION_CODES } = require("../utils/regions");
const { buildEditedSaleItem, calculateSaleFinancials, allocateSaleFinancialsToItems } = require("../utils/saleIntegrity");
const { aggregateItemQuantities, calculateStockDeltas } = require("../utils/saleMutations");
const reportingDate = require("../utils/reportingDate");
const { buildTimeframeFilter, getTimeframeDescription, getTodayKisangani } = reportingDate;
const { scopedRevenueExpression, buildPagedFacet } = require("../utils/reportingPipelines");
const { MutationError, IdempotentReplay, createSaleTransaction, validateClientOccurredAt, salePayloadMatches } = require("../utils/saleCreation");
const { isValidBarcodeToken, isMatchingReceiptIdentity } = require("../utils/barcodeId");
const SaleSyncConflict = require("../models/SaleSyncConflict");
const User = require("../models/User");
const { isObjectId, saleItemError, saleChargesError, toFiniteNumber, toPositiveAmount, cleanString } = require("../utils/validate");
const { stripCostFields, stripCostFieldsFromList, saleEditDenial } = require("../utils/saleAccess");
const { audit } = require("../utils/audit");

// Reject malformed ids before any database call (prevents CastError 500s).
router.param("id", (req, res, next, id) => {
  if (!isObjectId(id)) return res.status(400).json({ error: "Invalid sale ID" });
  next();
});

// The seller of an online sale is always the authenticated user. For an
// offline sale synced later, the payload names the cashier who made it; it
// is kept only when it matches a real account, otherwise the syncing user.
async function resolveSyncSalesPerson(claimed, user) {
  const name = typeof claimed === "string" ? claimed.trim() : "";
  if (name && name !== user.username && name.length <= 60) {
    const exists = await User.exists({ username: name });
    if (exists) return name;
  }
  return user.username;
}

const BACKDATE_AUDIT_THRESHOLD_MS = 60 * 60 * 1000;

// A sale with no registered customer selected always falls back to the
// permanent Walk-in Customer — the cashier is never forced to pick one.
// normalize to the Sale model enum
function normalizePaymentMethod(pm) {
  const v = String(pm || "cash").toLowerCase();
  if (v === "cash") return "cash";
  if (v === "card") return "card";
  if (
    ["mpesa", "m-pesa", "bank", "transfer", "wire", "bank transfer"].includes(v)
  ) {
    return "transfer";
  }
  return "other";
}

async function resolveLegacyItemRegions(sales) {
  const unresolvedIds = new Set();
  for (const sale of sales) {
    for (const item of sale.items || []) {
      if (!item.regionCode && item.productId) unresolvedIds.add(String(item.productId));
    }
  }
  const products = unresolvedIds.size
    ? await Product.find({ _id: { $in: [...unresolvedIds] } }).select("region regionCode").lean()
    : [];
  const byId = new Map(products.map((product) => [String(product._id), product]));
  return sales.map((sale) => ({
    ...sale,
    items: (sale.items || []).map((item) => {
      if (item.regionCode) return { ...item, regionResolution: "snapshot" };
      const product = item.productId ? byId.get(String(item.productId)) : null;
      return product?.regionCode
        ? { ...item, region: product.region, regionCode: product.regionCode, regionResolution: "product-fallback" }
        : { ...item, regionResolution: "unresolved" };
    }),
  }));
}

// Ensure the registered customer exists. Aggregate statistics are always
// recalculated from committed sales, never incremented speculatively.
async function updateCustomerData(customerData, session = null) {
  const { name, phone, email } = customerData;
  const customer = await Customer.findOneAndUpdate(
    { phone },
    {
      $set: { name, email: email || "" },
      $setOnInsert: { isWalkIn: phone === WALKIN_CUSTOMER_PHONE },
    },
    { new: true, upsert: true, runValidators: true, session }
  );
  return customer._id;
}

// Helper function to recalculate customer statistics (FIXED)
async function recalculateCustomerStats(customerId, session = null) {
  const pipeline = [
    { $match: {
      customerId: new mongoose.Types.ObjectId(customerId),
      status: { $in: ["completed", "pending", null] },
      type: { $in: ["sale", "reservation"] },
    } },
    { $group: {
      _id: null,
      totalPurchases: { $sum: 1 },
      totalSpent: { $sum: { $ifNull: ["$total", 0] } },
      firstPurchaseDate: { $min: "$createdAt" },
      lastPurchaseDate: { $max: "$createdAt" },
    } },
  ];
  let aggregate = Sale.aggregate(pipeline);
  if (session) aggregate = aggregate.session(session);
  const stats = (await aggregate)[0] || {
    totalPurchases: 0,
    totalSpent: 0,
    firstPurchaseDate: null,
    lastPurchaseDate: null,
  };
  await Customer.findByIdAndUpdate(customerId, {
    totalPurchases: stats.totalPurchases,
    totalSpent: stats.totalSpent,
    firstPurchaseDate: stats.firstPurchaseDate,
    lastPurchaseDate: stats.lastPurchaseDate,
  }, { session });
}


// ==================== MAIN SALES ENDPOINT (TIME FRAME PAGINATION) ====================

/**
 * Complete bounded business-day snapshot for the designated offline laptop.
 * This is transaction data, not cached report totals; the client merges it
 * with local operations by clientSaleId and can reproduce today's reads.
 */
router.get("/offline-snapshot", authMiddleware, requireModulePermission(["sales", "reports", "dashboard", "pos"]), async (req, res) => {
  try {
    const today = getTodayKisangani();
    const range = reportingDate.buildTimeframeFilter({ date: today });
    const maxRows = 5000;
    const rows = await Sale.find({
      ...range,
      status: { $in: ["completed", "pending", null] },
      type: { $in: ["sale", "reservation"] },
    }).sort({ createdAt: 1, _id: 1 }).limit(maxRows + 1).lean();
    if (rows.length > maxRows) {
      return res.status(409).json({
        error: "Offline snapshot exceeds the safe daily limit",
        coverage: { start: range.createdAt.$gte, end: range.createdAt.$lte, complete: false },
      });
    }
    return res.json({
      sales: stripCostFieldsFromList(rows, req.user),
      coverage: {
        start: range.createdAt.$gte.toISOString(),
        end: range.createdAt.$lte.toISOString(),
        complete: true,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error building offline sales snapshot:", error);
    return res.status(500).json({ error: "Failed to build offline sales snapshot" });
  }
});

/** 
 * GET /api/sales
 * Timeframe filters with bounded page-based pagination
 * Priority: custom range > specific day > month > year > today (default)
 */
router.get("/", authMiddleware, requireModulePermission("sales"), async (req, res) => {
  try {
    const { customerPhone, customer, status, type, region, paymentMethod, search, edited } = req.query;
    const { page, limit, skip } = reportingDate.parsePagination(req.query);
    const timeframeFilter = reportingDate.buildTimeframeFilter(req.query);
    const filter = { ...timeframeFilter };
    filter.status = status || { $in: ["completed", "pending", null] };
    filter.type = type || { $in: ["sale", "reservation"] };
    if (customerPhone) filter["customer.phone"] = customerPhone;
    if (paymentMethod) filter.paymentMethod = paymentMethod;

    const andFilters = [];
    if (region) {
      if (!VALID_REGION_CODES.includes(region)) return res.status(400).json({ error: "Invalid region code" });
      andFilters.push({ $or: [
        { "items.regionCode": region },
        { "items.region": region === "Bbbb" ? "Butembo" : "China" },
      ] });
    }
    const term = String(search || customer || "").trim().slice(0, 100);
    if (term) {
      const escaped = term.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
      const criteria = ["saleId", "saleNumber", "customer.name", "customer.phone", "salesPerson"]
        .map((field) => ({ [field]: { $regex: escaped, $options: "i" } }));
      if (mongoose.isValidObjectId(term)) criteria.push({ customerId: new mongoose.Types.ObjectId(term) });
      andFilters.push({ $or: criteria });
    }
    if (edited === "true") {
      andFilters.push({ $or: [
        { "editHistory.0": { $exists: true } },
        { editedBy: { $exists: true, $ne: null } },
      ] });
    }
    if (andFilters.length) filter.$and = andFilters;

    const revenueExpression = scopedRevenueExpression(region);
    const [facet = {}] = await Sale.aggregate([
      { $match: filter },
      buildPagedFacet({ skip, limit, summaryGroup: {
        _id: null,
        totalRevenue: { $sum: { $cond: [{ $ne: ["$type", "expense"] }, revenueExpression, 0] } },
        totalExpenses: { $sum: { $cond: [{ $eq: ["$type", "expense"] }, { $ifNull: ["$total", 0] }, 0] } },
        saleCount: { $sum: { $cond: [{ $ne: ["$type", "expense"] }, 1, 0] } },
        expenseCount: { $sum: { $cond: [{ $eq: ["$type", "expense"] }, 1, 0] } },
      } }),
    ]).allowDiskUse(true);

    const sales = stripCostFieldsFromList(await resolveLegacyItemRegions(facet.data || []), req.user);
    const total = facet.metadata?.[0]?.totalRecords || 0;
    const totals = facet.summary?.[0] || {
      totalRevenue: 0, totalExpenses: 0, saleCount: 0, expenseCount: 0,
    };

    res.json({
      success: true,
      data: sales,
      timeframe: reportingDate.timeframeMetadata(req.query, timeframeFilter),
      pagination: {
        totalRecords: total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        limit,
      },
      summary: {
        totalRecords: total,
        revenue: totals.totalRevenue,
        expenses: totals.totalExpenses,
        net: totals.totalRevenue - totals.totalExpenses,
        salesCount: totals.saleCount,
        expensesCount: totals.expenseCount,
      },
      filtersApplied: {
        customerPhone: customerPhone || "none",
        status: status || "default (completed, pending, legacy-unset)",
        type: type || "default (sale, reservation)",
        paymentMethod: paymentMethod || "none",
        search: term || "none",
        edited: edited === "true",
        region: region || "all",
      },
      performanceNote: null,
    });
  } catch (error) {
    console.error("Error fetching paginated sales:", error);
    const badRequest = /Invalid date|Invalid year|Invalid month|Start date/.test(error.message);
    res.status(badRequest ? 400 : 500).json({
      error: badRequest ? error.message : "Failed to fetch sales",
      suggestion: "Check your query parameters and try again",
    });
  }
});

/** ---------- DAILY STATS FIRST (before :id) ---------- **/
router.get("/stats/daily", authMiddleware, requireModulePermission("sales"), async (req, res) => {
  try {
    const dateStr = req.query.date || getTodayKisangani();
    const dateFilter = reportingDate.buildTimeframeFilter({ date: dateStr });
    const { page, limit, skip } = reportingDate.parsePagination(req.query);
    const [facet = {}] = await Sale.aggregate([
      { $match: {
        ...dateFilter,
        status: { $in: ["completed", "pending", null] },
        type: { $in: ["sale", "reservation"] },
      } },
      { $facet: {
        summary: [{ $group: {
          _id: null,
          totalSales: { $sum: 1 },
          totalRevenue: { $sum: "$total" },
          totalItems: { $sum: { $size: { $ifNull: ["$items", []] } } },
        } }],
        sales: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit }, { $project: { __v: 0 } }],
      } },
    ]);
    const summary = facet.summary?.[0] || { totalSales: 0, totalRevenue: 0, totalItems: 0 };
    res.json({
      date: dateStr,
      ...summary,
      sales: stripCostFieldsFromList(facet.sales || [], req.user),
      pagination: { totalRecords: summary.totalSales, totalPages: Math.ceil(summary.totalSales / limit), currentPage: page, limit },
    });
  } catch (error) {
    console.error("Error fetching daily stats:", error);
    res.status(500).json({ error: "Failed to fetch daily statistics" });
  }
});

/** ---------- CREATE SALE OR EXPENSE ---------- **/
router.post("/", authMiddleware, requireModulePermission(["pos", "reservation"]), async (req, res) => {
  try {
    const {
      customer,
      items,
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
      clientSaleId,
      barcodeToken,
      receiptNumber,
      total: requestedTotal,
      // 🔹 NEW EXPENSE FIELDS (salesPerson/recordedBy are never read from the client)
      reason,
      recipientName,
      recipientPhone,
      amount,
    } = req.body;

    const normalizedPM = normalizePaymentMethod(paymentMethod);

    if (type !== undefined && type !== null && type !== "" && !["sale", "reservation", "expense"].includes(type)) {
      return res.status(400).json({ error: "Invalid sale type" });
    }
    if (clientSaleId !== undefined && clientSaleId !== null && (typeof clientSaleId !== "string" || clientSaleId.length > 100)) {
      return res.status(400).json({ error: "Invalid clientSaleId" });
    }

    // 🔹 HANDLE EXPENSE TYPE (legacy path; expenses now live in /api/expenses)
    if (type === "expense") {
      if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Only admins can record expenses through the sales endpoint" });
      }
      const cleanReason = cleanString(reason, 500);
      const cleanRecipientName = cleanString(recipientName, 100);
      const cleanRecipientPhone = cleanString(recipientPhone, 40);
      if (!cleanReason || !cleanRecipientName || !cleanRecipientPhone || !amount) {
        return res.status(400).json({
          error: "Expense requires reason, recipientName, recipientPhone, and amount"
        });
      }

      const expenseAmount = toPositiveAmount(amount);
      if (expenseAmount === null) {
        return res.status(400).json({
          error: "Amount must be a positive number"
        });
      }

      const saleId = `EXP-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 5)
        .toUpperCase()}`;

      const saleNumber = `EXP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const expenseData = {
        saleId,
        saleNumber,
        customer: {
          name: cleanRecipientName,
          phone: cleanRecipientPhone,
          email: "",
        },
        items: [], // No items for expenses
        subtotal: expenseAmount,
        total: expenseAmount,
        paymentMethod: normalizedPM,
        status: "expense", // 🔹 Special status for expenses
        salesPerson: req.user.username,
        type: "expense",
        reason: cleanReason,
        recipientName: cleanRecipientName,
        recipientPhone: cleanRecipientPhone,
        notes: typeof notes === "string" ? notes.slice(0, 1000) : ""
      };

      const expense = new Sale(expenseData);
      const savedExpense = await expense.save();

      return res.status(201).json(savedExpense);
    }

    // 🔹 HANDLE REGULAR SALE (existing logic)
    // Customer info is optional — a sale with no registered customer falls
    // back to the permanent Walk-in Customer (see resolveSaleCustomer above).
    const safeCustomer = resolveSaleCustomer(customer);

    // A clientSaleId sent on the regular online path makes a lost response
    // safely retryable too (Part V), not just offline sync. Legacy callers
    // that don't send one behave exactly as before.
    if (clientSaleId) {
      const existing = await Sale.findOne({ clientSaleId });
      if (existing) {
        if (salePayloadMatches(existing, { items, customer: safeCustomer, total: requestedTotal, paymentMethod: normalizedPM })) {
          return res.status(200).json(stripCostFields(existing, req.user));
        }
        return res.status(409).json({ error: "Cette vente existe déjà avec un contenu différent (clientSaleId réutilisé)." });
      }
      if (!isMatchingReceiptIdentity(barcodeToken, receiptNumber)) {
        return res.status(400).json({ error: "A valid matching barcodeToken and receiptNumber are required with clientSaleId" });
      }
    }

    const result = await createSaleTransaction({
      items,
      safeCustomer,
      salesPerson: req.user.username,
      paymentMethod: normalizedPM,
      type,
      reservationDate,
      reservationTime,
      notes,
      exchangeRateSnapshot,
      discount,
      tax,
      transportCost,
      otherCharges,
      identity: clientSaleId ? { clientSaleId, barcodeToken, receiptNumber } : undefined,
      origin: "online",
      updateCustomerData,
      recalculateCustomerStats,
    });
    const savedSale = result instanceof IdempotentReplay ? result.existingSale : result;

    return res.status(201).json(stripCostFields(savedSale, req.user));
  } catch (error) {
    console.error("Error creating sale/expense:", error);
    if (error instanceof MutationError) return res.status(error.status).json({ error: error.message });
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    return res.status(500).json({ error: "Failed to create sale/expense" });
  }
});

/** ---------- OFFLINE SALE SYNC (idempotent intake for the designated offline device) ---------- **/
router.post("/sync", authMiddleware, requireModulePermission(["pos", "reservation"]), async (req, res) => {
  try {
    const {
      customer,
      items,
      paymentMethod,
      salesPerson,
      type,
      reservationDate,
      reservationTime,
      notes,
      exchangeRateSnapshot,
      discount,
      tax,
      transportCost,
      otherCharges,
      clientSaleId,
      barcodeToken,
      receiptNumber,
      clientOccurredAt,
      total: requestedTotal,
    } = req.body;

    if (!clientSaleId || typeof clientSaleId !== "string" || clientSaleId.length > 100) {
      return res.status(400).json({ error: "clientSaleId is required for offline sync" });
    }
    if (type !== undefined && type !== null && type !== "" && !["sale", "reservation"].includes(type)) {
      return res.status(400).json({ error: "Invalid sale type" });
    }
    if (!isValidBarcodeToken(barcodeToken)) {
      return res.status(400).json({ error: "barcodeToken is missing or malformed" });
    }
    if (!receiptNumber || typeof receiptNumber !== "string") {
      return res.status(400).json({ error: "receiptNumber is required" });
    }
    if (!isMatchingReceiptIdentity(barcodeToken, receiptNumber)) {
      return res.status(400).json({ error: "receiptNumber does not match barcodeToken" });
    }

    const normalizedPM = normalizePaymentMethod(paymentMethod);
    const safeCustomer = resolveSaleCustomer(customer);

    // Idempotency fast path: this exact offline sale already landed. Never
    // decided by clientSaleId alone — a semantic mismatch means the id was
    // reused for a materially different transaction, which is a conflict,
    // not a safe replay.
    const existing = await Sale.findOne({ clientSaleId });
    if (existing) {
      if (salePayloadMatches(existing, { items, customer: safeCustomer, total: requestedTotal, paymentMethod: normalizedPM })) {
        return res.status(200).json(stripCostFields(existing, req.user));
      }
      return res.status(409).json({ error: "Cette vente existe déjà avec un contenu différent (clientSaleId réutilisé)." });
    }

    const occurredAtCheck = validateClientOccurredAt(clientOccurredAt);
    if (!occurredAtCheck.ok) {
      return res.status(400).json({ error: occurredAtCheck.error });
    }
    const createdAtOverride = occurredAtCheck.date;
    const syncSalesPerson = await resolveSyncSalesPerson(salesPerson, req.user);

    const result = await createSaleTransaction({
      items,
      safeCustomer,
      salesPerson: syncSalesPerson,
      paymentMethod: normalizedPM,
      type,
      reservationDate,
      reservationTime,
      notes,
      exchangeRateSnapshot,
      discount,
      tax,
      transportCost,
      otherCharges,
      identity: { clientSaleId, barcodeToken, receiptNumber },
      createdAtOverride,
      origin: req.body.origin === "online" ? "online" : "offline",
      updateCustomerData,
      recalculateCustomerStats,
    });
    const savedSale = result instanceof IdempotentReplay ? result.existingSale : result;

    if (!(result instanceof IdempotentReplay) && createdAtOverride &&
        Date.now() - createdAtOverride.getTime() > BACKDATE_AUDIT_THRESHOLD_MS) {
      await audit(req, "sale.synced_backdated", {
        targetType: "Sale",
        targetId: savedSale._id,
        after: { createdAt: createdAtOverride, total: savedSale.total, salesPerson: syncSalesPerson, clientSaleId },
      });
    }

    return res.status(201).json(stripCostFields(savedSale, req.user));
  } catch (error) {
    console.error("Error synchronizing offline sale:", error);
    if (error instanceof MutationError) return res.status(error.status).json({ error: error.message });
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    return res.status(500).json({ error: "Failed to synchronize offline sale" });
  }
});

/** ---------- BARCODE LOOKUP (receipt/stub scanning) ---------- **/
router.get("/barcode/:token", authMiddleware, requireModulePermission(["pos", "sales", "reservation"]), async (req, res) => {
  try {
    const { token } = req.params;
    if (!isValidBarcodeToken(token)) {
      return res.status(400).json({ found: false, error: "Malformed barcode" });
    }
    const sale = await Sale.findOne({ barcodeToken: token }).lean();
    if (!sale) return res.status(200).json({ found: false });

    const itemCount = (sale.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    const rate = sale.exchangeRateSnapshot?.rate;
    return res.status(200).json({
      found: true,
      receiptNumber: sale.receiptNumber || sale.saleId,
      occurredAt: sale.createdAt,
      customerName: sale.customer?.isWalkIn ? "Walk-in Customer" : sale.customer?.name || "Walk-in Customer",
      totalUSD: sale.total,
      totalFC: rate ? Math.round(sale.total * rate) : null,
      paymentMethod: sale.paymentMethod,
      salesPerson: sale.salesPerson,
      itemCount,
      status: sale.status,
      type: sale.type,
    });
  } catch (error) {
    console.error("Error looking up sale by barcode:", error);
    return res.status(500).json({ found: false, error: "Barcode lookup failed" });
  }
});

/** ---------- SYNC CONFLICT REPORTING / RECONCILIATION ---------- **/
router.post("/sync/conflicts", authMiddleware, requireModulePermission(["pos", "reservation"]), async (req, res) => {
  try {
    const {
      clientSaleId, barcodeToken, receiptNumber, reason,
      productId, productName, localQuantity, occurredAt,
      salesPerson, region, regionCode, payload,
    } = req.body;
    if (!clientSaleId || !barcodeToken || !receiptNumber || !reason || !occurredAt) {
      return res.status(400).json({ error: "clientSaleId, barcodeToken, receiptNumber, reason, and occurredAt are required" });
    }
    const textFields = [clientSaleId, barcodeToken, receiptNumber];
    if (textFields.some((value) => typeof value !== "string" || value.length > 100) ||
        (productId && !isObjectId(String(productId))) ||
        Number.isNaN(new Date(occurredAt).getTime())) {
      return res.status(400).json({ error: "Invalid sync conflict report" });
    }
    const conflict = await SaleSyncConflict.create({
      clientSaleId,
      barcodeToken,
      receiptNumber,
      reason: String(reason).slice(0, 500),
      productId: productId || null,
      productName: String(productName || "").slice(0, 200),
      localQuantity: Number.isFinite(Number(localQuantity)) ? Number(localQuantity) : null,
      occurredAt: new Date(occurredAt),
      salesPerson: String(salesPerson || "").slice(0, 60),
      region: String(region || "").slice(0, 20),
      regionCode: String(regionCode || "").slice(0, 10),
      reportedBy: req.user.id,
      payload: payload || null,
    });
    return res.status(201).json(conflict);
  } catch (error) {
    console.error("Error recording sync conflict:", error);
    return res.status(500).json({ error: "Failed to record sync conflict" });
  }
});

router.get("/sync/conflicts", authMiddleware, requireModulePermission(["sync", "sales"]), async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status === "open" || status === "acknowledged" ? { status } : {};
    const conflicts = await SaleSyncConflict.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    return res.status(200).json(conflicts);
  } catch (error) {
    console.error("Error listing sync conflicts:", error);
    return res.status(500).json({ error: "Failed to list sync conflicts" });
  }
});

router.patch("/sync/conflicts/:id/acknowledge", authMiddleware, requireModulePermission(["sync", "sales"]), async (req, res) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ error: "Invalid conflict id" });
    }
    const conflict = await SaleSyncConflict.findByIdAndUpdate(
      req.params.id,
      { status: "acknowledged", acknowledgedBy: req.user.id, acknowledgedAt: new Date() },
      { new: true }
    );
    if (!conflict) return res.status(404).json({ error: "Conflict record not found" });
    return res.status(200).json(conflict);
  } catch (error) {
    console.error("Error acknowledging sync conflict:", error);
    return res.status(500).json({ error: "Failed to acknowledge sync conflict" });
  }
});

// ==================== RELATED HISTORY ENDPOINTS ====================

/** ---------- GET EXPENSES (TIME FRAME BASED) ---------- **/
router.get("/expenses/all", authMiddleware, requireModulePermission("sortiehistory"), async (req, res) => {
  try {
    const { 
      status 
    } = req.query;
    
    // Build timeframe filter
    let timeframeFilter;
    try {
      timeframeFilter = buildTimeframeFilter(req.query);
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD"
      });
    }
    
    const filter = { 
      type: "expense",
      ...timeframeFilter
    };
    
    if (status) {
      filter.status = status;
    }

    const { page, limit, skip } = reportingDate.parsePagination(req.query);
    const [facet = {}] = await Sale.aggregate([
      { $match: filter },
      { $facet: {
        data: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit }, { $project: { __v: 0, items: 0 } }],
        summary: [{ $group: { _id: null, totalExpenses: { $sum: 1 }, totalAmount: { $sum: "$total" } } }],
      } },
    ]);
    const expenses = facet.data || [];
    const summary = facet.summary?.[0] || { totalExpenses: 0, totalAmount: 0 };

    res.json({
      success: true,
      data: expenses,
      summary: {
        totalExpenses: summary.totalExpenses,
        totalAmount: summary.totalAmount,
        timeframe: getTimeframeDescription(req.query)
      },
      pagination: { totalRecords: summary.totalExpenses, totalPages: Math.ceil(summary.totalExpenses / limit), currentPage: page, limit }
    });
  } catch (error) {
    console.error("Error fetching expenses:", error);
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
});

/** ---------- GET RESERVATIONS (TIME FRAME BASED) ---------- **/
router.get("/reservations/all", authMiddleware, requireModulePermission("reservations"), async (req, res) => {
  try {
    const { status, region, search } = req.query;
    const { page, limit, skip } = reportingDate.parsePagination(req.query);
    const timeframeFilter = reportingDate.buildTimeframeFilter(req.query);
    const filter = {
      type: "reservation",
      status: status && status !== "all" ? status : { $in: ["pending", "completed", null] },
      ...timeframeFilter,
    };
    if (region) {
      if (!VALID_REGION_CODES.includes(region)) return res.status(400).json({ error: "Invalid region code" });
      filter.$or = [
        { "items.regionCode": region },
        { "items.region": region === "Bbbb" ? "Butembo" : "China" },
      ];
    }
    if (search) {
      const escaped = String(search).replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
      const searchFilter = { $or: [
        { saleId: { $regex: escaped, $options: "i" } },
        { "customer.name": { $regex: escaped, $options: "i" } },
        { "customer.phone": { $regex: escaped, $options: "i" } },
        { "customer.email": { $regex: escaped, $options: "i" } },
      ] };
      filter.$and = [...(filter.$or ? [{ $or: filter.$or }] : []), searchFilter];
      delete filter.$or;
    }

    const revenue = scopedRevenueExpression(region);
    const [facet = {}] = await Sale.aggregate([
      { $match: filter },
      buildPagedFacet({ skip, limit, summaryGroup: {
        _id: null,
        totalReservations: { $sum: 1 },
        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
        totalValue: { $sum: revenue },
        itemCount: { $sum: { $size: { $ifNull: ["$items", []] } } },
      } }),
    ]).allowDiskUse(true);
    const data = stripCostFieldsFromList(await resolveLegacyItemRegions(facet.data || []), req.user);
    const total = facet.metadata?.[0]?.totalRecords || 0;
    const summary = facet.summary?.[0] || {
      totalReservations: 0, pending: 0, completed: 0, totalValue: 0, itemCount: 0,
    };
    res.json({
      success: true,
      data,
      pagination: { totalRecords: total, totalPages: Math.ceil(total / limit), currentPage: page, limit },
      summary: { ...summary, timeframe: getTimeframeDescription(req.query) },
    });
  } catch (error) {
    console.error("Error fetching reservations:", error);
    res.status(/Invalid date|Invalid year|Invalid month|Start date/.test(error.message) ? 400 : 500)
      .json({ error: /Invalid/.test(error.message) ? error.message : "Failed to fetch reservations" });
  }
});

// ==================== ALL OTHER ROUTES REMAIN EXACTLY THE SAME ====================

/** ---------- GET BY ID (after other specific routes) ---------- **/
router.get("/:id", authMiddleware, requireModulePermission("sales"), async (req, res) => {
  try {
    const saleId = req.params.id;
    
    const sale = await Sale.findById(saleId)
      .select('-__v') // Exclude version key
      .lean();
    
    if (!sale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    // Only check for duplicates if needed
    let potentialDuplicates = [];
    let duplicateCount = 0;
    
    if (sale.saleId) {
      potentialDuplicates = await Sale.find({
        saleId: sale.saleId,
        _id: { $ne: saleId }
      })
      .select('_id saleId createdAt status')
      .lean();
      
      duplicateCount = potentialDuplicates.length;
    }

    res.json({
      success: true,
      data: stripCostFields(sale, req.user),
      duplicates: {
        count: duplicateCount,
        items: potentialDuplicates
      },
      message: duplicateCount > 0 ? 
        `Found ${duplicateCount} potential duplicates` : 
        "No duplicates found"
    });

  } catch (error) {
    console.error("Error fetching sale:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID format" });
    }
    res.status(500).json({ error: "Failed to fetch sale" });
  }
});

/** ---------- EDIT SALE (Role-Based Restrictions) ---------- **/
router.put("/:id", authMiddleware, requireModulePermission("sales"), async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      customer, 
      items, 
      paymentMethod, 
      reason, 
      type, 
      reservationDate, 
      reservationTime, 
      notes,
      // Expense fields
      recipientName,
      recipientPhone,
      amount,
      discount,
      tax,
      transportCost,
      otherCharges,
    } = req.body;

    // Find the original sale
    const originalSale = await Sale.findById(id).lean();
    if (!originalSale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    // Role rules: completed sales are admin-only; reservations keep their
    // existing admin/manager rules; a sale can never be turned into an
    // expense (that rewrote the total without returning stock).
    const denial = saleEditDenial(req.user, originalSale, type);
    if (denial) {
      return res.status(denial.status).json({ error: denial.error });
    }

    const normalizedPM = normalizePaymentMethod(paymentMethod);

    // 🔹 HANDLE EXPENSE EDITING (only ever for an existing expense record)
    if (originalSale.type === "expense") {
      if (!reason || !recipientName || !recipientPhone || !amount ||
          [reason, recipientName, recipientPhone].some((value) => typeof value !== "string" || value.length > 500)) {
        return res.status(400).json({ 
          error: "Expense requires reason, recipientName, recipientPhone, and amount" 
        });
      }

      const expenseAmount = toPositiveAmount(amount);
      if (expenseAmount === null) {
        return res.status(400).json({ 
          error: "Amount must be a positive number" 
        });
      }

      // Track changes for audit
      const changes = new Map();
      
      if (originalSale.reason !== reason) {
        changes.set('reason', { from: originalSale.reason, to: reason });
      }
      if (originalSale.recipientName !== recipientName) {
        changes.set('recipientName', { from: originalSale.recipientName, to: recipientName });
      }
      if (originalSale.recipientPhone !== recipientPhone) {
        changes.set('recipientPhone', { from: originalSale.recipientPhone, to: recipientPhone });
      }
      if (originalSale.total !== expenseAmount) {
        changes.set('total', { from: originalSale.total, to: expenseAmount });
      }

      const updatedExpense = await Sale.findByIdAndUpdate(
        id,
        {
          reason,
          recipientName,
          recipientPhone,
          subtotal: expenseAmount,
          total: expenseAmount,
          paymentMethod: normalizedPM,
          notes: typeof notes === "string" && notes ? notes.slice(0, 1000) : originalSale.notes,
          editedBy: req.user.userId,
          editedAt: new Date(),
          $push: {
            editHistory: {
              editedBy: req.user.userId,
              editedAt: new Date(),
              changes: Object.fromEntries(changes),
              reason: reason || "Expense correction"
            }
          }
        },
        { new: true, runValidators: true }
      );
      await audit(req, "sale.expense_record_edited", {
        targetType: "Sale",
        targetId: id,
        before: { reason: originalSale.reason, recipientName: originalSale.recipientName, total: originalSale.total },
        after: { reason, recipientName, total: expenseAmount },
      });

      return res.json(updatedExpense);
    }

    // 🔹 HANDLE REGULAR SALE EDITING
    // Track changes for audit
    const changes = new Map();
    const originalItems = originalSale.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Sale must contain at least one item" });
    }

    // Validate and process items
    let subtotal = 0;
    const enrichedItems = [];
    
    if (items.length > 500) {
      return res.status(400).json({ error: "Too many items in one sale" });
    }
    const chargesError = saleChargesError({ discount, tax, transportCost, otherCharges });
    if (chargesError) return res.status(400).json({ error: chargesError });

    for (const item of items) {
      const itemError = saleItemError(item);
      if (itemError) {
        return res.status(400).json({ error: itemError });
      }
      const productId = String(item.productId);
      const quantity = toFiniteNumber(item.quantity);
      const price = toFiniteNumber(item.price);

      const oldItem = originalItems.find((candidate) =>
        candidate.productId && String(candidate.productId) === String(productId)
      );
      const product = await Product.findById(productId).lean();
      if (!product && !oldItem) {
        return res.status(400).json({ error: `Product not found: ${productId}` });
      }
      const canonicalItem = buildEditedSaleItem(product, oldItem, { productId, quantity, price });
      subtotal += canonicalItem.total;
      enrichedItems.push(canonicalItem);
    }

    const financials = calculateSaleFinancials(subtotal, {
      discount: discount ?? originalSale.discount,
      tax: tax ?? originalSale.tax,
      transportCost: transportCost ?? originalSale.transportCost,
      otherCharges: otherCharges ?? originalSale.otherCharges,
    });
    if (financials.total < 0) {
      return res.status(400).json({ error: "Discount cannot exceed the sale amount" });
    }
    const allocatedItems = allocateSaleFinancialsToItems(enrichedItems, financials);
    const total = financials.total;

    const stockDeltas = calculateStockDeltas(originalItems, enrichedItems);
    const safeCustomer = resolveSaleCustomer(customer);

    // Track what changed
    if (JSON.stringify(originalSale.customer) !== JSON.stringify(safeCustomer)) {
      changes.set('customer', { from: originalSale.customer, to: safeCustomer });
    }

    if (originalSale.total !== total) {
      changes.set('total', { from: originalSale.total, to: total });
    }
    if (JSON.stringify(originalItems) !== JSON.stringify(allocatedItems)) {
      changes.set('items', { from: originalItems, to: allocatedItems });
    }
    
    if (originalSale.paymentMethod !== normalizedPM) {
      changes.set('paymentMethod', { from: originalSale.paymentMethod, to: normalizedPM });
    }

    // Track type changes
    const effectiveType = type || originalSale.type;
    if (originalSale.type !== effectiveType) {
      changes.set('type', { from: originalSale.type, to: effectiveType });
    }

    const session = await mongoose.startSession();
    let updatedSale;
    try {
      await session.withTransaction(async () => {
        for (const { productId, delta } of stockDeltas) {
          const productFilter = delta < 0
            ? { _id: productId, stock: { $gte: -delta } }
            : { _id: productId };
          const updatedProduct = await Product.findOneAndUpdate(
            productFilter,
            { $inc: { stock: delta } },
            { new: true, session }
          );
          if (!updatedProduct && delta < 0) {
            throw new MutationError(409, `Insufficient stock or deleted product: ${productId}`);
          }
        }

        const newCustomerId = !safeCustomer.isWalkIn && safeCustomer.phone
          ? await updateCustomerData(safeCustomer, session)
          : null;
        updatedSale = await Sale.findOneAndUpdate(
          { _id: id, updatedAt: originalSale.updatedAt },
          {
            customer: safeCustomer,
            customerId: newCustomerId,
            items: allocatedItems,
            ...financials,
            cost: allocatedItems.reduce((sum, item) => sum + item.cost, 0),
            profit: total - allocatedItems.reduce((sum, item) => sum + item.cost, 0),
            paymentMethod: normalizedPM,
            type: effectiveType,
            reservationDate: typeof reservationDate === "string" && reservationDate ? reservationDate.slice(0, 40) : originalSale.reservationDate,
            reservationTime: typeof reservationTime === "string" && reservationTime ? reservationTime.slice(0, 40) : originalSale.reservationTime,
            notes: typeof notes === "string" && notes ? notes.slice(0, 1000) : originalSale.notes,
            editedBy: req.user.userId,
            editedAt: new Date(),
            $push: {
              editHistory: {
                editedBy: req.user.userId,
                editedAt: new Date(),
                changes: Object.fromEntries(changes),
                reason: typeof reason === "string" && reason ? reason.slice(0, 500) : "Sale correction"
              }
            }
          },
          { new: true, runValidators: true, session }
        );
        if (!updatedSale) throw new MutationError(409, "Sale changed while you were editing. Refresh and try again.");

        const customerIds = new Set([
          originalSale.customerId ? String(originalSale.customerId) : null,
          newCustomerId ? String(newCustomerId) : null,
        ].filter(Boolean));
        for (const customerId of customerIds) {
          await recalculateCustomerStats(customerId, session);
        }
      });
    } finally {
      await session.endSession();
    }

    await audit(req, "sale.edited", {
      targetType: "Sale",
      targetId: id,
      before: originalSale,
      after: { changes: Object.fromEntries(changes), stockDeltas, reason: typeof reason === "string" ? reason.slice(0, 500) : null },
    });

    res.json(updatedSale);
  } catch (error) {
    console.error("Error editing sale:", error);
    if (error instanceof MutationError) return res.status(error.status).json({ error: error.message });
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID" });
    }
    res.status(500).json({ error: "Failed to edit sale" });
  }
});

/** ---------- MARK RESERVATION AS COMPLETED ---------- **/
router.patch("/:id/complete", authMiddleware, requireModulePermission("sales"), async (req, res) => {
  try {
    const { id } = req.params;

    const sale = await Sale.findById(id).lean();
    if (!sale) {
      return res.status(404).json({ error: "Réservation non trouvée" });
    }

    // 🔹 NEW: Check if it's actually a reservation
    if (sale.type !== "reservation") {
      return res.status(400).json({ error: "This is not a reservation" });
    }

    // 🔹 NEW: Check if already completed
    if (sale.status === "completed") {
      return res.status(400).json({ error: "Reservation already completed" });
    }

    const updatedSale = await Sale.findByIdAndUpdate(
      id,
      {
        status: "completed",
        completedAt: new Date(),
        completedBy: req.user.username || req.user.userId,
      },
      { new: true }
    );
    await audit(req, "reservation.completed", { targetType: "Sale", targetId: id, before: { status: sale.status } });

    res.json(stripCostFields(updatedSale, req.user));
  } catch (error) {
    console.error("Error completing reservation:", error);
    res.status(500).json({ error: "Échec de la mise à jour de la réservation" });
  }
});

/** ---------- MARK RESERVATION AS PENDING ---------- **/
router.patch("/:id/pending", authMiddleware, requireModulePermission("sales"), async (req, res) => {
  try {
    const { id } = req.params;

    const sale = await Sale.findById(id).lean();
    if (!sale) {
      return res.status(404).json({ error: "Réservation non trouvée" });
    }

    // 🔹 NEW: RESTRICTION - Only admin can return completed reservations to pending
    if (sale.status === "completed" && req.user.role !== "admin") {
      return res.status(403).json({ 
        error: "Only admin can return completed reservations to pending" 
      });
    }

    // 🔹 NEW: Check if it's actually a reservation
    if (sale.type !== "reservation") {
      return res.status(400).json({ error: "This is not a reservation" });
    }

    const updatedSale = await Sale.findByIdAndUpdate(
      id,
      {
        status: "pending",
        completedAt: null,
        completedBy: null,
      },
      { new: true }
    );
    await audit(req, "reservation.reopened", { targetType: "Sale", targetId: id, before: { status: sale.status, completedBy: sale.completedBy } });

    res.json(stripCostFields(updatedSale, req.user));
  } catch (error) {
    console.error("Error setting reservation to pending:", error);
    res.status(500).json({ error: "Échec de la mise à jour de la réservation" });
  }
});

/** ---------- VOID/REFUND SALE ---------- **/
router.patch("/:id/void", authMiddleware, requireModulePermission("sales"), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admins can void sales" });
    }

    const { id } = req.params;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : undefined;

    let voidedSale;
    let saleBeforeVoid;
    let stockWarnings = [];
    await session.withTransaction(async () => {
      stockWarnings = [];
      const sale = await Sale.findById(id).session(session).lean();
      if (!sale) throw new MutationError(404, "Sale not found");
      if (sale.status === "voided") throw new MutationError(400, "Sale is already voided");
      saleBeforeVoid = sale;

      if (["sale", "reservation"].includes(sale.type)) {
        for (const [productId, quantity] of aggregateItemQuantities(sale.items)) {
          const product = await Product.findByIdAndUpdate(
            productId, { $inc: { stock: quantity } }, { new: true, session }
          );
          if (!product) stockWarnings.push(`Deleted product ${productId}: stock could not be restored`);
        }
      }
      voidedSale = await Sale.findByIdAndUpdate(
        id,
        {
          status: "voided",
          voidedBy: req.user.userId,
          voidedAt: new Date(),
          $push: {
            editHistory: {
              editedBy: req.user.userId,
              editedAt: new Date(),
              changes: { status: { from: sale.status, to: "voided" } },
              reason: reason || "Sale voided"
            }
          }
        },
        { new: true, session }
      );
      if (sale.customerId && ["sale", "reservation"].includes(sale.type)) {
        await recalculateCustomerStats(sale.customerId, session);
      }
    });

    await audit(req, "sale.voided", {
      targetType: "Sale",
      targetId: id,
      before: { status: saleBeforeVoid.status, total: saleBeforeVoid.total, items: saleBeforeVoid.items },
      after: { status: "voided", reason: reason || "Sale voided", stockWarnings },
    });

    res.json({
      ...voidedSale.toObject(),
      stockReturned: stockWarnings.length === 0,
      stockWarnings,
    });
  } catch (error) {
    console.error("Error voiding sale:", error);
    if (error instanceof MutationError) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: "Failed to void sale" });
  } finally {
    await session.endSession();
  }
});

/** ---------- DELETE SALE ---------- **/
router.delete("/:id", authMiddleware, requireModulePermission("sales"), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admins can permanently delete sales" });
    }
    let deletedSale;
    let stockWarnings = [];
    await session.withTransaction(async () => {
      stockWarnings = [];
      const sale = await Sale.findById(req.params.id).session(session).lean();
      if (!sale) throw new MutationError(404, "Sale not found");
      deletedSale = sale;

      if (["sale", "reservation"].includes(sale.type) && sale.status !== "voided") {
        for (const [productId, quantity] of aggregateItemQuantities(sale.items)) {
          const product = await Product.findByIdAndUpdate(
            productId, { $inc: { stock: quantity } }, { new: true, session }
          );
          if (!product) stockWarnings.push(`Deleted product ${productId}: stock could not be restored`);
        }
      }
      await Sale.deleteOne({ _id: sale._id }, { session });
      if (sale.customerId && ["sale", "reservation"].includes(sale.type)) {
        await recalculateCustomerStats(sale.customerId, session);
      }
    });
    // Full snapshot: a hard-deleted sale otherwise leaves no trace at all.
    await audit(req, "sale.deleted", { targetType: "Sale", targetId: deletedSale._id, before: deletedSale, after: { stockWarnings } });
    res.json({ 
      success: true,
      message: "Sale deleted successfully",
      stockReturned: ["sale", "reservation"].includes(deletedSale.type) &&
        deletedSale.status !== "voided" && stockWarnings.length === 0,
      stockWarnings,
    });
  } catch (error) {
    console.error("Error deleting sale:", error);
    if (error instanceof MutationError) return res.status(error.status).json({ error: error.message });
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID" });
    }
    res.status(500).json({ error: "Failed to delete sale" });
  } finally {
    await session.endSession();
  }
});

module.exports = router;
