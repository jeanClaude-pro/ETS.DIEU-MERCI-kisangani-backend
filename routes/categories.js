const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth");
const requireModulePermission = require("../middleware/requireModulePermission");

const Category = require("../models/Category");

// Create a new category
router.post("/", authMiddleware, requireModulePermission("products"), async (req, res) => {
  try {
    const newCategories = await Category.create(req.body);
    res.status(201).json(newCategories);
  } catch (error) {
    console.error("Error creating category:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Get all categories
router.get("/", authMiddleware, async (req, res) => {
  try {
    const categories = await Category.find();
    res.status(200).json(categories);
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
