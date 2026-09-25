import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
let tmp: string;
let pluginRoot: string;

const hasZip = spawnSync('zip', ['-v'], { encoding: 'utf8' }).status === 0 && spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0;

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
    const agents = ['worker-fast', 'worker', 'worker-deep', 'worker-frontier', 'planner', 'planner-frontier'].map((a) => `agents/${a}.md`);
    for (const must of ['dist/hook.js', 'dist/jev.js', 'dist/brief.js', 'dist/cli.js', 'dist/job.js', 'dist/plan.js', 'hooks/hooks.json', ...agents, '.claude-plugin/plugin.json', 'README.md']) expect(list, must).toContain(must);
    expect(list.some((f) => f.startsWith('src/') || f.startsWith('tests/') || f.startsWith('node_modules/') || f.includes('.env') && !f.endsWith('.env.example'))).toBe(false);

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
    const doctor = spawnSync(process.execPath, [join(dest, 'dist', 'cli.js'), 'doctor'], { cwd: otherCwd, encoding: 'utf8', env: { ...env, PATH: '/nonexistent' } });
    expect(doctor.stdout).toMatch(/\[ok\] dist\/hook\.js present/);
    expect(doctor.stdout).toMatch(/hooks\.json PreToolUse \(no matcher\): 1 command hook/);
    expect(doctor.stdout).toMatch(/hooks\.json Stop \(no matcher\): 1 command hook/);
    for (const agent of agents) expect(existsSync(join(dest, agent)), agent).toBe(true);
  }, 60_000);

  it('packs a lean profile with one executor, the lean hook set and no stale compiled modules', () => {
    const outDir = join(tmp, 'pack lean out');
    const pack = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), outDir, '--root', pluginRoot, '--profile', 'lean'], { encoding: 'utf8' });
    expect(pack.status, pack.stderr).toBe(0);
    const archive = readdirSync(outDir).find((f) => /^jev-gate-lean-.*\.zip$/.test(f));
    expect(archive).toBeDefined();
    const list = spawnSync('unzip', ['-Z1', join(outDir, archive!)], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(list.filter((f) => f.startsWith('agents/') && f.endsWith('.md'))).toEqual(['agents/executor.md']);
    for (const must of ['dist/hook.js', 'dist/lean.js', 'dist/lean-source.js', 'hooks/hooks.json', '.claude-plugin/plugin.json']) expect(list, must).toContain(must);
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
  }, 60_000);

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
