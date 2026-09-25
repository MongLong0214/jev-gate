import { aliasFamily, factsOf } from './models.ts';
import type { ModelTier } from './policy.ts';
import { TIER_ORDER } from './policy.ts';

/**
 * The option contract (#40), read from the manifest's userConfig as `register(on, options)` receives it. A wrong
 * type or an out-of-range number turns the whole Router off rather than guessing what was meant; the diagnostic
 * names the field, never its value.
 */
export interface RouterConfig {
  enabled: boolean;
  routeSubagentModel: boolean;
  routeMainEffort: boolean;
  routeMainModel: boolean;
  /** An explicit key always wins; an invalid one never falls back to the environment's. */
  explicitKey: { kind: 'absent' } | { kind: 'valid'; value: string } | { kind: 'invalid' };
  /** Only the valid, unambiguous profile mappings. Empty when the mapping as a whole is ambiguous. */
  tiers: Partial<Record<ModelTier, string>>;
  /** Profiles dropped, and why, for the once-per-session diagnostic. */
  tierIssues: Array<{ tier: ModelTier; reason: 'invalid' | 'unknown_model' | 'ambiguous' }>;
  minUpgradeConfidence: number;
  minDowngradeConfidence: number;
  timeoutMs: number;
  logDecisions: boolean;
}

export type ConfigResult = { ok: true; config: RouterConfig } | { ok: false; field: string };

type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>;

const DEFAULT_TIERS: Record<Exclude<ModelTier, 'frontier'>, string> = { fast: 'haiku', standard: 'sonnet', deep: 'opus' };
const TIER_FIELDS: Record<ModelTier, string> = { fast: 'fastModel', standard: 'standardModel', deep: 'deepModel', frontier: 'frontierModel' };

/** Visible ASCII only: anything else cannot ride in a header, and is not echoed to say so. */
const HEADER_SAFE_KEY = /^[\x21-\x7e]{8,1024}$/;
/** A model identifier as the host spells one, with an optional bracketed suffix; models.ts decides whether it is known. */
const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}(?:\[[A-Za-z0-9._-]{1,16}\])?$/;

export const validKey = (value: string): boolean => HEADER_SAFE_KEY.test(value);

export const resolveConfig = (options: Options): ConfigResult => {
  const bool = (field: string, fallback: boolean): boolean | null => {
    const v = options[field];
    if (v === undefined) return fallback;
    return typeof v === 'boolean' ? v : null;
  };
  const num = (field: string, fallback: number, min: number, max: number): number | null => {
    const v = options[field];
    if (v === undefined) return fallback;
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
  };

  const enabled = bool('enabled', false);
  if (enabled === null) return { ok: false, field: 'enabled' };
  const routeSubagentModel = bool('routeSubagentModel', true);
  if (routeSubagentModel === null) return { ok: false, field: 'routeSubagentModel' };
  const routeMainEffort = bool('routeMainEffort', true);
  if (routeMainEffort === null) return { ok: false, field: 'routeMainEffort' };
  const routeMainModel = bool('routeMainModel', false);
  if (routeMainModel === null) return { ok: false, field: 'routeMainModel' };
  const logDecisions = bool('logDecisions', true);
  if (logDecisions === null) return { ok: false, field: 'logDecisions' };
  // A floor at or under one half would let a coin flip move a model.
  const minUpgradeConfidence = num('minUpgradeConfidence', 0.8, 0.5, 1);
  if (minUpgradeConfidence === null) return { ok: false, field: 'minUpgradeConfidence' };
  const minDowngradeConfidence = num('minDowngradeConfidence', 0.9, 0.5, 1);
  if (minDowngradeConfidence === null) return { ok: false, field: 'minDowngradeConfidence' };
  const timeoutMs = num('timeoutMs', 800, 50, 30_000);
  if (timeoutMs === null) return { ok: false, field: 'timeoutMs' };

  const rawKey = options['typesafeApiKey'];
  let explicitKey: RouterConfig['explicitKey'];
  if (rawKey === undefined || (typeof rawKey === 'string' && rawKey.trim() === '')) explicitKey = { kind: 'absent' };
  else if (typeof rawKey === 'string' && validKey(rawKey)) explicitKey = { kind: 'valid', value: rawKey };
  else explicitKey = { kind: 'invalid' };

  const tierIssues: RouterConfig['tierIssues'] = [];
  const candidate: Partial<Record<ModelTier, string>> = {};
  for (const tier of TIER_ORDER) {
    const v = options[TIER_FIELDS[tier]];
    // Frontier has no default: absent or blank is simply not configured.
    const value = tier === 'frontier' ? (typeof v === 'string' && v.trim() === '' ? undefined : v) : (v ?? DEFAULT_TIERS[tier]);
    if (value === undefined) continue;
    if (typeof value !== 'string' || !MODEL_VALUE.test(value)) {
      tierIssues.push({ tier, reason: 'invalid' });
      continue;
    }
    // Frontier exists only as an exact, verified identifier; an unknown optional profile cannot authorize a change.
    const known = tier === 'frontier' ? factsOf(value) !== null && aliasFamily(value) === null : factsOf(value) !== null || aliasFamily(value) !== null;
    if (!known) {
      tierIssues.push({ tier, reason: 'unknown_model' });
      continue;
    }
    candidate[tier] = value;
  }
  // Two profiles naming one model family make every rank lookup a guess, so none is made.
  const families = Object.values(candidate).map((v) => factsOf(v)?.family ?? aliasFamily(v));
  const ambiguous = new Set(families).size !== families.length;
  if (ambiguous) for (const tier of TIER_ORDER.filter((t) => candidate[t] !== undefined)) tierIssues.push({ tier, reason: 'ambiguous' });

  return {
    ok: true,
    config: {
      enabled,
      routeSubagentModel,
      routeMainEffort,
      routeMainModel,
      explicitKey,
      tiers: ambiguous ? {} : candidate,
      tierIssues,
      minUpgradeConfidence,
      minDowngradeConfidence,
      timeoutMs,
      logDecisions,
    },
  };
};

/** Whether anything would run at all. Off, or every switch off, registers nothing and reads nothing. */
export const anyRouting = (c: RouterConfig): boolean => c.enabled && (c.routeSubagentModel || c.routeMainEffort || c.routeMainModel);
