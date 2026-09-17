const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isAccountUsable,
  getEffectiveModules,
  sanitizeRegistrationInput,
  MODULE_IDS,
} = require("./userAccess");

test("isAccountUsable: active users (explicit or legacy default) pass", () => {
  assert.equal(isAccountUsable({ isActive: true, status: "active" }), true);
  // Legacy doc created before `status` existed: Mongoose hydrates status as
  // "active" by schema default, isActive keeps its real stored value.
  assert.equal(isAccountUsable({ isActive: true, status: "active" }), true);
});

test("isAccountUsable: legacy suspended users (isActive:false, no real status) stay blocked", () => {
  assert.equal(isAccountUsable({ isActive: false, status: "active" }), false);
});

test("isAccountUsable: pending and rejected are blocked even if isActive is true", () => {
  assert.equal(isAccountUsable({ isActive: true, status: "pending" }), false);
  assert.equal(isAccountUsable({ isActive: true, status: "rejected" }), false);
});

test("isAccountUsable: suspended is blocked", () => {
  assert.equal(isAccountUsable({ isActive: false, status: "suspended" }), false);
});

test("getEffectiveModules: admin always gets every module regardless of stored permissions", () => {
  assert.deepEqual(getEffectiveModules({ role: "admin", modulePermissions: ["pos"] }), MODULE_IDS);
  assert.deepEqual(getEffectiveModules({ role: "admin" }), MODULE_IDS);
});

test("getEffectiveModules: unset modulePermissions falls back to the role default", () => {
  const staffModules = getEffectiveModules({ role: "staff" });
  assert.ok(staffModules.includes("sales"));
  assert.ok(!staffModules.includes("management"));
});

test("getEffectiveModules: an explicit (even empty) array overrides the role default", () => {
  assert.deepEqual(getEffectiveModules({ role: "staff", modulePermissions: ["pos"] }), ["pos"]);
  assert.deepEqual(getEffectiveModules({ role: "staff", modulePermissions: [] }), []);
});

test("sanitizeRegistrationInput: strips role/status/isActive/modulePermissions from client input", () => {
  const result = sanitizeRegistrationInput({
    username: "bob",
    email: "bob@example.com",
    password: "secret123",
    role: "admin",
    status: "active",
    isActive: true,
    modulePermissions: ["management"],
  });
  assert.deepEqual(result, { username: "bob", email: "bob@example.com", password: "secret123" });
});

test("module id registry has the expected known ids (drift guard)", () => {
  const expected = [
    "dashboard", "rate", "pos", "reservation", "entry", "sortie", "products",
    "sales", "reservations", "entryhistory", "sortiehistory", "reports",
    "customers", "management",
  ];
  assert.deepEqual([...MODULE_IDS].sort(), [...expected].sort());
});
