import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, validateConfig } from '../src/config.js';

const enoent = (): never => {
  const err = new Error('missing') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
};

describe('V4 config', () => {
  it('defaults to off with no file', () => {
    expect(loadConfig({}, enoent)).toEqual({ ok: true, config: DEFAULT_CONFIG, source: 'defaults' });
    expect(DEFAULT_CONFIG.mode).toBe('off');
  });

  it('JEV_GATE_MODE=off short-circuits before any file is read, even an invalid one', () => {
    let reads = 0;
    const r = loadConfig({ JEV_GATE_MODE: 'off', JEV_GATE_CONFIG: '/x.json' }, () => {
      reads++;
      return '{not json';
    });
    expect(r).toMatchObject({ ok: true, config: { mode: 'off' }, source: 'env:off' });
    expect(reads).toBe(0);
  });

  it('JEV_GATE_MODE overrides only the mode; invalid values fail', () => {
    expect(loadConfig({ JEV_GATE_MODE: 'auto' }, enoent)).toMatchObject({ ok: true, config: { mode: 'auto', routeConfidenceFloor: 0.8 } });
    expect(loadConfig({ JEV_GATE_MODE: 'native' }, enoent)).toMatchObject({ ok: true, config: { mode: 'native' } });
    expect(loadConfig({ JEV_GATE_MODE: 'enrich' }, enoent)).toMatchObject({ ok: false });
  });

  it('reads a v4 file, merges defaults and validates model identifiers', () => {
    const r = loadConfig({ JEV_GATE_CONFIG: '/c.json' }, () => JSON.stringify({ version: 4, mode: 'native', models: { opus: 'claude-opus-5' } }));
    expect(r).toMatchObject({ ok: true, source: '/c.json', config: { mode: 'native', models: { sonnet: 'sonnet', opus: 'claude-opus-5', fable: 'fable' } } });
    expect(validateConfig({ version: 4, models: { sonnet: 'bad model; rm' } }).ok).toBe(false);
    expect(validateConfig({ version: 4, models: { haiku: 'haiku' } }).ok).toBe(false);
  });

  it('rejects a V3 layout instead of partially interpreting it, and names the migration', () => {
    for (const raw of [{ version: 3, mode: 'auto' }, { version: 4, uncertainTier: 'fable' }, { version: 4, mode: 'enrich' }, { version: 4, opusModel: 'opus' }]) {
      const r = validateConfig(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/V3 layout[\s\S]*"version": 4/);
    }
    const r = loadConfig({ JEV_GATE_CONFIG: '/v3.json', JEV_GATE_MODE: 'auto' }, () => JSON.stringify({ version: 3, mode: 'auto' }));
    expect(r.ok).toBe(false);
  });

  it('rejects unknown keys, bad bounds and missing explicit files', () => {
    expect(validateConfig({ version: 4, extra: 1 }).ok).toBe(false);
    expect(validateConfig({ version: 4, requestDeadlineMs: 4001 }).ok).toBe(false);
    expect(validateConfig({ version: 4, requestDeadlineMs: 0 }).ok).toBe(false);
    expect(validateConfig({ version: 4, routeConfidenceFloor: 1.2 }).ok).toBe(false);
    expect(validateConfig({ version: 5 }).ok).toBe(false);
    expect(loadConfig({ JEV_GATE_CONFIG: '/missing.json' }, enoent)).toMatchObject({ ok: false });
    expect(loadConfig({ JEV_GATE_CONFIG: '/x.json' }, () => 'nope')).toMatchObject({ ok: false, error: 'config is not valid JSON' });
  });
});
