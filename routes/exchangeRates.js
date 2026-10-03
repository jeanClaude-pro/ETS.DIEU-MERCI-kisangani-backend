const express = require("express");
const router = express.Router();
const ExchangeRate = require("../models/ExchangeRate");
const authMiddleware = require("../middleware/auth");
const requireModulePermission = require("../middleware/requireModulePermission");
const { isObjectId, toFiniteNumber, capLimit } = require("../utils/validate");
const { audit } = require("../utils/audit");

const MAX_RATE = 1e7;

router.param("id", (req, res, next, id) => {
  if (!isObjectId(id)) return res.status(400).json({ error: "Invalid exchange rate ID" });
  next();
});

// GET current active exchange rate
router.get("/current", async (req, res) => {
  try {
    const currentRate = await ExchangeRate.getCurrentRate();
    
    if (!currentRate) {
      return res.status(404).json({ 
        error: "No active exchange rate found" 
      });
    }

    res.json({
      _id: currentRate._id,
      rate: currentRate.rate,
      effectiveFrom: currentRate.effectiveFrom,
      lastUpdated: currentRate.updatedAt,
      notes: currentRate.notes
    });
  } catch (error) {
    console.error("Error fetching current exchange rate:", error);
    res.status(500).json({ error: "Failed to fetch exchange rate" });
  }
});

// GET exchange rate history (Admin only)
router.get("/history", authMiddleware, requireModulePermission("rate"), async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can view rate history" 
      });
    }

    const limit = capLimit(req.query.limit, { defaultLimit: 50, max: 200 });
    const history = await ExchangeRate.getRateHistory(limit);

    res.json({
      history,
      total: history.length
    });
  } catch (error) {
    console.error("Error fetching exchange rate history:", error);
    res.status(500).json({ error: "Failed to fetch rate history" });
  }
});

// CREATE new exchange rate (Admin only)
router.post("/", authMiddleware, requireModulePermission("rate"), async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can set exchange rates" 
      });
    }

    const { rate, effectiveFrom, notes } = req.body;

    // Validate required fields
    const parsedRate = toFiniteNumber(rate, { min: 0, max: MAX_RATE, exclusiveMin: true });
    if (parsedRate === null) {
      return res.status(400).json({ 
        error: "Valid exchange rate is required" 
      });
    }
    if (effectiveFrom !== undefined && effectiveFrom !== null && effectiveFrom !== "" &&
        Number.isNaN(new Date(effectiveFrom).getTime())) {
      return res.status(400).json({ error: "Invalid effectiveFrom date" });
    }
    if (notes !== undefined && typeof notes !== "string") {
      return res.status(400).json({ error: "Invalid notes" });
    }
    const previousRate = await ExchangeRate.getCurrentRate();

    // Deactivate all previous rates
    await ExchangeRate.updateMany(
      { isActive: true },
      { isActive: false }
    );

    // Create new active rate
    const newRate = new ExchangeRate({
      rate: parsedRate,
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
      createdBy: req.user.userId,
      notes: notes || ""
    });

    const savedRate = await newRate.save();
    await audit(req, "exchange_rate.set", {
      targetType: "ExchangeRate",
      targetId: savedRate._id,
      before: previousRate ? { rate: previousRate.rate } : null,
      after: { rate: savedRate.rate, effectiveFrom: savedRate.effectiveFrom },
    });

    res.status(201).json({
      message: "Exchange rate updated successfully",
      rate: savedRate
    });
  } catch (error) {
    console.error("Error creating exchange rate:", error);
    
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    
    res.status(500).json({ error: "Failed to update exchange rate" });
  }
});

// UPDATE exchange rate (Admin only)
router.put("/:id", authMiddleware, requireModulePermission("rate"), async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can update exchange rates" 
      });
    }

    const { id } = req.params;
    const { rate, notes } = req.body;

    const existingRate = await ExchangeRate.findById(id);
    if (!existingRate) {
      return res.status(404).json({ error: "Exchange rate not found" });
    }

    // Validate rate if provided
    const parsedRate = rate === undefined || rate === null || rate === ""
      ? undefined
      : toFiniteNumber(rate, { min: 0, max: MAX_RATE, exclusiveMin: true });
    if (parsedRate === null) {
      return res.status(400).json({ 
        error: "Valid exchange rate is required" 
      });
    }
    if (notes !== undefined && typeof notes !== "string") {
      return res.status(400).json({ error: "Invalid notes" });
    }

    // Update rate
    const before = { rate: existingRate.rate, notes: existingRate.notes };
    if (parsedRate !== undefined) existingRate.rate = parsedRate;
    if (notes !== undefined) existingRate.notes = notes;

    const updatedRate = await existingRate.save();
    await audit(req, "exchange_rate.updated", {
      targetType: "ExchangeRate",
      targetId: updatedRate._id,
      before,
      after: { rate: updatedRate.rate, notes: updatedRate.notes },
    });

    res.json({
      message: "Exchange rate updated successfully",
      rate: updatedRate
    });
  } catch (error) {
    console.error("Error updating exchange rate:", error);
    
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid exchange rate ID" });
    }
    
    res.status(500).json({ error: "Failed to update exchange rate" });
  }
});

// DEACTIVATE exchange rate (Admin only)
router.patch("/:id/deactivate", authMiddleware, requireModulePermission("rate"), async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can deactivate exchange rates" 
      });
    }

    const { id } = req.params;

    const rate = await ExchangeRate.findById(id);
    if (!rate) {
      return res.status(404).json({ error: "Exchange rate not found" });
    }

    if (!rate.isActive) {
      return res.status(400).json({ error: "Exchange rate is already inactive" });
    }

    await rate.deactivate();

    res.json({
      message: "Exchange rate deactivated successfully",
      rate
    });
  } catch (error) {
    console.error("Error deactivating exchange rate:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid exchange rate ID" });
    }
    
    res.status(500).json({ error: "Failed to deactivate exchange rate" });
  }
});

module.exports = router;