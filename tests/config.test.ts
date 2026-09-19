import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, MIGRATION_SAMPLE, resolveConfigPath, validateConfig } from '../src/config.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-config-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const V5 = {
  version: 5,
  mode: 'auto',
  jevModel: 'jev-1.13.0',
  requestDeadlineMs: 3000,
  admissionConfidenceFloor: 0.8,
  routeConfidenceFloor: 0.8,
  resultConfidenceFloor: 0.8,
  plannerDefaultTier: 'deep',
  models: { fast: 'haiku', standard: 'sonnet', deep: 'opus', frontier: 'fable' },
  maxParallelWorkers: 3,
  guardAllowTools: [],
};

const write = (name: string, value: unknown): string => {
  const p = join(tmp, name);
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  return p;
};

describe('validateConfig', () => {
  it('accepts a full V5 file and a partial file over the defaults', () => {
    // routeQuestionShape is optional in a file and defaulted, so a deployed V5 config keeps composite Gate B.
    expect(validateConfig(V5)).toEqual({ ok: true, config: { ...V5, mode: 'auto', routeQuestionShape: 'composite', delegationDepthFloor: 300_000 } });
    const partial = validateConfig({ version: 5, mode: 'native', plannerDefaultTier: 'frontier', models: { deep: 'claude-opus-5' } });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.config).toMatchObject({
      mode: 'native',
      plannerDefaultTier: 'frontier',
      models: { fast: 'haiku', standard: 'sonnet', deep: 'claude-opus-5', frontier: 'fable' },
      // T5: the default is one worker; parallel dispatch is opt-in until write isolation is actually verified.
      maxParallelWorkers: 1,
      guardAllowTools: [],
    });
    expect(DEFAULT_CONFIG.maxParallelWorkers).toBe(1);
    // Absent in a deployed file, so the floor arrives without anyone editing their config; 0 is accepted and turns it off.
    expect(DEFAULT_CONFIG.delegationDepthFloor).toBe(300_000);
    expect(validateConfig({ version: 5, delegationDepthFloor: 0 })).toMatchObject({ ok: true, config: { delegationDepthFloor: 0 } });
    // T11: a deployed file that still sets resultConfidenceFloor keeps loading; nothing reads it any more.
    const deprecated = validateConfig({ version: 5, mode: 'auto', resultConfidenceFloor: 0.95 });
    expect(deprecated).toMatchObject({ ok: true, config: { resultConfidenceFloor: 0.95 } });
  });

  it.each([
    ['V4 file', { version: 4, mode: 'auto', routeConfidenceFloor: 0.8, models: { sonnet: 'sonnet', opus: 'opus', fable: 'fable' } }],
    ['V3 file', { version: 3, mode: 'enrich', uncertainTier: 'opus' }],
    ['V4 floor key', { version: 5, confidenceFloor: 0.8 }],
    ['V4 model tiers', { version: 5, models: { sonnet: 'sonnet', opus: 'opus', fable: 'fable' } }],
  ])('rejects a %s with the V5 sample', (_name, raw) => {
    const r = validateConfig(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('"version": 5');
    expect(r.error).toContain('plannerDefaultTier');
  });

  it.each([
    ['unknown key', { version: 5, nope: 1 }, 'unknown config keys'],
    ['mode', { version: 5, mode: 'enrich2' }, 'mode must be'],
    ['jevModel', { version: 5, jevModel: 'jev 1;rm -rf' }, 'jevModel must match'],
    ['deadline over the hook timeout', { version: 5, requestDeadlineMs: 9000 }, 'requestDeadlineMs must be'],
    ['floor of zero', { version: 5, routeConfidenceFloor: 0 }, 'routeConfidenceFloor must be'],
    ['admission floor above one', { version: 5, admissionConfidenceFloor: 1.2 }, 'admissionConfidenceFloor must be'],
    ['result floor type', { version: 5, resultConfidenceFloor: 'high' }, 'resultConfidenceFloor must be'],
    ['planner tier', { version: 5, plannerDefaultTier: 'standard' }, 'plannerDefaultTier must be deep|frontier'],
    ['model name', { version: 5, models: { deep: 'opus; echo' } }, 'models.deep must match'],
    ['parallel cap', { version: 5, maxParallelWorkers: 0 }, 'maxParallelWorkers must be'],
    ['parallel cap type', { version: 5, maxParallelWorkers: 2.5 }, 'maxParallelWorkers must be'],
    ['guard allow-list', { version: 5, guardAllowTools: ['rm -rf'] }, 'guardAllowTools must be'],
    ['depth floor type', { version: 5, delegationDepthFloor: '300k' }, 'delegationDepthFloor must be'],
    ['negative depth floor', { version: 5, delegationDepthFloor: -1 }, 'delegationDepthFloor must be'],
    ['fractional depth floor', { version: 5, delegationDepthFloor: 300_000.5 }, 'delegationDepthFloor must be'],
  ])('rejects an invalid %s', (_name, raw, message) => {
    const r = validateConfig(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  it('keeps the V5 defaults in the migration sample', () => {
    const sample = JSON.parse(MIGRATION_SAMPLE) as Record<string, unknown>;
    const validated = validateConfig(sample);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.config).toEqual(DEFAULT_CONFIG);
  });
});

describe('loadConfig', () => {
  it('short-circuits JEV_GATE_MODE=off before reading any file', () => {
    const readFile = (): string => {
      throw new Error('config must not be read when the mode is off');
    };
    expect(loadConfig({ JEV_GATE_MODE: 'off', JEV_GATE_CONFIG: '/nope' }, readFile)).toMatchObject({ ok: true, source: 'env:off', config: { mode: 'off' } });
  });

  it('reads a file, lets JEV_GATE_MODE override only the mode, and reports a missing explicit path', () => {
    const p = write('c.json', { ...V5, mode: 'native', maxParallelWorkers: 2 });
    const loaded = loadConfig({ JEV_GATE_CONFIG: p });
    expect(loaded).toMatchObject({ ok: true, config: { mode: 'native', maxParallelWorkers: 2 } });
    expect(loadConfig({ JEV_GATE_CONFIG: p, JEV_GATE_MODE: 'auto' })).toMatchObject({ ok: true, config: { mode: 'auto', maxParallelWorkers: 2 } });
    expect(loadConfig({ JEV_GATE_CONFIG: join(tmp, 'missing.json') })).toMatchObject({ ok: false, error: 'JEV_GATE_CONFIG points to a missing file' });
    expect(loadConfig({ JEV_GATE_CONFIG: write('bad.json', '{nope') })).toMatchObject({ ok: false, error: 'config is not valid JSON' });
    expect(loadConfig({ JEV_GATE_MODE: 'enrich' })).toMatchObject({ ok: false, source: 'env' });
  });

  it('falls back to defaults with no file and resolves HOME', () => {
    expect(loadConfig({ HOME: join(tmp, 'nonexistent') })).toEqual({ ok: true, config: DEFAULT_CONFIG, source: 'defaults' });
    expect(resolveConfigPath({ HOME: '/h' })).toBe(join('/h', '.config', 'jev-gate', 'config.json'));
    expect(resolveConfigPath({ HOME: '/h', JEV_GATE_CONFIG: '/x/y.json' })).toBe('/x/y.json');
  });
});
