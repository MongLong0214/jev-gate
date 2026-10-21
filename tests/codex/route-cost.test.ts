import { describe, expect, it } from 'vitest';
import { codexRouteCost } from '../../src/codex/route-cost.js';
import { codexBilling } from '../../src/codex/launch.js';
import { ModelCache, cacheState, switchCost } from '../../src/cost.js';

const from = 'gpt-6.1-sol', to = 'gpt-6-luna';
const cache = () => {
  const c = new ModelCache();
  c.observe({ model: from, epoch: 'e', at: 0, ttlMs: null, input: 200, read: 22000, write: 0, output: 374 });
  return c;
};
describe('Codex transport billing and cache-safe rate comparison', () => {
  it('uses only the selected native transport, never an account header at a custom upstream', () => {
    expect(codexBilling(undefined, 'native-account')).toBe('chatgpt');
    expect(codexBilling(undefined, undefined)).toBe('api');
    for (const account of ['', [], ['native-account']]) expect(codexBilling(undefined, account)).toBe('unknown');
    for (const upstream of ['http://127.0.0.1:9999/v1', 'https://gateway.example/v1']) {
      expect(codexBilling(upstream, 'native-account')).toBe('unknown');
    }
  });
  it('allows native cold Luna even against indefinitely warm Sol without inventing a TTL or usage forecast', () => {
    const c = cache(), prior = c.list('e');
    for (const observed of [undefined, new ModelCache(), c]) {
      for (const now of [1000, 30 * 60_000 + 1, 366 * 86400_000]) {
        const result = codexRouteCost(from, to, 'chatgpt', undefined, observed, 'e', now);
        expect(result).toMatchObject({ hold: false, reason: 'cost_allows', unit: 'credits_per_million_tokens',
          baseline: { read: 2.5 }, target: { input: 2.5 }, input_delta_range_per_million: [-49.75, 0], output_delta_per_million: -237.5,
          cache_lifetime: 'not_assumed', future_requests: 'not_assumed', included_allowance: 'unknown', token_saving: 'unmeasured' });
        expect(result).not.toHaveProperty('deltaUsd');
      }
    }
    expect(c.list('e')).toEqual(prior); expect(cacheState(c.get(from, 'e'), 1000)).toBe('unknown');
  });
  it('keeps the API cache-write premium and USD unit separate from native credits', () => {
    expect(codexRouteCost(from, to, 'api', 'default', cache(), 'e', 1000)).toMatchObject({ hold: true, reason: 'cost_unknown_hold', basis: 'api_list_estimate', unit: 'USD' });
    const warm = cache(); warm.observe({ ...warm.get(from, 'e')!, ttlMs: 1_800_000, ttlIsMinimum: true });
    const result = codexRouteCost(from, to, 'api', null, warm, 'e', 1000);
    expect(result).toMatchObject({ hold: true, reason: 'cost_hold' });
    expect(result).not.toHaveProperty('input_delta_range_per_million');
    // A default-write table must never price a 12h/mixed policy as a 30m write.
    expect(codexRouteCost(from, to, 'api', null, warm, 'e', 1000, 1, [{ ttl: '12h' }])).toMatchObject({ hold: true, reason: 'cost_unknown_hold' });
  });
  it('does not infer unknown rates, nonstandard speed prices, or a saving for an effort-only edit', () => {
    for (const billing of ['unknown', 'chatgpt', 'api'] as const) {
      expect(codexRouteCost(from, to, billing, 'ultrafast', cache(), 'e', 1)).toMatchObject({ hold: true, reason: 'cost_unknown_hold' });
    }
    expect(codexRouteCost(from, to, 'unknown', null, cache(), 'e', 1)).toMatchObject({ hold: true });
    expect(codexRouteCost(from, 'unpublished-model', 'chatgpt', null, cache(), 'e', 1)).toMatchObject({ hold: true });
    expect(codexRouteCost('gpt-5.6-sol', 'gpt-6.1-sol', 'chatgpt', null, cache(), 'e', 1)).toMatchObject({ hold: true });
    expect(codexRouteCost(from, from, 'chatgpt', null, cache(), 'e', 1)).toBeNull();
  });
  it('holds arithmetic overflow instead of allowing a switch through NaN comparison', () => {
    const p = { source: 'fixture', revision: 'test', input: Number.MAX_VALUE, read: 0, output: Number.MAX_VALUE };
    expect(switchCost({ prefix: Number.MAX_SAFE_INTEGER, targetHeld: 0, baseline: p, target: { ...p, output: 0 }, baselineWrite: p.input, targetWrite: p.input,
      baselineCache: 'warm', targetCache: 'cold', outputRange: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], returns: true })).toMatchObject({ hold: true, reason: 'cost_unknown_hold', deltaUsd: null });
  });
});
