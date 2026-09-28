import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validateDuns } from '../src/duns.mjs';

test('duns: rejects an empty list', () => {
  assert.equal(validateDuns({ dunss: [] }).ok, false);
});
test('duns: accepts a populated list', () => {
  assert.equal(validateDuns({ dunss: ['x'] }).ok, true);
});
