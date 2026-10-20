// routes/auth.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const RefreshSession = require("../models/RefreshSession");
const { signAccessToken, startSession, rotateSession, endSession, SessionError } = require("../utils/sessionTokens");
const { isAccountUsable, statusDenialMessage } = require("../utils/userAccess");
const loginThrottle = require("../middleware/loginThrottle");
const { audit } = require("../utils/audit");

function safeUserPayload(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    status: user.status,
    regionScope: user.role === "admin" ? "all" : (user.regionScope || "all"),
    modulePermissions: user.modulePermissions,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

const requestMeta = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

// A device renews about every 13 minutes; this ceiling only stops scripted
// guessing against /refresh and /logout.
const sessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: false,
  legacyHeaders: false,
  message: { message: "Trop de requêtes, réessayez plus tard.", code: "RATE_LIMITED" },
});

// Helper: basic field guard
function required(...fields) {
  return fields.every((f) => typeof f === "string" && f.trim().length > 0);
}

// Compared against when the email is unknown so a missing account takes as
// long as a wrong password (no timing-based account discovery).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);
const INVALID_CREDENTIALS = "Invalid email or password";

// Public registration: modest per-IP ceiling. No headers that reveal the
// window (standardHeaders/legacyHeaders off also suppresses Retry-After).
// Public self-registration has been removed: accounts are created by an
// administrator in the Management space, with a role and a region.
router.post("/register", (req, res) => {
  res.status(410).json({ message: "Les comptes sont créés par un administrateur." });
});

router.post("/login", async (req, res) => {
  try {
    let { email, password } = req.body || {};
    if (![email, password].every((value) => value === undefined || typeof value === "string")) {
      return res.status(400).json({ message: "Missing credentials" });
    }
    email = (email || "").trim().toLowerCase();
    password = String(password || "");

    if (!required(email, password) || email.length > 254 || password.length > 128) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    const ip = req.ip;
    if (await loginThrottle.isBlocked(ip, email)) {
      return loginThrottle.sendTooManyAttempts(res);
    }

    // 1) DO NOT exclude password here; we need it to compare
    const user = await User.findOne({ email });

    // 2) Compare plain password with stored hash (a dummy hash when the
    // account doesn't exist, so both failures cost the same time).
    const ok = await bcrypt.compare(password, user ? user.password : DUMMY_PASSWORD_HASH);
    if (!user || !ok) {
      const { accountLocked, ipLocked } = await loginThrottle.recordFailure(ip, email);
      await audit(req, "auth.login_failed", {
        targetType: "User",
        targetId: user?._id || null,
        meta: { email, reason: user ? "wrong_password" : "unknown_email" },
      });
      if (accountLocked || ipLocked) {
        await audit(req, "auth.login_locked", {
          targetType: "User",
          targetId: user?._id || null,
          meta: { email, scope: accountLocked ? "account" : "ip" },
        });
      }
      return res.status(400).json({ message: INVALID_CREDENTIALS });
    }

    await loginThrottle.recordSuccess(ip, email);

    if (!isAccountUsable(user)) {
      return res.status(403).json({ message: statusDenialMessage(user) });
    }

    // 3) Tokens AFTER a successful compare: a 15-minute access token and a
    // single-use refresh token that renews it while the user is active.
    const access = signAccessToken(user);
    const refreshToken = await startSession(RefreshSession, user, requestMeta(req));

    // 4) Return a safe user payload (don’t send the password/hash)
    const safeUser = safeUserPayload(user);
    console.log("User logged in:", safeUser.id);

    return res.status(200).json({ user: safeUser, token: access.token, accessExpiresAt: access.expiresAt, refreshToken });
  } catch (error) {
    console.error("Error logging in user:", error.message);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// POST /api/auth/refresh { refreshToken } → new access + refresh tokens.
// The presented refresh token is retired; reusing it later revokes the
// whole session (it can only mean the token was copied).
const REFRESH_STATUS = { REFRESH_ROTATED: 409, INVALID_REFRESH: 401, REFRESH_REUSED: 401, SESSION_EXPIRED: 401 };
router.post("/refresh", sessionLimiter, async (req, res) => {
  try {
    const { user, refreshToken } = await rotateSession(RefreshSession, req.body?.refreshToken, {
      loadUser: (id) => User.findById(id).select("-password"),
      isUsable: isAccountUsable,
      meta: requestMeta(req),
    });
    const access = signAccessToken(user);
    return res.status(200).json({ user: safeUserPayload(user), token: access.token, accessExpiresAt: access.expiresAt, refreshToken });
  } catch (error) {
    if (error instanceof SessionError) {
      if (error.code === "REFRESH_REUSED") {
        await audit(req, "auth.refresh_reuse", { targetType: "RefreshSession", meta: {} });
      }
      return res.status(REFRESH_STATUS[error.code] || 401).json({ message: error.message, code: error.code });
    }
    console.error("Error refreshing session:", error.message);
    return res.status(503).json({ message: "Service temporarily unavailable", code: "SERVICE_UNAVAILABLE" });
  }
});

// POST /api/auth/logout { refreshToken } → the session can't be renewed
// anymore; the current access token dies within 15 minutes at most.
router.post("/logout", sessionLimiter, async (req, res) => {
  try {
    await endSession(RefreshSession, req.body?.refreshToken);
  } catch (error) {
    console.error("Error ending session:", error.message);
  }
  return res.status(204).end();
});

router._testing = { DUMMY_PASSWORD_HASH, INVALID_CREDENTIALS };

module.exports = router;
