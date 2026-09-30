import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/evidence/source.js';
import { startDashboard } from '../../src/dashboard.js';

const root = join(__dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'jev-codex-package-'));
const staged = join(tmp, 'source');
const installed = join(tmp, 'installed plugin');
const project = join(tmp, 'workspace');
const traces = join(tmp, 'records');
const shellEnv = { PATH: process.env['PATH'] ?? '', JEV_CODEX_TRACE_DIR: traces, JEV_CODEX_WORKSPACE: project };
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeAll(() => {
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
  writeFileSync(join(project, 'source.ts'), 'export const codexEvidenceNeedle = 42;\n');
}, 60_000);

describe('installed Codex archive', () => {
  it('runs doctor without starting an MCP transport or writing records', () => {
    const empty = join(tmp, 'doctor-only');
    const result = spawnSync(process.execPath, [join(installed, 'dist/cli.mjs'), 'doctor'], { cwd: project, env: { ...shellEnv, JEV_CODEX_TRACE_DIR: empty }, encoding: 'utf8', timeout: 5000 });
    expect(result.stderr).toBe('');
    expect(existsSync(empty)).toBe(false);
    expect(result.stdout).toContain('No source was scanned and no request was sent.');
    expect(result.stdout).toContain('[unsupported] router:');
  });
  it('runs the actual hook from a path with spaces and preserves execution on invalid input', () => {
    const run = spawnSync(process.execPath, [join(installed, 'dist/hook.mjs')], { cwd: project, env: shellEnv, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's' }) });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain('native Codex plugin');
    const invalid = spawnSync(process.execPath, [join(installed, 'dist/hook.mjs')], { cwd: project, env: shellEnv, encoding: 'utf8', input: 'invalid' });
    expect(invalid).toMatchObject({ status: 0, stdout: '{}\n', stderr: '' });
  });

  it('serves real Evidence MCP calls in the Codex workspace, with no key or installed node_modules', async () => {
    const client = new Client({ name: 'codex-package-test', version: '0' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(installed, 'dist/server.mjs'), '--codex'], cwd: project,
        env: { ...shellEnv, CLAUDE_PROJECT_DIR: '/wrong-project', PWD: '/wrong-pwd' }, stderr: 'pipe' }));
      const listed = await client.listTools();
      expect(listed.tools.map(t => t.name)).toEqual(['jev_evidence']);
      expect(listed.tools[0]!.description).toContain(realpathSync(project));
      const found = await client.callTool({ name: 'jev_evidence', arguments: { goal: 'Find the test symbol', exactSymbols: ['codexEvidenceNeedle'] } });
      const content = found.content as Array<{ type: string; text: string }>;
      const body = JSON.parse(content[0]!.text);
      expect(body.projectRoot).toBe(realpathSync(project));
      expect(body.items[0].text).toContain('codexEvidenceNeedle');
      const readBack = await client.callTool({ name: 'jev_evidence', arguments: { goal: 'Read returned source', sources: [body.items[0].source] } });
      expect(JSON.stringify(readBack)).toContain('codexEvidenceNeedle');
      const invalid = await client.callTool({ name: 'jev_evidence', arguments: { goal: 'Bad input', roots: ['../outside'] } });
      expect(invalid.isError).toBe(true);
    } finally { await client.close(); }
  });

  it('uses an explicit Evidence config as the authoritative scope and refuses unknown Codex workspaces', async () => {
    const cfg = join(tmp, 'evidence.json');
    writeFileSync(cfg, JSON.stringify({ projectRoot: project, allowedRoots: ['.'], remote: false }));
    expect(await loadConfig({ JEV_EVIDENCE_CONFIG: cfg }, { host: 'codex', cwd: '/no/workspace' })).toMatchObject({ ok: true, origin: 'explicit', config: { remote: false } });
    expect(await loadConfig({ PWD: project, CLAUDE_PROJECT_DIR: project }, { host: 'codex', cwd: tmp })).toMatchObject({ ok: false, reason: 'unsupported_inventory' });
  });

  it('streams real hook records to the dashboard and includes unsupported capability explanations', async () => {
    const server = await startDashboard({ traceDir: traces, debugDir: null, env: {}, host: 'codex' }, 0);
    const abort = new AbortController();
    try {
      const response = await fetch(`${server.url}api/live`, { signal: abort.signal });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"host":"codex"');
      const run = spawnSync(process.execPath, [join(installed, 'dist/hook.mjs')], { cwd: project, env: shellEnv, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's2', turn_id: 't2', tool_use_id: 'tool', tool_name: 'Bash' }) });
      expect(run.status).toBe(0);
      const changed = await reader.read();
      const event = new TextDecoder().decode(changed.value);
      expect(event).toContain('Codex · 도구 시작');
      expect(event).toContain('"state":"active"');
      expect(event).toContain('"state":"unsupported"');
      expect(event).not.toContain('codexEvidenceNeedle');
      await reader.cancel();
    } finally { abort.abort(); await server.close(); }
  });
});
