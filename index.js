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

// ====== DB + Server Startup ======
mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log("✅ Connected to MongoDB Atlas");
    await backfillProductRegions();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });