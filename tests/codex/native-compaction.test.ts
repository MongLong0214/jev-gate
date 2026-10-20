import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startCodexSession } from '../../src/codex/launch.js';

describe('native Codex compaction forwarding (#178, #292)', () => {
  it.each([['/responses', { request_kind: 'compaction', compaction: { trigger: 'manual', implementation: 'responses' } }], ['/responses/compact', {}]])('preserves native compact bytes on %s without Router or context pollution', async (path, labels) => {
    const root = mkdtempSync(join(tmpdir(), 'jev-forward-')); const trace = join(root, 'trace');
    const requests: string[] = [];
    const upstream = createServer(async (req, res) => { let body = ''; for await (const b of req) body += String(b); requests.push(body); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { model: 'gpt-6.1-sol', usage: { input_tokens: 1 }, output: [] } }) + '\n\n'); });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
    writeFileSync(join(root, 'policy.json'), '{}');
    const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: trace, JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` }, connection: { token: 't'.repeat(64), port: 0 } });
    try {
      await session.policy.externalHook({ hook_event_name: 'SessionStart', session_id: 's', cwd: root, model: 'gpt-6.1-sol' });
      const native = session.policy.sessions.get('s')!;
      native.prompt = 'p'; native.route = { effort: 'low', effortEdit: { kind: 'set', value: 'low' } };
      const observe = vi.spyOn(session.policy, 'observeUsage');
      const routing = vi.spyOn(session.policy, 'externalRequest');
      const body = JSON.stringify({ model: 'gpt-6.1-sol', reasoning: { effort: 'xhigh' }, input: [{ type: 'function_call_output', call_id: 'orphan', output: 'must be preserved' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarize the conversation.' }] }], extra_owner_field: 'preserve' });
      const metadata = JSON.stringify({ session_id: 's', thread_id: 's', ...labels });
      const response = await fetch(session.url.replace('ws:', 'http:') + path, { method: 'POST', headers: { 'x-jev-gate-session': session.token, 'session-id': 's', 'x-codex-turn-metadata': metadata, 'content-type': 'application/json' }, body });
      expect(await response.text()).toContain('response.completed'); expect(requests).toEqual([body]); expect(routing).not.toHaveBeenCalled();
      expect(readdirSync(trace).some(f => f.startsWith('codex_route_applied') || f.startsWith('codex_router_response') || f.startsWith('codex_model_request'))).toBe(false);
      expect(observe).not.toHaveBeenCalled(); expect(native.cache).toBeUndefined(); expect(native.route?.effort).toBe('low');
    } finally { await session.close(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
  });
});
