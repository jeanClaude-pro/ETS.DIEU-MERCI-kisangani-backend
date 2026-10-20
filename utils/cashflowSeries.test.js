const test = require("node:test");
const assert = require("node:assert/strict");
const {
  bucketKey, chooseGranularity, listBucketKeys, resolveSeriesPlan, mergeSeries, sumSeries,
} = require("./cashflowSeries");

test("bucket keys use UTC+2 business time, not the host timezone", () => {
  // 22:30 UTC on Jan 31 is already 00:30 on Feb 1 in Kisangani.
  const instant = new Date("2026-01-31T22:30:00.000Z");
  assert.equal(bucketKey(instant, "hour"), "2026-02-01T00");
  assert.equal(bucketKey(instant, "day"), "2026-02-01");
  assert.equal(bucketKey(instant, "month"), "2026-02");
});

test("granularity follows the span: one day → hours, a month → days, a year → months", () => {
  const day = resolveSeriesPlan({ date: "2026-10-01" }, new Date("2026-10-20T08:00:00Z"));
  assert.equal(day.granularity, "hour");
  assert.equal(day.bucketKeys.length, 24);
  assert.equal(day.bucketKeys[0], "2026-10-01T00");
  assert.equal(day.bucketKeys[23], "2026-10-01T23");

  const month = resolveSeriesPlan({ from: "2026-02-01", to: "2026-02-28" }, new Date("2026-10-20T08:00:00Z"));
  assert.equal(month.granularity, "day");
  assert.equal(month.bucketKeys.length, 28);

  const year = resolveSeriesPlan({ year: "2025" }, new Date("2026-10-20T08:00:00Z"));
  assert.equal(year.granularity, "month");
  assert.deepEqual(year.bucketKeys, ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06",
    "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12"]);
  assert.equal(chooseGranularity(new Date(0), new Date(100 * 86_400_000)), "month");
});

test("a completed period is compared with the full previous equivalent period", () => {
  const plan = resolveSeriesPlan({ date: "2026-10-10" }, new Date("2026-10-20T08:00:00Z"));
  assert.equal(plan.isPartial, false);
  assert.equal(plan.previous.start.toISOString(), "2026-10-08T22:00:00.000Z");
  assert.equal(plan.previous.end.toISOString(), "2026-10-09T21:59:59.999Z");
  assert.equal(plan.elapsedBucketKeys.length, 24);
});

test("a running period compares only the elapsed portion of both periods", () => {
  // 10:00 local on Oct 20 inside "this month".
  const now = new Date("2026-10-20T08:00:00.000Z");
  const plan = resolveSeriesPlan({ from: "2026-10-01", to: "2026-10-31" }, now);
  assert.equal(plan.isPartial, true);
  assert.equal(plan.current.end.toISOString(), now.toISOString());
  const currentElapsed = plan.current.end - plan.current.start;
  const previousElapsed = plan.previous.end - plan.previous.start;
  assert.equal(previousElapsed, currentElapsed);
  // 31 day buckets are drawn, but only Oct 1–20 have started.
  assert.equal(plan.bucketKeys.length, 31);
  assert.equal(plan.elapsedBucketKeys.length, 20);
  assert.equal(plan.elapsedBucketKeys.at(-1), "2026-10-20");
});

test("today's chart stops counting hours that have not happened yet", () => {
  const plan = resolveSeriesPlan({ date: "2026-10-20" }, new Date("2026-10-20T08:15:00.000Z"));
  assert.equal(plan.isPartial, true);
  assert.equal(plan.elapsedBucketKeys.at(-1), "2026-10-20T10");
  // Yesterday is compared up to the same minute.
  assert.equal(plan.previous.end.toISOString(), "2026-10-19T08:15:00.000Z");
});

test("merge keeps every bucket, fills real zeros, and computes net", () => {
  const keys = listBucketKeys(new Date("2026-10-01T00:00:00+02:00"), new Date("2026-10-03T23:59:59.999+02:00"), "day");
  const series = mergeSeries(keys, {
    sales: [{ _id: "2026-10-01", amount: 120.5, count: 3 }, { _id: "2026-10-03", amount: 80, count: 1 }],
    entries: [{ _id: "2026-10-02", amount: 50, count: 1 }],
    expenses: [{ _id: "2026-10-01", amount: 20.25, count: 2 }],
  }, keys.slice(0, 2));
  assert.deepEqual(series.map((row) => row.key), ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.equal(series[0].net, 100.25);
  assert.equal(series[1].sales, 0);
  assert.equal(series[1].net, 50);
  assert.equal(series[2].elapsed, false);
  const totals = sumSeries(series);
  assert.deepEqual(totals, { sales: 200.5, salesCount: 4, entries: 50, entriesCount: 1, expenses: 20.25, expensesCount: 2 });
});

test("invalid dates are rejected before any query runs", () => {
  assert.throws(() => resolveSeriesPlan({ date: "2026-02-30" }), /Invalid date/);
  assert.throws(() => resolveSeriesPlan({ from: "2026-03-02", to: "2026-03-01" }), /Start date/);
});
