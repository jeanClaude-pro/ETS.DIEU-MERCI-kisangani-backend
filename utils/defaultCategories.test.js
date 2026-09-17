const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_PRODUCT_CATEGORIES,
  normalizeCategoryName,
  populateDefaultCategories,
} = require("./defaultCategories");

function createInMemoryCategoryModel(initialCategories) {
  const records = initialCategories.map((category) => ({ ...category }));
  const query = () => ({ select: () => ({ lean: async () => records.map((record) => ({ ...record })) }) });
  return {
    records,
    find: query,
    async bulkWrite(operations) {
      for (const { updateOne } of operations) {
        if (!records.some((record) => record.name === updateOne.filter.name)) {
          records.push({ ...updateOne.update.$setOnInsert });
        }
      }
    },
  };
}

test("default categories describe products and contain no forbidden customer groups", () => {
  const forbidden = /^(homme|femme|garçon|fille|enfant|bébé)$/iu;
  assert.equal(DEFAULT_PRODUCT_CATEGORIES.some(({ name }) => forbidden.test(name)), false);
  assert.equal(new Set(DEFAULT_PRODUCT_CATEGORIES.map(({ name }) => normalizeCategoryName(name))).size,
    DEFAULT_PRODUCT_CATEGORIES.length);
});

test("normalization treats spacing, case, accents and punctuation consistently", () => {
  assert.equal(normalizeCategoryName("  SOUS–VÊTEMENTS "), "sous vetements");
  assert.equal(normalizeCategoryName("T shirts"), normalizeCategoryName("T-shirts"));
  assert.equal(normalizeCategoryName("Écharpes"), normalizeCategoryName("echarpes"));
});

test("population is idempotent and preserves every existing category", async () => {
  const model = createInMemoryCategoryModel([
    { name: "Catégorie historique", description: "Ne pas modifier" },
    { name: "t shirts", description: "Nom existant conservé" },
  ]);
  const original = model.records.map((record) => ({ ...record }));

  const first = await populateDefaultCategories(model);
  const countAfterFirstRun = model.records.length;
  const second = await populateDefaultCategories(model);

  assert.deepEqual(model.records.slice(0, original.length), original);
  assert.equal(first.added.includes("T-shirts"), false);
  assert.ok(first.added.length > 0);
  assert.equal(second.added.length, 0);
  assert.equal(model.records.length, countAfterFirstRun);
  assert.equal(new Set(model.records.map(({ name }) => normalizeCategoryName(name))).size, model.records.length);
});
