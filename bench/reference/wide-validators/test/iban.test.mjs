import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validateIban } from '../src/iban.mjs';

test('iban: rejects an empty list', () => {
  assert.equal(validateIban({ ibans: [] }).ok, false);
});
test('iban: accepts a populated list', () => {
  assert.equal(validateIban({ ibans: ['x'] }).ok, true);
});
