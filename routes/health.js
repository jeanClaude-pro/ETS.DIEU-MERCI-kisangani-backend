const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

// Public, unauthenticated, cheap. This is the "genuinely unavailable" probe
// the PWA polls instead of trusting navigator.onLine alone — a device can
// have Wi-Fi while the API process or MongoDB itself is unreachable.
router.get("/", async (req, res) => {
  const readyState = mongoose.connection.readyState;
  const database = readyState === 1 ? "ready" : readyState === 2 ? "connecting" : "unavailable";
  res.set("Cache-Control", "no-store");
  if (database !== "ready") {
    return res.status(503).json({ ok: false, api: "ready", database, checkedAt: new Date().toISOString() });
  }
  try {
    // readyState alone may remain connected briefly after a database outage.
    // A bounded ping proves the dependency required to commit a sale works.
    await mongoose.connection.db.command({ ping: 1 }, { maxTimeMS: 1500 });
    return res.status(200).json({ ok: true, api: "ready", database, checkedAt: new Date().toISOString() });
  } catch (error) {
    console.warn("Health database ping failed:", error.message);
    return res.status(503).json({ ok: false, api: "ready", database: "unavailable", checkedAt: new Date().toISOString() });
  }
});

module.exports = router;
