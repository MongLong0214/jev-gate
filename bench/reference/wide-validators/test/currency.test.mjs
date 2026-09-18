import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validateCurrency } from '../src/currency.mjs';

test('currency: rejects an empty list', () => {
  assert.equal(validateCurrency({ currencys: [] }).ok, false);
});
test('currency: accepts a populated list', () => {
  assert.equal(validateCurrency({ currencys: ['x'] }).ok, true);
});
