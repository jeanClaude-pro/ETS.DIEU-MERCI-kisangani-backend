const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Entry = require("../models/Entry");
const authMiddleware = require("../middleware/auth");
const requireModulePermission = require("../middleware/requireModulePermission");
const { isValidRegionPair } = require("../utils/regions");
const reportingDate = require("../utils/reportingDate");
const { buildTimeframeFilter, getTimeframeDescription, getTodayKisangani } = reportingDate;


// Normalize payment method (same as your sales route)
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

async function getPagedEntriesWithSummary(filter, query) {
  const { page, limit, skip } = reportingDate.parsePagination(query);
  const [facet = {}] = await Entry.aggregate([
    { $match: filter },
    { $facet: {
      entries: [
        { $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit },
        { $lookup: { from: "users", localField: "createdBy", foreignField: "_id", as: "createdByUser" } },
        { $set: { createdBy: { $ifNull: [{ $first: "$createdByUser" }, "$createdBy"] } } },
        { $project: { __v: 0, createdByUser: 0, "createdBy.password": 0 } },
      ],
      summary: [{ $group: { _id: null, count: { $sum: 1 }, totalAmount: { $sum: "$amount" }, averageAmount: { $avg: "$amount" } } }],
    } },
  ]);
  const summary = facet.summary?.[0] || { count: 0, totalAmount: 0, averageAmount: 0 };
  return {
    entries: facet.entries || [],
    summary,
    pagination: { totalRecords: summary.count, totalPages: Math.ceil(summary.count / limit), currentPage: page, limit },
  };
}

// ==================== MAIN ENTRIES ENDPOINT (TIME FRAME PAGINATION) ====================

/** 
 * GET /api/entries
 * Timeframe filters with bounded page-based pagination
 * Priority: custom range > specific day > month > year > today (default)
 */
router.get("/", authMiddleware, requireModulePermission("entryhistory"), async (req, res) => {
  try {
    const {
      category,
      source,
      status,
      search,
      createdBy,
      region,
      edited
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
    
    // 2. Apply status filter if provided, otherwise use default
    if (status) {
      if (status === 'all') {
        // Include all statuses
        filter.status = { $in: ["active", "deleted"] };
      } else if (["active", "deleted"].includes(status)) {
        filter.status = status;
      } else {
        return res.status(400).json({ error: "Invalid status. Use 'active', 'deleted', or 'all'" });
      }
    } else {
      // Default: include only active entries
      filter.status = "active";
    }
    
    // 3. Apply category filter if provided
    if (category) {
      filter.category = category;
    }
    
    // 4. Apply source filter if provided
    if (source) {
      filter.source = source;
    }
    
    // 5. Apply createdBy filter if provided
    if (createdBy) {
      if (!mongoose.isValidObjectId(createdBy)) return res.status(400).json({ error: "Invalid createdBy ID" });
      filter.createdBy = new mongoose.Types.ObjectId(createdBy);
    }
    
    // 6. Apply search filter if provided
    if (search) {
      const escapedSearch = String(search).replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
      filter.$or = [
        { entryId: { $regex: escapedSearch, $options: "i" } },
        { source: { $regex: escapedSearch, $options: "i" } },
        { category: { $regex: escapedSearch, $options: "i" } },
        { description: { $regex: escapedSearch, $options: "i" } }
      ];
    }

    // 7. Apply region filter if provided
    if (region) {
      if (!["Bbbb", "Cnnn"].includes(region)) return res.status(400).json({ error: "Invalid region code" });
      filter.regionCode = region;
    }
    if (edited === "true") filter["editHistory.0"] = { $exists: true };

    const { page, limit, skip } = reportingDate.parsePagination(req.query);
    const [facet = {}] = await Entry.aggregate([
      { $match: filter },
      { $facet: {
        data: [
          { $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit },
          { $lookup: { from: "users", localField: "createdBy", foreignField: "_id", as: "createdByUser" } },
          { $lookup: { from: "users", localField: "updatedBy", foreignField: "_id", as: "updatedByUser" } },
          { $set: {
            createdBy: { $ifNull: [{ $first: "$createdByUser" }, "$createdBy"] },
            updatedBy: { $ifNull: [{ $first: "$updatedByUser" }, "$updatedBy"] },
          } },
          { $project: { __v: 0, createdByUser: 0, updatedByUser: 0, "createdBy.password": 0, "updatedBy.password": 0 } },
        ],
        metadata: [{ $count: "totalRecords" }],
        totals: [{ $group: {
          _id: null,
          totalAmount: { $sum: "$amount" },
          activeCount: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
          activeAmount: { $sum: { $cond: [{ $eq: ["$status", "active"] }, "$amount", 0] } },
          deletedCount: { $sum: { $cond: [{ $eq: ["$status", "deleted"] }, 1, 0] } },
          deletedAmount: { $sum: { $cond: [{ $eq: ["$status", "deleted"] }, "$amount", 0] } },
        } }],
        categories: [{ $group: { _id: "$category", amount: { $sum: "$amount" } } }],
        paymentMethods: [{ $group: { _id: "$paymentMethod", amount: { $sum: "$amount" } } }],
      } },
    ]).allowDiskUse(true);
    const entries = facet.data || [];
    const total = facet.metadata?.[0]?.totalRecords || 0;

    // Generate timeframe metadata
    const timeframeDescription = getTimeframeDescription(req.query);
    const timeframeFilter = buildTimeframeFilter(req.query);

    const totals = {
      totalAmount: 0,
      activeCount: 0,
      activeAmount: 0,
      deletedCount: 0,
      deletedAmount: 0,
      ...(facet.totals?.[0] || {}),
      paymentMethods: Object.fromEntries((facet.paymentMethods || []).map((row) => [row._id, row.amount])),
      categories: Object.fromEntries((facet.categories || []).map((row) => [row._id, row.amount])),
    };

    // Prepare response with timeframe metadata
    const response = {
      success: true,
      data: entries,
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
        totalAmount: totals.totalAmount,
        active: {
          count: totals.activeCount,
          amount: totals.activeAmount
        },
        deleted: {
          count: totals.deletedCount,
          amount: totals.deletedAmount
        },
        categories: totals.categories,
        paymentMethods: totals.paymentMethods
      },
      pagination: { totalRecords: total, totalPages: Math.ceil(total / limit), currentPage: page, limit },
      filtersApplied: {
        status: status || 'default (active only)',
        category: category || 'none',
        source: source || 'none',
        createdBy: createdBy || 'none',
        search: search || 'none',
        region: region || 'all'
      },
      // Performance warning for large datasets
      performanceNote: total > 1000 
        ? `Large dataset (${total} records). Consider using a more specific timeframe.`
        : null
    };

    res.json(response);
    
  } catch (error) {
    console.error("Error fetching entries with timeframe pagination:", error);
    
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
      error: "Failed to fetch entries",
      suggestion: "Check your query parameters and try again"
    });
  }
});

// ==================== ALL OTHER ROUTES ====================

/** ---------- CREATE ENTRY (Everyone can create) ---------- */
router.post("/", authMiddleware, requireModulePermission("entry"), async (req, res) => {
  try {
    const {
      amount,
      source,
      paymentMethod,
      category,
      description,
      receivedFrom,
      region,
      regionCode
    } = req.body;

    // Validation (like your sale validation)
    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: "Amount is required and must be positive"
      });
    }
    if (!source) {
      return res.status(400).json({
        error: "Source is required"
      });
    }
    if (!category) {
      return res.status(400).json({
        error: "Category is required"
      });
    }
    if (!region || !regionCode || !isValidRegionPair(region, regionCode)) {
      return res.status(400).json({
        error: "A valid region (Butembo/China) is required",
      });
    }

    const normalizedPM = normalizePaymentMethod(paymentMethod);
    const entryAmount = parseFloat(amount);

    // Generate unique entry ID (like your saleId)
    const entryId = `ENTRY-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 5)
      .toUpperCase()}`;

    const entryData = {
      entryId,
      amount: entryAmount,
      source: source.trim(),
      paymentMethod: normalizedPM,
      category: category.trim(),
      description: description ? description.trim() : "",
      receivedFrom: receivedFrom || {},
      createdBy: req.user.userId,
      region,
      regionCode
    };

    const entry = new Entry(entryData);
    const savedEntry = await entry.save();

    return res.status(201).json(savedEntry);
  } catch (error) {
    console.error("Error creating entry:", error);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    return res.status(500).json({ error: "Failed to create entry" });
  }
});

/** ---------- GET ENTRY BY ID ---------- */
router.get("/:id", authMiddleware, requireModulePermission("entryhistory"), async (req, res) => {
  try {
    const entryId = req.params.id;
    
    const entry = await Entry.findById(entryId)
      .populate("createdBy", "username email")
      .populate("updatedBy", "username")
      .populate("editHistory.editedBy", "username email");

    if (!entry) {
      return res.status(404).json({ error: "Entry not found" });
    }

    res.json(entry);
  } catch (error) {
    console.error("Error fetching entry:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid entry ID" });
    }
    res.status(500).json({ error: "Failed to fetch entry" });
  }
});

/** ---------- EDIT ENTRY (Admin only) ---------- */
router.put("/:id", authMiddleware, requireModulePermission("entryhistory"), async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin") {
      return res.status(403).json({ 
        error: "Access denied. Only administrators can edit entries." 
      });
    }

    const { id } = req.params;
    const {
      amount,
      source,
      paymentMethod,
      category,
      description,
      receivedFrom,
      reason,
      region,
      regionCode
    } = req.body;

    if ((region !== undefined || regionCode !== undefined) &&
        !isValidRegionPair(region, regionCode)) {
      return res.status(400).json({
        error: "A valid region (Butembo/China) is required",
      });
    }

    // Validate required fields for edit
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        error: "Amount is required and must be positive" 
      });
    }
    if (!source) {
      return res.status(400).json({ 
        error: "Source is required" 
      });
    }
    if (!category) {
      return res.status(400).json({ 
        error: "Category is required" 
      });
    }
    if (!reason || reason.trim() === "") {
      return res.status(400).json({ 
        error: "Reason for editing is required" 
      });
    }

    // Find the original entry
    const originalEntry = await Entry.findById(id);
    if (!originalEntry) {
      return res.status(404).json({ error: "Entry not found" });
    }

    // Prevent editing deleted entries
    if (originalEntry.status === "deleted") {
      return res.status(400).json({ 
        error: "Cannot edit a deleted entry" 
      });
    }

    const normalizedPM = normalizePaymentMethod(paymentMethod);
    const entryAmount = parseFloat(amount);

    // Track changes for audit
    const changes = new Map();
    
    if (originalEntry.amount !== entryAmount) {
      changes.set('amount', { 
        from: originalEntry.amount, 
        to: entryAmount 
      });
    }
    if (originalEntry.source !== source) {
      changes.set('source', { 
        from: originalEntry.source, 
        to: source 
      });
    }
    if (originalEntry.paymentMethod !== normalizedPM) {
      changes.set('paymentMethod', { 
        from: originalEntry.paymentMethod, 
        to: normalizedPM 
      });
    }
    if (originalEntry.category !== category) {
      changes.set('category', { 
        from: originalEntry.category, 
        to: category 
      });
    }
    if (originalEntry.description !== description) {
      changes.set('description', { 
        from: originalEntry.description, 
        to: description 
      });
    }
    if (JSON.stringify(originalEntry.receivedFrom) !== JSON.stringify(receivedFrom)) {
      changes.set('receivedFrom', { 
        from: originalEntry.receivedFrom, 
        to: receivedFrom 
      });
    }

    // Check if there are actual changes
    if (changes.size === 0) {
      return res.status(400).json({ 
        error: "No changes detected" 
      });
    }

    const updatedEntry = await Entry.findByIdAndUpdate(
      id,
      {
        amount: entryAmount,
        source: source.trim(),
        paymentMethod: normalizedPM,
        category: category.trim(),
        description: description ? description.trim() : "",
        receivedFrom: receivedFrom || {},
        updatedBy: req.user.userId,
        ...(region !== undefined && { region }),
        ...(regionCode !== undefined && { regionCode }),
        $push: {
          editHistory: {
            editedBy: req.user.userId,
            editedAt: new Date(),
            changes: Object.fromEntries(changes),
            reason: reason.trim()
          }
        }
      },
      { new: true, runValidators: true }
    ).populate("createdBy", "username")
     .populate("updatedBy", "username")
     .populate("editHistory.editedBy", "username");

    res.json({
      message: "Entry updated successfully",
      entry: updatedEntry
    });
  } catch (error) {
    console.error("Error editing entry:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid entry ID" });
    }
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    res.status(500).json({ error: "Failed to edit entry" });
  }
});

/** ---------- DELETE ENTRY (Admin only - soft delete) ---------- */
router.delete("/:id", authMiddleware, requireModulePermission("entryhistory"), async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin") {
      return res.status(403).json({ 
        error: "Access denied. Only administrators can delete entries." 
      });
    }

    const entry = await Entry.findById(req.params.id);
    
    if (!entry) {
      return res.status(404).json({ error: "Entry not found" });
    }

    if (entry.status === "deleted") {
      return res.status(400).json({ error: "Entry is already deleted" });
    }

    // Soft delete
    const deletedEntry = await Entry.findByIdAndUpdate(
      req.params.id,
      {
        status: "deleted",
        deletedBy: req.user.userId,
        deletedAt: new Date()
      },
      { new: true }
    );

    res.json({ 
      message: "Entry deleted successfully", 
      entry: deletedEntry 
    });
  } catch (error) {
    console.error("Error deleting entry:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid entry ID" });
    }
    
    res.status(500).json({ error: "Failed to delete entry" });
  }
});

/** ---------- RESTORE ENTRY (Admin only) ---------- */
router.patch("/:id/restore", authMiddleware, requireModulePermission("entryhistory"), async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin") {
      return res.status(403).json({ 
        error: "Access denied. Only administrators can restore entries." 
      });
    }

    const entry = await Entry.findById(req.params.id);
    
    if (!entry) {
      return res.status(404).json({ error: "Entry not found" });
    }

    if (entry.status !== "deleted") {
      return res.status(400).json({ error: "Entry is not deleted" });
    }

    const restoredEntry = await Entry.findByIdAndUpdate(
      req.params.id,
      {
        status: "active",
        deletedBy: null,
        deletedAt: null,
        updatedBy: req.user.userId
      },
      { new: true }
    );

    res.json({ 
      message: "Entry restored successfully", 
      entry: restoredEntry 
    });
  } catch (error) {
    console.error("Error restoring entry:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid entry ID" });
    }
    
    res.status(500).json({ error: "Failed to restore entry" });
  }
});

/** ---------- DAILY ENTRY STATS (like your sales stats) ---------- */
router.get("/stats/daily", authMiddleware, requireModulePermission("entryhistory"), async (req, res) => {
  try {
    const dateStr = req.query.date || getTodayKisangani();
    const dateFilter = buildTimeframeFilter({ date: dateStr });
    const { page, limit, skip } = reportingDate.parsePagination(req.query);
    const [facet = {}] = await Entry.aggregate([
      { $match: { ...dateFilter, status: "active" } },
      { $facet: {
        summary: [{ $group: { _id: null, totalEntries: { $sum: 1 }, totalAmount: { $sum: "$amount" } } }],
        categories: [{ $group: { _id: "$category", amount: { $sum: "$amount" } } }],
        paymentMethods: [{ $group: { _id: "$paymentMethod", amount: { $sum: "$amount" } } }],
        entries: [
          { $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit },
          { $lookup: { from: "users", localField: "createdBy", foreignField: "_id", as: "createdByUser" } },
          { $set: { createdBy: { $ifNull: [{ $first: "$createdByUser" }, "$createdBy"] } } },
          { $project: { __v: 0, createdByUser: 0, "createdBy.password": 0 } },
        ],
      } },
    ]);
    const summary = facet.summary?.[0] || { totalEntries: 0, totalAmount: 0 };
    res.json({
      date: dateStr,
      ...summary,
      categoryBreakdown: Object.fromEntries((facet.categories || []).map((row) => [row._id, row.amount])),
      paymentMethodBreakdown: Object.fromEntries((facet.paymentMethods || []).map((row) => [row._id, row.amount])),
      entries: facet.entries || [],
      pagination: { totalRecords: summary.totalEntries, totalPages: Math.ceil(summary.totalEntries / limit), currentPage: page, limit },
    });
  } catch (error) {
    console.error("Error fetching daily entry stats:", error);
    res.status(500).json({ error: "Failed to fetch daily statistics" });
  }
});

/** ---------- GET ENTRY STATISTICS WITH TIMEFRAME FILTERING ---------- */
router.get("/stats/summary", authMiddleware, requireModulePermission("entryhistory"), async (req, res) => {
  try {
    const timeframeFilter = { ...buildTimeframeFilter(req.query), status: "active" };
    const [facet = {}] = await Entry.aggregate([
      { $match: timeframeFilter },
      { $facet: {
        totals: [{ $group: { _id: null, totalEntries: { $sum: 1 }, totalAmount: { $sum: "$amount" }, avgAmount: { $avg: "$amount" }, maxAmount: { $max: "$amount" }, minAmount: { $min: "$amount" } } }],
        categories: [{ $group: { _id: "$category", count: { $sum: 1 }, totalAmount: { $sum: "$amount" }, avgAmount: { $avg: "$amount" } } }, { $sort: { totalAmount: -1, _id: 1 } }],
        sources: [{ $group: { _id: "$source", count: { $sum: 1 }, totalAmount: { $sum: "$amount" }, avgAmount: { $avg: "$amount" } } }, { $sort: { totalAmount: -1, _id: 1 } }],
        paymentMethods: [{ $group: { _id: "$paymentMethod", count: { $sum: 1 }, totalAmount: { $sum: "$amount" }, avgAmount: { $avg: "$amount" } } }, { $sort: { totalAmount: -1, _id: 1 } }],
        dailyBreakdown: [{ $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Africa/Lubumbashi" } }, count: { $sum: 1 }, totalAmount: { $sum: "$amount" } } }, { $sort: { _id: 1 } }, { $limit: 30 }],
        topEntries: [{ $sort: { amount: -1, _id: 1 } }, { $limit: 10 }, { $project: { entryId: 1, source: 1, amount: 1, category: 1, paymentMethod: 1, createdAt: 1 } }],
        frequentSources: [{ $group: { _id: "$source", count: { $sum: 1 }, totalAmount: { $sum: "$amount" }, avgAmount: { $avg: "$amount" } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 10 }],
      } },
    ]);
    res.json({
      timeframe: {
        description: getTimeframeDescription(req.query),
        start: timeframeFilter.createdAt.$gte,
        end: timeframeFilter.createdAt.$lte,
      },
      totals: facet.totals?.[0] || { totalEntries: 0, totalAmount: 0, avgAmount: 0, maxAmount: 0, minAmount: 0 },
      categories: facet.categories || [],
      sources: facet.sources || [],
      paymentMethods: facet.paymentMethods || [],
      dailyBreakdown: (facet.dailyBreakdown || []).map((day) => ({ date: day._id, count: day.count, totalAmount: day.totalAmount })),
      topEntries: facet.topEntries || [],
      frequentSources: facet.frequentSources || [],
    });
  } catch (error) {
    console.error("Error fetching entry statistics:", error);
    res.status(/Invalid date|Invalid year|Invalid month|Start date/.test(error.message) ? 400 : 500)
      .json({ error: /Invalid/.test(error.message) ? error.message : "Failed to fetch entry statistics" });
  }
});

/** ---------- GET ENTRIES BY CATEGORY WITH TIMEFRAME ---------- */
router.get("/category/:category", authMiddleware, requireModulePermission("entryhistory"), async (req, res) => {
  try {
    const { category } = req.params;
    
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

    // Add category filter
    timeframeFilter.category = category;
    timeframeFilter.status = "active";

    const { entries, summary, pagination } = await getPagedEntriesWithSummary(timeframeFilter, req.query);

    res.json({
      success: true,
      category: category,
      timeframe: getTimeframeDescription(req.query),
      summary,
      pagination,
      entries
    });
  } catch (error) {
    console.error("Error fetching entries by category:", error);
    res.status(500).json({ error: "Failed to fetch entries by category" });
  }
});

/** ---------- GET ENTRIES BY SOURCE WITH TIMEFRAME ---------- */
router.get("/source/:source", authMiddleware, requireModulePermission("entryhistory"), async (req, res) => {
  try {
    const { source } = req.params;
    
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

    // Add source filter
    timeframeFilter.source = source;
    timeframeFilter.status = "active";

    const { entries, summary, pagination } = await getPagedEntriesWithSummary(timeframeFilter, req.query);

    res.json({
      success: true,
      source: source,
      timeframe: getTimeframeDescription(req.query),
      summary,
      pagination,
      entries
    });
  } catch (error) {
    console.error("Error fetching entries by source:", error);
    res.status(500).json({ error: "Failed to fetch entries by source" });
  }
});

/** ---------- GET ENTRIES BY PAYMENT METHOD WITH TIMEFRAME ---------- */
router.get("/payment/:method", authMiddleware, requireModulePermission("entryhistory"), async (req, res) => {
  try {
    const { method } = req.params;
    
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

    // Add payment method filter
    timeframeFilter.paymentMethod = method;
    timeframeFilter.status = "active";

    const { entries, summary, pagination } = await getPagedEntriesWithSummary(timeframeFilter, req.query);

    res.json({
      success: true,
      paymentMethod: method,
      timeframe: getTimeframeDescription(req.query),
      summary,
      pagination,
      entries
    });
  } catch (error) {
    console.error("Error fetching entries by payment method:", error);
    res.status(500).json({ error: "Failed to fetch entries by payment method" });
  }
});

/** ---------- GET USER'S ENTRIES WITH TIMEFRAME ---------- */
router.get("/user/me", authMiddleware, async (req, res) => {
  try {
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

    // Add user filter
    if (!mongoose.isValidObjectId(req.user.userId)) return res.status(400).json({ error: "Invalid user ID" });
    timeframeFilter.createdBy = new mongoose.Types.ObjectId(req.user.userId);
    timeframeFilter.status = "active";

    const { entries, summary, pagination } = await getPagedEntriesWithSummary(timeframeFilter, req.query);

    res.json({
      success: true,
      userId: req.user.userId,
      timeframe: getTimeframeDescription(req.query),
      summary,
      pagination,
      entries
    });
  } catch (error) {
    console.error("Error fetching user's entries:", error);
    res.status(500).json({ error: "Failed to fetch user's entries" });
  }
});

/** ---------- GET USER PERMISSIONS ---------- */
router.get("/permissions/me", authMiddleware, async (req, res) => {
  try {
    const permissions = {
      canCreate: true, // Everyone can create entries
      canEdit: req.user.role === "admin",
      canDelete: req.user.role === "admin",
      canRestore: req.user.role === "admin",
      role: req.user.role,
      userId: req.user.userId,
      userName: req.user.username || req.user.email || "User"
    };

    res.json(permissions);
  } catch (error) {
    console.error("Error fetching user permissions:", error);
    res.status(500).json({ error: "Failed to fetch user permissions" });
  }
});

/** ---------- GET ENTRIES HISTORY/AUDIT LOG ---------- */
router.get("/:id/history", authMiddleware, requireModulePermission("entryhistory"), async (req, res) => {
  try {
    const entry = await Entry.findById(req.params.id)
      .populate("editHistory.editedBy", "username email");

    if (!entry) {
      return res.status(404).json({ error: "Entry not found" });
    }

    res.json({
      entryId: entry.entryId,
      currentStatus: entry.status,
      history: entry.editHistory || []
    });
  } catch (error) {
    console.error("Error fetching entry history:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid entry ID" });
    }
    res.status(500).json({ error: "Failed to fetch entry history" });
  }
});

module.exports = router;
