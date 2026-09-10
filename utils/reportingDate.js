const KISANGANI_OFFSET = "+02:00";
const KISANGANI_TIMEZONE = "Africa/Lubumbashi";

function getTodayKisangani(now = new Date()) {
  return new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseReportingDate(value, endOfDay = false) {
  const input = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error(`Invalid date format: ${value}. Use YYYY-MM-DD format.`);
  }
  const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
  const parsed = new Date(`${input}T${time}${KISANGANI_OFFSET}`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  const reconstructed = new Date(parsed.getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (reconstructed !== input) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function validYear(value) {
  const year = Number.parseInt(value, 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Invalid year: ${value}. Must be between 2000-2100.`);
  }
  return year;
}

function buildTimeframeFilter(query = {}, now = new Date()) {
  const { from, to, date, year, month } = query;
  let start;
  let end;

  if (from || to) {
    start = from ? parseReportingDate(from) : new Date(0);
    end = to ? parseReportingDate(to, true) : now;
    if (start > end) throw new Error("Start date (from) must be before or equal to end date (to)");
  } else if (date) {
    start = parseReportingDate(date);
    end = parseReportingDate(date, true);
  } else if (year && month) {
    const y = validYear(year);
    const m = Number.parseInt(month, 10);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new Error(`Invalid month: ${month}. Must be between 01-12.`);
    }
    const nextYear = m === 12 ? y + 1 : y;
    const nextMonth = m === 12 ? 1 : m + 1;
    start = new Date(`${y}-${String(m).padStart(2, "0")}-01T00:00:00.000${KISANGANI_OFFSET}`);
    end = new Date(new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00.000${KISANGANI_OFFSET}`).getTime() - 1);
  } else if (year) {
    const y = validYear(year);
    start = new Date(`${y}-01-01T00:00:00.000${KISANGANI_OFFSET}`);
    end = new Date(`${y}-12-31T23:59:59.999${KISANGANI_OFFSET}`);
  } else {
    const today = getTodayKisangani(now);
    start = parseReportingDate(today);
    end = parseReportingDate(today, true);
  }

  return { createdAt: { $gte: start, $lte: end } };
}

function getTimeframeDescription(query = {}) {
  const { from, to, date, year, month } = query;
  if (from || to) return `Custom range: ${from || "Beginning"} to ${to || "Now"}`;
  if (date) return `Day: ${date}`;
  if (year && month) return `Month: ${year}-${String(month).padStart(2, "0")}`;
  if (year) return `Year: ${year}`;
  return "Today (default)";
}

function parsePagination(query = {}, defaults = {}) {
  const defaultLimit = defaults.defaultLimit || 50;
  const maxLimit = defaults.maxLimit || 200;
  const rawPage = Number.parseInt(query.page, 10);
  const rawLimit = Number.parseInt(query.limit, 10);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const requested = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : defaultLimit;
  const limit = Math.min(requested, maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

function timeframeMetadata(query, filter) {
  return {
    description: getTimeframeDescription(query),
    start: filter.createdAt.$gte.toISOString(),
    end: filter.createdAt.$lte.toISOString(),
    query: {
      from: query.from || null,
      to: query.to || null,
      date: query.date || null,
      year: query.year || null,
      month: query.month || null,
    },
  };
}

module.exports = {
  KISANGANI_OFFSET,
  KISANGANI_TIMEZONE,
  getTodayKisangani,
  parseReportingDate,
  buildTimeframeFilter,
  getTimeframeDescription,
  parsePagination,
  timeframeMetadata,
};
