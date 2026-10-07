import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
let tmp: string;
let pluginRoot: string;

// pack.mjs writes the archive itself; unzip only reads it back here.
const hasZip = spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0;

// The root README's install targets (#95, #98).
const INSTALL_DOCS = [
  'README.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'docs/advanced-usage.md',
  'docs/bench-ab.md',
  'bench/ab/tasks.example.json',
  'plugins/evidence/README.md',
  'plugins/codex/README.md',
  'mods/compact/README.md',
  'mods/output/README.md',
  'mods/router/README.md',
  'assets/readme/jev-gate-logo.svg',
];

const relativeReadmeLinks = (markdown: string): string[] => {
  const found: string[] = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s[^)]*)?\)|<img\b[^>]*?\bsrc="([^"]+)"/g)) {
    const raw = (match[1] ?? match[2] ?? '').trim();
    if (raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const path = raw.split('#')[0] ?? '';
    if (path) found.push(path);
  }
  return found;
};

const expectReadmeLinksInside = (dir: string, rel = 'README.md') => {
  const markdown = readFileSync(join(dir, rel), 'utf8');
  expect(markdown.length, rel).toBeGreaterThan(40);
  const base = dirname(join(dir, rel));
  for (const target of relativeReadmeLinks(markdown)) {
    const resolved = join(base, target);
    const fromRoot = relative(dir, resolved);
    expect(fromRoot.startsWith('..'), `${rel} -> ${target}`).toBe(false);
    expect(existsSync(resolved), `${rel} -> ${target}`).toBe(true);
  }
};

const expectInstallDocs = (dest: string) => {
  for (const rel of INSTALL_DOCS) expect(readFileSync(join(dest, rel), 'utf8').length, rel).toBeGreaterThan(20);
  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toContain('plugins/evidence/README.md#configure');
  expect(readFileSync(join(dest, 'plugins/evidence/README.md'), 'utf8')).toMatch(/^## Configure$/m);
  for (const rel of INSTALL_DOCS.filter((f) => f.endsWith('.svg'))) expect(readFileSync(join(dest, rel), 'utf8'), rel).toMatch(/^<svg\b/);
  expectReadmeLinksInside(dest);
  expectReadmeLinksInside(dest, 'docs/advanced-usage.md');
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jev-pack-'));
  pluginRoot = join(tmp, 'root');
  mkdirSync(pluginRoot, { recursive: true });
  const r = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json'), '--outDir', join(pluginRoot, 'dist')], { encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  mkdirSync(join(pluginRoot, 'docs'), { recursive: true });
  for (const rel of ['.claude-plugin', 'hooks', 'agents', 'mods', 'src', 'plugins/evidence/skills', 'plugins/evidence/.claude-plugin', 'plugins/evidence/README.md', 'plugins/codex/README.md', 'assets/readme', 'README.md', 'AGENTS.md', 'CHANGELOG.md', 'docs/advanced-usage.md', 'docs/bench-ab.md', 'bench/ab/tasks.example.json', '.env.example', 'package.json']) cpSync(join(root, rel), join(pluginRoot, rel), { recursive: true });
  // The evidence bundle is build output, and the tests run before the build.
  const evidence = spawnSync(process.execPath, [join(root, 'scripts', 'build-evidence.mjs'), join(pluginRoot, 'plugins', 'evidence', 'dist', 'server.mjs')], { encoding: 'utf8' });
  expect(evidence.status, evidence.stderr).toBe(0);
}, 60_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!hasZip)('npm run pack (#18)', () => {
  it('produces an archive that loads from a path with spaces and answers a hook event with no network and no key', () => {
    const outDir = join(tmp, 'pack out');
    const otherCwd = join(tmp, 'other cwd');
    mkdirSync(otherCwd, { recursive: true });
    const pack = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), outDir, '--root', pluginRoot], { cwd: otherCwd, encoding: 'utf8' });
    expect(pack.status, pack.stderr).toBe(0);
    const archive = readdirSync(outDir).find((f) => /^jev-gate-.*\.zip$/.test(f));
    expect(archive).toBeDefined();
    const list = spawnSync('unzip', ['-Z1', join(outDir, archive!)], { encoding: 'utf8' }).stdout.trim().split('\n');
    const agents = ['worker-fast', 'worker', 'worker-deep', 'worker-frontier', 'planner', 'planner-frontier', 'executor'].map((a) => `agents/${a}.md`);
    for (const must of ['dist/entry.js', 'dist/hook.js', 'dist/jev.js', 'dist/brief.js', 'dist/cli.js', 'dist/job.js', 'dist/plan.js', 'hooks/hooks.json', ...agents, '.claude-plugin/plugin.json', ...INSTALL_DOCS]) expect(list, must).toContain(must);
    expect(list.some((f) => f.startsWith('src/') && !/^src\/(?:frontier-routing|router-(?:answers|selection|context|child-context|secret)|claude-(?:models|candidates))\.ts$/.test(f) || f.includes('/tests/') || f.startsWith('tests/') || f.startsWith('node_modules/') || f.startsWith('bench/') && f !== 'bench/ab/tasks.example.json' || f === 'HANDOFF.md' || f.includes('.env') && !f.endsWith('.env.example'))).toBe(false);
    // v0.6.0: the one plugin carries the three Mods from their source, the module that loads them, and the evidence
    // server with its skill, at the paths plugin.json and hooks/register.ts name; no Mod manifest, test or declaration.
    // #95 adds the feature READMEs beside that source, not the Mod tests.
    for (const must of ['hooks/register.ts', 'mods/compact/hooks/register.ts', 'mods/output/hooks/filter.ts', 'mods/router/hooks/router.ts', 'plugins/evidence/dist/server.mjs', 'plugins/evidence/skills/evidence/SKILL.md']) expect(list, must).toContain(must);
    expect(list.filter((f) => f.startsWith('mods/') && !/^mods\/(compact|output|router)\/(?:hooks\/[a-z-]+\.ts|README\.md)$/.test(f))).toEqual([]);
    expect(list.filter((f) => f.startsWith('plugins/'))).toEqual(['plugins/codex/README.md', 'plugins/evidence/README.md', 'plugins/evidence/dist/server.mjs', 'plugins/evidence/skills/evidence/SKILL.md']);

    const dest = join(tmp, 'installed here', 'jev gate');
    mkdirSync(dest, { recursive: true });
    expect(dest.includes(' '), dest).toBe(true);
    expect(dest.startsWith(root), dest).toBe(false);
    expect(spawnSync('unzip', ['-q', join(outDir, archive!), '-d', dest], { encoding: 'utf8' }).status).toBe(0);
    for (const agent of agents) {
      const definition = readFileSync(join(dest, agent), 'utf8');
      expect(definition, agent).not.toMatch(/^tools:|^disallowedTools:/m);
    }
    expectInstallDocs(dest);
    const env = { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home'), JEV_GATE_MODE: 'auto' };
    const guidance = spawnSync('node "' + join(dest, 'dist', 'hook.js') + '"', { shell: true, cwd: otherCwd, encoding: 'utf8', env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'add a test' }) });
    expect(guidance.status).toBe(0);
    expect(JSON.parse(guidance.stdout).hookSpecificOutput.additionalContext).toContain('coordinator guidance');
    const pre = spawnSync(process.execPath, [join(dest, 'dist', 'hook.js')], { cwd: otherCwd, encoding: 'utf8', env, input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_use_id: 't', tool_name: 'Agent', tool_input: { subagent_type: 'jev-gate:worker', description: 'd', prompt: 'p', run_in_background: false } }) });
    expect(pre).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: key_missing\n' });
    // #48 P2: hooks.json actually commands dist/entry.js, not dist/hook.js directly -- this is the one check in this
    // file that goes through that real indirection (src/entry.ts dynamically importing dist/hook.js) rather than
    // invoking dist/hook.js as if it were still the installed command.
    const viaEntry = spawnSync('node "' + join(dest, 'dist', 'entry.js') + '"', { shell: true, cwd: otherCwd, encoding: 'utf8', env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'add a test' }) });
    expect(viaEntry.status).toBe(0);
    expect(JSON.parse(viaEntry.stdout).hookSpecificOutput.additionalContext).toContain('coordinator guidance');
    const offViaEntry = spawnSync('node "' + join(dest, 'dist', 'entry.js') + '"', { shell: true, cwd: otherCwd, encoding: 'utf8', env: { ...env, JEV_GATE_MODE: 'off' }, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'add a test' }) });
    expect(offViaEntry).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: mode_off\n' });
    // The config-file-off variant (#48 P2): no JEV_GATE_MODE at all, only a config file saying mode:"off" under this
    // run's own $HOME -- entry.js has to read that file itself to take the fast path, not just check the env var.
    const offHome = join(tmp, 'off-config-home');
    mkdirSync(join(offHome, '.config', 'jev-gate'), { recursive: true });
    writeFileSync(join(offHome, '.config', 'jev-gate', 'config.json'), JSON.stringify({ version: 5, mode: 'off' }));
    const offViaConfig = spawnSync('node "' + join(dest, 'dist', 'entry.js') + '"', {
      shell: true,
      cwd: otherCwd,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: offHome },
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'add a test' }),
    });
    expect(offViaConfig).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: mode_off\n' });
    const doctor = spawnSync(process.execPath, [join(dest, 'dist', 'cli.js'), 'doctor'], { cwd: otherCwd, encoding: 'utf8', env: { ...env, PATH: '/nonexistent' } });
    expect(doctor.stdout).toMatch(/\[ok\] dist\/entry\.js present/);
    expect(doctor.stdout).toMatch(/\[ok\] dist\/hook\.js present/);
    expect(doctor.stdout).toMatch(/hooks\.json PreToolUse \(no matcher\): 1 command hook/);
    expect(doctor.stdout).toMatch(/hooks\.json Stop \(no matcher\): 1 command hook/);
    // #48 P2: SessionStart is the sixth registered event, wired to the same dist/entry.js command.
    expect(doctor.stdout).toMatch(/hooks\.json SessionStart \(no matcher\): 1 command hook/);
    for (const agent of agents) expect(existsSync(join(dest, agent)), agent).toBe(true);
    // v0.3.0 shipped without agents/executor.md and doctor failed on the installed archive; the lines above only
    // sampled its output. With the host able to run Agent calls in the foreground, doctor on the archive fails nothing.
    const whole = spawnSync(process.execPath, [join(dest, 'dist', 'cli.js'), 'doctor'], {
      cwd: otherCwd,
      encoding: 'utf8',
      env: { ...env, PATH: '/nonexistent', CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
    });
    expect(whole.stdout.split('\n').filter((l) => l.startsWith('[fail]'))).toEqual([]);
    expect(whole.status).toBe(0);
  }, 60_000);

  it('packs a lean profile with one executor, the lean hook set and no stale compiled modules', () => {
    const outDir = join(tmp, 'pack lean out');
    const otherCwd = join(tmp, 'other lean cwd');
    mkdirSync(otherCwd, { recursive: true });
    const pack = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), outDir, '--root', pluginRoot, '--profile', 'lean'], { cwd: otherCwd, encoding: 'utf8' });
    expect(pack.status, pack.stderr).toBe(0);
    const archive = readdirSync(outDir).find((f) => /^jev-gate-lean-.*\.zip$/.test(f));
    expect(archive).toBeDefined();
    const list = spawnSync('unzip', ['-Z1', join(outDir, archive!)], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(list.filter((f) => f.startsWith('agents/') && f.endsWith('.md'))).toEqual(['agents/executor.md']);
    for (const must of ['dist/entry.js', 'dist/hook.js', 'dist/lean.js', 'dist/lean-source.js', 'hooks/hooks.json', '.claude-plugin/plugin.json', ...INSTALL_DOCS]) expect(list, must).toContain(must);
    // The build clears dist, so a module deleted from src cannot reappear in an archive.
    expect(list).not.toContain('dist/context.js');
    expect(list.some((f) => f.startsWith('src/') || f.startsWith('tests/') || f.startsWith('bench/') && f !== 'bench/ab/tasks.example.json')).toBe(false);
    // No Mod is loaded: register.ts and hook sources stay out. The shared README's feature docs are files only (#95).
    expect(list.filter((f) => f.startsWith('mods/') || f === 'hooks/register.ts')).toEqual(['mods/compact/README.md', 'mods/output/README.md', 'mods/router/README.md']);
    expect(list.filter((f) => f.startsWith('plugins/'))).toEqual(['plugins/codex/README.md', 'plugins/evidence/README.md', 'plugins/evidence/dist/server.mjs', 'plugins/evidence/skills/evidence/SKILL.md']);

    const dest = join(tmp, 'lean installed', 'jev gate');
    mkdirSync(dest, { recursive: true });
    expect(spawnSync('unzip', ['-q', join(outDir, archive!), '-d', dest], { encoding: 'utf8' }).status).toBe(0);
    expectInstallDocs(dest);
    const env = { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'lean home'), JEV_GATE_MODE: 'lean' };
    // No key: the installed lean entrypoint reads no source, sends nothing and prints nothing.
    const quiet = spawnSync(process.execPath, [join(dest, 'dist', 'hook.js'), '--lean'], { cwd: otherCwd, encoding: 'utf8', env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt_id: 'p', prompt: 'add a test' }) });
    expect(quiet).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: key_missing\n' });
    // A legacy mode under the lean artifact is diagnosed, not turned into a guard for roles it does not ship.
    const mismatch = spawnSync(process.execPath, [join(dest, 'dist', 'hook.js'), '--lean'], { cwd: otherCwd, encoding: 'utf8', env: { ...env, JEV_GATE_MODE: 'auto' }, input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_use_id: 't', tool_name: 'Bash', tool_input: { command: 'ls' } }) });
    expect(mismatch).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: profile_mode_mismatch\n' });
    // #48 P2: lean.json's real command is dist/entry.js --lean; this is the one lean check that goes through it.
    const quietViaEntry = spawnSync(process.execPath, [join(dest, 'dist', 'entry.js'), '--lean'], { cwd: otherCwd, encoding: 'utf8', env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt_id: 'p', prompt: 'add a test' }) });
    expect(quietViaEntry).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: key_missing\n' });
  }, 60_000);

  it('packs the same bytes every time, whatever the timestamps of its files', () => {
    const sha = (dir: string) => {
      const pack = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), dir, '--root', pluginRoot], { encoding: 'utf8' });
      expect(pack.status, pack.stderr).toBe(0);
      const archive = readdirSync(dir).find((f) => /^jev-gate-[0-9].*\.zip$/.test(f))!;
      return createHash('sha256').update(readFileSync(join(dir, archive))).digest('hex');
    };
    const first = sha(join(tmp, 'repro a'));
    const later = new Date('2031-05-06T07:08:09Z');
    for (const rel of ['README.md', 'package.json', join('dist', 'entry.js')]) utimesSync(join(pluginRoot, rel), later, later);
    expect(sha(join(tmp, 'repro b'))).toBe(first);
    const archive = join(tmp, 'repro b', readdirSync(join(tmp, 'repro b'))[0]!);
    expect(spawnSync('unzip', ['-tq', archive], { encoding: 'utf8' }).status).toBe(0);
    // No entry carries the clock: a release rebuilt on another machine, on another day, gives the pinned bytes.
    const rows = spawnSync('unzip', ['-Z', archive], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /^-/.test(l));
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) expect(row).toMatch(/ stor 80-Jan-01 00:00 /);
  });

  it('packs the router Mod from its source, at its own version, with nothing of Lean or legacy', () => {
    const outDir = join(tmp, 'pack router out');
    const otherCwd = join(tmp, 'other router cwd');
    mkdirSync(otherCwd, { recursive: true });
    const pack = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), outDir, '--profile', 'router'], { cwd: otherCwd, encoding: 'utf8' });
    expect(pack.status, pack.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, 'mods', 'router', '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; version: string };
    expect(manifest.name).toBe('jev-gate-router');
    expect(readdirSync(outDir)).toContain(`jev-gate-router-${manifest.version}.zip`);
    const list = spawnSync('unzip', ['-Z1', join(outDir, `jev-gate-router-${manifest.version}.zip`)], { encoding: 'utf8' }).stdout.trim().split('\n');
    const modules = readdirSync(join(root, 'mods', 'router', 'hooks')).filter((n) => n.endsWith('.ts'));
    const files = list.filter((f) => !f.endsWith('/')).sort();
    expect(files).toEqual(['.claude-plugin/plugin.json', 'README.md', 'hooks/hooks.json', ...modules.map((n) => `hooks/${n}`), ...['router-answers','router-selection','router-context','router-child-context','router-secret','claude-models','claude-candidates','frontier-routing'].map(n => `src/${n}.ts`)].sort());
    // Declarations, host tests, compiled Lean and the executor stay out: Router-only exposes no Lean executor or history reader.
    expect(list.some((f) => /^(types|tests|dist|agents)\//.test(f))).toBe(false);
    const dest = join(tmp, 'router installed', 'jev router');
    mkdirSync(dest, { recursive: true });
    expect(dest.includes(' ')).toBe(true);
    expect(dest.startsWith(root)).toBe(false);
    expect(spawnSync('unzip', ['-q', join(outDir, `jev-gate-router-${manifest.version}.zip`), '-d', dest], { encoding: 'utf8' }).status).toBe(0);
    expectReadmeLinksInside(dest);
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toMatch(/^## Enable$/m);
  });

  it('packs evidence with a root readme whose relative links stay inside that archive', () => {
    const outDir = join(tmp, 'pack evidence out');
    const otherCwd = join(tmp, 'other evidence cwd');
    mkdirSync(otherCwd, { recursive: true });
    const pack = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), outDir, '--root', pluginRoot, '--profile', 'evidence'], { cwd: otherCwd, encoding: 'utf8' });
    expect(pack.status, pack.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugins', 'evidence', '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string };
    const archive = join(outDir, `jev-gate-evidence-${manifest.version}.zip`);
    const list = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).stdout.trim().split('\n').sort();
    expect(list).toEqual(['.claude-plugin/plugin.json', 'README.md', 'dist/server.mjs', 'skills/evidence/SKILL.md']);
    const dest = join(tmp, 'evidence installed', 'jev evidence');
    mkdirSync(dest, { recursive: true });
    expect(dest.includes(' ')).toBe(true);
    expect(dest.startsWith(root)).toBe(false);
    expect(spawnSync('unzip', ['-q', archive, '-d', dest], { encoding: 'utf8' }).status).toBe(0);
    expectReadmeLinksInside(dest);
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toMatch(/^## Configure$/m);
    expect(existsSync(join(dest, 'dist', 'server.mjs'))).toBe(true);
  });
});
