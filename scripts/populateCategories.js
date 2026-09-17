require("dotenv").config();
const mongoose = require("mongoose");
const { populateDefaultCategories } = require("../utils/defaultCategories");

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI);
  const result = await populateDefaultCategories();
  console.log(`Categories: ${result.added.length} added, ${result.totalCount} total.`);
  if (result.added.length) console.log(`Added: ${result.added.join(", ")}`);
}

main()
  .catch((error) => {
    console.error("Category population failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
