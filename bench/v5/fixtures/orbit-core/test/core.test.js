import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCamera, screenToWorld, worldToScreen } from '../src/camera.js';
import { createClock } from '../src/clock.js';
import { formatHud } from '../src/hud.js';
import { stepBodies, totalMomentum } from '../src/physics.js';

const G = 6.674e-11;
const twoBodies = () => [
  { id: 'a', mass: 1e12, x: 0, y: 0, vx: 0, vy: -2.5834e-7, r: 1 },
  { id: 'b', mass: 1e3, x: 1000, y: 0, vx: 0, vy: 0.2583408602345746, r: 1 },
];

test('clock turns whole steps out of the elapsed time', () => {
  const clock = createClock({ stepMs: 16, maxStepsPerAdvance: 8 });
  assert.equal(clock.advance(32), 2);
  assert.equal(clock.state().simTimeMs, 32);
});

test('a paused clock neither steps nor accumulates', () => {
  const clock = createClock({ stepMs: 16, maxStepsPerAdvance: 8 });
  clock.advance(32);
  clock.pause();
  assert.equal(clock.advance(160), 0);
  assert.equal(clock.state().simTimeMs, 32);
  clock.resume();
  assert.equal(clock.advance(16), 1);
});

test('a step keeps the total momentum of an isolated pair', () => {
  const before = totalMomentum(twoBodies());
  const after = totalMomentum(stepBodies(twoBodies(), 1, G));
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('screenToWorld undoes worldToScreen', () => {
  const cam = createCamera({ cx: 120, cy: -40, zoom: 0.25, viewportW: 800, viewportH: 600 });
  const world = { x: 1234.5, y: -678.25 };
  const back = screenToWorld(cam, worldToScreen(cam, world));
  assert.ok(Math.abs(back.x - world.x) < 1e-9);
  assert.ok(Math.abs(back.y - world.y) < 1e-9);
});

test('the HUD line reports the state it is given', () => {
  assert.equal(
    formatHud({ simTimeMs: 83456, timeScale: 2, paused: true, bodyCount: 12, energy: -123400 }),
    'T+00:01:23.456 x2.0 PAUSED bodies=12 E=-1.234e+5',
  );
});
