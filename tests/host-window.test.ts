import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { readHostCompactWindow } from '../src/host-window.js';

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
