// Region scoping: an account may be limited to Butembo (Bbbb), China (Cnnn)
// or see both ("all"). Admins always see both. The "shareholder" role is
// always limited to exactly one region and is read-only.
//
// Enforcement happens in three layers:
//  1. authMiddleware stores the caller's scope in an AsyncLocalStorage for
//     the rest of the request.
//  2. regionScopePlugin (Entry, Expense, Product) adds `regionCode = scope`
//     to every query and aggregation run during that request, so no route
//     can accidentally return another region's records.
//  3. Sales (whose items can mix regions) are scoped explicitly by the sales
//     and reports routes through resolveRegion / saleVisibleInScope.
const { AsyncLocalStorage } = require("node:async_hooks");
const { VALID_REGION_CODES } = require("./regions");
const { calculateRegionTotal } = require("./saleIntegrity");

const REGION_SCOPES = ["all", ...VALID_REGION_CODES];
const REGION_NAMES = { Bbbb: "Butembo", Cnnn: "China" };
const SINGLE_REGION_ROLES = new Set(["shareholder"]);
const READ_ONLY_ROLES = new Set(["shareholder"]);

const storage = new AsyncLocalStorage();

class RegionScopeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** null = both regions; otherwise the single region code the user may see. */
function userRegionScope(user) {
  if (!user || user.role === "admin") return null;
  return VALID_REGION_CODES.includes(user.regionScope) ? user.regionScope : null;
}

function isReadOnlyRole(user) {
  return READ_ONLY_ROLES.has(user?.role);
}

/** Validation for account creation / update. Returns an error message or null. */
function regionScopeError(role, regionScope) {
  const scope = regionScope ?? "all";
  if (!REGION_SCOPES.includes(scope)) return "Invalid region scope";
  if (role === "admin" && scope !== "all") return "Administrators always see both regions";
  if (SINGLE_REGION_ROLES.has(role) && scope === "all") return "A shareholder must be assigned to exactly one region";
  return null;
}

function runWithRegionScope(scope, callback) {
  return storage.run({ scope: scope || null }, callback);
}

function currentRegionScope() {
  return storage.getStore()?.scope || null;
}

/** For internal maintenance inside a scoped request (e.g. customer totals). */
function withoutRegionScope(callback) {
  return storage.run({ scope: null }, callback);
}

/**
 * The region a request may report on. A scoped user always gets their own
 * region (asking for the other one is refused); everyone else gets the
 * region they asked for, or "" for both.
 */
function resolveRegion(user, requested) {
  const value = requested === undefined || requested === null ? "" : String(requested);
  if (value && !VALID_REGION_CODES.includes(value)) throw new RegionScopeError(400, "Invalid region code");
  const scope = userRegionScope(user);
  if (!scope) return value;
  if (value && value !== scope) throw new RegionScopeError(403, "Accès limité à votre région");
  return scope;
}

const itemCode = (item) => item?.regionCode
  || Object.keys(REGION_NAMES).find((code) => REGION_NAMES[code] === item?.region)
  || "Unknown";

/** "any": the sale touches the region; "all": every line belongs to it. */
function saleInRegion(sale, region, mode = "any") {
  if (!region) return true;
  const items = Array.isArray(sale?.items) ? sale.items : [];
  if (items.length === 0) return false;
  return mode === "all" ? items.every((item) => itemCode(item) === region) : items.some((item) => itemCode(item) === region);
}

/** Mongo filter matching sales with at least one line in the region. */
function saleRegionFilter(region) {
  if (!region) return {};
  return { $or: [{ "items.regionCode": region }, { "items.region": REGION_NAMES[region] }] };
}

/**
 * What a region-scoped viewer may see of a sale: only their region's lines,
 * and the region's share of the total (the same share every report uses).
 */
function projectSaleForScope(sale, scope) {
  if (!scope || !sale) return sale;
  const plain = typeof sale.toObject === "function" ? sale.toObject() : sale;
  const items = (plain.items || []).filter((item) => itemCode(item) === scope);
  if (items.length === (plain.items || []).length) return plain;
  return { ...plain, items, total: calculateRegionTotal(plain, scope), regionScoped: true };
}

/** Mongoose plugin for collections that carry a regionCode field. */
function regionScopePlugin(schema) {
  const scopeQuery = function scopeQuery() {
    const scope = currentRegionScope();
    if (scope) this.where({ regionCode: scope });
  };
  schema.pre(/^find/, scopeQuery);
  schema.pre(["countDocuments", "distinct", "updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne"], scopeQuery);
  schema.pre("aggregate", function scopeAggregate() {
    const scope = currentRegionScope();
    if (scope) this.pipeline().unshift({ $match: { regionCode: scope } });
  });
  schema.pre("save", function scopeSave(next) {
    const scope = currentRegionScope();
    if (scope && this.regionCode && this.regionCode !== scope) {
      return next(new RegionScopeError(403, "Accès limité à votre région"));
    }
    return next();
  });
}

module.exports = {
  REGION_SCOPES,
  REGION_NAMES,
  RegionScopeError,
  userRegionScope,
  isReadOnlyRole,
  regionScopeError,
  runWithRegionScope,
  currentRegionScope,
  withoutRegionScope,
  resolveRegion,
  saleInRegion,
  saleRegionFilter,
  projectSaleForScope,
  regionScopePlugin,
};
