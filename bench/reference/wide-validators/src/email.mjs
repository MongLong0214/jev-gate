/** Validates the email section of a submission. */
export const validateEmail = (submission) => {
  const entries = submission?.emails;
  if (!Array.isArray(entries)) return { ok: false, field: 'email', reason: 'missing' };
  if (entries.length === 0) return { ok: false, field: 'email', reason: 'empty' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'email', reason: 'blank' };
  }
  return { ok: true, field: 'email', count: entries.length };
};
