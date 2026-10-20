const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const {
  accessTtlSeconds, signAccessToken, verifyAccessToken, hashToken,
  startSession, rotateSession, endSession, REFRESH_IDLE_MS, SESSION_MAX_MS, ROTATION_GRACE_MS,
} = require("./sessionTokens");

// Minimal in-memory stand-in for the RefreshSession model.
function fakeModel() {
  const rows = [];
  let seq = 0;
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value || (value === null && row[key] == null));
  return {
    rows,
    async create(doc) { const row = { _id: ++seq, rotatedAt: null, revokedAt: null, ...doc }; rows.push(row); return row; },
    async findOne(filter) { return rows.find((row) => matches(row, filter)) || null; },
    async findOneAndUpdate(filter, update) {
      const row = rows.find((r) => matches(r, filter));
      if (!row) return null;
      const before = { ...row };
      Object.assign(row, update.$set);
      return before;
    },
    async updateMany(filter, update) { rows.filter((r) => matches(r, filter)).forEach((r) => Object.assign(r, update.$set)); },
  };
}

const USER = { _id: "507f1f77bcf86cd799439011", tokenVersion: 2, status: "active" };
const deps = (user = USER) => ({ loadUser: async () => user, isUsable: (u) => u.status === "active" });
const T0 = Date.UTC(2026, 9, 20, 8, 0, 0);

test("access token lifetime is 15 minutes and env can only shorten it", () => {
  assert.equal(accessTtlSeconds(undefined), 900);
  assert.equal(accessTtlSeconds("1d"), 900);
  assert.equal(accessTtlSeconds("2h"), 900);
  assert.equal(accessTtlSeconds("15m"), 900);
  assert.equal(accessTtlSeconds("5m"), 300);
  assert.equal(accessTtlSeconds("nonsense"), 900);
});

test("signed access tokens verify and expose their expiry", () => {
  const { token, expiresAt } = signAccessToken(USER, T0);
  const decoded = verifyAccessToken(token);
  assert.equal(decoded.id, USER._id);
  assert.equal(decoded.tv, 2);
  assert.equal(new Date(expiresAt).getTime() - T0, 15 * 60 * 1000);
});

test("only the hash of the refresh token is stored", async () => {
  const Model = fakeModel();
  const token = await startSession(Model, USER, {}, T0);
  assert.match(token, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(Model.rows.length, 1);
  assert.equal(Model.rows[0].tokenHash, hashToken(token));
  assert.ok(!JSON.stringify(Model.rows).includes(token));
});

test("a refresh rotates: new token works, old one is retired", async () => {
  const Model = fakeModel();
  const first = await startSession(Model, USER, {}, T0);
  const { refreshToken: second } = await rotateSession(Model, first, deps(), T0 + 60_000);
  assert.notEqual(second, first);
  const { refreshToken: third } = await rotateSession(Model, second, deps(), T0 + 120_000);
  assert.ok(third);
  assert.equal(new Set(Model.rows.map((r) => r.familyId)).size, 1);
});

test("a retired token presented again within the grace window is told to retry, not revoked", async () => {
  const Model = fakeModel();
  const first = await startSession(Model, USER, {}, T0);
  const { refreshToken: second } = await rotateSession(Model, first, deps(), T0);
  await assert.rejects(rotateSession(Model, first, deps(), T0 + 5_000), { code: "REFRESH_ROTATED" });
  // The newer token is still valid.
  await rotateSession(Model, second, deps(), T0 + 6_000);
});

test("reusing an old refresh token later revokes the whole session", async () => {
  const Model = fakeModel();
  const stolen = await startSession(Model, USER, {}, T0);
  const { refreshToken: current } = await rotateSession(Model, stolen, deps(), T0);
  await assert.rejects(rotateSession(Model, stolen, deps(), T0 + ROTATION_GRACE_MS + 1_000), { code: "REFRESH_REUSED" });
  await assert.rejects(rotateSession(Model, current, deps(), T0 + ROTATION_GRACE_MS + 2_000), { code: "INVALID_REFRESH" });
});

test("a session unused for longer than the idle window cannot be renewed", async () => {
  const Model = fakeModel();
  const token = await startSession(Model, USER, {}, T0);
  await assert.rejects(rotateSession(Model, token, deps(), T0 + REFRESH_IDLE_MS + 1), { code: "SESSION_EXPIRED" });
});

test("renewals never extend a session past its absolute 12-hour limit", async () => {
  const Model = fakeModel();
  let token = await startSession(Model, USER, {}, T0);
  let now = T0;
  while (now + 10 * 60_000 < T0 + SESSION_MAX_MS) {
    now += 10 * 60_000;
    ({ refreshToken: token } = await rotateSession(Model, token, deps(), now));
  }
  await assert.rejects(rotateSession(Model, token, deps(), T0 + SESSION_MAX_MS + 1), { code: "SESSION_EXPIRED" });
});

test("a password reset / role change (tokenVersion bump) or suspension kills refresh", async () => {
  const Model = fakeModel();
  const a = await startSession(Model, USER, {}, T0);
  await assert.rejects(rotateSession(Model, a, deps({ ...USER, tokenVersion: 3 }), T0 + 1_000), { code: "INVALID_REFRESH" });
  const b = await startSession(Model, USER, {}, T0);
  await assert.rejects(rotateSession(Model, b, deps({ ...USER, status: "suspended" }), T0 + 1_000), { code: "INVALID_REFRESH" });
});

test("logout revokes the session and malformed tokens are rejected without a lookup", async () => {
  const Model = fakeModel();
  const token = await startSession(Model, USER, {}, T0);
  assert.equal(await endSession(Model, token, T0), true);
  await assert.rejects(rotateSession(Model, token, deps(), T0 + 1_000), { code: "INVALID_REFRESH" });
  for (const bad of [undefined, "", "short", { $ne: null }, "x".repeat(65)]) {
    await assert.rejects(rotateSession(Model, bad, deps(), T0), { code: "INVALID_REFRESH" });
  }
});
