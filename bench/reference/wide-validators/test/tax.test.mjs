import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validateTax } from '../src/tax.mjs';

test('tax: rejects an empty list', () => {
  assert.equal(validateTax({ taxs: [] }).ok, false);
});
test('tax: accepts a populated list', () => {
  assert.equal(validateTax({ taxs: ['x'] }).ok, true);
});
