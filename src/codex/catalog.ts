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

/** Product roles from the account's descriptions, not inferred prices or a version performance ranking. */
export const codexModelRole = (m: CodexModel): { rank: number; description: string } | undefined => {
  const text = m.description ?? '';
  if (/frontier|most demanding|most intelligent/i.test(text)) return { rank: 3, description: 'frontier: exceptional unresolved foundational reasoning.' };
  if (/fast|efficient|affordable|easier|lightweight/i.test(text)) return { rank: 0, description: 'fast: prioritize for file discovery, lookup, listing and mechanical edits with clear checks.' };
  if (/balanced|straightforward|everyday/i.test(text) && !/workhorse|advanced.*reasoning/i.test(text)) return { rank: 1, description: 'standard: ordinary implementation under established contracts.' };
  if (/workhorse|advanced.*reasoning|coding.*reasoning|reasoning.*coding/i.test(text)) return { rank: 2, description: 'deep: hard debugging, competing design constraints or subtle correctness.' };
  return undefined;
};
