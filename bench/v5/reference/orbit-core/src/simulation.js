import { createClock } from './clock.js';
import { mergeCollisions } from './collisions.js';
import { stepBodies } from './physics.js';
import { restore, serialize } from './snapshot.js';

/** Clock + integrator + merge in one deterministic loop: the same advance sequence always produces the same doubles. */
export const createSimulation = ({ bodies, G, stepMs = 16, maxStepsPerAdvance = 8 }) => {
  if (!Array.isArray(bodies)) throw new RangeError('bodies must be an array');
  if (!Number.isFinite(G)) throw new RangeError('G must be a finite number');
  let clock = createClock({ stepMs, maxStepsPerAdvance });
  let current = bodies.map((b) => ({ ...b }));
  const dtSeconds = stepMs / 1000;
  return {
    advance(elapsedMs) {
      const steps = clock.advance(elapsedMs);
      for (let i = 0; i < steps; i += 1) current = mergeCollisions(stepBodies(current, dtSeconds, G));
      return steps;
    },
    snapshot: () => serialize({ clock: clock.state(), bodies: current }),
    restoreFrom(text) {
      const state = restore(text);
      clock = createClock({ stepMs, maxStepsPerAdvance, ...state.clock });
      current = state.bodies;
    },
    bodies: () => current.map((b) => ({ ...b })),
    clock: () => clock,
  };
};
