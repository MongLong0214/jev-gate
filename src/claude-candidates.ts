import { MODEL_FACTS, factsOf, sameIdentity, claudeTargetAllowed } from './claude-models.ts';
import type { RouteCandidate } from './router-selection.ts';

export type ModelAliases = Readonly<Record<string, string>>;
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
export const claudeCandidates = (args: {
  baseline: string; available?: readonly string[]; aliases: ModelAliases; allowFable: boolean; hostBase?: string;
  scope?: 'root' | 'spawn'; preferences?: readonly string[]; switches?: readonly { from: string; to: string }[];
}): RouteCandidate[] => {
  const baseId = resolveClaudeModel(args.baseline, args.aliases) ?? args.baseline;
  const base = factsOf(baseId);
  const ids = [baseId, ...MODEL_FACTS.map(f => baseId.startsWith('anthropic.') ? f.ids.find(id => id.startsWith('anthropic.')) ?? '' : f.ids[0]!), ...(args.available ?? []), ...(args.preferences ?? [])];
  const seen = new Set<string>(); const out: RouteCandidate[] = [];
  for (const wire of ids) {
    const id = resolveClaudeModel(wire, args.aliases); if (!id || seen.has(id) || [...seen].some(s => sameIdentity(s, id))) continue;
    const f = factsOf(id); if (!f) continue;
    seen.add(id);
    if (id !== baseId && (!base && args.scope !== 'spawn' || !claudeTargetAllowed(id, args.allowFable) || !claudeModelAllowed(id, args.available, args.aliases) ||
        args.scope !== 'spawn' && base && f.contextTokens < base.contextTokens || args.switches && !args.switches.some(s => s.from === args.baseline && s.to === id))) continue;
    if (id === 'claude-sonnet-5-5' && args.hostBase && /^2\.1\.(\d+)$/.test(args.hostBase) && Number(args.hostBase.split('.')[2]) < 284) continue;
    out.push({ id, description: `${f.family} model ${id}; documented context ${f.contextTokens} tokens. Account entitlement is not inferred.`,
      efforts: f.unconditionalEffort, omitEffort: f.unconditionalEffort.length === 0 && f.conditionalEffort.length === 0 });
  }
  return out;
};
