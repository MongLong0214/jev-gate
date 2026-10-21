import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { serveConnection } from '../../src/codex/connection.js';
import * as launch from '../../src/codex/launch.js';

it('keeps an active stream and worker across plugin upgrades, tolerates a transient absence, and retires only an idle removed installation (#322)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-lifecycle-'));
  const home = join(root, 'home'); mkdirSync(home);
  mkdirSync(join(root, '.codex-plugin')); writeFileSync(join(root, '.codex-plugin/plugin.json'), '{"version":"1.0.0"}');
  const configPath = join(root, 'config.json'); const pluginPath = join(root, 'plugin.json');
  const original = { model: 'owner-model', model_reasoning_effort: 'high', plugins: { 'jev-gate@fixture': { enabled: true } } };
  writeFileSync(configPath, JSON.stringify(original));
  const plugin = (installed: boolean, localVersion = '1.0.0') => writeFileSync(pluginPath, JSON.stringify({ installed, localVersion }));
  plugin(true);
  writeFileSync(join(root, 'codex'), `#!${process.execPath}
const {createInterface}=require('node:readline');const fs=require('node:fs');
let revision=0;createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result={};
 if(m.method==='model/list')result={data:[],nextCursor:null};
 if(m.method==='plugin/installed'){fs.appendFileSync(${JSON.stringify(join(root, 'checks'))},'x');const p=JSON.parse(fs.readFileSync(${JSON.stringify(pluginPath)}));result={marketplaces:[{plugins:[{id:'jev-gate@fixture',name:'jev-gate',enabled:true,...p}]}]};}
 if(m.method==='config/read')result={layers:[{name:{type:'user',file:${JSON.stringify(configPath)}},version:String(revision),config:JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}))}]};
 if(m.method==='config/batchWrite'){const c=JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}));for(const e of m.params.edits){if(e.value===null)delete c[e.keyPath];else c[e.keyPath]=e.value;}revision++;fs.writeFileSync(${JSON.stringify(configPath)},JSON.stringify(c));}
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});
`, { mode: 0o755 });
  let finish: (() => void) | undefined;
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) { /* Consume the request before streaming. */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"response.created"}\n\n');
    finish = () => res.end('data: {"type":"response.completed"}\n\n');
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const start = launch.startCodexSession;
  let session: Awaited<ReturnType<typeof start>> | undefined;
  vi.spyOn(launch, 'startCodexSession').mockImplementation(async o => session = await start(o));
  // Only the service's poll clock is advanced; fake CLI/HTTP I/O remains real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const service = serveConnection(root, { HOME: home, CODEX_HOME: home, PATH: root, XDG_CONFIG_HOME: join(root, 'private-config'), JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_CODEX_TRACE_DIR: join(root, 'trace'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1` });
  const wait = async (ready: () => boolean) => { const until = performance.now() + 3000; while (!ready() && performance.now() < until) await new Promise(r => setTimeout(r, 5)); expect(ready()).toBe(true); };
  const checks = () => existsSync(join(root, 'checks')) ? readFileSync(join(root, 'checks'), 'utf8').length : 0;
  const poll = async () => { const before = checks(); vi.advanceTimersByTime(5000); await wait(() => checks() > before); await new Promise(r => setTimeout(r, 30)); };
  try {
    await wait(() => existsSync(join(home, 'jev-gate/connection/owner.json')) && readFileSync(configPath, 'utf8').includes('/native/'));
    const state = JSON.parse(readFileSync(join(home, 'jev-gate/connection/owner.json'), 'utf8')) as { port: number; token: string };
    const base = `http://127.0.0.1:${state.port}`;
    const healthy = async () => expect((await fetch(base + '/health', { headers: { authorization: `Bearer ${state.token}` } })).status).toBe(200);
    const response = await fetch(`${base}/native/${state.token}/responses`, { method: 'POST', body: '{}' });
    const text = response.text(); void text.catch(() => undefined);
    const held = vi.spyOn(session!.policy, 'hasActiveWorkers').mockReturnValue(true);
    plugin(true, '1.1.0'); await poll(); await healthy();
    plugin(false); await poll(); await poll(); await healthy();
    finish!(); expect(await text).toContain('response.completed');
    await poll(); await healthy(); // The owned worker remains active between requests.
    held.mockRestore(); plugin(true, '1.1.0'); await poll(); await healthy();
    plugin(false); await poll(); await healthy();
    plugin(true, '1.1.0'); await poll(); await healthy(); // One missing sample is not an uninstall.
    plugin(false); await poll(); await poll(); await service;
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(original);
  } finally {
    finish?.(); await session?.close(); await service;
    vi.useRealTimers(); vi.restoreAllMocks(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
