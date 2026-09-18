import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeCollisions } from '../src/collisions.js';
import { createSimulation } from '../src/simulation.js';
import { restore, serialize } from '../src/snapshot.js';

const G = 6.674e-11;
const bodies = () => [
  { id: 'a', mass: 1e12, x: 0, y: 0, vx: 0, vy: 0, r: 1 },
  { id: 'b', mass: 1e3, x: 1000, y: 0, vx: 0, vy: 0.2583408602345746, r: 1 },
];

test('a chain of overlapping bodies merges in one call, conserving mass and momentum', () => {
  const merged = mergeCollisions([
    { id: 'a', mass: 1, x: 0, y: 0, vx: 1, vy: 0, r: 1 },
    { id: 'b', mass: 4, x: 1.5, y: 0, vx: 0, vy: 2, r: 1 },
    { id: 'c', mass: 2, x: 3, y: 0, vx: -3, vy: 0, r: 1 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'b');
  assert.equal(merged[0].mass, 7);
  assert.equal(merged[0].vx, (1 - 6) / 7);
  assert.equal(merged[0].r, Math.sqrt(3));
});

test('a snapshot rejects fields it does not define', () => {
  const text = serialize({ clock: { simTimeMs: 0, accumulatorMs: 0, paused: false, timeScale: 1 }, bodies: bodies() });
  assert.deepEqual(restore(text).bodies, bodies());
  assert.throws(() => restore(JSON.stringify({ ...JSON.parse(text), seed: 1 })), { name: 'SnapshotError' });
});

test('a run continued from a snapshot matches the uninterrupted run bit for bit', () => {
  const straight = createSimulation({ bodies: bodies(), G, stepMs: 16, maxStepsPerAdvance: 8 });
  const split = createSimulation({ bodies: bodies(), G, stepMs: 16, maxStepsPerAdvance: 8 });
  for (let i = 0; i < 50; i += 1) {
    straight.advance(100);
    split.advance(100);
  }
  const resumed = createSimulation({ bodies: bodies(), G, stepMs: 16, maxStepsPerAdvance: 8 });
  resumed.restoreFrom(split.snapshot());
  for (let i = 0; i < 50; i += 1) {
    straight.advance(100);
    resumed.advance(100);
  }
  assert.deepEqual(resumed.bodies(), straight.bodies());
  assert.deepEqual(resumed.clock().state(), straight.clock().state());
});
