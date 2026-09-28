/** Validates the postcode section of a submission. */
export const validatePostcode = (submission) => {
  const entries = submission?.postcodes;
  if (!Array.isArray(entries)) return { ok: false, field: 'postcode', reason: 'missing' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'postcode', reason: 'blank' };
  }
  return { ok: true, field: 'postcode', count: entries.length };
};
