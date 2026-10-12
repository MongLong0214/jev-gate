import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInventory } from '../src/inventory.mjs';
import { transfer } from '../src/transfer.mjs';

test('transfer moves stock and drops an emptied item', () => {
  const a = createInventory();
  const b = createInventory();
  a.addItem('A-1', 3);
  transfer(a, b, 'A-1', 3);
  assert.deepEqual(a.list(), []);
  assert.equal(b.getQty('A-1'), 3);
});

test('a failed transfer changes nothing', () => {
  const a = createInventory();
  const b = createInventory();
  a.addItem('A-1', 3);
  assert.throws(() => transfer(a, b, 'A-1', 4), { name: 'RangeError', message: 'inventory: insufficient stock' });
  assert.throws(() => transfer(a, b, 'A-1', 0), { name: 'RangeError', message: 'inventory: invalid qty' });
  assert.equal(a.getQty('A-1'), 3);
  assert.deepEqual(b.list(), []);
});
