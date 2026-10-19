import { cacheState, switchCost, type CacheObservation, type ModelCache } from './cost.ts';
import { providerContextLimit, providerPrice } from './provider-prices.ts';

/**
 * Adapter estimate using observed usage, not a forecast supplied by a classifier. `cache` holds one context's
 * observations (the root conversation, or one subagent's); undefined is a new context, such as a new subagent: cold
 * for every model, with no baseline conversation to return to. Null for the same model: an effort change alone kept
 * the cache (read ratio p10 1.00 over 383 same-model effort changes, 2026-10). `added` is the new input the switched
 * request carries past the observed prefix, such as the person's prompt; it sets the price band, not the token counts.
 * `horizon` is the requests the target is expected to serve. Over a turn each produces the latest observed output; one
 * request alone (Codex, a spawn) may produce none to that, so its worst case counts no output saving.
 */
export const routeCost = (host: 'claude' | 'codex', from: string, to: string, cache: ModelCache | undefined, epoch: string, now: number, added = 1, horizon = 1) => {
  if (from === to) return null;
  const baseline = cache?.get(from, epoch) ?? null, target = cache?.get(to, epoch) ?? null;
  const latest = cache?.latest(epoch) ?? null;
  const size = (v: CacheObservation | null) => v?.input != null && v.read !== null && v.write !== null ? v.input + v.read + v.write : null;
  // The switched request carries the newest request's prefix (its input, cache reads and writes) and its output, and
  // `added` new input tokens, at least one: the price band is the one for that whole request, past a band edge it crosses.
  const prefix = size(latest) !== null && latest!.output !== null ? size(latest)! + latest!.output : null;
  const request = prefix === null ? null : prefix + Math.max(1, added);
  // An unknown prefix can be any band: the baseline's cheapest against the target's dearest.
  const fromPrice = providerPrice(host, from, request ?? 0), toPrice = providerPrice(host, to, request ?? providerContextLimit(host, to));
  const ttl = (v: CacheObservation | null) => v?.ttlMs != null && !v.ttlIsMinimum ? v.ttlMs : null;
  const writeRate = (p: ReturnType<typeof providerPrice>, ttl: number | null): number | readonly [number, number] | null => p?.write ?? (ttl === 300_000 ? p?.write5m : ttl === 3_600_000 ? p?.write1h : undefined) ??
    (p?.write5m !== undefined && p.write1h !== undefined ? [Math.min(p.write5m, p.write1h), Math.max(p.write5m, p.write1h)] as const : null);
  const seen = (v: CacheObservation | null) => v ? { age_ms: now - v.at, ttl_ms: v.ttlMs, ttl_minimum: v.ttlIsMinimum ?? false, ttl_bounds_ms: v.ttlBoundsMs ?? null,
    input: v.input ?? null, read: v.read, write: v.write, output: v.output } : 'not_observed_in_epoch';
  return { ...switchCost({ prefix, targetHeld: size(target) ?? 0, baseline: fromPrice, target: toPrice, baselineCache: cacheState(baseline, now), targetCache: cacheState(target, now),
    baselineWrite: writeRate(fromPrice, ttl(baseline)), targetWrite: writeRate(toPrice, ttl(target)), outputRange: latest?.output != null ? [horizon > 1 ? latest.output : 0, latest.output] : null, returns: cache !== undefined, horizon }),
    evidence: { baseline: seen(baseline), target: seen(target), prefix_source: prefix === null ? 'unobserved' : latest === baseline ? 'baseline' : latest === target ? 'target' : latest!.model },
    output_basis: horizon > 1 ? 'previous_output' : 'scenario_zero_to_previous_output', future_output: 'unknown', new_content: added > 1 ? 'price_band_only' : 'unobserved_not_counted', jev_cost: 'separate_observed_usage',
    scope: horizon > 1 ? 'turn_horizon' : 'next_request_scenario', horizon, return_horizon: 'request_after_horizon_may_return_to_baseline', return_cost: 'in_delta_usd', handoff_cost: 'unknown', whole_session_cost: 'unknown' };
};
/**
 * #271: a model switch rewrites the conversation's cache once and saves on every later request, so a root turn's switch
 * is priced over this many requests, not one: judged on one, every warm downgrade was held (42 of 42 proposals,
 * v0.8.24 to v0.8.27). 5 is the p90 of requests per root turn (698 turns, 2026-10-16 to 10-19). Replaying those turns'
 * recorded inputs and proposals at a 1-hour TTL: 13 of the 42 pass, the 9 sessions' estimate falls 3.8% and none
 * rises more than 0.6%; 6 to 10 let one session rise 3%, 15 one 13%, no guard (as v0.8.22) one 27.5%.
 */
export const TURN_HORIZON = 5;
/**
 * An upgrade is the classifier's capability call, never held for cache cost; an unknown rank is not an upgrade. A null
 * cost is a switch not checked: none, an effort change alone, or a move the baseline cannot stay out of.
 */
export const costHold = (cost: { hold: boolean; reason: string } | null, baseRank: number | undefined, targetRank: number | undefined) => {
  const upgrade = baseRank !== undefined && targetRank !== undefined && targetRank > baseRank;
  return { hold: !!cost?.hold && !upgrade, reason: cost === null ? 'not_checked' : upgrade ? 'upgrade_allowed' : cost.reason };
};
