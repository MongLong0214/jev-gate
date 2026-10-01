import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startCodexSession } from '../../src/codex/launch.js';

describe('Codex Compact native forwarding (#137)', () => {
  it('forwards the actual untouched unsafe compact request and creates no local applied record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-forward-')); const marker = 'compact-marker'; const trace = join(root, 'trace');
    const requests: string[] = [];
    const upstream = createServer(async (req, res) => { let body = ''; for await (const b of req) body += String(b); requests.push(body); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('native-compact-fallback'); });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});\n`, { mode: 0o755 });
    writeFileSync(join(root, 'policy.json'), '{}');
    const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: trace, JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` }, connection: { token: 't'.repeat(64), marker, port: 0 } });
    try {
      await session.policy.externalHook({ hook_event_name: 'SessionStart', session_id: 's', cwd: root, model: 'gpt-6.1-sol' });
      await session.policy.externalHook({ hook_event_name: 'PreCompact', session_id: 's', trigger: 'manual' });
      const routing = vi.spyOn(session.policy, 'externalRequest');
      const body = JSON.stringify({ model: 'gpt-6.1-sol', input: [{ type: 'function_call_output', call_id: 'orphan', output: 'must be preserved' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: marker }] }], extra_owner_field: 'preserve' });
      const response = await fetch(session.url.replace('ws:', 'http:') + '/responses', { method: 'POST', headers: { 'x-jev-gate-session': session.token, 'session-id': 's', 'content-type': 'application/json' }, body });
      expect(await response.text()).toBe('native-compact-fallback'); expect(requests).toEqual([body]); expect(routing).not.toHaveBeenCalled();
      expect(readdirSync(trace).filter(f => f.startsWith('codex_compact'))).toHaveLength(0);
      expect(session.policy.previousCompact('s')).toBeUndefined();
    } finally { await session.close(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
  });
});
