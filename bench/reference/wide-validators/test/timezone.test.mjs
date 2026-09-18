import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validateTimezone } from '../src/timezone.mjs';

test('timezone: rejects an empty list', () => {
  assert.equal(validateTimezone({ timezones: [] }).ok, false);
});
test('timezone: accepts a populated list', () => {
  assert.equal(validateTimezone({ timezones: ['x'] }).ok, true);
});
