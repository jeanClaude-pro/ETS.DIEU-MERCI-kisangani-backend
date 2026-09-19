const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const User = require("../models/User");
const authMiddleware = require("./auth");

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET);
}

// mongoose.connection.readyState is a plain property on the shared singleton
// connection; tests restore it afterward so they never leak into other files.
function withReadyState(state, fn) {
  const original = mongoose.connection.readyState;
  Object.defineProperty(mongoose.connection, "readyState", { value: state, configurable: true });
  return Promise.resolve(fn()).finally(() => {
    Object.defineProperty(mongoose.connection, "readyState", { value: original, configurable: true });
  });
}

test("authMiddleware: a database outage (readyState not connected) is 503, never 401", async () => {
  const token = signToken({ id: "507f1f77bcf86cd799439011" });
  const req = { header: () => `Bearer ${token}` };
  const res = fakeRes();
  let nextCalled = false;

  await withReadyState(0, () => authMiddleware(req, res, () => { nextCalled = true; }));

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "SERVICE_UNAVAILABLE");
});

test("authMiddleware: a Mongo connection error during the user lookup is 503, never 401", async () => {
  const token = signToken({ id: "507f1f77bcf86cd799439011" });
  const req = { header: () => `Bearer ${token}` };
  const res = fakeRes();

  const originalFindById = User.findById;
  User.findById = () => ({
    select: () => Promise.reject(Object.assign(new Error("connection timed out"), { name: "MongoNetworkError" })),
  });

  try {
    await withReadyState(1, () => authMiddleware(req, res, () => {}));
  } finally {
    User.findById = originalFindById;
  }

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "SERVICE_UNAVAILABLE");
});

test("authMiddleware: a genuinely invalid token is still 401", async () => {
  const req = { header: () => "Bearer not-a-real-token" };
  const res = fakeRes();

  await withReadyState(1, () => authMiddleware(req, res, () => {}));

  assert.equal(res.statusCode, 401);
});

test("authMiddleware: a missing Authorization header is still 401", async () => {
  const req = { header: () => undefined };
  const res = fakeRes();

  await withReadyState(1, () => authMiddleware(req, res, () => {}));

  assert.equal(res.statusCode, 401);
});

test("authMiddleware: user not found (DB reachable, id just doesn't exist) is still 401", async () => {
  const token = signToken({ id: "507f1f77bcf86cd799439011" });
  const req = { header: () => `Bearer ${token}` };
  const res = fakeRes();

  const originalFindById = User.findById;
  User.findById = () => ({ select: () => Promise.resolve(null) });

  try {
    await withReadyState(1, () => authMiddleware(req, res, () => {}));
  } finally {
    User.findById = originalFindById;
  }

  assert.equal(res.statusCode, 401);
});

test("authMiddleware: a usable user with a valid token and a healthy DB reaches next()", async () => {
  const token = signToken({ id: "507f1f77bcf86cd799439011" });
  const req = { header: () => `Bearer ${token}` };
  const res = fakeRes();
  let nextCalled = false;

  const originalFindById = User.findById;
  User.findById = () => ({
    select: () => Promise.resolve({
      _id: { toString: () => "507f1f77bcf86cd799439011" },
      role: "staff",
      isActive: true,
      status: "active",
    }),
  });

  try {
    await withReadyState(1, () => authMiddleware(req, res, () => { nextCalled = true; }));
  } finally {
    User.findById = originalFindById;
  }

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.equal(req.user.id, "507f1f77bcf86cd799439011");
});

test("authMiddleware: a suspended user (DB reachable) is 401, not 503", async () => {
  const token = signToken({ id: "507f1f77bcf86cd799439011" });
  const req = { header: () => `Bearer ${token}` };
  const res = fakeRes();

  const originalFindById = User.findById;
  User.findById = () => ({
    select: () => Promise.resolve({
      _id: { toString: () => "507f1f77bcf86cd799439011" },
      role: "staff",
      isActive: false,
      status: "suspended",
    }),
  });

  try {
    await withReadyState(1, () => authMiddleware(req, res, () => {}));
  } finally {
    User.findById = originalFindById;
  }

  assert.equal(res.statusCode, 401);
});
