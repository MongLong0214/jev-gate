// JSON snapshot with a closed schema: every key is checked, so an unknown or missing field is a SnapshotError rather
// than a silently half-restored world. JSON.stringify/parse round-trips a double exactly, so no extra encoding is needed.
const TOP_KEYS = ['version', 'clock', 'bodies'];
const CLOCK_KEYS = ['simTimeMs', 'accumulatorMs', 'paused', 'timeScale'];
const BODY_KEYS = ['id', 'mass', 'x', 'y', 'vx', 'vy', 'r'];

const fail = (message) => {
  const error = new Error(message);
  error.name = 'SnapshotError';
  throw error;
};

const shape = (value, keys, where) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`unknown field ${where}.${key}`);
  for (const key of keys) if (!(key in value)) fail(`missing field ${where}.${key}`);
};

const num = (value, where) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${where} must be a finite number`);
  return value;
};

export const serialize = ({ clock, bodies }) =>
  JSON.stringify({
    version: 1,
    clock: { simTimeMs: clock.simTimeMs, accumulatorMs: clock.accumulatorMs, paused: clock.paused, timeScale: clock.timeScale },
    bodies: bodies.map((b) => ({ id: b.id, mass: b.mass, x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.r })),
  });

export const restore = (text) => {
  if (typeof text !== 'string') fail('snapshot must be a string');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`snapshot is not valid JSON: ${err.message}`);
  }
  shape(parsed, TOP_KEYS, 'snapshot');
  if (parsed.version !== 1) fail(`unsupported snapshot version ${String(parsed.version)}`);
  shape(parsed.clock, CLOCK_KEYS, 'snapshot.clock');
  if (typeof parsed.clock.paused !== 'boolean') fail('snapshot.clock.paused must be a boolean');
  if (!Array.isArray(parsed.bodies)) fail('snapshot.bodies must be an array');
  return {
    clock: {
      simTimeMs: num(parsed.clock.simTimeMs, 'snapshot.clock.simTimeMs'),
      accumulatorMs: num(parsed.clock.accumulatorMs, 'snapshot.clock.accumulatorMs'),
      paused: parsed.clock.paused,
      timeScale: num(parsed.clock.timeScale, 'snapshot.clock.timeScale'),
    },
    bodies: parsed.bodies.map((b, i) => {
      shape(b, BODY_KEYS, `snapshot.bodies[${i}]`);
      if (typeof b.id !== 'string') fail(`snapshot.bodies[${i}].id must be a string`);
      return {
        id: b.id,
        mass: num(b.mass, `snapshot.bodies[${i}].mass`),
        x: num(b.x, `snapshot.bodies[${i}].x`),
        y: num(b.y, `snapshot.bodies[${i}].y`),
        vx: num(b.vx, `snapshot.bodies[${i}].vx`),
        vy: num(b.vy, `snapshot.bodies[${i}].vy`),
        r: num(b.r, `snapshot.bodies[${i}].r`),
      };
    }),
  };
};
