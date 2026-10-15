/** The one plugin's option name for each option here (hooks/register.ts joins them with the router's); the command hooks read them as CLAUDE_PLUGIN_OPTION_<NAME>. */
export const COMPACT_OPTION_NAMES = { enabled: 'compactEnabled', mode: 'compactMode', budgetChars: 'compactBudgetChars', compactSubagents: 'compactSubagents', compactManual: 'compactManual', jevEnabled: 'compactJevEnabled', jevTimeoutMs: 'compactJevTimeoutMs' } as const;

export type CompactMode = 'shadow' | 'active';

export interface CompactConfig {
  enabled: boolean;
  mode: CompactMode;
  budgetChars: number;
  subagents: boolean;
  manual: boolean;
  jevEnabled?: boolean;
  jevTimeoutMs?: number;
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
  const manual = bool('compactManual', true);
  if (manual === null) return { ok: false, field: 'compactManual' };
  const jevEnabled = bool('jevEnabled', true);
  if (jevEnabled === null) return { ok: false, field: 'jevEnabled' };
  const jevTimeoutMs = o['jevTimeoutMs'] ?? 1000;
  if (typeof jevTimeoutMs !== 'number' || !Number.isInteger(jevTimeoutMs) || jevTimeoutMs < 50 || jevTimeoutMs > 3500) return { ok: false, field: 'jevTimeoutMs' };
  return { ok: true, config: { enabled, mode, budgetChars: budget, subagents, manual, jevEnabled, jevTimeoutMs } };
};
