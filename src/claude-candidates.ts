import { MODEL_FACTS, factsOf, sameIdentity, claudeTargetAllowed } from './claude-models.ts';
import type { RouteCandidate } from './router-selection.ts';

export type ModelAliases = Readonly<Record<string, string>>;
// Product roles, not a measured price/performance ranking. Same-family versions have the same role.
const ROLES = {
  haiku: { rank: 0, text: 'fast: prioritize for file discovery, lookup, listing and mechanical edits with clear checks.' },
  sonnet: { rank: 1, text: 'standard: ordinary multistep implementation or investigation under established contracts.' },
  opus: { rank: 2, text: 'deep: hard debugging, competing design constraints or subtle correctness.' },
  fable: { rank: 3, text: 'frontier: exceptional unresolved foundational reasoning.' },
} as const;
/** Explicit alias mappings come from effective host settings/environment, never the alias's spelling. */
export const resolveClaudeModel = (id: string, aliases: ModelAliases): string | null => factsOf(id) ? id : aliases[id] && factsOf(aliases[id]!) ? aliases[id]! : null;
export const claudeModelAllowed = (id: string, available: readonly string[] | undefined, aliases: ModelAliases): boolean => available === undefined || available.some(value => {
  const resolved = resolveClaudeModel(value, aliases);
  if (resolved && (resolved === id || sameIdentity(resolved, id))) return true;
  const f = factsOf(id);
  if (!resolved && ['haiku', 'sonnet', 'opus', 'fable'].includes(value)) return f?.family === value;
  // Official version-prefix allowlists match only a whole model segment.
  return factsOf(value) !== null && (id === value || id.startsWith(value + '-'));
});
/** A smaller window needs a current complete-request bound and room for its entire maximum output. */
export const claudeContextFits = (baseline: string, target: string, tokens?: number): boolean => {
  const base = factsOf(baseline); const candidate = factsOf(target);
  if (!base || !candidate) return false;
  if (candidate.contextTokens >= base.contextTokens) return true;
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 && candidate.maxOutputTokens !== undefined &&
    tokens + candidate.maxOutputTokens < candidate.contextTokens;
};
export const claudeCandidates = (args: {
  baseline: string; available?: readonly string[]; aliases: ModelAliases; allowFable: boolean; hostBase?: string;
  scope?: 'root' | 'spawn'; preferences?: readonly string[]; switches?: readonly { from: string; to: string }[];
  inputUpperBound?: number; requestCompatible?: boolean; excluded?: Record<string, number>;
}): RouteCandidate[] => {
  const baseId = resolveClaudeModel(args.baseline, args.aliases) ?? args.baseline;
  const base = factsOf(baseId);
  const ids = [baseId, ...MODEL_FACTS.map(f => baseId.startsWith('anthropic.') ? f.ids.find(id => id.startsWith('anthropic.')) ?? '' : f.ids[0]!), ...(args.available ?? []), ...(args.preferences ?? [])];
  const seen = new Set<string>(); const out: RouteCandidate[] = [];
  for (const wire of ids) {
    const id = resolveClaudeModel(wire, args.aliases); if (!id || seen.has(id) || [...seen].some(s => sameIdentity(s, id))) continue;
    const f = factsOf(id); if (!f) continue;
    seen.add(id);
    let reason = '';
    if (id !== baseId) {
      if (!base && args.scope !== 'spawn') reason = 'baseline_unknown';
      else if (!claudeTargetAllowed(id, args.allowFable)) reason = 'fable_disabled_by_config';
      else if (!claudeModelAllowed(id, args.available, args.aliases)) reason = 'model_not_allowed';
      else if (args.scope !== 'spawn' && base && f.contextTokens < base.contextTokens) {
        if (args.requestCompatible !== true || args.inputUpperBound === undefined || !Number.isFinite(args.inputUpperBound) || args.inputUpperBound < 0) reason = 'context_unverified';
        else if (!claudeContextFits(baseId, id, args.inputUpperBound)) reason = 'context_exceeded';
      }
      if (!reason && args.switches && !args.switches.some(s => s.from === args.baseline && s.to === id)) reason = 'switch_not_allowed';
    }
    if (!reason && id === 'claude-sonnet-5-5' && args.hostBase && /^2\.1\.(\d+)$/.test(args.hostBase) && Number(args.hostBase.split('.')[2]) < 284) reason = 'host_unverified';
    if (reason) { if (args.excluded) args.excluded[reason] = (args.excluded[reason] ?? 0) + 1; continue; }
    out.push({ id, rank: ROLES[f.family].rank, description: `${f.family} model ${id}; ${f.role ?? 'Legacy version; no comparative performance is established here.'} Product role ${ROLES[f.family].text} Documented context ${f.contextTokens} tokens. Account entitlement is not inferred.`,
      efforts: f.unconditionalEffort, omitEffort: f.unconditionalEffort.length === 0 && f.conditionalEffort.length === 0 });
  }
  return out;
};
