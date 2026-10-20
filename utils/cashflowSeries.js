// Pure helpers for the /reports/cashflow time series. Kept free of Express
// and MongoDB so bucket generation, comparison windows and merging are unit
// tested independently. All calendar maths happen in the fixed UTC+2
// business timezone used by every other report.
const { buildTimeframeFilter, getTodayKisangani } = require("./reportingDate");

const OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAILY_SPAN_DAYS = 62;

// Mongo $dateToString formats for each granularity (evaluated in UTC+2).
const BUCKET_FORMATS = Object.freeze({
  hour: "%Y-%m-%dT%H",
  day: "%Y-%m-%d",
  month: "%Y-%m",
});

const pad = (value) => String(value).padStart(2, "0");

// Wall-clock parts of an instant in the business timezone.
function businessParts(date) {
  const shifted = new Date(date.getTime() + OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

function bucketKey(date, granularity) {
  const parts = businessParts(date);
  if (granularity === "month") return `${parts.year}-${pad(parts.month)}`;
  const day = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  return granularity === "hour" ? `${day}T${pad(parts.hour)}` : day;
}

// Start instant (UTC) of the business-time bucket identified by `key`.
function bucketStart(key, granularity) {
  if (granularity === "month") return new Date(`${key}-01T00:00:00.000+02:00`);
  if (granularity === "hour") return new Date(`${key}:00:00.000+02:00`);
  return new Date(`${key}T00:00:00.000+02:00`);
}

function nextBucketStart(start, granularity) {
  if (granularity === "hour") return new Date(start.getTime() + 60 * 60 * 1000);
  if (granularity === "day") return new Date(start.getTime() + DAY_MS);
  const parts = businessParts(start);
  const year = parts.month === 12 ? parts.year + 1 : parts.year;
  const month = parts.month === 12 ? 1 : parts.month + 1;
  return new Date(`${year}-${pad(month)}-01T00:00:00.000+02:00`);
}

function chooseGranularity(start, end) {
  const spanDays = (end.getTime() - start.getTime() + 1) / DAY_MS;
  if (spanDays <= 1) return "hour";
  if (spanDays <= MAX_DAILY_SPAN_DAYS) return "day";
  return "month";
}

/** Every bucket key in [start, end], including empty ones (real zeros). */
function listBucketKeys(start, end, granularity) {
  const keys = [];
  let cursor = bucketStart(bucketKey(start, granularity), granularity);
  while (cursor <= end && keys.length < 1000) {
    keys.push(bucketKey(cursor, granularity));
    cursor = nextBucketStart(cursor, granularity);
  }
  return keys;
}

/**
 * Resolves the report window, its granularity, and the comparison windows.
 * A period that is still running (e.g. "this month") is compared on its
 * elapsed portion only: [start, now] against the same elapsed length at the
 * start of the previous equivalent period, never a partial against a full one.
 */
function resolveSeriesPlan(query = {}, now = new Date()) {
  const { createdAt } = buildTimeframeFilter(query, now);
  const start = createdAt.$gte;
  const end = createdAt.$lte;
  const granularity = chooseGranularity(start, end);
  const isPartial = now >= start && now < end;
  const comparableEnd = isPartial ? now : end;
  const elapsedMs = comparableEnd.getTime() - start.getTime();
  const periodMs = end.getTime() - start.getTime() + 1;
  const previousStart = new Date(start.getTime() - periodMs);

  return {
    start,
    end,
    granularity,
    bucketFormat: BUCKET_FORMATS[granularity],
    bucketKeys: listBucketKeys(start, end, granularity),
    // Buckets that have started; later ones are future, not "zero sales".
    elapsedBucketKeys: listBucketKeys(start, comparableEnd, granularity),
    isPartial,
    current: { start, end: comparableEnd },
    previous: { start: previousStart, end: new Date(previousStart.getTime() + elapsedMs) },
    today: getTodayKisangani(now),
  };
}

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Joins the three grouped aggregations onto the full ordered bucket list. */
function mergeSeries(bucketKeys, { sales = [], entries = [], expenses = [] } = {}, elapsedKeys = bucketKeys) {
  const byKey = (rows) => new Map(rows.map((row) => [String(row._id), row]));
  const salesByKey = byKey(sales);
  const entriesByKey = byKey(entries);
  const expensesByKey = byKey(expenses);
  const elapsed = new Set(elapsedKeys);
  return bucketKeys.map((key) => {
    const sale = salesByKey.get(key);
    const entry = entriesByKey.get(key);
    const expense = expensesByKey.get(key);
    const salesAmount = money(sale?.amount);
    const entriesAmount = money(entry?.amount);
    const expensesAmount = money(expense?.amount);
    return {
      key,
      sales: salesAmount,
      salesCount: Number(sale?.count || 0),
      entries: entriesAmount,
      entriesCount: Number(entry?.count || 0),
      expenses: expensesAmount,
      expensesCount: Number(expense?.count || 0),
      net: money(salesAmount + entriesAmount - expensesAmount),
      elapsed: elapsed.has(key),
    };
  });
}

function sumSeries(series) {
  return series.reduce((totals, row) => ({
    sales: money(totals.sales + row.sales),
    salesCount: totals.salesCount + row.salesCount,
    entries: money(totals.entries + row.entries),
    entriesCount: totals.entriesCount + row.entriesCount,
    expenses: money(totals.expenses + row.expenses),
    expensesCount: totals.expensesCount + row.expensesCount,
  }), { sales: 0, salesCount: 0, entries: 0, entriesCount: 0, expenses: 0, expensesCount: 0 });
}

module.exports = {
  BUCKET_FORMATS,
  bucketKey,
  bucketStart,
  chooseGranularity,
  listBucketKeys,
  resolveSeriesPlan,
  mergeSeries,
  sumSeries,
  money,
};
