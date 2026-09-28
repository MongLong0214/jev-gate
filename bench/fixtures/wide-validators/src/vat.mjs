/** Validates the vat section of a submission. */
export const validateVat = (submission) => {
  const entries = submission?.vats;
  if (!Array.isArray(entries)) return { ok: false, field: 'vat', reason: 'missing' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'vat', reason: 'blank' };
  }
  return { ok: true, field: 'vat', count: entries.length };
};
