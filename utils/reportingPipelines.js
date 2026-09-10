const { KISANGANI_TIMEZONE } = require("./reportingDate");

const REPORTABLE_SALE_MATCH = {
  type: { $in: ["sale", "reservation"] },
  status: { $in: ["completed", "pending", null] },
};

function itemSubtotal(item = "$$item") {
  return {
    $ifNull: [
      `${item}.subtotal`,
      { $ifNull: [`${item}.total`, { $multiply: [{ $ifNull: [`${item}.price`, 0] }, { $ifNull: [`${item}.quantity`, 0] }] }] },
    ],
  };
}

function itemRegion(item = "$$item") {
  return {
    $ifNull: [
      `${item}.regionCode`,
      { $switch: { branches: [
        { case: { $eq: [`${item}.region`, "Butembo"] }, then: "Bbbb" },
        { case: { $eq: [`${item}.region`, "China"] }, then: "Cnnn" },
      ], default: "Unknown" } },
    ],
  };
}

function regionWeightExpression(code) {
  return { $sum: { $map: {
    input: { $ifNull: ["$items", []] }, as: "item",
    in: { $cond: [{ $eq: [itemRegion(), code] }, itemSubtotal(), 0] },
  } } };
}

// Mirrors calculateRegionTotal(): totals are converted to cents, truncated by
// regional weight, then remainder cents go to the largest fractional shares.
// Ties keep the stable Bbbb, Cnnn, Unknown order used by the JS implementation.
// $let variable names must start with a lowercase letter, so region codes
// (e.g. "Bbbb") can't be used directly as var names — hence the "w" prefix.
function regionRevenueExpression(regionCode) {
  const order = ["Bbbb", "Cnnn", "Unknown"];
  const varName = (code) => `w${code}`;
  const weightVars = Object.fromEntries(order.map((code) => [varName(code), regionWeightExpression(code)]));
  const exact = (code) => ({ $divide: [{ $multiply: ["$$totalCents", `$$${varName(code)}`] }, "$$weight"] });
  const base = (code) => ({ $trunc: exact(code) });
  const fraction = (code) => ({ $subtract: [exact(code), base(code)] });
  const rank = (code) => ({ $add: order.filter((candidate) => candidate !== code).map((candidate) => ({
    $cond: [{
      [order.indexOf(candidate) < order.indexOf(code) ? "$gte" : "$gt"]: [fraction(candidate), fraction(code)],
    }, 1, 0],
  })) });

  return { $let: { vars: {
    ...weightVars,
    totalCents: { $round: [{ $multiply: [{ $ifNull: ["$total", 0] }, 100] }, 0] },
  }, in: { $let: { vars: { weight: { $add: order.map((code) => `$$${varName(code)}`) } }, in: {
    $cond: [
      { $or: [{ $lte: ["$$weight", 0] }, { $lte: [`$$${varName(regionCode)}`, 0] }] },
      0,
      { $let: { vars: {
        remaining: { $subtract: ["$$totalCents", { $add: order.map(base) }] },
        selectedBase: base(regionCode),
        selectedRank: rank(regionCode),
      }, in: { $divide: [{ $add: ["$$selectedBase", { $cond: [{ $lt: ["$$selectedRank", "$$remaining"] }, 1, 0] }] }, 100] } } },
    ],
  } } } } };
}

function scopedRevenueExpression(regionCode) {
  return regionCode ? regionRevenueExpression(regionCode) : { $ifNull: ["$total", 0] };
}

function buildPagedFacet({ skip, limit, summaryGroup, project = { __v: 0 } }) {
  return { $facet: {
    data: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit }, { $project: project }],
    metadata: [{ $count: "totalRecords" }],
    summary: [{ $group: summaryGroup }],
  } };
}

function percentChange(current, previous) {
  if (previous > 0) return Math.round(((current - previous) / previous) * 100);
  return current > 0 ? 100 : 0;
}

function dateGroup(format) {
  return { $dateToString: { format, date: "$createdAt", timezone: KISANGANI_TIMEZONE } };
}

module.exports = {
  REPORTABLE_SALE_MATCH,
  itemSubtotal,
  itemRegion,
  regionRevenueExpression,
  scopedRevenueExpression,
  buildPagedFacet,
  percentChange,
  dateGroup,
};
