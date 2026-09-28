import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validateCountry } from '../src/country.mjs';

test('country: rejects an empty list', () => {
  assert.equal(validateCountry({ countrys: [] }).ok, false);
});
test('country: accepts a populated list', () => {
  assert.equal(validateCountry({ countrys: ['x'] }).ok, true);
});
