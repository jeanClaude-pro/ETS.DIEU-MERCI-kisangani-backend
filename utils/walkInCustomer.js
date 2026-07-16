const Customer = require("../models/Customer");

// The single permanent system customer used whenever a sale has no
// registered customer attached. phone is fixed because Customer.phone is
// required+unique, so this doubles as the record's stable lookup key.
const WALKIN_CUSTOMER_NAME = "Walk-in Customer";
const WALKIN_CUSTOMER_PHONE = "WALK-IN";

// Idempotent get-or-create: safe to call on every server startup and as a
// defensive fallback from routes, never creates a duplicate.
async function ensureWalkInCustomer() {
  let customer = await Customer.findOne({ phone: WALKIN_CUSTOMER_PHONE });
  if (!customer) {
    customer = await Customer.create({
      name: WALKIN_CUSTOMER_NAME,
      phone: WALKIN_CUSTOMER_PHONE,
      email: "",
      isWalkIn: true,
    });
    console.log("Created default Walk-in Customer record");
  } else if (!customer.isWalkIn) {
    customer.isWalkIn = true;
    await customer.save();
  }
  return customer;
}

function resolveSaleCustomer(customer) {
  const supplied = customer || {};
  const isWalkIn = supplied.isWalkIn === true ||
    !String(supplied.phone || "").trim() ||
    supplied.phone === WALKIN_CUSTOMER_PHONE;
  if (isWalkIn) {
    return {
      name: String(supplied.name || "").trim() || WALKIN_CUSTOMER_NAME,
      phone: WALKIN_CUSTOMER_PHONE,
      email: "",
      isWalkIn: true,
    };
  }
  return {
    name: String(supplied.name || "").trim(),
    phone: String(supplied.phone || "").trim(),
    email: String(supplied.email || "").trim(),
    isWalkIn: false,
  };
}

module.exports = {
  WALKIN_CUSTOMER_NAME,
  WALKIN_CUSTOMER_PHONE,
  ensureWalkInCustomer,
  resolveSaleCustomer,
};
