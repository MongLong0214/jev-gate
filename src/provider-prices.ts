import raw from './provider-prices-data.ts';
import type { PriceFacts } from './cost.ts';
import { factsOf } from './claude-models.ts';

/** Adapter facts generated from official metadata by the existing PR model check. No per-request network lookup. */
export const providerPrice = (host: 'claude' | 'codex', model: string, prompt: number | null, serviceTier: string | null = null): PriceFacts | null => {
  if (prompt !== null && (!Number.isSafeInteger(prompt) || prompt < 0) || serviceTier !== null && !['default', 'standard'].includes(serviceTier)) return null;
  const id = host === 'claude' ? factsOf(model)?.ids[0] ?? model : model;
  const row = (raw as Array<{ host: string; model: string; source: string; revision: string; bands: Array<PriceFacts & { maxPrompt: number }> }>).find(p => p.host === host && p.model === id);
  const band = prompt === null ? row?.bands.length === 1 ? row.bands[0] : undefined : row?.bands.find(p => prompt <= p.maxPrompt);
  return row && band ? { ...band, source: row.source, revision: row.revision } : null;
};

/** Price bands do not establish an account's permissions; this is only the official context ceiling. */
export const providerContextLimit = (host: 'claude' | 'codex', model: string): number | null => {
  const row = raw.find(p => p.host === host && p.model === model);
  return row?.bands.at(-1)?.maxPrompt ?? null;
};
