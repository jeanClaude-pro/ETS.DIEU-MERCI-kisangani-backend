const mongoose = require("mongoose");

// One row per issued refresh token. Only a SHA-256 hash of the token is
// stored, so a database leak never yields a usable token. Every successful
// refresh "rotates": the row is marked rotated and a new row (same family)
// replaces it. Presenting a rotated token again is treated as theft and
// revokes the whole family (every device session started by that login).
const refreshSessionSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  familyId: { type: String, required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  // The user's tokenVersion when issued: a password reset, role/region
  // change or suspension bumps it and kills every refresh token at once.
  tokenVersion: { type: Number, default: 0 },
  // Absolute end of the login session, kept across rotations.
  sessionExpiresAt: { type: Date, required: true },
  // Sliding expiry: unused for longer than the idle window → dead.
  idleExpiresAt: { type: Date, required: true },
  rotatedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  revokedReason: { type: String, default: null },
  userAgent: { type: String, default: "" },
  ip: { type: String, default: "" },
}, { timestamps: true });

// MongoDB removes rows automatically once the login session has ended.
refreshSessionSchema.index({ sessionExpiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.RefreshSession || mongoose.model("RefreshSession", refreshSessionSchema);
