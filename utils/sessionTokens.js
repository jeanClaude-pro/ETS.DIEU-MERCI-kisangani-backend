// Short-lived access tokens + rotating refresh tokens.
//
//  - Access token (JWT, HS256): 15 minutes at most, whatever JWT_EXPIRES_IN
//    says. Carries `typ: "access"` so no other token type is ever accepted.
//  - Refresh token: 384 random bits, sent once to the client, stored hashed.
//    Single use: each refresh returns a new one and retires the old one.
//    Dies after 30 minutes without use, or 12 hours after login, or when
//    the user's tokenVersion changes, or on logout.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const MAX_ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_IDLE_MS = 30 * 60 * 1000;
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
// Two tabs (or a retried request) may present the same token a moment apart;
// that is not theft. Within this window the second caller is told to re-read
// the newer token instead of having the family revoked.
const ROTATION_GRACE_MS = 30 * 1000;
const ISSUER = "boutique-erp";
const AUDIENCE = "boutique-erp-app";

/** Access token lifetime in seconds: env may shorten it, never extend it. */
function accessTtlSeconds(raw = process.env.JWT_EXPIRES_IN) {
  const match = /^(\d+)\s*([smh]?)$/.exec(String(raw || "").trim());
  if (!match) return MAX_ACCESS_TTL_SECONDS;
  const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600, "": 1 })[match[2]];
  return seconds > 0 ? Math.min(seconds, MAX_ACCESS_TTL_SECONDS) : MAX_ACCESS_TTL_SECONDS;
}

function signAccessToken(user, now = Date.now()) {
  const ttl = accessTtlSeconds();
  const token = jwt.sign(
    { id: String(user._id), tv: user.tokenVersion || 0, typ: "access" },
    process.env.JWT_SECRET,
    { expiresIn: ttl, algorithm: "HS256", issuer: ISSUER, audience: AUDIENCE },
  );
  return { token, expiresAt: new Date(now + ttl * 1000).toISOString() };
}

function verifyAccessToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE });
  if (decoded?.typ !== "access") {
    const error = new Error("Not an access token");
    error.name = "JsonWebTokenError";
    throw error;
  }
  return decoded;
}

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const newRefreshToken = () => crypto.randomBytes(48).toString("base64url");
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{64}$/;

class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Creates the first refresh token of a new login. */
async function startSession(Model, user, meta = {}, now = Date.now()) {
  const refreshToken = newRefreshToken();
  await Model.create({
    tokenHash: hashToken(refreshToken),
    familyId: crypto.randomUUID(),
    userId: user._id,
    tokenVersion: user.tokenVersion || 0,
    sessionExpiresAt: new Date(now + SESSION_MAX_MS),
    idleExpiresAt: new Date(now + REFRESH_IDLE_MS),
    userAgent: String(meta.userAgent || "").slice(0, 200),
    ip: String(meta.ip || "").slice(0, 64),
  });
  return refreshToken;
}

async function revokeFamily(Model, familyId, reason, now = Date.now()) {
  await Model.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date(now), revokedReason: reason } });
}

/**
 * Exchanges a refresh token for a new one. `loadUser(id)` returns the user
 * (or null); `isUsable(user)` applies the account status rules.
 * Returns { user, refreshToken } or throws SessionError.
 */
async function rotateSession(Model, presentedToken, { loadUser, isUsable, meta = {} }, now = Date.now()) {
  if (typeof presentedToken !== "string" || !REFRESH_TOKEN_PATTERN.test(presentedToken)) {
    throw new SessionError("INVALID_REFRESH", "Session invalide");
  }
  const session = await Model.findOne({ tokenHash: hashToken(presentedToken) });
  if (!session || session.revokedAt) throw new SessionError("INVALID_REFRESH", "Session invalide");

  if (session.rotatedAt) {
    if (now - new Date(session.rotatedAt).getTime() <= ROTATION_GRACE_MS) {
      throw new SessionError("REFRESH_ROTATED", "Session déjà renouvelée");
    }
    // An old token came back: it was copied. Kill every token of this login.
    await revokeFamily(Model, session.familyId, "reuse_detected", now);
    throw new SessionError("REFRESH_REUSED", "Session révoquée par sécurité");
  }
  if (new Date(session.sessionExpiresAt).getTime() <= now || new Date(session.idleExpiresAt).getTime() <= now) {
    await revokeFamily(Model, session.familyId, "expired", now);
    throw new SessionError("SESSION_EXPIRED", "Session expirée");
  }

  const user = await loadUser(session.userId);
  if (!user || !isUsable(user) || (user.tokenVersion || 0) !== (session.tokenVersion || 0)) {
    await revokeFamily(Model, session.familyId, "account_changed", now);
    throw new SessionError("INVALID_REFRESH", "Session invalide");
  }

  // Claim the row atomically: only one concurrent request can rotate it.
  const claimed = await Model.findOneAndUpdate(
    { _id: session._id, rotatedAt: null, revokedAt: null },
    { $set: { rotatedAt: new Date(now) } },
  );
  if (!claimed) throw new SessionError("REFRESH_ROTATED", "Session déjà renouvelée");

  const refreshToken = newRefreshToken();
  await Model.create({
    tokenHash: hashToken(refreshToken),
    familyId: session.familyId,
    userId: session.userId,
    tokenVersion: session.tokenVersion || 0,
    sessionExpiresAt: session.sessionExpiresAt,
    idleExpiresAt: new Date(Math.min(now + REFRESH_IDLE_MS, new Date(session.sessionExpiresAt).getTime())),
    userAgent: String(meta.userAgent || session.userAgent || "").slice(0, 200),
    ip: String(meta.ip || "").slice(0, 64),
  });
  return { user, refreshToken };
}

/** Logout: revokes the presented token's whole family (best effort). */
async function endSession(Model, presentedToken, now = Date.now()) {
  if (typeof presentedToken !== "string" || !REFRESH_TOKEN_PATTERN.test(presentedToken)) return false;
  const session = await Model.findOne({ tokenHash: hashToken(presentedToken) });
  if (!session) return false;
  await revokeFamily(Model, session.familyId, "logout", now);
  return true;
}

module.exports = {
  MAX_ACCESS_TTL_SECONDS,
  REFRESH_IDLE_MS,
  SESSION_MAX_MS,
  ROTATION_GRACE_MS,
  SessionError,
  accessTtlSeconds,
  signAccessToken,
  verifyAccessToken,
  hashToken,
  startSession,
  rotateSession,
  endSession,
  revokeFamily,
};
