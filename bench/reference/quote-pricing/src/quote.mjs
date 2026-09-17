export function quote({ role, price, coupon = 0 }) {
  if (role === 'admin') return { role, amount: price };
  if (role === 'customer') return { role, amount: Math.max(0, price - coupon) };
  throw new Error(`unknown role: ${String(role)}`);
}
