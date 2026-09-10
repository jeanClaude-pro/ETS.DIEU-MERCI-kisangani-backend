const test = require("node:test");
const assert = require("node:assert/strict");
const { regionRevenueExpression, buildPagedFacet, percentChange } = require("./reportingPipelines");
const { calculateRegionTotal } = require("./saleIntegrity");

function pathValue(path, document, variables) {
  const variable = path.startsWith("$$");
  const parts = path.slice(variable ? 2 : 1).split(".");
  let value = variable ? variables[parts.shift()] : document;
  for (const part of parts) value = value?.[part];
  return value;
}

function evaluate(expression, document, variables = {}) {
  if (typeof expression === "string" && expression.startsWith("$")) return pathValue(expression, document, variables);
  if (expression === null || typeof expression !== "object") return expression;
  if (Array.isArray(expression)) return expression.map((value) => evaluate(value, document, variables));
  const entries = Object.entries(expression);
  if (entries.length !== 1 || !entries[0][0].startsWith("$")) {
    return Object.fromEntries(entries.map(([key, value]) => [key, evaluate(value, document, variables)]));
  }
  const [operator, value] = entries[0];
  const args = () => evaluate(value, document, variables);
  if (operator === "$ifNull") { const [first, fallback] = args(); return first == null ? fallback : first; }
  if (operator === "$eq") { const [a, b] = args(); return a === b; }
  if (operator === "$gt") { const [a, b] = args(); return a > b; }
  if (operator === "$gte") { const [a, b] = args(); return a >= b; }
  if (operator === "$lt") { const [a, b] = args(); return a < b; }
  if (operator === "$lte") { const [a, b] = args(); return a <= b; }
  if (operator === "$or") return args().some(Boolean);
  if (operator === "$add") return args().reduce((sum, item) => sum + item, 0);
  if (operator === "$subtract") { const [a, b] = args(); return a - b; }
  if (operator === "$multiply") return args().reduce((product, item) => product * item, 1);
  if (operator === "$divide") { const [a, b] = args(); return a / b; }
  if (operator === "$trunc") return Math.trunc(args());
  if (operator === "$round") { const [number, places] = args(); const scale = 10 ** places; return Math.round(number * scale) / scale; }
  if (operator === "$cond") { const [condition, yes, no] = value; return evaluate(condition, document, variables) ? evaluate(yes, document, variables) : evaluate(no, document, variables); }
  if (operator === "$sum") { const values = args(); return Array.isArray(values) ? values.reduce((sum, item) => sum + item, 0) : values; }
  if (operator === "$map") {
    const input = evaluate(value.input, document, variables);
    return input.map((item) => evaluate(value.in, document, { ...variables, [value.as]: item }));
  }
  if (operator === "$switch") {
    const branch = value.branches.find((candidate) => evaluate(candidate.case, document, variables));
    return evaluate(branch ? branch.then : value.default, document, variables);
  }
  if (operator === "$let") {
    const scoped = { ...variables };
    for (const [name, variableExpression] of Object.entries(value.vars)) {
      scoped[name] = evaluate(variableExpression, document, variables);
    }
    return evaluate(value.in, document, scoped);
  }
  throw new Error(`Unsupported test operator ${operator}`);
}

// MongoDB requires $let variable names to start with a lowercase ASCII letter
// or "_" (region codes like "Bbbb"/"Cnnn" fail this and are rejected at query
// time with "starts with an invalid character for a user variable name" —
// a bug the pure-JS evaluate() above can't catch since it doesn't enforce
// Mongo's variable-naming rules). Walk every $let in the pipeline and check.
function assertValidLetVariableNames(expression) {
  if (expression === null || typeof expression !== "object") return;
  if (Array.isArray(expression)) {
    for (const item of expression) assertValidLetVariableNames(item);
    return;
  }
  if (expression.$let) {
    for (const name of Object.keys(expression.$let.vars || {})) {
      assert.match(name, /^[a-z_][A-Za-z0-9_]*$/, `"${name}" is not a valid $let variable name`);
    }
  }
  for (const value of Object.values(expression)) assertValidLetVariableNames(value);
}

test("regional revenue expression uses Mongo-legal $let variable names for every region code", () => {
  for (const region of ["Bbbb", "Cnnn", "Unknown"]) {
    assertValidLetVariableNames(regionRevenueExpression(region));
  }
});

test("regional revenue expression allocates receipt totals instead of duplicating charges", () => {
  const expression = JSON.stringify(regionRevenueExpression("Bbbb"));
  assert.match(expression, /totalCents/);
  assert.match(expression, /remaining/);
  assert.match(expression, /regionCode/);
  assert.doesNotMatch(expression, /\$lookup/);
});

test("regional aggregation expression exactly matches receipt allocation including remainder cents", () => {
  const cases = [
    { total: 95, items: [{ regionCode: "Bbbb", subtotal: 40 }, { regionCode: "Cnnn", subtotal: 60 }] },
    { total: 0.05, items: [{ regionCode: "Bbbb", subtotal: 1 }, { regionCode: "Cnnn", subtotal: 1 }, { subtotal: 1 }] },
    { total: 10.01, items: [{ regionCode: "Bbbb", price: 2, quantity: 1 }, { regionCode: "Cnnn", price: 4, quantity: 2 }] },
  ];
  for (const sale of cases) {
    for (const region of ["Bbbb", "Cnnn"]) {
      assert.equal(evaluate(regionRevenueExpression(region), sale), calculateRegionTotal(sale, region));
    }
  }
});

test("paged facets sort deterministically before skip and limit", () => {
  const facet = buildPagedFacet({ skip: 20, limit: 10, summaryGroup: { _id: null, count: { $sum: 1 } } });
  assert.deepEqual(facet.$facet.data.slice(0, 3), [
    { $sort: { createdAt: -1, _id: -1 } }, { $skip: 20 }, { $limit: 10 },
  ]);
});

test("growth percentages retain zero-baseline behavior", () => {
  assert.equal(percentChange(10, 0), 100);
  assert.equal(percentChange(15, 10), 50);
  assert.equal(percentChange(0, 0), 0);
});
