import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, effectiveDepthFloor, hookDefaultMode, IGNORED_KEYS, LEGACY_DEPTH_FLOOR, loadConfig, MIGRATION_SAMPLE, resolveConfigPath, validateConfig } from '../src/config.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-config-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const V5 = {
  version: 5,
  mode: 'auto',
  jevModel: 'jev-1.14.0',
  requestDeadlineMs: 3000,
  admissionConfidenceFloor: 0.8,
  routeConfidenceFloor: 0.8,
  models: { fast: 'haiku', standard: 'sonnet', deep: 'opus', frontier: 'fable' },
  workerIsolation: 'worktree',
};

const write = (name: string, value: unknown): string => {
  const p = join(tmp, name);
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  return p;
};

describe('validateConfig', () => {
  it('accepts a full V5 file and a partial file over the defaults', () => {
    // Every key past the sample is optional in a file and defaulted; 0.4.0 moved Gate B to atomic and the shape to auto.
    expect(validateConfig(V5)).toEqual({
      ok: true,
      config: {
        ...V5,
        mode: 'auto',
        frontierEnabled: false,
        routeQuestionShape: 'atomic',
        delegationDepthFloor: 0,
        delegationDepthFraction: 0.6,
        admissionQuestionShape: 'atomic',
        delegationCoordinatorTurns: 11,
        delegationWorkerTokensPerCall: 40_000,
        verifyWorkerChecks: true,
      },
    });
    const partial = validateConfig({ version: 5, mode: 'native', models: { deep: 'claude-opus-5' } });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.config).toMatchObject({
      mode: 'native',
      models: { fast: 'haiku', standard: 'sonnet', deep: 'claude-opus-5', frontier: 'claude-fable-5-1' },
    });
    // #48 P0-1: absent (and an explicit null) derive the floor from the host's own compaction window instead of a
    // fixed absolute number; 0 is still accepted and still turns the floor off outright.
    expect(DEFAULT_CONFIG.delegationDepthFloor).toBe(0);
    expect(DEFAULT_CONFIG.delegationDepthFraction).toBe(0.6);
    expect(validateConfig({ version: 5, delegationDepthFloor: null })).toMatchObject({ ok: true, config: { delegationDepthFloor: null } });
    expect(validateConfig({ version: 5, delegationDepthFloor: 0 })).toMatchObject({ ok: true, config: { delegationDepthFloor: 0 } });
    expect(validateConfig({ version: 5, delegationDepthFloor: 300_000 })).toMatchObject({ ok: true, config: { delegationDepthFloor: 300_000 } });
    expect(validateConfig({ version: 5, delegationDepthFraction: 0.3 })).toMatchObject({ ok: true, config: { delegationDepthFraction: 0.3 } });
    for (const edge of [0.25, 0.95]) expect(validateConfig({ version: 5, delegationDepthFraction: edge })).toMatchObject({ ok: true, config: { delegationDepthFraction: edge } });
    // The two shapes are configured independently and no longer agree: Gate A ships atomic because the composite
    // question admitted 0 of 61 real prompts offline, while Gate B's atomic shape has one end-to-end observation.
    expect(DEFAULT_CONFIG.admissionQuestionShape).toBe('atomic');
    expect(DEFAULT_CONFIG.routeQuestionShape).toBe('atomic');
    expect(validateConfig({ version: 5, admissionQuestionShape: 'composite' })).toMatchObject({ ok: true, config: { admissionQuestionShape: 'composite', routeQuestionShape: 'atomic' } });
    expect(validateConfig({ version: 5, verifyWorkerChecks: false, delegationCoordinatorTurns: 17, delegationWorkerTokensPerCall: 60_000 })).toMatchObject({
      ok: true,
      config: { verifyWorkerChecks: false, delegationCoordinatorTurns: 17, delegationWorkerTokensPerCall: 60_000 },
    });
    // #213: a deployed file that still sets the withdrawn Gate C floor loads whatever its value, and the floor is dropped.
    for (const floor of [0.95, 'high']) {
      const old = validateConfig({ ...V5, resultConfidenceFloor: floor });
      expect(old).toMatchObject({ ok: true, config: { admissionConfidenceFloor: 0.8, routeConfidenceFloor: 0.8 } });
      if (old.ok) expect(old.config).not.toHaveProperty('resultConfidenceFloor');
    }
    expect(MIGRATION_SAMPLE).not.toContain('resultConfidenceFloor');
    expect(DEFAULT_CONFIG).not.toHaveProperty('resultConfidenceFloor');
    // #289: a deployed file that still sets a removed planner or guard key loads, whatever its value, and drops it.
    const removed = { plannerDefaultTier: 'standard', maxParallelWorkers: 0, guardAllowTools: ['rm -rf'], guardAllowMcp: 'yes', maxTasksPerPlan: 65, admittedShape: 'hierarchy', planInterpretation: null };
    expect(Object.keys(removed).every((k) => IGNORED_KEYS.has(k))).toBe(true);
    const legacy = validateConfig({ ...V5, ...removed });
    expect(legacy).toMatchObject({ ok: true, config: { workerIsolation: 'worktree' } });
    if (legacy.ok) for (const k of Object.keys(removed)) expect(legacy.config).not.toHaveProperty(k);
    for (const k of Object.keys(removed)) expect(MIGRATION_SAMPLE).not.toContain(k);
  });

  it('refuses an unknown mode from JEV_GATE_MODE, the gateMode option or a file instead of mapping it', () => {
    const p = write('old-mode.json', { ...V5, mode: 'lean' });
    expect(loadConfig({ JEV_GATE_CONFIG: p })).toMatchObject({ ok: false, source: p });
    expect(loadConfig({ JEV_GATE_MODE: 'lean' })).toMatchObject({ ok: false, source: 'env' });
    expect(loadConfig({ CLAUDE_PLUGIN_OPTION_GATEMODE: 'lean' })).toMatchObject({ ok: false, source: 'env' });
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
    expect(r.error).toContain('workerIsolation');
  });

  it.each([
    ['unknown key', { version: 5, nope: 1 }, 'unknown config keys'],
    ['mode', { version: 5, mode: 'enrich2' }, 'mode must be'],
    // A mode from an older release is refused like any unknown mode; nothing maps it to another mode.
    ['mode from an older release', { version: 5, mode: 'lean' }, 'mode must be'],
    // The withdrawn search filter's mode: a deployed file that still sets it is refused with the reason, not crashed.
    ['withdrawn context mode', { version: 5, mode: 'context' }, 'the `context` search filter was withdrawn'],
    ['jevModel', { version: 5, jevModel: 'jev 1;rm -rf' }, 'jevModel must match'],
    ['deadline over the hook timeout', { version: 5, requestDeadlineMs: 9000 }, 'requestDeadlineMs must be'],
    ['floor of zero', { version: 5, routeConfidenceFloor: 0 }, 'routeConfidenceFloor must be'],
    ['admission floor above one', { version: 5, admissionConfidenceFloor: 1.2 }, 'admissionConfidenceFloor must be'],
    ['model name', { version: 5, models: { deep: 'opus; echo' } }, 'models.deep must match'],
    ['depth floor type', { version: 5, delegationDepthFloor: '300k' }, 'delegationDepthFloor must be'],
    ['negative depth floor', { version: 5, delegationDepthFloor: -1 }, 'delegationDepthFloor must be'],
    ['fractional depth floor', { version: 5, delegationDepthFloor: 300_000.5 }, 'delegationDepthFloor must be'],
    ['depth fraction type', { version: 5, delegationDepthFraction: '0.6' }, 'delegationDepthFraction must be'],
    ['coordinator turns zero', { version: 5, delegationCoordinatorTurns: 0 }, 'delegationCoordinatorTurns must be'],
    ['coordinator turns fraction', { version: 5, delegationCoordinatorTurns: 11.5 }, 'delegationCoordinatorTurns must be'],
    ['worker tokens type', { version: 5, delegationWorkerTokensPerCall: '40000' }, 'delegationWorkerTokensPerCall must be'],
    ['verify flag type', { version: 5, verifyWorkerChecks: 1 }, 'verifyWorkerChecks must be a boolean'],
    ['depth fraction zero', { version: 5, delegationDepthFraction: 0 }, 'delegationDepthFraction must be'],
    // #48 review: small enough to turn the derived floor into (nearly) nothing on a 100K window.
    ['depth fraction below 0.25', { version: 5, delegationDepthFraction: 0.001 }, 'delegationDepthFraction must be'],
    ['depth fraction above 0.95', { version: 5, delegationDepthFraction: 0.99 }, 'delegationDepthFraction must be'],
    ['depth fraction one', { version: 5, delegationDepthFraction: 1 }, 'delegationDepthFraction must be'],
    ['depth fraction above one', { version: 5, delegationDepthFraction: 1.5 }, 'delegationDepthFraction must be'],
    ['admission shape', { version: 5, admissionQuestionShape: 'fanout' }, 'admissionQuestionShape must be'],
    ['admission shape null', { version: 5, admissionQuestionShape: null }, 'admissionQuestionShape must be'],
  ])('rejects an invalid %s', (_name, raw, message) => {
    const r = validateConfig(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  describe('workerIsolation (#48 P1-2)', () => {
    it('defaults to worktree when absent and honors an explicit none', () => {
      expect(validateConfig({ version: 5 })).toMatchObject({ ok: true, config: { workerIsolation: 'worktree' } });
      expect(validateConfig({ version: 5, workerIsolation: 'none' })).toMatchObject({ ok: true, config: { workerIsolation: 'none' } });
    });

    it('rejects an unrecognized value', () => {
      const r = validateConfig({ version: 5, workerIsolation: 'branch' });
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('workerIsolation must be') });
    });

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
    const p = write('c.json', { ...V5, mode: 'native', workerIsolation: 'none' });
    const loaded = loadConfig({ JEV_GATE_CONFIG: p });
    expect(loaded).toMatchObject({ ok: true, config: { mode: 'native', workerIsolation: 'none' } });
    expect(loadConfig({ JEV_GATE_CONFIG: p, JEV_GATE_MODE: 'auto' })).toMatchObject({ ok: true, config: { mode: 'auto', workerIsolation: 'none' } });
    expect(loadConfig({ JEV_GATE_CONFIG: join(tmp, 'missing.json') })).toMatchObject({ ok: false, error: 'JEV_GATE_CONFIG points to a missing file' });
    expect(loadConfig({ JEV_GATE_CONFIG: write('bad.json', '{nope') })).toMatchObject({ ok: false, error: 'config is not valid JSON' });
    expect(loadConfig({ JEV_GATE_MODE: 'enrich' })).toMatchObject({ ok: false, source: 'env' });
  });

  it('falls back to defaults with no file and resolves HOME', () => {
    expect(loadConfig({ HOME: join(tmp, 'nonexistent') })).toEqual({ ok: true, config: DEFAULT_CONFIG, source: 'defaults' });
    expect(resolveConfigPath({ HOME: '/h' })).toBe(join('/h', '.config', 'jev-gate', 'config.json'));
    expect(resolveConfigPath({ HOME: '/h', JEV_GATE_CONFIG: '/x/y.json' })).toBe('/x/y.json');
  });

  it('runs a plugin hook auto with no setup; the gateMode option and JEV_GATE_MODE override it, a file decides otherwise', () => {
    const home = join(tmp, 'nonexistent');
    const plugin = { HOME: home, CLAUDE_PLUGIN_ROOT: '/p' };
    expect(hookDefaultMode(plugin)).toBe('auto');
    expect(hookDefaultMode({ HOME: home })).toBe('off');
    expect(loadConfig(plugin)).toEqual({ ok: true, config: DEFAULT_CONFIG, source: 'defaults' });
    expect(loadConfig(plugin, undefined, 'auto')).toEqual({ ok: true, config: { ...DEFAULT_CONFIG, mode: 'auto' }, source: 'defaults' });
    expect(loadConfig({ ...plugin, CLAUDE_PLUGIN_OPTION_GATEMODE: 'off' }, undefined, 'auto')).toMatchObject({ ok: true, source: 'env:off' });
    expect(loadConfig({ ...plugin, CLAUDE_PLUGIN_OPTION_GATEMODE: 'native' }, undefined, 'auto')).toMatchObject({ ok: true, config: { mode: 'native' } });
    expect(loadConfig({ ...plugin, CLAUDE_PLUGIN_OPTION_GATEMODE: 'off', JEV_GATE_MODE: 'native' }, undefined, 'auto')).toMatchObject({ ok: true, config: { mode: 'native' } });
    expect(loadConfig({ ...plugin, CLAUDE_PLUGIN_OPTION_GATEMODE: 'fast' }, undefined, 'auto')).toMatchObject({ ok: false, source: 'env' });
    const p = write('native.json', { ...V5, mode: 'native' });
    expect(loadConfig({ ...plugin, JEV_GATE_CONFIG: p }, undefined, 'auto')).toMatchObject({ ok: true, config: { mode: 'native' } });
    expect(loadConfig({ ...plugin, JEV_GATE_CONFIG: p, CLAUDE_PLUGIN_OPTION_GATEMODE: 'off' }, undefined, 'auto')).toMatchObject({ ok: true, source: 'env:off' });
  });
});

describe('gateMode precedence when the plugin option is unset (#96)', () => {
  // Stub env. An absent CLAUDE_PLUGIN_OPTION_GATEMODE is the resolver input, not evidence that a host omits it.
  const home = join(tmp, 'nonexistent-96');
  const plugin = { HOME: home, CLAUDE_PLUGIN_ROOT: '/plugin' };
  const file = (mode: string): string => write(`p96-${mode}.json`, { ...V5, mode });
  const unread = (): string => {
    throw new Error('config must not be read');
  };

  it('keeps the file mode when the plugin option is unset', () => {
    for (const mode of ['off', 'native']) {
      const path = file(mode);
      const env = { ...plugin, JEV_GATE_CONFIG: path };
      expect(loadConfig(env, undefined, hookDefaultMode(env))).toMatchObject({ ok: true, config: { mode }, source: path });
    }
  });

  it('stays auto for a legacy plugin hook with no file and no plugin option', () => {
    expect(hookDefaultMode(plugin)).toBe('auto');
    expect(loadConfig(plugin, undefined, hookDefaultMode(plugin))).toEqual({ ok: true, config: { ...DEFAULT_CONFIG, mode: 'auto' }, source: 'defaults' });
  });

  it('lets an explicit plugin auto override a file off', () => {
    const path = file('off');
    const env = { ...plugin, JEV_GATE_CONFIG: path, CLAUDE_PLUGIN_OPTION_GATEMODE: 'auto' };
    expect(loadConfig(env, undefined, hookDefaultMode(env))).toMatchObject({ ok: true, config: { mode: 'auto' }, source: path });
  });

  it('keeps the off fast path for an explicit plugin off before an unreadable config', () => {
    const env = { ...plugin, JEV_GATE_CONFIG: join(tmp, 'missing-96.json'), CLAUDE_PLUGIN_OPTION_GATEMODE: 'off' };
    expect(loadConfig(env, unread, 'auto')).toMatchObject({ ok: true, source: 'env:off', config: { mode: 'off' } });
    const denied = (): string => {
      const err = new Error('denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    expect(loadConfig({ ...env, JEV_GATE_CONFIG: join(tmp, 'denied-96.json') }, denied, 'auto')).toMatchObject({ ok: true, source: 'env:off', config: { mode: 'off' } });
  });

  it('returns off before reading a file when JEV_GATE_MODE=off, whatever else is set', () => {
    const env = { ...plugin, JEV_GATE_CONFIG: file('auto'), JEV_GATE_MODE: 'off', CLAUDE_PLUGIN_OPTION_GATEMODE: 'auto' };
    expect(loadConfig(env, unread, 'auto')).toMatchObject({ ok: true, source: 'env:off', config: { mode: 'off' } });
  });

  it('lets JEV_GATE_MODE=native beat an explicit plugin auto', () => {
    const path = file('off');
    const env = { ...plugin, JEV_GATE_CONFIG: path, JEV_GATE_MODE: 'native', CLAUDE_PLUGIN_OPTION_GATEMODE: 'auto' };
    expect(loadConfig(env, undefined, 'auto')).toMatchObject({ ok: true, config: { mode: 'native' }, source: path });
  });

  it('stays off for doctor and a bare node when nothing overrides and no file exists', () => {
    // doctor and a bare node call loadConfig without hookDefaultMode, so a plugin root alone does not select auto.
    expect(loadConfig(plugin)).toEqual({ ok: true, config: DEFAULT_CONFIG, source: 'defaults' });
    expect(loadConfig({ HOME: home })).toEqual({ ok: true, config: DEFAULT_CONFIG, source: 'defaults' });
  });

  it('follows a valid config file for doctor', () => {
    const path = file('native');
    expect(loadConfig({ HOME: home, JEV_GATE_CONFIG: path })).toMatchObject({ ok: true, config: { mode: 'native' }, source: path });
  });

  it('errors on a bad explicit config instead of treating it as no file and therefore auto', () => {
    const missing = { ...plugin, JEV_GATE_CONFIG: join(tmp, 'missing-explicit-96.json') };
    expect(loadConfig(missing, undefined, 'auto')).toMatchObject({ ok: false, error: 'JEV_GATE_CONFIG points to a missing file' });
    const bad = { ...plugin, JEV_GATE_CONFIG: write('p96-bad.json', '{nope') };
    expect(loadConfig(bad, undefined, 'auto')).toMatchObject({ ok: false, error: 'config is not valid JSON' });
    const denied = (): string => {
      const err = new Error('denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    expect(loadConfig({ ...plugin, JEV_GATE_CONFIG: join(tmp, 'denied-explicit-96.json') }, denied, 'auto')).toMatchObject({ ok: false, error: 'cannot read config: EACCES' });
  });
});

describe('effectiveDepthFloor (#48 P0-1)', () => {
  it('an explicit config value always wins, whatever the window is', () => {
    const config = { ...DEFAULT_CONFIG, delegationDepthFloor: 300_000 };
    expect(effectiveDepthFloor(config, null)).toEqual({ floor: 300_000, source: 'config' });
    expect(effectiveDepthFloor(config, 1_000_000)).toEqual({ floor: 300_000, source: 'config' });
    // 0 is a real, explicit value: it disables the floor outright, it is not "absent".
    expect(effectiveDepthFloor({ ...DEFAULT_CONFIG, delegationDepthFloor: 0 }, 1_000_000)).toEqual({ floor: 0, source: 'config' });
  });

  it("takes the atomic gate's floor from its cost model, whatever the window", () => {
    for (const window of [null, 200_000, 1_000_000]) expect(effectiveDepthFloor({ ...DEFAULT_CONFIG, delegationDepthFloor: null }, window)).toEqual({ floor: 50_865, source: 'cost_model' });
    // A coordinator that costs more turns needs a deeper session before anything can pay. The bound is the live last
    // bin (51.5), not a second copy of the default floor.
    expect(effectiveDepthFloor({ ...DEFAULT_CONFIG, delegationDepthFloor: null, delegationCoordinatorTurns: 30 }, null).floor).toBe(Math.floor((51.5 * 40_000) / (51.5 - 30)) + 1);
  });

  const composite = { ...DEFAULT_CONFIG, delegationDepthFloor: null, admissionQuestionShape: 'composite' as const };

  it("derives the composite gate's floor from the window at the configured fraction, capped at the legacy absolute floor", () => {
    // default fraction 0.6 x a 300K host window: a smaller window still admits some prompts before it compacts.
    expect(effectiveDepthFloor(composite, 300_000)).toEqual({ floor: 180_000, source: 'window_fraction' });
    // A 1M-window host keeps exactly the old 300K behaviour: min(LEGACY_DEPTH_FLOOR, 0.6 x 1,000,000) = 300,000.
    expect(effectiveDepthFloor(composite, 1_000_000)).toEqual({ floor: LEGACY_DEPTH_FLOOR, source: 'window_fraction' });
  });

  it('falls back to the legacy absolute floor for the composite gate when the window is unknown', () => {
    expect(effectiveDepthFloor(composite, null)).toEqual({ floor: LEGACY_DEPTH_FLOOR, source: 'fallback_absolute' });
  });
});
