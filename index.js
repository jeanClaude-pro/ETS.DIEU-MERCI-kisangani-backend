require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");

const app = express();
const printRoutes = require('./routes/print');

// Middleware
app.use(express.json());
app.use(morgan("combined"));

// ✅ Allow both local dev + Netlify frontend
app.use(cors());

// Env variables
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

// ====== Use Routes ======
app.use("/api/products", require("./routes/products"));
app.use("/api/sales", require("./routes/sales"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/categories", require("./routes/categories"));
app.use('/api/print', printRoutes);
app.use("/api/expenses", require("./routes/expenses")); // ✅ Added expense routes
app.use("/api/exchange-rates", require("./routes/exchangeRates"));
app.use("/api/entries", require("./routes/entries"));
// Default route
app.get("/", (req, res) => {
  res.send("ERP/POS System Backend is running...");
});

// ====== One-time backfill: legacy products predate the region field ======
// All pre-existing products are known to have shipped from China, so this
// assigns them automatically instead of blocking sales behind a manual prompt.
async function backfillProductRegions() {
  const Product = require("./models/Product");
  const { modifiedCount } = await Product.updateMany(
    { region: { $exists: false } },
    { $set: { region: "China", regionCode: "Cnnn" } }
  );
  if (modifiedCount) {
    console.log(`🌍 Backfilled region for ${modifiedCount} legacy product(s) -> China`);
  }
}

async function repairSaleItemSnapshots() {
  const Product = require("./models/Product");
  const Sale = require("./models/Sale");
  const { canonicalProductName, calculateLineTotal } = require("./utils/saleIntegrity");

  await Product.updateMany(
    { $or: [{ originalName: { $exists: false } }, { originalName: "" }] },
    [{ $set: { originalName: "$name" } }]
  );
  const products = await Product.find({}).select("name originalName region regionCode").lean();
  const productsById = new Map(products.map((product) => [String(product._id), product]));
  const sales = await Sale.find({
    type: { $in: ["sale", "reservation"] },
    "items.0": { $exists: true },
  });
  let repaired = 0;
  for (const sale of sales) {
    let changed = false;
    for (const item of sale.items) {
      if (!item.productId) continue;
      const product = productsById.get(String(item.productId));
      if (!product?.region || !product?.regionCode) continue;
      const name = canonicalProductName(product);
      const total = calculateLineTotal(item);
      if (item.name !== name || item.region !== product.region ||
          item.regionCode !== product.regionCode || item.total !== total) {
        item.name = name;
        item.region = product.region;
        item.regionCode = product.regionCode;
        item.total = total;
        changed = true;
      }
    }
    const total = sale.items.reduce((sum, item) => sum + calculateLineTotal(item), 0);
    if (sale.subtotal !== total || sale.total !== total) {
      sale.subtotal = total;
      sale.total = total;
      changed = true;
    }
    if (changed) {
      // Direct repair avoids blocking startup on unrelated incomplete legacy rows.
      await Sale.updateOne(
        { _id: sale._id },
        { $set: { items: sale.items, subtotal: sale.subtotal, total: sale.total } }
      );
      repaired += 1;
    }
  }
  if (repaired) console.log(`Repaired canonical names, regions, and totals for ${repaired} sale(s)`);
}

// ====== DB + Server Startup ======
mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log("✅ Connected to MongoDB Atlas");
    await backfillProductRegions();
    await repairSaleItemSnapshots();
    const { ensureWalkInCustomer } = require("./utils/walkInCustomer");
    await ensureWalkInCustomer();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });
