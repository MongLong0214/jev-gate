/** Validates the currency section of a submission. */
export const validateCurrency = (submission) => {
  const entries = submission?.currencys;
  if (!Array.isArray(entries)) return { ok: false, field: 'currency', reason: 'missing' };
  if (entries.length === 0) return { ok: false, field: 'currency', reason: 'empty' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'currency', reason: 'blank' };
  }
  return { ok: true, field: 'currency', count: entries.length };
};
