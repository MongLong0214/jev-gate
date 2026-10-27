import type { CodexModel } from './router.js';

export interface CatalogResult { models: CodexModel[]; complete: boolean; excluded: Record<string, number> }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Account discovery is retained independently of automatic target policy. Conflicts never widen capabilities. */
export const normalizeCatalog = (raw: readonly unknown[], complete: boolean): CatalogResult => {
  const models = new Map<string, CodexModel>(); const conflicts = new Set<string>(); const excluded: Record<string, number> = {};
  const drop = (reason: string): void => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  for (const value of raw) {
    if (!record(value) || typeof value['model'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/.test(value['model']) ||
        !Array.isArray(value['supportedReasoningEfforts']) || value['supportedReasoningEfforts'].some(e => !record(e) || typeof e['reasoningEffort'] !== 'string' || !/^[a-z]{1,24}$/.test(e['reasoningEffort'])) ||
        ['hidden', 'isDefault'].some(k => value[k] !== undefined && typeof value[k] !== 'boolean') ||
        ['description', 'displayName', 'defaultReasoningEffort'].some(k => value[k] !== undefined && typeof value[k] !== 'string') ||
        value['inputModalities'] !== undefined && (!Array.isArray(value['inputModalities']) || value['inputModalities'].some(m => typeof m !== 'string'))) { drop('malformed'); continue; }
    const model = value as unknown as CodexModel;
    if (new Set(model.supportedReasoningEfforts.map(e => e.reasoningEffort)).size !== model.supportedReasoningEfforts.length ||
        model.defaultReasoningEffort !== undefined && !model.supportedReasoningEfforts.some(e => e.reasoningEffort === model.defaultReasoningEffort)) { drop('capability_invalid'); continue; }
    if (conflicts.has(model.model)) { drop('duplicate_conflict'); continue; }
    const fingerprint = (m: CodexModel): string => JSON.stringify({ efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort).sort(), default: m.defaultReasoningEffort, hidden: m.hidden ?? false, modalities: m.inputModalities?.slice().sort(), capabilities: m.capabilities });
    const prior = models.get(model.model);
    if (prior && fingerprint(prior) !== fingerprint(model)) { models.delete(model.model); conflicts.add(model.model); drop('duplicate_conflict'); }
    else if (!prior) models.set(model.model, model);
  }
  return { models: [...models.values()], complete, excluded };
};
/** Canonical family grammar, never a substring match. The account catalog supplies actual versions/IDs. */
export const isAstra = (id: string): boolean => /^(?:gpt-\d+(?:\.\d+)?-astra|astra(?:-\d+(?:\.\d+)?)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(id);
export const codexTargetAllowed = (id: string, allowAstra: boolean): boolean => allowAstra || !isAstra(id);
export const generalCodexModel = (m: CodexModel): boolean => !m.hidden &&
  !/cybersecurity|automatic.*review|specialist|\b(?:older|previous generation|legacy)\b/i.test(m.description ?? '') &&
  (!m.inputModalities || m.inputModalities.includes('text'));

/** `gpt-<major>[.<minor>]-<family>`. Any other ID has no comparable version, so it is never superseded. */
const codexVersion = (id: string): { family: string; version: [number, number] } | null => {
  const m = /^gpt-(\d+)(?:\.(\d+))?-([a-z]+(?:-[a-z]+)*)$/.exec(id);
  return m ? { family: m[3]!, version: [Number(m[1]), Number(m[2] ?? 0)] } : null;
};
/**
 * The newest general model the catalog lists in the same family at a higher version, or null. A model with one is
 * superseded and never a target. Only the catalog decides, so a new release needs no code change; a hidden or
 * specialist entry supersedes nothing, so it cannot leave its family without a target.
 */
export const codexSuccessor = (id: string, catalog: readonly CodexModel[]): string | null => {
  const own = codexVersion(id);
  let best: { id: string; version: [number, number] } | null = null;
  for (const m of own ? catalog : []) {
    const other = codexVersion(m.model), than = best?.version ?? own!.version;
    if (other?.family === own!.family && generalCodexModel(m) && (other.version[0] - than[0] || other.version[1] - than[1]) > 0) best = { id: m.model, version: other.version };
  }
  return best?.id ?? null;
};

/** Verified current product guidance, otherwise account descriptions; never prices or version performance guesses. */
export const codexModelRole = (m: CodexModel): { rank: number; description: string } | undefined => {
  // Official guidance explicitly includes focused coding and well-scoped problem solving, beyond mechanical edits.
  // https://learn.chatgpt.com/docs/models and https://developers.openai.com/api/docs/guides/model-selection (2026-10-22).
  // This exact documented model must still be present/eligible in the account catalog. Future variants are not inferred.
  if (m.model === 'gpt-6-luna') return { rank: 1, description: 'standard: focused coding and problem solving with clear contracts and checks; complex end-to-end reasoning stays deep.' };
  // The native catalog only says "Codex model". Published guidance includes scoped code fixes with clear checks.
  // https://developers.openai.com/api/docs/guides/model-selection (2026-10-27). Availability/efforts remain account-owned.
  if (m.model === 'gpt-6.1-terra') return { rank: 1, description: 'standard: scoped code fixes, clear writing, visual understanding and computer use with defined inputs and verification; complex projects stay deep.' };
  const text = m.description ?? '';
  if (/frontier|most demanding|most intelligent/i.test(text)) return { rank: 3, description: 'frontier: exceptional unresolved foundational reasoning.' };
  if (/fast|efficient|affordable|easier|lightweight/i.test(text)) return { rank: 0, description: 'fast: prioritize for file discovery, lookup, listing and mechanical edits with clear checks.' };
  if (/balanced|straightforward|everyday/i.test(text) && !/workhorse|advanced.*reasoning/i.test(text)) return { rank: 1, description: 'standard: ordinary implementation under established contracts.' };
  if (/workhorse|advanced.*reasoning|coding.*reasoning|reasoning.*coding/i.test(text)) return { rank: 2, description: 'deep: hard debugging, competing design constraints or subtle correctness.' };
  return undefined;
};
