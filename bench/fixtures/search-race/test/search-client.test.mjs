import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearchClient } from '../src/search-client.mjs';

test('search returns { query, items } and updates state', async () => {
  const client = createSearchClient(async (q) => [`${q}-1`, `${q}-2`]);
  const result = await client.search('shoes');
  assert.deepEqual(result, { query: 'shoes', items: ['shoes-1', 'shoes-2'] });
  assert.deepEqual(client.getState(), { query: 'shoes', results: ['shoes-1', 'shoes-2'] });
});
