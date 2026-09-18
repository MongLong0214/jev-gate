// 중력 적분기. 현재는 1차 오일러법이라 궤도가 조금씩 부풀어 오른다.
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

export const stepBodies = (bodies, dtSeconds, G) => {
  const a = accelerations(bodies, G);
  return bodies.map((b, i) => ({
    ...b,
    x: b.x + b.vx * dtSeconds,
    y: b.y + b.vy * dtSeconds,
    vx: b.vx + a[i].ax * dtSeconds,
    vy: b.vy + a[i].ay * dtSeconds,
  }));
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
