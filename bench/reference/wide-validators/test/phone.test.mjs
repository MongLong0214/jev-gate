import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validatePhone } from '../src/phone.mjs';

test('phone: rejects an empty list', () => {
  assert.equal(validatePhone({ phones: [] }).ok, false);
});
test('phone: accepts a populated list', () => {
  assert.equal(validatePhone({ phones: ['x'] }).ok, true);
});
