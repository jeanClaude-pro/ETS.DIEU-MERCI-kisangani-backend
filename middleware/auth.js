const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");
const { isAccountUsable, statusDenialMessage } = require("../utils/userAccess");

// Errors that mean "the database itself couldn't be reached/queried" as
// opposed to "the token/user is invalid". These must never be reported as
// 401 — a DB outage is not an authentication failure, and misreporting it
// as one both breaks every authenticated route at once and (client-side)
// destroys the cached session an offline device needs to keep selling.
function isDatabaseUnavailableError(err) {
  if (!err) return false;
  if (err.name === "MongooseServerSelectionError" || err.name === "MongoServerSelectionError") return true;
  if (err.name === "MongoNetworkError" || err.name === "MongoNetworkTimeoutError") return true;
  if (err.name === "MongooseError" && /buffering timed out/i.test(err.message || "")) return true;
  return false;
}

async function authMiddleware(req, res, next) {
  // Get token from header
  const authHeader = req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  const token = authHeader.split(" ")[1];

  // Verify the JWT itself first — a malformed/expired/forged token is a
  // genuine 401 regardless of database state, so this must not be skipped
  // or delayed by a DB-readiness check.
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    console.error("Invalid token:", err.message);
    return res.status(401).json({ message: "Token is not valid" });
  }

  // The database dependency is checked separately from token verification
  // so an outage is reported as 503 (service unavailable), matching
  // /api/health's own classification, instead of masquerading as 401.
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: "Service temporarily unavailable",
      code: "SERVICE_UNAVAILABLE",
    });
  }

  let user;
  try {
    user = await User.findById(decoded.id).select("-password");
  } catch (err) {
    if (isDatabaseUnavailableError(err)) {
      console.warn("Auth DB lookup failed (database unavailable):", err.message);
      return res.status(503).json({
        error: "Service temporarily unavailable",
        code: "SERVICE_UNAVAILABLE",
      });
    }
    console.error("Auth DB lookup failed:", err.message);
    return res.status(401).json({ message: "Token is not valid" });
  }

  if (!user) {
    return res.status(401).json({ message: "User not found" });
  }

  // Re-checked on every request (not just at login) so a suspended/rejected
  // account loses access immediately, even with an already-issued token.
  if (!isAccountUsable(user)) {
    return res.status(401).json({ message: statusDenialMessage(user) });
  }

  req.user = user;

  // ✅ ADD THESE PERMISSION FLAGS
  req.user.canValidate = user.role === 'admin' || user.role === 'manager';
  req.user.isAdmin = user.role === 'admin';

  // ✅ Also add these for compatibility
  req.user.id = user._id.toString();
  req.user.userId = user._id.toString();

  next(); // continue to next middleware/route
}

module.exports = authMiddleware;