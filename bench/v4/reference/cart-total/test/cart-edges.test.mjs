import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from '../src/cart.mjs';

test('fixed coupon never drives the total below zero', () => {
  assert.equal(cartTotal([{ price: 300, quantity: 1 }], { coupon: { type: 'fixed', value: 500 } }).total, 0);
});
test('totals are whole won with tax', () => {
  assert.equal(cartTotal([{ price: 333, quantity: 1 }], { taxRate: 0.1 }).total, 366);
});
test('rejects fractional or negative quantities', () => {
  assert.throws(() => cartTotal([{ price: 100, quantity: 1.5 }]), RangeError);
  assert.throws(() => cartTotal([{ price: 100, quantity: -1 }]), RangeError);
});
