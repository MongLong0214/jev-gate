import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/sim.mjs';
import { createCamera } from '../src/camera.mjs';
import { renderHud } from '../src/hud.mjs';

const bodies = () => [{ id: 'sun', x: 0, y: 0, vx: 0, vy: 0, mass: 1000 }, { id: 'p', x: 100, y: 0, vx: 0, vy: 20, mass: 1 }];

test('advance honors pause and time scale deterministically', () => {
  const a = createSimulation({ bodies: bodies() });
  const b = createSimulation({ bodies: bodies() });
  a.advance(500); b.advance(500);
  assert.deepEqual(a.state(), b.state());
  a.pause(); a.advance(500);
  assert.equal(a.state().timeMs, 500);
  a.resume(); a.setTimeScale(2); a.advance(500);
  assert.equal(a.state().timeMs, 1500);
});

test('camera transforms are inverses and pan/zoom move the view', () => {
  const cam = createCamera({ viewportWidth: 800, viewportHeight: 600 });
  const w = { x: 123.5, y: -42 };
  const back = cam.screenToWorld(cam.worldToScreen(w));
  assert.ok(Math.abs(back.x - w.x) < 1e-9 && Math.abs(back.y - w.y) < 1e-9);
  cam.zoomBy(2, { x: 400, y: 300 });
  assert.equal(cam.state().zoom, 2);
});

test('hud reports time, scale, pause and selection', () => {
  const sim = createSimulation({ bodies: bodies() });
  sim.setTimeScale(4); sim.pause();
  const hud = renderHud(sim.state(), 'p');
  assert.match(hud, /scale=4x/); assert.match(hud, /PAUSED/); assert.match(hud, /selected=p speed=20\.0/);
});
