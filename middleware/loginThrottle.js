const LoginAttempt = require("../models/LoginAttempt");
const { escapeRegex } = require("../utils/validate");

// Brute-force protection for POST /api/auth/login, backed by MongoDB so a
// restart never clears an active lockout.
//
// Two independent counters, failures only:
//  - account key (IP + email): 5 failures within 1 minute locks that pair
//    for 2 hours. Keyed per pair so one attacked account never blocks the
//    other cashiers sharing the shop's public IP.
//  - IP key: a looser ceiling (40 failures / 15 minutes) that stops one
//    client from cycling through many different emails.
// A successful login clears that account key. The lockout duration is never
// disclosed (no Retry-After / RateLimit-* headers, generic message).
const ACCOUNT_LIMIT = { max: 5, windowMs: 60 * 1000, lockMs: 2 * 60 * 60 * 1000 };
const IP_LIMIT = { max: 40, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 };
const TOO_MANY_ATTEMPTS_MESSAGE = "Trop de tentatives. Réessayez plus tard.";

function accountKey(ip, email) {
  return `acct:${ip || "unknown"}|${String(email || "").toLowerCase()}`;
}

function ipKey(ip) {
  return `ip:${ip || "unknown"}`;
}

function isLocked(doc, now) {
  return Boolean(doc?.lockedUntil && new Date(doc.lockedUntil).getTime() > now);
}

async function isBlocked(ip, email, now = Date.now()) {
  const docs = await LoginAttempt.find({ key: { $in: [accountKey(ip, email), ipKey(ip)] } }).lean();
  return docs.some((doc) => isLocked(doc, now));
}

async function incrementKey(key, limit, now) {
  const nowDate = new Date(now);
  // Start a fresh window when the previous one has elapsed (and no lock is
  // active). Conditional update, so concurrent failures never double-reset.
  await LoginAttempt.updateOne(
    {
      key,
      windowStart: { $lt: new Date(now - limit.windowMs) },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: nowDate } }],
    },
    { $set: { count: 0, windowStart: nowDate, lockedUntil: null } }
  );

  const update = {
    $inc: { count: 1 },
    $setOnInsert: { windowStart: nowDate, lockedUntil: null },
    $max: { expiresAt: new Date(now + limit.windowMs) },
  };
  let doc;
  try {
    doc = await LoginAttempt.findOneAndUpdate({ key }, update, { upsert: true, new: true });
  } catch (error) {
    // Two first failures raced on the upsert; the document now exists.
    if (error?.code !== 11000) throw error;
    doc = await LoginAttempt.findOneAndUpdate({ key }, update, { new: true });
  }

  if (doc && doc.count >= limit.max && !isLocked(doc, now)) {
    const lockedUntil = new Date(now + limit.lockMs);
    await LoginAttempt.updateOne({ key }, { $set: { lockedUntil, expiresAt: lockedUntil } });
    return true;
  }
  return false;
}

// Returns which keys became locked by this failure.
async function recordFailure(ip, email, now = Date.now()) {
  const [accountLocked, ipLocked] = await Promise.all([
    incrementKey(accountKey(ip, email), ACCOUNT_LIMIT, now),
    incrementKey(ipKey(ip), IP_LIMIT, now),
  ]);
  return { accountLocked, ipLocked };
}

async function recordSuccess(ip, email) {
  await LoginAttempt.deleteOne({ key: accountKey(ip, email) });
}

// Admin unlock: clears the account lock for that email from every IP.
async function unlockEmail(email) {
  const suffix = `|${String(email || "").toLowerCase()}`;
  const { deletedCount } = await LoginAttempt.deleteMany({
    key: { $regex: `^acct:.*${escapeRegex(suffix)}$` },
  });
  return deletedCount || 0;
}

function sendTooManyAttempts(res) {
  return res.status(429).json({ message: TOO_MANY_ATTEMPTS_MESSAGE });
}

module.exports = {
  ACCOUNT_LIMIT,
  IP_LIMIT,
  TOO_MANY_ATTEMPTS_MESSAGE,
  accountKey,
  ipKey,
  isBlocked,
  recordFailure,
  recordSuccess,
  unlockEmail,
  sendTooManyAttempts,
};
