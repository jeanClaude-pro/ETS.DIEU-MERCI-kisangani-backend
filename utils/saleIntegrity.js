const { VALID_REGION_CODES, isValidRegionPair } = require("./regions");

function canonicalProductName(product) {
  return String(product.originalName || product.name || "").trim();
}

function calculateLineTotal(item) {
  const price = Number(item?.price);
  const quantity = Number(item?.quantity);
  return Number.isFinite(price) && Number.isFinite(quantity)
    ? Math.round(price * quantity * 100) / 100
    : 0;
}

function calculateRegionTotal(sale, regionCode) {
  if (!VALID_REGION_CODES.includes(regionCode)) return 0;
  const buckets = { Bbbb: 0, Cnnn: 0, Unknown: 0 };
  for (const item of sale?.items || []) {
    const code = VALID_REGION_CODES.includes(item.regionCode) ? item.regionCode : "Unknown";
    buckets[code] += Number.isFinite(item.subtotal) ? item.subtotal : calculateLineTotal(item);
  }
  const weight = buckets.Bbbb + buckets.Cnnn + buckets.Unknown;
  if (weight <= 0 || buckets[regionCode] <= 0) return 0;
  const sourceTotal = Number.isFinite(sale?.total) ? sale.total : weight;
  const amountCents = Math.round(sourceTotal * 100);
  const codes = ["Bbbb", "Cnnn", "Unknown"];
  const exact = codes.map((code) => ({ code, value: amountCents * buckets[code] / weight }));
  const allocated = Object.fromEntries(exact.map(({ code, value }) => [code, Math.trunc(value)]));
  let remaining = amountCents - Object.values(allocated).reduce((sum, value) => sum + value, 0);
  for (const { code } of exact.sort((a, b) => (b.value % 1) - (a.value % 1))) {
    if (remaining > 0) { allocated[code] += 1; remaining -= 1; }
    if (remaining < 0) { allocated[code] -= 1; remaining += 1; }
  }
  return allocated[regionCode] / 100;
}

function calculateSaleFinancials(subtotal, values = {}) {
  const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
  const discount = Math.max(0, money(values.discount));
  const tax = Math.max(0, money(values.tax));
  const transportCost = Math.max(0, money(values.transportCost));
  const otherCharges = Math.max(0, money(values.otherCharges));
  const roundedSubtotal = money(subtotal);
  return {
    subtotal: roundedSubtotal,
    discount,
    tax,
    transportCost,
    otherCharges,
    total: money(roundedSubtotal - discount + tax + transportCost + otherCharges),
  };
}

function allocateSaleFinancialsToItems(items, financials) {
  const subtotal = items.reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
  const allocate = (amount) => {
    if (subtotal <= 0) return items.map(() => 0);
    const cents = Math.round(Number(amount || 0) * 100);
    const exact = items.map((item, index) => ({ index, value: cents * item.subtotal / subtotal }));
    const allocated = exact.map(({ value }) => Math.trunc(value));
    let remaining = cents - allocated.reduce((sum, value) => sum + value, 0);
    for (const { index } of exact.sort((a, b) => (b.value % 1) - (a.value % 1))) {
      if (remaining > 0) { allocated[index] += 1; remaining -= 1; }
      if (remaining < 0) { allocated[index] -= 1; remaining += 1; }
    }
    return allocated.map((value) => value / 100);
  };
  const discounts = allocate(financials.discount);
  const taxes = allocate(financials.tax);
  const transports = allocate(financials.transportCost);
  const others = allocate(financials.otherCharges);
  return items.map((item, index) => {
    const netTotal = Math.round((item.subtotal - discounts[index] + taxes[index] + transports[index] + others[index]) * 100) / 100;
    return {
      ...item,
      discount: discounts[index],
      tax: taxes[index],
      transportCost: transports[index],
      otherCharges: others[index],
      netTotal,
      profit: Math.round((netTotal - item.cost) * 100) / 100,
    };
  });
}

function buildCanonicalSaleItem(product, item) {
  if (!product?.region || !product?.regionCode ||
      !isValidRegionPair(product.region, product.regionCode)) {
    throw new Error(`Product "${canonicalProductName(product) || product?._id || "unknown"}" has an invalid region assignment`);
  }

  const quantity = Number(item?.quantity);
  const price = Number(item?.price);
  const unitCost = Number(product.unitCost ?? item?.unitCost ?? 0);
  const subtotal = price * quantity;
  const cost = unitCost * quantity;
  return {
    productId: product._id,
    name: canonicalProductName(product),
    ...(String(product.unit || item?.unit || "").trim() && {
      unit: String(product.unit || item?.unit).trim(),
    }),
    quantity,
    price,
    subtotal,
    total: subtotal,
    unitCost,
    cost,
    profit: subtotal - cost,
    discount: Number(item?.discount || 0),
    tax: Number(item?.tax || 0),
    transportCost: Number(item?.transportCost || 0),
    otherCharges: Number(item?.otherCharges || 0),
    region: product.region,
    regionCode: product.regionCode,
  };
}

function buildEditedSaleItem(product, oldItem, item) {
  if (!product && !oldItem) throw new Error(`Product not found: ${item?.productId || "unknown"}`);
  const snapshotSource = oldItem?.region && oldItem?.regionCode
    ? {
        _id: item.productId,
        name: oldItem.name || product?.name,
        originalName: oldItem.name || product?.originalName,
        unit: oldItem.unit || product?.unit,
        region: oldItem.region,
        regionCode: oldItem.regionCode,
        unitCost: oldItem.unitCost ?? product?.unitCost ?? 0,
      }
    : product;
  return buildCanonicalSaleItem(snapshotSource, item);
}

module.exports = {
  canonicalProductName,
  calculateLineTotal,
  calculateRegionTotal,
  calculateSaleFinancials,
  allocateSaleFinancialsToItems,
  buildCanonicalSaleItem,
  buildEditedSaleItem,
};
