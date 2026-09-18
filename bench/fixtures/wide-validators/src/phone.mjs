/** Validates the phone section of a submission. */
export const validatePhone = (submission) => {
  const entries = submission?.phones;
  if (!Array.isArray(entries)) return { ok: false, field: 'phone', reason: 'missing' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'phone', reason: 'blank' };
  }
  return { ok: true, field: 'phone', count: entries.length };
};
