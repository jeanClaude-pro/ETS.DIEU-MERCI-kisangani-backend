const mongoose = require("mongoose");

// Append-only trail of sensitive actions (who, what, when, target,
// before/after). There are no API routes that edit or delete entries, and
// the hooks below make update/delete queries fail in application code too.
const auditLogSchema = new mongoose.Schema({
  action: { type: String, required: true },
  actor: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    username: { type: String, default: null },
    role: { type: String, default: null },
  },
  targetType: { type: String, default: null },
  targetId: { type: String, default: null },
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

function rejectMutation() {
  throw new Error("Audit log entries are append-only");
}

for (const op of [
  "updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace",
  "deleteOne", "deleteMany", "findOneAndDelete",
]) {
  auditLogSchema.pre(op, rejectMutation);
}
auditLogSchema.pre("save", function blockResave() {
  if (!this.isNew) rejectMutation();
});

module.exports = mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);
