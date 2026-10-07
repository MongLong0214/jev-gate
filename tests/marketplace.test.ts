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
    // v0.6.0: one plugin, so one install and one update; the Mods and the evidence server ship inside it.
    expect(marketplace.plugins.map((p) => p.name)).toEqual(['jev-gate']);
  });

  it('leaves every version to plugin.json, and every plugin.json is at the package version', () => {
    // A version in both places is taken from plugin.json without warning; one place keeps the update signal honest.
    for (const p of marketplace.plugins) expect(p.version, p.name).toBeUndefined();
    for (const rel of ['.claude-plugin/plugin.json', ...['mods/compact', 'mods/router', 'mods/output', 'plugins/evidence'].map((d) => `${d}/.claude-plugin/plugin.json`)]) {
      expect((readJson(join(root, rel)) as { version: string }).version, rel).toBe(version);
    }
  });

  it('pins jev-gate to this version’s release archive by SHA-256', () => {
    const archives = marketplace.plugins.filter((p) => typeof p.source !== 'string');
    expect(archives.map((p) => p.name)).toEqual(['jev-gate']);
    expect(relativeEntries).toEqual([]);
    for (const entry of archives) {
      expect(entry.source, entry.name).toEqual({
        source: 'archive',
        url: `https://github.com/MongLong0214/jev-gate/releases/download/v${version}/${entry.name}-${version}.zip`,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toMatch(new RegExp(`^## v${version.replace(/\./g, '\\.')} `, 'm'));
  });

  it('loads a hooks module whose imports all resolve inside the files the archive carries', () => {
    // The archive holds hooks/ and mods/<mod>/hooks/*.ts (scripts/pack.mjs), so an import outside them breaks the installed copy.
    const specifier = /(?:^|\n)\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
    const shipped = (rel: string) => /^src\/(?:frontier-routing|router-(?:answers|selection|context|secret)|claude-(?:models|candidates))\.ts$/.test(rel) || /^(hooks|mods\/(compact|output|router)\/hooks)\/[a-z-]+\.ts$/.test(rel);
    const hooks = readJson(join(root, 'hooks', 'hooks.json')) as { modules: string[] };
    expect(hooks.modules).toEqual(['./register.ts']);
    const seen = new Set<string>();
    const visit = (rel: string): void => {
      if (seen.has(rel)) return;
      seen.add(rel);
      expect(shipped(rel), rel).toBe(true);
      expect(existsSync(join(root, rel)), rel).toBe(true);
      for (const [, a, b] of readFileSync(join(root, rel), 'utf8').matchAll(specifier)) {
        const spec = (a ?? b)!;
        if (spec === 'claude-code' || spec.startsWith('node:')) continue;
        expect(spec.startsWith('.'), `${rel} imports ${spec}`).toBe(true);
        visit(relative(root, resolve(dirname(join(root, rel)), spec)));
      }
    };
    visit('hooks/register.ts');
    expect([...seen].filter((f) => f.startsWith('mods/')).length).toBeGreaterThan(10);
  });
});
