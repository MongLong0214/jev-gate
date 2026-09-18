import { runChecker } from './_lib.mjs';

// Trusted behaviour checks for the orbit-core job. Every value here is fixed by the request text: SI units, G supplied by
// the caller, and the two-body circular orbit m1=1e12 kg, m2=1e3 kg, r=1000 m. Checks report a reason so a failure names
// the behaviour that regressed rather than "something went wrong" (ADR #22 A11).
const G = 6.674e-11;
const M1 = 1e12;
const M2 = 1e3;
const R = 1000;
const V_REL = Math.sqrt((G * (M1 + M2)) / R);

/** Barycentric circular orbit: collision-free for the whole drift run (separation ~1000 m, radii 1 m). */
const orbit = () => [
  { id: 'a', mass: M1, x: 0, y: 0, vx: 0, vy: -(M2 / (M1 + M2)) * V_REL, r: 1 },
  { id: 'b', mass: M2, x: R, y: 0, vx: 0, vy: (M1 / (M1 + M2)) * V_REL, r: 1 },
];

const trio = () => [
  { id: 'a', mass: M1, x: 0, y: 0, vx: 0, vy: 0, r: 1 },
  { id: 'b', mass: M2, x: R, y: 0, vx: 0, vy: V_REL, r: 1 },
  { id: 'c', mass: M2, x: -2 * R, y: 0, vx: 0, vy: -Math.sqrt((G * M1) / (2 * R)), r: 1 },
];

const ok = (passed, reason) => ({ passed, reason });
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const throwsRange = (fn) => {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof RangeError;
  }
};
const throwsSnapshotError = (fn) => {
  try {
    fn();
    return false;
  } catch (err) {
    return err?.name === 'SnapshotError';
  }
};

await runChecker(
  [
    'modules_load',
    'clock_steps_and_accumulator',
    'clock_pause_and_time_scale',
    'physics_energy_drift_bounded',
    'physics_reversible',
    'collisions_conserve_mass_and_momentum',
    'collisions_transitive_and_order_independent',
    'snapshot_round_trip_exact',
    'snapshot_rejects_unknown_fields',
    'camera_transforms_invertible',
    'camera_zoom_at_keeps_anchor',
    'camera_pan_shifts_view',
    'hud_formats_exact_strings',
    'simulation_replay_bit_identical',
    'simulation_restore_continues_run',
    'test_suite_passes',
  ],
  async ({ check, importModule, runTests }) => {
    const load = async (rel) => {
      try {
        return await importModule(rel);
      } catch {
        return null;
      }
    };
    // Loaded one by one so a missing module leaves only its own checks unevaluated; the others still observe behaviour.
    const clockMod = await load('src/clock.js');
    const physics = await load('src/physics.js');
    const collisions = await load('src/collisions.js');
    const snapshot = await load('src/snapshot.js');
    const camera = await load('src/camera.js');
    const hud = await load('src/hud.js');
    const simulation = await load('src/simulation.js');

    await check('modules_load', () => {
      const missing = [];
      const want = [
        ['src/clock.js', clockMod, ['createClock']],
        ['src/physics.js', physics, ['stepBodies', 'totalEnergy', 'totalMomentum']],
        ['src/collisions.js', collisions, ['mergeCollisions']],
        ['src/snapshot.js', snapshot, ['serialize', 'restore']],
        ['src/camera.js', camera, ['createCamera', 'worldToScreen', 'screenToWorld', 'zoomAt', 'pan']],
        ['src/hud.js', hud, ['formatHud']],
        ['src/simulation.js', simulation, ['createSimulation']],
      ];
      for (const [rel, mod, names] of want) {
        if (!mod) missing.push(`${rel} (did not import)`);
        else for (const n of names) if (typeof mod[n] !== 'function') missing.push(`${rel}#${n}`);
      }
      return ok(missing.length === 0, missing.length ? `missing exports: ${missing.join(', ')}` : null);
    });

    if (clockMod) {
      await check('clock_steps_and_accumulator', () => {
        const c = clockMod.createClock({ stepMs: 16, maxStepsPerAdvance: 8 });
        // 200 ms → 12.5 steps, capped at 8; the 72 ms left over is clamped to one step so a stall cannot queue work up.
        if (c.advance(200) !== 8) return ok(false, 'advance(200) did not return the 8-step cap');
        let s = c.state();
        if (s.simTimeMs !== 128) return ok(false, `simTimeMs after the cap is ${s.simTimeMs}, expected 128`);
        if (s.accumulatorMs !== 16) return ok(false, `leftover accumulator is ${s.accumulatorMs}, expected it clamped to 16`);
        if (c.advance(0) !== 1) return ok(false, 'the clamped remainder did not produce a step on the next advance');
        s = c.state();
        if (s.simTimeMs !== 144 || s.accumulatorMs !== 0) return ok(false, `after draining the remainder: simTimeMs ${s.simTimeMs}, accumulator ${s.accumulatorMs}`);
        if (c.advance(20) !== 1) return ok(false, 'advance(20) did not produce exactly one step');
        s = c.state();
        if (s.simTimeMs !== 160 || s.accumulatorMs !== 4) return ok(false, `sub-step remainder lost: simTimeMs ${s.simTimeMs}, accumulator ${s.accumulatorMs}`);
        if (c.advance(0) !== 0) return ok(false, 'a 4 ms accumulator produced a step');
        if (c.advance(12) !== 1) return ok(false, 'the 4 ms remainder did not carry into the next advance');
        const d = clockMod.createClock();
        if (d.advance(48) !== 3 || d.state().simTimeMs !== 48) return ok(false, 'default stepMs=16 / maxStepsPerAdvance=8 not applied');
        return ok(true, null);
      });

      await check('clock_pause_and_time_scale', () => {
        const c = clockMod.createClock({ stepMs: 16, maxStepsPerAdvance: 8 });
        c.advance(20);
        const before = c.state();
        c.pause();
        if (c.advance(1000) !== 0) return ok(false, 'a paused clock still produced steps');
        const paused = c.state();
        if (paused.paused !== true) return ok(false, 'state().paused is not true after pause()');
        if (paused.simTimeMs !== before.simTimeMs) return ok(false, 'a paused clock advanced simTimeMs');
        if (paused.accumulatorMs !== before.accumulatorMs) return ok(false, 'a paused clock accumulated elapsed time');
        c.resume();
        if (c.state().paused !== false) return ok(false, 'state().paused is not false after resume()');
        if (c.advance(12) !== 1) return ok(false, 'the clock did not resume from the accumulator it kept');
        const t = clockMod.createClock({ stepMs: 16, maxStepsPerAdvance: 8 });
        t.setTimeScale(2);
        if (t.state().timeScale !== 2) return ok(false, 'state().timeScale does not report the scale that was set');
        if (t.advance(24) !== 3 || t.state().simTimeMs !== 48) return ok(false, 'timeScale is not applied to the elapsed time before accumulation');
        if (t.state().accumulatorMs !== 0) return ok(false, `scaled accumulator is ${t.state().accumulatorMs}, expected 0`);
        const half = clockMod.createClock({ stepMs: 16, maxStepsPerAdvance: 8 });
        half.setTimeScale(0.5);
        if (half.advance(16) !== 0 || half.advance(16) !== 1) return ok(false, 'a timeScale below 1 does not slow the clock');
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
          if (!throwsRange(() => t.setTimeScale(bad))) return ok(false, `setTimeScale(${String(bad)}) did not throw RangeError`);
        }
        return ok(true, null);
      });
    }

    if (physics) {
      await check('physics_energy_drift_bounded', () => {
        // Measured on the reference: 3.1e-14 relative over these 20 000 steps, so the declared 1e-4 bound clears the
        // reference by far more than the required ×10 margin (10× measured is 3.1e-13) while the same run under a
        // first-order Euler step drifts 2.7e-3 — 26× over the bound. Collision-free by construction: energy only.
        let bodies = orbit();
        const e0 = physics.totalEnergy(bodies, G);
        for (let i = 0; i < 20000; i += 1) bodies = physics.stepBodies(bodies, 1, G);
        const e1 = physics.totalEnergy(bodies, G);
        const drift = Math.abs((e1 - e0) / e0);
        const p0 = physics.totalMomentum(orbit());
        const p1 = physics.totalMomentum(bodies);
        const scale = M2 * V_REL;
        const momentumHeld = Math.abs(p1.x - p0.x) < 1e-9 * scale && Math.abs(p1.y - p0.y) < 1e-9 * scale;
        if (!Number.isFinite(drift)) return ok(false, 'total energy is not a finite number after 20 000 steps');
        if (!momentumHeld) return ok(false, 'total momentum of the isolated pair changed while integrating');
        return ok(drift < 1e-4, `relative energy drift ${drift.toExponential(3)} over 20 000 steps at dt=1 s (bound 1e-4)`);
      });

      await check('physics_reversible', () => {
        const start = orbit();
        let bodies = start;
        for (let i = 0; i < 20000; i += 1) bodies = physics.stepBodies(bodies, 1, G);
        bodies = bodies.map((b) => ({ ...b, vx: -b.vx, vy: -b.vy }));
        for (let i = 0; i < 20000; i += 1) bodies = physics.stepBodies(bodies, 1, G);
        let worst = 0;
        for (let i = 0; i < start.length; i += 1) {
          worst = Math.max(worst, Math.hypot(bodies[i].x - start[i].x, bodies[i].y - start[i].y) / R);
        }
        return ok(worst < 1e-6, `reversed run returned to within ${worst.toExponential(3)} of the start, relative to r=1000 m (bound 1e-6)`);
      });
    }

    if (collisions) {
      await check('collisions_conserve_mass_and_momentum', () => {
        const input = [
          { id: 'a', mass: 3, x: 0, y: 0, vx: 2, vy: -1, r: 2 },
          { id: 'b', mass: 1, x: 3, y: 0, vx: -4, vy: 3, r: 2 },
          { id: 'far', mass: 5, x: 1000, y: 0, vx: 0, vy: 0, r: 1 },
        ];
        const out = collisions.mergeCollisions(input);
        if (out.length !== 2) return ok(false, `expected 2 bodies after one merge, got ${out.length}`);
        const merged = out.find((b) => b.id === 'a');
        const far = out.find((b) => b.id === 'far');
        if (!merged || !far) return ok(false, `merged body must keep the heavier id 'a'; got ids ${out.map((b) => b.id).join(',')}`);
        if (merged.mass !== 4) return ok(false, `merged mass is ${merged.mass}, expected 3+1`);
        if (!near(merged.vx, (3 * 2 + 1 * -4) / 4, 1e-12) || !near(merged.vy, (3 * -1 + 1 * 3) / 4, 1e-12)) {
          return ok(false, `merge did not conserve momentum: velocity (${merged.vx}, ${merged.vy}), expected (0.5, 0)`);
        }
        if (!near(merged.x, (3 * 0 + 1 * 3) / 4, 1e-12) || !near(merged.y, 0, 1e-12)) return ok(false, `merged position ${merged.x},${merged.y} is not the centre of mass`);
        if (!near(merged.r, Math.sqrt(8), 1e-12)) return ok(false, `merged radius is ${merged.r}, expected sqrt(r1²+r2²)`);
        if (far.mass !== 5 || far.r !== 1) return ok(false, 'a body that overlaps nothing was altered');
        const tie = collisions.mergeCollisions([
          { id: 'z', mass: 2, x: 0, y: 0, vx: 0, vy: 0, r: 2 },
          { id: 'b', mass: 2, x: 1, y: 0, vx: 0, vy: 0, r: 2 },
        ]);
        if (tie.length !== 1 || tie[0].id !== 'b') return ok(false, `an equal-mass merge must keep the lexicographically smaller id, got ${tie.map((b) => b.id).join(',')}`);
        return ok(true, null);
      });

      await check('collisions_transitive_and_order_independent', () => {
        // a—b and b—c overlap, a—c do not: one call must still collapse the whole chain.
        const chain = [
          { id: 'a', mass: 1, x: 0, y: 0, vx: 1, vy: 0, r: 1 },
          { id: 'b', mass: 4, x: 1.5, y: 0, vx: 0, vy: 2, r: 1 },
          { id: 'c', mass: 2, x: 3, y: 0, vx: -3, vy: 0, r: 1 },
          { id: 'd', mass: 9, x: 500, y: 0, vx: 0, vy: 0, r: 1 },
        ];
        const out = collisions.mergeCollisions(chain);
        if (out.length !== 2) return ok(false, `a chain of three overlapping bodies did not merge in one call: ${out.length} bodies left`);
        const merged = out.find((b) => b.id === 'b');
        if (!merged || merged.mass !== 7) return ok(false, `transitive merge gave ids ${out.map((b) => b.id).join(',')} and mass ${merged?.mass}`);
        if (!near(merged.vx, (1 * 1 + 2 * -3) / 7, 1e-12) || !near(merged.vy, (4 * 2) / 7, 1e-12)) return ok(false, 'the transitive merge did not conserve momentum');
        if (!near(merged.r, Math.sqrt(3), 1e-12)) return ok(false, `transitive merge radius is ${merged.r}, expected sqrt(3)`);
        const ids = out.map((b) => b.id);
        if (ids.join(',') !== [...ids].sort().join(',')) return ok(false, `result is not sorted by id: ${ids.join(',')}`);
        const shuffles = [
          [3, 1, 0, 2],
          [2, 0, 3, 1],
          [1, 3, 2, 0],
        ];
        const expected = JSON.stringify(out);
        for (const order of shuffles) {
          const got = JSON.stringify(collisions.mergeCollisions(order.map((i) => ({ ...chain[i] }))));
          if (got !== expected) return ok(false, `input order ${order.join('')} produced a different result: ${got}`);
        }
        return ok(true, null);
      });
    }

    if (snapshot) {
      await check('snapshot_round_trip_exact', () => {
        const state = {
          clock: { simTimeMs: 160, accumulatorMs: 0.1 + 0.2, paused: true, timeScale: 1 / 3 },
          bodies: [
            { id: 'a', mass: 1e12, x: 1 / 3, y: -0.1, vx: 5e-324, vy: 1.7976931348623157e308, r: 1 },
            { id: 'b', mass: 1e3, x: 1000.0000000000001, y: 1e-300, vx: -2.5834086023457461e-7, vy: 0.1 + 0.7, r: 2.5 },
          ],
        };
        const text = snapshot.serialize(state);
        if (typeof text !== 'string') return ok(false, 'serialize did not return a string');
        const back = snapshot.restore(text);
        for (const key of ['simTimeMs', 'accumulatorMs', 'paused', 'timeScale']) {
          if (!Object.is(back.clock?.[key], state.clock[key])) return ok(false, `clock.${key} changed across the round trip: ${state.clock[key]} → ${back.clock?.[key]}`);
        }
        if (back.bodies?.length !== 2) return ok(false, 'restored body count differs');
        for (let i = 0; i < 2; i += 1) {
          for (const key of ['id', 'mass', 'x', 'y', 'vx', 'vy', 'r']) {
            if (!Object.is(back.bodies[i][key], state.bodies[i][key])) return ok(false, `bodies[${i}].${key} is not bit-identical: ${state.bodies[i][key]} → ${back.bodies[i][key]}`);
          }
        }
        if (snapshot.serialize(back) !== text) return ok(false, 'serialize(restore(text)) is not the original text');
        return ok(true, null);
      });

      await check('snapshot_rejects_unknown_fields', () => {
        const text = snapshot.serialize({
          clock: { simTimeMs: 32, accumulatorMs: 4, paused: false, timeScale: 1 },
          bodies: [{ id: 'a', mass: 1, x: 0, y: 0, vx: 0, vy: 0, r: 1 }],
        });
        const parsed = JSON.parse(text);
        const cases = [
          ['top-level', { ...parsed, seed: 7 }],
          ['clock', { ...parsed, clock: { ...parsed.clock, drift: 1 } }],
          ['body', { ...parsed, bodies: [{ ...parsed.bodies[0], colour: 'red' }] }],
        ];
        for (const [where, payload] of cases) {
          if (!throwsSnapshotError(() => snapshot.restore(JSON.stringify(payload)))) return ok(false, `an unknown ${where} field did not raise SnapshotError`);
        }
        if (!throwsSnapshotError(() => snapshot.restore('{not json'))) return ok(false, 'malformed JSON did not raise SnapshotError');
        try {
          snapshot.restore(text);
        } catch (err) {
          return ok(false, `a valid snapshot was rejected: ${err?.message}`);
        }
        return ok(true, null);
      });
    }

    if (camera) {
      await check('camera_transforms_invertible', () => {
        const cams = [
          camera.createCamera({ cx: 0, cy: 0, zoom: 1, viewportW: 800, viewportH: 600 }),
          camera.createCamera({ cx: 1234.5, cy: -678.25, zoom: 0.03125, viewportW: 1920, viewportH: 1080 }),
          camera.createCamera({ cx: -5e5, cy: 5e5, zoom: 64, viewportW: 300, viewportH: 301 }),
        ];
        for (const cam of cams) {
          for (const p of [{ x: 0, y: 0 }, { x: 1e4, y: -1e4 }, { x: 0.125, y: -0.375 }, { x: cam.cx, y: cam.cy }]) {
            const back = camera.screenToWorld(cam, camera.worldToScreen(cam, p));
            if (!near(back.x, p.x, 1e-9) || !near(back.y, p.y, 1e-9)) return ok(false, `world→screen→world moved (${p.x},${p.y}) to (${back.x},${back.y}) at zoom ${cam.zoom}`);
            const s = { x: 17.5, y: -3.25 };
            const backS = camera.worldToScreen(cam, camera.screenToWorld(cam, s));
            if (!near(backS.x, s.x, 1e-9) || !near(backS.y, s.y, 1e-9)) return ok(false, `screen→world→screen moved (${s.x},${s.y}) to (${backS.x},${backS.y}) at zoom ${cam.zoom}`);
          }
          const centre = camera.worldToScreen(cam, { x: cam.cx, y: cam.cy });
          if (!near(centre.x, cam.viewportW / 2, 1e-9) || !near(centre.y, cam.viewportH / 2, 1e-9)) return ok(false, 'the camera centre does not land in the middle of the viewport');
        }
        return ok(true, null);
      });

      await check('camera_zoom_at_keeps_anchor', () => {
        const cam = camera.createCamera({ cx: 40, cy: -20, zoom: 2, viewportW: 800, viewportH: 600 });
        for (const point of [{ x: 0, y: 0 }, { x: 800, y: 600 }, { x: 123.5, y: 47.25 }, { x: 400, y: 300 }]) {
          for (const factor of [2, 0.5, 1.1, 16]) {
            const anchor = camera.screenToWorld(cam, point);
            const next = camera.zoomAt(cam, point, factor);
            if (!near(next.zoom, cam.zoom * factor, 1e-12)) return ok(false, `zoomAt did not multiply the zoom by ${factor}: ${next.zoom}`);
            const after = camera.screenToWorld(next, point);
            if (!near(after.x, anchor.x, 1e-9) || !near(after.y, anchor.y, 1e-9)) {
              return ok(false, `zoomAt ×${factor} at (${point.x},${point.y}) moved the world point under the cursor from (${anchor.x},${anchor.y}) to (${after.x},${after.y})`);
            }
          }
        }
        if (cam.zoom !== 2 || cam.cx !== 40 || cam.cy !== -20) return ok(false, 'zoomAt mutated the camera it was given');
        if (!throwsRange(() => camera.zoomAt(cam, { x: 0, y: 0 }, 0)) || !throwsRange(() => camera.zoomAt(cam, { x: 0, y: 0 }, -2))) return ok(false, 'a zero or negative zoom factor did not throw RangeError');
        return ok(true, null);
      });

      await check('camera_pan_shifts_view', () => {
        const cam = camera.createCamera({ cx: 40, cy: -20, zoom: 4, viewportW: 800, viewportH: 600 });
        const world = { x: 60.5, y: -12.25 };
        const before = camera.worldToScreen(cam, world);
        const moved = camera.pan(cam, 120, -48);
        const after = camera.worldToScreen(moved, world);
        if (!near(after.x, before.x - 120, 1e-9) || !near(after.y, before.y + 48, 1e-9)) {
          return ok(false, `pan(120,-48) shifted the world point by (${after.x - before.x},${after.y - before.y}) screen px, expected (-120,48)`);
        }
        if (moved.zoom !== cam.zoom) return ok(false, 'pan changed the zoom');
        if (cam.cx !== 40 || cam.cy !== -20) return ok(false, 'pan mutated the camera it was given');
        const roundTrip = camera.pan(moved, -120, 48);
        if (!near(roundTrip.cx, cam.cx, 1e-9) || !near(roundTrip.cy, cam.cy, 1e-9)) return ok(false, 'panning back did not return the camera to where it started');
        return ok(true, null);
      });
    }

    if (hud) {
      await check('hud_formats_exact_strings', () => {
        const cases = [
          [{ simTimeMs: 83456, timeScale: 2, paused: true, bodyCount: 12, energy: -123400 }, 'T+00:01:23.456 x2.0 PAUSED bodies=12 E=-1.234e+5'],
          [{ simTimeMs: 0, timeScale: 1, paused: false, bodyCount: 0, energy: 0 }, 'T+00:00:00.000 x1.0 RUNNING bodies=0 E=0.000e+0'],
          [{ simTimeMs: 45296789, timeScale: 0.5, paused: false, bodyCount: 3, energy: 6.674e-11 }, 'T+12:34:56.789 x0.5 RUNNING bodies=3 E=6.674e-11'],
          [{ simTimeMs: 359999999, timeScale: 10, paused: true, bodyCount: 1, energy: 1 }, 'T+99:59:59.999 x10.0 PAUSED bodies=1 E=1.000e+0'],
        ];
        for (const [input, expected] of cases) {
          const got = hud.formatHud(input);
          if (got !== expected) return ok(false, `formatHud(${JSON.stringify(input)}) returned ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
        }
        return ok(true, null);
      });
    }

    if (simulation) {
      const config = () => ({ bodies: trio(), G, stepMs: 16, maxStepsPerAdvance: 8 });

      await check('simulation_replay_bit_identical', () => {
        const a = simulation.createSimulation(config());
        const b = simulation.createSimulation(config());
        let steps = 0;
        for (let i = 0; i < 1250; i += 1) {
          const sa = a.advance(128);
          const sb = b.advance(128);
          if (sa !== sb) return ok(false, `the two runs disagreed on the step count at advance ${i}: ${sa} vs ${sb}`);
          steps += sa;
        }
        if (steps !== 10000) return ok(false, `1250 × advance(128) produced ${steps} steps, expected 10 000`);
        if (a.clock().state().simTimeMs !== 160000) return ok(false, `simTimeMs after 10 000 steps is ${a.clock().state().simTimeMs}, expected 160000`);
        const left = JSON.stringify(a.bodies());
        if (left !== JSON.stringify(b.bodies())) return ok(false, 'two identical runs produced different doubles after 10 000 steps');
        if (left !== JSON.stringify(a.bodies())) return ok(false, 'bodies() is not stable between calls');
        const bodies = a.bodies();
        if (bodies.length !== 3 || !bodies.every((x) => Number.isFinite(x.x) && Number.isFinite(x.vx))) return ok(false, 'the 10 000-step run did not leave three finite bodies');
        if (JSON.stringify(bodies) === JSON.stringify(trio())) return ok(false, 'the simulation did not move the bodies at all');
        return ok(true, null);
      });

      await check('simulation_restore_continues_run', () => {
        const straight = simulation.createSimulation(config());
        const interrupted = simulation.createSimulation(config());
        // 100 ms is not a whole number of 16 ms steps, so the accumulator is non-zero when the snapshot is taken.
        for (let i = 0; i < 500; i += 1) {
          straight.advance(100);
          interrupted.advance(100);
        }
        const text = interrupted.snapshot();
        if (typeof text !== 'string') return ok(false, 'snapshot() did not return a string');
        const resumed = simulation.createSimulation({ ...config(), bodies: [{ id: 'zz', mass: 1, x: 5, y: 5, vx: 0, vy: 0, r: 1 }] });
        resumed.restoreFrom(text);
        if (JSON.stringify(resumed.bodies()) !== JSON.stringify(interrupted.bodies())) return ok(false, 'restoreFrom did not reproduce the bodies the snapshot was taken from');
        if (JSON.stringify(resumed.clock().state()) !== JSON.stringify(interrupted.clock().state())) {
          return ok(false, `restoreFrom did not reproduce the clock: ${JSON.stringify(resumed.clock().state())} vs ${JSON.stringify(interrupted.clock().state())}`);
        }
        for (let i = 0; i < 500; i += 1) {
          straight.advance(100);
          resumed.advance(100);
        }
        if (JSON.stringify(resumed.bodies()) !== JSON.stringify(straight.bodies())) return ok(false, 'a run continued from a restored snapshot diverged from the uninterrupted run');
        if (JSON.stringify(resumed.clock().state()) !== JSON.stringify(straight.clock().state())) return ok(false, 'the restored clock diverged from the uninterrupted run');
        return ok(true, null);
      });
    }

    await check('test_suite_passes', () => runTests());
  },
);
