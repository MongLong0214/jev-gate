import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countByStatus } from '../src/count-by-status.mjs';

test('counts open and closed items', () => {
  const items = [{ status: 'open' }, { status: 'closed' }, { status: 'open' }];
  assert.deepEqual(countByStatus(items), { open: 2, closed: 1 });
});
