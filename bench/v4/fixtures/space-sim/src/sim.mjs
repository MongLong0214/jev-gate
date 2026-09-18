// Minimal 2D gravity simulation core. Public API: createSimulation({ bodies }) -> { step(dtMs), state() }
// Bodies: { id, x, y, vx, vy, mass }. Units: px, px/s, kg-ish. Deterministic given identical inputs.
const G = 50;

export function createSimulation({ bodies }) {
  const state = { timeMs: 0, bodies: bodies.map((b) => ({ ...b })) };

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

  return { step, state: () => ({ timeMs: state.timeMs, bodies: state.bodies.map((b) => ({ ...b })) }) };
}
