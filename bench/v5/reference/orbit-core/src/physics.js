// Pure Newtonian gravity in SI units, no softening. Every function takes G from the caller and returns new objects.
const accelerations = (bodies, G) =>
  bodies.map((a) => {
    let ax = 0;
    let ay = 0;
    for (const b of bodies) {
      if (b === a) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      const d = Math.sqrt(d2);
      const k = (G * b.mass) / (d2 * d);
      ax += k * dx;
      ay += k * dy;
    }
    return { ax, ay };
  });

/** Velocity-Verlet, kick-drift-kick: half kick, full drift, recompute acceleration, half kick. Symplectic and reversible. */
export const stepBodies = (bodies, dtSeconds, G) => {
  const a0 = accelerations(bodies, G);
  const drifted = bodies.map((b, i) => {
    const vx = b.vx + a0[i].ax * dtSeconds * 0.5;
    const vy = b.vy + a0[i].ay * dtSeconds * 0.5;
    return { ...b, vx, vy, x: b.x + vx * dtSeconds, y: b.y + vy * dtSeconds };
  });
  const a1 = accelerations(drifted, G);
  return drifted.map((b, i) => ({ ...b, vx: b.vx + a1[i].ax * dtSeconds * 0.5, vy: b.vy + a1[i].ay * dtSeconds * 0.5 }));
};

export const totalEnergy = (bodies, G) => {
  let e = 0;
  for (const b of bodies) e += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const dx = bodies[j].x - bodies[i].x;
      const dy = bodies[j].y - bodies[i].y;
      e -= (G * bodies[i].mass * bodies[j].mass) / Math.sqrt(dx * dx + dy * dy);
    }
  }
  return e;
};

export const totalMomentum = (bodies) => {
  let x = 0;
  let y = 0;
  for (const b of bodies) {
    x += b.mass * b.vx;
    y += b.mass * b.vy;
  }
  return { x, y };
};
