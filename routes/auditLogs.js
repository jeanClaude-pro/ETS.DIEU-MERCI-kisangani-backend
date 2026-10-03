const express = require("express");
const AuditLog = require("../models/AuditLog");
const authMiddleware = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const { parsePagination } = require("../utils/reportingDate");
const { isObjectId } = require("../utils/validate");

const router = express.Router();

// Read-only, admin-only. There are intentionally no POST/PUT/PATCH/DELETE
// routes: audit entries can't be created, edited or removed through the API.
router.get("/", authMiddleware, requireRole("admin"), async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 });
    const filter = {};
    if (typeof req.query.action === "string" && /^[a-z_.]{1,60}$/.test(req.query.action)) {
      filter.action = req.query.action;
    }
    if (typeof req.query.targetType === "string" && /^[A-Za-z]{1,40}$/.test(req.query.targetType)) {
      filter.targetType = req.query.targetType;
    }
    if (typeof req.query.targetId === "string" && req.query.targetId.length <= 100) {
      filter.targetId = req.query.targetId;
    }
    if (typeof req.query.actorId === "string" && isObjectId(req.query.actorId)) {
      filter["actor.id"] = req.query.actorId;
    }

    const [entries, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    res.json({ entries, pagination: { totalRecords: total, totalPages: Math.ceil(total / limit), currentPage: page, limit } });
  } catch (error) {
    console.error("Error listing audit log:", error.message);
    res.status(500).json({ error: "Failed to list audit log" });
  }
});

module.exports = router;
