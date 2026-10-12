import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeoutOption } from '../src/cli-options.mjs';

test('a bare number is seconds', () => {
  assert.equal(parseTimeoutOption('90'), 90_000);
  assert.throws(() => parseTimeoutOption('3601'), { name: 'RangeError', message: 'timeout too long: 1h1s' });
});
