import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validateLocale } from '../src/locale.mjs';

test('locale: rejects an empty list', () => {
  assert.equal(validateLocale({ locales: [] }).ok, false);
});
test('locale: accepts a populated list', () => {
  assert.equal(validateLocale({ locales: ['x'] }).ok, true);
});
