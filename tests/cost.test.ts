import { describe, it, expect } from 'vitest';
import fixture from './fixtures/cache-cost-20261008.json' with { type: 'json' };
import { normalizeUsage, usageCost, ModelCache, cacheState, observedTtl, switchCost } from '../src/cost.js';
import { providerPrice } from '../src/provider-prices.js';
import { delegationCost } from '../src/admission.js';
import { claudeEffortCache, effortCacheHit } from '../src/claude-cache.js';
import { CACHE_GONE, CACHE_REACH, costHold, routeCost, TURN_HORIZON } from '../src/route-cost.js';
import { observedDelegationPrices } from '../src/delegation-prices.js';

const price = { source: 'fixture', revision: 'test-v1', input: 4, read: .2, write5m: 5, write1h: 8, output: 20 };
const raw = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20 }, output_tokens_details: { thinking_tokens: 4 } };
describe('observed usage and cost', () => {
  it('reproduces 76 historical host list estimates with frozen inferred prices, separately checking current official rates', () => {
    expect(fixture.rows).toHaveLength(76);
    for (const row of fixture.rows) {
      const costs = row.models.map(m => usageCost(normalizeUsage('claude', m.usage), { ...fixture.prices[m.model as keyof typeof fixture.prices], revision: fixture.revision, source: fixture.source }).usd);
      expect(costs.every(c => c !== null), row.cell).toBe(true);
      expect(Math.abs(costs.reduce<number>((s, c) => s + c!, 0) - row.cost_usd), row.cell).toBeLessThan(.001);
    }
    expect(providerPrice('claude', 'claude-sonnet-5-5', 100_000)?.read).toBe(.1);
    expect(fixture.prices['claude-sonnet-5-5'].read).toBe(.2);
    expect(fixture.note).toContain('not the production price table');
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
  it('permits cheap output on input-neutral Haiku, holds short Sonnet and bounds the return to the baseline', () => {
    const common = { prefix: 100_000, targetHeld: 0, baseline: price, baselineCache: 'warm' as const, targetCache: 'cold' as const, baselineWrite: 8, outputRange: [0, 1000] as const, returns: true };
    const haiku = { ...price, read: .01, output: .5 };
    expect(switchCost({ ...common, target: haiku, targetWrite: .2 }).hold).toBe(false);
    expect(switchCost({ ...common, target: { ...price, output: 10 }, targetWrite: 4 })).toMatchObject({ hold: true, reason: 'cost_hold' });
    expect(switchCost({ ...common, target: { ...price, output: 10 }, targetWrite: 4, outputRange: [40_000, 50_000] }).hold).toBe(false);
    // Unknown target state: what it held may be read or written.
    expect(switchCost({ ...common, target: price, targetWrite: 8, targetCache: 'unknown', targetHeld: 100_000 })).toMatchObject({ hold: true, reason: 'cost_unknown_hold' });
    // A cold baseline left cold is rewritten on return: staying is then worth its read, not its write.
    expect(switchCost({ ...common, baselineCache: 'cold', target: haiku, targetWrite: 1, returns: false }).hold).toBe(false);
    expect(switchCost({ ...common, baselineCache: 'cold', target: haiku, targetWrite: 1 }).hold).toBe(true);
    // A warm target still writes what was added since its own request.
    expect(switchCost({ ...common, targetCache: 'warm', target: { ...price, read: .1, output: 10 }, targetWrite: 4, targetHeld: 90_000 }).hold).toBe(true);
    expect(switchCost({ ...common, targetCache: 'warm', target: { ...price, read: .1, output: 10 }, targetWrite: 4, targetHeld: 100_000 }).hold).toBe(false);
    expect(switchCost({ ...common, target: null, targetWrite: .2 })).toMatchObject({ hold: true, reason: 'cost_unknown_hold', deltaUsd: null });
    expect(providerPrice('claude', 'claude-haiku-5-5', 100_001)?.write1h).toBe(1);
    expect(providerPrice('codex', 'gpt-6.1-sol', 300_000)?.output).toBe(15);
    expect(providerPrice('codex', 'gpt-6.1-sol', 1000, 'priority')).toBeNull();
  });
  it('prices startup, rereads, output and a declared horizon; unknown observations retain token policy', () => {
    const model = { coordinatorTurns: 11, workerTokensPerCall: 40_000, prices: { root: price, worker: { ...price, output: 10 }, workerWriteRate: 4, startupRange: [41_000, 49_000] as const, reexploreRange: null, outputRange: [0, 1000] as const, residualContext: 1000, horizon: null, overheadUsd: [0, .01] as const, provenance: 'observed_range' } };
    expect(delegationCost(25, 86_700, model)).toMatchObject({ basis: 'tokens', savingUsd: null, components: { m4: null } });
    const priced = delegationCost(25, 86_700, { ...model, prices: { ...model.prices, reexploreRange: [0, 10_000], residualContext: 50_000, horizon: 3 } });
    expect(priced.components.m3).toEqual([0, .04]); expect(priced.components.m4).toBeCloseTo(.03);
    expect(priced.savingUsd?.[0]).toBeCloseTo(-.17324); expect(priced.savingUsd?.[1]).toBeCloseTo(-.08124);
  });
  it('retains known Claude prices without guessing an unknown Codex worker price band', () => {
    const prices = observedDelegationPrices('claude', 'claude-opus-5-5', 'claude-sonnet-5-5', 86700);
    expect(prices).toBeDefined();
    expect(delegationCost(25, 86700, { coordinatorTurns: 11, workerTokensPerCall: 40000, prices: prices! })).toMatchObject({ basis: 'tokens', savingUsd: null, components: { m1: expect.any(Number), m2: null, m3: null, m4: null, m5: null } });
    expect(observedDelegationPrices('codex', 'gpt-6.1-sol', 'gpt-6-luna', 86700)).toBeUndefined();
    const observed = observedDelegationPrices('codex', 'gpt-6.1-sol', 'gpt-6-luna', 86700, { range: [39000, 41000], writeRate: 1 });
    expect(observed).toBeDefined();
    expect(delegationCost(25, 86700, { coordinatorTurns: 11, workerTokensPerCall: 40000, prices: observed! })).toMatchObject({ basis: 'tokens', savingUsd: null, components: { m1: expect.any(Number), m2: [.039, .041], m3: null, m4: null, m5: null } });
  });
  it('lets the switch guard decide with the transcript TTL, instead of an unknown expiry or write price range', () => {
    const observed = (ttlMs: number | null) => {
      const cache = new ModelCache();
      cache.observe({ model: 'claude-opus-5-5', epoch: 'one', at: 0, ttlMs, ttlBoundsMs: [300_000, 3_600_000], input: 0, read: 49_000, write: 1000, output: 3000 });
      return cache;
    };
    const cost = (ttl: number | null, now = 1000) => routeCost('claude', 'claude-opus-5-5', 'claude-sonnet-5-5', observed(ttl), 'one', now, 1, TURN_HORIZON);
    expect(cost(null)).toMatchObject({ hold: true, reason: 'cost_hold' });
    expect(cost(300_000)).toMatchObject({ hold: false, reason: 'cost_allows' });
    expect(cost(null, 600_000)).toMatchObject({ hold: true, reason: 'cost_unknown_hold' });
    expect(cost(3_600_000, 600_000)).toMatchObject({ hold: true, reason: 'cost_hold' });
  });
  it('guards observed switches by exact price band, holds the unobserved and leaves effort and upgrades alone', () => {
    const bounds = [300_000, 3_600_000] as const;
    const opus = (read: number, at = 0) => ({ model: 'claude-opus-5-5', epoch: 'one', at, ttlMs: null, ttlBoundsMs: bounds, input: 10, read, write: 1000, output: 100 });
    const c = new ModelCache(); c.observe(opus(50_000));
    // Haiku's 1h write at or under 100k is Opus's read: input-neutral, so cheaper output decides. Sonnet writes dearer.
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-haiku-5-5', c, 'one', 1000)).toMatchObject({ hold: false, reason: 'cost_allows', evidence: { prefix_source: 'baseline' } });
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-sonnet-5-5', c, 'one', 1000)).toMatchObject({ hold: true, reason: 'cost_hold', whole_session_cost: 'unknown' });
    expect(cacheState(c.get('claude-opus-5-5', 'one'), 299_999)).toBe('warm');
    expect(cacheState(c.get('claude-opus-5-5', 'one'), 300_000)).toBe('unknown');
    expect(cacheState(c.get('claude-opus-5-5', 'one'), 3_600_000)).toBe('cold');
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-haiku-5-5', c, 'one', 3_600_000)?.hold).toBe(false);
    // Exactly at Haiku's 100k band edge the next request carries at least one token more: priced past the edge, so held.
    const edge = new ModelCache(); edge.observe(opus(100_000 - 10 - 1000 - 100));
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-haiku-5-5', edge, 'one', 1000)).toMatchObject({ hold: true, reason: 'cost_hold' });
    // One token under the edge, the request's own new input decides the band: two new tokens cross it.
    const under = new ModelCache(); under.observe(opus(100_000 - 1 - 10 - 1000 - 100));
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-haiku-5-5', under, 'one', 1000)).toMatchObject({ hold: false, reason: 'cost_allows' });
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-haiku-5-5', under, 'one', 1000, 2)).toMatchObject({ hold: true, reason: 'cost_hold', inputs: { target: providerPrice('claude', 'claude-haiku-5-5', 100_001) } });
    c.observe(opus(150_000)); // Over Haiku's 100k band its write is dearer than Opus's read.
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-haiku-5-5', c, 'one', 1000)).toMatchObject({ hold: true, reason: 'cost_hold' });
    // Never observed in this context: any band, so held; a new context has no baseline to return to.
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-haiku-5-5', new ModelCache(), 'one', 1000)).toMatchObject({ hold: true, reason: 'cost_unknown_hold' });
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-sonnet-5-5', undefined, '', 1000)?.hold).toBe(false);
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-opus-5-5', c, 'one', 1000)).toBeNull();
    expect(costHold(routeCost('claude', 'claude-sonnet-5-5', 'claude-opus-5-5', c, 'one', 1000), 1, 2)).toEqual({ hold: false, reason: 'upgrade_allowed' });
    expect(costHold({ hold: true, reason: 'cost_hold' }, undefined, 0)).toEqual({ hold: true, reason: 'cost_hold' });
    expect(costHold(null, 2, 0)).toEqual({ hold: false, reason: 'not_checked' });
  });
  it('prices a root switch over a turn: the cache write is paid once and every later request saves (#271)', () => {
    const o = new ModelCache();
    o.observe({ model: 'claude-opus-5-5', at: 0, epoch: 'e', ttlMs: 3_600_000, read: 148_000, write: 1000, input: 1000, output: 1500 });
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-haiku-5-5', o, 'e', 1000, 10)).toMatchObject({ hold: true, reason: 'cost_hold', scope: 'next_request_scenario',
      output_basis: 'scenario_zero_to_previous_output', inputs: { outputRange: [0, 1500] } });
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-haiku-5-5', o, 'e', 1000, 10, TURN_HORIZON)).toMatchObject({ hold: false, reason: 'cost_allows', scope: 'turn_horizon', horizon: 5,
      output_basis: 'previous_output', inputs: { outputRange: [1500, 1500] } });
    // Sonnet's write is half Opus's, its read half too: at 150k it repays only after about 20 requests.
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-sonnet-5-5', o, 'e', 1000, 10, TURN_HORIZON)).toMatchObject({ hold: true, reason: 'cost_hold' });
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-sonnet-5-5', o, 'e', 1000, 10, 25)).toMatchObject({ hold: false });
    // Codex keeps the one-request price: a warm sol move to luna with output it may not repeat stays held (#271).
    const x = new ModelCache();
    x.observe({ model: 'gpt-6.1-sol', at: 0, epoch: 'e', ttlMs: 1_800_000, read: 97_000, write: 1000, input: 1000, output: 1000 });
    expect(routeCost('codex', 'gpt-6.1-sol', 'gpt-6-luna', x, 'e', 1000)).toMatchObject({ hold: true, inputs: { outputRange: [0, 1000] } });
    const v = { prefix: 0, targetHeld: 0, baseline: providerPrice('claude', 'claude-opus-5-5', 1)!, target: providerPrice('claude', 'claude-haiku-5-5', 1)!, baselineCache: 'warm' as const, targetCache: 'warm' as const, baselineWrite: 8, targetWrite: 1, outputRange: [0, 0] as [number, number], returns: true };
    for (const horizon of [Infinity, 0, 1.5]) expect(switchCost({ ...v, horizon })).toMatchObject({ hold: true, reason: 'cost_unknown_hold' });
    // A horizon never turns an unknown into an allowance.
    expect(routeCost('claude', 'claude-opus-5-5', 'claude-haiku-5-5', new ModelCache(), 'e', 1000, 10, TURN_HORIZON)).toMatchObject({ hold: true, reason: 'cost_unknown_hold' });
  });
  it('reads a target cache live by its TTL as warm only within reach of its last request (#274)', () => {
    // 55b329 at 08:50:55Z: Haiku answered 18 requests before, live by its TTL, and the switch read 30,040 of 99,448.
    const at = (since: number | undefined) => {
      const c = new ModelCache();
      c.observe({ model: 'claude-haiku-5-5', at: 0, epoch: 'e', ttlMs: 3_600_000, read: 99_000, write: 448, input: 2, output: 700, ...(since === undefined ? {} : { seq: 1 }) });
      c.observe({ model: 'claude-opus-5-5', at: 0, epoch: 'e', ttlMs: 3_600_000, read: 123_000, write: 1859, input: 2, output: 558, ...(since === undefined ? {} : { seq: 1 + since }) });
      return routeCost('claude', 'claude-opus-5-5', 'claude-haiku-5-5', c, 'e', 1000, 10, TURN_HORIZON);
    };
    expect(at(undefined)?.inputs.targetCache).toBe('warm');
    expect(at(CACHE_REACH)).toMatchObject({ inputs: { targetCache: 'warm' }, evidence: { target: { requests_since: 5 } } });
    expect(at(CACHE_REACH + 1)?.inputs.targetCache).toBe('unknown');
    expect(at(CACHE_GONE - 1)?.inputs.targetCache).toBe('unknown');
    expect(at(CACHE_GONE)?.inputs.targetCache).toBe('cold');
    expect(at(18)?.deltaUsd![1]).toBeGreaterThan(at(1)!.deltaUsd![1]);
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
