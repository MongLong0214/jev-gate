/** Validates the locale section of a submission. */
export const validateLocale = (submission) => {
  const entries = submission?.locales;
  if (!Array.isArray(entries)) return { ok: false, field: 'locale', reason: 'missing' };
  if (entries.length === 0) return { ok: false, field: 'locale', reason: 'empty' };
  for (const e of entries) {
    if (typeof e !== 'string' || e.trim().length === 0) return { ok: false, field: 'locale', reason: 'blank' };
  }
  return { ok: true, field: 'locale', count: entries.length };
};
