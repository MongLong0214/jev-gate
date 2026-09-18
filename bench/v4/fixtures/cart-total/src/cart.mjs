// Shopping cart totals. Public API: cartTotal(items, options) -> { subtotal, discount, total }
export function cartTotal(items, options = {}) {
  const { coupon = null, taxRate = 0 } = options;
  let subtotal = 0;
  for (const item of items) subtotal += item.price * item.quantity;
  let discount = 0;
  if (coupon && coupon.type === 'percent') discount = subtotal * (coupon.value / 100);
  if (coupon && coupon.type === 'fixed') discount = coupon.value;
  const total = (subtotal - discount) * (1 + taxRate);
  return { subtotal, discount, total };
}
