import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { modelContextWindow, readHostCompactWindow } from '../src/host-window.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-host-window-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const dir = (): string => {
  const p = join(tmp, `d${(seq += 1)}`);
  mkdirSync(p, { recursive: true });
  return p;
};

const writeSettings = (root: string, rel: string, value: unknown): void => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
};

describe('readHostCompactWindow', () => {
  it('reads no window at all when nothing is set', () => {
    // HOME is always given explicitly here: an empty env falls back to the real machine's homedir(), exactly like
    // config.ts's resolveConfigPath, and this machine's own ~/.claude/settings.json is not this test's business.
    const cwd = dir();
    expect(readHostCompactWindow({ HOME: dir() }, cwd)).toEqual({ tokens: null, source: 'unknown' });
    expect(readHostCompactWindow({ HOME: dir() }, null)).toEqual({ tokens: null, source: 'unknown' });
    expect(readHostCompactWindow({ HOME: dir() }, undefined)).toEqual({ tokens: null, source: 'unknown' });
  });

  it('the env var wins over every settings file, even when they also set one', () => {
    const cwd = dir();
    const home = dir();
    writeSettings(cwd, '.claude/settings.local.json', { autoCompactWindow: 111_111 });
    writeSettings(home, '.claude/settings.json', { autoCompactWindow: 222_222 });
    expect(readHostCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000', HOME: home }, cwd)).toEqual({ tokens: 300_000, source: 'env' });
  });

  it('an invalid env value is not the env winning -- it falls through to the settings files', () => {
    const cwd = dir();
    writeSettings(cwd, '.claude/settings.local.json', { autoCompactWindow: 250_000 });
    for (const bad of ['not-a-number', '-1', '1.5', '', '0']) {
      expect(readHostCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: bad, HOME: dir() }, cwd)).toEqual({ tokens: 250_000, source: `settings:${join(cwd, '.claude', 'settings.local.json')}` });
    }
  });

  it('project settings.local.json wins over project settings.json, which wins over user settings', () => {
    const cwd = dir();
    const home = dir();
    writeSettings(home, '.claude/settings.json', { autoCompactWindow: 999_999 });
    expect(readHostCompactWindow({ HOME: home }, cwd)).toEqual({ tokens: 999_999, source: `settings:${join(home, '.claude', 'settings.json')}` });
    writeSettings(cwd, '.claude/settings.json', { autoCompactWindow: 500_000 });
    expect(readHostCompactWindow({ HOME: home }, cwd)).toEqual({ tokens: 500_000, source: `settings:${join(cwd, '.claude', 'settings.json')}` });
    writeSettings(cwd, '.claude/settings.local.json', { autoCompactWindow: 400_000 });
    expect(readHostCompactWindow({ HOME: home }, cwd)).toEqual({ tokens: 400_000, source: `settings:${join(cwd, '.claude', 'settings.local.json')}` });
  });

  it('CLAUDE_CONFIG_DIR redirects the user settings path; unset falls back to $HOME/.claude', () => {
    const cwd = dir();
    const configDir = dir();
    writeSettings(configDir, 'settings.json', { autoCompactWindow: 700_000 });
    expect(readHostCompactWindow({ CLAUDE_CONFIG_DIR: configDir, HOME: dir() }, cwd)).toEqual({ tokens: 700_000, source: `settings:${join(configDir, 'settings.json')}` });
  });

  it.each([
    ['a file over 1 MiB', () => 'x'.repeat(1024 * 1024 + 1)],
    ['invalid JSON', () => '{not json'],
    ['a JSON array', () => JSON.stringify([1, 2, 3])],
    ['a JSON string', () => JSON.stringify('nope')],
    ['autoCompactWindow missing', () => JSON.stringify({ other: 1 })],
    ['autoCompactWindow zero', () => JSON.stringify({ autoCompactWindow: 0 })],
    ['autoCompactWindow negative', () => JSON.stringify({ autoCompactWindow: -5 })],
    ['autoCompactWindow fractional', () => JSON.stringify({ autoCompactWindow: 300_000.5 })],
    ['autoCompactWindow a string', () => JSON.stringify({ autoCompactWindow: '300000' })],
  ])('skips a candidate file that is %s, never throwing', (_name, makeBody) => {
    const cwd = dir();
    writeSettings(cwd, '.claude/settings.local.json', makeBody());
    expect(readHostCompactWindow({ HOME: dir() }, cwd)).toEqual({ tokens: null, source: 'unknown' });
  });

  it('an unreadable settings path (missing file) is skipped, not an error', () => {
    const cwd = dir();
    expect(readHostCompactWindow({ HOME: dir() }, cwd)).toEqual({ tokens: null, source: 'unknown' });
  });
});

describe('#48 review: the window the host actually compacts at', () => {
  const none: string[] = [];

  it('clamps a configured window into the host range 100K..1M, so a tiny value can never derive a zero floor', () => {
    expect(readHostCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1', HOME: dir() }, null, { managedDirs: none })).toEqual({ tokens: 100_000, source: 'env (clamped from 1)' });
    const cwd = dir();
    writeSettings(cwd, '.claude/settings.json', { autoCompactWindow: 5_000_000 });
    expect(readHostCompactWindow({ HOME: dir() }, cwd, { managedDirs: none }).tokens).toBe(1_000_000);
  });

  it('caps a configured window at the model window: CLAUDE_CODE_DISABLE_1M_CONTEXT holds every model at 200K', () => {
    const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', CLAUDE_CODE_DISABLE_1M_CONTEXT: '1', HOME: dir() };
    expect(readHostCompactWindow(env, null, { managedDirs: none })).toEqual({ tokens: 200_000, source: 'env capped by CLAUDE_CODE_DISABLE_1M_CONTEXT' });
    expect(readHostCompactWindow({ ...env, CLAUDE_CODE_DISABLE_1M_CONTEXT: '0' }, null, { managedDirs: none }).tokens).toBe(1_000_000);
    expect(readHostCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000', HOME: dir() }, null, { model: 'claude-haiku-4-5-20251001', managedDirs: none })).toEqual({
      tokens: 200_000,
      source: 'env capped by model:claude-haiku-4-5-20251001',
    });
    // A window already under the model's is left alone.
    expect(readHostCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000', HOME: dir() }, null, { model: 'claude-opus-5-5', managedDirs: none })).toEqual({ tokens: 300_000, source: 'env' });
  });

  it.each([
    ['claude-opus-5-5', 1_000_000],
    ['claude-opus-4-7', 1_000_000],
    ['claude-sonnet-5', 1_000_000],
    ['claude-fable-5-1', 1_000_000],
    ['claude-opus-4-6', 200_000],
    ['claude-opus-4-6[1m]', 1_000_000],
    ['claude-sonnet-4-6', 200_000],
    ['claude-opus-4-20250514', 200_000],
    ['claude-haiku-4-5-20251001', 200_000],
    ['claude-3-5-sonnet-20241022', 200_000],
    ['my-gateway-alias', null],
  ])('with nothing configured, the model %s sets the window to %s', (model, tokens) => {
    const r = readHostCompactWindow({ HOME: dir() }, null, { model, managedDirs: none });
    expect(r.tokens).toBe(tokens);
    if (tokens !== null) expect(r.source).toBe(`default:model:${model}`);
  });

  it('does not establish a native-1M model window on Bedrock, Vertex or Foundry, where the deployment pins it', () => {
    for (const k of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      expect(modelContextWindow({ [k]: '1' }, 'claude-opus-5-5')).toBeNull();
      expect(modelContextWindow({ [k]: '1' }, 'claude-haiku-4-5')).toEqual({ tokens: 200_000, source: 'model:claude-haiku-4-5' });
    }
  });

  it('reads managed settings above every settings file but below the env var; the last drop-in in name order wins', () => {
    const managed = dir();
    const cwd = dir();
    writeSettings(cwd, '.claude/settings.local.json', { autoCompactWindow: 400_000 });
    writeSettings(managed, 'managed-settings.json', { autoCompactWindow: 600_000 });
    expect(readHostCompactWindow({ HOME: dir() }, cwd, { managedDirs: [managed] })).toEqual({ tokens: 600_000, source: `managed:${join(managed, 'managed-settings.json')}` });
    writeSettings(managed, 'managed-settings.d/20-b.json', { autoCompactWindow: 250_000 });
    writeSettings(managed, 'managed-settings.d/10-a.json', { autoCompactWindow: 700_000 });
    writeSettings(managed, 'managed-settings.d/.hidden.json', { autoCompactWindow: 900_000 });
    expect(readHostCompactWindow({ HOME: dir() }, cwd, { managedDirs: [managed] })).toEqual({ tokens: 250_000, source: `managed:${join(managed, 'managed-settings.d', '20-b.json')}` });
    expect(readHostCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000', HOME: dir() }, cwd, { managedDirs: [managed] }).source).toBe('env');
  });

  it('reads project settings from CLAUDE_PROJECT_DIR, which a `cd` does not move, before the hook cwd', () => {
    const project = dir();
    const moved = dir();
    writeSettings(project, '.claude/settings.json', { autoCompactWindow: 450_000 });
    writeSettings(moved, '.claude/settings.json', { autoCompactWindow: 150_000 });
    expect(readHostCompactWindow({ CLAUDE_PROJECT_DIR: project, HOME: dir() }, moved, { managedDirs: none }).tokens).toBe(450_000);
  });

  it('reads settings.local.json at the repository root, and at the main checkout root from a linked worktree', () => {
    const main = dir();
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const wt = dir();
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    writeSettings(main, '.claude/settings.local.json', { autoCompactWindow: 350_000 });
    // From a subdirectory of the worktree the walk reaches the worktree's `.git` file, then the main checkout.
    const sub = join(wt, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    expect(readHostCompactWindow({ HOME: dir() }, sub, { managedDirs: none })).toEqual({ tokens: 350_000, source: `settings:${join(main, '.claude', 'settings.local.json')}` });
    // In the main checkout itself, from a subdirectory, the repository root.
    const mainSub = join(main, 'lib');
    mkdirSync(mainSub);
    expect(readHostCompactWindow({ HOME: dir() }, mainSub, { managedDirs: none }).tokens).toBe(350_000);
  });

  it('keeps settings.local.json in the session directory when the repository root is the home directory', () => {
    const home = dir();
    mkdirSync(join(home, '.git'));
    const cwd = join(home, 'proj');
    mkdirSync(cwd);
    writeSettings(home, '.claude/settings.local.json', { autoCompactWindow: 800_000 });
    writeSettings(cwd, '.claude/settings.local.json', { autoCompactWindow: 220_000 });
    expect(readHostCompactWindow({ HOME: home }, cwd, { managedDirs: none }).tokens).toBe(220_000);
  });

  it('a symlinked settings file is read like the host reads it (the host follows it)', () => {
    const cwd = dir();
    const real = join(dir(), 'real.json');
    writeFileSync(real, JSON.stringify({ autoCompactWindow: 330_000 }));
    mkdirSync(join(cwd, '.claude'));
    symlinkSync(real, join(cwd, '.claude', 'settings.json'));
    expect(readHostCompactWindow({ HOME: dir() }, cwd, { managedDirs: none }).tokens).toBe(330_000);
  });
});

describe('#48 re-review: windows reported as known that were not', () => {
  const none: string[] = [];

  it('budgets Sonnet 5 at 200K behind an LLM gateway, and leaves Opus and Fable unknown there', () => {
    const gateway = { ANTHROPIC_BASE_URL: 'https://llm-gateway.example.com', HOME: dir() };
    expect(modelContextWindow(gateway, 'claude-sonnet-5')).toEqual({ tokens: 200_000, source: 'model:claude-sonnet-5 behind ANTHROPIC_BASE_URL' });
    expect(modelContextWindow(gateway, 'claude-sonnet-5[1m]')).toMatchObject({ tokens: 1_000_000 });
    expect(modelContextWindow(gateway, 'claude-opus-5-5')).toBeNull();
    expect(modelContextWindow(gateway, 'claude-haiku-4-5-20251001')).toMatchObject({ tokens: 200_000 });
    // Anthropic's own API under ANTHROPIC_BASE_URL is not a gateway.
    expect(modelContextWindow({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, 'claude-sonnet-5')).toMatchObject({ tokens: 1_000_000 });
    // A configured 1M is capped to the gateway's 200K rather than read as healthy.
    expect(readHostCompactWindow({ ...gateway, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' }, null, { model: 'claude-sonnet-5', managedDirs: none }).tokens).toBe(200_000);
  });

  it('reads every managed drop-in, not the first 64', () => {
    const managed = dir();
    for (let i = 0; i < 70; i++) writeSettings(managed, `managed-settings.d/${String(i).padStart(3, '0')}.json`, i === 69 ? { autoCompactWindow: 150_000 } : {});
    writeSettings(managed, 'managed-settings.d/000.json', { autoCompactWindow: 800_000 });
    expect(readHostCompactWindow({ HOME: dir() }, dir(), { managedDirs: [managed] })).toEqual({ tokens: 150_000, source: `managed:${join(managed, 'managed-settings.d', '069.json')}` });
  });

  it('keeps local settings beside project settings on Windows, even in a linked worktree', () => {
    const main = dir();
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const wt = dir();
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    writeSettings(main, '.claude/settings.local.json', { autoCompactWindow: 350_000 });
    writeSettings(wt, '.claude/settings.local.json', { autoCompactWindow: 250_000 });
    expect(readHostCompactWindow({ HOME: dir() }, wt, { managedDirs: none }).tokens).toBe(350_000);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(readHostCompactWindow({ HOME: dir() }, wt, { managedDirs: none }).tokens).toBe(250_000);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('#48 third review: the legacy local file in the starting directory', () => {
  it('reads a starting-directory settings.local.json an older host left, below the root file', () => {
    const root = dir();
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'pkg');
    mkdirSync(sub);
    writeSettings(sub, '.claude/settings.local.json', { autoCompactWindow: 150_000 });
    expect(readHostCompactWindow({ HOME: dir() }, sub, { managedDirs: [], model: 'claude-opus-5-5' })).toEqual({ tokens: 150_000, source: `settings:${join(sub, '.claude', 'settings.local.json')}` });
    writeSettings(root, '.claude/settings.local.json', { autoCompactWindow: 400_000 });
    expect(readHostCompactWindow({ HOME: dir() }, sub, { managedDirs: [], model: 'claude-opus-5-5' }).tokens).toBe(400_000);
    // Below both local files: the shared project file only applies when neither local file sets the key.
    writeSettings(sub, '.claude/settings.json', { autoCompactWindow: 700_000 });
    expect(readHostCompactWindow({ HOME: dir() }, sub, { managedDirs: [], model: 'claude-opus-5-5' }).tokens).toBe(400_000);
  });
});
