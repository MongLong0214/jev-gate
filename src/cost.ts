/** Host-neutral accounting. Cache counters have different meanings in each adapter. */
export interface TokenUsage {
  input: number | null; read: number | null; write: number | null;
  write5m: number | null; write1h: number | null; output: number | null; thinking: number | null;
  coverage: 'complete' | 'partial' | 'invalid';
}
export interface PriceFacts {
  revision: string; source: string; input: number; read: number; output: number;
  write?: number; write5m?: number; write1h?: number;
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const tokenCount = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
export const normalizeUsage = (host: 'claude' | 'codex', raw: unknown): TokenUsage => {
  const u = object(raw), details = object(u['input_tokens_details']), creation = object(u['cache_creation']);
  const total = tokenCount(u['input_tokens']);
  const read = tokenCount(host === 'claude' ? u['cache_read_input_tokens'] : details['cached_tokens']);
  const write = tokenCount(host === 'claude' ? u['cache_creation_input_tokens'] : details['cache_write_tokens']);
  const write5m = host === 'claude' ? tokenCount(creation['ephemeral_5m_input_tokens']) : null;
  const write1h = host === 'claude' ? tokenCount(creation['ephemeral_1h_input_tokens']) : null;
  const output = tokenCount(u['output_tokens']);
  const thinking = tokenCount(object(u['output_tokens_details'])[host === 'claude' ? 'thinking_tokens' : 'reasoning_tokens']);
  const input = host === 'claude' ? total : total !== null && read !== null && write !== null ? total - read - write : null;
  const invalid = input !== null && input < 0 || thinking !== null && output !== null && thinking > output ||
    write !== null && write5m !== null && write1h !== null && write !== write5m + write1h ||
    ['input_tokens', 'output_tokens', ...(host === 'claude' ? ['cache_read_input_tokens', 'cache_creation_input_tokens'] : [])].some(k => u[k] !== undefined && u[k] !== null && tokenCount(u[k]) === null) ||
    host === 'codex' && ['cached_tokens', 'cache_write_tokens'].some(k => details[k] !== undefined && details[k] !== null && tokenCount(details[k]) === null) ||
    ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'].some(k => creation[k] !== undefined && creation[k] !== null && tokenCount(creation[k]) === null) ||
    Object.entries(object(u['output_tokens_details'])).some(([k, v]) => ['thinking_tokens', 'reasoning_tokens'].includes(k) && v !== null && tokenCount(v) === null);
  return { input, read, write, write5m, write1h, output, thinking,
    coverage: invalid ? 'invalid' : [input, read, write, output].every(v => v !== null) ? 'complete' : 'partial' };
};
/** Thinking is a subset of output, never an additional charge. Unknown counters never become zero. */
export const usageCost = (u: TokenUsage, p: PriceFacts | null): { usd: number | null; basis: 'api_list_estimate'; revision: string | null; reason: string | null } => {
  const unknown = (reason: string) => ({ usd: null, basis: 'api_list_estimate' as const, revision: p?.revision ?? null, reason });
  if (!p) return unknown('price_unknown');
  if (Object.entries(p).some(([k, v]) => !['source', 'revision'].includes(k) && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))) return unknown('price_invalid');
  if (u.coverage !== 'complete') return unknown(`usage_${u.coverage}`);
  let writes: number;
  if (u.write === 0) writes = 0;
  else if (p.write !== undefined) writes = u.write! * p.write;
  else if (u.write5m !== null && u.write1h !== null && p.write5m !== undefined && p.write1h !== undefined) writes = u.write5m * p.write5m + u.write1h * p.write1h;
  else return unknown('write_ttl_unknown');
  return { usd: (u.input! * p.input + u.read! * p.read + writes + u.output! * p.output) / 1e6, basis: 'api_list_estimate', revision: p.revision, reason: null };
};
export interface CacheObservation { model: string; at: number; epoch: string; ttlMs: number | null; read: number | null; write: number | null; output: number | null; input?: number | null; effort?: string | null; ttlIsMinimum?: boolean }
/** One small per-execution map, not a cache service or billing ledger. */
export class ModelCache {
  private entries = new Map<string, CacheObservation>();
  observe(v: CacheObservation): void {
    const previous = this.get(v.model, v.epoch);
    if (previous && v.ttlMs === null && v.write === 0 && v.read !== null && v.read > 0) v = { ...v, ttlMs: previous.ttlMs, at: previous.ttlIsMinimum ? previous.at : v.at, ...(previous.ttlIsMinimum ? { ttlIsMinimum: true } : {}) };
    this.entries.delete(v.model); this.entries.set(v.model, v); while (this.entries.size > 16) this.entries.delete(this.entries.keys().next().value!);
  }
  get(model: string, epoch: string): CacheObservation | null { const v = this.entries.get(model); return v?.epoch === epoch ? v : null; }
  clear(): void { this.entries.clear(); }
}
export const cacheState = (v: CacheObservation | null, now: number): 'warm' | 'cold' | 'unknown' => !v ? 'unknown'
  : v.read === 0 && v.write === 0 ? 'cold' : v.ttlMs === null || v.read === null || v.write === null || now < v.at ? 'unknown'
  : now - v.at < v.ttlMs ? 'warm' : v.ttlIsMinimum ? 'unknown' : 'cold';
// A mixed prefix is only proven reusable for its shortest observed lifetime.
export const observedTtl = (u: TokenUsage): number | null => u.write5m !== null && u.write5m > 0 ? 300_000 : u.write1h !== null && u.write1h > 0 ? 3_600_000 : null;
export interface SwitchCostInput {
  prefix: number; baseline: PriceFacts | null; target: PriceFacts | null;
  baselineCache: 'warm' | 'cold' | 'unknown'; targetCache: 'warm' | 'cold' | 'unknown';
  baselineWrite: number | null; targetWrite: number | null;
  outputRange: readonly [number, number] | null;
  /** Return costs are scenarios, never accumulated as consumption. */
  returnWriteRange?: readonly [number, number]; overheadRange?: readonly [number, number];
}
export const switchCost = (v: SwitchCostInput): { hold: boolean; reason: 'cost_hold' | 'cost_unknown' | 'cost_allows'; deltaUsd: [number, number] | null; inputs: SwitchCostInput } => {
  const unknown = () => ({ hold: false, reason: 'cost_unknown' as const, deltaUsd: null, inputs: v });
  const range = (r: readonly [number, number]) => r.every(n => Number.isFinite(n) && n >= 0) && r[0] <= r[1];
  if (!v.baseline || !v.target || !v.outputRange || !range(v.outputRange) ||
    v.returnWriteRange && !range(v.returnWriteRange) || v.overheadRange && !range(v.overheadRange) ||
    v.baselineCache === 'unknown' || v.targetCache === 'unknown' || !Number.isSafeInteger(v.prefix) || v.prefix < 0) return unknown();
  const from = v.baselineCache === 'warm' ? v.baseline.read : v.baselineWrite;
  const to = v.targetCache === 'warm' ? v.target.read : v.targetWrite;
  if (from === null || to === null || ![from, to, v.baseline.output, v.target.output].every(n => Number.isFinite(n) && n >= 0)) return unknown();
  const outputDelta = v.target.output - v.baseline.output;
  const outputs = v.outputRange.map(n => n * outputDelta / 1e6);
  const prefix = v.prefix * (to - from) / 1e6;
  const returnWrite = v.returnWriteRange ?? [0, 0], overhead = v.overheadRange ?? [0, 0];
  const deltaUsd: [number, number] = [prefix + Math.min(...outputs) + returnWrite[0] + overhead[0], prefix + Math.max(...outputs) + returnWrite[1] + overhead[1]];
  const hold = deltaUsd[0] > 0;
  return { hold, reason: hold ? 'cost_hold' : 'cost_allows', deltaUsd, inputs: v };
};
