// Role rules for reading and mutating sales, kept pure so they're unit-tested
// independently of Express and MongoDB.

const COST_ROLES = new Set(["admin", "manager"]);
const SALE_LEVEL_COST_FIELDS = ["cost", "profit"];
const ITEM_LEVEL_COST_FIELDS = ["unitCost", "cost", "profit"];

function canSeeCosts(user) {
  return COST_ROLES.has(user?.role);
}

function withoutFields(object, fields) {
  const copy = { ...object };
  for (const field of fields) delete copy[field];
  return copy;
}

// Removes cost price / margin data from a sale (lean object or document)
// for roles that must not see it. Other fields are untouched so existing
// screens keep working.
function stripCostFields(sale, user) {
  if (!sale || canSeeCosts(user)) return sale;
  const plain = typeof sale.toObject === "function" ? sale.toObject() : sale;
  const stripped = withoutFields(plain, SALE_LEVEL_COST_FIELDS);
  if (Array.isArray(plain.items)) {
    stripped.items = plain.items.map((item) => withoutFields(item, ITEM_LEVEL_COST_FIELDS));
  }
  return stripped;
}

function stripCostFieldsFromList(sales, user) {
  if (!Array.isArray(sales) || canSeeCosts(user)) return sales;
  return sales.map((sale) => stripCostFields(sale, user));
}

// Only sales can be edited (a historical reservation record stays a
// reservation; the reservation module itself has been retired).
const EDITABLE_TYPES = ["sale"];

// Decides whether `user` may edit `originalSale` with the requested `type`.
// Returns null when allowed, or { status, error }.
function saleEditDenial(user, originalSale, requestedType) {
  const role = user?.role;

  if (originalSale.status === "voided" || originalSale.status === "corrected") {
    return { status: 400, error: "Cannot edit a voided or corrected sale" };
  }

  if (originalSale.type === "expense") {
    if (role !== "admin") return { status: 403, error: "Only admin can edit expense records" };
    if (requestedType !== undefined && requestedType !== "expense") {
      return { status: 400, error: "An expense record cannot be converted into a sale" };
    }
    return null;
  }

  if (requestedType !== undefined && requestedType !== null && requestedType !== "" &&
      requestedType !== originalSale.type && !EDITABLE_TYPES.includes(requestedType)) {
    return { status: 400, error: "Invalid sale type" };
  }

  if (role !== "admin") {
    return { status: 403, error: "Only admin can edit completed sales" };
  }
  return null;
}

module.exports = {
  canSeeCosts,
  stripCostFields,
  stripCostFieldsFromList,
  saleEditDenial,
};
