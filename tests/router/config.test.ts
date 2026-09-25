import { describe, expect, it } from 'vitest';

import { anyRouting, resolveConfig } from '../../mods/router/hooks/config.ts';
import { FAKE_KEY } from './fake-engine.ts';

const ok = (options: Record<string, string | number | boolean>) => {
  const r = resolveConfig(options);
  if (!r.ok) throw new Error(`invalid option ${r.field}`);
  return r.config;
};

describe('resolveConfig', () => {
  it('is off by default, and off registers nothing', () => {
    const c = ok({});
    expect(c).toMatchObject({
      enabled: false,
      routeSubagentModel: true,
      routeMainEffort: true,
      routeMainModel: false,
      explicitKey: { kind: 'absent' },
      tiers: { fast: 'haiku', standard: 'sonnet', deep: 'opus' },
      tierIssues: [],
      minUpgradeConfidence: 0.8,
      minDowngradeConfidence: 0.9,
      timeoutMs: 800,
      logDecisions: true,
    });
    expect(anyRouting(c)).toBe(false);
    expect(anyRouting(ok({ enabled: true }))).toBe(true);
    expect(anyRouting(ok({ enabled: true, routeSubagentModel: false, routeMainEffort: false, routeMainModel: false }))).toBe(false);
  });

  it('turns the Router off, naming the field, for a wrong type or an out-of-range number', () => {
    const cases: Array<[Record<string, string | number | boolean>, string]> = [
      [{ enabled: 'yes' }, 'enabled'],
      [{ routeMainModel: 1 }, 'routeMainModel'],
      [{ logDecisions: 'false' }, 'logDecisions'],
      [{ minUpgradeConfidence: 0.5 - 1e-9 }, 'minUpgradeConfidence'],
      [{ minDowngradeConfidence: 1.01 }, 'minDowngradeConfidence'],
      [{ timeoutMs: 49 }, 'timeoutMs'],
      [{ timeoutMs: 30_001 }, 'timeoutMs'],
      [{ timeoutMs: Number.NaN }, 'timeoutMs'],
    ];
    for (const [options, field] of cases) expect(resolveConfig(options)).toEqual({ ok: false, field });
  });

  it('keeps an explicit key only when it can ride in a header, and never falls back from an invalid one', () => {
    expect(ok({ typesafeApiKey: FAKE_KEY }).explicitKey).toEqual({ kind: 'valid', value: FAKE_KEY });
    expect(ok({ typesafeApiKey: '' }).explicitKey).toEqual({ kind: 'absent' });
    expect(ok({ typesafeApiKey: '   ' }).explicitKey).toEqual({ kind: 'absent' });
    for (const bad of ['short', 'sk-with space-testonly', 'sk-ünïcode-testonlynotakey', 'x'.repeat(1025)]) {
      expect(ok({ typesafeApiKey: bad }).explicitKey).toEqual({ kind: 'invalid' });
    }
    expect(ok({ typesafeApiKey: 12345678 }).explicitKey).toEqual({ kind: 'invalid' });
  });

  it('drops a profile it cannot trust and says which and why', () => {
    const c = ok({ fastModel: 'claude-haiku-4-5', standardModel: 'not a model!', deepModel: 'claude-opus-9-9', frontierModel: 'opus' });
    expect(c.tiers).toEqual({ fast: 'claude-haiku-4-5' });
    expect(c.tierIssues).toEqual([
      { tier: 'standard', reason: 'invalid' },
      { tier: 'deep', reason: 'unknown_model' },
      // Frontier exists only as an exact identifier; an alias cannot authorize it.
      { tier: 'frontier', reason: 'unknown_model' },
    ]);
    expect(ok({ frontierModel: 'claude-fable-5-1' }).tiers.frontier).toBe('claude-fable-5-1');
    expect(ok({ frontierModel: '' }).tiers.frontier).toBeUndefined();
    expect(ok({ deepModel: 'claude-opus-5-5[1m]' }).tiers.deep).toBe('claude-opus-5-5[1m]');
    // Only a suffix the host lists for that model names a known variant.
    for (const deepModel of ['claude-opus-5-5[bogus]', 'claude-fable-5-1[1m]']) {
      expect(ok({ deepModel }).tierIssues, deepModel).toEqual([{ tier: 'deep', reason: 'unknown_model' }]);
    }
  });

  it('keeps no profile at all when two name one family, since every rank lookup would be a guess', () => {
    const c = ok({ standardModel: 'opus' });
    expect(c.tiers).toEqual({});
    expect(c.tierIssues.map((i) => i.reason)).toEqual(['ambiguous', 'ambiguous', 'ambiguous']);
    expect(ok({ deepModel: 'claude-opus-5-5', frontierModel: 'claude-fable-5-1' }).tiers).toEqual({
      fast: 'haiku',
      standard: 'sonnet',
      deep: 'claude-opus-5-5',
      frontier: 'claude-fable-5-1',
    });
  });
});
