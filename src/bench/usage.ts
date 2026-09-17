export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number | null;
}

export type ModelUsage = Record<string, ModelUsageEntry>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Reads the whole-tree per-model usage from a final `result` event. Returns null when the contract is absent or malformed. */
export const parseModelUsage = (result: unknown): ModelUsage | null => {
  if (!isRecord(result) || !isRecord(result['modelUsage'])) return null;
  const out: ModelUsage = {};
  for (const [model, raw] of Object.entries(result['modelUsage'])) {
    if (!isRecord(raw)) return null;
    const inputTokens = num(raw['inputTokens']);
    const outputTokens = num(raw['outputTokens']);
    const cacheRead = num(raw['cacheReadInputTokens']);
    const cacheCreation = num(raw['cacheCreationInputTokens']);
    if (inputTokens === null || outputTokens === null || cacheRead === null || cacheCreation === null) return null;
    out[model] = { inputTokens, outputTokens, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation, costUSD: num(raw['costUSD']) };
  }
  return out;
};

export const totalTokens = (e: ModelUsageEntry): number => e.inputTokens + e.outputTokens + e.cacheReadInputTokens + e.cacheCreationInputTokens;

export const isFableModel = (model: string): boolean => /fable/i.test(model);

export const addUsage = (into: ModelUsage, more: ModelUsage): void => {
  for (const [model, e] of Object.entries(more)) {
    const cur = into[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
    into[model] = {
      inputTokens: cur.inputTokens + e.inputTokens,
      outputTokens: cur.outputTokens + e.outputTokens,
      cacheReadInputTokens: cur.cacheReadInputTokens + e.cacheReadInputTokens,
      cacheCreationInputTokens: cur.cacheCreationInputTokens + e.cacheCreationInputTokens,
      costUSD: cur.costUSD === null || e.costUSD === null ? null : cur.costUSD + e.costUSD,
    };
  }
};

/** Jev list price per input token; output tokens are free. Unknown models price as null, never as zero. */
export const JEV_PRICING: Record<string, { usdPerInputMtok: number; source: string; checked: string }> = {
  'jev-1.13.0': { usdPerInputMtok: 0.042, source: 'https://docs.typesafe.ai/models.md', checked: '2026-09-17' },
};

export const estimateJevCostUsd = (model: string | null, inputTokens: number | null): number | null => {
  if (!model || inputTokens === null) return null;
  const price = JEV_PRICING[model];
  return price ? (inputTokens / 1_000_000) * price.usdPerInputMtok : null;
};
