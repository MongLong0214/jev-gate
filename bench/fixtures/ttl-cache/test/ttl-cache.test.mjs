import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../src/ttl-cache.mjs';

test('stores and returns a fresh value', () => {
  let clock = 0;
  const cache = createTtlCache(100, () => clock);
  cache.set('a', 'A');
  clock = 50;
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.size(), 1);
});
