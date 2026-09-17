const Category = require("../models/Category");

// The existing schema is deliberately flat. These entries describe products,
// never the gender or age of the customer.
const DEFAULT_PRODUCT_CATEGORIES = Object.freeze([
  { name: "Chemises", description: "Chemises et chemisiers habillés ou décontractés." },
  { name: "T-shirts", description: "T-shirts à manches courtes ou longues." },
  { name: "Polos", description: "Polos classiques et décontractés." },
  { name: "Blouses", description: "Blouses et hauts habillés." },
  { name: "Tops", description: "Tops et hauts légers." },
  { name: "Robes", description: "Robes courtes, longues et habillées." },
  { name: "Jupes", description: "Jupes de différentes longueurs et coupes." },
  { name: "Pantalons", description: "Pantalons habillés et décontractés." },
  { name: "Jeans", description: "Pantalons et articles en denim." },
  { name: "Shorts", description: "Shorts et bermudas." },
  { name: "Costumes", description: "Costumes et pièces de costume." },
  { name: "Vestes", description: "Vestes légères et vestes de tenue." },
  { name: "Blazers", description: "Blazers structurés et décontractés." },
  { name: "Pulls", description: "Pulls en maille et tricots." },
  { name: "Sweats", description: "Sweats, sweats à capuche et hauts molletonnés." },
  { name: "Manteaux", description: "Manteaux et vêtements d'extérieur." },
  { name: "Ensembles", description: "Ensembles coordonnés de plusieurs pièces." },
  { name: "Leggings", description: "Leggings et pantalons extensibles." },
  { name: "Sous-vêtements", description: "Sous-vêtements et articles intimes." },
  { name: "Pyjamas", description: "Pyjamas et vêtements de nuit." },
  { name: "Tenues de sport", description: "Vêtements et ensembles destinés au sport." },
  { name: "Baskets", description: "Baskets et chaussures sportives." },
  { name: "Chaussures de ville", description: "Chaussures habillées et formelles." },
  { name: "Mocassins", description: "Mocassins et chaussures sans lacets." },
  { name: "Sandales", description: "Sandales ouvertes et chaussures d'été." },
  { name: "Talons", description: "Chaussures et sandales à talons." },
  { name: "Bottes", description: "Bottes et bottines." },
  { name: "Pantoufles", description: "Pantoufles et chaussures d'intérieur." },
  { name: "Sacs", description: "Sacs à main, sacs de voyage et sacs pratiques." },
  { name: "Ceintures", description: "Ceintures de tenue et accessoires de taille." },
  { name: "Casquettes", description: "Casquettes et couvre-chefs à visière." },
  { name: "Chapeaux", description: "Chapeaux et autres couvre-chefs." },
  { name: "Cravates", description: "Cravates, nœuds papillon et accessoires assortis." },
  { name: "Chaussettes", description: "Chaussettes de ville, sportives et fantaisie." },
  { name: "Écharpes", description: "Écharpes, foulards et accessoires de cou." },
  { name: "Portefeuilles", description: "Portefeuilles, porte-cartes et porte-monnaie." },
  { name: "Bijoux", description: "Bijoux et ornements de mode." },
  { name: "Accessoires", description: "Autres accessoires de mode." },
]);

function cleanCategoryName(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeCategoryName(value) {
  return cleanCategoryName(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`]/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("fr");
}

function missingDefaultCategories(existingCategories) {
  const existingKeys = new Set(
    existingCategories.map((category) => normalizeCategoryName(category?.name)).filter(Boolean),
  );
  return DEFAULT_PRODUCT_CATEGORIES.filter(
    (category) => !existingKeys.has(normalizeCategoryName(category.name)),
  );
}

async function populateDefaultCategories(CategoryModel = Category) {
  const existingBefore = await CategoryModel.find({}).select("name").lean();
  const missing = missingDefaultCategories(existingBefore);

  if (missing.length) {
    await CategoryModel.bulkWrite(
      missing.map((category) => ({
        updateOne: {
          filter: { name: category.name },
          update: { $setOnInsert: category },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  const categoriesAfter = await CategoryModel.find({}).select("name").lean();
  const beforeKeys = new Set(existingBefore.map((category) => normalizeCategoryName(category.name)));
  const added = categoriesAfter
    .map((category) => category.name)
    .filter((name) => !beforeKeys.has(normalizeCategoryName(name)))
    .sort((left, right) => left.localeCompare(right, "fr"));

  return {
    existingCount: existingBefore.length,
    added,
    totalCount: categoriesAfter.length,
  };
}

module.exports = {
  DEFAULT_PRODUCT_CATEGORIES,
  cleanCategoryName,
  normalizeCategoryName,
  missingDefaultCategories,
  populateDefaultCategories,
};
