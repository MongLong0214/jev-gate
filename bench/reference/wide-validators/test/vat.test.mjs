import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validateVat } from '../src/vat.mjs';

test('vat: rejects an empty list', () => {
  assert.equal(validateVat({ vats: [] }).ok, false);
});
test('vat: accepts a populated list', () => {
  assert.equal(validateVat({ vats: ['x'] }).ok, true);
});
