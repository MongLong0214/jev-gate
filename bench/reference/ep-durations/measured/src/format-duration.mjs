const UNITS = [['h', 3_600_000], ['m', 60_000], ['s', 1000], ['ms', 1]];

export const formatDuration = (ms) => {
  if (ms === 0) return '0ms';
  let rest = ms;
  let out = '';
  for (const [unit, size] of UNITS) {
    const n = Math.floor(rest / size);
    if (n > 0) out += `${n}${unit}`;
    rest -= n * size;
  }
  return out;
};
