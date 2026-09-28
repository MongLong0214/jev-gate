import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

type Entry = { name: string; source: string | { source: string; url?: string; sha256?: string }; version?: string };
const marketplace = readJson(join(root, '.claude-plugin', 'marketplace.json')) as { name: string; owner: { name: string }; plugins: Entry[] };
const version = (readJson(join(root, 'package.json')) as { version: string }).version;
const relativeEntries = marketplace.plugins.filter((p): p is Entry & { source: string } => typeof p.source === 'string');

// What a user installs is what this file says: a relative source is copied from the marketplace checkout on its own,
// and the archive is the release asset the pin names.
describe('the marketplace', () => {
  it('is named jev-gate, so a plugin installs as <plugin>@jev-gate', () => {
    expect(marketplace.name).toBe('jev-gate');
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins.map((p) => p.name).sort()).toEqual(['jev-gate', 'jev-gate-compact', 'jev-gate-evidence', 'jev-gate-output', 'jev-gate-router']);
  });

  it('leaves every version to plugin.json, and every plugin.json is at the package version', () => {
    // A version in both places is taken from plugin.json without warning; one place keeps the update signal honest.
    for (const p of marketplace.plugins) expect(p.version, p.name).toBeUndefined();
    for (const rel of ['.claude-plugin/plugin.json', ...['mods/compact', 'mods/router', 'mods/output', 'plugins/evidence'].map((d) => `${d}/.claude-plugin/plugin.json`)]) {
      expect((readJson(join(root, rel)) as { version: string }).version, rel).toBe(version);
    }
  });

  it('points each relative source at a plugin of the same name', () => {
    expect(relativeEntries.map((p) => p.source).sort()).toEqual(['./mods/compact', './mods/output', './mods/router']);
    for (const p of relativeEntries) {
      expect((readJson(join(root, p.source, '.claude-plugin', 'plugin.json')) as { name: string }).name).toBe(p.name);
    }
  });

  it('pins jev-gate and jev-gate-evidence to this version’s release archives by SHA-256', () => {
    const archives = marketplace.plugins.filter((p) => typeof p.source !== 'string');
    expect(archives.map((p) => p.name).sort()).toEqual(['jev-gate', 'jev-gate-evidence']);
    for (const entry of archives) {
      expect(entry.source, entry.name).toEqual({
        source: 'archive',
        url: `https://github.com/MongLong0214/jev-gate/releases/download/v${version}/${entry.name}-${version}.zip`,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
    // The evidence archive is built from plugins/evidence, whose manifest names it (#77).
    expect((readJson(join(root, 'plugins', 'evidence', '.claude-plugin', 'plugin.json')) as { name: string }).name).toBe('jev-gate-evidence');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toMatch(new RegExp(`^## v${version.replace(/\./g, '\\.')} `, 'm'));
  });

  it('ships Function Hooks plugins whose modules import nothing outside their own directory', () => {
    // Only the plugin's directory reaches the cache, so an import that climbs out of it breaks the installed copy.
    const specifier = /(?:^|\n)\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const p of relativeEntries) {
      const dir = resolve(root, p.source);
      const hooks = readJson(join(dir, 'hooks', 'hooks.json')) as { modules: string[] };
      for (const m of hooks.modules) expect(existsSync(resolve(dir, 'hooks', m)), `${p.name} ${m}`).toBe(true);
      for (const file of readdirSync(join(dir, 'hooks')).filter((n) => n.endsWith('.ts'))) {
        const text = readFileSync(join(dir, 'hooks', file), 'utf8');
        for (const [, a, b] of text.matchAll(specifier)) {
          const spec = (a ?? b)!;
          if (spec === 'claude-code' || spec.startsWith('node:')) continue;
          expect(spec.startsWith('.'), `${p.name}/hooks/${file} imports ${spec}`).toBe(true);
          const target = resolve(dirname(join(dir, 'hooks', file)), spec);
          expect(relative(dir, target).startsWith('..'), `${p.name}/hooks/${file} imports ${spec}`).toBe(false);
          expect(existsSync(target), `${p.name}/hooks/${file} imports ${spec}`).toBe(true);
        }
      }
    }
  });
});
