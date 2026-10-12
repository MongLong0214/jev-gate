export const createInventory = () => {
  const items = new Map();
  return {
    addItem(sku, qty) {
      items.set(sku, qty);
    },
    getQty(sku) {
      return items.get(sku) ?? 0;
    },
    list() {
      return [...items.entries()].map(([sku, qty]) => ({ sku, qty }));
    },
  };
};
