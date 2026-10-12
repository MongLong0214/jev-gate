import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvLine } from '../src/csv-parse.mjs';

test('plain fields', () => {
  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
});
