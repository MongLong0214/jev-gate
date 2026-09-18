/** Validates the swift section of a submission. */
export const validateSwift = (submission) => {
  const entries = submission?.swifts;
  if (!Array.isArray(entries)) return { ok: false, field: 'swift', reason: 'missing' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'swift', reason: 'blank' };
  }
  return { ok: true, field: 'swift', count: entries.length };
};
