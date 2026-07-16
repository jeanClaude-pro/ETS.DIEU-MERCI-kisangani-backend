const mongoose = require("mongoose");
const { isValidRegionPair } = require("../utils/regions");

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
    },
    originalName: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
    },
    description: {
      type: String,
      default: "",
    },

    category: {
      type: String,
      required: true,
    },
    region: {
      type: String,
      enum: ["Butembo", "China"],
      required: true,
    },
    regionCode: {
      type: String,
      enum: ["Bbbb", "Cnnn"],
      required: true,
    },
    brand: {
      type: String,
      default: "",
    },
    stock: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    minStock: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    unit: {
      type: String,
      required: true,
      default: "pcs",
    },
    weight: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  {
    timestamps: true,
  }
);

productSchema.pre("validate", function (next) {
  if (this.isNew && !this.originalName) this.originalName = this.name;
  if (this.region && this.regionCode && !isValidRegionPair(this.region, this.regionCode)) {
    return next(new Error(`regionCode "${this.regionCode}" does not match region "${this.region}"`));
  }
  next();
});

// Create index for better search performance
productSchema.index({ name: "text", description: "text", brand: "text" });
productSchema.index({ category: 1 });
productSchema.index({ status: 1 });
productSchema.index({ region: 1 });

// Reuse if it already exists (prevents OverwriteModelError)
const Product =
  mongoose.models.Product || mongoose.model("Product", productSchema);

module.exports = Product;
