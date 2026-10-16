import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startCodexSession } from '../../src/codex/launch.js';
import { runtimeCodexPolicy } from '../../src/codex/config.js';

// Header shape captured from Codex CLI 0.162.1 for a native spawn_agent child; session-id is the root thread.
const childMetadata = JSON.stringify({ thread_id: 'native-child', parent_thread_id: 's', thread_source: 'subagent', subagent_kind: 'thread_spawn', agent_name: 'explorer', sandbox_mode: 'read-only', model: 'gpt-6.1-sol', reasoning_effort: 'high' });

describe('Codex native spawn_agent child requests', () => {
  it.each([true, false])('never bind to the root session state (native connection: %s)', async connected => {
    const root = mkdtempSync(join(tmpdir(), 'jev-native-child-')); const trace = join(root, 'trace');
    const requests: string[] = [];
    const upstream = createServer(async (req, res) => { let body = ''; for await (const b of req) body += String(b); requests.push(body); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { model: 'gpt-6.1-sol', usage: { input_tokens: 1 }, output: [] } }) + '\n\n'); });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
    writeFileSync(join(root, 'policy.json'), '{}');
    const env = { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: trace, JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` };
    const session = await startCodexSession({ cwd: root, env, ...(connected ? { connection: { token: 't'.repeat(64), marker: 'compact-marker', port: 0 } } : {}) });
    try {
      await session.policy.externalHook({ hook_event_name: 'SessionStart', session_id: 's', cwd: root, model: 'gpt-6.1-sol' });
      const native = session.policy.sessions.get('s')!;
      // A routed root turn: its effort patch must stay on root requests only.
      const items = [{ type: 'userMessage', clientId: 'p', content: 'Root task.' }]; const wire = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Root task.' }] }];
      const lastSubmitted = { prompt: 'p', model: 'gpt-6.1-sol', effort: 'low', requestId: 'root-request', epoch: native.epoch, index: null, scope: 'root' as const, parent: null };
      Object.assign(native, { prompt: 'p', task: 'Root task.', routed: 'p', baseline: { model: 'gpt-6.1-sol', effort: 'high' }, route: { effort: 'low', effortEdit: { kind: 'set', value: 'low' } }, routeConfig: JSON.stringify(runtimeCodexPolicy({ ...env, JEV_CODEX_MODEL: 'gpt-6.1-sol' }, session.policy.catalog).router), items, wire, complete: true, lastSubmitted });
      const observe = vi.spyOn(session.policy, 'observeRequest'); const usage = vi.spyOn(session.policy, 'observeUsage');
      expect(session.policy.requestSession(childMetadata, 's')).toBeNull();
      const body = JSON.stringify({ model: 'gpt-6.1-sol', reasoning: { effort: 'high' }, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Child task.' }] }] });
      const response = await fetch(session.url.replace('ws:', 'http:') + '/responses', { method: 'POST', headers: { 'x-jev-gate-session': session.token, 'session-id': 's', 'x-codex-turn-metadata': childMetadata, 'content-type': 'application/json' }, body });
      expect(await response.text()).toContain('response.completed');
      expect(requests).toEqual([body]);
      expect(native.items).toBe(items); expect(native.wire).toBe(wire); expect(native.route?.effort).toBe('low');
      expect(native.lastSubmitted).toBe(lastSubmitted); expect(observe).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
      expect(readdirSync(trace).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8'))).some(r => r.session_id === 's' && ['codex_model_request', 'codex_route_applied'].includes(r.phase))).toBe(false);
    } finally { await session.close(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
  });
  it('still binds known threads and root requests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-native-child-'));
    writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
    writeFileSync(join(root, 'policy.json'), '{}');
    const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: join(root, 'trace') }, connection: { token: 't'.repeat(64), marker: 'compact-marker', port: 0 } });
    try {
      await session.policy.externalHook({ hook_event_name: 'SessionStart', session_id: 's', cwd: root, model: 'gpt-6.1-sol' });
      await session.policy.externalHook({ hook_event_name: 'SessionStart', session_id: 'worker', cwd: root, model: 'gpt-6.1-sol' });
      expect(session.policy.requestSession(JSON.stringify({ thread_id: 'worker', parent_thread_id: 's', thread_source: 'subagent' }), 's')).toBe('worker');
      expect(session.policy.requestSession(JSON.stringify({ thread_id: 's', thread_source: 'user' }), 's')).toBe('s');
      expect(session.policy.requestSession(JSON.stringify({ thread_id: 'unknown' }), 's')).toBe('s');
      expect(session.policy.requestSession(undefined, 's')).toBe('s');
    } finally { await session.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
