const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth");
const requireModulePermission = require("../middleware/requireModulePermission");

const Category = require("../models/Category");
const { cleanCategoryName, normalizeCategoryName } = require("../utils/defaultCategories");

// Create a new category
router.post("/", authMiddleware, requireModulePermission("products"), async (req, res) => {
  try {
    const requested = (Array.isArray(req.body) ? req.body : [req.body]).map((category) => ({
      name: cleanCategoryName(category?.name),
      description: String(category?.description ?? "").trim(),
    }));
    if (requested.some((category) => !category.name)) {
      return res.status(400).json({ message: "Category name is required" });
    }

    const existing = await Category.find({}).select("name").lean();
    const knownKeys = new Set(existing.map((category) => normalizeCategoryName(category.name)));
    const uniqueRequested = [];
    for (const category of requested) {
      const key = normalizeCategoryName(category.name);
      if (!knownKeys.has(key)) {
        knownKeys.add(key);
        uniqueRequested.push(category);
      }
    }

    const created = uniqueRequested.length
      ? await Category.insertMany(uniqueRequested, { ordered: false })
      : [];
    res.status(created.length ? 201 : 200).json(Array.isArray(req.body) ? created : created[0] ?? null);
  } catch (error) {
    console.error("Error creating category:", error);
    if (error?.code === 11000) {
      return res.status(409).json({ message: "Category already exists" });
    }
    res.status(500).json({ message: "Internal server error" });
  }
});

// Get all categories
router.get("/", authMiddleware, async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 }).collation({ locale: "fr", strength: 1 });
    res.status(200).json(categories);
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
