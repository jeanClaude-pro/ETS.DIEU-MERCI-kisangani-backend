const jwt = require("jsonwebtoken");

// `tv` (token version) lets the server revoke every token issued before a
// password reset, role change or suspension: auth middleware rejects a
// token whose `tv` no longer matches the user's current tokenVersion.
const generateToken = (user) => {
  return jwt.sign(
    { id: String(user._id), tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1d", algorithm: "HS256" }
  );
};

module.exports = generateToken;
