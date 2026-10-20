import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installConnection, restoreConnection, type Connection } from '../../src/codex/connection.js';
import { runCodexHook } from '../../src/codex/hook.js';
import { startCodexSession } from '../../src/codex/launch.js';
import { DISPATCH_FAILED } from '../../src/codex/policy.js';
import { CODEX_SANDBOX_META } from '../../src/codex/workspace.js';
import { connectionDispatch } from '../../src/evidence/server.js';
import { openTraceDir } from '../../src/trace.js';
import type { CodexRpc } from '../../src/codex/rpc.js';
import type { Obj } from '../../src/codex/source.js';

const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });
const fixture = (config: Obj = { model: 'gpt-6.1-sol', model_reasoning_effort: 'high' }) => {
  const home = mkdtempSync(join(tmpdir(), 'jev-connect-unit-')); temps.push(home);
  const env = { CODEX_HOME: home }; let revision = 0;
  const requests: Obj[] = [];
  const rpc = { request: async (method: string, params: Obj) => {
    if (method === 'config/read') return { layers: [{ name: { type: 'user', file: join(home, 'config.toml') }, version: String(revision), config: structuredClone(config) }] };
    if (method !== 'config/batchWrite' || params['expectedVersion'] !== String(revision)) throw new Error('revision mismatch');
    requests.push(params); revision++;
    for (const edit of params['edits'] as Array<{ keyPath: string; value: unknown }>) {
      const parts = edit.keyPath.split('.'); const last = parts.pop()!; let target = config;
      for (const part of parts) { target[part] ??= {}; target = target[part] as Obj; }
      if (edit.value === null) delete target[last]; else target[last] = structuredClone(edit.value);
    }
    return {};
  } } as unknown as CodexRpc;
  const connection = (): Connection => ({ version: 1, pid: process.pid, port: 12345, token: 'a'.repeat(64), marker: 'owned compact prompt', root: home, original: {}, installed: {} });
  return { env, config, rpc, connection, requests, home };
};
describe('automatic connection ownership and recovery', () => {
  it('restores absent settings after multiple restarts, preserving the user model and effort', async () => {
    const f = fixture(); await installConnection(f.rpc, f.connection(), f.env);
    await installConnection(f.rpc, f.connection(), f.env); await installConnection(f.rpc, f.connection(), f.env);
    await restoreConnection(f.rpc, f.env);
    expect(f.config).toMatchObject({ model: 'gpt-6.1-sol', model_reasoning_effort: 'high' });
    expect(f.config['model_provider']).toBeUndefined(); expect(f.config['compact_prompt']).toBeUndefined();
    expect((f.config['model_providers'] as Obj)['jev-gate-native']).toBeUndefined();
    expect(readFileSync(join(f.home, 'jev-gate/connection/owner.json'), 'utf8')).not.toMatch(/TYPESAFE|OPENAI_API_KEY/);
  });
  it('restores explicit owner values and preserves changes made while connected', async () => {
    const f = fixture({ model_provider: 'openai', compact_prompt: 'owner prompt', model: 'gpt-5.6-terra' });
    await installConnection(f.rpc, f.connection(), f.env);
    f.config['compact_prompt'] = 'new owner prompt'; f.config['model_reasoning_effort'] = 'max';
    await restoreConnection(f.rpc, f.env);
    expect(f.config).toMatchObject({ model_provider: 'openai', compact_prompt: 'new owner prompt', model: 'gpt-5.6-terra', model_reasoning_effort: 'max' });
  });
  it('never replaces a custom provider or an unowned Jev provider', async () => {
    for (const provider of ['owner-endpoint', 'jev-gate-native']) {
      const f = fixture({ model_provider: provider });
      await expect(installConnection(f.rpc, f.connection(), f.env)).rejects.toThrow(); expect(f.requests).toHaveLength(0);
    }
  });
  it('refuses reconnecting over owner edits but can restore remaining owned keys', async () => {
    const f = fixture(); await installConnection(f.rpc, f.connection(), f.env);
    f.config['compact_prompt'] = 'owner edit';
    await expect(installConnection(f.rpc, f.connection(), f.env)).rejects.toThrow();
    await restoreConnection(f.rpc, f.env);
    expect(f.config['model_provider']).toBeUndefined(); expect(f.config['compact_prompt']).toBe('owner edit');
  });
  it('refuses symlinked connection state directories before editing native configuration', async () => {
    const f = fixture(); const outside = mkdtempSync(join(tmpdir(), 'jev-connect-outside-')); temps.push(outside);
    mkdirSync(join(f.home, 'jev-gate'), { mode: 0o700 }); symlinkSync(outside, join(f.home, 'jev-gate/connection'));
    await expect(installConnection(f.rpc, f.connection(), f.env)).rejects.toThrow(); expect(f.requests).toHaveLength(0);
  });
});
describe('connection failures are named, not collapsed (#287)', () => {
  const helper = async (answer: (res: import('node:http').ServerResponse) => void): Promise<Server> => {
    const server = createServer((req, res) => { req.resume(); req.on('end', () => answer(res)); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); return server;
  };
  const owner = (home: string, port: number) => {
    mkdirSync(join(home, 'jev-gate/connection'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'jev-gate/connection/owner.json'), JSON.stringify({ version: 1, pid: process.pid, port, token: 'a'.repeat(64), marker: 'm', root: home, original: {}, installed: {} }), { mode: 0o600 });
  };
  const meta = (home: string) => ({ [CODEX_SANDBOX_META]: { sandboxCwd: home }, threadId: 'root-thread' });
  it('returns and records the closed reason a dispatch did not reach the helper, and passes a real answer through', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-connect-fail-')); temps.push(home);
    const env = { CODEX_HOME: home, HOME: home }; const trace = join(home, 'trace');
    const opened = openTraceDir(trace, env); if (!opened.ok) throw new Error(opened.error);
    const dispatch = connectionDispatch(env, opened.writer);
    const results: string[] = [];
    results.push(await dispatch({}, meta(home), new AbortController().signal));
    const failing = await helper(res => { res.writeHead(502); res.end('Error: /secret/path'); }); owner(home, (failing.address() as { port: number }).port);
    results.push(await dispatch({}, meta(home), new AbortController().signal));
    const hanging = await helper(() => undefined); owner(home, (hanging.address() as { port: number }).port);
    results.push(await dispatch({}, meta(home), AbortSignal.timeout(100)));
    const aborted = new AbortController(); aborted.abort();
    results.push(await dispatch({}, meta(home), aborted.signal));
    const port = (failing.address() as { port: number }).port;
    await new Promise<void>(r => failing.close(() => r())); hanging.closeAllConnections(); await new Promise<void>(r => hanging.close(() => r()));
    owner(home, port);
    results.push(await dispatch({}, meta(home), new AbortController().signal));
    const answering = await helper(res => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ output: 'Worker started in the background.' })); });
    owner(home, (answering.address() as { port: number }).port);
    results.push(await dispatch({}, meta(home), new AbortController().signal));
    await new Promise<void>(r => answering.close(() => r()));
    expect(results).toEqual([...['state_missing', 'http_error', 'timeout', 'aborted', 'unreachable'].map(r => `Native connection unavailable or interrupted (${r}). No completion is claimed.`), 'Worker started in the background.']);
    const rows = readdirSync(trace).filter(f => f.startsWith('failure-')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8')) as Obj);
    expect(rows.map(r => r['connection_failure']).sort()).toEqual(['aborted', 'http_error', 'state_missing', 'timeout', 'unreachable']);
    for (const row of rows) expect(row).toMatchObject({ host: 'codex', phase: 'failure', tool_name: 'jev_agent', error_first_line: `connection_${String(row['connection_failure'])}` });
    expect(JSON.stringify(rows)).not.toContain('/secret/path');
  });
  it('answers an /agent call whose dispatch throws with fixed text instead of a bare 502', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-connect-agent-')); temps.push(root);
    writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
    writeFileSync(join(root, 'policy.json'), '{}');
    const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: join(root, 'trace') }, connection: { token: 't'.repeat(64), marker: 'compact-marker', port: 0 } });
    try {
      vi.spyOn(session.policy, 'dispatch').mockRejectedValue(new Error('EACCES /secret/path'));
      const response = await fetch(session.url.replace('ws:', 'http:') + '/agent', { method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(64)}`, 'content-type': 'application/json' }, body: JSON.stringify({ arguments: {}, meta: { [CODEX_SANDBOX_META]: { sandboxCwd: pathToFileURL(root).href }, threadId: 'root-thread' } }) });
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ output: DISPATCH_FAILED });
      // #287 R2: the helper records the closed category where it caught the exception, since the MCP server sees an ordinary answer.
      const rows = readdirSync(join(root, 'trace')).filter(f => f.startsWith('failure-')).map(f => JSON.parse(readFileSync(join(root, 'trace', f), 'utf8')) as Obj);
      expect(rows).toEqual([expect.objectContaining({ host: 'codex', session_id: 'root-thread', tool_name: 'jev_agent', error_first_line: 'dispatch_exception', dispatch_failure: 'exception' })]);
      expect(JSON.stringify(rows)).not.toMatch(/EACCES|secret/);
    } finally { vi.restoreAllMocks(); await session.close(); }
  });
  it('records why a hook did not reach the helper, on both the automatic connection and the managed bridge (#287 R2)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-connect-hook-')); temps.push(home);
    const trace = join(home, 'trace'); const event = { hook_event_name: 'PreToolUse', session_id: 'root-thread', turn_id: 'turn', tool_use_id: 'call', tool_name: 'Bash', tool_input: { command: 'ls' } };
    async function* stdin(): AsyncIterable<string> { yield JSON.stringify(event); }
    const run = (env: Record<string, string>) => runCodexHook({ stdin: stdin(), env: { CODEX_HOME: home, HOME: home, JEV_CODEX_TRACE_DIR: trace, ...env } });
    expect(await run({})).toEqual({});
    const failing = await helper(res => { res.writeHead(502); res.end('Error: /secret/path'); }); const port = (failing.address() as { port: number }).port; owner(home, port);
    expect(await run({})).toEqual({});
    expect(await run({ JEV_CODEX_BRIDGE_URL: `http://127.0.0.1:${port}`, JEV_CODEX_BRIDGE_TOKEN: 'b'.repeat(64) })).toEqual({});
    await new Promise<void>(r => failing.close(() => r()));
    expect(await run({ JEV_CODEX_BRIDGE_URL: `http://127.0.0.1:${port}`, JEV_CODEX_BRIDGE_TOKEN: 'b'.repeat(64) })).toEqual({});
    const rows = readdirSync(trace).filter(f => f.startsWith('failure-')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8')) as Obj);
    expect(rows.map(r => r['connection_failure']).sort()).toEqual(['http_error', 'http_error', 'state_missing', 'unreachable']);
    for (const row of rows) expect(row).toMatchObject({ host: 'codex', session_id: 'root-thread', event: 'PreToolUse', tool_name: 'Bash', error_first_line: `connection_${String(row['connection_failure'])}` });
    expect(readdirSync(trace).filter(f => f.startsWith('codex_event-'))).toHaveLength(4);
    expect(JSON.stringify(rows)).not.toMatch(/secret|"ls"/);
  });
});
