import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDashboard } from '../../src/dashboard.js';
import { liveFrames } from '../live-frames.js';
import { resolveApiKey } from '../../src/credentials.js';

const root = join(__dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'jev-codex-package-'));
const staged = join(tmp, 'source');
const installed = join(tmp, 'installed plugin');
const project = join(tmp, 'workspace');
const traces = join(tmp, 'records');
const shellEnv = { PATH: process.env['PATH'] ?? '', HOME: tmp, CODEX_HOME: join(tmp, 'codex-home'), XDG_CONFIG_HOME: join(tmp, 'config'), XDG_STATE_HOME: join(tmp, 'state'), JEV_GATE_TRACE_DIR: join(tmp, 'claude-records'), JEV_GATE_ONBOARDING: '0', JEV_DASHBOARD_NO_OPEN: '1', JEV_CODEX_TRACE_DIR: traces, JEV_CODEX_AUTO_CONNECT: '0' };
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeAll(() => {
  const bin = join(tmp, 'fake-bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.158.0'); process.exit(0); }
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line); if (row.id === undefined) return;
  const result = row.method === 'model/list' ? { data: [{ model: 'gpt-6.1-sol', description: 'Latest workhorse for coding and reasoning', isDefault: true, supportedReasoningEfforts: ['low','medium','high','xhigh','max'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) }], nextCursor: null } : {};
  console.log(JSON.stringify({ id: row.id, result }));
});
`, { mode: 0o700 });
  shellEnv.PATH = `${bin}:${shellEnv.PATH}`;
  cpSync(join(root, 'plugins/codex'), join(staged, 'plugins/codex'), { recursive: true, filter: p => !p.includes('/dist/') && !p.endsWith('/dist') });
  cpSync(join(root, 'package.json'), join(staged, 'package.json'));
  const built = spawnSync(process.execPath, [join(root, 'scripts/build-codex.mjs'), join(staged, 'plugins/codex/dist')], { encoding: 'utf8' });
  expect(built.status, built.stderr).toBe(0);
  const pack = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), join(tmp, 'archives'), '--profile', 'codex', '--root', staged], { encoding: 'utf8' });
  expect(pack.status, pack.stderr).toBe(0);
  const pkg = JSON.parse(readFileSync(join(root, 'plugins/codex/.codex-plugin/plugin.json'), 'utf8')) as { version: string };
  const zip = join(tmp, 'archives', `jev-gate-codex-${pkg.version}.zip`);
  mkdirSync(installed); mkdirSync(project);
  expect(spawnSync('unzip', ['-q', zip, '-d', installed]).status).toBe(0);
  expect(spawnSync('git', ['init', '-q'], { cwd: project }).status).toBe(0);
}, 60_000);

describe('installed Codex archive', () => {
  it('B1: ships and executes the isolated worker snapshot helper', () => {
    const cwd = join(tmp, 'snapshot project'); mkdirSync(cwd);
    for (const args of [['init', '-q'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']]) {
      const run = spawnSync('git', args, { cwd, env: shellEnv, encoding: 'utf8' }); expect(run.status, run.stderr).toBe(0);
    }
    writeFileSync(join(cwd, 'uncommitted.txt'), 'snapshot input');
    const run = spawnSync(process.execPath, [join(installed, 'dist/worktree.mjs'), '--codex', cwd, join(cwd, '.jev-gate-worktrees')], { cwd, env: shellEnv, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.path).not.toBe(cwd);
    expect(readFileSync(join(result.path, 'uncommitted.txt'), 'utf8')).toBe('snapshot input');
    expect(readFileSync(join(cwd, 'uncommitted.txt'), 'utf8')).toBe('snapshot input');
    expect(result.baseline).toMatch(/^[a-f0-9]{40}$/);
  });

  it('automatically offers key entry from the installed MCP with no environment key', async () => {
    const client = new Client({ name: 'codex-onboarding-test', version: '0' });
    const keyEnv = { ...shellEnv, XDG_CONFIG_HOME: join(tmp, 'onboarding config'), JEV_GATE_ONBOARDING: '1', JEV_GATE_NO_BROWSER: '1' };
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(installed, 'dist/server.mjs'), '--codex'], cwd: project, env: keyEnv, stderr: 'pipe' });
    let diagnostics = '';
    transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    try {
      await client.connect(transport);
      const url = diagnostics.match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}/)?.[0]; expect(url, diagnostics).toBeDefined();
      const response = await fetch(url!, { method: 'POST', headers: { origin: new URL(url!).origin, 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'fake-native-entry-key' }) });
      expect(response.status).toBe(204); expect(resolveApiKey(keyEnv)).toBe('fake-native-entry-key');
      expect(diagnostics).not.toContain('fake-native-entry-key');
      // Without the automatic connection the server offers no tool: jev_agent needs the connection.
      expect((await client.listTools()).tools).toEqual([]);
    } finally { await client.close(); }
  });
  it('runs doctor without starting an MCP transport or writing records', () => {
    const empty = join(tmp, 'doctor-only');
    const result = spawnSync(process.execPath, [join(installed, 'dist/cli.mjs'), 'doctor', '--json'], { cwd: project, env: { ...shellEnv, JEV_CODEX_TRACE_DIR: empty }, encoding: 'utf8', timeout: 5000 });
    expect(result.stderr).toBe('');
    expect(existsSync(empty)).toBe(false);
    const report = JSON.parse(result.stdout);
    expect(report.host).toBe('codex');
    expect(report.models.source).toContain('model/list');
    expect(report.checks.some((c: { message: string }) => c.message.includes('No source was scanned and no inference was performed'))).toBe(true);
    expect(report.models.accountAccess).toBe('unverified');
  });
  it('reports the running Codex archive version in its actual dashboard', async () => {
    const child = spawn(process.execPath, [join(installed, 'dist/cli.mjs'), 'dashboard', '--port', '0'], { cwd: project, env: { ...shellEnv, JEV_DASHBOARD_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('dashboard did not start')), 5000);
        child.stdout.on('data', chunk => { output += chunk.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//); if (match) { clearTimeout(timer); resolve(match[0]); } });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`dashboard exited ${code}`)); });
      });
      const snapshot = await (await fetch(`${url}api/snapshot`)).json() as { version: { running: string; installed: null } };
      const manifest = JSON.parse(readFileSync(join(installed, '.codex-plugin/plugin.json'), 'utf8'));
      expect(snapshot.version).toEqual({ running: manifest.version, installed: null, release: { latest: null, checkedAt: null, error: null, source: 'https://github.com/MongLong0214/jev-gate/releases/latest' } });
    } finally { child.kill(); }
  });
  it('runs the actual hook from a path with spaces and preserves execution on invalid input', () => {
    const run = spawnSync(process.execPath, [join(installed, 'dist/hook.mjs')], { cwd: project, env: shellEnv, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's' }) });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain('native Codex plugin');
    const invalid = spawnSync(process.execPath, [join(installed, 'dist/hook.mjs')], { cwd: project, env: shellEnv, encoding: 'utf8', input: 'invalid' });
    expect(invalid).toMatchObject({ status: 0, stdout: '{}\n', stderr: '' });
  });

  it('streams real hook records to the dashboard and explains how to connect automatic policies', async () => {
    const server = await startDashboard({ traceDir: traces, env: {}, host: 'codex' }, 0);
    const abort = new AbortController();
    try {
      const response = await fetch(`${server.url}api/live`, { signal: abort.signal });
      const reader = response.body!.getReader(), frames = liveFrames(reader);
      expect(JSON.stringify(await frames.next())).toContain('"host":"codex"');
      const run = spawnSync(process.execPath, [join(installed, 'dist/hook.mjs')], { cwd: project, env: shellEnv, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's2', turn_id: 't2', tool_use_id: 'tool', tool_name: 'Bash' }) });
      expect(run.status).toBe(0);
      const event = JSON.stringify(await frames.next());
      expect(event).toContain('Codex · 도구 시작');
      expect(event).toContain('"state":"active"');
      expect(event).toContain('"mode":"connect"');
      await reader.cancel();
    } finally { abort.abort(); await server.close(); }
  });
});
