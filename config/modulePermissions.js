// Canonical module-permission registry.
//
// This is a plain JS mirror of the module ids/roles defined in
// client/src/components/navigationConfig.ts (`navigationSections`). It has to
// be duplicated rather than imported because the client file is TypeScript
// and the server runs CommonJS with no shared build step. Keep the ids and
// `roles` arrays here in sync with that file whenever a module is added,
// renamed, or its default role access changes.
const operationalRoles = ["admin", "manager", "cashier_supervisor", "inventory_manager"];
const historyRoles = [...operationalRoles, "staff"];
// Shareholders consult one region: products, operations and transactions.
// They never get an operational (create/edit) module.
const SHAREHOLDER_MODULES = ["dashboard", "products", "sales", "entryhistory", "sortiehistory", "reports"];
// Modules that no longer exist; stored on older accounts and ignored.
const RETIRED_MODULE_IDS = ["reservation", "reservations"];

const MODULES = [
  { id: "dashboard", roles: ["admin", "manager", "shareholder"] },
  // exchangeRates.js's write routes already allow admin+manager today
  // (independent of what the sidebar shows); keep that intact.
  { id: "rate", roles: ["admin", "manager"] },
  { id: "pos", roles: operationalRoles },
  { id: "entry", roles: operationalRoles },
  { id: "sortie", roles: operationalRoles },
  { id: "products", roles: ["admin", "manager", "inventory_manager", "shareholder"] },
  { id: "sales", roles: [...historyRoles, "shareholder"] },
  { id: "sync", roles: operationalRoles },
  // Receipt barcode scanning — useful anywhere sales are made or reviewed.
  { id: "scanner", roles: historyRoles },
  { id: "entryhistory", roles: [...operationalRoles, "shareholder"] },
  { id: "sortiehistory", roles: [...operationalRoles, "shareholder"] },
  { id: "reports", roles: ["admin", "shareholder"] },
  { id: "customers", roles: ["admin", "manager", "cashier_supervisor"] },
  { id: "management", roles: ["admin"] },
];

const MODULE_IDS = MODULES.map((module) => module.id);

function defaultModulesForRole(role) {
  if (!role) return [];
  return MODULES.filter((module) => module.roles.includes(role)).map((module) => module.id);
}

module.exports = { MODULES, MODULE_IDS, SHAREHOLDER_MODULES, RETIRED_MODULE_IDS, defaultModulesForRole };
