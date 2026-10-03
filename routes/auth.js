// routes/auth.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/genrateToken");
const { isAccountUsable, statusDenialMessage, sanitizeRegistrationInput } = require("../utils/userAccess");
const { isValidEmail, passwordPolicyError } = require("../utils/validate");
const loginThrottle = require("../middleware/loginThrottle");
const { audit } = require("../utils/audit");

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
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: false,
  legacyHeaders: false,
  handler: (req, res) => loginThrottle.sendTooManyAttempts(res),
});

router.post("/register", registerLimiter, async (req, res) => {
  try {
    // Public registration must never let the caller pick role/status/isActive
    // or any other privileged field — only these three are ever read.
    let { username, email, password } = sanitizeRegistrationInput(req.body);
    if (![username, email, password].every((value) => value === undefined || typeof value === "string")) {
      return res.status(400).json({ message: "Invalid request" });
    }
    username = (username || "").trim();
    email = (email || "").trim().toLowerCase();
    password = String(password || "");

    if (!required(username, email, password)) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    if (username.length > 60) {
      return res.status(400).json({ message: "Username is too long" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Invalid email address" });
    }
    const policyError = passwordPolicyError(password);
    if (policyError) {
      return res.status(400).json({ message: policyError });
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      username,
      email,
      password: hashedPassword,
      status: "pending",
      history: [{ action: "requested" }],
    });

    // Keep response minimal for register; client will switch to login
    return res.status(201).json({
      message: `Merci ${newUser.username}, votre inscription a été reçue. Un administrateur doit approuver votre compte avant que vous puissiez vous connecter.`,
    });
  } catch (error) {
    console.error("Error registering user:", error.message);
    return res.status(500).json({ message: "Internal server error" });
  }
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

    // 3) Create token AFTER successful compare
    const token = generateToken(user);

    // 4) Return a safe user payload (don’t send the password/hash)
    const safeUser = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status,
      modulePermissions: user.modulePermissions,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };

    console.log("User logged in:", safeUser.id);

    return res.status(200).json({ user: safeUser, token });
  } catch (error) {
    console.error("Error logging in user:", error.message);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router._testing = { DUMMY_PASSWORD_HASH, INVALID_CREDENTIALS };

module.exports = router;
