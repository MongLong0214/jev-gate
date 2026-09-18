import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from '../src/cart.mjs';

test('sums items and applies a percent coupon', () => {
  const r = cartTotal([{ price: 1000, quantity: 2 }, { price: 500, quantity: 1 }], { coupon: { type: 'percent', value: 10 } });
  assert.deepEqual(r, { subtotal: 2500, discount: 250, total: 2250 });
});
