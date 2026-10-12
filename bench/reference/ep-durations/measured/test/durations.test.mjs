import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../src/format-duration.mjs';
import { paginate } from '../src/paginate.mjs';
import { parseDuration } from '../src/parse-duration.mjs';

test('combined units and ms', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('2m15s'), 135_000);
  assert.equal(parseDuration('250ms'), 250);
  assert.throws(() => parseDuration('30m1h'), { name: 'TypeError' });
});

test('format is the inverse of parse', () => {
  for (const t of ['1h30m', '1s500ms', '0ms', '45m']) assert.equal(formatDuration(parseDuration(t)), t);
});

test('page 1 is the first page', () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 1, 2), [1, 2]);
  assert.throws(() => paginate([1], 0, 2), RangeError);
});
