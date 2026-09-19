const mongoose = require("mongoose");

// Durable, central record of an offline sale that could not be synchronized
// (stock conflict, rejected validation, etc.) so it survives even if the
// one offline laptop's browser storage is later cleared. Never mutates
// stock or totals itself — purely an audit/reconciliation trail.
const saleSyncConflictSchema = new mongoose.Schema({
  clientSaleId: { type: String, required: true, index: true },
  barcodeToken: { type: String, required: true },
  receiptNumber: { type: String, required: true },
  reason: { type: String, required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
  productName: { type: String, default: "" },
  localQuantity: { type: Number, default: null },
  occurredAt: { type: Date, required: true },
  salesPerson: { type: String, default: "" },
  region: { type: String, default: "" },
  regionCode: { type: String, default: "" },
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["open", "acknowledged"], default: "open" },
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  acknowledgedAt: { type: Date, default: null },
  // Original offline sale request body, kept for manual recovery/audit.
  payload: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

saleSyncConflictSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("SaleSyncConflict", saleSyncConflictSchema);
