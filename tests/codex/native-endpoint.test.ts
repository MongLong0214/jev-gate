import { createServer, request } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startCodexSession } from '../../src/codex/launch.js';

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
    finish(); expect(await (await response).text()).toContain('response.completed');
    expect(forwarded).toEqual([{ path: '/v1/models', auth: 'Bearer native-account-token', privateHeader: undefined, body: '' }, { path: '/v1/responses', auth: 'Bearer native-account-token', privateHeader: undefined, body: raw }]);
    const busy = vi.spyOn(session.policy, 'hasActiveWorkers').mockReturnValue(true);
    expect((await restartRequest()).status).toBe(409); busy.mockRestore();
    expect((await restartRequest()).status).toBe(204); await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  } finally { finish?.(); await session.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
});
