import { runChecker } from './_lib.mjs';
const bodies = () => [{ id: 'sun', x: 0, y: 0, vx: 0, vy: 0, mass: 1000 }, { id: 'p', x: 100, y: 0, vx: 0, vy: 20, mass: 1 }];
await runChecker(
  ['modules_load', 'sim_api_and_existing_test_kept', 'advance_is_deterministic', 'pause_stops_time', 'time_scale_scales_time', 'camera_transforms_are_inverses', 'camera_pan_zoom_change_view', 'hud_reports_state', 'test_suite_passes'],
  async ({ check, importModule, runTests }) => {
    let sim, cam, hud;
    await check('modules_load', async () => { sim = await importModule('src/sim.mjs'); cam = await importModule('src/camera.mjs'); hud = await importModule('src/hud.mjs'); return typeof sim.createSimulation === 'function' && typeof cam.createCamera === 'function' && typeof hud.renderHud === 'function'; });
    if (!sim || !cam || !hud) return;
    await check('sim_api_and_existing_test_kept', () => { const s = sim.createSimulation({ bodies: bodies() }); s.step(100); const p = s.state().bodies[1]; return p.vx < 0 && s.state().timeMs === 100; });
    await check('advance_is_deterministic', () => { const a = sim.createSimulation({ bodies: bodies() }); const b = sim.createSimulation({ bodies: bodies() }); for (let i = 0; i < 10; i++) { a.advance(37); b.advance(37); } return JSON.stringify(a.state().bodies) === JSON.stringify(b.state().bodies) && a.state().timeMs > 0; });
    await check('pause_stops_time', () => { const s = sim.createSimulation({ bodies: bodies() }); s.advance(200); const t = s.state().timeMs; s.pause(); s.advance(500); const same = s.state().timeMs === t && s.state().paused === true; s.resume(); s.advance(200); return same && s.state().timeMs > t && s.state().paused === false; });
    await check('time_scale_scales_time', () => { const a = sim.createSimulation({ bodies: bodies() }); const b = sim.createSimulation({ bodies: bodies() }); b.setTimeScale(3); a.advance(600); b.advance(200); let threw = false; try { b.setTimeScale(0); } catch { threw = true; } return Math.abs(a.state().timeMs - b.state().timeMs) < 10.5 && threw; });
    await check('camera_transforms_are_inverses', () => { const c = cam.createCamera({ viewportWidth: 800, viewportHeight: 600 }); const w = { x: 123.5, y: -42 }; const back = c.screenToWorld(c.worldToScreen(w)); c.zoomBy(2.5); c.pan(30, -10); const back2 = c.screenToWorld(c.worldToScreen(w)); return Math.abs(back.x - w.x) < 1e-6 && Math.abs(back.y - w.y) < 1e-6 && Math.abs(back2.x - w.x) < 1e-6 && Math.abs(back2.y - w.y) < 1e-6; });
    await check('camera_pan_zoom_change_view', () => { const c = cam.createCamera({ viewportWidth: 800, viewportHeight: 600 }); const before = c.worldToScreen({ x: 10, y: 10 }); c.pan(50, 0); const afterPan = c.worldToScreen({ x: 10, y: 10 }); c.zoomBy(2); const afterZoom = c.worldToScreen({ x: 10, y: 10 }); return afterPan.x !== before.x && (afterZoom.x !== afterPan.x || afterZoom.y !== afterPan.y); });
    await check('hud_reports_state', () => { const s = sim.createSimulation({ bodies: bodies() }); s.setTimeScale(4); s.pause(); const text = hud.renderHud(s.state(), 'p'); return /4/.test(text) && /paus/i.test(text) && /2/.test(text) && /p\b/.test(text) && /20(\.0+)?/.test(text); });
    await check('test_suite_passes', () => runTests());
  },
);
