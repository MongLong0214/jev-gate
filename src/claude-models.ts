/**
 * Exact-model facts the policy is allowed to rely on. Source: the Claude platform model overview and effort pages,
 * read 2026-10-08. https://platform.claude.com/docs/en/models/overview and https://platform.claude.com/docs/en/build-with-claude/effort. A model absent from this table has unknown rank, capacity and effort support, and nothing here
 * guesses them: its model and effort stay native.
 */
export type SymbolicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_ORDER: readonly SymbolicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable';

/** Agent.model accepts family tokens only. Actual IDs belong at the native agent.spawn boundary. */
export const claudeAgentToolModel = (model: string): Family | null =>
  ['haiku', 'sonnet', 'opus', 'fable'].includes(model) ? model as Family : factsOf(model)?.family ?? null;

export interface ModelFacts {
  /** Every full identifier the host may send for this model, matched exactly. */
  ids: readonly string[];
  /**
   * Request variants the host itself lists for this model. Claude Code 2.1.282 names `claude-opus-5-5[1m]` and
   * `claude-sonnet-5[1m]`, its 1M-context variants, and no other. A variant is its own identity: it is ranked with
   * its model but matched, allowed and observed with its suffix. Any other suffix is an unknown model.
   */
  suffixes: readonly string[];
  family: Family;
  /** Historical identity remains readable, but it is never a new automatic target. */
  legacy?: boolean;
  /** First supported Claude Code 2.1 release for this model's native request conversion. */
  minimumHostRelease?: number;
  contextTokens: number;
  /** Documented output limit, used to reserve the entire possible response when switching to a smaller window. */
  maxOutputTokens?: number;
  /** Published model role; omitted for legacy versions without a current description. */
  role?: string;
  /** Published API default; independent of the effort selected for a particular task. */
  defaultEffort?: SymbolicEffort;
  /** Levels valid under every thinking mode the model accepts. Empty when the model takes no effort at all. */
  unconditionalEffort: readonly SymbolicEffort[];
  /**
   * Levels valid only under some thinking mode. The retained mode is not visible at the hook, so these are never
   * offered; a conditional current level may still be reduced to an unconditional one.
   */
  conditionalEffort: readonly SymbolicEffort[];
}

export const MODEL_FACTS: readonly ModelFacts[] = [
  { ids: ["claude-fable-5"], suffixes: ["[1m]"], family: "fable", legacy: true, contextTokens: 1000000, unconditionalEffort: ["low", "medium", "high", "xhigh", "max"], conditionalEffort: [] },
  { ids: ["claude-sonnet-5-5", "anthropic.claude-sonnet-5-5"], suffixes: ["[1m]"], family: "sonnet", minimumHostRelease: 284, contextTokens: 1000000, maxOutputTokens: 128000, role: "The best combination of speed and intelligence", defaultEffort: "high", unconditionalEffort: ["low", "medium", "high"], conditionalEffort: ["xhigh", "max"] },
  { ids: ["claude-fable-5-1", "anthropic.claude-fable-5-1"], suffixes: [], family: "fable", contextTokens: 1000000, maxOutputTokens: 128000, role: "For demanding reasoning and long-horizon agentic work", defaultEffort: "high", unconditionalEffort: ["low", "medium", "high", "xhigh", "max"], conditionalEffort: [] },
  { ids: ["claude-opus-5-5", "anthropic.claude-opus-5-5"], suffixes: ["[1m]"], family: "opus", contextTokens: 1000000, maxOutputTokens: 128000, role: "For long-running agentic coding and knowledge work", defaultEffort: "medium", unconditionalEffort: ["low", "medium", "high", "xhigh", "max"], conditionalEffort: [] },
  { ids: ["claude-opus-5", "anthropic.claude-opus-5"], suffixes: [], family: "opus", legacy: true, contextTokens: 1000000, unconditionalEffort: ["low", "medium", "high"], conditionalEffort: ["xhigh", "max"] },
  { ids: ["claude-sonnet-5"], suffixes: ["[1m]"], family: "sonnet", legacy: true, contextTokens: 1000000, unconditionalEffort: ["low", "medium", "high"], conditionalEffort: ["xhigh", "max"] },
  { ids: ["claude-haiku-5-5", "anthropic.claude-haiku-5-5"], suffixes: [], family: "haiku", minimumHostRelease: 293, contextTokens: 1000000, maxOutputTokens: 128000, role: "For high-volume, latency-sensitive tasks such as classification, extraction, and routing", defaultEffort: "medium", unconditionalEffort: ["low", "medium", "high"], conditionalEffort: ["xhigh", "max"] },
  { ids: ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "anthropic.claude-haiku-4-5", "claude-haiku-4-5@20251001"], suffixes: [], family: "haiku", legacy: true, contextTokens: 200000, maxOutputTokens: 64000, role: "Fastest model; simple tasks, lookup and mechanical transformations with clear checks.", unconditionalEffort: [], conditionalEffort: [] },
];

/** One current automatic version per family; historical facts only explain older recorded executions. */
export const currentClaudeModel = (family: Family): string => {
  const current = MODEL_FACTS.filter(f => f.family === family && !f.legacy);
  if (current.length !== 1) throw new Error(`ambiguous current Claude family: ${family}`);
  return current[0]!.ids[0]!;
};

/** The aliases the Agent tool resolves itself. Root requests never receive one of these. */
const SPAWN_ALIASES: Readonly<Record<string, Family>> = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' };

/** `claude-opus-5-5[1m]` → base `claude-opus-5-5`, suffix `[1m]`. The suffix is kept wherever the ID is kept. */
export const splitModelId = (id: string): { base: string; suffix: string } => {
  const m = /^(.*?)(\[[^\]]*\])$/.exec(id);
  return m ? { base: m[1] ?? id, suffix: m[2] ?? '' } : { base: id, suffix: '' };
};

// Only a suffix the table does not list for that model is unknown, rather than every suffixed id: the host's own 1M
// entries carry one.
export const factsOf = (id: string): ModelFacts | null => {
  const { base, suffix } = splitModelId(id);
  return MODEL_FACTS.find((f) => f.ids.includes(base) && (suffix === '' || f.suffixes.includes(suffix))) ?? null;
};

/** Two full identifiers of one model and one variant: `claude-haiku-4-5` and its dated form, but not `x` and `x[1m]`. */
export const sameIdentity = (a: string, b: string): boolean => {
  const facts = factsOf(a);
  return facts !== null && factsOf(b) === facts && splitModelId(a).suffix === splitModelId(b).suffix;
};

export const aliasFamily = (value: string): Family | null => SPAWN_ALIASES[value] ?? null;

/**
 * Whether an observed model is the one that was requested. Only identities this table can vouch for are equivalent:
 * an alias matches its family, a full ID matches its own entry and variant. Anything else is compared exactly, and an
 * unknown observation is not a match.
 */
export const sameModel = (requested: string, observed: string): boolean => {
  if (requested === observed) return true;
  const seen = factsOf(observed);
  if (!seen) return false;
  const family = aliasFamily(requested);
  if (family) return seen.family === family;
  return sameIdentity(requested, observed);
};

/**
 * Whether the id a response reports (TurnUsage.model, "by the id the API reports") names the requested model, in
 * either variant: a bare id and its listed `[1m]` form count as the same model, in both directions. That is what an
 * effort-only patch needs, since the efforts a model takes do not depend on its variant. A model override is held to
 * sameModel instead, which keeps the variant.
 */
export const answeredBy = (requested: string, observed: string): boolean => {
  if (sameModel(requested, observed)) return true;
  if (aliasFamily(requested) !== null) return false;
  const seen = factsOf(observed);
  return seen !== null && factsOf(requested) === seen;
};

export const effortIndex = (e: SymbolicEffort): number => EFFORT_ORDER.indexOf(e);

export const isSymbolicEffort = (v: unknown): v is SymbolicEffort => typeof v === 'string' && (EFFORT_ORDER as readonly string[]).includes(v);

/** A root model change from one exact identifier to another. */
export interface RootSwitch {
  from: string;
  to: string;
}

/** Restricted automatic family, including known canonical versions; unrelated strings never match. */
export const isFable = (id: string): boolean => factsOf(id)?.family === 'fable' || /^(?:anthropic\.)?claude-fable-\d+(?:-\d+)*(?:@\d{8})?(?:\[1m\])?$/.test(id);
export const claudeTargetAllowed = (id: string, allowFable: boolean): boolean => factsOf(id)?.legacy !== true && (allowFable || !isFable(id));
