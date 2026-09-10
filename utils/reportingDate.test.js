const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTimeframeFilter, parseReportingDate, parsePagination } = require("./reportingDate");

test("reporting days always use UTC+2 boundaries", () => {
  const filter = buildTimeframeFilter({ date: "2026-09-09" });
  assert.equal(filter.createdAt.$gte.toISOString(), "2026-09-08T22:00:00.000Z");
  assert.equal(filter.createdAt.$lte.toISOString(), "2026-09-09T21:59:59.999Z");
});

test("month boundaries remain UTC+2 across server timezones", () => {
  const filter = buildTimeframeFilter({ year: "2026", month: "02" });
  assert.equal(filter.createdAt.$gte.toISOString(), "2026-01-31T22:00:00.000Z");
  assert.equal(filter.createdAt.$lte.toISOString(), "2026-02-28T21:59:59.999Z");
});

test("pagination is deterministic and capped", () => {
  assert.deepEqual(parsePagination({ page: "3", limit: "999" }), { page: 3, limit: 200, skip: 400 });
});

test("invalid calendar dates are rejected instead of rolling into another month", () => {
  assert.throws(() => parseReportingDate("2026-02-31"), /Invalid date/);
});

test("custom ranges share the same inclusive UTC+2 day boundaries", () => {
  const filter = buildTimeframeFilter({ from: "2026-03-02", to: "2026-03-08" });
  assert.equal(filter.createdAt.$gte.toISOString(), "2026-03-01T22:00:00.000Z");
  assert.equal(filter.createdAt.$lte.toISOString(), "2026-03-08T21:59:59.999Z");
});
