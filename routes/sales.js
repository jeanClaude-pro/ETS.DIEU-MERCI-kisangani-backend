// routes/sales.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");
const { WALKIN_CUSTOMER_NAME, WALKIN_CUSTOMER_PHONE, resolveSaleCustomer } = require("../utils/walkInCustomer");
const { VALID_REGION_CODES } = require("../utils/regions");
const { buildCanonicalSaleItem, buildEditedSaleItem, calculateRegionTotal, calculateSaleFinancials, allocateSaleFinancialsToItems } = require("../utils/saleIntegrity");
const { aggregateItemQuantities, calculateStockDeltas } = require("../utils/saleMutations");

class MutationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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
  try {
    // FIX: Only include completed sales (exclude voided and corrected)
    let salesQuery = Sale.find({
      customerId: customerId,
      status: { $in: ["completed", "pending", undefined, null] } // Only valid sales
    })
    .sort({ createdAt: 1 })
    .select('total status type createdAt') // Only select needed fields
    .lean();
    if (session) salesQuery = salesQuery.session(session);
    const sales = await salesQuery;
    
    // Additional safety filter
    const validSales = sales.filter(sale => 
      sale.status !== "voided" && sale.status !== "corrected" && sale.type !== "expense"
    );
    
    if (validSales.length === 0) {
      await Customer.findByIdAndUpdate(customerId, {
        totalPurchases: 0,
        totalSpent: 0,
        firstPurchaseDate: null,
        lastPurchaseDate: null,
      }, { session });
      return;
    }
    
    const totalPurchases = validSales.length;
    const totalSpent = validSales.reduce((sum, sale) => sum + sale.total, 0);
    const firstPurchaseDate = validSales[0].createdAt;
    const lastPurchaseDate = validSales[validSales.length - 1].createdAt;

    await Customer.findByIdAndUpdate(customerId, {
      totalPurchases,
      totalSpent,
      firstPurchaseDate,
      lastPurchaseDate,
    });
  } catch (error) {
    console.error("Error recalculating customer stats:", error);
    throw error;
  }
}

// ==================== TIME FRAME HELPER FUNCTIONS ====================

// Kisangani (DRC) is permanently UTC+2 — no daylight saving time
const KIS_OFFSET = '+02:00';

/**
 * Returns today's date string (YYYY-MM-DD) in Kisangani local time (UTC+2).
 */
function getTodayKisangani() {
  const now = new Date();
  const local = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return local.toISOString().split('T')[0];
}

/**
 * Parse a YYYY-MM-DD string into a Date whose boundary (start or end of day)
 * is expressed in Kisangani local time (UTC+2), regardless of server timezone.
 */
function parseDate(dateStr, isEndDate = false) {
  if (!dateStr) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid date format: ${dateStr}. Use YYYY-MM-DD format.`);
  }

  const time = isEndDate ? '23:59:59.999' : '00:00:00.000';
  const date = new Date(`${dateStr}T${time}${KIS_OFFSET}`);

  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${dateStr}`);
  }

  return date;
}

/**
 * Build date range filter based on timeframe parameters
 * Follows priority: custom range > specific day > month > year > today
 * @param {Object} query - Request query parameters
 * @returns {Object} MongoDB date filter { createdAt: { $gte, $lte } }
 */
function buildTimeframeFilter(query) {
  const { from, to, date, year, month } = query;
  
  // Priority 1: Custom date range (from and to)
  if (from || to) {
    const startDate = from ? parseDate(from, false) : new Date(0); // Beginning of time
    const endDate = to ? parseDate(to, true) : new Date(); // Current date/time
    
    if (from && to && startDate > endDate) {
      throw new Error("Start date (from) must be before or equal to end date (to)");
    }
    
    return {
      createdAt: {
        $gte: startDate,
        $lte: endDate
      }
    };
  }
  
  // Priority 2: Specific day
  if (date) {
    return {
      createdAt: {
        $gte: parseDate(date, false),
        $lte: parseDate(date, true)
      }
    };
  }

  // Priority 3: Specific month
  if (year && month) {
    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10); // 1-indexed (1=Jan … 12=Dec)

    if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
      throw new Error(`Invalid year: ${year}. Must be between 2000-2100.`);
    }
    if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
      throw new Error(`Invalid month: ${month}. Must be between 01-12.`);
    }

    const mm = String(monthNum).padStart(2, '0');
    const lastDay = new Date(yearNum, monthNum, 0).getDate(); // day 0 of next month
    const dd = String(lastDay).padStart(2, '0');

    return {
      createdAt: {
        $gte: new Date(`${yearNum}-${mm}-01T00:00:00.000${KIS_OFFSET}`),
        $lte: new Date(`${yearNum}-${mm}-${dd}T23:59:59.999${KIS_OFFSET}`)
      }
    };
  }

  // Priority 4: Full year
  if (year) {
    const yearNum = parseInt(year, 10);

    if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
      throw new Error(`Invalid year: ${year}. Must be between 2000-2100.`);
    }

    return {
      createdAt: {
        $gte: new Date(`${yearNum}-01-01T00:00:00.000${KIS_OFFSET}`),
        $lte: new Date(`${yearNum}-12-31T23:59:59.999${KIS_OFFSET}`)
      }
    };
  }

  // Priority 5: Default to today in Kisangani time
  const todayStr = getTodayKisangani();
  return {
    createdAt: {
      $gte: new Date(`${todayStr}T00:00:00.000${KIS_OFFSET}`),
      $lte: new Date(`${todayStr}T23:59:59.999${KIS_OFFSET}`)
    }
  };
}

/**
 * Get human-readable timeframe description
 */
function getTimeframeDescription(query) {
  const { from, to, date, year, month } = query;
  
  if (from || to) {
    return `Custom range: ${from || 'Beginning'} to ${to || 'Now'}`;
  }
  if (date) {
    return `Day: ${date}`;
  }
  if (year && month) {
    return `Month: ${year}-${String(month).padStart(2, '0')}`;
  }
  if (year) {
    return `Year: ${year}`;
  }
  return 'Today (default)';
}

// ==================== MAIN SALES ENDPOINT (TIME FRAME PAGINATION) ====================

/** 
 * GET /api/sales
 * Timeframe-based pagination (no numeric pagination)
 * Priority: custom range > specific day > month > year > today (default)
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const {
      customerPhone,
      status,
      type,
      region
    } = req.query;

    // Build the main filter object
    const filter = {};
    
    // 1. Apply timeframe filter (priority order handled in buildTimeframeFilter)
    try {
      const timeframeFilter = buildTimeframeFilter(req.query);
      Object.assign(filter, timeframeFilter);
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD for dates, YYYY for year, MM for month (01-12)"
      });
    }
    
    // 2. Apply customer phone filter if provided
    if (customerPhone) {
      filter["customer.phone"] = customerPhone;
    }
    
    // 3. Apply status filter if provided, otherwise use default
    if (status) {
      filter.status = status;
    } else {
      // Default: include completed, pending, and expense statuses
      filter.status = { $in: ["completed", "pending", "expense"] };
    }
    
    // 4. Apply type filter if provided, otherwise use default
    if (type) {
      filter.type = type;
    } else {
      // Default: include all types
      filter.type = { $in: ["sale", "reservation", "expense"] };
    }

    // 5. Apply region filter if provided (matches any item in that region)
    if (region) {
      if (!VALID_REGION_CODES.includes(region)) {
        return res.status(400).json({ error: "Invalid region code" });
      }
    }

    // Execute query - get ALL records within timeframe (no skip/limit)
    const foundSales = await Sale.find(filter)
      .select('-__v') // Exclude version key
      .sort({ createdAt: -1 }) // Newest first as requested
      .lean();
    const resolvedSales = await resolveLegacyItemRegions(foundSales);
    const sales = region
      ? resolvedSales.filter((sale) => sale.items.some((item) => item.regionCode === region))
      : resolvedSales;
    
    // Get count for metadata
    const total = sales.length;
    
    // Generate timeframe metadata
    const timeframeDescription = getTimeframeDescription(req.query);
    const timeframeFilter = buildTimeframeFilter(req.query);
    
    // Calculate totals for quick insights
    const totals = sales.reduce((acc, sale) => {
      if (sale.type === "expense") {
        acc.totalExpenses += sale.total;
        acc.expenseCount += 1;
      } else {
        acc.totalRevenue += region ? calculateRegionTotal(sale, region) : sale.total;
        acc.saleCount += 1;
      }
      return acc;
    }, {
      totalRevenue: 0,
      totalExpenses: 0,
      saleCount: 0,
      expenseCount: 0
    });
    
    // Prepare response with timeframe metadata
    const response = {
      success: true,
      data: sales,
      timeframe: {
        description: timeframeDescription,
        start: timeframeFilter.createdAt.$gte.toISOString(),
        end: timeframeFilter.createdAt.$lte.toISOString(),
        query: {
          from: req.query.from || null,
          to: req.query.to || null,
          date: req.query.date || null,
          year: req.query.year || null,
          month: req.query.month || null
        }
      },
      summary: {
        totalRecords: total,
        revenue: totals.totalRevenue,
        expenses: totals.totalExpenses,
        net: totals.totalRevenue - totals.totalExpenses,
        salesCount: totals.saleCount,
        expensesCount: totals.expenseCount
      },
      filtersApplied: {
        customerPhone: customerPhone || 'none',
        status: status || 'default (completed, pending, expense)',
        type: type || 'default (sale, reservation, expense)',
        region: region || 'all'
      },
      // Performance warning for large datasets
      performanceNote: total > 1000 
        ? `Large dataset (${total} records). Consider using a more specific timeframe.`
        : null
    };
    
    res.json(response);
    
  } catch (error) {
    console.error("Error fetching sales with timeframe pagination:", error);
    
    // Handle specific error types
    if (error.message.includes("Invalid date format") || 
        error.message.includes("Invalid year") || 
        error.message.includes("Invalid month")) {
      return res.status(400).json({ 
        error: error.message,
        validFormats: {
          date: "YYYY-MM-DD (e.g., 2024-12-25)",
          month: "year=YYYY&month=MM (e.g., year=2024&month=12)",
          year: "year=YYYY (e.g., year=2024)",
          customRange: "from=YYYY-MM-DD&to=YYYY-MM-DD"
        }
      });
    }
    
    res.status(500).json({ 
      error: "Failed to fetch sales",
      suggestion: "Check your query parameters and try again"
    });
  }
});

// ==================== ALL OTHER ROUTES REMAIN UNCHANGED ====================

/** ---------- DAILY STATS FIRST (before :id) ---------- **/
router.get("/stats/daily", authMiddleware, async (req, res) => {
  try {
    const { date } = req.query;
    const dateStr = date || getTodayKisangani();
    const startOfDay = new Date(`${dateStr}T00:00:00.000${KIS_OFFSET}`);
    const endOfDay = new Date(`${dateStr}T23:59:59.999${KIS_OFFSET}`);

    const dailySales = await Sale.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfDay, $lte: endOfDay },
          // ✅ FIXED: INCLUDE PENDING RESERVATIONS (money already received)
          status: { $in: ["completed", "pending"] },
          // ✅ FIXED: INCLUDE BOTH SALES AND RESERVATIONS
          type: { $in: ["sale", "reservation"] }
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: 1 },
          totalRevenue: { $sum: "$total" },
          totalItems: { $sum: { $size: "$items" } },
        },
      },
    ]);

    // Use timeframe-based query (no limit) for consistency
    const sales = await Sale.find({
      createdAt: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["completed", "pending"] },
      type: { $in: ["sale", "reservation"] }
    })
    .sort({ createdAt: -1 })
    .select('-__v')
    .lean();

    res.json({
      date: dateStr,
      totalSales: dailySales[0]?.totalSales || 0,
      totalRevenue: dailySales[0]?.totalRevenue || 0,
      totalItems: dailySales[0]?.totalItems || 0,
      sales,
    });
  } catch (error) {
    console.error("Error fetching daily stats:", error);
    res.status(500).json({ error: "Failed to fetch daily statistics" });
  }
});

/** ---------- CREATE SALE OR EXPENSE ---------- **/
router.post("/", authMiddleware, async (req, res) => {
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
      // 🔹 NEW EXPENSE FIELDS
      reason,
      recipientName,
      recipientPhone,
      amount,
      recordedBy
    } = req.body;

    const normalizedPM = normalizePaymentMethod(paymentMethod);

    // 🔹 HANDLE EXPENSE TYPE
    if (type === "expense") {
      if (!reason || !recipientName || !recipientPhone || !amount) {
        return res.status(400).json({ 
          error: "Expense requires reason, recipientName, recipientPhone, and amount" 
        });
      }

      const expenseAmount = parseFloat(amount);
      if (isNaN(expenseAmount) || expenseAmount <= 0) {
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
          name: recipientName,
          phone: recipientPhone,
          email: "",
        },
        items: [], // No items for expenses
        subtotal: expenseAmount,
        total: expenseAmount,
        paymentMethod: normalizedPM,
        status: "expense", // 🔹 Special status for expenses
        salesPerson: recordedBy || salesPerson || "Admin",
        type: "expense",
        reason: reason,
        recipientName: recipientName,
        recipientPhone: recipientPhone,
        notes: notes || ""
      };

      const expense = new Sale(expenseData);
      const savedExpense = await expense.save();

      return res.status(201).json(savedExpense);
    }

    // 🔹 HANDLE REGULAR SALE (existing logic)
    // Customer info is optional — a sale with no registered customer falls
    // back to the permanent Walk-in Customer (see resolveSaleCustomer above).
    const safeCustomer = resolveSaleCustomer(customer);
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ error: "Sale must contain at least one item" });
    }

    let subtotal = 0;
    const enrichedItems = [];
    for (const item of items) {
      const { productId, quantity, price } = item || {};
      if (!productId || !quantity || quantity <= 0 || !price || price < 0) {
        return res.status(400).json({
          error: "Each item requires productId, quantity>0, and price>=0",
        });
      }

      const product = await Product.findById(productId).lean();
      if (!product)
        return res
          .status(400)
          .json({ error: `Product not found: ${productId}` });

      if (typeof product.stock !== "number" || product.stock < quantity) {
        return res.status(400).json({
          error: `Insufficient stock for ${
            product.name || name || productId
          }. Available: ${product.stock ?? 0}`,
        });
      }

      if (!product.region || !product.regionCode) {
        return res.status(400).json({
          error: `Product "${product.name || productId}" has no region assigned. Contact an administrator.`,
        });
      }

      const canonicalItem = buildCanonicalSaleItem(product, { quantity, price });
      subtotal += canonicalItem.total;
      enrichedItems.push(canonicalItem);
    }

    const financials = calculateSaleFinancials(subtotal, { discount, tax, transportCost, otherCharges });
    const allocatedItems = allocateSaleFinancialsToItems(enrichedItems, financials);
    const total = financials.total;
    const saleId = `SALE-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 5)
      .toUpperCase()}`;

    const saleNumber = `SN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // UPDATED: Include type and reservation fields WITH CORRECT STATUS
    const saleData = {
      saleId,
      saleNumber,
      customer: safeCustomer,
      customerId: null,
      items: allocatedItems,
      ...financials,
      cost: allocatedItems.reduce((sum, item) => sum + item.cost, 0),
      profit: total - allocatedItems.reduce((sum, item) => sum + item.cost, 0),
      paymentMethod: normalizedPM,
      status: type === "reservation" ? "pending" : "completed", // ✅ FIXED: Reservations as pending (money received)
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
        }
      })
    };

    const session = await mongoose.startSession();
    let savedSale;
    try {
      await session.withTransaction(async () => {
        if (!safeCustomer.isWalkIn && safeCustomer.phone) {
          saleData.customerId = await updateCustomerData(safeCustomer, session);
        }
        for (const [productId, quantity] of aggregateItemQuantities(enrichedItems)) {
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
    } finally {
      await session.endSession();
    }

    return res.status(201).json(savedSale);
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

// ==================== MODIFIED ENDPOINTS (REMOVE PAGINATION) ====================

/** ---------- GET EXPENSES (TIME FRAME BASED) ---------- **/
router.get("/expenses/all", authMiddleware, async (req, res) => {
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

    const expenses = await Sale.find(filter)
      .select('-__v -items') // Expenses don't have items
      .sort({ createdAt: -1 })
      .lean();

    const total = expenses.length;
    const totalAmount = expenses.reduce((sum, expense) => sum + expense.total, 0);

    res.json({
      success: true,
      data: expenses,
      summary: {
        totalExpenses: total,
        totalAmount: totalAmount,
        timeframe: getTimeframeDescription(req.query)
      }
    });
  } catch (error) {
    console.error("Error fetching expenses:", error);
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
});

/** ---------- GET RESERVATIONS (TIME FRAME BASED) ---------- **/
router.get("/reservations/all", authMiddleware, async (req, res) => {
  try {
    const {
      status,
      region
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
      type: "reservation",
      ...timeframeFilter
    };

    if (status) {
      filter.status = status;
    }

    if (region) {
      if (!VALID_REGION_CODES.includes(region)) {
        return res.status(400).json({ error: "Invalid region code" });
      }
    }

    const foundReservations = await Sale.find(filter)
      .select('-__v') // Exclude version key
      .sort({ createdAt: -1 })
      .lean();
    const resolvedReservations = await resolveLegacyItemRegions(foundReservations);
    const reservations = region
      ? resolvedReservations.filter((sale) => sale.items.some((item) => item.regionCode === region))
      : resolvedReservations;

    const total = reservations.length;
    const pendingCount = reservations.filter(r => r.status === "pending").length;
    const completedCount = reservations.filter(r => r.status === "completed").length;

    res.json({
      success: true,
      data: reservations,
      summary: {
        totalReservations: total,
        pending: pendingCount,
        completed: completedCount,
        timeframe: getTimeframeDescription(req.query)
      }
    });
  } catch (error) {
    console.error("Error fetching reservations:", error);
    res.status(500).json({ error: "Failed to fetch reservations" });
  }
});

// ==================== ALL OTHER ROUTES REMAIN EXACTLY THE SAME ====================

/** ---------- GET BY ID (after other specific routes) ---------- **/
router.get("/:id", authMiddleware, async (req, res) => {
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
      data: sale,
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
router.put("/:id", authMiddleware, async (req, res) => {
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

    // 🔹 NEW: RESTRICTION FOR RESERVATIONS
    if (originalSale.type === "reservation") {
      const userRole = req.user.role;
      
      // If reservation is completed, only admin can edit
      if (originalSale.status === "completed" && userRole !== "admin") {
        return res.status(403).json({ 
          error: "Only admin can edit completed reservations" 
        });
      }
      
      // If reservation is pending, only admin and manager can edit
      if (originalSale.status === "pending" && 
          userRole !== "admin" && userRole !== "manager") {
        return res.status(403).json({ 
          error: "Only admin and manager can edit pending reservations" 
        });
      }
    }

    // Prevent editing voided or corrected sales
    if (originalSale.status === "voided" || originalSale.status === "corrected") {
      return res.status(400).json({ 
        error: "Cannot edit a voided or corrected sale" 
      });
    }

    const normalizedPM = normalizePaymentMethod(paymentMethod);

    // 🔹 HANDLE EXPENSE EDITING
    if (originalSale.type === "expense" || type === "expense") {
      if (!reason || !recipientName || !recipientPhone || !amount) {
        return res.status(400).json({ 
          error: "Expense requires reason, recipientName, recipientPhone, and amount" 
        });
      }

      const expenseAmount = parseFloat(amount);
      if (isNaN(expenseAmount) || expenseAmount <= 0) {
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
          notes: notes || originalSale.notes,
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
    
    for (const item of items) {
      const { productId, quantity, price } = item || {};
      if (!productId || !quantity || quantity <= 0 || !price || price < 0) {
        return res.status(400).json({
          error: "Each item requires productId, quantity>0, and price>=0",
        });
      }

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
            reservationDate: reservationDate || originalSale.reservationDate,
            reservationTime: reservationTime || originalSale.reservationTime,
            notes: notes || originalSale.notes,
            editedBy: req.user.userId,
            editedAt: new Date(),
            $push: {
              editHistory: {
                editedBy: req.user.userId,
                editedAt: new Date(),
                changes: Object.fromEntries(changes),
                reason: reason || "Sale correction"
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
router.patch("/:id/complete", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { completedBy } = req.body;

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
        completedBy: completedBy || req.user.userId,
      },
      { new: true }
    );

    res.json(updatedSale);
  } catch (error) {
    console.error("Error completing reservation:", error);
    res.status(500).json({ error: "Échec de la mise à jour de la réservation" });
  }
});

/** ---------- MARK RESERVATION AS PENDING ---------- **/
router.patch("/:id/pending", authMiddleware, async (req, res) => {
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

    res.json(updatedSale);
  } catch (error) {
    console.error("Error setting reservation to pending:", error);
    res.status(500).json({ error: "Échec de la mise à jour de la réservation" });
  }
});

/** ---------- VOID/REFUND SALE ---------- **/
router.patch("/:id/void", authMiddleware, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admins can void sales" });
    }

    const { id } = req.params;
    const { reason } = req.body;

    let voidedSale;
    let stockWarnings = [];
    await session.withTransaction(async () => {
      stockWarnings = [];
      const sale = await Sale.findById(id).session(session).lean();
      if (!sale) throw new MutationError(404, "Sale not found");
      if (sale.status === "voided") throw new MutationError(400, "Sale is already voided");

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
router.delete("/:id", authMiddleware, async (req, res) => {
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
