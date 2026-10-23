import { createHash } from 'node:crypto';
import { estimateTokens } from '../outbound-text.js';
import { obj, type Obj } from './source.js';
import { CODEX_CREDIT_RATES, type CodexBilling } from './route-cost.js';

// One bounded request shape per session. Digests stay in memory, never in traces.
// JSON item estimates are not the server's rendered prompt or a tokenizer contract.
export interface RequestShape {
  model: string; standard: boolean; settings: string; items: Array<{ digest: string; tokens: number }>; tokens: number;
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const requestShape = (request: Obj): RequestShape | null => {
 try {
  if (typeof request['model'] !== 'string' || request['previous_response_id'] || !Array.isArray(request['input']) || request['input'].length > 4096) return null;
  const settings = JSON.stringify(['model', 'instructions', 'tools', 'parallel_tool_calls', 'tool_choice', 'text', 'reasoning', 'service_tier', 'prompt_cache_key', 'prompt_cache_options', 'prompt_cache_retention', 'context_management'].map(k => [k, request[k]]));
  let bytes = Buffer.byteLength(settings), tokens = 0;
  if (bytes > 2_000_000) return null;
  const items: RequestShape['items'] = [];
  for (const item of request['input']) {
    const encoded = JSON.stringify(item); if (typeof encoded !== 'string') return null;
    bytes += Buffer.byteLength(encoded);
    if (bytes > 2_000_000) return null;
    const count = estimateTokens(encoded); tokens += count;
    items.push({ digest: digest(encoded), tokens: count });
  }
  const tier = request['service_tier'];
  return { model: request['model'], standard: tier === undefined || tier === null || tier === 'default' || tier === 'standard', settings: digest(settings), items, tokens };
 } catch { return null; }
};
const prefix = (a: RequestShape, b: RequestShape): { items: number; tokens: number } => {
  if (a.settings !== b.settings) return { items: 0, tokens: 0 };
  let items = 0, tokens = 0;
  while (items < a.items.length && items < b.items.length && a.items[items]!.digest === b.items[items]!.digest) tokens += a.items[items++]!.tokens;
  return { items, tokens };
};

export const requestChange = (before: Obj, after: Obj): Obj => {
  const a = requestShape(before), b = requestShape(after);
  if (!a || !b) return { basis: 'serialized_input_estimate', reason: 'input_shape_unknown' };
  const shared = prefix({ ...a, settings: b.settings }, b);
  return { basis: 'serialized_input_estimate', first_changed_item: shared.items === a.items.length && shared.items === b.items.length ? null : shared.items,
    estimated_input_tokens_delta: b.tokens - a.tokens, retained_suffix_estimated_tokens: Math.max(0, b.tokens - shared.tokens),
    model_changed: a.model !== b.model, effort_changed: obj(before['reasoning'])?.['effort'] !== obj(after['reasoning'])?.['effort'],
    settings_changed: a.settings !== b.settings, server_cache_effect: 'unmeasured' };
};

/** A scenario estimate, not observed cache residency, a bill, or future-turn amortization. */
export const compactBenefit = (before: RequestShape | null, after: RequestShape | null, previous: RequestShape | undefined, billing: CodexBilling) => {
  const facts = { basis: 'serialized_input_estimate', cache_residency: 'unknown', total_token_saving: 'unmeasured', future_requests: 'not_assumed' };
  if (!before || !after) return { ...facts, allow: !previous, reason: 'input_shape_unknown' };
  const edit = prefix(before, after);
  const change = { first_changed_item: edit.items, retained_suffix_estimated_tokens: Math.max(0, after.tokens - edit.tokens), estimated_input_tokens_removed: before.tokens - after.tokens };
  // No server lifetime or cross-model cache is invented. Existing bounded assessment
  // remains available without a comparison; its net cache effect stays unmeasured.
  if (!previous || previous.settings !== before.settings || previous.settings !== after.settings) return { ...facts, ...change, allow: true, reason: 'reuse_unobserved' };
  const native = prefix(previous, before), compacted = prefix(previous, after);
  const lost = Math.max(0, native.tokens - compacted.tokens);
  const shared = { ...change, shared_prefix_estimated_tokens: native.tokens, lost_prefix_estimated_tokens: lost };
  if (!lost) return { ...facts, ...shared, allow: true, reason: 'previous_prefix_preserved' };
  const rates = billing === 'chatgpt' && before.standard && after.standard ? CODEX_CREDIT_RATES[after.model] : undefined;
  if (!rates) return { ...facts, ...shared, allow: false, reason: 'reuse_cost_unknown' };
  // Count the shared suffix once for the complete proposed edit, not once per candidate.
  // Compare equal output, with the prior matching prefix reusable in the native request.
  const delta = (after.tokens - before.tokens) * rates[0] + lost * (rates[0] - rates[1]);
  return { ...facts, ...shared, allow: delta < 0, reason: delta < 0 ? 'estimated_net_benefit' : 'prefix_reprocessing_risk',
    estimated_credit_delta: delta / 1_000_000, included_allowance: 'unknown' };
};

/** Only a closed, scalar projection of server-provided diagnostics is observable. */
export const cacheDiagnostics = (value: unknown): Obj => {
  const d = obj(value), type = d?.['type'];
  if (!['cache_hit', 'cache_miss', 'comparison_response_not_found', 'unavailable'].includes(String(type))) return { type: 'unknown' };
  const result: Obj = { type };
  const reasons = ['model_changed', 'prompt_cache_key_changed', 'service_tier_changed', 'tools_changed', 'text_format_changed', 'reasoning_effort_changed', 'verbosity_changed', 'context_compacted', 'input_changed'];
  if (type === 'cache_miss') result['reason'] = reasons.includes(String(d?.['reason'])) ? d!['reason'] : 'unknown';
  for (const key of ['comparison_reusable_tokens', 'cache_missed_tokens']) if (Number.isSafeInteger(d?.[key]) && Number(d![key]) >= 0) result[key] = d![key];
  return result;
};
