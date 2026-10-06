import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startCodexSession } from '../../src/codex/launch.js';

describe('Codex Compact native forwarding (#137)', () => {
  it.each([true, false])('preserves native compact bytes without Router or context pollution (local compact allowed: %s)', async allowed => {
    const root = mkdtempSync(join(tmpdir(), 'jev-forward-')); const marker = 'compact-marker'; const trace = join(root, 'trace');
    const requests: string[] = [];
    const upstream = createServer(async (req, res) => { let body = ''; for await (const b of req) body += String(b); requests.push(body); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { model: 'gpt-6.1-sol', usage: { input_tokens: 1 }, output: [] } }) + '\n\n'); });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
    writeFileSync(join(root, 'policy.json'), '{}');
    const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: trace, JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` }, connection: { token: 't'.repeat(64), marker, port: 0 } });
    try {
      await session.policy.externalHook({ hook_event_name: 'SessionStart', session_id: 's', cwd: root, model: 'gpt-6.1-sol' });
      await session.policy.externalHook({ hook_event_name: 'PreCompact', session_id: 's', trigger: 'manual' });
      const native = session.policy.sessions.get('s')!;
      native.compactAllowed = allowed; native.prompt = 'p'; native.route = { effort: 'low', effortEdit: { kind: 'set', value: 'low' } };
      const observe = vi.spyOn(session.policy, 'observeUsage');
      const routing = vi.spyOn(session.policy, 'externalRequest');
      const body = JSON.stringify({ model: 'gpt-6.1-sol', reasoning: { effort: 'xhigh' }, input: [{ type: 'function_call_output', call_id: 'orphan', output: 'must be preserved' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: marker }] }], extra_owner_field: 'preserve' });
      const response = await fetch(session.url.replace('ws:', 'http:') + '/responses', { method: 'POST', headers: { 'x-jev-gate-session': session.token, 'session-id': 's', 'content-type': 'application/json' }, body });
      expect(await response.text()).toContain('response.completed'); expect(requests).toEqual([body]); expect(routing).not.toHaveBeenCalled();
      const compactRows = readdirSync(trace).filter(f => f.startsWith('codex_compact')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8')));
      if (allowed) expect(compactRows).toContainEqual(expect.objectContaining({ stage: 'deferred', applied: false, fallback: 'unpaired_result', jev_sent: false, selection: 'not_eligible' }));
      expect(compactRows).toContainEqual(expect.objectContaining({ stage: 'native_submitted', summarizer_request: true, submitted_model: 'gpt-6.1-sol', submitted_effort: 'xhigh' }));
      expect(compactRows).toHaveLength(allowed ? 2 : 1);
      expect(readdirSync(trace).some(f => f.startsWith('codex_route_applied') || f.startsWith('codex_router_response'))).toBe(false);
      expect(observe).not.toHaveBeenCalled(); expect(native.cache).toBeUndefined(); expect(native.route?.effort).toBe('low');
      expect(compactRows.some(r => r.stage === 'selected' || r.applied === true)).toBe(false);
      expect(session.policy.previousCompact('s')).toBeUndefined();
    } finally { await session.close(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
  });
});
