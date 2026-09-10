const express = require("express");
const router = express.Router();
const Customer = require("../models/Customer");
const Sale = require("../models/Sale"); // Make sure to import Sale model
const { ensureWalkInCustomer } = require("../utils/walkInCustomer");
const mongoose = require("mongoose");
const { parsePagination } = require("../utils/reportingDate");
const authMiddleware = require("../middleware/auth");

router.use(authMiddleware);

// GET /api/customers/walkin - Get the permanent system Walk-in Customer
// (created lazily here as a fallback in case the startup bootstrap hasn't run)
router.get("/walkin", async (req, res) => {
  try {
    const customer = await ensureWalkInCustomer();
    res.json(customer);
  } catch (error) {
    console.error("Error fetching walk-in customer:", error);
    res.status(500).json({ error: "Failed to fetch walk-in customer" });
  }
});

// GET /api/customers - Get all customers with optional filtering
// Excludes the system Walk-in Customer by default since it isn't a real
// customer to manage; pass includeWalkIn=true to include it.
router.get("/", async (req, res) => {
  try {
    const { search, includeWalkIn } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

    // Build filter object
    const filter = {};
    if (includeWalkIn !== "true") {
      filter.isWalkIn = { $ne: true };
    }

    if (search) {
      const escapedSearch = String(search).replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
      filter.$or = [
        { name: { $regex: escapedSearch, $options: "i" } },
        { phone: { $regex: escapedSearch, $options: "i" } },
        { email: { $regex: escapedSearch, $options: "i" } }
      ];
    }
    
    const [facet = {}] = await Customer.aggregate([
      { $match: filter },
      { $facet: {
        customers: [{ $sort: { totalSpent: -1, lastPurchaseDate: -1, _id: 1 } }, { $skip: skip }, { $limit: limit }],
        metadata: [{ $count: "total" }],
        summary: [{ $group: {
          _id: null,
          totalSpent: { $sum: "$totalSpent" },
          totalPurchases: { $sum: "$totalPurchases" },
          activeCustomers: { $sum: { $cond: [{ $gt: [{ $ifNull: ["$totalSpent", 0] }, 0] }, 1, 0] } },
        } }],
      } },
    ]);
    const customers = facet.customers || [];
    const total = facet.metadata?.[0]?.total || 0;
    
    res.json({
      customers,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
      limit,
      summary: facet.summary?.[0] || { totalSpent: 0, totalPurchases: 0, activeCustomers: 0 }
    });
  } catch (error) {
    console.error("Error fetching customers:", error);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

// POST /api/customers - Create a new customer
router.post("/", async (req, res) => {
  try {
    const { name, phone, email } = req.body;

    if (!name || !String(name).trim() || !phone || !String(phone).trim()) {
      return res.status(400).json({ error: "Name and phone are required" });
    }

    const customer = await Customer.create({
      name: String(name).trim(),
      phone: String(phone).trim(),
      email: email ? String(email).trim() : "",
    });

    res.status(201).json(customer);
  } catch (error) {
    console.error("Error creating customer:", error);

    if (error.code === 11000) {
      return res.status(409).json({ error: "A customer with this phone number already exists" });
    }

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }

    res.status(500).json({ error: "Failed to create customer" });
  }
});

// DELETE /api/customers/:id - Delete a customer (admin only)
router.delete("/:id", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admins can delete customers" });
    }

    const customer = await Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    if (customer.isWalkIn) {
      return res.status(400).json({ error: "The Walk-in Customer record cannot be deleted" });
    }

    await Customer.deleteOne({ _id: customer._id });
    res.json({ message: "Customer deleted", _id: customer._id });
  } catch (error) {
    console.error("Error deleting customer:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }

    res.status(500).json({ error: "Failed to delete customer" });
  }
});

// GET /api/customers/:id - Get a single customer by ID
router.get("/:id", async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    res.json(customer);
  } catch (error) {
    console.error("Error fetching customer:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

// GET /api/customers/phone/:phone - Get customer by phone number
router.get("/phone/:phone", async (req, res) => {
  try {
    const customer = await Customer.findOne({ phone: req.params.phone });
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    res.json(customer);
  } catch (error) {
    console.error("Error fetching customer by phone:", error);
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

// POST /api/customers/:id/recalculate - Recalculate customer statistics
router.post("/:id/recalculate", async (req, res) => {
  try {
    const customerId = req.params.id;
    
    if (!mongoose.isValidObjectId(customerId)) return res.status(400).json({ error: "Invalid customer ID" });
    const [stats = {}] = await Sale.aggregate([
      { $match: {
        customerId: new mongoose.Types.ObjectId(customerId),
        status: { $in: ["completed", "pending", null] },
        type: { $in: ["sale", "reservation"] },
      } },
      { $group: {
        _id: null,
        totalPurchases: { $sum: 1 },
        totalSpent: { $sum: { $ifNull: ["$total", 0] } },
        firstPurchaseDate: { $min: "$createdAt" },
        lastPurchaseDate: { $max: "$createdAt" },
      } },
    ]);

    // Update customer
    const updatedCustomer = await Customer.findByIdAndUpdate(
      customerId,
      {
        totalPurchases: stats.totalPurchases || 0,
        totalSpent: stats.totalSpent || 0,
        firstPurchaseDate: stats.firstPurchaseDate || null,
        lastPurchaseDate: stats.lastPurchaseDate || null,
      },
      { new: true }
    );

    if (!updatedCustomer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    res.json(updatedCustomer);
  } catch (error) {
    console.error("Error recalculating customer stats:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    
    res.status(500).json({ error: "Failed to recalculate customer statistics" });
  }
});

// PUT /api/customers/:id - Update a customer
router.put("/:id", async (req, res) => {
  try {
    const { name, email } = req.body;
    
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    res.json(customer);
  } catch (error) {
    console.error("Error updating customer:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    
    res.status(500).json({ error: "Failed to update customer" });
  }
});

// GET /api/customers/stats/top - Get top customers by spending
router.get("/stats/top", async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const topCustomers = await Customer.find({ isWalkIn: { $ne: true } })
      .sort({ totalSpent: -1 })
      .limit(parseInt(limit));
    
    res.json(topCustomers);
  } catch (error) {
    console.error("Error fetching top customers:", error);
    res.status(500).json({ error: "Failed to fetch top customers" });
  }
});

module.exports = router;
