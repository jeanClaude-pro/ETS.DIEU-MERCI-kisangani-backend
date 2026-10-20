const { signAccessToken } = require("./sessionTokens");

// Short-lived access token (15 minutes at most). `tv` (token version) lets
// the server revoke every token issued before a password reset, role change
// or suspension. Renewal happens through /api/auth/refresh.
const generateToken = (user) => signAccessToken(user).token;

module.exports = generateToken;
