/** Validates the tax section of a submission. */
export const validateTax = (submission) => {
  const entries = submission?.taxs;
  if (!Array.isArray(entries)) return { ok: false, field: 'tax', reason: 'missing' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'tax', reason: 'blank' };
  }
  return { ok: true, field: 'tax', count: entries.length };
};
