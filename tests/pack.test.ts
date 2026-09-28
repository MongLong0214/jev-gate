import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
let tmp: string;
let pluginRoot: string;

// pack.mjs writes the archive itself; unzip only reads it back here.
const hasZip = spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jev-pack-'));
  pluginRoot = join(tmp, 'root');
  mkdirSync(pluginRoot, { recursive: true });
  const r = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json'), '--outDir', join(pluginRoot, 'dist')], { encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  for (const rel of ['.claude-plugin', 'hooks', 'agents', 'README.md', 'AGENTS.md', '.env.example', 'package.json']) cpSync(join(root, rel), join(pluginRoot, rel), { recursive: true });
}, 60_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!hasZip)('npm run pack (#18)', () => {
  it('produces an archive that loads from a path with spaces and answers a hook event with no network and no key', () => {
    const outDir = join(tmp, 'pack out');
    const pack = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), outDir, '--root', pluginRoot], { encoding: 'utf8' });
    expect(pack.status, pack.stderr).toBe(0);
    const archive = readdirSync(outDir).find((f) => /^jev-gate-.*\.zip$/.test(f));
    expect(archive).toBeDefined();
    const list = spawnSync('unzip', ['-Z1', join(outDir, archive!)], { encoding: 'utf8' }).stdout.trim().split('\n');
    const agents = ['worker-fast', 'worker', 'worker-deep', 'worker-frontier', 'planner', 'planner-frontier', 'executor'].map((a) => `agents/${a}.md`);
    for (const must of ['dist/entry.js', 'dist/hook.js', 'dist/jev.js', 'dist/brief.js', 'dist/cli.js', 'dist/job.js', 'dist/plan.js', 'hooks/hooks.json', ...agents, '.claude-plugin/plugin.json', 'README.md']) expect(list, must).toContain(must);
    expect(list.some((f) => f.startsWith('src/') || f.startsWith('tests/') || f.startsWith('node_modules/') || f.includes('.env') && !f.endsWith('.env.example'))).toBe(false);
    // #77: the evidence server is bundled into plugins/evidence and ships only in its own archive.
    expect(list.filter((f) => f.includes('evidence'))).toEqual([]);

    const dest = join(tmp, 'installed here', 'jev gate');
    mkdirSync(dest, { recursive: true });
    expect(spawnSync('unzip', ['-q', join(outDir, archive!), '-d', dest], { encoding: 'utf8' }).status).toBe(0);
    const otherCwd = join(tmp, 'other cwd');
    mkdirSync(otherCwd);
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
    const pack = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), outDir, '--root', pluginRoot, '--profile', 'lean'], { encoding: 'utf8' });
    expect(pack.status, pack.stderr).toBe(0);
    const archive = readdirSync(outDir).find((f) => /^jev-gate-lean-.*\.zip$/.test(f));
    expect(archive).toBeDefined();
    const list = spawnSync('unzip', ['-Z1', join(outDir, archive!)], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(list.filter((f) => f.startsWith('agents/') && f.endsWith('.md'))).toEqual(['agents/executor.md']);
    for (const must of ['dist/entry.js', 'dist/hook.js', 'dist/lean.js', 'dist/lean-source.js', 'hooks/hooks.json', '.claude-plugin/plugin.json']) expect(list, must).toContain(must);
    // The build clears dist, so a module deleted from src cannot reappear in an archive.
    expect(list).not.toContain('dist/context.js');
    expect(list.some((f) => f.startsWith('src/') || f.startsWith('tests/'))).toBe(false);

    const dest = join(tmp, 'lean installed', 'jev gate');
    mkdirSync(dest, { recursive: true });
    expect(spawnSync('unzip', ['-q', join(outDir, archive!), '-d', dest], { encoding: 'utf8' }).status).toBe(0);
    const otherCwd = join(tmp, 'other lean cwd');
    mkdirSync(otherCwd);
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
    const pack = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), outDir, '--profile', 'router'], { encoding: 'utf8' });
    expect(pack.status, pack.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, 'mods', 'router', '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; version: string };
    expect(manifest.name).toBe('jev-gate-router');
    expect(readdirSync(outDir)).toContain(`jev-gate-router-${manifest.version}.zip`);
    const list = spawnSync('unzip', ['-Z1', join(outDir, `jev-gate-router-${manifest.version}.zip`)], { encoding: 'utf8' }).stdout.trim().split('\n');
    const modules = readdirSync(join(root, 'mods', 'router', 'hooks')).filter((n) => n.endsWith('.ts'));
    const files = list.filter((f) => !f.endsWith('/')).sort();
    expect(files).toEqual(['.claude-plugin/plugin.json', 'README.md', 'hooks/hooks.json', ...modules.map((n) => `hooks/${n}`)].sort());
    // Declarations, host tests, compiled Lean and the executor stay out: Router-only exposes no Lean executor or history reader.
    expect(list.some((f) => /^(types|tests|dist|agents|src)\//.test(f))).toBe(false);
  });
});
