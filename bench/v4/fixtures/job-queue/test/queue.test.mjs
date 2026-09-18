import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/queue.mjs';

test('runs jobs with bounded concurrency and resolves their values', async () => {
  const q = createQueue({ concurrency: 2 });
  let active = 0;
  let peak = 0;
  const job = (v) => async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return v; };
  const results = await Promise.all([q.enqueue(job(1)), q.enqueue(job(2)), q.enqueue(job(3))]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.equal(peak, 2);
  await q.drain();
  assert.equal(q.size(), 0);
});
