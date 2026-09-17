import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearchClient } from '../src/search-client.mjs';

test('a late older response does not overwrite newer results', async () => {
  const pending = new Map();
  const client = createSearchClient((q) => new Promise((resolve) => pending.set(q, resolve)));
  const first = client.search('old');
  const second = client.search('new');
  pending.get('new')(['new-1']);
  await second;
  pending.get('old')(['old-1']);
  await first;
  assert.deepEqual(client.getState(), { query: 'new', results: ['new-1'] });
});
