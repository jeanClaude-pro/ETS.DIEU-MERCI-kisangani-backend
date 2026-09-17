const { hasModuleAccess } = require("../utils/userAccess");

// Additional authorization layer on top of authMiddleware. Does not replace
// any existing role/action check inside route handlers (e.g. void/refund
// restrictions) — it only gates whether the user may reach the module at
// all. Accepts a single module id or an array (user needs at least one).
function requireModulePermission(moduleId) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "No token, authorization denied" });
    }
    if (!hasModuleAccess(req.user, moduleId)) {
      return res.status(403).json({ message: "Accès non autorisé à ce module" });
    }
    next();
  };
}

module.exports = requireModulePermission;
