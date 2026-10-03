const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const User = require("../models/User");
const authMiddleware = require("./auth");
const generateToken = require("../utils/genrateToken");

const USER_ID = "507f1f77bcf86cd799439011";

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

async function runAuth(token, userFields) {
  const originalFindById = User.findById;
  const originalReadyState = mongoose.connection.readyState;
  Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
  User.findById = () => ({
    select: () => Promise.resolve(userFields === null ? null : {
      _id: { toString: () => USER_ID },
      role: "staff",
      isActive: true,
      status: "active",
      ...userFields,
    }),
  });
  const req = { header: () => `Bearer ${token}` };
  const res = fakeRes();
  let nextCalled = false;
  try {
    await authMiddleware(req, res, () => { nextCalled = true; });
  } finally {
    User.findById = originalFindById;
    Object.defineProperty(mongoose.connection, "readyState", { value: originalReadyState, configurable: true });
  }
  return { req, res, nextCalled };
}

test("token revocation: a token issued before a password/role change (old tokenVersion) is 401", async () => {
  const token = generateToken({ _id: USER_ID, tokenVersion: 0 });
  const { res, nextCalled } = await runAuth(token, { tokenVersion: 1 });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("token revocation: a token with the current tokenVersion is accepted", async () => {
  const token = generateToken({ _id: USER_ID, tokenVersion: 2 });
  const { nextCalled } = await runAuth(token, { tokenVersion: 2 });
  assert.equal(nextCalled, true);
});

test("token revocation: legacy tokens without tv still work for legacy users (no forced logout)", async () => {
  const token = jwt.sign({ id: USER_ID }, process.env.JWT_SECRET);
  const { nextCalled } = await runAuth(token, {});
  assert.equal(nextCalled, true);
});

test("a deactivated user's unexpired token is 401", async () => {
  const token = generateToken({ _id: USER_ID });
  const { res } = await runAuth(token, { isActive: false, status: "suspended" });
  assert.equal(res.statusCode, 401);
});

test("the role comes from the database, not from the token payload", async () => {
  const token = jwt.sign({ id: USER_ID, role: "admin" }, process.env.JWT_SECRET);
  const { req } = await runAuth(token, { role: "staff" });
  assert.equal(req.user.role, "staff");
  assert.equal(req.user.isAdmin, false);
});

test("a token signed with another secret, or unsigned, is 401", async () => {
  const forged = jwt.sign({ id: USER_ID }, "attacker-secret");
  const unsigned = jwt.sign({ id: USER_ID }, null, { algorithm: "none" });
  for (const token of [forged, unsigned]) {
    const { res } = await runAuth(token, {});
    assert.equal(res.statusCode, 401);
  }
});

test("an expired token is 401", async () => {
  const expired = jwt.sign(
    { id: USER_ID },
    process.env.JWT_SECRET,
    { expiresIn: -1, algorithm: "HS256" }
  );
  const { res, nextCalled } = await runAuth(expired, {});
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("a token whose id is not an ObjectId is 401 without a database lookup", async () => {
  const token = jwt.sign({ id: { $ne: null } }, process.env.JWT_SECRET);
  const { res } = await runAuth(token, {});
  assert.equal(res.statusCode, 401);
});

test("generateToken: expiry is set and the payload carries only id + tv", () => {
  const token = generateToken({ _id: USER_ID, tokenVersion: 3, role: "admin", password: "x" });
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(decoded.id, USER_ID);
  assert.equal(decoded.tv, 3);
  assert.equal(decoded.role, undefined);
  assert.equal(decoded.password, undefined);
  assert.equal(decoded.exp - decoded.iat, 24 * 60 * 60);
});
