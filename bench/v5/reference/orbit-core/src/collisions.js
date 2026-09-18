// Inelastic merge of overlapping bodies. The overlap graph is built once from the input, so the result is the set of
// connected components merged in one call; sums run in id order so the doubles do not depend on the input order.
const merge = (group) => {
  const members = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let mass = 0;
  let px = 0;
  let py = 0;
  let mx = 0;
  let my = 0;
  let r2 = 0;
  for (const b of members) {
    mass += b.mass;
    px += b.mass * b.vx;
    py += b.mass * b.vy;
    mx += b.mass * b.x;
    my += b.mass * b.y;
    r2 += b.r * b.r;
  }
  let heaviest = members[0];
  for (const b of members) if (b.mass > heaviest.mass) heaviest = b;
  return { id: heaviest.id, mass, x: mx / mass, y: my / mass, vx: px / mass, vy: py / mass, r: Math.sqrt(r2) };
};

export const mergeCollisions = (bodies) => {
  const n = bodies.length;
  const parent = bodies.map((_, i) => i);
  const find = (i) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const dx = bodies[j].x - bodies[i].x;
      const dy = bodies[j].y - bodies[i].y;
      if (Math.sqrt(dx * dx + dy * dy) < bodies[i].r + bodies[j].r) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(bodies[i]);
  }
  return [...groups.values()]
    .map((g) => (g.length === 1 ? { ...g[0] } : merge(g)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};
