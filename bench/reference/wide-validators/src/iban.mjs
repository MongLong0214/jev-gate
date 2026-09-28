/** Validates the iban section of a submission. */
export const validateIban = (submission) => {
  const entries = submission?.ibans;
  if (!Array.isArray(entries)) return { ok: false, field: 'iban', reason: 'missing' };
  if (entries.length === 0) return { ok: false, field: 'iban', reason: 'empty' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'iban', reason: 'blank' };
  }
  return { ok: true, field: 'iban', count: entries.length };
};
