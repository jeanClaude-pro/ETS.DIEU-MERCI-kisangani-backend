// Generic role gate used by the new Management endpoints, to avoid repeating
// `if (req.user.role !== "admin")` for every route. Existing ad hoc role
// checks elsewhere in the codebase (sales.js void, expenses.js isAdminUser)
// are intentionally left as-is.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "No token, authorization denied" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Accès refusé : permissions insuffisantes" });
    }
    next();
  };
}

module.exports = requireRole;
