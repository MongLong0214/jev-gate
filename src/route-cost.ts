import { cacheState, switchCost, type ModelCache } from './cost.ts';
import { providerPrice } from './provider-prices.ts';

/** Adapter estimate using observed usage, not a forecast supplied by a classifier. */
export const routeCost = (host: 'claude' | 'codex', from: string, to: string, cache: ModelCache | undefined, epoch: string, now: number) => {
  const baseline = cache?.get(from, epoch) ?? null, target = cache?.get(to, epoch) ?? null;
  const prefix = baseline?.input != null && baseline.read !== null && baseline.write !== null ? baseline.input + baseline.read + baseline.write : -1;
  const fromPrice = providerPrice(host, from, prefix), toPrice = providerPrice(host, to, prefix);
  const writeRate = (p: ReturnType<typeof providerPrice>, ttl: number | null | undefined) => p?.write ?? (ttl === 300_000 ? p?.write5m : ttl === 3_600_000 ? p?.write1h : undefined) ?? null;
  return { ...switchCost({ prefix, baseline: fromPrice, target: toPrice,
    baselineCache: cacheState(baseline, now), targetCache: cacheState(target, now),
    baselineWrite: writeRate(fromPrice, baseline?.ttlMs), targetWrite: writeRate(toPrice, target?.ttlMs),
    outputRange: baseline?.output != null ? [0, baseline.output] : null }),
    output_basis: 'scenario_zero_to_previous_output', future_output: 'unknown', return_horizon: 'undeclared', jev_cost: 'separate_observed_usage',
    scope: 'next_request_scenario', return_cost: 'unknown', handoff_cost: 'unknown', whole_session_cost: 'unknown' };
};
