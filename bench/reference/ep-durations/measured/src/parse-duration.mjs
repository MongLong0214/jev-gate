const UNITS = [['h', 3_600_000], ['m', 60_000], ['s', 1000], ['ms', 1]];
const PATTERN = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/;

export const parseDuration = (text) => {
  const m = typeof text === 'string' ? PATTERN.exec(text) : null;
  if (!m || text === '') throw new TypeError(`invalid duration: ${text}`);
  return UNITS.reduce((total, [, ms], i) => total + Number(m[i + 1] ?? 0) * ms, 0);
};
