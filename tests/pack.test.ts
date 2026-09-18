import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
    for (const must of ['dist/hook.js', 'dist/jev.js', 'dist/brief.js', 'dist/cli.js', 'hooks/hooks.json', 'agents/worker.md', 'agents/planner.md', '.claude-plugin/plugin.json', 'README.md']) expect(list, must).toContain(must);
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
    expect(doctor.stdout).toMatch(/hooks\.json PreToolUse \(\^Agent\$\): 1 command hook/);
    expect(existsSync(join(dest, 'agents', 'planner.md'))).toBe(true);
  }, 60_000);
});
