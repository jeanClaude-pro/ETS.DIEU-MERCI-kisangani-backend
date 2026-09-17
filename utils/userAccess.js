const { MODULE_IDS, defaultModulesForRole } = require("../config/modulePermissions");

const ROLE_ENUM = ["admin", "manager", "inventory_manager", "cashier_supervisor", "staff"];

// A user can only ever use the app when both flags agree it's allowed.
// `isActive` is the field pre-existing code already relies on (and is kept in
// sync with `status` by the User model's pre-save hook); `status` additionally
// distinguishes "never approved" / "explicitly rejected" from a suspension.
function isAccountUsable(user) {
  if (!user) return false;
  if (user.isActive === false) return false;
  if (user.status === "pending" || user.status === "rejected") return false;
  return true;
}

function statusDenialMessage(user) {
  if (user?.status === "pending") return "Votre compte est en attente d'approbation par un administrateur.";
  if (user?.status === "rejected") return "Votre demande de compte a été refusée.";
  return "Votre compte a été suspendu. Contactez un administrateur.";
}

// Admins always have full module access (see plan: "safe admin rule") so they
// can never lock themselves out of Management or any other section.
function getEffectiveModules(user) {
  if (!user) return [];
  if (user.role === "admin") return MODULE_IDS;
  if (Array.isArray(user.modulePermissions)) return user.modulePermissions;
  return defaultModulesForRole(user.role);
}

function hasModuleAccess(user, moduleId) {
  const ids = Array.isArray(moduleId) ? moduleId : [moduleId];
  const effective = getEffectiveModules(user);
  return ids.some((id) => effective.includes(id));
}

// Registration must never let the caller choose role/status/permissions.
function sanitizeRegistrationInput(body) {
  const { username, email, password } = body || {};
  return { username, email, password };
}

module.exports = {
  ROLE_ENUM,
  MODULE_IDS,
  isAccountUsable,
  statusDenialMessage,
  getEffectiveModules,
  hasModuleAccess,
  sanitizeRegistrationInput,
};
