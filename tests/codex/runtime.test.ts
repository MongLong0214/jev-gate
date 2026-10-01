import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadActivity } from '../../src/activity.js';
import { WebSocket } from 'ws';
import { startCodexSession } from '../../src/codex/launch.js';

// Real Codex process + real plugin + real MCP + fake local model. Never uses a model key/login.
// Explicit opt-in: this exercises Codex's installer and removes only its uniquely named test installation.
const required = process.env['JEV_CODEX_E2E'] === '1';
const root = join(__dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'jev-codex-runtime-'));
const runtimeEnv = { ...process.env, CODEX_HOME: join(tmp, 'codex home') };
const plugin = join(tmp, 'plugin with spaces');
const workspace = join(tmp, 'workspace');
const market = `jev-test-${Date.now()}`;
const log = `\n RUN  v5.0.1 /fixture\n\n${'fixture repeat detail\n'.repeat(100)} ✓ a.test.ts (1 test) 1ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n   Start at  10:20:30\n   Duration  10ms\n`;
let installed = false;
let marketAdded = false;
const isolation: string[] = [];
afterAll(() => {
  if (installed) {
    const removed = spawnSync('codex', ['plugin', 'remove', `jev-gate@${market}`], { env: runtimeEnv, encoding: 'utf8', timeout: 15_000 });
    expect(removed.status, removed.stderr).toBe(0);
  }
  if (marketAdded) {
    const removed = spawnSync('codex', ['plugin', 'marketplace', 'remove', market], { env: runtimeEnv, encoding: 'utf8', timeout: 15_000 });
    expect(removed.status, removed.stderr).toBe(0);
  }
  rmSync(tmp, { recursive: true, force: true });
});

type Rec = Record<string, unknown>;
const functions = (tools: unknown): Rec[] => Array.isArray(tools) ? tools.flatMap(t => t && typeof t === 'object'
  ? (t as Rec)['type'] === 'namespace' ? functions((t as Rec)['tools']).map(f => ({ ...f, namespace: (t as Rec)['name'] })) : [t as Rec] : []) : [];

const requestFunctions = (request: Rec): Rec[] => [...functions(request['tools']), ...(Array.isArray(request['input']) ? request['input'].flatMap(i => (i as Rec)?.['type'] === 'additional_tools' ? functions((i as Rec)['tools']) : []) : [])];

describe.skipIf(!required)('real Codex native plugin runtime', () => {
  beforeAll(() => {
    const available = spawnSync('codex', ['--version'], { env: runtimeEnv, encoding: 'utf8' });
    expect(available.status, 'Install Codex CLI 0.158.0+ to run the native runtime tests').toBe(0);
    // Never depend on or mutate the owner's plugins, hooks, MCPs or authentication.
    mkdirSync(runtimeEnv.CODEX_HOME, { recursive: true });
    writeFileSync(join(runtimeEnv.CODEX_HOME, 'config.toml'), '[features]\nplugins=true\nhooks=true\n');
    const staged = join(tmp, 'source');
    const stagedPlugin = join(staged, 'plugins/codex');
    cpSync(join(root, 'plugins/codex'), stagedPlugin, { recursive: true, filter: p => !p.includes('/dist/') && !p.endsWith('/dist') });
    // MCP server names are global in the host. A user's installed Evidence server must not shadow this fixture,
    // or be re-enabled by it. Keep the packaged manifest path and loader, with only a disposable server name.
    const mcpFile = join(stagedPlugin, '.mcp.json');
    const mcp = JSON.parse(readFileSync(mcpFile, 'utf8')) as { mcpServers: Record<string, unknown> };
    mcp.mcpServers['jev_runtime_fixture'] = mcp.mcpServers['jev_gate_evidence'];
    (mcp.mcpServers['jev_runtime_fixture'] as Rec)['env'] = { JEV_CODEX_AUTO_CONNECT: '0' };
    delete mcp.mcpServers['jev_gate_evidence'];
    writeFileSync(mcpFile, JSON.stringify(mcp));
    const built = spawnSync(process.execPath, [join(root, 'scripts/build-codex.mjs'), join(stagedPlugin, 'dist')], { env: runtimeEnv, encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
    cpSync(join(root, 'package.json'), join(staged, 'package.json'));
    const packed = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), join(tmp, 'archives'), '--profile', 'codex', '--root', staged], { env: runtimeEnv, encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    const archive = readdirSync(join(tmp, 'archives')).find(f => f.endsWith('.zip'))!;
    mkdirSync(plugin);
    expect(spawnSync('unzip', ['-q', join(tmp, 'archives', archive), '-d', plugin]).status).toBe(0);
    mkdirSync(workspace); mkdirSync(join(workspace, '.bin'));
    expect(spawnSync('git', ['init', '-q'], { cwd: workspace }).status).toBe(0);
    writeFileSync(join(workspace, 'source.ts'), 'export const runtimeEvidenceNeedle = 42;\n');
    writeFileSync(join(workspace, '.bin/vitest'), `#!${process.execPath}\nconst text = ${JSON.stringify(log)}; const fail = process.argv.includes("fail"); process.stdout.write(fail ? text.replaceAll("1 passed", "1 failed") : text); process.exitCode = fail ? 1 : 0;\n`, { mode: 0o755 });
    const marketplace = JSON.parse(readFileSync(join(plugin, '.agents/plugins/marketplace.json'), 'utf8')) as Rec;
    marketplace['name'] = market;
    writeFileSync(join(plugin, '.agents/plugins/marketplace.json'), JSON.stringify(marketplace));
    const registered = spawnSync('codex', ['plugin', 'marketplace', 'add', plugin], { env: runtimeEnv, encoding: 'utf8', timeout: 20_000 });
    expect(registered.status, registered.stderr).toBe(0);
    marketAdded = true;
    const added = spawnSync('codex', ['plugin', 'add', `jev-gate@${market}`, '--json',
      '-c', `marketplaces.${market}.source_type="local"`,
      '-c', `marketplaces.${market}.source=${JSON.stringify(plugin)}`], { env: runtimeEnv, encoding: 'utf8', timeout: 20_000 });
    expect(added.status, added.stderr).toBe(0);
    installed = true;
  }, 60_000);

  it.each(['single', 'failed', 'permission-boundary', 'edit-after-check', 'worktree', 'hierarchy', 'lean', 'cancelled', 'budget', 'compact-manual', 'compact-auto', 'routing-gpt-6.1-sol', 'routing-gpt-6-astra', 'routing-gpt-6-sol', 'routing-gpt-6-luna', 'routing-gpt-5.6-terra', 'routing-model-terra'])('runs automatic native Codex policies: %s', async scenario => {
    const routing = scenario.startsWith('routing-');
    const baselineModel = routing && scenario !== 'routing-model-terra' ? scenario.slice('routing-'.length) : 'gpt-6.1-sol';
    const targetEffort = baselineModel.endsWith('luna') ? 'max' : 'ultra';
    const requests: Rec[] = []; const headerKeys: string[][]=[];
    const trace = join(tmp, `managed ${scenario} traces`);
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[]}'); return; }
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      let body: Buffer = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'zstd') body = createRequire(import.meta.url)('node:zlib').zstdDecompressSync(body);
      const request = JSON.parse(body.toString()) as Rec; requests.push(request); headerKeys.push(Object.keys(req.headers));
      const index=requests.length;
      const final=(text:string):Rec=>({id:`msg_${index}`,type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text,annotations:[]}]});
      const fn=(name:string,args:Rec):Rec=>requestFunctions(request).some(t=>t['name']===name) ? {id:`fc_${index}`,type:'function_call',call_id:`call_${index}`,name,arguments:JSON.stringify(args)} : {id:`fc_${index}`,type:'custom_tool_call',call_id:`call_${index}`,name:'exec',input:`const result = await tools.${name}(${JSON.stringify(args)}); text(result);`};
      let item = index===2 ? fn('exec_command',{cmd:'touch guard-must-not-exist',login:false}) : index===3 ? fn('jev_agent',{subagent_type:'jev-gate:worker',prompt:'Investigate the fixture and run vitest run.'}) : index===4 ? fn('exec_command',{cmd:'vitest run',login:false,max_output_tokens:8000}) : index===5 ? final('```json\n'+JSON.stringify({status:'done',summary:'Fixture checked',changed_files:[],interfaces:[],checks:[{check_id:'vitest run',result:'pass',note:'actual run'}],blockers:[]})+'\n```') : final('managed native complete');
      const report=(check:string):string=>'```json\n'+JSON.stringify({status:'done',summary:'Fixture checked',changed_files:[],interfaces:[],checks:[{check_id:check,result:'pass',note:'actual run'}],blockers:[]})+'\n```';
      if(scenario==='failed' && index===4) item=fn('exec_command',{cmd:'vitest run fail',login:false,max_output_tokens:8000});
      if(scenario==='failed' && index===5) item=final(report('vitest run fail'));
      if(scenario==='permission-boundary' && index===4) item=fn('exec_command',{cmd:'touch worker-must-not-exist',login:false});
      if(scenario==='permission-boundary' && index===5) item=final(report('touch worker-must-not-exist'));
      if(scenario==='edit-after-check') {
        if(index===5) {
          const patch=`*** Begin Patch\n*** Add File: ${join(workspace,'changed.ts')}\n+export const observedEdit = 1;\n*** End Patch`;
          item=requestFunctions(request).some(t=>t['name']==='apply_patch')
            ? {id:`fc_${index}`,type:'custom_tool_call',call_id:`call_${index}`,name:'apply_patch',input:patch}
            : {id:`fc_${index}`,type:'custom_tool_call',call_id:`call_${index}`,name:'exec',input:`text(await tools.apply_patch(${JSON.stringify(patch)}));`};
        } else if(index===6 || index===9) item=final(report('vitest run'));
        else if(index===7) item=fn('jev_agent',{subagent_type:'jev-gate:worker',prompt:'Investigate the fixture and run vitest run after the observed edit.'});
        else if(index===8) item=fn('exec_command',{cmd:'vitest run',login:false,max_output_tokens:8000});
      }
      if(scenario==='cancelled' && index===4) item=fn('exec_command',{cmd:'sleep 30',login:false,yield_time_ms:1000});
      if(scenario==='cancelled' && index>=5) { res.writeHead(200,{'content-type':'text/event-stream'}); res.flushHeaders(); return; }
      if(scenario==='budget' && index>=2) item=fn('exec_command',{cmd:'touch guard-must-not-exist',login:false});
      if(scenario==='hierarchy'||scenario==='worktree') {
        const task=(id:string,deps:string[])=>({id,outcome:'Check the fixture',depends_on:deps,deliverables:['source.ts'],constraints:[],checks:[{id:'c1',description:'Check fixture',required:true,command:'vitest run'}]});
        const plan={status:'ready',goal:'Check two dependent outcomes',constraints:[],tasks:[task('t1',[]),task('t2',['t1'])]};
        if(index===3) item=fn('jev_agent',{subagent_type:'jev-gate:planner',prompt:'Plan the two fixture outcomes.'});
        else if(index===4) item=final('```json\n'+JSON.stringify(plan)+'\n```');
        else if(index===5 || index===9) item=fn('jev_agent',{subagent_type:'jev-gate:worker',prompt:'[JEV_TASK rev=1 id=t2]\nCheck t2.'});
        else if(index===6) item=fn('jev_agent',{subagent_type:'jev-gate:worker',prompt:'[JEV_TASK rev=1 id=t1]\nCheck t1.'});
        else if(index===7 || index===10) item=fn('exec_command',{cmd:'vitest run',login:false,max_output_tokens:8000});
        else if(index===8 || index===11) item=final(report('c1'));
      }
      if(scenario==='lean') {
        if(index===1) item=final('Old unrelated narrative. '.repeat(300));
        else if(index===2) { const marker=JSON.stringify(request['input']).match(/jev-lean-[a-f0-9]{16}/)?.[0]; item=fn('jev_agent',{subagent_type:'jev-gate:executor',prompt:marker ?? 'missing marker'}); }
        else if(index===3) item=fn('exec_command',{cmd:'vitest run',login:false,max_output_tokens:8000});
        else if(index===4) item=final(report('vitest run'));
      }
      if(scenario.startsWith('compact')) item=final(index===1?'Old unrelated narrative. '.repeat(6000):'managed native complete');
      const response = { id: `resp_${requests.length}`, status: 'completed', output: [item], usage: { input_tokens: scenario==='compact-auto' && index===2 ? 300000 : 150000, output_tokens: 1, total_tokens: scenario==='compact-auto' && index===2 ? 300001 : 150001 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const config = [...isolation, 'features.plugins=true', 'features.hooks=true', `model=${JSON.stringify(baselineModel)}`, 'model_reasoning_effort="medium"', 'model_context_window=1000000', `model_auto_compact_token_limit=${scenario === 'compact-auto' ? 200000 : 900000}`, `marketplaces.${market}.source_type="local"`, `marketplaces.${market}.source=${JSON.stringify(plugin)}`, `plugins.jev-gate@${market}.enabled=true`, 'shell_environment_policy.inherit="all"'];
    if(scenario==='worktree') {
      expect(spawnSync('git',['add','source.ts'],{cwd:workspace}).status).toBe(0);
      expect(spawnSync('git',['-c','user.name=Jev fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture'],{cwd:workspace}).status).toBe(0);
    }
    const policyFile=join(tmp, `policy ${scenario}.json`); writeFileSync(policyFile,JSON.stringify({gate:{mode:scenario.startsWith('compact')||routing?'off':scenario==='lean'?'lean':'auto',admittedShape:scenario==='hierarchy'||scenario==='worktree'?'hierarchy':'auto',...(scenario==='worktree'?{workerIsolation:'worktree',maxParallelWorkers:2,guardAllowTools:['Bash','Read','Glob','Grep','Agent']}: {})},...(scenario==='routing-model-terra'?{router:{model:true},gate:{mode:'off',models:{fast:'gpt-6-luna',standard:'gpt-5.6-terra',deep:'gpt-6.1-sol',frontier:'gpt-6-astra'}}}:{}),compact:{manual:scenario==='compact-manual'}}));
    const profiles=Object.fromEntries(['planner','planner-frontier','worker-fast','worker','worker-deep','worker-frontier','executor'].map(n=>[`jev-gate:${n}`,readFileSync(join(root,'agents',n+'.md'),'utf8').replace(/^---[\s\S]*?---\s*/, '')]));
    const session = await startCodexSession({ cwd: workspace, env: { ...runtimeEnv, PATH:`${join(workspace,'.bin')}:${process.env['PATH'] ?? ''}`, JEV_CODEX_CONFIG:policyFile, JEV_CODEX_TRACE_DIR: trace, JEV_GATE_STATE_DIR: join(tmp, `managed ${scenario} state`), JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(server.address() as {port:number}).port}/v1`, TYPESAFE_API_KEY: 'fixture-key' }, serverArgs: config.flatMap(c => ['-c', c]), bypassHookTrust: true, nativeAuth: false, profiles,
      fetchImpl: (async (_url, init) => {
        const parsed=JSON.parse(String(init?.body)); const q = parsed.questions;
        return new Response(JSON.stringify({ model: parsed.model, answers: Object.fromEntries(Object.keys(q).map(k => { const score=routing && k==='effort'?q[k].criteria.length-1:routing && k==='tier'?1:k==='tool_calls'?4:k==='size'?2:0; const picks:Record<string,string>={work_shape:'sustained_task',handoff_scope:'self_contained'}; const pick=k.startsWith('relation_')?'omit':picks[k] ?? Object.keys(q[k].criteria ?? {})[0]; return [k, q[k].type === 'score' ? { type: 'score', score, confidence:1, probabilities: Object.fromEntries(q[k].criteria.map((_:unknown,i:number)=>[i,i===score?1:0])) } : q[k].type === 'noul' ? { type:'noul',noul:0 } : { type: 'choice', choice: pick, confidence: 1, probabilities: Object.fromEntries(Object.keys(q[k].criteria).map(v=>[v,v===pick?1:0])) }]; })) }), { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch });
    const socket = new WebSocket(session.url, { headers: { Authorization: `Bearer ${session.token}` } });
    const opened = new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    const messages: Rec[] = []; const pending = new Map<number, {resolve:(v:Rec)=>void;reject:(e:Error)=>void}>(); let seq=0;
    socket.on('message', data => { const m=JSON.parse(String(data)) as Rec; messages.push(m); const p=pending.get(Number(m['id'])); if(p){pending.delete(Number(m['id']));m['error']?p.reject(new Error(JSON.stringify(m['error']))):p.resolve(m['result'] as Rec);} });
    const call = (method:string, params:Rec):Promise<Rec> => new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
    try {
      if (scenario === 'single') {
        const refused = await fetch(session.url.replace('ws:', 'http:') + '/responses?probe=1', { method: 'POST', headers: { 'x-jev-gate-session': session.token }, body: '{}' });
        expect(refused.status).toBe(412); expect(requests).toHaveLength(0);
      }
      await opened;
      await call('initialize', { clientInfo: {name:'jev-test',version:'1'}, capabilities: {experimentalApi:true} }); socket.send(JSON.stringify({method:'initialized'}));
      const started=await call('thread/start',{cwd:workspace,model:baselineModel,approvalPolicy:'never',sandbox:scenario==='edit-after-check'?'workspace-write':'read-only',ephemeral:true});
      const id=String((started['thread'] as Rec)['id']);
      const hookList=await call('hooks/list',{cwds:[workspace]});
      await call('turn/start',{threadId:id,collaborationMode:{mode:'default',settings:{model:baselineModel,reasoning_effort:'medium',developer_instructions:null}},input:[{type:'text',text:'Explain the fixture. Preserve the userConstraintNeedle verbatim.',text_elements:[]}]});
      const until=Date.now()+20000; while(!messages.some(m=>m['method']==='turn/completed') && Date.now()<until) await new Promise(r=>setTimeout(r,20));
      expect(messages.some(m=>m['method']==='turn/completed'),JSON.stringify(messages)).toBe(true);
      expect(requests.length).toBe(1);
      expect(JSON.stringify(requests[0])).toContain('jev_agent');
      expect(JSON.stringify(requests[0])).toContain('Jev Gate');
      const rows=readdirSync(trace).map(f=>JSON.parse(readFileSync(join(trace,f),'utf8')) as Rec);
      if(scenario.startsWith('compact')) {
        const waitTurn=async(at:number)=>{ const end=Date.now()+15000; while(!messages.slice(at).some(m=>m['method']==='turn/completed' && (m['params'] as Rec)['threadId']===id) && Date.now()<end) await new Promise(r=>setTimeout(r,20)); };
        const second=messages.length;
        await call('turn/start',{threadId:id,collaborationMode:{mode:'default',settings:{model:baselineModel,reasoning_effort:'medium',developer_instructions:null}},input:[{type:'text',text:'Give a short second answer.',text_elements:[]}]}); await waitTurn(second);
        if(scenario==='compact-manual') {
          const compactStart=messages.length;
          await call('thread/compact/start',{threadId:id});
          const end=Date.now()+15000; while(!readdirSync(trace).some(f=>f.startsWith('codex_compact') && JSON.parse(readFileSync(join(trace,f),'utf8')).stage==='installed') && Date.now()<end) await new Promise(r=>setTimeout(r,20));
          await waitTurn(compactStart);
        }
        const third=messages.length;
        await call('turn/start',{threadId:id,collaborationMode:{mode:'default',settings:{model:baselineModel,reasoning_effort:'medium',developer_instructions:null}},input:[{type:'text',text:'Continue and preserve the original user constraints.',text_elements:[]}]}); await waitTurn(third);
        const all=readdirSync(trace).map(f=>JSON.parse(readFileSync(join(trace,f),'utf8')) as Rec);
        expect(all.some(r=>r['phase']==='codex_compact' && r['stage']==='installed' && r['applied']===true),JSON.stringify({all,count:requests.length})).toBe(true);
        expect(requests.length).toBe(3);
        expect(JSON.stringify(requests[2]!['input'])).toContain('[jev-gate compact]');
        expect(JSON.stringify(requests[2]!['input'])).toContain('userConstraintNeedle');
        expect(JSON.stringify(all)).not.toContain('userConstraintNeedle');
        return;
      }
      if (routing) {
        // Ultra uses the model's native inference setting, which can differ as its live catalog changes.
        const wireEffort = (requests[0]!['reasoning'] as Rec)['effort'];
        if (targetEffort === 'ultra') expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(wireEffort);
        else expect(wireEffort).toBe(targetEffort);
        expect(requests[0]!['model']).toBe(scenario === 'routing-model-terra' ? 'gpt-5.6-terra' : baselineModel);
        expect(rows.some(r => r['phase'] === 'codex_route_applied' && r['selected_effort'] === targetEffort && r['observed_host_effort'] === targetEffort && r['observed_effort'] === wireEffort && r['applied'] === true), JSON.stringify(rows)).toBe(true);
        return;
      }
      expect((requests[0]!['reasoning'] as Rec)['effort'],JSON.stringify(rows)).toBe('low');
      expect(rows.some(r=>r['phase']==='codex_router_result'),JSON.stringify(rows)).toBe(true);
      expect(rows.some(r=>r['phase']==='codex_route_applied' && r['applied']===true),JSON.stringify({rows,headerKeys,hookCount:(hookList['data'] as Rec[]).length})).toBe(true);
      const before=messages.length;
      await call('turn/start',{threadId:id,collaborationMode:{mode:'default',settings:{model:baselineModel,reasoning_effort:'medium',developer_instructions:null}},input:[{type:'text',text:'Investigate the repository fixture and check it using vitest run.',text_elements:[]}]});
      if(scenario==='cancelled') {
        const deadline=Date.now()+15000;
        while(!messages.slice(before).some(m=>m['method']==='item/started' && (m['params'] as Rec)['threadId']!==id && ((m['params'] as Rec)['item'] as Rec)['type']==='commandExecution') && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
        const active=messages.slice(before).filter(m=>m['method']==='turn/started' && (m['params'] as Rec)['threadId']===id).at(-1);
        expect(active).toBeDefined();
        await call('turn/interrupt',{threadId:id,turnId:((active!['params'] as Rec)['turn'] as Rec)['id']});
        const end=Date.now()+10000;
        while(!readdirSync(trace).some(f=>f.startsWith('failure-')) && Date.now()<end) await new Promise(r=>setTimeout(r,20));
        const all=readdirSync(trace).map(f=>JSON.parse(readFileSync(join(trace,f),'utf8')) as Rec);
        expect(all.some(r=>r['phase']==='failure'),JSON.stringify(all)).toBe(true);
        expect(all.some(r=>r['phase']==='post' && r['verdict']==='accept')).toBe(false);
        await vi.waitFor(() => expect(session.policy.sessions.size).toBe(1), { timeout: 3000 });
        return;
      }
      const end=Date.now()+20000; while(!messages.slice(before).some(m=>m['method']==='turn/completed' && (m['params'] as Rec)['threadId']===id) && Date.now()<end) await new Promise(r=>setTimeout(r,20));
      const all=readdirSync(trace).map(f=>JSON.parse(readFileSync(join(trace,f),'utf8')) as Rec);
      if(scenario==='edit-after-check') {
        expect(readFileSync(join(workspace,'changed.ts'),'utf8')).toContain('observedEdit');
        const posts=all.filter(r=>r['phase']==='post').sort((a,b)=>String(a['written_at']).localeCompare(String(b['written_at'])));
        expect(posts.map(r=>r['verdict']),JSON.stringify(posts)).toEqual(['incomplete','accept']);
        expect((posts[0]!['verification'] as Rec)['stale']).toEqual(['#1']);
        expect(messages.some(m=>m['method']==='item/completed' && ((m['params'] as Rec)['item'] as Rec)?.['type']==='fileChange')).toBe(true);
        expect(requests.length).toBe(10);
        return;
      }
      if(scenario==='budget') {
        expect(requests.length,JSON.stringify(all)).toBe(13);
        expect(all.some(r=>r['phase']==='guard' && r['stopped']===true)).toBe(true);
        expect(existsSync(join(workspace,'guard-must-not-exist'))).toBe(false);
        expect(messages.slice(before).some(m=>m['method']==='turn/completed' && ((m['params'] as Rec)['turn'] as Rec)['status']==='interrupted')).toBe(true);
        return;
      }
      expect(requests.length,JSON.stringify({all,turns:messages.slice(before).filter(m=>m['method']==='turn/completed')})).toBe(scenario==='hierarchy'||scenario==='worktree'?12:scenario==='lean'?5:6);
      expect(existsSync(join(workspace,'guard-must-not-exist'))).toBe(false);
      if(scenario==='lean') {
        expect(all.some(r=>r['phase']==='lean_dispatch'),JSON.stringify(all)).toBe(true);
        expect(all.some(r=>['admission_intent','pre_intent','guard','plan'].includes(String(r['phase'])))).toBe(false);
        expect(JSON.stringify(requests[2]!['input'])).not.toContain('Old unrelated narrative');
        expect(JSON.stringify(requests[2]!['input'])).toContain('Investigate the repository fixture');
      } else {
        if(scenario!=='worktree') expect(JSON.stringify(requests[2]!['input'])).toContain('denied');
        if(scenario==='permission-boundary') expect(existsSync(join(workspace,'worker-must-not-exist'))).toBe(false);
        if(scenario==='worktree') {
          expect(JSON.stringify(requests[6]!['input'])).toContain('worktrees/jev-codex-');
          expect(all.some(r=>r['phase']==='post' && r['verdict']==='accept'),JSON.stringify(all)).toBe(true);
        }
        expect(all.some(r=>r['phase']==='admission_result' && (r['decision'] as Rec)?.['shape']==='orchestrated'),JSON.stringify(all)).toBe(true);
        expect(all.some(r=>r['phase']==='post' && r['verdict']===(['failed','permission-boundary'].includes(scenario)?'incomplete':'accept')),JSON.stringify(all.filter(r=>r['phase']==='post'))).toBe(true);
        if(scenario==='hierarchy'||scenario==='worktree') {
          expect(all.filter(r=>r['phase']==='dispatch' && r['role']==='worker').length).toBe(2);
          expect(all.some(r=>r['phase']==='post' && r['plan_complete']===true),JSON.stringify(all)).toBe(true);
          expect(JSON.stringify(requests[6]!['input'])).toContain('[Jev Gate task contract]');
        }
      }
    } finally { socket.terminate(); await session.close(); server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); }
  }, 60000);

  const run = async (trust: boolean, scenario = 'passing'): Promise<{ requests: Rec[]; output: string; code: number | null; trace: string }> => {
    const requests: Rec[] = [];
    const trace = join(tmp, `${trust ? 'trusted' : 'untrusted'} ${scenario} traces`);
    if (scenario === 'recording-unavailable') writeFileSync(trace, 'not a directory');
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[]}'); return; }
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      let body: Buffer = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'zstd') {
        // Node 22.15+ / 24; the plugin itself still targets Node 22.
        const zlib = createRequire(import.meta.url)('node:zlib') as { zstdDecompressSync: (b: Buffer) => Buffer };
        body = zlib.zstdDecompressSync(body);
      }
      const request = JSON.parse(body.toString()) as Rec;
      requests.push(request);
      const tool = requestFunctions(request).find(t => String(t['name']).endsWith('jev_evidence'));
      const index = requests.length;
      const item: Rec = index === 1
        ? { id: `fc_${index}`, type: 'function_call', call_id: `call_${index}`, name: 'exec_command', arguments: JSON.stringify({ cmd: scenario === 'failed' ? 'vitest run fail' : 'vitest run', login: false, max_output_tokens: 8000 }) }
        : index === 2 && tool
          ? { id: `fc_${index}`, type: 'function_call', call_id: `call_${index}`, name: tool['name'], ...(tool['namespace'] ? { namespace: tool['namespace'] } : {}), arguments: JSON.stringify({ goal: 'Locate fixture evidence', exactSymbols: ['runtimeEvidenceNeedle'] }) }
          : { id: 'msg_final', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture complete', annotations: [] }] };
      const response = { id: `resp_${index}`, object: 'response', created_at: 1, model: 'jev-test-model', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const config = [
      ...isolation,
      'features.plugins=true', 'features.hooks=true',
      'model_provider="jev_test"', 'model="jev-test-model"', 'model_providers.jev_test.name="Local fixture"',
      `model_providers.jev_test.base_url="http://127.0.0.1:${address.port}/v1"`,
      'model_providers.jev_test.wire_api="responses"', 'model_providers.jev_test.requires_openai_auth=false',
      `marketplaces.${market}.source_type="local"`,
      `marketplaces.${market}.source=${JSON.stringify(plugin)}`,
      `plugins.jev-gate@${market}.enabled=true`,
      `plugins.jev-gate@${market}.mcp_servers.jev_runtime_fixture.enabled=true`,
      'shell_environment_policy.inherit="all"',
    ];
    const args = ['--no-daemon', ...(trust ? ['--dangerously-bypass-hook-trust'] : []), 'exec', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--json', '-C', workspace, ...config.flatMap(c => ['-c', c]), 'Run the local fixture tools, then finish.'];
    let output = '';
    const child = spawn('codex', args, { cwd: workspace, env: { HOME: process.env['HOME'] ?? '', CODEX_HOME: runtimeEnv.CODEX_HOME, PATH: `${join(workspace, '.bin')}:${process.env['PATH'] ?? ''}`, JEV_CODEX_AUTO_CONNECT: '0', JEV_CODEX_TRACE_DIR: trace, ...(scenario === 'missing-workspace' ? {} : { JEV_CODEX_WORKSPACE: workspace }), JEV_CODEX_ENABLED: scenario === 'hooks-disabled' ? '0' : '1', JEV_CODEX_OUTPUT: scenario === 'disabled' ? 'off' : 'on', CLAUDE_PROJECT_DIR: '/wrong-workspace', PWD: '/wrong-workspace' } });
    child.stdin.end(); child.stdout.on('data', b => { output += String(b); }); child.stderr.on('data', b => { output += String(b); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 40_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      return { requests, output, code, trace };
    } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };

  it('loads plugin MCP and trusted hooks, folds the actual model-visible result and records both paths', async () => {
    const result = await run(true);
    expect(result.code, result.output).toBe(0);
    expect(result.requests.length, result.output).toBeGreaterThanOrEqual(3);
    expect(functions(result.requests[0]!['tools']).some(t => String(t['name']).endsWith('jev_evidence')), result.output).toBe(true);
    expect(JSON.stringify(result.requests[0])).toContain('Read-only source evidence from the one project this server was configured for');
    const second = JSON.stringify(result.requests[1]!['input']);
    expect(second.includes('100 times in a row'), JSON.stringify({records: existsSync(result.trace) ? readdirSync(result.trace).map(f => JSON.parse(readFileSync(join(result.trace, f), 'utf8'))) : [], errors: result.output.split('\n').filter(l => /hook|ERROR|WARN/i.test(l))})).toBe(true);
    expect(second).toContain('[jev-gate output]');
    const last = JSON.stringify(result.requests.at(-1)!['input']);
    expect(last).toContain('runtimeEvidenceNeedle');
    expect(last).not.toContain('/wrong-workspace');
    const records = readdirSync(result.trace).map(f => JSON.parse(readFileSync(join(result.trace, f), 'utf8')) as Rec);
    expect(records.some(r => r['phase'] === 'evidence_result')).toBe(true);
    expect(records.some(r => r['phase'] === 'codex_output' && r['applied'] === true)).toBe(true);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) expect(records.some(r => r['event'] === event), event).toBe(true);
    const snapshot = loadActivity({ traceDir: result.trace, debugDir: null, env: {}, host: 'codex' });
    expect(snapshot.operations.features.find(f => f.id === 'evidence')?.state).toBe('observed');
    expect(snapshot.operations.features.find(f => f.id === 'admission')?.capability?.mode).toBe('connect');
    expect(JSON.stringify(records)).not.toContain('runtimeEvidenceNeedle');
    expect(JSON.stringify(snapshot)).not.toContain('fixture repeat detail');
  }, 60_000);

  it('honors Codex hook trust: untrusted hooks do not fold or manufacture execution records', async () => {
    const result = await run(false);
    expect(result.code, result.output).toBe(0);
    expect(JSON.stringify(result.requests[1]?.['input'])).not.toContain('100 times in a row');
    const snapshot = loadActivity({ traceDir: result.trace, debugDir: null, env: {}, host: 'codex' });
    expect(snapshot.operations.features.find(f => f.id === 'output')?.count).toBe(0);
    expect(snapshot.operations.features.find(f => f.id === 'workers')?.count).toBe(0);
  }, 60_000);

  it.each(['failed', 'disabled'])('preserves actual model-visible output when %s', async scenario => {
    const result = await run(true, scenario);
    expect(result.code, result.output).toBe(0);
    const input = JSON.stringify(result.requests[1]?.['input']);
    expect(input).not.toContain('[jev-gate output]');
    expect(input.split('fixture repeat detail').length - 1).toBe(100);
    if (scenario === 'failed') expect(input).toContain('Process exited with code 1');
    const snapshot = loadActivity({ traceDir: result.trace, debugDir: null, env: {}, host: 'codex' });
    expect(snapshot.operations.features.find(f => f.id === 'workers')?.count).toBe(0);
    expect(snapshot.operations.feed.some(s => s.lifecycle)).toBe(true);
    expect(snapshot.operations.features.find(f => f.id === 'output')?.count).toBe(scenario === 'disabled' ? 0 : 1);
  }, 60_000);

  it('binds Evidence to the actual native workspace with no environment setting or launcher', async () => {
    const result = await run(true, 'missing-workspace');
    expect(result.code, result.output).toBe(0);
    const last = JSON.stringify(result.requests.at(-1)?.['input']);
    expect(last).not.toContain('unavailable_config');
    expect(last).toContain('export const runtimeEvidenceNeedle');
    expect(last).toContain(workspace);
    expect(last).not.toContain('/wrong-workspace');
    const rows = readdirSync(result.trace).map(f => JSON.parse(readFileSync(join(result.trace, f), 'utf8')) as Rec);
    expect(rows.some(r => r['phase'] === 'evidence_result')).toBe(true);
    expect(rows.find(r => r['phase'] === 'evidence_result')?.['session_id']).toBeTypeOf('string');
  }, 60_000);

  it.each(['recording-unavailable', 'hooks-disabled'])('preserves native output and the separate MCP when %s', async scenario => {
    const result = await run(true, scenario);
    expect(result.code, result.output).toBe(0);
    const input = JSON.stringify(result.requests[1]?.['input']);
    expect(input).not.toContain('[jev-gate output]');
    expect(input.split('fixture repeat detail').length - 1).toBe(100);
    expect(JSON.stringify(result.requests.at(-1)?.['input'])).toContain('runtimeEvidenceNeedle');
    if (scenario === 'recording-unavailable') expect(readFileSync(result.trace, 'utf8')).toBe('not a directory');
    else {
      const rows = readdirSync(result.trace).map(f => JSON.parse(readFileSync(join(result.trace, f), 'utf8')) as Rec);
      expect(rows.some(r => r['phase'] === 'evidence_result')).toBe(true);
      expect(rows.some(r => String(r['phase']).startsWith('codex_'))).toBe(false);
    }
  }, 60_000);

});
