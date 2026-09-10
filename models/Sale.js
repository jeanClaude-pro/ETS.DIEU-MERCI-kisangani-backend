const mongoose = require("mongoose");
const { isValidRegionPair } = require("../utils/regions");
const { calculateLineTotal } = require("../utils/saleIntegrity");

const saleItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: false // Made optional for expenses
  },
  name: {
    type: String,
    required: false // Made optional for expenses
  },
  quantity: {
    type: Number,
    required: false, // Made optional for expenses
    min: 1
  },
  price: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0
  },
  total: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0
  },
  unit: {
    type: String,
    required: false,
    trim: true
  },
  subtotal: { type: Number, required: false, min: 0 },
  unitCost: { type: Number, required: false, min: 0 },
  cost: { type: Number, required: false, min: 0 },
  profit: { type: Number, required: false },
  discount: { type: Number, required: false, min: 0, default: 0 },
  tax: { type: Number, required: false, min: 0, default: 0 },
  transportCost: { type: Number, required: false, min: 0, default: 0 },
  otherCharges: { type: Number, required: false, min: 0, default: 0 },
  netTotal: { type: Number, required: false, min: 0 },
  region: {
    type: String,
    enum: ["Butembo", "China"],
    required: false
  },
  regionCode: {
    type: String,
    enum: ["Bbbb", "Cnnn"],
    required: false
  },
});

const saleSchema = new mongoose.Schema({
  saleId: {
    type: String,
    required: true,
    unique: true  // ← THIS creates an index automatically
  },
  customer: {
    name: {
      type: String,
      required: false, // Made optional for expenses
      trim: true
    },
    phone: {
      type: String,
      required: false, // Made optional for expenses
      trim: true
      // REMOVED: index: true  ← Fixed: removed duplicate index
    },
    email: {
      type: String,
      trim: true,
      default: ""
    },
    // Denormalized so consumers (receipts, reports, analytics) can tell this
    // was the system Walk-in Customer without joining to the Customer collection.
    isWalkIn: {
      type: Boolean,
      default: false
    }
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: false
  },
  items: [saleItemSchema],
  subtotal: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0
  },
  discount: { type: Number, min: 0, default: 0 },
  tax: { type: Number, min: 0, default: 0 },
  transportCost: { type: Number, min: 0, default: 0 },
  otherCharges: { type: Number, min: 0, default: 0 },
  cost: { type: Number, min: 0, default: 0 },
  profit: { type: Number, default: 0 },
  total: {
    type: Number,
    required: true,
    min: 0
  },
  paymentMethod: {
    type: String,
    enum: ["cash", "card", "transfer", "other"],
    default: "cash"
  },
  saleNumber: {
    type: String,
    unique: true  // ← THIS also creates an index automatically
  },
  salesPerson: {
    type: String,
    required: true,
    trim: true,
    default: "Admin"
  },
  // --- UPDATED STATUS ENUM ---
  status: {
    type: String,
    enum: ["completed", "refunded", "pending", "voided", "corrected", "expense"], // 🔹 Added "expense"
    default: "completed"
  },
  // --- UPDATED TYPE ENUM ---
  type: {
    type: String,
    enum: ["sale", "reservation", "expense"], // 🔹 Added "expense"
    default: "sale"
  },
  // --- NEW EXPENSE FIELDS ---
  reason: {
    type: String,
    required: false, // Will be required for expenses
    trim: true
  },
  recipientName: {
    type: String,
    required: false, // Will be required for expenses
    trim: true
  },
  recipientPhone: {
    type: String,
    required: false, // Will be required for expenses
    trim: true
  },
  // --- EXISTING RESERVATION FIELDS ---
  reservationDate: {
    type: String,
    default: null
  },
  reservationTime: {
    type: String,
    default: null
  },
  notes: {
    type: String,
    default: ""
  },
  completedAt: {
    type: Date,
    default: null
  },
  completedBy: {
    type: String,
    default: null
  },
  // --- EXISTING FIELDS ---
  voidedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  voidedAt: {
    type: Date,
    default: null
  },
  // --- NEW FIELDS FOR SALE CORRECTION ---
  originalSaleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Sale",
    default: null
  },
  correctionSaleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Sale",
    default: null
  },
  editedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  editedAt: {
    type: Date,
    default: null
  },
  editHistory: [{
    editedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    editedAt: {
      type: Date,
      default: Date.now
    },
    changes: {
      type: Map,
      of: mongoose.Schema.Types.Mixed
    },
    reason: String
  }],
  // Snapshot of the exchange rate at the time the sale was recorded
  exchangeRateSnapshot: {
    rateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExchangeRate",
      required: false
    },
    rate: {
      type: Number,
      required: false
    },
    effectiveFrom: {
      type: Date,
      required: false
    }
  },
}, {
  timestamps: true
});

// Create index for better query performance
saleSchema.index({ createdAt: -1 });
saleSchema.index({ "customer.phone": 1 }); // Keep this explicit index
// REMOVED: saleSchema.index({ saleId: 1 }); ← DUPLICATE of unique: true on line 27
saleSchema.index({ salesPerson: 1 });
saleSchema.index({ type: 1 }); // Add index for type (sale/reservation/expense)
saleSchema.index({ status: 1 });
// Reporting: equality matches on type/status followed by deterministic date sorting.
saleSchema.index({ type: 1, status: 1, createdAt: -1, _id: -1 });
// Customer-stat recalculation: one customer's valid purchases in date order.
saleSchema.index({ customerId: 1, status: 1, createdAt: 1 });

// Pre-save middleware to calculate item totals (only for sales with items)
saleSchema.pre("save", function(next) {
  // Sales and reservations use the same authoritative line arithmetic.
  if (["sale", "reservation"].includes(this.type) && this.items && this.items.length > 0) {
    this.items.forEach(item => {
      item.total = calculateLineTotal(item);
    });
    this.subtotal = Math.round(this.items.reduce((sum, item) => sum + item.total, 0) * 100) / 100;
    this.cost = Math.round(this.items.reduce((sum, item) => sum + Number(item.cost || 0), 0) * 100) / 100;
    this.total = Math.round((this.subtotal - Number(this.discount || 0) + Number(this.tax || 0) +
      Number(this.transportCost || 0) + Number(this.otherCharges || 0)) * 100) / 100;
    this.profit = Math.round((this.total - this.cost) * 100) / 100;
  }
  
  next();
});

saleSchema.pre("validate", function(next) {
  const invalidItem = (this.items || []).find((item) =>
    !item.region || !item.regionCode || !isValidRegionPair(item.region, item.regionCode)
  );
  if (["sale", "reservation"].includes(this.type) && invalidItem) {
    return next(new Error("Every sale item must have a matching region and region code"));
  }
  next();
});

module.exports = mongoose.model("Sale", saleSchema);
