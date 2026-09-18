import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validatePostcode } from '../src/postcode.mjs';

test('postcode: rejects an empty list', () => {
  assert.equal(validatePostcode({ postcodes: [] }).ok, false);
});
test('postcode: accepts a populated list', () => {
  assert.equal(validatePostcode({ postcodes: ['x'] }).ok, true);
});
