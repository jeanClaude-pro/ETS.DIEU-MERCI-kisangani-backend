const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema({
  expenseId: {
    type: String,
    required: true,
    unique: true
  },
  reason: {
    type: String,
    required: true,
    trim: true
  },
  recipientName: {
    type: String,
    required: true,
    trim: true
  },
  recipientPhone: {
    type: String,
    required: true,
    trim: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  paymentMethod: {
    type: String,
    enum: ["cash", "mpesa", "bank", "card", "other"],
    default: "cash"
  },
  status: {
    type: String,
    enum: ["pending", "validated", "rejected"],
    default: "pending"
  },
  recordedBy: {
    type: String,
    required: true,
    trim: true
  },
  validatedBy: {
    type: String,
    default: null
  },
  validatedAt: {
    type: Date,
    default: null
  },
  notes: {
    type: String,
    default: ""
  },
  region: {
    type: String,
    enum: ["Butembo", "China"],
    required: false
  },
  regionCode: {
    type: String,
    enum: ["Bbbb", "Cnnn"],
    required: false
  }
}, {
  timestamps: true
});

// Create index for better query performance
// NOTE: Removed duplicate index for expenseId (already created by unique: true)
expenseSchema.index({ createdAt: -1 });
expenseSchema.index({ status: 1 });
expenseSchema.index({ recordedBy: 1 });
// Net-income and history queries match validation status before date sorting.
expenseSchema.index({ status: 1, createdAt: -1, _id: -1 });
expenseSchema.index({ regionCode: 1 });

module.exports = mongoose.model("Expense", expenseSchema);
