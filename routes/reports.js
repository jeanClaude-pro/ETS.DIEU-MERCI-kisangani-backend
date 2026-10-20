const express = require("express");
const Sale = require("../models/Sale");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const Entry = require("../models/Entry");
const Expense = require("../models/Expense");
const authMiddleware = require("../middleware/auth");
const requireModulePermission = require("../middleware/requireModulePermission");
const { VALID_REGION_CODES } = require("../utils/regions");
const { buildTimeframeFilter, timeframeMetadata, parseReportingDate, getTodayKisangani } = require("../utils/reportingDate");
const { REPORTABLE_SALE_MATCH, itemSubtotal, itemRegion, scopedRevenueExpression, percentChange, dateGroup } = require("../utils/reportingPipelines");
const { resolveSeriesPlan, mergeSeries, sumSeries, money: cashflowMoney } = require("../utils/cashflowSeries");
const { canSeeCosts } = require("../utils/saleAccess");
const { resolveRegion } = require("../utils/regionScope");

const router = express.Router();

// Region-scoped accounts always report on their own region only.
function regionFromQuery(req, res) {
  try {
    return resolveRegion(req.user, req.query.region || "");
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
    return null;
  }
}

function regionReceiptFilter(region) {
  if (!region) return {};
  return { $or: [
    { "items.regionCode": region },
    { "items.region": region === "Bbbb" ? "Butembo" : "China" },
  ] };
}

function saleMatch(dateFilter, region) {
  return { ...REPORTABLE_SALE_MATCH, ...dateFilter, ...regionReceiptFilter(region) };
}

function money(result, field) {
  return Number(result?.[0]?.[field] || 0);
}

function compactTrend(rows, idField, labelField) {
  return rows.map((row) => ({
    [idField]: row._id,
    [labelField]: row._id,
    sales: row.sales,
    revenue: row.revenue,
  }));
}

router.get("/analytics", authMiddleware, requireModulePermission("reports"), async (req, res) => {
  try {
    const region = regionFromQuery(req, res);
    if (region === null) return;
    const dateFilter = buildTimeframeFilter(req.query);
    const match = saleMatch(dateFilter, region);
    const revenue = scopedRevenueExpression(region);
    const itemRegionMatch = region ? { $expr: { $eq: [itemRegion("$items"), region] } } : null;
    const periodMilliseconds = dateFilter.createdAt.$lte.getTime() - dateFilter.createdAt.$gte.getTime() + 1;
    const previousEnd = new Date(dateFilter.createdAt.$gte.getTime() - 1);
    const previousDateFilter = { createdAt: {
      $gte: new Date(previousEnd.getTime() - periodMilliseconds + 1),
      $lte: previousEnd,
    } };

    const [salesSummary, previousSalesSummary, entriesSummary, expensesSummary, customerSummary, previousCustomerSummary, productSummary,
      topProducts, topCustomers, daily, weekly, monthly, availableYears] = await Promise.all([
      Sale.aggregate([{ $match: match }, { $group: { _id: null, totalSales: { $sum: 1 }, totalRevenue: { $sum: revenue }, averageSale: { $avg: revenue } } }]),
      Sale.aggregate([{ $match: saleMatch(previousDateFilter, region) }, { $group: { _id: null, totalSales: { $sum: 1 }, totalRevenue: { $sum: revenue } } }]),
      Entry.aggregate([{ $match: { ...dateFilter, status: "active", ...(region ? { regionCode: region } : {}) } }, { $group: { _id: null, totalEntries: { $sum: "$amount" }, entryCount: { $sum: 1 } } }]),
      Expense.aggregate([
        { $match: { ...dateFilter, status: "validated", ...(region ? { regionCode: region } : {}) } },
        { $facet: {
          summary: [{ $group: { _id: null, totalValidatedExpenses: { $sum: "$amount" }, expenseCount: { $sum: 1 } } }],
          expenses: [
            { $sort: { createdAt: -1, _id: -1 } },
            { $project: { _id: 1, expenseId: 1, reason: 1, amount: 1, recipientName: 1, paymentMethod: 1, regionCode: 1, validatedAt: 1, createdAt: 1 } },
          ],
        } },
      ]),
      Sale.aggregate([{ $match: { ...match, "customer.isWalkIn": { $ne: true } } }, { $group: { _id: { $ifNull: ["$customerId", { $ifNull: ["$customer.phone", "$customer.name"] }] } } }, { $count: "count" }]),
      Sale.aggregate([{ $match: { ...saleMatch(previousDateFilter, region), "customer.isWalkIn": { $ne: true } } }, { $group: { _id: { $ifNull: ["$customerId", { $ifNull: ["$customer.phone", "$customer.name"] }] } } }, { $count: "count" }]),
      Sale.aggregate([{ $match: match }, { $unwind: "$items" }, ...(itemRegionMatch ? [{ $match: itemRegionMatch }] : []), { $group: { _id: { productId: "$items.productId", name: "$items.name", regionCode: itemRegion("$items") } } }, { $count: "count" }]),
      Sale.aggregate([{ $match: match }, { $unwind: "$items" }, ...(itemRegionMatch ? [{ $match: itemRegionMatch }] : []), { $group: {
        _id: { productId: "$items.productId", name: "$items.name", regionCode: itemRegion("$items") },
        quantity: { $sum: { $ifNull: ["$items.quantity", 0] } },
        revenue: { $sum: { $ifNull: ["$items.netTotal", itemSubtotal("$items")] } },
      } }, { $sort: { quantity: -1, "_id.name": 1 } }, { $limit: 50 }, { $project: { _id: 0, productId: "$_id.productId", name: "$_id.name", regionCode: "$_id.regionCode", quantity: 1, revenue: 1 } }]),
      Sale.aggregate([{ $match: { ...match, "customer.isWalkIn": { $ne: true } } }, { $group: {
        _id: { $ifNull: ["$customerId", { $ifNull: ["$customer.phone", "$customer.name"] }] },
        name: { $first: "$customer.name" }, purchases: { $sum: 1 }, totalSpent: { $sum: revenue }, lastPurchase: { $max: "$createdAt" }, averagePurchase: { $avg: revenue },
      } }, { $sort: { totalSpent: -1, name: 1 } }, { $limit: 5 }, { $project: { _id: 0, name: 1, purchases: 1, totalSpent: 1, lastPurchase: 1, averagePurchase: 1 } }]),
      Sale.aggregate([{ $match: match }, { $group: { _id: dateGroup("%Y-%m-%d"), sales: { $sum: 1 }, revenue: { $sum: revenue } } }, { $sort: { _id: 1 } }]),
      Sale.aggregate([{ $match: match }, { $group: { _id: dateGroup("%G-W%V"), sales: { $sum: 1 }, revenue: { $sum: revenue } } }, { $sort: { _id: 1 } }]),
      Sale.aggregate([{ $match: match }, { $group: { _id: dateGroup("%Y-%m"), sales: { $sum: 1 }, revenue: { $sum: revenue } } }, { $sort: { _id: 1 } }]),
      Sale.aggregate([{ $match: REPORTABLE_SALE_MATCH }, { $group: { _id: dateGroup("%Y") } }, { $sort: { _id: -1 } }]),
    ]);

    const totalRevenue = money(salesSummary, "totalRevenue");
    const totalEntries = money(entriesSummary, "totalEntries");
    const expenseReport = expensesSummary[0] || { summary: [], expenses: [] };
    const totalValidatedExpenses = money(expenseReport.summary, "totalValidatedExpenses");
    const totalValidatedExpenseCount = money(expenseReport.summary, "expenseCount");
    const monthRows = compactTrend(monthly, "month", "monthName");
    const selectedYear = String(req.query.year || getTodayKisangani().slice(0, 4));

    res.json({
      success: true,
      timeframe: timeframeMetadata(req.query, dateFilter),
      data: {
        totalSales: money(salesSummary, "totalSales"), totalRevenue,
        totalCustomers: money(customerSummary, "count"), totalProducts: money(productSummary, "count"),
        totalValidatedExpenses, totalValidatedExpenseCount, totalEntries,
        validatedExpenses: expenseReport.expenses || [],
        netRevenue: totalRevenue + totalEntries - totalValidatedExpenses,
        averageSale: money(salesSummary, "averageSale"),
        salesByDay: compactTrend(daily, "date", "dayName"),
        salesByWeek: compactTrend(weekly, "week", "startDate").map((row) => ({ ...row, endDate: row.startDate })),
        salesByMonth: monthRows,
        salesByYear: [{ year: selectedYear, months: monthRows.filter((row) => row.month.startsWith(selectedYear)).map((row) => ({ ...row, month: row.month.slice(5) })) }],
        topProducts, topCustomers,
        recentTrends: {
          salesGrowth: percentChange(money(salesSummary, "totalSales"), money(previousSalesSummary, "totalSales")),
          revenueGrowth: percentChange(totalRevenue, money(previousSalesSummary, "totalRevenue")),
          customerGrowth: percentChange(money(customerSummary, "count"), money(previousCustomerSummary, "count")),
        },
      },
      availableYears: availableYears.map((row) => Number(row._id)),
      filtersApplied: { region: region || "all" },
    });
  } catch (error) {
    console.error("Error building analytics report:", error);
    res.status(error.message.startsWith("Invalid") ? 400 : 500).json({ error: error.message.startsWith("Invalid") ? error.message : "Failed to build analytics report" });
  }
});

// Sales (green), money entries (yellow) and validated expenses (red) on one
// time axis, with the comparison data the client insights engine needs.
// Uses exactly the same matchers as /analytics so totals always agree.
router.get("/cashflow", authMiddleware, requireModulePermission("reports"), async (req, res) => {
  try {
    const region = regionFromQuery(req, res);
    if (region === null) return;
    const plan = resolveSeriesPlan(req.query);
    const fullRange = { createdAt: { $gte: plan.start, $lte: plan.end } };
    const toRange = (window) => ({ createdAt: { $gte: window.start, $lte: window.end } });
    const revenue = scopedRevenueExpression(region);
    const regionField = region ? { regionCode: region } : {};
    const bucket = dateGroup(plan.bucketFormat);
    const includeCosts = canSeeCosts(req.user);
    const itemRegionStage = region ? [{ $match: { $expr: { $eq: [itemRegion("$items"), region] } } }] : [];
    const itemRevenue = { $ifNull: ["$items.netTotal", itemSubtotal("$items")] };
    const hasProfit = { $isNumber: "$items.profit" };

    const totalsFor = async (window) => {
      const range = toRange(window);
      const [sales, entries, expenses] = await Promise.all([
        Sale.aggregate([{ $match: saleMatch(range, region) }, { $group: { _id: null, amount: { $sum: revenue }, count: { $sum: 1 } } }]),
        Entry.aggregate([{ $match: { ...range, status: "active", ...regionField } }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
        Expense.aggregate([{ $match: { ...range, status: "validated", ...regionField } }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      ]);
      return {
        start: window.start.toISOString(),
        end: window.end.toISOString(),
        sales: cashflowMoney(sales[0]?.amount), salesCount: Number(sales[0]?.count || 0),
        entries: cashflowMoney(entries[0]?.amount), entriesCount: Number(entries[0]?.count || 0),
        expenses: cashflowMoney(expenses[0]?.amount), expensesCount: Number(expenses[0]?.count || 0),
      };
    };

    // Gross profit = item profit snapshots (net revenue − cost of goods).
    // Items sold before costs were recorded are counted, never guessed.
    const profitFor = async (window) => {
      const [row] = await Sale.aggregate([
        { $match: saleMatch(toRange(window), region) }, { $unwind: "$items" }, ...itemRegionStage,
        { $group: {
          _id: null,
          grossProfit: { $sum: { $cond: [hasProfit, "$items.profit", 0] } },
          coveredRevenue: { $sum: { $cond: [hasProfit, itemRevenue, 0] } },
          itemCount: { $sum: 1 },
          coveredItemCount: { $sum: { $cond: [hasProfit, 1, 0] } },
        } },
      ]);
      const itemCount = Number(row?.itemCount || 0);
      return {
        grossProfit: cashflowMoney(row?.grossProfit),
        coveredRevenue: cashflowMoney(row?.coveredRevenue),
        itemCount,
        coverage: itemCount ? Number(row.coveredItemCount) / itemCount : 0,
      };
    };

    const [salesRows, entryRows, expenseRows, currentTotals, previousTotals, categoryRows, productRows,
      soldProductIds, lowStockCount, activeProducts, currentProfit, previousProfit] = await Promise.all([
      Sale.aggregate([{ $match: saleMatch(fullRange, region) }, { $group: { _id: bucket, amount: { $sum: revenue }, count: { $sum: 1 } } }]),
      Entry.aggregate([{ $match: { ...fullRange, status: "active", ...regionField } }, { $group: { _id: bucket, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      Expense.aggregate([{ $match: { ...fullRange, status: "validated", ...regionField } }, { $group: { _id: bucket, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      totalsFor(plan.current),
      totalsFor(plan.previous),
      Sale.aggregate([
        { $match: saleMatch(fullRange, region) }, { $unwind: "$items" }, ...itemRegionStage,
        // Sale lines carry no category snapshot, so the product's current
        // category is used; deleted products fall into "uncategorised".
        { $lookup: {
          from: Product.collection.name,
          let: { productId: "$items.productId" },
          pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$productId"] } } }, { $project: { _id: 0, category: 1 } }],
          as: "product",
        } },
        { $set: { productCategory: { $ifNull: [{ $arrayElemAt: ["$product.category", 0] }, null] } } },
        { $group: {
          _id: "$productCategory",
          revenue: { $sum: itemRevenue },
          quantity: { $sum: { $ifNull: ["$items.quantity", 0] } },
          grossProfit: { $sum: { $cond: [hasProfit, "$items.profit", 0] } },
          itemCount: { $sum: 1 },
          coveredItemCount: { $sum: { $cond: [hasProfit, 1, 0] } },
        } },
        { $sort: { revenue: -1, _id: 1 } },
      ]),
      Sale.aggregate([
        { $match: saleMatch(fullRange, region) }, { $unwind: "$items" }, ...itemRegionStage,
        { $group: {
          _id: { productId: "$items.productId", name: "$items.name" },
          quantity: { $sum: { $ifNull: ["$items.quantity", 0] } },
          revenue: { $sum: itemRevenue },
        } },
        { $sort: { quantity: -1, revenue: -1, "_id.name": 1 } }, { $limit: 5 },
      ]),
      Sale.distinct("items.productId", saleMatch(fullRange, region)),
      Product.countDocuments({ status: "active", ...regionField, minStock: { $gt: 0 }, $expr: { $lte: ["$stock", "$minStock"] } }),
      Product.countDocuments({ status: "active", ...regionField }),
      includeCosts ? profitFor(plan.current) : null,
      includeCosts ? profitFor(plan.previous) : null,
    ]);

    const unsoldProducts = await Product.countDocuments({
      status: "active", ...regionField, _id: { $nin: soldProductIds.filter(Boolean) },
    });
    const series = mergeSeries(plan.bucketKeys, { sales: salesRows, entries: entryRows, expenses: expenseRows }, plan.elapsedBucketKeys);

    res.json({
      success: true,
      timeframe: timeframeMetadata(req.query, fullRange),
      granularity: plan.granularity,
      isPartial: plan.isPartial,
      series,
      totals: sumSeries(series),
      comparison: { current: currentTotals, previous: previousTotals },
      profit: includeCosts ? { current: currentProfit, previous: previousProfit } : null,
      categories: categoryRows.map((row) => ({
        category: row._id || null,
        revenue: cashflowMoney(row.revenue),
        quantity: Number(row.quantity || 0),
        ...(includeCosts && {
          grossProfit: cashflowMoney(row.grossProfit),
          profitCoverage: row.itemCount ? row.coveredItemCount / row.itemCount : 0,
        }),
      })),
      topProducts: productRows.map((row) => ({
        productId: row._id.productId || null,
        name: row._id.name || "Article",
        quantity: Number(row.quantity || 0),
        revenue: cashflowMoney(row.revenue),
      })),
      stock: { lowStockCount, activeProducts, unsoldProducts },
      filtersApplied: { region: region || "all" },
    });
  } catch (error) {
    const badRequest = /^Invalid|Start date/.test(error.message);
    if (!badRequest) console.error("Error building cashflow report:", error);
    res.status(badRequest ? 400 : 500).json({ error: badRequest ? error.message : "Failed to build cashflow report" });
  }
});

router.get("/dashboard", authMiddleware, requireModulePermission("dashboard"), async (req, res) => {
  try {
    const region = regionFromQuery(req, res);
    if (region === null) return;
    const now = new Date();
    const today = getTodayKisangani(now);
    const [year, month] = today.split("-").map(Number);
    const currentStart = parseReportingDate(`${year}-${String(month).padStart(2, "0")}-01`);
    const previousYear = month === 1 ? year - 1 : year;
    const previousMonth = month === 1 ? 12 : month - 1;
    const previousStart = parseReportingDate(`${previousYear}-${String(previousMonth).padStart(2, "0")}-01`);
    const baseMatch = { ...REPORTABLE_SALE_MATCH, ...regionReceiptFilter(region) };
    const todayFilter = buildTimeframeFilter({ date: today });
    const revenue = scopedRevenueExpression(region);

    const [sales, recentSales, products, customers, newCustomers] = await Promise.all([
      Sale.aggregate([{ $match: baseMatch }, { $facet: {
        total: [{ $match: todayFilter }, { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: revenue } } }],
        current: [{ $match: { createdAt: { $gte: currentStart, $lte: now } } }, { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: revenue } } }],
        previous: [{ $match: { createdAt: { $gte: previousStart, $lt: currentStart } } }, { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: revenue } } }],
      } }]),
      Sale.aggregate([{ $match: { ...baseMatch, ...todayFilter } }, { $sort: { createdAt: -1, _id: -1 } }, { $limit: 5 }, { $set: { total: revenue, ...(region ? { items: { $filter: { input: "$items", as: "item", cond: { $eq: [itemRegion(), region] } } } } : {}) } }, { $project: { __v: 0 } }]),
      Product.aggregate([{ $match: { ...(region ? { regionCode: region } : {}) } }, { $facet: { count: [{ $count: "value" }], lowStock: [{ $match: { stock: { $lt: 100 } } }, { $sort: { stock: 1, _id: 1 } }, { $limit: 5 }] } }]),
      Customer.aggregate([{ $match: { isWalkIn: { $ne: true } } }, { $count: "value" }]),
      Customer.aggregate([{ $match: { isWalkIn: { $ne: true }, createdAt: { $gte: currentStart, $lte: now } } }, { $count: "value" }]),
    ]);
    const facets = sales[0] || {};
    const lifetime = facets.total?.[0] || { count: 0, revenue: 0 };
    const current = facets.current?.[0] || { count: 0, revenue: 0 };
    const previous = facets.previous?.[0] || { count: 0, revenue: 0 };
    const totalCustomers = money(customers, "value");
    res.json({ success: true, data: {
      totalRevenue: lifetime.revenue, totalSales: lifetime.count,
      totalProducts: products[0]?.count?.[0]?.value || 0, totalCustomers,
      recentSales, lowStockProducts: products[0]?.lowStock || [],
      revenueGrowth: percentChange(current.revenue, previous.revenue),
      salesGrowth: percentChange(current.count, previous.count),
      customerGrowth: totalCustomers ? Math.round((money(newCustomers, "value") / totalCustomers) * 100) : 0,
    } });
  } catch (error) {
    console.error("Error building dashboard report:", error);
    res.status(500).json({ error: "Failed to build dashboard report" });
  }
});

router.get("/stock", authMiddleware, requireModulePermission("reports"), async (req, res) => {
  try {
    const region = regionFromQuery(req, res);
    if (region === null) return;
    const dateFilter = buildTimeframeFilter(req.query);
    const sold = await Sale.aggregate([
      { $match: saleMatch(dateFilter, region) }, { $unwind: "$items" },
      ...(region ? [{ $match: { $expr: { $eq: [itemRegion("$items"), region] } } }] : []),
      { $group: { _id: "$items.productId", name: { $first: "$items.name" }, regionCode: { $first: itemRegion("$items") }, quantitySold: { $sum: "$items.quantity" }, revenue: { $sum: { $ifNull: ["$items.netTotal", itemSubtotal("$items")] } } } },
      { $sort: { quantitySold: -1, _id: 1 } },
    ]);
    res.json({ success: true, timeframe: timeframeMetadata(req.query, dateFilter), data: sold });
  } catch (error) {
    res.status(error.message.startsWith("Invalid") ? 400 : 500).json({ error: error.message.startsWith("Invalid") ? error.message : "Failed to build stock report" });
  }
});

module.exports = router;
