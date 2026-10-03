require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rejectMongoOperators = require("./middleware/rejectMongoOperators");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Env variables
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

// ====== Secret checks (fail fast, never print the values) ======
const MIN_JWT_SECRET_LENGTH = 32;
if (!MONGO_URI) {
  console.error("❌ MONGO_URI is not set. Refusing to start.");
  process.exit(1);
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
  const message = `JWT_SECRET must be set and at least ${MIN_JWT_SECRET_LENGTH} characters long.`;
  if (IS_PRODUCTION) {
    console.error(`❌ ${message} Refusing to start.`);
    process.exit(1);
  }
  console.warn(`⚠️ ${message} (allowed outside production only)`);
}

const app = express();
const printRoutes = require('./routes/print');

// Real client IP behind the hosting proxy (Render: one hop). Needed for the
// login rate limiter; never `true`, which would trust spoofed headers.
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY ?? (IS_PRODUCTION ? "1" : "0"), 10);
app.set("trust proxy", Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 0);
// Express 5 default, set explicitly: query strings never become objects
// (`?a[$ne]=x` stays a plain string key).
app.set("query parser", "simple");
app.disable("x-powered-by");

// Security headers. The API only serves JSON, so the strict default CSP is
// fine here; the frontend's own headers live in client/netlify.toml.
app.use(helmet({
  crossOriginResourcePolicy: { policy: "same-site" },
}));

// CORS: only the configured frontend origin(s), plus local dev servers
// outside production. Requests without an Origin (curl, health checks,
// server-to-server) are not browser cross-origin requests and pass through.
const DEV_ORIGINS = ["http://localhost:5173", "http://localhost:4173", "http://127.0.0.1:5173", "http://127.0.0.1:4173"];
const allowedOrigins = new Set([
  ...String(process.env.CLIENT_URL || "").split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean),
  ...(IS_PRODUCTION ? [] : DEV_ORIGINS),
]);
if (IS_PRODUCTION && allowedOrigins.size === 0) {
  console.warn("⚠️ CLIENT_URL is not set: browsers on other origins will be refused by CORS.");
}
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600,
}));

// Middleware
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(rejectMongoOperators);
// Request log without query strings (searches may contain phone numbers).
morgan.token("path-only", (req) => (req.originalUrl || req.url || "").split("?")[0]);
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :path-only HTTP/:http-version" :status :res[content-length] ":user-agent"'));

// ====== Use Routes ======
app.use("/api/health", require("./routes/health"));
app.use("/api/products", require("./routes/products"));
app.use("/api/sales", require("./routes/sales"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/categories", require("./routes/categories"));
app.use('/api/print', printRoutes);
app.use("/api/expenses", require("./routes/expenses")); // ✅ Added expense routes
app.use("/api/exchange-rates", require("./routes/exchangeRates"));
app.use("/api/entries", require("./routes/entries"));
app.use("/api/audit-logs", require("./routes/auditLogs"));
// Default route
app.get("/", (req, res) => {
  res.send("ERP/POS System Backend is running...");
});

// Must stay last: JSON 404 + error responses without stack traces.
app.use(notFoundHandler);
app.use(errorHandler);

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
    {
      name: "populateDefaultCategories",
      run: async () => {
        const result = await require("./utils/defaultCategories").populateDefaultCategories();
        console.log(`Categories ready: ${result.added.length} added, ${result.totalCount} total`);
      },
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
