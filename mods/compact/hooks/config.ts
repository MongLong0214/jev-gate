export type CompactMode = 'shadow' | 'active';

export interface CompactConfig {
  enabled: boolean;
  mode: CompactMode;
  budgetChars: number;
  subagents: boolean;
  manual: boolean;
}

export type CompactConfigResult = { ok: true; config: CompactConfig } | { ok: false; field: string };

type Options = Readonly<Record<string, unknown>>;

export const BUDGET_MIN = 8000;
export const BUDGET_MAX = 400000;

/** A wrong type or an out-of-range number turns the module off rather than guessing; the diagnostic names the field only. */
export const resolveCompactConfig = (options: Options | undefined): CompactConfigResult => {
  const o = options ?? {};
  const bool = (k: string, d: boolean): boolean | null => (o[k] === undefined ? d : typeof o[k] === 'boolean' ? (o[k] as boolean) : null);
  const enabled = bool('enabled', true);
  if (enabled === null) return { ok: false, field: 'enabled' };
  const mode = o['mode'] === undefined ? 'active' : o['mode'];
  if (mode !== 'shadow' && mode !== 'active') return { ok: false, field: 'mode' };
  const budget = o['budgetChars'] === undefined ? 40000 : o['budgetChars'];
  if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < BUDGET_MIN || budget > BUDGET_MAX) return { ok: false, field: 'budgetChars' };
  const subagents = bool('compactSubagents', true);
  if (subagents === null) return { ok: false, field: 'compactSubagents' };
  const manual = bool('compactManual', false);
  if (manual === null) return { ok: false, field: 'compactManual' };
  return { ok: true, config: { enabled, mode, budgetChars: budget, subagents, manual } };
};
