import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/parse-duration.mjs';

test('single units', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('2m'), 120_000);
  assert.equal(parseDuration('1h'), 3_600_000);
});
