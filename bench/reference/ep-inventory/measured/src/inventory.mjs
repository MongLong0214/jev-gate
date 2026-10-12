const checkQty = (qty) => {
  if (!Number.isInteger(qty) || qty <= 0) throw new RangeError('inventory: invalid qty');
};

export const createInventory = () => {
  const items = new Map();
  return {
    addItem(sku, qty) {
      checkQty(qty);
      items.set(sku, (items.get(sku) ?? 0) + qty);
    },
    removeItem(sku, qty) {
      checkQty(qty);
      const have = items.get(sku) ?? 0;
      if (have < qty) throw new RangeError('inventory: insufficient stock');
      if (have === qty) items.delete(sku);
      else items.set(sku, have - qty);
    },
    getQty(sku) {
      return items.get(sku) ?? 0;
    },
    list() {
      return [...items.entries()].map(([sku, qty]) => ({ sku, qty }));
    },
  };
};
