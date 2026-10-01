import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboardSources, startDashboard } from '../src/dashboard.js';
import { ensureDashboard } from '../src/dashboard-launch.js';
import { dashboardStatus, setDashboard } from '../src/dashboard-settings.js';
import { recordingStatus, setRecording } from '../src/recording.js';
import { credentialsDir, readPrivateJson, writePrivateJson } from '../src/credentials.js';
import { openTraceDir } from '../src/trace.js';
import { loadActivity } from '../src/activity.js';
import { DASHBOARD_PAGE } from '../src/dashboard-page.js';
import { createRecorder } from '../mods/router/hooks/recording.ts';
import { runCodexHook } from '../src/codex/hook.js';
const passing = `\n RUN  v5.0.1 /test/project\n\n${'stdout: repeated test detail\n'.repeat(90)} ✓ src/a.test.ts (2 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n   Start at  10:20:30\n   Duration  123ms\n`;

const dirs: string[] = [];const servers: Array<{close:()=>Promise<void>}> = [];
const temp = () => {const path=mkdtempSync(join(tmpdir(),'jev-dashboard-'));dirs.push(path);return path};
const environment=()=>({HOME:temp(),XDG_CONFIG_HOME:temp(),XDG_STATE_HOME:temp()});
afterEach(async()=>{for(const s of servers.splice(0))await s.close().catch(()=>undefined);for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})});
const plugin=(version='0.8.1',host='claude')=>{const root=temp();mkdirSync(join(root,`.${host}-plugin`));writeFileSync(join(root,`.${host}-plugin/plugin.json`),JSON.stringify({version}));mkdirSync(join(root,'dist'));writeFileSync(join(root,'dist',host==='codex'?'cli.mjs':'cli.js'),'');return root};

describe('automatic shared dashboard',()=>{
  it('defaults both preferences on without requiring configuration files',()=>{
    const env=environment();expect(dashboardStatus(env)).toEqual({enabled:true});expect(recordingStatus(env)).toEqual({enabled:true});
    const sources=dashboardSources(env);expect(sources.traceDirs?.map(s=>s.host)).toEqual(['claude','codex']);
    setDashboard(env,false);expect(dashboardStatus(env).enabled).toBe(false);expect(recordingStatus(env).enabled).toBe(true);
    setRecording(env,false);setDashboard(env,true);expect(recordingStatus(env).enabled).toBe(false);expect(dashboardStatus(env).enabled).toBe(true);
  });
  it('reuses one live dashboard across hosts, replaces an older build and never downgrades it',async()=>{
    const env=environment();let launched=0;
    const launch=(_entry:string,token:string)=>{launched++;void startDashboard(dashboardSources(env),0,{token}).then(s=>{servers.push(s);writePrivateJson(join(credentialsDir(env),'dashboard-runtime.json'),{token,version:launched===1?'0.8.1':'0.8.2',url:s.url,pid:process.pid})})};
    expect(await ensureDashboard(plugin(),env,{launch})).toBe(true);expect(launched).toBe(1);
    const first=readPrivateJson(join(credentialsDir(env),'dashboard-runtime.json'));
    expect(await ensureDashboard(plugin('0.8.1','codex'),env,{launch})).toBe(true);expect(launched).toBe(1);
    expect(await ensureDashboard(plugin('0.8.2'),env,{launch})).toBe(true);expect(launched).toBe(2);
    expect(readPrivateJson(join(credentialsDir(env),'dashboard-runtime.json'))?.['token']).not.toBe(first?.['token']);
    expect(await ensureDashboard(plugin(),env,{launch})).toBe(true);expect(launched).toBe(2);
    setDashboard(env,false);expect(await ensureDashboard(plugin(),env,{launch})).toBe(false);expect(launched).toBe(2);
  });
  it('does not double launch when concurrent sessions start',async()=>{
    const env=environment();const root=plugin();let launches=0;
    const launch=(_entry:string,token:string)=>{launches++;void startDashboard(dashboardSources(env),0,{token}).then(s=>{servers.push(s);writePrivateJson(join(credentialsDir(env),'dashboard-runtime.json'),{token,version:'0.8.1',url:s.url,pid:process.pid})})};
    const results=await Promise.all([ensureDashboard(root,env,{launch}),ensureDashboard(root,env,{launch})]);
    expect(results.some(Boolean)).toBe(true);expect(launches).toBe(1);
  });
  it('accepts preference writes only from the same loopback origin and shutdown only from its owner',async()=>{
    const env=environment();const token='a'.repeat(32);const server=await startDashboard(dashboardSources(env),0,{token});servers.push(server);
    const request=(path:string,origin:string)=>fetch(server.url+path,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({enabled:false})});
    expect((await request('api/recording','https://other.invalid')).status).toBe(403);
    expect(recordingStatus(env).enabled).toBe(true);
    expect((await request('api/recording',server.url.slice(0,-1))).status).toBe(200);expect(recordingStatus(env).enabled).toBe(false);
    expect((await request('api/dashboard',server.url.slice(0,-1))).status).toBe(200);expect(dashboardStatus(env).enabled).toBe(false);
    expect((await fetch(server.url+'api/shutdown',{method:'POST'})).status).toBe(403);
    expect((await fetch(server.url)).status).toBe(200);
    expect((await (await fetch(server.url+'favicon.svg')).text())).toContain('<svg');
  });
});

describe('independent recording without --debug',()=>{
  it('does not hold native execution when recording I/O stalls and the host wait API throws', async () => {
    const recorder = createRecorder({ paths: async () => null as never, stat: async () => null as never,
      exists: async () => false, read: async () => '', write: async () => undefined,
      debug: () => undefined, wait: () => { throw new Error('host clock unavailable'); } });
    // A stalled path lookup must remain optional even when the clock refuses the wait.
    const stalled = createRecorder({ paths: () => new Promise(() => undefined), stat: async () => null as never,
      exists: async () => false, read: async () => '', write: async () => undefined,
      debug: () => undefined, wait: () => { throw new Error('host clock unavailable'); } });
    recorder.log('jev-router {"event":"request","sent":true}');
    await recorder.flush();
    stalled.log('jev-router {"event":"request","sent":true}');
    const result = await Promise.race([stalled.flush().then(() => 'released'), new Promise(resolve => setTimeout(() => resolve('blocked'), 200))]);
    expect(result).toBe('released');
  });
  it('the live shared switch stops records while native Output keeps working',async()=>{
    const env=environment();const path=join(env.XDG_STATE_HOME,'traces');const opened=openTraceDir(path,env);if(!opened.ok)throw Error(opened.error);
    expect(opened.writer.write('codex_event',{host:'codex'}).ok).toBe(true);setRecording(env,false);
    expect(opened.writer.write('codex_event',{})).toEqual({ok:false,error:'recording_disabled'});
    async function* stdin(){yield JSON.stringify({hook_event_name:'PostToolUse',session_id:'s',tool_name:'Bash',tool_input:{command:'vitest run'},tool_response:passing})}
    const result=await runCodexHook({env:{...env,JEV_CODEX_TRACE_DIR:path,JEV_CODEX_AUTO_CONNECT:'0'},stdin:stdin()});
    expect(result['stopReason']).toContain('90 times in a row');expect(readdirSync(path)).toHaveLength(1);
    setRecording(env,true);expect(opened.writer.write('codex_event',{}).ok).toBe(true);
  });
  it('records all three Function Mods with the host fs API and applies preference changes live',async()=>{
    const env=environment();const dir=dashboardSources(env).traceDirs![0]!.dir;mkdirSync(dir,{recursive:true,mode:0o700});
    const files=new Map<string,string>();const logs:string[]=[];
    const host={env:{get:async(k:string)=>env[k as keyof typeof env]},session:{id:async()=> 'session'},fs:{stat:async(path:string)=>({kind:path===dir?'dir':'file',isLink:false,size:files.get(path)?.length??0}),exists:async(path:string)=>files.has(path),read:async(path:string)=>files.get(path),write:async(path:string,value:string)=>{files.set(path,value);writeFileSync(path,value)}},ui:{log:(s:string)=>logs.push(s)},clock:{sleep:async()=>new Promise<void>(()=>undefined)}};
    const recorder=createRecorder({paths:async()=>({home:env.HOME,state:env.XDG_STATE_HOME,config:env.XDG_CONFIG_HOME,trace:undefined,session:'session'}),stat:host.fs.stat,exists:host.fs.exists,read:async path=>files.get(path)!,write:host.fs.write,debug:host.ui.log,wait:host.clock.sleep});
    for(const component of ['router','compact','output'])recorder.log(`jev-${component} ${JSON.stringify({event:component,applied:true})}`);
    await recorder.flush();expect(readdirSync(dir)).toHaveLength(3);expect(logs).toHaveLength(3);
    const setting=join(credentialsDir(env),'recording.json');files.set(setting,JSON.stringify({version:1,enabled:false}));
    recorder.log('jev-router {"event":"request","sent":true}');await recorder.flush();expect(readdirSync(dir)).toHaveLength(3);
    files.set(setting,JSON.stringify({version:1,enabled:true}));recorder.log('jev-router {"event":"root_result","observed":"haiku"}');await recorder.flush();expect(readdirSync(dir)).toHaveLength(4);
    expect(readFileSync(join(dir,readdirSync(dir)[0]!),'utf8')).toContain('session_id');
  });
  it('merges both hosts without colliding sessions, debug mirrors or request counts',()=>{
    const env=environment();const sources=dashboardSources(env);for(const source of sources.traceDirs!){mkdirSync(source.dir,{recursive:true});writeFileSync(join(source.dir,'record.json'),JSON.stringify({host:source.host,phase:'admission_result',session_id:'same',prompt_id:'same',request_id:source.host,attempted:true,written_at:new Date().toISOString(),http:{duration_ms:75},decision:{shape:'direct'}}))}
    const claude=sources.traceDirs![0]!.dir;const record={event:'root',turn:'same',sent:true,duration_ms:90,patch:{model:'haiku'}};
    writeFileSync(join(claude,'mod.json'),JSON.stringify({...record,phase:'claude_router',host:'claude',session_id:'same',written_at:new Date().toISOString()}));
    const debug=temp();writeFileSync(join(debug,'mirror.log'),new Date().toISOString()+' [DEBUG] jev-router '+JSON.stringify(record)+'\n');
    const snapshot=loadActivity({...sources,debugDir:debug});expect(snapshot.host).toBe('mixed');
    expect(snapshot.operations.runs.filter(r=>r.source==='gate')).toHaveLength(2);expect(new Set(snapshot.operations.runs.map(r=>r.id)).size).toBe(snapshot.operations.runs.length);
    expect(snapshot.operations.features.find(f=>f.id==='router')?.count).toBe(1);expect(snapshot.operations.latency.measured).toBe(3);
    expect(snapshot.operations.feed.every(s=>s.host==='claude'||s.host==='codex')).toBe(true);
  });
  it('shows model mismatch and missing observations explicitly and matches family aliases',()=>{
    const env=environment();const dir=temp();for(const [index,selected,observed]of [[0,'haiku','claude-haiku-4-5'],[1,'opus','claude-sonnet-5'],[2,'sonnet',null]] as const)writeFileSync(join(dir,`${index}.json`),JSON.stringify({phase:'claude_router',session_id:'s',event:'child_result',turn:String(index),requested:selected,observed,confirmation:index===0?'confirmed':index===1?'mismatch':'unobserved',written_at:new Date().toISOString()}));
    const runs=loadActivity({traceDir:dir,debugDir:null,env}).operations.runs;
    expect(runs.flatMap(r=>r.steps.map(s=>s.model?.status)).sort()).toEqual(['confirmed','mismatch','unobserved']);
    expect(runs.filter(r=>r.state==='attention')).toHaveLength(1);expect(runs.filter(r=>r.state==='unconfirmed')).toHaveLength(1);
  });
  it('ships parseable browser code and a real vector mark, without the boxed letter J',()=>{
    const script=DASHBOARD_PAGE.split('<script>')[1]!.split('</script>')[0]!;expect(()=>new Script(script)).not.toThrow();
    expect(DASHBOARD_PAGE).toContain('<svg');expect(DASHBOARD_PAGE).not.toContain('brand-mark">J</span>');
  });
});
