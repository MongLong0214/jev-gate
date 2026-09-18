// Fixed-step clock. Real elapsed time enters an accumulator scaled by timeScale; whole steps of stepMs come out.
// The optional initial state (simTimeMs/accumulatorMs/paused/timeScale) exists so a restored snapshot can rebuild a clock.
export const createClock = ({ stepMs = 16, maxStepsPerAdvance = 8, simTimeMs = 0, accumulatorMs = 0, paused = false, timeScale = 1 } = {}) => {
  if (!Number.isFinite(stepMs) || stepMs <= 0) throw new RangeError('stepMs must be a finite positive number');
  if (!Number.isInteger(maxStepsPerAdvance) || maxStepsPerAdvance <= 0) throw new RangeError('maxStepsPerAdvance must be a positive integer');
  if (!Number.isFinite(timeScale) || timeScale <= 0) throw new RangeError('timeScale must be a finite positive number');
  const s = { simTimeMs, accumulatorMs, paused: Boolean(paused), timeScale };
  return {
    advance(elapsedMs) {
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError('elapsedMs must be a finite non-negative number');
      if (s.paused) return 0;
      s.accumulatorMs += elapsedMs * s.timeScale;
      let steps = 0;
      while (s.accumulatorMs >= stepMs && steps < maxStepsPerAdvance) {
        s.accumulatorMs -= stepMs;
        s.simTimeMs += stepMs;
        steps += 1;
      }
      // Spiral-of-death guard: whatever the cap left behind never exceeds one step, so a long stall cannot queue work forever.
      if (s.accumulatorMs > stepMs) s.accumulatorMs = stepMs;
      return steps;
    },
    pause() { s.paused = true; },
    resume() { s.paused = false; },
    setTimeScale(x) {
      if (!Number.isFinite(x) || x <= 0) throw new RangeError('timeScale must be a finite positive number');
      s.timeScale = x;
    },
    state: () => ({ simTimeMs: s.simTimeMs, accumulatorMs: s.accumulatorMs, paused: s.paused, timeScale: s.timeScale }),
  };
};
