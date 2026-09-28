import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const AGENTS = ['worker-fast', 'worker', 'worker-deep', 'worker-frontier', 'planner', 'planner-frontier', 'executor'];
let repo: string;

const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};
const json = (rel: string, value: unknown) => write(rel, `${JSON.stringify(value, null, 2)}\n`);
const run = (cmd: string, ...args: string[]) => spawnSync(cmd, args, { cwd: repo, encoding: 'utf8' });
const release = (...args: string[]) => run(process.execPath, join(repo, 'scripts', 'release.mjs'), ...args);
const git = (...args: string[]) => {
  const r = run('git', ...args);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};
const commit = (message: string) => {
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message);
};
const setVersion = (v: string) => {
  for (const [rel, name] of [
    ['package.json', 'jev-gate'],
    ['.claude-plugin/plugin.json', 'jev-gate'],
    ['mods/compact/.claude-plugin/plugin.json', 'jev-gate-compact'],
    ['mods/router/.claude-plugin/plugin.json', 'jev-gate-router'],
    ['mods/output/.claude-plugin/plugin.json', 'jev-gate-output'],
    ['plugins/evidence/.claude-plugin/plugin.json', 'jev-gate-evidence'],
  ] as const) json(rel, { name, version: v, type: 'module' });
  write('CHANGELOG.md', `# Changelog\n\n## v${v} — test\n\nNotes for ${v}.\n`);
};
const pin = () => JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins[2].source;

// A released version is what installed copies hold: the same version with other bytes leaves them stale and makes the
// published archive fail the pin (R64-01). These run the real release.mjs and pack.mjs against a small repository.
describe('scripts/release.mjs', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'jev-release-'));
    for (const f of ['pack.mjs', 'release.mjs']) {
      mkdirSync(join(repo, 'scripts'), { recursive: true });
      copyFileSync(join(root, 'scripts', f), join(repo, 'scripts', f));
    }
    setVersion('0.3.0');
    json('.claude-plugin/marketplace.json', {
      name: 'jev-gate',
      owner: { name: 't' },
      plugins: [
        { name: 'jev-gate-compact', source: './mods/compact' },
        { name: 'jev-gate-router', source: './mods/router' },
        { name: 'jev-gate', source: { source: 'archive', url: 'https://example.invalid/x.zip', sha256: '0'.repeat(64) } },
      ],
    });
    for (const m of ['compact', 'router']) write(`mods/${m}/hooks/register.ts`, 'export default () => {};\n');
    write('hooks/hooks.json', '{}\n');
    for (const a of AGENTS) write(`agents/${a}.md`, `# ${a}\n`);
    for (const f of ['README.md', 'AGENTS.md', '.env.example']) write(f, `${f}\n`);
    write('dist/hook.js', 'export {};\n');
    write('dist/entry.js', 'export {};\n');
    git('init', '-q');
    expect(release('pin').status).toBe(0);
    commit('A');
    git('tag', 'v0.3.0');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('passes at the released commit and names the release asset', () => {
    const r = release('check', '--tag', 'v0.3.0');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(pin()).toEqual({
      source: 'archive',
      url: 'https://github.com/MongLong0214/jev-gate/releases/download/v0.3.0/jev-gate-0.3.0.zip',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('refuses a second commit that repacks a released version', () => {
    const released = pin().sha256;
    write('README.md', 'README.md, edited after the release\n');
    const refused = release('pin');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`v0.3.0 is released with archive ${released}`);
    // Written by hand, the repin still fails the check that main's CI and the release job run.
    const packed = spawnSync(process.execPath, [join(repo, 'scripts', 'pack.mjs'), join(repo, 'out')], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    const sha = createHash('sha256').update(readFileSync(join(repo, 'out', 'jev-gate-0.3.0.zip'))).digest('hex');
    rmSync(join(repo, 'out'), { recursive: true, force: true });
    const m = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8'));
    m.plugins[2].source.sha256 = sha;
    json('.claude-plugin/marketplace.json', m);
    commit('B');
    const check = release('check');
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(`v0.3.0 is released with archive ${released}, this tree packs ${sha}`);
    expect(check.stderr).toContain('raise the version');
  });

  it('refuses a changed Function Hooks plugin at a released version', () => {
    write('mods/compact/hooks/register.ts', 'export default () => { /* changed */ };\n');
    commit('B');
    const check = release('check');
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('changed since v0.3.0 at the same version: mods/compact/hooks/register.ts');
  });

  it('accepts the same change once the version is raised', () => {
    write('mods/compact/hooks/register.ts', 'export default () => { /* changed */ };\n');
    write('README.md', 'README.md, edited after the release\n');
    setVersion('0.3.1');
    expect(release('pin').status).toBe(0);
    commit('B');
    const check = release('check', '--tag', 'v0.3.1');
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
    expect(pin().url).toContain('/v0.3.1/jev-gate-0.3.1.zip');
  });

  it('refuses to answer from a shallow clone, which has no tags', () => {
    const shallow = join(repo, 'shallow');
    const clone = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${repo}`, shallow], { encoding: 'utf8' });
    expect(clone.status, clone.stderr).toBe(0);
    for (const rel of ['dist/hook.js', 'dist/entry.js']) copyFileSync(join(repo, rel), join(shallow, rel));
    const check = spawnSync(process.execPath, [join(shallow, 'scripts', 'release.mjs'), 'check'], { cwd: shallow, encoding: 'utf8' });
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('a shallow checkout cannot tell whether v0.3.0 is released');
  });

  it('publishes only the entry the served marketplace pins', () => {
    git('switch', '-q', '-c', 'served');
    const m = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8'));
    m.plugins[2].source.sha256 = 'f'.repeat(64);
    json('.claude-plugin/marketplace.json', m);
    commit('served moved on');
    git('switch', '-q', '--detach', 'v0.3.0');
    const check = release('check', '--tag', 'v0.3.0', '--against', 'served');
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(`served serves {"source":"archive"`);
    expect(release('check', '--tag', 'v0.3.0', '--against', 'v0.3.0').status).toBe(0);
  });

  it('refuses a served marketplace that serves this version with other plugin files', () => {
    git('switch', '-q', '-c', 'served');
    write('mods/router/hooks/register.ts', 'export default () => { /* merged after the check */ };\n');
    commit('same-version change merged');
    git('switch', '-q', '--detach', 'v0.3.0');
    const check = release('check', '--tag', 'v0.3.0', '--against', 'served');
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('served serves v0.3.0 with other plugin files: mods/router/hooks/register.ts');
  });

  // R64-03: main moving on to a later version between publication and the read-back must not fail the earlier release.
  it('accepts a served marketplace that has moved on to a later version', () => {
    git('switch', '-q', '-c', 'served');
    write('mods/compact/hooks/register.ts', 'export default () => { /* 0.3.1 */ };\n');
    setVersion('0.3.1');
    expect(release('pin').status).toBe(0);
    commit('0.3.1');
    git('switch', '-q', '--detach', 'v0.3.0');
    const check = release('check', '--tag', 'v0.3.0', '--against', 'served');
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
  });

  it('refuses a served marketplace that does not serve this version yet', () => {
    git('switch', '-q', '-c', 'served');
    setVersion('0.2.9');
    expect(release('pin').status).toBe(0);
    commit('older');
    git('switch', '-q', '--detach', 'v0.3.0');
    const check = release('check', '--tag', 'v0.3.0', '--against', 'served');
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('served serves v0.2.9, not v0.3.0 yet');
  });

  it('accepts the published asset only when it is the pinned archive', () => {
    const out = join(repo, 'out');
    expect(release('check', '--tag', 'v0.3.0', '--out', out).status).toBe(0);
    const good = release('check', '--tag', 'v0.3.0', '--asset', join(out, 'jev-gate-0.3.0.zip'));
    expect(good.stderr).toBe('');
    expect(good.status).toBe(0);
    writeFileSync(join(out, 'other.zip'), 'not the archive');
    const bad = release('check', '--tag', 'v0.3.0', '--asset', join(out, 'other.zip'));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('other.zip is ');
  });
});
