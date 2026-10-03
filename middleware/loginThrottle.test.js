const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const LoginAttempt = require("../models/LoginAttempt");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const throttle = require("./loginThrottle");
const authRouter = require("../routes/auth");

// In-memory stand-in for the LoginAttempt collection, implementing exactly
// the query shapes loginThrottle uses.
function installFakeStore() {
  const docs = new Map();
  const originals = {};
  for (const name of ["find", "updateOne", "findOneAndUpdate", "deleteOne", "deleteMany"]) {
    originals[name] = LoginAttempt[name];
  }
  const time = (value) => (value ? new Date(value).getTime() : null);

  LoginAttempt.find = (filter) => ({
    lean: async () => filter.key.$in.map((key) => docs.get(key)).filter(Boolean).map((doc) => ({ ...doc })),
  });
  LoginAttempt.updateOne = async (filter, update) => {
    const doc = docs.get(filter.key);
    if (!doc) return { modifiedCount: 0 };
    if (filter.windowStart) {
      const windowOk = time(doc.windowStart) < time(filter.windowStart.$lt);
      const lockOk = doc.lockedUntil === null || time(doc.lockedUntil) <= time(filter.$or[1].lockedUntil.$lte);
      if (!windowOk || !lockOk) return { modifiedCount: 0 };
    }
    Object.assign(doc, update.$set);
    return { modifiedCount: 1 };
  };
  LoginAttempt.findOneAndUpdate = async (filter, update, options = {}) => {
    let doc = docs.get(filter.key);
    if (!doc) {
      if (!options.upsert) return null;
      doc = { key: filter.key, count: 0, ...update.$setOnInsert };
      docs.set(filter.key, doc);
    }
    doc.count += update.$inc.count;
    const max = update.$max.expiresAt;
    if (!doc.expiresAt || time(max) > time(doc.expiresAt)) doc.expiresAt = max;
    return { ...doc };
  };
  LoginAttempt.deleteOne = async (filter) => ({ deletedCount: docs.delete(filter.key) ? 1 : 0 });
  LoginAttempt.deleteMany = async (filter) => {
    const pattern = new RegExp(filter.key.$regex);
    let deletedCount = 0;
    for (const key of [...docs.keys()]) {
      if (pattern.test(key)) { docs.delete(key); deletedCount += 1; }
    }
    return { deletedCount };
  };
  return {
    docs,
    restore() { Object.assign(LoginAttempt, originals); },
  };
}

test("loginThrottle: the 5th failure within a minute locks that IP+email pair", async () => {
  const store = installFakeStore();
  try {
    const now = Date.now();
    for (let i = 0; i < 4; i += 1) {
      const result = await throttle.recordFailure("1.1.1.1", "a@shop.cd", now + i);
      assert.equal(result.accountLocked, false);
    }
    assert.equal(await throttle.isBlocked("1.1.1.1", "a@shop.cd", now + 10), false);
    const fifth = await throttle.recordFailure("1.1.1.1", "a@shop.cd", now + 5);
    assert.equal(fifth.accountLocked, true);
    assert.equal(await throttle.isBlocked("1.1.1.1", "a@shop.cd", now + 10), true);
    // Still locked well after the 1-minute window: the lock lasts 2 hours.
    assert.equal(await throttle.isBlocked("1.1.1.1", "a@shop.cd", now + 60 * 60 * 1000), true);
    assert.equal(await throttle.isBlocked("1.1.1.1", "a@shop.cd", now + 2 * 60 * 60 * 1000 + 1000), false);
  } finally {
    store.restore();
  }
});

test("loginThrottle: one locked account does not block another account on the same shop IP", async () => {
  const store = installFakeStore();
  try {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) await throttle.recordFailure("9.9.9.9", "victim@shop.cd", now);
    assert.equal(await throttle.isBlocked("9.9.9.9", "victim@shop.cd", now), true);
    assert.equal(await throttle.isBlocked("9.9.9.9", "cashier@shop.cd", now), false);
  } finally {
    store.restore();
  }
});

test("loginThrottle: failures spread over more than a minute do not lock the account", async () => {
  const store = installFakeStore();
  try {
    const start = Date.now();
    for (let i = 0; i < 6; i += 1) {
      await throttle.recordFailure("2.2.2.2", "slow@shop.cd", start + i * 61 * 1000);
    }
    assert.equal(await throttle.isBlocked("2.2.2.2", "slow@shop.cd", start + 6 * 61 * 1000), false);
  } finally {
    store.restore();
  }
});

test("loginThrottle: many different emails from one IP hit the looser per-IP limit", async () => {
  const store = installFakeStore();
  try {
    const now = Date.now();
    let ipLocked = false;
    for (let i = 0; i < throttle.IP_LIMIT.max; i += 1) {
      ({ ipLocked } = await throttle.recordFailure("3.3.3.3", `user${i}@shop.cd`, now));
    }
    assert.equal(ipLocked, true);
    assert.equal(await throttle.isBlocked("3.3.3.3", "fresh@shop.cd", now), true);
  } finally {
    store.restore();
  }
});

test("loginThrottle: success resets the account counter; admin unlock clears a lock", async () => {
  const store = installFakeStore();
  try {
    const now = Date.now();
    for (let i = 0; i < 4; i += 1) await throttle.recordFailure("4.4.4.4", "b@shop.cd", now);
    await throttle.recordSuccess("4.4.4.4", "b@shop.cd");
    const afterReset = await throttle.recordFailure("4.4.4.4", "b@shop.cd", now);
    assert.equal(afterReset.accountLocked, false);

    for (let i = 0; i < 5; i += 1) await throttle.recordFailure("5.5.5.5", "c@shop.cd", now);
    assert.equal(await throttle.isBlocked("5.5.5.5", "c@shop.cd", now), true);
    assert.equal(await throttle.unlockEmail("C@shop.cd"), 1);
    assert.equal(await throttle.isBlocked("5.5.5.5", "c@shop.cd", now), false);
  } finally {
    store.restore();
  }
});

// ---- POST /api/auth/login, end to end with stubbed models ----

function loginHandler() {
  const layer = authRouter.stack.find((entry) => entry.route?.path === "/login");
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.set = res.setHeader;
  return res;
}

async function login(email, password, ip = "7.7.7.7") {
  const res = fakeRes();
  await loginHandler()({ body: { email, password }, ip }, res);
  return res;
}

test("login: unknown email and wrong password return the same status and message", async () => {
  const store = installFakeStore();
  const originalFindOne = User.findOne;
  const originalCreate = AuditLog.create;
  AuditLog.create = async () => ({});
  const hash = await bcrypt.hash("correct-password", 4);
  User.findOne = async ({ email }) => (email === "known@shop.cd"
    ? { _id: "507f1f77bcf86cd799439011", email, password: hash, role: "staff", status: "active", isActive: true }
    : null);
  try {
    const unknown = await login("nobody@shop.cd", "whatever-pass");
    const wrong = await login("known@shop.cd", "wrong-password");
    assert.equal(unknown.statusCode, wrong.statusCode);
    assert.deepEqual(unknown.body, wrong.body);
  } finally {
    User.findOne = originalFindOne;
    AuditLog.create = originalCreate;
    store.restore();
  }
});

test("login: repeated failures end in a generic 429 that reveals no lockout duration", async () => {
  const store = installFakeStore();
  const originalFindOne = User.findOne;
  const originalCreate = AuditLog.create;
  const auditActions = [];
  AuditLog.create = async (doc) => { auditActions.push(doc.action); return doc; };
  User.findOne = async () => null;
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await login("target@shop.cd", "guess-number-" + i);
      assert.equal(res.statusCode, 400);
    }
    const blocked = await login("target@shop.cd", "another-guess");
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.body.message, throttle.TOO_MANY_ATTEMPTS_MESSAGE);
    assert.doesNotMatch(JSON.stringify(blocked.body), /\d+\s*(h|min|heure|minute)/i);
    for (const header of Object.keys(blocked.headers)) {
      assert.doesNotMatch(header, /retry-after|ratelimit/i);
    }
    assert.ok(auditActions.includes("auth.login_failed"));
    assert.ok(auditActions.includes("auth.login_locked"));

    // A different account on the same IP can still log in attempts.
    const other = await login("other@shop.cd", "some-password");
    assert.equal(other.statusCode, 400);
  } finally {
    User.findOne = originalFindOne;
    AuditLog.create = originalCreate;
    store.restore();
  }
});

test("login: operator-shaped credentials are refused before any lookup", async () => {
  const originalFindOne = User.findOne;
  let lookedUp = false;
  User.findOne = async () => { lookedUp = true; return null; };
  try {
    const res = await login({ $ne: null }, { $ne: null });
    assert.equal(res.statusCode, 400);
    assert.equal(lookedUp, false);
  } finally {
    User.findOne = originalFindOne;
  }
});
