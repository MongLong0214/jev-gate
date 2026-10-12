import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeoutOption } from '../src/cli-options.mjs';

test('timeout accepts durations up to one hour', () => {
  assert.equal(parseTimeoutOption('45m'), 2_700_000);
  assert.equal(parseTimeoutOption('1h'), 3_600_000);
});

test('timeout rejects too long, zero and bad syntax', () => {
  assert.throws(() => parseTimeoutOption('1h30m'), { name: 'RangeError', message: 'timeout too long: 1h30m' });
  assert.throws(() => parseTimeoutOption('0s'), { name: 'RangeError', message: 'timeout must be positive' });
  assert.throws(() => parseTimeoutOption('soon'), { name: 'TypeError' });
});
