function aggregateItemQuantities(items = []) {
  const quantities = new Map();
  for (const item of items) {
    if (!item?.productId) continue;
    const id = String(item.productId);
    quantities.set(id, (quantities.get(id) || 0) + Number(item.quantity || 0));
  }
  return quantities;
}

// Positive delta returns stock; negative delta consumes stock.
function calculateStockDeltas(oldItems = [], newItems = []) {
  const oldQuantities = aggregateItemQuantities(oldItems);
  const newQuantities = aggregateItemQuantities(newItems);
  const ids = new Set([...oldQuantities.keys(), ...newQuantities.keys()]);
  return [...ids].map((productId) => ({
    productId,
    delta: (oldQuantities.get(productId) || 0) - (newQuantities.get(productId) || 0),
  })).filter(({ delta }) => delta !== 0);
}

module.exports = { aggregateItemQuantities, calculateStockDeltas };
