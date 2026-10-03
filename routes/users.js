const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");

const User = require("../models/User");
const authMiddleware = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const { ROLE_ENUM, MODULE_IDS } = require("../utils/userAccess");
const { isObjectId, escapeRegex, isValidEmail, passwordPolicyError } = require("../utils/validate");
const { unlockEmail } = require("../middleware/loginThrottle");
const { audit } = require("../utils/audit");

// Apply auth middleware to all routes
router.use(authMiddleware);

// Reject malformed ids before any database call.
router.param("userId", (req, res, next, userId) => {
  if (!isObjectId(userId)) return res.status(400).json({ message: "Invalid user ID" });
  next();
});

const SAFE_FIELDS = "_id username email role status isActive modulePermissions approvedBy approvedAt createdAt updatedAt";

// Buckets legacy documents (created before the `status` field existed) using
// their pre-existing `isActive` value, so listing/filtering is correct even
// for rows the schema default can't reach at the query level.
function statusFilter(status) {
  if (status === "pending" || status === "rejected") return { status };
  if (status === "active") {
    return { $or: [{ status: "active" }, { status: { $exists: false }, isActive: true }] };
  }
  if (status === "suspended") {
    return { $or: [{ status: "suspended" }, { status: { $exists: false }, isActive: false }] };
  }
  return null;
}

function pushHistory(user, action, performedBy, details) {
  user.history = user.history || [];
  user.history.push({
    action,
    performedBy: performedBy?._id || null,
    performedByUsername: performedBy?.username || null,
    details: details || null,
  });
}

function validateModulePermissions(modulePermissions) {
  if (!Array.isArray(modulePermissions)) return "modulePermissions must be an array";
  const unknown = modulePermissions.filter((id) => !MODULE_IDS.includes(id));
  if (unknown.length) return `Unknown module id(s): ${unknown.join(", ")}`;
  return null;
}

function isSelf(req) {
  return req.params.userId === req.user._id.toString();
}

function isActiveAdmin(user) {
  return user.role === "admin" && user.isActive !== false &&
    !["suspended", "pending", "rejected"].includes(user.status);
}

// The shop must always keep at least one active admin. Called before any
// change that would remove `user`'s active-admin standing.
async function wouldRemoveLastActiveAdmin(user) {
  if (!isActiveAdmin(user)) return false;
  const others = await User.countDocuments({
    _id: { $ne: user._id },
    role: "admin",
    isActive: { $ne: false },
    status: { $nin: ["suspended", "pending", "rejected"] },
  });
  return others === 0;
}

const LAST_ADMIN_MESSAGE = "The last active administrator cannot be removed, demoted or suspended";

// Invalidates every JWT issued to this user so far.
function revokeTokens(user) {
  user.tokenVersion = (user.tokenVersion || 0) + 1;
}

function userSnapshot(user) {
  return {
    username: user.username,
    email: user.email,
    role: user.role,
    status: user.status,
    isActive: user.isActive,
    modulePermissions: user.modulePermissions,
  };
}

// Get current user profile (self-service, no module gate)
router.get("/me", async (req, res) => {
  const userId = req.user._id;
  try {
    const user = await User.findById(userId).select(SAFE_FIELDS);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Change own password (self-service). Requires the current password and
// signs out every other session; the caller must log in again.
router.put("/me/password", async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return res.status(400).json({ message: "currentPassword and newPassword are required" });
    }
    const policyError = passwordPolicyError(newPassword);
    if (policyError) return res.status(400).json({ message: policyError });

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    revokeTokens(user);
    await user.save();
    await audit(req, "user.password_changed", { targetType: "User", targetId: user._id });

    res.json({ message: "Password updated. Please sign in again." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// List users with filters/search/pagination (Admin only)
router.get("/", requireRole("admin"), async (req, res) => {
  try {
    const { status, role, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    const filters = [];
    if (status) {
      const filter = statusFilter(status);
      if (!filter) return res.status(400).json({ message: "Invalid status filter" });
      filters.push(filter);
    }
    if (role) {
      if (!ROLE_ENUM.includes(role)) return res.status(400).json({ message: "Invalid role filter" });
      filters.push({ role });
    }
    if (search) {
      const pattern = new RegExp(escapeRegex(String(search).trim().slice(0, 100)), "i");
      filters.push({ $or: [{ username: pattern }, { email: pattern }] });
    }
    const query = filters.length ? { $and: filters } : {};

    const [users, total] = await Promise.all([
      User.find(query)
        .select(SAFE_FIELDS)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(query),
    ]);

    res.json({ users, total, page, limit, pages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Aggregate counts for the Management dashboard tiles (Admin only)
router.get("/stats", requireRole("admin"), async (req, res) => {
  try {
    const [pending, active, suspended, rejected, byRoleAgg] = await Promise.all([
      User.countDocuments(statusFilter("pending")),
      User.countDocuments(statusFilter("active")),
      User.countDocuments(statusFilter("suspended")),
      User.countDocuments(statusFilter("rejected")),
      User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
    ]);

    const byRole = {};
    for (const entry of byRoleAgg) byRole[entry._id || "staff"] = entry.count;

    res.json({ pending, active, suspended, rejected, byRole });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Single user detail incl. audit history (Admin only)
router.get("/:userId", requireRole("admin"), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select(`${SAFE_FIELDS} history`);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Create new user (Admin only) — pre-approved, active immediately
router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const { username, email, password, role } = req.body;

    if (!ROLE_ENUM.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }
    if (typeof username !== "string" || !username.trim() || username.trim().length > 60) {
      return res.status(400).json({ message: "A username of at most 60 characters is required" });
    }
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ message: "Invalid email address" });
    }
    const policyError = passwordPolicyError(password);
    if (policyError) {
      return res.status(400).json({ message: policyError });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      username: username.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role,
      status: "active",
      approvedBy: req.user._id,
      approvedAt: new Date(),
      history: [
        {
          action: "approved",
          performedBy: req.user._id,
          performedByUsername: req.user.username,
          details: { createdDirectlyByAdmin: true, role },
        },
      ],
    });

    await newUser.save();
    await audit(req, "user.created", { targetType: "User", targetId: newUser._id, after: userSnapshot(newUser) });

    const userResponse = await User.findById(newUser._id).select(SAFE_FIELDS);
    res.status(201).json(userResponse);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Email already exists" });
    }
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Approve a pending request: assign role + modules, activate (Admin only)
router.patch("/:userId/approve", requireRole("admin"), async (req, res) => {
  try {
    const { role, modulePermissions } = req.body;

    if (isSelf(req)) {
      return res.status(400).json({ message: "Cannot approve your own account" });
    }
    if (!ROLE_ENUM.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    let modules;
    if (role !== "admin") {
      const error = validateModulePermissions(modulePermissions || []);
      if (error) return res.status(400).json({ message: error });
      modules = modulePermissions || [];
    }

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    // Approval is only for account requests; role/status changes of existing
    // accounts go through their own endpoints and guards.
    if (user.status !== "pending" && user.status !== "rejected") {
      return res.status(400).json({ message: "Only pending or rejected accounts can be approved" });
    }

    const before = userSnapshot(user);
    user.role = role;
    user.modulePermissions = modules;
    user.status = "active";
    user.approvedBy = req.user._id;
    user.approvedAt = new Date();
    pushHistory(user, "approved", req.user, { role, modulePermissions: modules });
    await user.save();
    await audit(req, "user.approved", { targetType: "User", targetId: user._id, before, after: userSnapshot(user) });

    res.json(await User.findById(user._id).select(SAFE_FIELDS));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Reject a pending request (Admin only)
router.patch("/:userId/reject", requireRole("admin"), async (req, res) => {
  try {
    const { reason } = req.body;
    if (isSelf(req)) {
      return res.status(400).json({ message: "Cannot reject your own account" });
    }
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (await wouldRemoveLastActiveAdmin(user)) {
      return res.status(400).json({ message: LAST_ADMIN_MESSAGE });
    }

    const before = userSnapshot(user);
    user.status = "rejected";
    revokeTokens(user);
    pushHistory(user, "rejected", req.user, { reason: typeof reason === "string" ? reason.slice(0, 500) : null });
    await user.save();
    await audit(req, "user.rejected", { targetType: "User", targetId: user._id, before, after: userSnapshot(user) });

    res.json(await User.findById(user._id).select(SAFE_FIELDS));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Suspend an active account (Admin only)
router.patch("/:userId/suspend", requireRole("admin"), async (req, res) => {
  try {
    if (isSelf(req)) {
      return res.status(400).json({ message: "Cannot suspend your own account" });
    }
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.status !== "active") {
      return res.status(400).json({ message: "Only active accounts can be suspended" });
    }
    if (await wouldRemoveLastActiveAdmin(user)) {
      return res.status(400).json({ message: LAST_ADMIN_MESSAGE });
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
    user.status = "suspended";
    revokeTokens(user);
    pushHistory(user, "suspended", req.user, { reason });
    await user.save();
    await audit(req, "user.suspended", { targetType: "User", targetId: user._id, meta: { reason } });

    res.json(await User.findById(user._id).select(SAFE_FIELDS));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Reactivate a suspended account (Admin only)
router.patch("/:userId/reactivate", requireRole("admin"), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.status !== "suspended") {
      return res.status(400).json({ message: "Only suspended accounts can be reactivated" });
    }

    user.status = "active";
    pushHistory(user, "reactivated", req.user, null);
    await user.save();
    await audit(req, "user.reactivated", { targetType: "User", targetId: user._id });

    res.json(await User.findById(user._id).select(SAFE_FIELDS));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update user role (Admin only)
router.put("/:userId/role", requireRole("admin"), async (req, res) => {
  try {
    const { role } = req.body;
    if (!ROLE_ENUM.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }
    // No user may change their own role.
    if (isSelf(req)) {
      return res.status(400).json({ message: "Cannot change your own role" });
    }

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (role !== "admin" && await wouldRemoveLastActiveAdmin(user)) {
      return res.status(400).json({ message: LAST_ADMIN_MESSAGE });
    }

    const from = user.role;
    user.role = role;
    if (from !== role) revokeTokens(user);
    pushHistory(user, "role_changed", req.user, { from, to: role });
    await user.save();
    await audit(req, "user.role_changed", { targetType: "User", targetId: user._id, before: { role: from }, after: { role } });

    res.json(await User.findById(user._id).select(SAFE_FIELDS));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update per-user module permissions (Admin only)
router.put("/:userId/modules", requireRole("admin"), async (req, res) => {
  try {
    const { modulePermissions } = req.body;
    const error = validateModulePermissions(modulePermissions);
    if (error) return res.status(400).json({ message: error });

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const before = { modulePermissions: user.modulePermissions };
    user.modulePermissions = modulePermissions;
    pushHistory(user, "permissions_changed", req.user, { modulePermissions });
    await user.save();
    await audit(req, "user.modules_changed", { targetType: "User", targetId: user._id, before, after: { modulePermissions } });

    res.json(await User.findById(user._id).select(SAFE_FIELDS));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Toggle active/suspended for backward compatibility (Admin only).
// Pending/rejected accounts must go through approve/reject instead.
router.put("/:userId/status", requireRole("admin"), async (req, res) => {
  try {
    if (isSelf(req)) {
      return res.status(400).json({ message: "Cannot change your own status" });
    }
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.status === "pending" || user.status === "rejected") {
      return res.status(400).json({ message: "Use approve/reject for pending accounts" });
    }

    const nextStatus = user.status === "active" ? "suspended" : "active";
    if (nextStatus === "suspended" && await wouldRemoveLastActiveAdmin(user)) {
      return res.status(400).json({ message: LAST_ADMIN_MESSAGE });
    }
    user.status = nextStatus;
    if (nextStatus === "suspended") revokeTokens(user);
    pushHistory(user, nextStatus === "active" ? "reactivated" : "suspended", req.user, null);
    await user.save();
    await audit(req, nextStatus === "active" ? "user.reactivated" : "user.suspended", { targetType: "User", targetId: user._id });

    res.json({
      message: `User ${nextStatus === "active" ? "activated" : "deactivated"} successfully`,
      user: await User.findById(user._id).select(SAFE_FIELDS),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Set a new password for another user (Admin only). Revokes that user's
// existing sessions. The admin communicates the new password out of band.
router.put("/:userId/password", requireRole("admin"), async (req, res) => {
  try {
    if (isSelf(req)) {
      return res.status(400).json({ message: "Use /users/me/password to change your own password" });
    }
    const { newPassword } = req.body || {};
    const policyError = passwordPolicyError(newPassword);
    if (policyError) return res.status(400).json({ message: policyError });

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.password = await bcrypt.hash(newPassword, 10);
    revokeTokens(user);
    await user.save();
    await unlockEmail(user.email);
    await audit(req, "user.password_reset", { targetType: "User", targetId: user._id });

    res.json({ message: "Password reset successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Clear a login lockout for this user's email, from any IP (Admin only).
router.post("/:userId/unlock-login", requireRole("admin"), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select("email");
    if (!user) return res.status(404).json({ message: "User not found" });
    const cleared = await unlockEmail(user.email);
    await audit(req, "user.login_unlocked", { targetType: "User", targetId: user._id, meta: { cleared } });
    res.json({ message: "Login lock cleared", cleared });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Delete user (Admin only)
router.delete("/:userId", requireRole("admin"), async (req, res) => {
  try {
    // Prevent users from deleting themselves
    if (isSelf(req)) {
      return res.status(400).json({ message: "Cannot delete your own account" });
    }

    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if (await wouldRemoveLastActiveAdmin(user)) {
      return res.status(400).json({ message: LAST_ADMIN_MESSAGE });
    }

    await User.deleteOne({ _id: user._id });
    await audit(req, "user.deleted", { targetType: "User", targetId: user._id, before: userSnapshot(user) });

    res.json({ message: "User deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update user profile (Own profile or Admin)
router.put("/:userId/profile", async (req, res) => {
  try {
    const { username, email } = req.body;
    const userId = req.params.userId;

    // Users can only update their own profile unless they're admin
    if (req.user.role !== "admin" && userId !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    const updateData = {};
    if (username !== undefined && username !== "") {
      if (typeof username !== "string" || !username.trim() || username.trim().length > 60) {
        return res.status(400).json({ message: "A username of at most 60 characters is required" });
      }
      updateData.username = username.trim();
    }
    if (email !== undefined && email !== "") {
      const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
      if (!isValidEmail(normalizedEmail)) {
        return res.status(400).json({ message: "Invalid email address" });
      }
      updateData.email = normalizedEmail;
    }

    const before = await User.findById(userId).select("username email");
    if (!before) {
      return res.status(404).json({ message: "User not found" });
    }
    const user = await User.findByIdAndUpdate(userId, updateData, { new: true }).select(SAFE_FIELDS);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    await audit(req, "user.profile_updated", {
      targetType: "User",
      targetId: userId,
      before: { username: before.username, email: before.email },
      after: updateData,
    });

    res.json(user);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Email already exists" });
    }
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router._testing = { isActiveAdmin, wouldRemoveLastActiveAdmin, revokeTokens };

module.exports = router;
