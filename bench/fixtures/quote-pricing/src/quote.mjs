export function quote({ role, price, coupon = 0 }) {
  const amount = Math.max(0, price - coupon);
  return { role, amount };
}
