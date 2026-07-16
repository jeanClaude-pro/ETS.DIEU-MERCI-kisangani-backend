const { VALID_REGION_CODES, isValidRegionPair } = require("./regions");

function canonicalProductName(product) {
  return String(product.originalName || product.name || "").trim();
}

function calculateLineTotal(item) {
  const price = Number(item?.price);
  const quantity = Number(item?.quantity);
  return Number.isFinite(price) && Number.isFinite(quantity) ? price * quantity : 0;
}

function calculateRegionTotal(sale, regionCode) {
  if (!VALID_REGION_CODES.includes(regionCode)) return 0;
  return (sale?.items || [])
    .filter((item) => item.regionCode === regionCode)
    .reduce((sum, item) => sum + calculateLineTotal(item), 0);
}

function buildCanonicalSaleItem(product, item) {
  if (!product?.region || !product?.regionCode ||
      !isValidRegionPair(product.region, product.regionCode)) {
    throw new Error(`Product "${canonicalProductName(product) || product?._id || "unknown"}" has an invalid region assignment`);
  }

  const quantity = Number(item?.quantity);
  const price = Number(item?.price);
  return {
    productId: product._id,
    name: canonicalProductName(product),
    quantity,
    price,
    total: price * quantity,
    region: product.region,
    regionCode: product.regionCode,
  };
}

module.exports = {
  canonicalProductName,
  calculateLineTotal,
  calculateRegionTotal,
  buildCanonicalSaleItem,
};
