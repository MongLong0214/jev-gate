const pad = (value, width) => String(value).padStart(width, '0');

/** `T+HH:MM:SS.mmm x<1 decimal> <PAUSED|RUNNING> bodies=<n> E=<exponential, 3 decimals>` — byte for byte. */
export const formatHud = ({ simTimeMs, timeScale, paused, bodyCount, energy }) => {
  const total = Math.floor(simTimeMs);
  const clock = `${pad(Math.floor(total / 3600000), 2)}:${pad(Math.floor(total / 60000) % 60, 2)}:${pad(Math.floor(total / 1000) % 60, 2)}.${pad(total % 1000, 3)}`;
  return `T+${clock} x${timeScale.toFixed(1)} ${paused ? 'PAUSED' : 'RUNNING'} bodies=${bodyCount} E=${energy.toExponential(3)}`;
};
