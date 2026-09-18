/** Validates the timezone section of a submission. */
export const validateTimezone = (submission) => {
  const entries = submission?.timezones;
  if (!Array.isArray(entries)) return { ok: false, field: 'timezone', reason: 'missing' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'timezone', reason: 'blank' };
  }
  return { ok: true, field: 'timezone', count: entries.length };
};
