import { createServer, request } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startCodexSession } from '../../src/codex/launch.js';
import type { Obj } from '../../src/codex/source.js';

it('forwards execution guidance only for a changed full-context pair and preserves native compact and incremental requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-routed-execution-'));
  writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
  writeFileSync(join(root, 'policy.json'), '{}');
  const forwarded: Obj[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += String(b); forwarded.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"completed"}');
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: join(root, 'trace'), JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1` }, connection: { token: 'a'.repeat(64), port: 0 } });
  try {
    vi.spyOn(session.policy, 'requestSession').mockReturnValue('native-session');
    const submitted = vi.spyOn(session.policy, 'observeRequest');
    const router = vi.spyOn(session.policy, 'externalRequest').mockImplementation(async (_id, request) => ({ request: request['pinned'] ? request : { ...request, model: 'selected' } }));
    const original: Obj = { model: 'native', reasoning: { effort: 'high' }, input: [
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'native_tool' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Native permissions.' }] },
      { type: 'reasoning', encrypted_content: 'opaque-native-checkpoint' },
      { type: 'function_call_output', call_id: 'native-call', output: 'Keep exact output.' },
    ], prompt_cache_key: 'native-cache', metadata: { owner: true } };
    const cases = [original, { ...original, instructions: 'Native full instructions.' }, { ...original, previous_response_id: 'native-state' }, { ...original, pinned: true }, original, original];
    for (const [i, input] of cases.entries()) {
      const url = session.url.replace('ws:', 'http:') + `/native/${session.token}/responses${i === 4 ? '/compact' : ''}`;
      const response = await fetch(url, { method: 'POST', headers: i === 5 ? { 'x-codex-turn-metadata': '{"request_kind":"compaction"}' } : {}, body: JSON.stringify(input) });
      expect(response.status).toBe(200); await response.text();
    }
    expect(router).toHaveBeenCalledTimes(4);
    expect(submitted.mock.calls[0]?.[3]).toEqual({ ...original, model: 'selected' });
    const lite = forwarded[0]!; expect(lite['model']).toBe('selected');
    expect((lite['input'] as Obj[]).slice(1)).toEqual(original['input']);
    expect((lite['input'] as Obj[])[0]).toMatchObject({ role: 'developer', content: [{ text: expect.stringContaining('required verification remain authoritative') }] });
    expect({ ...lite, input: original['input'] }).toEqual({ ...original, model: 'selected' });
    expect(forwarded[1]).toEqual({ ...cases[1], model: 'selected', instructions: expect.stringContaining('Native full instructions.\n\nJev routed execution:') });
    expect(forwarded.slice(2)).toEqual([{ ...cases[2], model: 'selected' }, cases[3], original, original]);
  } finally { await session.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
});

it('authenticates the built-in endpoint, preserves native auth, selects SSE before inference and defers busy updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-endpoint-'));
  writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
  writeFileSync(join(root, 'policy.json'), '{}');
  const forwarded: Array<{ path: string | undefined; auth: string | undefined; privateHeader: unknown; body: string }> = [];
  let arrived!: () => void; const receiving = new Promise<void>(r => { arrived = r; });
  let finish!: () => void;
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += String(b);
    forwarded.push({ path: req.url, auth: req.headers.authorization, privateHeader: req.headers['x-jev-gate-session'], body });
    if (req.url === '/v1/models') { res.end('{"models":[]}'); return; }
    finish = () => res.end('data: {"type":"response.completed"}\n\n');
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); arrived();
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const restart = vi.fn();
  const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: join(root, 'trace'), JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1` }, connection: { token: 'a'.repeat(64), port: 0, restart } });
  const base = session.url.replace('ws:', 'http:'); const endpoint = `${base}/native/${session.token}`;
  const restartRequest = () => fetch(base + '/restart', { method: 'POST', headers: { authorization: `Bearer ${session.token}` } });
  try {
    for (const url of [base + '/responses', base + '/native/' + 'b'.repeat(64) + '/responses', endpoint + 'x/responses']) expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
    expect(forwarded).toEqual([]);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(endpoint + '/responses', { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': Buffer.alloc(16).toString('base64'), 'sec-websocket-version': '13' } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(426); expect(forwarded).toEqual([]); // No prewarm or paid inference reaches upstream.
    expect(await (await fetch(endpoint + '/models', { headers: { authorization: 'Bearer native-account-token' } })).text()).toBe('{"models":[]}');
    const raw = '{"model":"owner-model","input":[],"owner_field":"preserve"}';
    const response = fetch(endpoint + '/responses', { method: 'POST', headers: { authorization: 'Bearer native-account-token' }, body: raw });
    await receiving;
    expect((await restartRequest()).status).toBe(409); expect(restart).not.toHaveBeenCalled();
    const beforeClose = vi.fn(async () => undefined);
    expect(await session.retire(beforeClose)).toBe(false); expect(beforeClose).not.toHaveBeenCalled();
    finish(); expect(await (await response).text()).toContain('response.completed');
    expect(forwarded).toEqual([{ path: '/v1/models', auth: 'Bearer native-account-token', privateHeader: undefined, body: '' }, { path: '/v1/responses', auth: 'Bearer native-account-token', privateHeader: undefined, body: raw }]);
    const busy = vi.spyOn(session.policy, 'hasActiveWorkers').mockReturnValue(true);
    expect((await restartRequest()).status).toBe(409);
    expect(await session.retire(beforeClose)).toBe(false); expect(beforeClose).not.toHaveBeenCalled(); busy.mockRestore();
    let release!: () => void;
    const restoring = new Promise<void>(r => { release = r; });
    const retired = session.retire(async () => { await restoring; throw new Error('revision changed'); });
    const rejected = expect(retired).rejects.toThrow('revision changed');
    expect((await fetch(endpoint + '/models')).status).toBe(503);
    expect((await restartRequest()).status).toBe(409);
    release(); await rejected;
    expect((await fetch(endpoint + '/models')).status).toBe(200); // Failed config restoration reopens serving.
    expect((await restartRequest()).status).toBe(204); await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  } finally { finish?.(); await session.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
});

it.each([false, true])('survives an upstream connection reset before headers or during SSE without replaying inference (native compact=%s)', async nativeCompact => {
  const root = mkdtempSync(join(tmpdir(), 'jev-reset-'));
  writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
  writeFileSync(join(root, 'policy.json'), '{}');
  let sent = 0; let abort: (() => void) | undefined;
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) { /* Consume the body. */ }
    sent++;
    if (sent === 1) { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (sent === 2) { res.write('data: {"type":"response.created"}\n\n'); abort = () => res.destroy(); return; }
    res.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: join(root, 'trace'), JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1` }, connection: { token: 'a'.repeat(64), port: 0 } });
  const base = session.url.replace('ws:', 'http:'); const endpoint = `${base}/native/${session.token}/responses`;
  try {
    await session.policy.externalHook({ hook_event_name: 'SessionStart', session_id: 's', cwd: root, model: 'gpt-6.1-sol' });
    await session.policy.externalHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: root, turn_id: 'p', prompt: 'Preserve the parser contract.' });
    const compact = vi.spyOn(session.policy, 'recordCompact');
    const headers = { 'session-id': 's', 'x-codex-turn-metadata': JSON.stringify({ session_id: 's', ...(nativeCompact ? { request_kind: 'compaction' } : {}) }) };
    const first = await fetch(endpoint, { method: 'POST', body: '{}', headers }); expect(first.status).toBe(502); await first.text();
    const response = await fetch(endpoint, { method: 'POST', body: '{}', headers });
    const failed = expect(response.text()).rejects.toThrow(); abort!(); await failed;
    expect(sent).toBe(2); // Native caller decides whether to retry; the gateway never replays.
    expect((await fetch(base + '/health', { headers: { authorization: `Bearer ${session.token}` } })).status).toBe(200);
    expect(await (await fetch(endpoint, { method: 'POST', body: '{}', headers })).text()).toContain('response.completed');
    expect(sent).toBe(3);
    if (nativeCompact) {
      await vi.waitFor(() => expect(compact.mock.calls.filter(c => c[2] === 'result')).toHaveLength(3));
      expect(compact.mock.calls.filter(c => c[2] === 'result').map(c => c[3].outcome)).toEqual(['failed', 'failed', 'completed']);
    }
  } finally { abort?.(); await session.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
});
