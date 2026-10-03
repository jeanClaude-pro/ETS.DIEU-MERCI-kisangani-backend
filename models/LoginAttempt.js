const mongoose = require("mongoose");

// Persistent failed-login counters (see middleware/loginThrottle.js). Stored
// in MongoDB so a server restart or a second instance never resets an active
// lockout. The TTL index removes each document once it no longer matters.
const loginAttemptSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  windowStart: { type: Date, required: true },
  lockedUntil: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
});

loginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.LoginAttempt || mongoose.model("LoginAttempt", loginAttemptSchema);
