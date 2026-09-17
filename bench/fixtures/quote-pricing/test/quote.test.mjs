import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote } from '../src/quote.mjs';

test('customer quote applies the coupon', () => {
  assert.deepEqual(quote({ role: 'customer', price: 15000, coupon: 2000 }), { role: 'customer', amount: 13000 });
});

test('coupon defaults to zero', () => {
  assert.deepEqual(quote({ role: 'customer', price: 9000 }), { role: 'customer', amount: 9000 });
});
