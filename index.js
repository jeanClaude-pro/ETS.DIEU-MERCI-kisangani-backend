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
      const total = calculateLineTotal(item);
      if (!item.name) { item.name = canonicalProductName(product); changed = true; }
      if (!item.region) { item.region = product.region; changed = true; }
      if (!item.regionCode) { item.regionCode = product.regionCode; changed = true; }
      if (!Number.isFinite(item.total)) { item.total = total; changed = true; }
      if (!Number.isFinite(item.subtotal)) { item.subtotal = total; changed = true; }
    }
    if (changed) {
      // Direct repair avoids blocking startup on unrelated incomplete legacy rows.
      await Sale.updateOne(
        { _id: sale._id },
        { $set: { items: sale.items } }
      );
      repaired += 1;
    }
  }
  if (repaired) console.log(`Repaired canonical names, regions, and totals for ${repaired} sale(s)`);
}

// ====== Maintenance tasks (run after listen, never block or crash startup) ======
// Each task is isolated: a failure in one is logged but does not stop the
// others or affect the already-open server port.
async function runMaintenanceTasks() {
  const tasks = [
    { name: "backfillProductRegions", run: backfillProductRegions },
    { name: "repairSaleItemSnapshots", run: repairSaleItemSnapshots },
    {
      name: "ensureWalkInCustomer",
      run: () => require("./utils/walkInCustomer").ensureWalkInCustomer(),
    },
  ];
  for (const task of tasks) {
    try {
      await task.run();
    } catch (err) {
      console.error(`⚠️ Maintenance task "${task.name}" failed:`, err.message);
    }
  }
}

// ====== DB + Server Startup ======
// Render (and similar PaaS platforms) detect a live deployment by scanning
// for an open port shortly after boot. app.listen() must therefore run as
// soon as MongoDB is connected, binding to 0.0.0.0 so it's reachable from
// outside the container. Maintenance/migration tasks run afterward in the
// background so they can never delay or block port binding.
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB Atlas");
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
      runMaintenanceTasks();
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

// ====== Process-level safety nets ======
// Log unexpected async failures instead of letting them crash the process
// and take down an already-bound port.
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught exception:", err);
});
