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
    ['plugins/codex/.codex-plugin/plugin.json', 'jev-gate'],
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
    // The jev-gate archive carries all three Mods' hook sources and the module that loads them (v0.6.0), plus the
    // install docs pack.mjs lists (#95). Stubs are enough: the archive only requires the paths to exist.
    for (const m of ['compact', 'router', 'output']) {
      write(`mods/${m}/hooks/register.ts`, 'export default () => {};\n');
      write(`mods/${m}/README.md`, `# ${m}\n`);
    }
    for (const name of ['jev-gate-logo.svg']) write(`assets/readme/${name}`, '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
    write('plugins/codex/README.md', '# Native Codex usage\n');
    write('docs/bench-ab.md', '# Paired benchmark usage\n');
    write('bench/ab/tasks.example.json', '{}\n');
    write('docs/advanced-usage.md', '# Advanced usage\n\nGate and lean settings for a checkout.\n');
    write('hooks/hooks.json', '{}\n');
    write('hooks/register.ts', 'export {};\n');
    for (const name of ['cost','provider-prices','provider-prices-data','route-cost','claude-cache','router-answers','router-selection','router-context','router-child-context','router-secret','claude-models','claude-candidates','frontier-routing']) write(`src/${name}.ts`, 'export {};\n');
    for (const a of AGENTS) write(`agents/${a}.md`, `# ${a}\n`);
    for (const f of ['README.md', 'AGENTS.md', '.env.example']) write(f, `${f}\n`);
    write('dist/hook.js', 'export {};\n');
    write('dist/entry.js', 'export {};\n');
    for (const f of ['dist/server.mjs', 'skills/evidence/SKILL.md', 'README.md']) write(`plugins/evidence/${f}`, `${f}\n`);
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
    expect(refused.stderr).toContain(`v0.3.0 is released with jev-gate-0.3.0.zip ${released}`);
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
    expect(check.stderr).toContain(`v0.3.0 is released with jev-gate-0.3.0.zip ${released}, this tree packs ${sha}`);
    expect(check.stderr).toContain('raise the version');
  });

  it('with only the archive entry, lets a file the archive does not carry change at a released version', () => {
    // v0.6.0 lists no source entry; an empty path list must not turn into a diff of every file in the repository.
    const m = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8'));
    m.plugins = m.plugins.filter((p: { name: string }) => p.name === 'jev-gate');
    json('.claude-plugin/marketplace.json', m);
    commit('one entry');
    git('tag', '-f', 'v0.3.0');
    write('docs/notes.md', 'not in the archive\n');
    commit('docs');
    const r = release('check', '--tag', 'v0.3.0', '--against', 'HEAD');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    write('README.md', 'README.md, edited after the release\n');
    expect(release('check').stderr).toMatch(/is released with jev-gate-0\.3\.0\.zip/);
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

  it('refuses a served marketplace that lists another entry at this version, source directory or archive', () => {
    const m = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8'));
    git('switch', '-q', '-c', 'served');
    json('.claude-plugin/marketplace.json', { ...m, plugins: [...m.plugins, { name: 'jev-gate-output', source: './mods/output' }] });
    commit('served lists one more');
    git('switch', '-q', '-');
    expect(release('check', '--against', 'served').stderr).toMatch(/served serves entries jev-gate, jev-gate-compact, jev-gate-output, jev-gate-router, this tree lists jev-gate, jev-gate-compact, jev-gate-router/);
    git('switch', '-q', 'served');
    json('.claude-plugin/marketplace.json', { ...m, plugins: m.plugins.map((p: { name: string }) => (p.name === 'jev-gate-compact' ? { ...p, source: './mods/output' } : p)) });
    commit('served moves a source directory');
    git('switch', '-q', '-');
    expect(release('check', '--against', 'served').stderr).toMatch(/served serves "\.\/mods\/output", not this entry "\.\/mods\/compact"/);
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
    mkdirSync(join(out, 'bad'));
    writeFileSync(join(out, 'bad', 'jev-gate-0.3.0.zip'), 'not the archive');
    const bad = release('check', '--tag', 'v0.3.0', '--asset', join(out, 'bad', 'jev-gate-0.3.0.zip'));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('jev-gate-0.3.0.zip is ');
    writeFileSync(join(out, 'other.zip'), 'not the archive');
    const unnamed = release('check', '--tag', 'v0.3.0', '--asset', join(out, 'other.zip'));
    expect(unnamed.status).toBe(1);
    expect(unnamed.stderr).toContain('other.zip is not a release archive name (jev-gate-0.3.0.zip)');
  });

  // #77: the evidence server's archive is a second pinned entry, packed with its own profile and frozen the same way.
  it('pins, freezes and checks the evidence archive beside the gate archive', () => {
    const m = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8'));
    m.plugins.push({ name: 'jev-gate-evidence', source: { source: 'archive', url: 'https://example.invalid/e.zip', sha256: '0'.repeat(64) } });
    json('.claude-plugin/marketplace.json', m);
    // Added after v0.3.0 was released, the entry has no pin there: the version must move.
    const refused = release('pin');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('v0.3.0 is released with jev-gate-evidence-0.3.0.zip (none)');
    setVersion('0.3.1');
    expect(release('pin').status).toBe(0);
    commit('B');
    const evidence = () => JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins[3].source;
    const packed = spawnSync(process.execPath, [join(repo, 'scripts', 'pack.mjs'), join(repo, 'ev'), '--profile', 'evidence'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    expect(evidence()).toEqual({
      source: 'archive',
      url: 'https://github.com/MongLong0214/jev-gate/releases/download/v0.3.1/jev-gate-evidence-0.3.1.zip',
      sha256: createHash('sha256').update(readFileSync(join(repo, 'ev', 'jev-gate-evidence-0.3.1.zip'))).digest('hex'),
    });
    rmSync(join(repo, 'ev'), { recursive: true, force: true });
    const out = join(repo, 'out');
    const check = release('check', '--tag', 'v0.3.1', '--out', out);
    expect(check.stderr).toBe('');
    expect(check.stdout).toContain('ok jev-gate-evidence-0.3.1.zip');
    expect(readFileSync(join(out, 'NOTES.md'), 'utf8')).toContain(`- \`jev-gate-evidence-0.3.1.zip\`: \`${evidence().sha256}\``);
    const both = ['jev-gate-0.3.1.zip', 'jev-gate-evidence-0.3.1.zip'].flatMap((n) => ['--asset', join(out, n)]);
    expect(release('check', '--tag', 'v0.3.1', ...both).status).toBe(0);
    // The second asset is checked too, not only the first.
    mkdirSync(join(out, 'bad'));
    writeFileSync(join(out, 'bad', 'jev-gate-evidence-0.3.1.zip'), 'not the archive');
    const second = release('check', '--tag', 'v0.3.1', '--asset', join(out, 'jev-gate-0.3.1.zip'), '--asset', join(out, 'bad', 'jev-gate-evidence-0.3.1.zip'));
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('jev-gate-evidence-0.3.1.zip is ');
    // A served marketplace that pins another evidence archive at this version is refused.
    git('switch', '-q', '-c', 'served');
    const served = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8'));
    served.plugins[3].source.sha256 = 'f'.repeat(64);
    json('.claude-plugin/marketplace.json', served);
    commit('served evidence moved');
    git('switch', '-q', '-');
    const against = release('check', '--tag', 'v0.3.1', '--against', 'served');
    expect(against.status).toBe(1);
    expect(against.stderr).toContain(`served serves {"source":"archive","url":"https://github.com/MongLong0214/jev-gate/releases/download/v0.3.1/jev-gate-evidence-0.3.1.zip","sha256":"${'f'.repeat(64)}"}`);
    git('tag', 'v0.3.1');
    // Released, a change to the evidence plugin's files repacks its archive and is refused at the same version.
    write('plugins/evidence/README.md', 'README.md, edited after the release\n');
    const frozen = release('check', '--tag', 'v0.3.1');
    expect(frozen.status).toBe(1);
    expect(frozen.stderr).toContain(`v0.3.1 is released with jev-gate-evidence-0.3.1.zip ${evidence().sha256}`);
    write('plugins/evidence/README.md', 'README.md\n');
    expect(release('check', '--tag', 'v0.3.1').status).toBe(0);
    // Dropping a released entry at the same version is refused as well.
    const m2 = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8'));
    m2.plugins.pop();
    json('.claude-plugin/marketplace.json', m2);
    const dropped = release('check', '--tag', 'v0.3.1');
    expect(dropped.status).toBe(1);
    expect(dropped.stderr).toContain('v0.3.1 is released with entries jev-gate, jev-gate-compact, jev-gate-evidence, jev-gate-router, this tree lists jev-gate, jev-gate-compact, jev-gate-router');
  });

  it('refuses a flag that is given no value', () => {
    for (const f of ['--against', '--asset', '--tag', '--out']) {
      const r = release('check', f);
      expect(r.status, f).toBe(1);
      expect(r.stderr).toContain(`${f} needs a value`);
    }
    expect(release('check', '--asset', '--tag', 'v0.3.0').stderr).toContain('--asset needs a value');
  });

  it('refuses an archive entry no pack profile builds', () => {
    const m = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8'));
    m.plugins.push({ name: 'jev-gate-other', source: { source: 'archive', url: 'https://example.invalid/o.zip', sha256: '0'.repeat(64) } });
    json('.claude-plugin/marketplace.json', m);
    const check = release('check');
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('archive entry jev-gate-other that no pack profile builds');
  });
});
