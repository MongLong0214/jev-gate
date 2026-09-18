/** Whole-tree usage parsing with strict numeric validation (#14 §4, #16 §2). Missing or malformed values stay unknown. */

export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number | null;
}

export type ModelUsage = Record<string, ModelUsageEntry>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Token counts are nonnegative safe integers; numeric strings, booleans, negatives, fractions, NaN and Infinity are rejected. */
export const tokenCount = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
/** Costs and durations are finite nonnegative numbers; fractions are allowed. */
export const money = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Sum that refuses to overflow the safe-integer range; null when any operand is unknown. */
export const safeSum = (values: Array<number | null>): number | null => {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
};

export type UsageParse = { ok: true; usage: ModelUsage } | { ok: false; reason: 'absent' | 'malformed' | 'empty_after_inference' };

/**
 * Reads `modelUsage` from a final `result` event. An empty map is reported separately because, after observed inference,
 * it is incomplete accounting rather than a complete zero.
 */
export const parseModelUsage = (result: unknown, inferenceObserved = false): UsageParse => {
  if (!isRecord(result) || !isRecord(result['modelUsage'])) return { ok: false, reason: 'absent' };
  const entries = Object.entries(result['modelUsage']);
  if (entries.length === 0) return inferenceObserved ? { ok: false, reason: 'empty_after_inference' } : { ok: true, usage: {} };
  const out: ModelUsage = {};
  for (const [model, raw] of entries) {
    if (!isRecord(raw) || model.length === 0) return { ok: false, reason: 'malformed' };
    const inputTokens = tokenCount(raw['inputTokens']);
    const outputTokens = tokenCount(raw['outputTokens']);
    const cacheRead = tokenCount(raw['cacheReadInputTokens']);
    const cacheCreation = tokenCount(raw['cacheCreationInputTokens']);
    if (inputTokens === null || outputTokens === null || cacheRead === null || cacheCreation === null) return { ok: false, reason: 'malformed' };
    if (safeSum([inputTokens, outputTokens, cacheRead, cacheCreation]) === null) return { ok: false, reason: 'malformed' };
    out[model] = { inputTokens, outputTokens, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation, costUSD: money(raw['costUSD']) };
  }
  return { ok: true, usage: out };
};

export const totalTokens = (e: ModelUsageEntry): number | null => safeSum([e.inputTokens, e.outputTokens, e.cacheReadInputTokens, e.cacheCreationInputTokens]);

/** Model-family identification from the actual model identifier, never from an agent or arm name. */
export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'unknown';
export const modelFamily = (model: string): Family => {
  const m = model.toLowerCase();
  if (m.includes('fable')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'unknown';
};

/** Adds per-model usage; returns null when any sum overflows so callers keep the total unknown. */
export const addUsage = (into: ModelUsage, more: ModelUsage): ModelUsage | null => {
  for (const [model, e] of Object.entries(more)) {
    const cur = into[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
    const inputTokens = safeSum([cur.inputTokens, e.inputTokens]);
    const outputTokens = safeSum([cur.outputTokens, e.outputTokens]);
    const cacheReadInputTokens = safeSum([cur.cacheReadInputTokens, e.cacheReadInputTokens]);
    const cacheCreationInputTokens = safeSum([cur.cacheCreationInputTokens, e.cacheCreationInputTokens]);
    if (inputTokens === null || outputTokens === null || cacheReadInputTokens === null || cacheCreationInputTokens === null) return null;
    into[model] = { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD: cur.costUSD === null || e.costUSD === null ? null : cur.costUSD + e.costUSD };
  }
  return into;
};

/** Family volume across a complete usage map; null when any model's identity is unknown (unknown is never zero Fable). */
export const familyTokens = (usage: ModelUsage, family: Family): number | null => {
  const models = Object.keys(usage);
  if (models.some((m) => modelFamily(m) === 'unknown')) return null;
  return safeSum(models.filter((m) => modelFamily(m) === family).map((m) => totalTokens(usage[m]!)));
};

/** API-equivalent cost grouped by model family. A family whose entries report no cost stays null, never zero. */
export const familyCosts = (usage: ModelUsage): Partial<Record<Family, number | null>> => {
  const out: Partial<Record<Family, number | null>> = {};
  for (const [model, e] of Object.entries(usage)) {
    const family = modelFamily(model);
    const current = family in out ? out[family] : 0;
    out[family] = current === null || current === undefined || e.costUSD === null ? null : current + e.costUSD;
  }
  return out;
};

/** Jev list price frozen with model, date and primary source (#10 §7). Unknown models price as null, never zero. */
export const JEV_PRICING: Record<string, { usdPerInputMtok: number; source: string; checked: string }> = {
  'jev-1.13.0': { usdPerInputMtok: 0.042, source: 'https://docs.typesafe.ai/models.md', checked: '2026-09-17' },
};

export const estimateJevCostUsd = (model: string | null, inputTokens: number | null): number | null => {
  if (!model || inputTokens === null) return null;
  const price = JEV_PRICING[model];
  return price ? (inputTokens / 1_000_000) * price.usdPerInputMtok : null;
};
