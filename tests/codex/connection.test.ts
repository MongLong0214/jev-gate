import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionBaseUrl, connectionRequest, helperRequest, installConnection, restoreConnection, type Connection } from '../../src/codex/connection.js';
import { runCodexHook } from '../../src/codex/hook.js';
import { startCodexSession } from '../../src/codex/launch.js';
import { DISPATCH_FAILED } from '../../src/codex/policy.js';
import { CODEX_SANDBOX_META } from '../../src/codex/workspace.js';
import { connectionDispatch, createServer as createMcpServer } from '../../src/evidence/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
  const connection = (): Connection => ({ version: 1, pid: process.pid, port: 12345, token: 'a'.repeat(64), root: home, original: {}, installed: {} });
  return { env, config, rpc, connection, requests, home };
};
describe('automatic connection ownership and recovery', () => {
  it('restores absent settings after multiple restarts, preserving the user model and effort', async () => {
    const f = fixture(); await installConnection(f.rpc, f.connection(), f.env);
    await installConnection(f.rpc, f.connection(), f.env); await installConnection(f.rpc, f.connection(), f.env);
    await restoreConnection(f.rpc, f.env);
    expect(f.config).toMatchObject({ model: 'gpt-6.1-sol', model_reasoning_effort: 'high' });
    expect(f.config['model_provider']).toBeUndefined(); expect(f.config['compact_prompt']).toBeUndefined();
    expect(f.config['openai_base_url']).toBeUndefined();
    expect(readFileSync(join(f.home, 'jev-gate/connection/owner.json'), 'utf8')).not.toMatch(/TYPESAFE|OPENAI_API_KEY/);
  });
  it('restores explicit owner values and preserves changes made while connected', async () => {
    const f = fixture({ model_provider: 'openai', compact_prompt: 'owner prompt', model: 'gpt-5.6-terra' });
    await installConnection(f.rpc, f.connection(), f.env);
    f.config['compact_prompt'] = 'new owner prompt'; f.config['model_reasoning_effort'] = 'max';
    await restoreConnection(f.rpc, f.env);
    expect(f.config).toMatchObject({ model_provider: 'openai', compact_prompt: 'new owner prompt', model: 'gpt-5.6-terra', model_reasoning_effort: 'max' });
  });
  it('uses the built-in provider and restores the original compatible endpoint without touching authentication', async () => {
    const original = { model_provider: 'openai', openai_base_url: 'https://owner.example/v1', model: 'gpt-6.1-sol', model_reasoning_effort: 'high', profile: 'owner', model_providers: { other: { name: 'Owner' } } };
    const f = fixture(structuredClone(original));
    await installConnection(f.rpc, f.connection(), f.env);
    expect(f.config).toEqual({ ...original, openai_base_url: connectionBaseUrl(f.connection()) });
    expect((f.requests[0]!['edits'] as Obj[]).map(e => e['keyPath'])).toEqual(['openai_base_url']);
    await restoreConnection(f.rpc, f.env); expect(f.config).toEqual(original);
  });
  it('restores the global provider and retains an owned historical alias in the same endpoint transaction', async () => {
    const legacyProvider = { name: 'Jev Gate / native Codex', base_url: 'http://127.0.0.1:12345' };
    const f = fixture({ model_provider: 'jev-gate-native', model_providers: { 'jev-gate-native': legacyProvider, other: { name: 'Owner' } }, model: 'gpt-6.1-sol' });
    const state = f.connection();
    state.original = { model_provider: 'openai', 'model_providers.jev-gate-native': null };
    state.installed = { model_provider: 'jev-gate-native', 'model_providers.jev-gate-native': legacyProvider };
    mkdirSync(join(f.home, 'jev-gate/connection'), { recursive: true, mode: 0o700 });
    writeFileSync(join(f.home, 'jev-gate/connection/owner.json'), JSON.stringify(state), { mode: 0o600 });
    await installConnection(f.rpc, f.connection(), f.env);
    expect(f.requests).toHaveLength(1);
    expect(f.config).toMatchObject({ model_provider: 'openai', openai_base_url: connectionBaseUrl(f.connection()), model: 'gpt-6.1-sol', model_providers: { other: { name: 'Owner' } } });
    expect((f.config['model_providers'] as Obj)['jev-gate-native']).toEqual({ ...legacyProvider, base_url: connectionBaseUrl(f.connection()) });
    await installConnection(f.rpc, f.connection(), f.env);
    await restoreConnection(f.rpc, f.env);
    expect(f.config['model_provider']).toBe('openai'); expect(f.config['openai_base_url']).toBeUndefined();
    expect((f.config['model_providers'] as Obj)['jev-gate-native']).toBeUndefined();
  });
  it('never replaces a custom provider or an unowned Jev provider', async () => {
    for (const provider of ['owner-endpoint', 'jev-gate-native']) {
      const f = fixture({ model_provider: provider });
      await expect(installConnection(f.rpc, f.connection(), f.env)).rejects.toThrow(); expect(f.requests).toHaveLength(0);
    }
  });
  it('refuses reconnecting over owner edits but can restore remaining owned keys', async () => {
    const f = fixture(); await installConnection(f.rpc, f.connection(), f.env);
    f.config['openai_base_url'] = 'https://owner.example/v1';
    await expect(installConnection(f.rpc, f.connection(), f.env)).rejects.toThrow();
    await restoreConnection(f.rpc, f.env);
    expect(f.config['model_provider']).toBeUndefined(); expect(f.config['openai_base_url']).toBe('https://owner.example/v1');
  });
  // #292: versions with Codex Compact wrote this exact compact_prompt and recorded the owner's value before it.
  const legacy = `[jev-gate compact ${'ab'.repeat(24)}] Produce a factual compaction summary of the preceding conversation.`;
  it('returns an earlier version\'s compact_prompt marker to the owner\'s value from before it', async () => {
    const f = fixture({ compact_prompt: 'owner prompt' }); await installConnection(f.rpc, f.connection(), f.env);
    const owner = join(f.home, 'jev-gate/connection/owner.json'); const state = JSON.parse(readFileSync(owner, 'utf8')) as Connection;
    writeFileSync(owner, JSON.stringify({ ...state, marker: legacy, original: { ...state.original, compact_prompt: 'owner prompt' }, installed: { ...state.installed, compact_prompt: legacy } }));
    f.config['compact_prompt'] = legacy;
    await installConnection(f.rpc, f.connection(), f.env);
    expect(f.config).toMatchObject({ compact_prompt: 'owner prompt', openai_base_url: connectionBaseUrl(f.connection()) });
    await restoreConnection(f.rpc, f.env);
    expect(f.config['compact_prompt']).toBe('owner prompt'); expect(f.config['model_provider']).toBeUndefined();
  });
  it('removes a leftover marker without recovery state and never touches a compact_prompt the owner wrote', async () => {
    const f = fixture({ compact_prompt: legacy }); await installConnection(f.rpc, f.connection(), f.env);
    expect(f.config['compact_prompt']).toBeUndefined();
    const owned = `${legacy} Keep file paths.`;
    const g = fixture({ compact_prompt: owned }); await installConnection(g.rpc, g.connection(), g.env);
    expect(g.config['compact_prompt']).toBe(owned);
    expect(g.requests.flatMap(r => r['edits'] as Obj[]).some(e => e['keyPath'] === 'compact_prompt')).toBe(false);
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
  const owner = (home: string, port: number, credentialsInRequest = false) => {
    mkdirSync(join(home, 'jev-gate/connection'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'jev-gate/connection/owner.json'), JSON.stringify({ version: 1, pid: process.pid, port, token: 'a'.repeat(64), marker: 'm', root: home, original: {}, installed: {}, ...(credentialsInRequest ? { credentialsInRequest: true } : {}) }), { mode: 0o600 });
  };
  it.each(['/hook', '/agent'] as const)('reaches %s without a separate credential deadline when the helper supports request credentials (#395)', async path => {
    const home = mkdtempSync(join(tmpdir(), 'jev-connect-inline-')); temps.push(home);
    const seen: string[] = [];
    const key = 'fake-inline-key';
    const server = createServer((req, res) => {
      seen.push(req.url!); req.resume();
      // The old two-request protocol times out here even though the actual endpoint is healthy.
      if (req.url === '/credentials') return;
      expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(64)}.${Buffer.from(key).toString('base64url')}`);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"received":true}');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    owner(home, (server.address() as { port: number }).port, true);
    try {
      for (let i = 0; i < 2; i++) expect(await connectionRequest({ CODEX_HOME: home, TYPESAFE_API_KEY: key }, path, {}, AbortSignal.timeout(150))).toEqual({ ok: true, value: { received: true } });
      expect(seen).toEqual([path, path]);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
  it('retains the separate credential protocol for an older running helper (#395)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-connect-legacy-')); temps.push(home);
    const seen: string[] = [];
    const key = 'fake-legacy-key';
    const server = createServer((req, res) => {
      seen.push(req.url!); req.resume();
      if (req.url === '/credentials') { expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(64)}.${Buffer.from(key).toString('base64url')}`); res.writeHead(204); res.end(); return; }
      expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(64)}`);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); owner(home, (server.address() as { port: number }).port);
    try {
      expect(await connectionRequest({ CODEX_HOME: home, TYPESAFE_API_KEY: key }, '/hook', {}, AbortSignal.timeout(1000))).toEqual({ ok: true, value: {} });
      expect(seen).toEqual(['/credentials', '/hook']);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
  const meta = (home: string) => ({ [CODEX_SANDBOX_META]: { sandboxCwd: home }, threadId: 'root-thread' });
  async function* hookEvent(session: string): AsyncIterable<string> { yield JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, turn_id: 'turn', tool_use_id: 'call', tool_name: 'Bash', tool_input: { command: 'ls' } }); }
  const failures = (trace: string): Obj[] => readdirSync(trace).filter(f => f.startsWith('failure-')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8')) as Obj);
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
  it('records a jev_agent call the MCP client cancels as aborted, though the SDK aborts with a string reason (#287)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-connect-cancel-')); temps.push(home);
    const env = { CODEX_HOME: home, HOME: home }; const trace = join(home, 'trace');
    const opened = openTraceDir(trace, env); if (!opened.ok) throw new Error(opened.error);
    let received!: () => void; const arrived = new Promise<void>(r => { received = r; });
    const hanging = createServer(req => { req.resume(); received(); }); await new Promise<void>(r => hanging.listen(0, '127.0.0.1', r));
    owner(home, (hanging.address() as { port: number }).port);
    let observedSignal: AbortSignal | undefined;
    const dispatch = connectionDispatch(env, opened.writer);
    const server = createMcpServer({ dispatch: (args, meta, signal) => { observedSignal = signal; return dispatch(args, meta, signal); } });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
    const client = new Client({ name: 'cancel-test', version: '0' }); await client.connect(b);
    try {
      const cancel = new AbortController();
      const call = client.callTool({ name: 'jev_agent', arguments: {}, _meta: meta(home) }, undefined, { signal: cancel.signal });
      await arrived; cancel.abort();
      await expect(call).rejects.toThrow();
      await vi.waitFor(() => expect(failures(trace).map(r => r['connection_failure'])).toEqual(['aborted']));
      expect(observedSignal?.aborted).toBe(true); expect(typeof observedSignal?.reason).toBe('string');
    } finally { await client.close(); await server.close(); hanging.closeAllConnections(); await new Promise<void>(r => hanging.close(() => r())); }
  });
  it.each(['aborted', 'timeout'] as const)('classifies %s while reading a helper response body from the signal (#287)', async reason => {
    const hanging = await helper(res => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
    const cancel = new AbortController();
    let reading!: () => void; const started = new Promise<void>(r => { reading = r; });
    const json = Response.prototype.json;
    const spy = vi.spyOn(Response.prototype, 'json').mockImplementation(function (this: Response) { reading(); return json.call(this); });
    try {
      const call = helperRequest(`http://127.0.0.1:${(hanging.address() as { port: number }).port}`, 'test', {}, cancel.signal);
      await started;
      cancel.abort(reason === 'timeout' ? new DOMException('deadline', 'TimeoutError') : 'MCP caller cancelled');
      await expect(call).resolves.toEqual({ ok: false, reason, stage: 'body', status: 200 });
    } finally { spy.mockRestore(); hanging.closeAllConnections(); await new Promise<void>(r => hanging.close(() => r())); }
  });
  it('answers an /agent call whose dispatch throws with fixed text instead of a bare 502', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-connect-agent-')); temps.push(root);
    writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
    writeFileSync(join(root, 'policy.json'), '{}');
    const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: join(root, 'trace') }, connection: { token: 't'.repeat(64), port: 0 } });
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
  it.each(['/hook', '/agent'] as const)('authenticates request credentials on %s without exposing them or weakening local auth (#395)', async path => {
    const root = mkdtempSync(join(tmpdir(), 'jev-connect-auth-')); temps.push(root);
    writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
    writeFileSync(join(root, 'policy.json'), '{}');
    const token = 't'.repeat(64); const key = 'fake-request-key';
    const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: join(root, 'trace') }, connection: { token, port: 0 } });
    const supply = vi.spyOn(session.policy, 'supplyKey');
    const handle = path === '/hook' ? vi.spyOn(session.policy, 'externalHook').mockResolvedValue({}) : vi.spyOn(session.policy, 'dispatch').mockResolvedValue('fixture');
    const post = (authorization: string) => fetch(session.url.replace('ws:', 'http:') + path, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '{}' });
    try {
      for (const authorization of [`Bearer ${'x'.repeat(64)}.${Buffer.from(key).toString('base64url')}`, `Bearer ${token}.!`, `Bearer ${token}.${Buffer.from('bad\nkey').toString('base64url')}`]) expect((await post(authorization)).status).toBe(401);
      expect(supply).not.toHaveBeenCalled(); expect(handle).not.toHaveBeenCalled();
      expect((await post(`Bearer ${token}.${Buffer.from(key).toString('base64url')}`)).status).toBe(200);
      expect(supply).toHaveBeenCalledExactlyOnceWith(key); expect(handle).toHaveBeenCalledTimes(1);
      expect((await post(`Bearer ${token}`)).status).toBe(200);
      expect(supply).toHaveBeenCalledTimes(1); expect(handle).toHaveBeenCalledTimes(2);
      const rows = readdirSync(join(root, 'trace')).filter(f => f.endsWith('.json')).map(f => readFileSync(join(root, 'trace', f), 'utf8'));
      expect(rows.join('')).not.toContain(key);
    } finally { vi.restoreAllMocks(); await session.close(); }
  });
  it('records why a hook did not reach the helper, on both the automatic connection and the managed bridge (#287 R2)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-connect-hook-')); temps.push(home);
    const trace = join(home, 'trace'); const bridged = { JEV_CODEX_BRIDGE_URL: '', JEV_CODEX_BRIDGE_TOKEN: 'b'.repeat(64) };
    const run = (env: Record<string, string>, session = 'root-thread') => runCodexHook({ stdin: hookEvent(session), env: { CODEX_HOME: home, HOME: home, JEV_CODEX_TRACE_DIR: trace, ...env } });
    expect(await run({})).toEqual({});
    const failing = await helper(res => { res.writeHead(502); res.end('Error: /secret/path'); }); const port = (failing.address() as { port: number }).port; owner(home, port);
    bridged.JEV_CODEX_BRIDGE_URL = `http://127.0.0.1:${port}`;
    expect(await run({})).toEqual({});
    expect(await run(bridged, 'bridge-thread')).toEqual({});
    await new Promise<void>(r => failing.close(() => r()));
    expect(await run(bridged, 'bridge-thread')).toEqual({});
    const rows = failures(trace);
    for (const row of rows) {
      expect(row).toMatchObject({ prompt_id: 'turn', tool_use_id: 'call', budget_ms: 4200, elapsed_ms: expect.any(Number), connection_stage: expect.any(String) });
      expect(JSON.stringify(row)).not.toContain('secret/path');
    }
    expect(rows.map(r => `${String(r['session_id'])}:${String(r['connection_failure'])}`).sort()).toEqual(['bridge-thread:http_error', 'bridge-thread:unreachable', 'root-thread:http_error', 'root-thread:state_missing']);
    for (const row of rows) expect(row).toMatchObject({ host: 'codex', event: 'PreToolUse', tool_name: 'Bash', error_first_line: `connection_${String(row['connection_failure'])}` });
    expect(readdirSync(trace).filter(f => f.startsWith('codex_event-'))).toHaveLength(4);
    expect(JSON.stringify(rows)).not.toMatch(/secret|"ls"/);
  });
  it('records a hook connection failure once per session and reason, however many events follow (#287)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-connect-once-')); temps.push(home);
    const trace = join(home, 'trace'); const env = { CODEX_HOME: home, HOME: home, JEV_CODEX_TRACE_DIR: trace };
    for (let i = 0; i < 5; i++) expect(await runCodexHook({ stdin: hookEvent('root-thread'), env })).toEqual({});
    expect(failures(trace).map(r => r['connection_failure'])).toEqual(['state_missing']);
    expect(failures(trace)[0]).toMatchObject({ host: 'codex', session_id: 'root-thread', event: 'PreToolUse', tool_name: 'Bash', error_first_line: 'connection_state_missing', connection_failure: 'state_missing' });
    const failing = await helper(res => { res.writeHead(502); res.end(); }); owner(home, (failing.address() as { port: number }).port);
    for (let i = 0; i < 3; i++) await runCodexHook({ stdin: hookEvent('root-thread'), env });
    await new Promise<void>(r => failing.close(() => r()));
    await runCodexHook({ stdin: hookEvent('other-thread'), env }); await runCodexHook({ stdin: hookEvent('other-thread'), env });
    expect(failures(trace).map(r => `${String(r['session_id'])}:${String(r['connection_failure'])}`).sort()).toEqual(['other-thread:unreachable', 'root-thread:http_error', 'root-thread:state_missing']);
    expect(readdirSync(trace).filter(f => f.startsWith('codex_event-'))).toHaveLength(10);
  });
});
