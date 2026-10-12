export const transfer = (from, to, sku, qty) => {
  if (from === to) throw new RangeError('inventory: same location');
  from.removeItem(sku, qty);
  to.addItem(sku, qty);
};
