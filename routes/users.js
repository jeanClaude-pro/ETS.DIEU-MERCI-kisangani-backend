const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");

const User = require("../models/User");
const authMiddleware = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const { ROLE_ENUM, MODULE_IDS } = require("../utils/userAccess");

// Apply auth middleware to all routes
router.use(authMiddleware);

const SAFE_FIELDS = "_id username email role status isActive modulePermissions approvedBy approvedAt createdAt updatedAt";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
      const pattern = new RegExp(escapeRegExp(String(search).trim()), "i");
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
    if (!password || String(password).length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      username,
      email,
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

    user.role = role;
    user.modulePermissions = modules;
    user.status = "active";
    user.approvedBy = req.user._id;
    user.approvedAt = new Date();
    pushHistory(user, "approved", req.user, { role, modulePermissions: modules });
    await user.save();

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
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.status = "rejected";
    pushHistory(user, "rejected", req.user, { reason: reason || null });
    await user.save();

    res.json(await User.findById(user._id).select(SAFE_FIELDS));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Suspend an active account (Admin only)
router.patch("/:userId/suspend", requireRole("admin"), async (req, res) => {
  try {
    if (req.params.userId === req.user._id.toString()) {
      return res.status(400).json({ message: "Cannot suspend your own account" });
    }
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.status !== "active") {
      return res.status(400).json({ message: "Only active accounts can be suspended" });
    }

    user.status = "suspended";
    pushHistory(user, "suspended", req.user, { reason: req.body?.reason || null });
    await user.save();

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
    if (req.params.userId === req.user._id.toString() && role !== "admin") {
      return res.status(400).json({ message: "Cannot change your own role" });
    }

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const from = user.role;
    user.role = role;
    pushHistory(user, "role_changed", req.user, { from, to: role });
    await user.save();

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

    user.modulePermissions = modulePermissions;
    pushHistory(user, "permissions_changed", req.user, { modulePermissions });
    await user.save();

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
    if (req.params.userId === req.user._id.toString()) {
      return res.status(400).json({ message: "Cannot change your own status" });
    }
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.status === "pending" || user.status === "rejected") {
      return res.status(400).json({ message: "Use approve/reject for pending accounts" });
    }

    const nextStatus = user.status === "active" ? "suspended" : "active";
    user.status = nextStatus;
    pushHistory(user, nextStatus === "active" ? "reactivated" : "suspended", req.user, null);
    await user.save();

    res.json({
      message: `User ${nextStatus === "active" ? "activated" : "deactivated"} successfully`,
      user: await User.findById(user._id).select(SAFE_FIELDS),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Delete user (Admin only)
router.delete("/:userId", requireRole("admin"), async (req, res) => {
  try {
    // Prevent users from deleting themselves
    if (req.params.userId === req.user._id.toString()) {
      return res.status(400).json({ message: "Cannot delete your own account" });
    }

    const user = await User.findByIdAndDelete(req.params.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

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
    if (username) updateData.username = username;
    if (email) updateData.email = email;

    const user = await User.findByIdAndUpdate(userId, updateData, { new: true }).select(SAFE_FIELDS);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Email already exists" });
    }
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
