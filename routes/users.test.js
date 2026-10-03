const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const usersRouter = require("./users");
const requireRole = require("../middleware/requireRole");

const { isActiveAdmin, wouldRemoveLastActiveAdmin, revokeTokens } = usersRouter._testing;

function withOtherAdmins(count, fn) {
  const original = User.countDocuments;
  User.countDocuments = async () => count;
  return Promise.resolve(fn()).finally(() => { User.countDocuments = original; });
}

test("last-admin guard: the only active admin cannot be removed", async () => {
  const admin = { _id: "a1", role: "admin", status: "active", isActive: true };
  await withOtherAdmins(0, async () => assert.equal(await wouldRemoveLastActiveAdmin(admin), true));
  await withOtherAdmins(1, async () => assert.equal(await wouldRemoveLastActiveAdmin(admin), false));
});

test("last-admin guard: non-admins and inactive admins are never the last admin", async () => {
  await withOtherAdmins(0, async () => {
    assert.equal(await wouldRemoveLastActiveAdmin({ role: "manager", status: "active" }), false);
    assert.equal(await wouldRemoveLastActiveAdmin({ role: "admin", status: "suspended", isActive: false }), false);
  });
  assert.equal(isActiveAdmin({ role: "admin", status: "pending" }), false);
});

test("revokeTokens increments tokenVersion (legacy users start at 0)", () => {
  const user = {};
  revokeTokens(user);
  assert.equal(user.tokenVersion, 1);
  revokeTokens(user);
  assert.equal(user.tokenVersion, 2);
});

test("requireRole: staff calling an admin-only endpoint gets 403; no user gets 401", () => {
  const gate = requireRole("admin");
  const run = (user) => {
    const res = { statusCode: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = () => res;
    let nextCalled = false;
    gate({ user }, res, () => { nextCalled = true; });
    return { status: res.statusCode, nextCalled };
  };
  assert.equal(run({ role: "staff" }).status, 403);
  assert.equal(run(undefined).status, 401);
  assert.equal(run({ role: "admin" }).nextCalled, true);
});

function routeHandler(method, path) {
  const layer = usersRouter.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

const ADMIN_ID = "507f1f77bcf86cd799439011";
const OTHER_ID = "507f1f77bcf86cd799439012";
const adminUser = { _id: { toString: () => ADMIN_ID }, role: "admin", username: "boss" };

test("users: nobody can change their own role", async () => {
  const res = fakeRes();
  await routeHandler("put", "/:userId/role")({ params: { userId: ADMIN_ID }, body: { role: "staff" }, user: adminUser }, res);
  assert.equal(res.statusCode, 400);
});

test("users: approve cannot be used on yourself or on an already active account", async () => {
  const self = fakeRes();
  await routeHandler("patch", "/:userId/approve")({ params: { userId: ADMIN_ID }, body: { role: "admin" }, user: adminUser }, self);
  assert.equal(self.statusCode, 400);

  const original = User.findById;
  User.findById = async () => ({ _id: "x", role: "staff", status: "active" });
  try {
    const active = fakeRes();
    await routeHandler("patch", "/:userId/approve")(
      { params: { userId: OTHER_ID }, body: { role: "admin" }, user: adminUser }, active);
    assert.equal(active.statusCode, 400);
  } finally {
    User.findById = original;
  }
});

test("users: demoting the last active admin is refused", async () => {
  const original = User.findById;
  const originalCount = User.countDocuments;
  User.findById = async () => ({ _id: "x", role: "admin", status: "active", isActive: true });
  User.countDocuments = async () => 0;
  try {
    const res = fakeRes();
    await routeHandler("put", "/:userId/role")(
      { params: { userId: OTHER_ID }, body: { role: "staff" }, user: adminUser }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /last active administrator/);
  } finally {
    User.findById = original;
    User.countDocuments = originalCount;
  }
});

test("users: a role change revokes the target's existing tokens and is audited", async () => {
  const original = User.findById;
  const originalCreate = AuditLog.create;
  const audited = [];
  AuditLog.create = async (doc) => { audited.push(doc); return doc; };
  const target = {
    _id: OTHER_ID, role: "staff", status: "active", isActive: true, tokenVersion: 0, history: [],
    save: async () => {},
  };
  User.findById = (id) => (id === OTHER_ID && !User.findById.called
    ? (User.findById.called = true, Promise.resolve(target))
    : { select: async () => ({ id: OTHER_ID, role: target.role }) });
  try {
    const res = fakeRes();
    await routeHandler("put", "/:userId/role")(
      { params: { userId: OTHER_ID }, body: { role: "manager" }, user: adminUser, ip: "1.1.1.1" }, res);
    assert.equal(res.statusCode, null);
    assert.equal(target.role, "manager");
    assert.equal(target.tokenVersion, 1);
    assert.equal(audited[0].action, "user.role_changed");
    assert.deepEqual(audited[0].after, { role: "manager" });
  } finally {
    User.findById = original;
    AuditLog.create = originalCreate;
  }
});

test("users: new passwords must meet the 8-character policy", async () => {
  const res = fakeRes();
  await routeHandler("put", "/:userId/password")(
    { params: { userId: OTHER_ID }, body: { newPassword: "short" }, user: adminUser }, res);
  assert.equal(res.statusCode, 400);
});

test("users: User JSON never exposes password or tokenVersion", () => {
  const user = new User({ username: "u", email: "u@shop.cd", password: "$2a$hash", tokenVersion: 4 });
  const json = user.toJSON();
  assert.equal(json.password, undefined);
  assert.equal(json.tokenVersion, undefined);
});
