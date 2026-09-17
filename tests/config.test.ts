import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, resolveConfigPath, validateConfig } from '../src/config.js';

const enoent = (): never => {
  const err = new Error('missing') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
};

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const r = loadConfig({}, enoent);
    expect(r).toEqual({ ok: true, config: DEFAULT_CONFIG, source: 'defaults' });
  });

  it('applies JEV_GATE_MODE override and rejects invalid values', () => {
    expect(loadConfig({ JEV_GATE_MODE: 'enrich' }, enoent)).toMatchObject({ ok: true, config: { mode: 'enrich' } });
    expect(loadConfig({ JEV_GATE_MODE: 'turbo' }, enoent)).toMatchObject({ ok: false });
  });

  it('reads a v3 file and merges defaults', () => {
    const r = loadConfig({ JEV_GATE_CONFIG: '/x/c.json' }, () => JSON.stringify({ version: 3, routeConfidenceFloor: 0.6, opusModel: 'claude-opus-5' }));
    expect(r).toMatchObject({ ok: true, source: '/x/c.json', config: { routeConfidenceFloor: 0.6, opusModel: 'claude-opus-5', jevModel: 'jev-1.13.0' } });
  });

  it('fails when JEV_GATE_CONFIG points to a missing file or invalid JSON', () => {
    expect(loadConfig({ JEV_GATE_CONFIG: '/nope.json' }, enoent)).toMatchObject({ ok: false });
    expect(loadConfig({ JEV_GATE_CONFIG: '/x.json' }, () => '{not json')).toMatchObject({ ok: false, error: 'config is not valid JSON' });
  });

  it('explains v1/v2 layouts instead of mixing them', () => {
    const r = validateConfig({ version: 1, jev: { endpoint: 'x' }, worker: {}, frontier: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/v3/);
  });

  it('rejects out-of-range or unsafe values', () => {
    expect(validateConfig({ version: 3, requestDeadlineMs: 0 }).ok).toBe(false);
    expect(validateConfig({ version: 3, requestDeadlineMs: 4500 }).ok).toBe(false);
    expect(validateConfig({ version: 3, requestDeadlineMs: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateConfig({ version: 3, routeConfidenceFloor: 1.5 }).ok).toBe(false);
    expect(validateConfig({ version: 3, mode: 'off ' }).ok).toBe(false);
    expect(validateConfig({ version: 3, jevModel: 'jev latest; rm -rf' }).ok).toBe(false);
    expect(validateConfig({ version: 3, uncertainTier: 'sonnet' }).ok).toBe(false);
    expect(validateConfig({ version: 3, unknownKey: 1 }).ok).toBe(false);
    expect(validateConfig({ version: 3, uncertainTier: 'opus', requestDeadlineMs: 2500 })).toMatchObject({ ok: true, config: { uncertainTier: 'opus', requestDeadlineMs: 2500 } });
  });

  it('resolves the explicit path first', () => {
    expect(resolveConfigPath({ JEV_GATE_CONFIG: '/tmp/a.json' })).toBe('/tmp/a.json');
    expect(resolveConfigPath({})).toMatch(/\.config\/jev-gate\/config\.json$/);
  });
});
