/** Validates the duns section of a submission. */
export const validateDuns = (submission) => {
  const entries = submission?.dunss;
  if (!Array.isArray(entries)) return { ok: false, field: 'duns', reason: 'missing' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'duns', reason: 'blank' };
  }
  return { ok: true, field: 'duns', count: entries.length };
};
