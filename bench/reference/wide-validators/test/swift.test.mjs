import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validateSwift } from '../src/swift.mjs';

test('swift: rejects an empty list', () => {
  assert.equal(validateSwift({ swifts: [] }).ok, false);
});
test('swift: accepts a populated list', () => {
  assert.equal(validateSwift({ swifts: ['x'] }).ok, true);
});
