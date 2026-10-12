import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInventory } from '../src/inventory.mjs';
import { transfer } from '../src/transfer.mjs';

test('a transfer to the same inventory is rejected and changes nothing', () => {
  const a = createInventory();
  a.addItem('A-1', 3);
  assert.throws(() => transfer(a, a, 'A-1', 1), { name: 'RangeError', message: 'inventory: same location' });
  assert.equal(a.getQty('A-1'), 3);
});
