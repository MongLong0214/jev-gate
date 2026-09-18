export function cartTotal(items, options = {}) {
  const { coupon = null, taxRate = 0 } = options;
  let subtotal = 0;
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 0) throw new RangeError('quantity must be a non-negative integer');
    subtotal += item.price * item.quantity;
  }
  let discount = 0;
  if (coupon && coupon.type === 'percent') discount = Math.round(subtotal * (coupon.value / 100));
  if (coupon && coupon.type === 'fixed') discount = coupon.value;
  discount = Math.min(discount, subtotal);
  const total = Math.round((subtotal - discount) * (1 + taxRate));
  return { subtotal, discount, total };
}
