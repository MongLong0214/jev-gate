import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInventory } from '../src/inventory.mjs';

test('a new item is listed with its quantity', () => {
  const inv = createInventory();
  inv.addItem('A-1', 3);
  assert.equal(inv.getQty('A-1'), 3);
  assert.deepEqual(inv.list(), [{ sku: 'A-1', qty: 3 }]);
});

test('an unknown sku has quantity 0', () => {
  assert.equal(createInventory().getQty('nope'), 0);
});
