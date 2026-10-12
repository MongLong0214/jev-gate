import { formatDuration } from './format-duration.mjs';
import { parseDuration } from './parse-duration.mjs';

const MAX = 3_600_000;

export const parseTimeoutOption = (value) => {
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : parseDuration(value);
  if (ms === 0) throw new RangeError('timeout must be positive');
  if (ms > MAX) throw new RangeError(`timeout too long: ${formatDuration(ms)}`);
  return ms;
};
