const G = 50;
const FIXED_STEP_MS = 10;

export function createSimulation({ bodies, initialBodies } = {}) {
  const source = bodies ?? initialBodies ?? [];
  const state = { timeMs: 0, bodies: source.map((b) => ({ ...b })), paused: false, timeScale: 1, accumulatorMs: 0 };

  function step(dtMs) {
    const dt = dtMs / 1000;
    for (const a of state.bodies) {
      let ax = 0;
      let ay = 0;
      for (const b of state.bodies) {
        if (a === b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = Math.max(dx * dx + dy * dy, 25);
        const f = (G * b.mass) / d2;
        const d = Math.sqrt(d2);
        ax += (f * dx) / d;
        ay += (f * dy) / d;
      }
      a.vx += ax * dt;
      a.vy += ay * dt;
    }
    for (const a of state.bodies) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
    }
    state.timeMs += dtMs;
  }

  /** Deterministic wall-clock driver: fixed 10 ms sub-steps scaled by timeScale; no progress while paused. */
  function advance(realDeltaMs) {
    if (state.paused || !(realDeltaMs > 0)) return;
    state.accumulatorMs += realDeltaMs * state.timeScale;
    while (state.accumulatorMs >= FIXED_STEP_MS) {
      step(FIXED_STEP_MS);
      state.accumulatorMs -= FIXED_STEP_MS;
    }
  }

  return {
    step,
    advance,
    pause() { state.paused = true; },
    resume() { state.paused = false; },
    togglePause() { state.paused = !state.paused; return state.paused; },
    setTimeScale(s) { if (!(s > 0) || !Number.isFinite(s)) throw new RangeError('timeScale must be a positive finite number'); state.timeScale = s; },
    state: () => ({ timeMs: state.timeMs, paused: state.paused, timeScale: state.timeScale, bodies: state.bodies.map((b) => ({ ...b })) }),
  };
}
