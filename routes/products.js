const express = require("express");
const router = express.Router();
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");
const isAdmin = require("../middleware/isAdmin");
const requireModulePermission = require("../middleware/requireModulePermission");
const { isValidRegionPair } = require("../utils/regions");
const { hasModuleAccess } = require("../utils/userAccess");
const { isObjectId, toFiniteNumber, cleanString, MAX_MONEY, MAX_QUANTITY } = require("../utils/validate");
const { audit } = require("../utils/audit");

// Reject malformed ids before any database call.
router.param("id", (req, res, next, id) => {
  if (!isObjectId(id)) return res.status(400).json({ error: "Invalid product ID" });
  next();
});

// Cost prices are only for roles that manage products.
function productForUser(product, user) {
  if (!product || hasModuleAccess(user, "products")) return product;
  const plain = typeof product.toObject === "function" ? product.toObject() : { ...product };
  delete plain.unitCost;
  return plain;
}

// Validates the numeric/text fields an admin may send on create/update.
// Returns an error message, or null. Undefined fields are skipped.
function productFieldsError(body) {
  const numeric = {
    stock: { min: 0, max: MAX_QUANTITY },
    minStock: { min: 0, max: MAX_QUANTITY },
    weight: { min: 0, max: MAX_QUANTITY },
    unitCost: { min: 0, max: MAX_MONEY },
  };
  for (const [field, range] of Object.entries(numeric)) {
    if (body[field] === undefined || body[field] === null || body[field] === "") continue;
    if (toFiniteNumber(body[field], range) === null) return `${field} must be a number between ${range.min} and ${range.max}`;
  }
  const text = { name: 200, description: 2000, category: 100, brand: 100, unit: 30 };
  for (const [field, max] of Object.entries(text)) {
    if (body[field] === undefined) continue;
    if (cleanString(body[field], max) === null) return `${field} must be text of at most ${max} characters`;
  }
  if (body.status !== undefined && !["active", "inactive"].includes(body.status)) return "Invalid status";
  return null;
}

// GET /api/products - Get all products with optional filtering
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { search, category, status, region } = req.query;

    // Build filter object
    const filter = {};

    if (search) {
      filter.$text = { $search: String(search).slice(0, 100) };
    }

    if (category) {
      filter.category = category;
    }

    if (status) {
      filter.status = status;
    }

    if (region) {
      filter.regionCode = region;
    }

    const projection = hasModuleAccess(req.user, "products") ? {} : { unitCost: 0 };
    const products = await Product.find(filter, projection).sort({ createdAt: -1 });
    res.json(products);
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// Minimal authenticated operational dataset for the designated offline POS.
// The public catalog remains compatible with existing screens, while offline
// synchronization no longer depends on it or receives cost/internal fields.
router.get("/offline-snapshot", authMiddleware, requireModulePermission("pos"), async (req, res) => {
  try {
    const products = await Product.find({ status: "active" })
      .select("name category region regionCode stock minStock unit status updatedAt")
      .sort({ name: 1 })
      .lean();
    res.set("Cache-Control", "no-store");
    return res.json({ products, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Error building offline product snapshot:", error);
    return res.status(500).json({ error: "Failed to build offline product snapshot" });
  }
});

// GET /api/products/:id - Get a single product by ID
router.get("/:id", authMiddleware, requireModulePermission("products"), async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(productForUser(product, req.user));
  } catch (error) {
    console.error("Error fetching product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    res.status(500).json({ error: "Failed to fetch product" });
  }
});

// POST /api/products - Create a new product
router.post("/", authMiddleware, isAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      category,
      brand,
      stock,
      minStock,
      unit,
      weight,
      unitCost,
      status,
      region,
      regionCode,
    } = req.body;

    // Validate required fields
    if (!name || !category) {
      return res.status(400).json({
        error: "Name and category are required fields",
      });
    }
    const fieldsError = productFieldsError(req.body);
    if (fieldsError) return res.status(400).json({ error: fieldsError });

    if (!region || !regionCode || !isValidRegionPair(region, regionCode)) {
      return res.status(400).json({
        error: "A valid region (Butembo/China) is required",
      });
    }

    const product = new Product({
      name,
      originalName: name,
      description: description || "",
      category,
      brand: brand || "",
      stock: Number(stock) || 0,
      minStock: Number(minStock) || 0,
      unit: unit || "pcs",
      weight: Number(weight) || 0,
      unitCost: Number(unitCost) || 0,
      status: status || "active",
      region,
      regionCode,
    });

    const savedProduct = await product.save();
    await audit(req, "product.created", {
      targetType: "Product",
      targetId: savedProduct._id,
      after: { name: savedProduct.name, stock: savedProduct.stock, unitCost: savedProduct.unitCost, status: savedProduct.status },
    });
    res.status(201).json(savedProduct);
  } catch (error) {
    console.error("Error creating product:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }

    res.status(500).json({ error: "Failed to create product" });
  }
});

// PUT /api/products/:id - Update a product
router.put("/:id", authMiddleware, isAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      category,
      brand,
      stock,
      minStock,
      unit,
      weight,
      unitCost,
      status,
      region,
      regionCode,
    } = req.body;

    const fieldsError = productFieldsError(req.body);
    if (fieldsError) return res.status(400).json({ error: fieldsError });

    const existingProduct = await Product.findById(req.params.id).lean();
    if (!existingProduct) {
      return res.status(404).json({ error: "Product not found" });
    }
    if (name !== undefined && String(name).trim() !== (existingProduct.originalName || existingProduct.name)) {
      return res.status(400).json({ error: "Product names are permanent and cannot be changed or translated" });
    }

    if ((region !== undefined || regionCode !== undefined) &&
        !isValidRegionPair(region, regionCode)) {
      return res.status(400).json({
        error: "A valid region (Butembo/China) is required",
      });
    }

    // Build update object with only provided fields
    const updateData = {};

    if (description !== undefined) updateData.description = description;
    if (category !== undefined) updateData.category = category;
    if (brand !== undefined) updateData.brand = brand;
    if (stock !== undefined) updateData.stock = Number(stock);
    if (minStock !== undefined) updateData.minStock = Number(minStock);
    if (unit !== undefined) updateData.unit = unit;
    if (weight !== undefined) updateData.weight = Number(weight);
    if (unitCost !== undefined) updateData.unitCost = Number(unitCost);
    if (status !== undefined) updateData.status = status;
    if (region !== undefined) updateData.region = region;
    if (regionCode !== undefined) updateData.regionCode = regionCode;

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Direct stock edits bypass sales, so every change is traceable here
    // (before/after), in addition to the other changed fields.
    const before = {};
    const after = {};
    for (const field of Object.keys(updateData)) {
      if (String(existingProduct[field]) !== String(updatedProduct[field])) {
        before[field] = existingProduct[field];
        after[field] = updatedProduct[field];
      }
    }
    if (Object.keys(after).length) {
      await audit(req, "stock" in after ? "product.stock_adjusted" : "product.updated", {
        targetType: "Product",
        targetId: updatedProduct._id,
        before,
        after,
        meta: { name: updatedProduct.name },
      });
    }

    res.json(updatedProduct);
  } catch (error) {
    console.error("Error updating product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }

    res.status(500).json({ error: "Failed to update product" });
  }
});

// DELETE /api/products/:id - Delete a product
router.delete("/:id", authMiddleware, isAdmin, async (req, res) => {
  try {
    const deletedProduct = await Product.findByIdAndDelete(req.params.id);

    if (!deletedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }
    await audit(req, "product.deleted", { targetType: "Product", targetId: deletedProduct._id, before: deletedProduct });

    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("Error deleting product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    res.status(500).json({ error: "Failed to delete product" });
  }
});

module.exports = router;
