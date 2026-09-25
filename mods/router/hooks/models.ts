/**
 * Exact-model facts the policy is allowed to rely on. Source: the Claude platform model overview and effort pages,
 * read 2026-09-25. A model absent from this table has unknown rank, capacity and effort support, and nothing here
 * guesses them: its model and effort stay native.
 */
export type SymbolicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_ORDER: readonly SymbolicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable';

export interface ModelFacts {
  /** Every full identifier the host may send for this model, matched exactly after a bracketed suffix is set aside. */
  ids: readonly string[];
  family: Family;
  contextTokens: number;
  /** Levels valid under every thinking mode the model accepts. Empty when the model takes no effort at all. */
  unconditionalEffort: readonly SymbolicEffort[];
  /**
   * Levels valid only under some thinking mode. The retained mode is not visible at the hook, so these are never
   * offered; a conditional current level may still be reduced to an unconditional one.
   */
  conditionalEffort: readonly SymbolicEffort[];
}

export const MODEL_FACTS: readonly ModelFacts[] = [
  // Adaptive thinking is always on, so no thinking-disabled request exists to make xhigh or max invalid.
  { ids: ['claude-fable-5-1'], family: 'fable', contextTokens: 1_000_000, unconditionalEffort: ['low', 'medium', 'high', 'xhigh', 'max'], conditionalEffort: [] },
  { ids: ['claude-opus-5-5'], family: 'opus', contextTokens: 1_000_000, unconditionalEffort: ['low', 'medium', 'high', 'xhigh', 'max'], conditionalEffort: [] },
  // Thinking can be turned off here, and the documented Opus 5 case rejects xhigh/max without it.
  { ids: ['claude-sonnet-5'], family: 'sonnet', contextTokens: 1_000_000, unconditionalEffort: ['low', 'medium', 'high'], conditionalEffort: ['xhigh', 'max'] },
  // No effort parameter at all.
  { ids: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'], family: 'haiku', contextTokens: 200_000, unconditionalEffort: [], conditionalEffort: [] },
];

/** The aliases the Agent tool resolves itself. Root requests never receive one of these. */
const SPAWN_ALIASES: Readonly<Record<string, Family>> = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' };

/** `claude-opus-5-5[1m]` → base `claude-opus-5-5`, suffix `[1m]`. The suffix is kept wherever the ID is kept. */
export const splitModelId = (id: string): { base: string; suffix: string } => {
  const m = /^(.*?)(\[[^\]]*\])$/.exec(id);
  return m ? { base: m[1] ?? id, suffix: m[2] ?? '' } : { base: id, suffix: '' };
};

export const factsOf = (id: string): ModelFacts | null => {
  const { base } = splitModelId(id);
  return MODEL_FACTS.find((f) => f.ids.includes(base)) ?? null;
};

export const aliasFamily = (value: string): Family | null => SPAWN_ALIASES[value] ?? null;

/**
 * Whether an observed model is the one that was requested. Only identities this table can vouch for are equivalent:
 * an alias matches its family, a full ID matches its own entry. Anything else is compared exactly, and an unknown
 * observation is not a match.
 */
export const sameModel = (requested: string, observed: string): boolean => {
  if (requested === observed) return true;
  const seen = factsOf(observed);
  if (!seen) return false;
  const family = aliasFamily(requested);
  if (family) return seen.family === family;
  return factsOf(requested) === seen;
};

export const effortIndex = (e: SymbolicEffort): number => EFFORT_ORDER.indexOf(e);

export const isSymbolicEffort = (v: unknown): v is SymbolicEffort => typeof v === 'string' && (EFFORT_ORDER as readonly string[]).includes(v);
