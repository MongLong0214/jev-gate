const UNITS = { s: 1000, m: 60_000, h: 3_600_000 };

export const parseDuration = (text) => {
  const m = /^(\d+)(s|m|h)$/.exec(text);
  if (!m) throw new TypeError(`invalid duration: ${text}`);
  return Number(m[1]) * UNITS[m[2]];
};
