import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInventory } from '../src/inventory.mjs';
import { toCsv } from '../src/report.mjs';

test('adding the same sku twice sums the quantity', () => {
  const inv = createInventory();
  inv.addItem('A-1', 3);
  inv.addItem('A-1', 2);
  assert.equal(inv.getQty('A-1'), 5);
});

test('a non-positive or fractional qty is rejected', () => {
  const inv = createInventory();
  for (const qty of [0, -1, 1.5]) assert.throws(() => inv.addItem('A-1', qty), { name: 'RangeError', message: 'inventory: invalid qty' });
});

test('removing everything deletes the item', () => {
  const inv = createInventory();
  inv.addItem('A-1', 2);
  inv.removeItem('A-1', 2);
  assert.deepEqual(inv.list(), []);
});

test('removing more than held is rejected', () => {
  const inv = createInventory();
  inv.addItem('A-1', 2);
  assert.throws(() => inv.removeItem('A-1', 3), { name: 'RangeError', message: 'inventory: insufficient stock' });
});

test('csv quotes fields with commas and quotes', () => {
  assert.equal(toCsv([{ sku: 'a,"b"', qty: 1 }]), 'sku,qty\n"a,""b""",1');
});
