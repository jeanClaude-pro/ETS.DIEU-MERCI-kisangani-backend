const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const { audit, redact } = require("./audit");

test("redact: passwords, tokens and tokenVersion never reach an audit entry", () => {
  const result = redact({
    username: "jean",
    password: "$2a$10$hash",
    tokenVersion: 3,
    nested: { token: "eyJ...", keep: 1 },
    list: [{ newPassword: "secret", ok: true }],
  });
  assert.deepEqual(result, { username: "jean", nested: { keep: 1 }, list: [{ ok: true }] });
});

test("redact: ObjectIds and Maps are kept readable", () => {
  const id = new mongoose.Types.ObjectId();
  const result = redact({ id, changes: new Map([["total", { from: 1, to: 2 }]]) });
  assert.equal(result.id, String(id));
  assert.deepEqual(result.changes, { total: { from: 1, to: 2 } });
});

test("audit: records actor and target, and never throws into the request", async () => {
  const originalCreate = AuditLog.create;
  let recorded = null;
  AuditLog.create = async (doc) => { recorded = doc; return doc; };
  try {
    await audit(
      { ip: "1.2.3.4", user: { _id: "u1", username: "admin", role: "admin" } },
      "sale.voided",
      { targetType: "Sale", targetId: "s1", before: { total: 5 } }
    );
  } finally {
    AuditLog.create = originalCreate;
  }
  assert.equal(recorded.action, "sale.voided");
  assert.deepEqual(recorded.actor, { id: "u1", username: "admin", role: "admin" });
  assert.equal(recorded.targetId, "s1");
  assert.equal(recorded.meta.ip, "1.2.3.4");

  AuditLog.create = async () => { throw new Error("db down"); };
  try {
    await assert.doesNotReject(() => audit({}, "x", {}));
  } finally {
    AuditLog.create = originalCreate;
  }
});

test("AuditLog: update and delete queries are refused (append-only)", async () => {
  mongoose.set("bufferCommands", false);
  try {
    await assert.rejects(() => AuditLog.updateOne({}, { $set: { action: "x" } }), /append-only/);
    await assert.rejects(() => AuditLog.deleteMany({}), /append-only/);
    await assert.rejects(() => AuditLog.findOneAndDelete({}), /append-only/);
  } finally {
    mongoose.set("bufferCommands", true);
  }
});
