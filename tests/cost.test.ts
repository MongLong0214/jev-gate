import { describe, it, expect } from 'vitest';
import fixture from './fixtures/cache-cost-20261008.json' with { type: 'json' };
import { normalizeUsage, usageCost, ModelCache, cacheState, observedTtl, switchCost } from '../src/cost.js';
import { providerPrice } from '../src/provider-prices.js';
import { delegationCost } from '../src/admission.js';
import { claudeEffortCache, effortCacheHit } from '../src/claude-cache.js';

const price = { source: 'fixture', revision: 'test-v1', input: 4, read: .2, write5m: 5, write1h: 8, output: 20 };
const raw = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20 }, output_tokens_details: { thinking_tokens: 4 } };
describe('observed usage and cost', () => {
  it('reproduces all 76 observed aggregate bills without using the production price table as a fitted constant', () => {
    expect(fixture.rows).toHaveLength(76);
    for (const row of fixture.rows) {
      const costs = row.models.map(m => usageCost(normalizeUsage('claude', m.usage), { ...fixture.prices[m.model as keyof typeof fixture.prices], revision: fixture.revision, source: fixture.source }).usd);
      expect(costs.every(c => c !== null), row.cell).toBe(true);
      expect(Math.abs(costs.reduce<number>((s, c) => s + c!, 0) - row.cost_usd), row.cell).toBeLessThan(.001);
    }
    expect(providerPrice('claude', 'claude-sonnet-5-5', 100_000)?.read).toBe(.1);
  });
  it('normalizes each provider contract and never bills reasoning twice', () => {
    const u = normalizeUsage('claude', raw);
    expect(usageCost(u, price).usd).toBeCloseTo((8 + 20 + 160 + 200) / 1e6);
    expect(normalizeUsage('codex', { input_tokens: 122, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 20 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 } })).toMatchObject({ input: 2, thinking: 4, coverage: 'complete' });
    expect(normalizeUsage('codex', { input_tokens: 10, input_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 }, output_tokens: 1 }).coverage).toBe('invalid');
    expect(normalizeUsage('codex', {}).coverage).toBe('partial');
    expect(normalizeUsage('claude', { ...raw, cache_creation: { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 20 } }).coverage).toBe('invalid');
    expect(usageCost(normalizeUsage('claude', { ...raw, cache_creation: {} }), price).reason).toBe('write_ttl_unknown');
    expect(usageCost(normalizeUsage('claude', {}), price).usd).toBeNull();
  });
  it('uses model-specific epochs and observed TTL rather than expiring OpenAI after its minimum guarantee', () => {
    const c = new ModelCache(); c.observe({ model: 'A', epoch: 'one', at: 0, ttlMs: 300_000, read: 100, write: 10, output: 2 });
    expect(cacheState(c.get('A', 'one'), 299_999)).toBe('warm');
    expect(cacheState(c.get('A', 'one'), 300_000)).toBe('cold');
    expect(c.get('A', 'two')).toBeNull();
    c.observe({ model: 'B', epoch: 'one', at: 0, ttlMs: 1_800_000, ttlIsMinimum: true, read: 100, write: 10, output: 2 });
    expect(cacheState(c.get('B', 'one'), 1_800_001)).toBe('unknown');
    expect(observedTtl(normalizeUsage('claude', raw))).toBe(3_600_000);
    c.clear(); expect(c.get('B', 'one')).toBeNull();
  });
  it('permits cheap output on input-neutral Haiku, holds short Sonnet and accounts for return scenarios', () => {
    const common = { prefix: 100_000, baseline: price, baselineCache: 'warm' as const, targetCache: 'cold' as const, baselineWrite: 8, outputRange: [0, 1000] as const };
    expect(switchCost({ ...common, target: { ...price, read: .01, output: .5 }, targetWrite: .2 }).hold).toBe(false);
    expect(switchCost({ ...common, target: { ...price, output: 10 }, targetWrite: 4 }).hold).toBe(true);
    expect(switchCost({ ...common, target: { ...price, output: 10 }, targetWrite: 4, outputRange: [40_000, 50_000] }).hold).toBe(false);
    expect(switchCost({ ...common, target: price, targetWrite: 8, targetCache: 'unknown' }).reason).toBe('cost_unknown');
    expect(switchCost({ ...common, target: { ...price, output: .5 }, targetWrite: .2, returnWriteRange: [.8, .8] }).hold).toBe(true);
    expect(providerPrice('claude', 'claude-haiku-5-5', 100_001)?.write1h).toBe(1);
    expect(providerPrice('codex', 'gpt-6.1-sol', 300_000)?.output).toBe(15);
    expect(providerPrice('codex', 'gpt-6.1-sol', 1000, 'priority')).toBeNull();
  });
  it('prices startup, rereads, output and a declared horizon; unknown observations retain token policy', () => {
    const model = { coordinatorTurns: 11, workerTokensPerCall: 40_000, prices: { root: price, worker: { ...price, output: 10 }, workerWriteRate: 4, startupRange: [41_000, 49_000] as const, reexploreRange: null, outputRange: [0, 1000] as const, residualContext: 1000, horizon: null, overheadUsd: [0, .01] as const, provenance: 'observed_range' } };
    expect(delegationCost(25, 86_700, model)).toMatchObject({ basis: 'tokens', savingUsd: null, components: { m4: 0 } });
    const priced = delegationCost(25, 86_700, { ...model, prices: { ...model.prices, reexploreRange: [0, 10_000] } });
    expect(priced.basis).toBe('api_list_estimate'); expect(priced.savingUsd?.[0]).toBeTypeOf('number');
  });
  it('keeps unknown, excluded and old-host cache capabilities conservative and restores the floor on an observed miss', () => {
    const capabilities = { host: '2.1.288', connection: 'api-key' as const, excluded: false, hipaa: false };
    expect(claudeEffortCache('claude-opus-5-5', capabilities)).toBe('supported');
    expect(claudeEffortCache('claude-opus-5-5', { ...capabilities, host: '2.1.287' })).toBe('capability_unknown');
    expect(claudeEffortCache('claude-opus-5-5', { ...capabilities, hipaa: null })).toBe('capability_unknown');
    expect(claudeEffortCache('claude-opus-5-5', { ...capabilities, excluded: true })).toBe('excluded');
    expect(effortCacheHit({ read: 80, write: 20 }, { read: 98 })).toBe(true);
    expect(effortCacheHit({ read: 80, write: 20 }, { read: 97 })).toBe(false);
    expect(effortCacheHit({ read: null, write: 20 }, { read: 0 })).toBeNull();
  });
});
