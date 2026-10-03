// Rejects request bodies containing MongoDB operator keys ("$gt", "$ne", ...)
// or dotted paths ("a.b") at any depth. No legitimate client payload uses
// them, and refusing outright (instead of silently stripping) means a
// tampered request can never be half-applied.
const MAX_DEPTH = 20;

function findForbiddenKey(value, depth = 0) {
  if (depth > MAX_DEPTH) return "(nesting too deep)";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findForbiddenKey(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (key.startsWith("$") || key.includes(".")) return key;
      const found = findForbiddenKey(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function rejectMongoOperators(req, res, next) {
  if (findForbiddenKey(req.body)) {
    return res.status(400).json({ message: "Invalid request", error: "Invalid request" });
  }
  next();
}

module.exports = rejectMongoOperators;
module.exports.findForbiddenKey = findForbiddenKey;
