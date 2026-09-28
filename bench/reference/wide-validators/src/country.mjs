/** Validates the country section of a submission. */
export const validateCountry = (submission) => {
  const entries = submission?.countrys;
  if (!Array.isArray(entries)) return { ok: false, field: 'country', reason: 'missing' };
  if (entries.length === 0) return { ok: false, field: 'country', reason: 'empty' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'country', reason: 'blank' };
  }
  return { ok: true, field: 'country', count: entries.length };
};
