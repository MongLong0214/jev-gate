import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/queue.mjs';

test('a failing job rejects its promise, reports through onError, and the queue keeps going', async () => {
  const seen = [];
  const q = createQueue({ concurrency: 1, onError: (e, id) => seen.push([e.message, id]) });
  const boom = q.enqueue(async () => { throw new Error('boom'); });
  const after = q.enqueue(async () => 'after');
  await assert.rejects(boom, /boom/);
  assert.equal(await after, 'after');
  assert.deepEqual(seen, [['boom', 1]]);
  await q.drain();
  assert.equal(q.size(), 0);
});
