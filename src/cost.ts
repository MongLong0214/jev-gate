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
export interface CacheObservation { model: string; at: number; epoch: string; ttlMs: number | null; read: number | null; write: number | null; output: number | null; input?: number | null; effort?: string | null; ttlIsMinimum?: boolean;
  /** The adapter's provider lifetimes when a response reports no TTL: certainly held before the first, certainly gone from the second. */
  ttlBoundsMs?: readonly [number, number] }
/** One small per-execution map, not a cache service or billing ledger. */
export class ModelCache {
  private entries = new Map<string, CacheObservation>();
  observe(v: CacheObservation): void {
    const previous = this.get(v.model, v.epoch);
    if (previous && v.ttlMs === null && v.write === 0 && v.read !== null && v.read > 0) v = { ...v, ttlMs: previous.ttlMs, at: previous.ttlIsMinimum ? previous.at : v.at, ...(previous.ttlIsMinimum ? { ttlIsMinimum: true } : {}) };
    this.entries.delete(v.model); this.entries.set(v.model, v); while (this.entries.size > 16) this.entries.delete(this.entries.keys().next().value!);
  }
  get(model: string, epoch: string): CacheObservation | null { const v = this.entries.get(model); return v?.epoch === epoch ? v : null; }
  /** The newest observation, whichever model answered it: it knows the conversation's prefix best. */
  latest(epoch: string): CacheObservation | null { const v = [...this.entries.values()].at(-1); return v?.epoch === epoch ? v : null; }
  /** This epoch's observations, oldest first: what a later process of the same conversation can restore. */
  list(epoch: string): CacheObservation[] { return [...this.entries.values()].filter(v => v.epoch === epoch); }
  clear(): void { this.entries.clear(); }
}
/** An epoch starts with every model empty: a model not observed in it cannot hold this context's prefix. */
export const cacheState = (v: CacheObservation | null, now: number): 'warm' | 'cold' | 'unknown' => {
  if (!v || v.read === 0 && v.write === 0) return 'cold';
  if (v.read === null || v.write === null || now < v.at) return 'unknown';
  const [held, gone] = v.ttlMs === null ? v.ttlBoundsMs ?? [0, Infinity] : [v.ttlMs, v.ttlIsMinimum ? v.ttlBoundsMs?.[1] ?? Infinity : v.ttlMs];
  return now - v.at < held ? 'warm' : now - v.at >= gone ? 'cold' : 'unknown';
};
// A mixed prefix is only proven reusable for its shortest observed lifetime.
export const observedTtl = (u: TokenUsage): number | null => u.write5m !== null && u.write5m > 0 ? 300_000 : u.write1h !== null && u.write1h > 0 ? 3_600_000 : null;
type Range = readonly [number, number];
export interface SwitchCostInput {
  /** Tokens the switched request carries before its new content. Null: not observed, any size from zero. */
  prefix: number | null;
  /** Of the prefix, how many the target cached before; the rest it writes even when warm. */
  targetHeld: number;
  baseline: PriceFacts | null; target: PriceFacts | null;
  baselineCache: 'warm' | 'cold' | 'unknown'; targetCache: 'warm' | 'cold' | 'unknown';
  /** A range when the TTL the write gets is not known. */
  baselineWrite: number | Range | null; targetWrite: number | Range | null;
  /** Null: not observed, any size from zero. */
  outputRange: Range | null;
  /** The request after may go back to the baseline; false only for a new context with no baseline conversation. */
  returns: boolean;
  /** USD. */
  overheadRange?: Range;
  /** Requests the target serves before a return, the switched one included; each later one reads the prefix on both sides. */
  horizon?: number;
}
/**
 * Over its horizon the switch must cost no more than staying in every scenario its inputs allow; uncertainty keeps the
 * original call. An unknown cache state may be warm or cold, so each side is bounded by its read and write rates.
 */
export const switchCost = (v: SwitchCostInput): { hold: boolean; reason: 'cost_hold' | 'cost_unknown_hold' | 'cost_allows'; deltaUsd: [number, number] | null; inputs: SwitchCostInput } => {
  const unknown = { hold: true, reason: 'cost_unknown_hold' as const, deltaUsd: null, inputs: v };
  const range = (r: Range) => Number.isFinite(r[0]) && r[0] >= 0 && r[1] >= r[0];
  const rate = (r: number | Range | null): Range | null => typeof r === 'number' ? [r, r] : r;
  const side = (p: PriceFacts, state: SwitchCostInput['baselineCache'], w: Range | null): Range | null =>
    state === 'warm' ? [p.read, p.read] : !w ? null : state === 'cold' ? w : [Math.min(p.read, w[0]), Math.max(p.read, w[1])];
  const bw = rate(v.baselineWrite), tw = rate(v.targetWrite);
  if (!v.baseline || !v.target || [bw, tw, v.outputRange, v.overheadRange].some(r => r && !range(r)) ||
    [v.prefix ?? 0, v.targetHeld].some(n => !Number.isSafeInteger(n) || n < 0) || v.horizon !== undefined && !(Number.isSafeInteger(v.horizon) && v.horizon >= 1)) return unknown;
  // Returning to a baseline the switch left cold rewrites what staying would have written now and read then: per token
  // a cold baseline is then worth its read rate, not its write. Warm, the baseline reads either way.
  const from = side(v.baseline, v.returns && v.baselineCache === 'cold' ? 'unknown' : v.baselineCache, bw);
  const to = side(v.target, v.targetCache, tw);
  if (!from || !to || !tw || ![...from, ...to, ...tw, v.baseline.output, v.target.output].every(n => Number.isFinite(n) && n >= 0)) return unknown;
  // Exact range products; an unobserved count spans zero to infinity, and zero tokens cost nothing at any rate.
  const times = (x: Range, c: Range): Range => { const p = [x[0] * c[0], x[0] * c[1], x[1] * c[0], x[1] * c[1]].map(n => Number.isNaN(n) ? 0 : n); return [Math.min(...p), Math.max(...p)]; };
  const count = (n: number): Range => v.prefix === null ? [0, Infinity] : [n, n];
  const held = v.targetCache === 'cold' || v.prefix === null ? 0 : Math.min(v.targetHeld, v.prefix);
  const outputDelta = v.target.output - v.baseline.output;
  const terms = [times(count(held), [to[0] - from[1], to[1] - from[0]]).map(n => n / 1e6),
    times(count((v.prefix ?? 0) - held), [tw[0] - from[1], tw[1] - from[0]]).map(n => n / 1e6),
    times(v.outputRange ?? [0, Infinity], [outputDelta, outputDelta]).map(n => n / 1e6), v.overheadRange ?? [0, 0]];
  // The cache write is paid once; every later request on the target saves the read and output price difference.
  const later = Math.max(1, v.horizon ?? 1) - 1;
  if (later) terms.push(times(count(v.prefix ?? 0), [v.target.read - v.baseline.read, v.target.read - v.baseline.read]).map(n => n * later / 1e6),
    times(v.outputRange ?? [0, Infinity], [outputDelta, outputDelta]).map(n => n * later / 1e6));
  const deltaUsd: [number, number] = [terms.reduce((s, t) => s + t[0]!, 0), terms.reduce((s, t) => s + t[1]!, 0)];
  const hold = deltaUsd[1] > 0;
  const unobserved = v.baselineCache === 'unknown' || v.targetCache === 'unknown' || v.prefix === null || !v.outputRange;
  return { hold, reason: !hold ? 'cost_allows' : deltaUsd[0] <= 0 && unobserved ? 'cost_unknown_hold' : 'cost_hold', deltaUsd, inputs: v };
};
