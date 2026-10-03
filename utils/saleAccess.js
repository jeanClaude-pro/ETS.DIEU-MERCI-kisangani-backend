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

const EDITABLE_TYPES = ["sale", "reservation"];

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

  // Sales and reservations can never be turned into expenses (that path
  // rewrote the total without returning stock).
  if (requestedType !== undefined && requestedType !== null && requestedType !== "" &&
      !EDITABLE_TYPES.includes(requestedType)) {
    return { status: 400, error: "Invalid sale type" };
  }

  if (originalSale.type === "reservation") {
    if (originalSale.status === "completed" && role !== "admin") {
      return { status: 403, error: "Only admin can edit completed reservations" };
    }
    if (originalSale.status === "pending" && role !== "admin" && role !== "manager") {
      return { status: 403, error: "Only admin and manager can edit pending reservations" };
    }
    if (originalSale.status !== "completed" && originalSale.status !== "pending" && role !== "admin") {
      return { status: 403, error: "Only admin can edit this reservation" };
    }
    return null;
  }

  // Completed sales: admin only.
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
