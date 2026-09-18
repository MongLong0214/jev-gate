import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/sim.mjs';

test('a light body accelerates toward a heavy one and time advances', () => {
  const sim = createSimulation({ bodies: [{ id: 'sun', x: 0, y: 0, vx: 0, vy: 0, mass: 1000 }, { id: 'p', x: 100, y: 0, vx: 0, vy: 0, mass: 1 }] });
  sim.step(100);
  const p = sim.state().bodies[1];
  assert.ok(p.vx < 0);
  assert.equal(sim.state().timeMs, 100);
});
