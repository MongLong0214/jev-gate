import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { startCodexSession } from '../../src/codex/launch.js';
import * as compactModule from '../../src/codex/compact.js';

describe('native Codex compaction forwarding (#178, #292)', () => {
  it.each(['/responses', '/responses/compact'])('selects old mixed tool text before %s, preserves native response bytes, and observes real upstream usage (#317)', async path => {
    const root = mkdtempSync(join(tmpdir(), 'jev-compact-wire-')); const trace = join(root, 'trace');
    const requests: Record<string, unknown>[] = [];
    let responseBody = JSON.stringify({ id: 'native-compaction', output: [{ type: 'compaction', encrypted_content: 'native-opaque-window' }], usage: { input_tokens: 9000, output_tokens: 180, input_tokens_details: { cached_tokens: 5000, cache_write_tokens: 0 } } });
    const upstream = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += String(chunk); requests.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(responseBody); });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n')});\n`, { mode: 0o755 });
    writeFileSync(join(root, 'policy.json'), JSON.stringify({ gate: { mode: 'off' }, router: { enabled: false } }));
    const judge = vi.fn(async (_url, init) => { const q = JSON.parse(String(init?.body)); return Response.json({ model: q.model, usage: { input_tokens: 500, output_tokens: 20 }, answers: Object.fromEntries(Object.keys(q.questions).map(id => [id, { type: 'choice', choice: 'remove', confidence: .99, probabilities: { keep: .005, remove: .99, unclear: .005 } }])) }); });
    const session = await startCodexSession({ cwd: root, fetchImpl: judge, env: { HOME: root, PATH: root, TYPESAFE_API_KEY: 'fake-local', JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: trace, JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` }, connection: { token: 'q'.repeat(64), port: 0 } });
    try {
      await session.policy.externalHook({ hook_event_name: 'SessionStart', session_id: 's', cwd: root, model: 'gpt-6.1-sol' });
      await session.policy.externalHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: root, turn_id: 'p', prompt: 'Finish the new parser. Old setup outputs are obsolete.' });
      const body = { model: 'gpt-6.1-sol', reasoning: { effort: 'xhigh' }, input: [{ type: 'reasoning', encrypted_content: 'keep-encrypted' }, ...Array.from({ length: 10 }, (_, i) => [
        { type: 'custom_tool_call', call_id: `c${i}`, name: 'exec', input: 'read old setup' },
        { type: 'custom_tool_call_output', call_id: `c${i}`, output: [{ type: 'input_text', text: 'Obsolete completed setup documentation.\n'.repeat(350) }, { type: 'input_image', image_url: 'data:image/png;base64,preserve' }] },
      ]).flat()] };
      const routing = vi.spyOn(session.policy, 'externalRequest'), usage = vi.spyOn(session.policy, 'observeUsage');
      const result = await fetch(session.url.replace('ws:', 'http:') + path, { method: 'POST', headers: { 'x-jev-gate-session': session.token, 'session-id': 's', 'x-codex-turn-metadata': JSON.stringify({ session_id: 's', request_kind: 'compaction' }) }, body: JSON.stringify(body) });
      expect(await result.text()).toBe(responseBody); expect(judge).toHaveBeenCalledTimes(1); expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain('Jev Compact'); expect((requests[0]!.input as unknown[])[0]).toEqual(body.input[0]);
      expect(requests[0]!.reasoning).toEqual(body.reasoning); expect((requests[0]!.input as unknown[]).slice(-12)).toEqual(body.input.slice(-12));
      expect(routing).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
      const { readFileSync } = await import('node:fs');
      const rows = readdirSync(trace).filter(f => f.startsWith('codex_compact-')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8')));
      expect(rows.find(r => r.stage === 'submitted')).toMatchObject({ applied: true, sent: true, path: 'native', prompt_id: 'p' });
      const fault = vi.spyOn(compactModule, 'prepareCodexCompact').mockRejectedValueOnce(new Error('injected optional selection failure'));
      try {
        const fallback = await fetch(session.url.replace('ws:', 'http:') + path, { method: 'POST', headers: { 'x-jev-gate-session': session.token, 'session-id': 's', 'x-codex-turn-metadata': JSON.stringify({ session_id: 's', request_kind: 'compaction' }) }, body: JSON.stringify(body) });
        expect(await fallback.text()).toBe(responseBody); expect(requests).toHaveLength(2); expect(requests[1]).toEqual(body);
      } finally { fault.mockRestore(); }
      responseBody = JSON.stringify({ status: 'incomplete', usage: { input_tokens: 9000, output_tokens: 12 } });
      const partial = await fetch(session.url.replace('ws:', 'http:') + path, { method: 'POST', headers: { 'x-jev-gate-session': session.token, 'session-id': 's', 'x-codex-turn-metadata': JSON.stringify({ session_id: 's', request_kind: 'compaction' }) }, body: JSON.stringify(body) });
      expect(await partial.text()).toBe(responseBody);
      expect(readdirSync(trace).filter(f => f.startsWith('codex_compact-')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8'))).some(r => r.stage === 'result' && r.outcome === 'failed')).toBe(true);
      expect(rows.find(r => r.stage === 'result')).toMatchObject({ outcome: 'completed', usage: { input: 4000, read: 5000, output: 180 }, total_token_saving: 'unmeasured' });
    } finally { await session.close(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    ['/responses', { request_kind: 'compaction', compaction: { trigger: 'manual', implementation: 'responses' } }, false, true],
    ['/responses', { request_kind: 'compaction' }, true, true],
    ['/responses/compact', {}, true, true],
    ['/responses', { request_kind: 'compaction' }, false, false],
    ['/responses', { request_kind: 'compaction' }, true, false],
  ] as const)('preserves native compact bytes on %s (gzip=%s, terminal=%s) without Router or context pollution', async (path, labels, compressed, terminal) => {
    const root = mkdtempSync(join(tmpdir(), 'jev-forward-')); const trace = join(root, 'trace');
    const requests: string[] = [];
    const event = terminal ? 'data: ' + JSON.stringify({ type: 'response.completed', response: { model: 'gpt-6.1-sol', usage: { input_tokens: 31, output_tokens: 7, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 } }, output: [] } }) + '\n\n' : 'data: {"type":"response.created"}\n\n';
    const upstream = createServer(async (req, res) => { let body = ''; for await (const b of req) body += String(b); requests.push(body);
      res.writeHead(200, { ...(path === '/responses/compact' ? { 'content-type': 'text/event-stream' } : {}), ...(compressed ? { 'content-encoding': 'gzip' } : {}) });
      res.end(compressed ? gzipSync(event) : event);
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
    writeFileSync(join(root, 'policy.json'), '{}');
    const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: trace, JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` }, connection: { token: 't'.repeat(64), port: 0 } });
    try {
      await session.policy.externalHook({ hook_event_name: 'SessionStart', session_id: 's', cwd: root, model: 'gpt-6.1-sol' });
      await session.policy.externalHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: root, turn_id: 'p', prompt: 'Keep the current parser contract.' });
      const native = session.policy.sessions.get('s')!;
      native.prompt = 'p'; native.route = { effort: 'low', effortEdit: { kind: 'set', value: 'low' } };
      const observe = vi.spyOn(session.policy, 'observeUsage');
      const routing = vi.spyOn(session.policy, 'externalRequest');
      const compact = vi.spyOn(session.policy, 'recordCompact');
      const body = JSON.stringify({ model: 'gpt-6.1-sol', reasoning: { effort: 'xhigh' }, input: [{ type: 'function_call_output', call_id: 'orphan', output: 'must be preserved' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarize the conversation.' }] }], extra_owner_field: 'preserve' });
      const metadata = JSON.stringify({ session_id: 's', thread_id: 's', ...labels });
      const response = await fetch(session.url.replace('ws:', 'http:') + path, { method: 'POST', headers: { 'x-jev-gate-session': session.token, 'session-id': 's', 'x-codex-turn-metadata': metadata, 'content-type': 'application/json' }, body });
      expect(await response.text()).toBe(event); expect(requests).toEqual([body]); expect(routing).not.toHaveBeenCalled();
      expect(readdirSync(trace).some(f => f.startsWith('codex_route_applied') || f.startsWith('codex_router_response') || f.startsWith('codex_model_request'))).toBe(false);
      expect(observe).not.toHaveBeenCalled(); expect(native.cache).toBeUndefined(); expect(native.route?.effort).toBe('low');
      await vi.waitFor(() => expect(compact).toHaveBeenCalledWith('s', expect.objectContaining({ path: 'native' }), 'result', expect.objectContaining(terminal ? { outcome: 'completed', usage: expect.objectContaining({ input: 21, read: 10, write: 0, output: 7 }) } : { outcome: 'failed', reason: 'response_terminal_not_observed', usage: null })));
      expect(compact.mock.calls.filter(c => c[2] === 'result')).toHaveLength(1);
    } finally { await session.close(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
  });
});
