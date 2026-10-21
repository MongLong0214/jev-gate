import { routeCost } from '../route-cost.js';
import { ModelCache } from '../cost.js';
import { providerContextLimit } from '../provider-prices.js';

export type CodexBilling = 'chatgpt' | 'api' | 'unknown';
const source = 'https://learn.chatgpt.com/docs/pricing#token-rates';
const revision = '2026-10-21';
// Standard credits per million tokens. These are NOT API USD prices or included subscription allowance rates.
// No separate cache-write charge: a cold target pays its ordinary input rate, without the API write multiplier.
export const CODEX_CREDIT_RATES: Record<string, readonly [input: number, read: number, output: number]> = {
  'gpt-6-astra': [250, 25, 1250], 'gpt-6.1-sol': [50, 2.5, 250], 'gpt-6-sol': [50, 5, 250],
  'gpt-6-luna': [2.5, .25, 12.5], 'gpt-5.6-sol': [100, 10, 500],
  'gpt-5.6-terra': [50, 5, 300], 'gpt-5.6-luna': [5, .5, 30],
};

/** Rate comparison, not a forecast of tokens, included allowance, or an actual bill. No future-turn/TTL assumption. */
export const codexRouteCost = (from: string, to: string, billing: CodexBilling, serviceTier: unknown,
  cache: ModelCache | undefined, epoch: string, now: number, added = 1, cachePolicy?: unknown) => {
  if (from === to) return null;
  const standard = serviceTier === undefined || serviceTier === null || serviceTier === 'default' || serviceTier === 'standard';
  // The shared API price table verifies default writes. Extended/mixed TTLs need their own price proof.
  if (billing === 'api' && standard && cachePolicy === undefined) {
    const estimate = routeCost('codex', from, to, cache ?? new ModelCache(), epoch, now, added);
    return estimate ? { ...estimate, basis: 'api_list_estimate', unit: 'USD' } : null;
  }
  const facts = { basis: billing === 'chatgpt' ? 'codex_credit_rate_comparison' : 'unknown', unit: billing === 'chatgpt' ? 'credits_per_million_tokens' : 'unknown',
    source, revision, cache_lifetime: 'not_assumed', future_requests: 'not_assumed', token_saving: 'unmeasured', included_allowance: 'unknown', actual_bill: 'unknown',
    whole_session_cost: 'unknown', return_cost: 'unknown', handoff_cost: 'unknown', jev_cost: 'separate_observed_usage' };
  const baseline = CODEX_CREDIT_RATES[from], target = CODEX_CREDIT_RATES[to];
  if (billing !== 'chatgpt' || !standard || !baseline || !target) return { ...facts, hold: true, reason: 'cost_unknown_hold' };
  const fromLimit = providerContextLimit('codex', from), toLimit = providerContextLimit('codex', to);
  // Unknown prompt sizes may span the entire baseline context. A smaller target needs separate capacity proof.
  if (fromLimit === null || toLimit === null || toLimit < fromLimit) return { ...facts, hold: true, reason: 'cost_unknown_hold' };
  // Even if the baseline remains cached forever and the target is entirely cold, every input token costs no more.
  // This compares one request at equal token counts. Later returns and different output lengths remain unmeasured.
  const inputDelta = [target[1] - baseline[0], target[0] - baseline[1]];
  const outputDelta = target[2] - baseline[2];
  const hold = inputDelta[1]! > 0 || outputDelta > 0;
  return { ...facts, hold, reason: hold ? 'cost_unknown_hold' : 'cost_allows',
    baseline: { input: baseline[0], read: baseline[1], output: baseline[2] }, target: { input: target[0], read: target[1], output: target[2] },
    input_delta_range_per_million: inputDelta, output_delta_per_million: outputDelta, scope: 'equal_token_count_rate_scenario',
    cache_scenario: 'best_baseline_read_vs_cold_target_input' };
};
