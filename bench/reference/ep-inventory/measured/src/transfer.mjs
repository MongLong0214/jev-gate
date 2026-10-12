export const transfer = (from, to, sku, qty) => {
  from.removeItem(sku, qty);
  to.addItem(sku, qty);
};
