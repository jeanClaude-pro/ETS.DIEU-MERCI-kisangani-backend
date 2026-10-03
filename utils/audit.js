const AuditLog = require("../models/AuditLog");

// Fields that must never land in an audit entry, at any depth.
const SECRET_KEYS = new Set(["password", "token", "tokenVersion", "authorization", "currentPassword", "newPassword"]);

function redact(value, depth = 0) {
  if (value === null || value === undefined || depth > 8) return value ?? null;
  if (typeof value?.toObject === "function") value = value.toObject();
  if (value instanceof Date) return value;
  if (value instanceof Map) value = Object.fromEntries(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (typeof value === "object") {
    if (value._bsontype) return String(value);
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEYS.has(key)) continue;
      out[key] = redact(entry, depth + 1);
    }
    return out;
  }
  return value;
}

function actorFrom(req) {
  const user = req?.user;
  if (!user) return { id: null, username: null, role: null };
  return { id: user._id || null, username: user.username || null, role: user.role || null };
}

// Records an audit entry. Never throws into the request: a failed audit
// write is logged server-side but does not undo the business operation.
async function audit(req, action, { targetType = null, targetId = null, before = null, after = null, meta = null, actor } = {}) {
  try {
    await AuditLog.create({
      action,
      actor: actor || actorFrom(req),
      targetType,
      targetId: targetId === null || targetId === undefined ? null : String(targetId),
      before: redact(before),
      after: redact(after),
      meta: redact({ ip: req?.ip || null, ...(meta || {}) }),
    });
  } catch (error) {
    console.error(`Audit write failed for "${action}":`, error.message);
  }
}

module.exports = { audit, redact };
