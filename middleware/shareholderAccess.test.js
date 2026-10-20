const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const User = require("../models/User");
const authMiddleware = require("./auth");
const generateToken = require("../utils/genrateToken");
const { currentRegionScope } = require("../utils/regionScope");
const { getEffectiveModules } = require("../utils/userAccess");

const USER_ID = "507f1f77bcf86cd799439011";

async function call({ method = "GET", url = "/api/sales", user }) {
  const originalFindById = User.findById;
  Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
  User.findById = () => ({ select: () => Promise.resolve({
    _id: { toString: () => USER_ID }, isActive: true, status: "active", tokenVersion: 0, ...user,
  }) });
  const token = generateToken({ _id: USER_ID, tokenVersion: 0 });
  const req = { method, originalUrl: url, header: () => `Bearer ${token}` };
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  let scopeSeen;
  let nextCalled = false;
  try {
    await authMiddleware(req, res, () => { nextCalled = true; scopeSeen = currentRegionScope(); });
  } finally {
    User.findById = originalFindById;
  }
  return { res, nextCalled, scopeSeen, req };
}

test("a shareholder can read but every write is refused", async () => {
  const shareholder = { role: "shareholder", regionScope: "Bbbb" };
  const read = await call({ user: shareholder });
  assert.equal(read.nextCalled, true);
  assert.equal(read.scopeSeen, "Bbbb");
  for (const [method, url] of [["POST", "/api/sales"], ["PATCH", "/api/expenses/abc/validate"], ["PUT", "/api/entries/abc"], ["DELETE", "/api/sales/abc"], ["PATCH", "/api/sales/abc/void"]]) {
    const write = await call({ method, url, user: shareholder });
    assert.equal(write.nextCalled, false, `${method} ${url}`);
    assert.equal(write.res.statusCode, 403);
    assert.match(write.res.body.message, /consultation uniquement/);
  }
  // Changing their own password stays possible.
  assert.equal((await call({ method: "PUT", url: "/api/users/me/password", user: shareholder })).nextCalled, true);
});

test("other roles keep writing, inside their own region scope", async () => {
  const cashier = await call({ method: "POST", user: { role: "cashier_supervisor", regionScope: "Cnnn" } });
  assert.equal(cashier.nextCalled, true);
  assert.equal(cashier.scopeSeen, "Cnnn");
  const admin = await call({ method: "POST", user: { role: "admin", regionScope: "Cnnn" } });
  assert.equal(admin.scopeSeen, null);
});

test("a shareholder can never be given an operational module", () => {
  assert.deepEqual(
    getEffectiveModules({ role: "shareholder", modulePermissions: ["sales", "pos", "entry", "management", "reports"] }),
    ["sales", "reports"],
  );
  assert.deepEqual(getEffectiveModules({ role: "shareholder" }),
    ["dashboard", "products", "sales", "entryhistory", "sortiehistory", "reports"]);
});
