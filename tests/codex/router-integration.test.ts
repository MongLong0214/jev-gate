import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CodexRpc } from '../../src/codex/rpc.js';
import { CodexPolicy } from '../../src/codex/policy.js';
import type { Obj } from '../../src/codex/source.js';
const dir = mkdtempSync(join(tmpdir(), 'router-integration-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const catalog = [
  { model: 'fixture-A', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
  { model: 'fixture-B', supportedReasoningEfforts: ['low', 'high', 'max'].map(reasoningEffort => ({ reasoningEffort })) },
];
const config = join(dir, 'policy.json');
const saveConfig = (router: Obj = {}) => writeFileSync(config, JSON.stringify({ gate: { mode: 'off' }, router: { timeoutMs: 2000, ...router } }));
const answers = (req: Obj, model: string, effort: string) => Object.fromEntries(Object.entries(req['questions'] as Record<string, {type:string;criteria:Record<string,string>|string[]}>).map(([k,q]) => {
  const pick = k === 'model' ? model : k === 'control' ? 'task_clear' : 'ordinary';
  return [k, q.type === 'choice' ? {type:'choice',choice:pick,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(v=>[v,v===pick?1:0]))} :
    {type:'score',probabilities:Object.fromEntries((q.criteria as string[]).map((v,i)=>[i,v.startsWith(effort === 'max' ? 'Maximum' : effort === 'low' ? 'Light' : 'Strong') ? 1 : 0]))}];
}));
const fixture = async (external: boolean, model: string, effort: string, wait?: Promise<void>) => {
  saveConfig(); const sent: Obj[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)); sent.push(req); if (wait) await wait;
    return new Response(JSON.stringify({ model:req.model, answers:answers(req,model,effort) }), {headers:{'content-type':'application/json'}});
  });
  const rpc = new CodexRpc(new PassThrough(), new PassThrough());
  const forward = vi.spyOn(rpc, 'forward').mockImplementation(() => {});
  const emitted = vi.spyOn(rpc, 'emit').mockImplementation(() => {});
  const policy = new CodexPolicy(rpc, {JEV_CODEX_CONFIG:config,TYPESAFE_API_KEY:'fixture-key',JEV_CODEX_TRACE_DIR:join(dir,'trace'),JEV_GATE_STATE_DIR:join(dir,'state')}, fetchImpl as typeof fetch);
  policy.catalog = catalog; policy.catalogComplete = true;
  if (external) {
    await policy.externalHook({hook_event_name:'SessionStart',session_id:'root',cwd:dir,model:'fixture-A'});
    await policy.externalHook({hook_event_name:'UserPromptSubmit',session_id:'root',turn_id:'prompt',prompt:'Implement the fixture.'});
  } else await rpc.onResponse({model:'fixture-A',reasoningEffort:'high',cwd:dir,thread:{id:'root'}},'thread/start',{});
  const request = {model:'fixture-A',reasoning:{effort:'high',summary:'auto'},input:[{role:'user',content:'Implement the fixture.'}],tools:[{type:'function',name:'original'}],metadata:{original:true}};
  const start = {id:1,method:'turn/start',params:{threadId:'root',clientUserMessageId:'prompt',model:'fixture-A',effort:'high',input:[{type:'text',text:'Implement the fixture.'}],collaborationMode:{mode:'default',settings:{model:'fixture-A',reasoning_effort:'high',developer_instructions:'preserve'}}}};
  return {rpc,policy,forward,emitted,fetchImpl,sent,request,start};
};
describe('original Codex root execution boundaries', () => {
  it('drops a stored target that the live catalog now marks as a previous generation', async () => {
    const f = await fixture(true, 'fixture-B', 'max');
    expect((await f.policy.externalRequest('root', f.request, new AbortController().signal)).request.model).toBe('fixture-B');
    f.policy.catalog = catalog.map(m => m.model === 'fixture-B' ? { ...m, description: 'Previous generation workhorse model.' } : m);
    expect((await f.policy.externalRequest('root', f.request, new AbortController().signal)).request).toEqual(f.request);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it.each([false, true].flatMap(external => ['default', 'echo'].map(mode => [external, mode] as const)))('reassesses three turns in one native root external=%s baseline=%s', async (external, mode) => {
    const f = await fixture(external, 'fixture-B', 'max'); let phase = 0;
    f.fetchImpl.mockImplementation(async (_url, init) => {
      const req = JSON.parse(String(init?.body)); f.sent.push(req);
      const target = phase < 2 ? 'fixture-B' : 'fixture-A';
      const selected = target in req.questions.model.criteria ? target : '__keep__';
      return new Response(JSON.stringify({ model: req.model, answers: answers(req, selected, phase < 2 ? 'max' : 'high') }), { headers: { 'content-type': 'application/json' } });
    });
    for (phase = 0; phase < 3; phase++) {
      const baseline = phase === 0 || mode === 'default' ? 'fixture-A' : 'fixture-B';
      const effort = phase === 0 || mode === 'default' ? 'high' : 'max';
      if (external) {
        await f.policy.externalHook({ hook_event_name: 'UserPromptSubmit', session_id: 'root', turn_id: `turn-${phase}`, prompt: 'Continue the clear fixture.' });
        for (let step = 0; step < 2; step++) {
          const routed = await f.policy.externalRequest('root', { ...f.request, model: baseline, reasoning: { ...f.request.reasoning, effort } }, new AbortController().signal);
          expect(routed.request.model).toBe(phase < 2 ? 'fixture-B' : 'fixture-A');
          expect(routed.request.reasoning).toMatchObject({ effort: phase < 2 ? 'max' : 'high' });
          const binding = f.policy.observeRequest('root', routed.request);
          f.policy.observeUsage('root', { status: 'completed', model: routed.request.model, output: [] }, binding);
        }
      } else {
        await f.policy.client({ ...f.start, id: phase + 1, params: { ...f.start.params, clientUserMessageId: `turn-${phase}`, model: baseline, effort, collaborationMode: { ...f.start.params.collaborationMode, settings: { ...f.start.params.collaborationMode.settings, model: baseline, reasoning_effort: effort } } } });
        expect(f.forward.mock.calls[phase]?.[0]).toMatchObject({ params: { threadId: 'root', model: phase < 2 ? 'fixture-B' : 'fixture-A', effort: phase < 2 ? 'max' : 'high' } });
      }
      expect(f.sent).toHaveLength(phase + 1); expect(f.policy.sessions.size).toBe(1);
    }
    f.rpc.close();
  });
  it('passes real prior response cache counts into the next decision without locking its model', async () => {
    const f = await fixture(true, 'fixture-B', 'max');
    const first = await f.policy.externalRequest('root', f.request, new AbortController().signal);
    const binding = f.policy.observeRequest('root', first.request);
    f.policy.observeUsage('root', { status: 'completed', model: 'fixture-B', output: [], usage: { input_tokens: 42_000, input_tokens_details: { cached_tokens: 40_000, cache_write_tokens: 1000 } } }, binding);
    await f.policy.externalHook({ hook_event_name: 'UserPromptSubmit', session_id: 'root', turn_id: 'new-prompt', prompt: 'Diagnose and fix the next failure.' });
    const second = await f.policy.externalRequest('root', f.request, new AbortController().signal);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]?.['state']).toMatchObject({ execution: { cache: { source: 'provider_response_usage', previous_model: 'fixture-B', input_tokens: 42_000, cache_read_tokens: 40_000, cache_write_tokens: 1000, cross_model_reuse_proven: false, current_fit_proven: false } } });
    expect(second.request.model).toBe('fixture-B'); expect(f.policy.sessions.size).toBe(1); f.rpc.close();
  });
  it.each([false,true].flatMap(external => [['__keep__','high'],['__keep__','low'],['fixture-B','high'],['fixture-B','max']].map(([model,effort])=>[external,model!,effort!] as const)))('same root keep/effort/model/both external=%s %s/%s',async(external,model,effort)=>{
    const f = await fixture(external,model,effort);
    const wantedModel = model === '__keep__' ? 'fixture-A' : model;
    if (external) {
      for (let i=0;i<2;i++) {
        const r = await f.policy.externalRequest('root',f.request,new AbortController().signal);
        expect(r.request).toEqual({...f.request,model:wantedModel,reasoning:{...f.request.reasoning,effort}});
        const binding = f.policy.observeRequest('root',r.request);
        f.policy.observeUsage('root',{status:'completed',model:wantedModel,output:[]},binding);
      }
    } else {
      await f.policy.client(f.start);
      expect(f.forward).toHaveBeenCalledOnce();
      const outbound = f.forward.mock.calls[0]![0];
      expect(outbound).toMatchObject({method:'turn/start',params:{threadId:'root',model:wantedModel,effort,collaborationMode:{settings:{model:wantedModel,reasoning_effort:effort,developer_instructions:'preserve'}}}});
    }
    expect(f.policy.sessions.size).toBe(1); expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it('shares pending assessment across concurrent external requests and keeps manual C',async()=>{
    let release!:()=>void; const wait = new Promise<void>(r=>{release=r;}); const f = await fixture(true,'fixture-B','max',wait);
    const one = f.policy.externalRequest('root',f.request,new AbortController().signal);
    const two = f.policy.externalRequest('root',f.request,new AbortController().signal);
    await vi.waitFor(()=>expect(f.sent).toHaveLength(1)); release();
    expect((await one).request.model).toBe('fixture-B'); expect((await two).request.model).toBe('fixture-B');
    const manual = {...f.request,model:'fixture-C'};
    expect((await f.policy.externalRequest('root',manual,new AbortController().signal)).request).toEqual(manual);
    expect((await f.policy.externalRequest('root',manual,new AbortController().signal)).request).toEqual(manual);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it('does not submit or duplicate a managed turn cancelled during preparation',async()=>{
    let release!:()=>void; const f = await fixture(false,'fixture-B','max',new Promise<void>(r=>{release=r;}));
    const run = f.policy.client(f.start); await vi.waitFor(()=>expect(f.sent).toHaveLength(1));
    await f.policy.client({...f.start,id:2}); expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.forward).not.toHaveBeenCalled();
    await f.policy.client({id:3,method:'turn/interrupt',params:{threadId:'root'}}); release(); await run;
    expect(f.forward.mock.calls.map(c=>c[0].method)).toEqual(['turn/interrupt']);
    expect(f.emitted.mock.calls.map(c=>c[0].id)).toEqual([2,1]); f.rpc.close();
  });
  it('drops unsent choices when loaded config changes, with no second assessment',async()=>{
    let release!:()=>void; const f = await fixture(true,'fixture-B','max',new Promise<void>(r=>{release=r;}));
    const run = f.policy.externalRequest('root',f.request,new AbortController().signal); await vi.waitFor(()=>expect(f.sent).toHaveLength(1));
    saveConfig({enabled:false}); release(); expect((await run).request).toEqual(f.request);
    expect((await f.policy.externalRequest('root',f.request,new AbortController().signal)).request).toEqual(f.request);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it('uses the actual completed reply and recent human constraints identically in both adapters',async()=>{
    const states:unknown[]=[];
    for (const external of [false,true]) {
      const f = await fixture(external,'__keep__','high'); const session=f.policy.sessions.get('root')!;
      session.completedReply='Actual completed answer.';
      if (external) { await f.policy.externalHook({hook_event_name:'UserPromptSubmit',session_id:'root',turn_id:'next',prompt:'Continue that work.'});
        session.recentRequests=['Keep the API unchanged.']; await f.policy.externalRequest('root',{...f.request,input:[{role:'user',content:'Continue that work.'}]},new AbortController().signal);
      } else { session.items=[{type:'userMessage',content:[{type:'text',text:'Keep the API unchanged.'}]}]; await f.policy.client({...f.start,params:{...f.start.params,input:[{type:'text',text:'Continue that work.'}]}}); }
      states.push(f.sent[0]!.state); f.rpc.close();
    }
    expect(states[0]).toEqual(states[1]); expect(states[0]).toMatchObject({task:{text:'Continue that work.',previous_reply:'Actual completed answer.',recent_requests:[{text:'Keep the API unchanged.'}]}});
  });
});

describe('catalog refresh and native pair fields',()=>{
  it('retains partial paginated metadata and excludes only conflicting or malformed entries',async()=>{
    const f=await fixture(false,'__keep__','high');
    const sixth={model:'fixture-F',description:'sixth coding model',supportedReasoningEfforts:[{reasoningEffort:'max',description:'highest'}],capabilities:{coding:true}};
    const listed=[...catalog,...['C','D','E'].map(n=>({...catalog[0]!,model:`fixture-${n}`})),sixth];
    const pages=[{data:listed,nextCursor:'next'},{data:[{...catalog[0]!,supportedReasoningEfforts:[{reasoningEffort:'low'}]},{model:'broken',supportedReasoningEfforts:null},{...sixth,model:'specialist',hidden:true}],nextCursor:'bad'}];
    const request=vi.spyOn(f.rpc,'request').mockImplementation(async()=>{const page=pages.shift();if(!page)throw new Error('pagination failed');return page;});
    await f.policy.initialize();
    expect(request).toHaveBeenCalledTimes(3); expect(f.policy.catalogComplete).toBe(false);
    expect(f.policy.catalog.map(m=>m.model)).toEqual(['fixture-B','fixture-C','fixture-D','fixture-E','fixture-F','specialist']);
    expect(f.policy.catalog.find(m=>m.model==='fixture-F')).toEqual(sixth);
    expect(f.policy.catalogExcluded).toMatchObject({duplicate_conflict:1,malformed:1}); f.rpc.close();
  });
  it('invalidates stale unsent catalog choices without replaying an assessment',async()=>{
    let release!:()=>void; const f=await fixture(true,'fixture-B','max',new Promise<void>(r=>{release=r;}));
    const run=f.policy.externalRequest('root',f.request,new AbortController().signal);await vi.waitFor(()=>expect(f.sent).toHaveLength(1));
    vi.spyOn(f.rpc,'request').mockResolvedValue({data:[catalog[0]],nextCursor:null}); await f.policy.initialize(); release();
    expect((await run).request).toEqual(f.request);expect((await f.policy.externalRequest('root',f.request,new AbortController().signal)).request).toEqual(f.request);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it.each(['none','omit'] as const)('applies %s without deleting other reasoning fields',async(kind)=>{
    const f=await fixture(true,'fixture-B','max');f.policy.catalog=[catalog[0]!,{model:'fixture-B',supportedReasoningEfforts:kind==='none'?[{reasoningEffort:'none'}]:[]}];
    const r=await f.policy.externalRequest('root',f.request,new AbortController().signal);
    expect(r.request).toEqual({...f.request,model:'fixture-B',reasoning:kind==='none'?{effort:'none',summary:'auto'}:{summary:'auto'}});f.rpc.close();
  });
  it.each([['model',false,'__keep__','low','fixture-A','low'],['effort',false,'fixture-B','max','fixture-B','high']] as const)('keeps the %s dimension independent at the original root',async(dimension,value,selected,scored,model,effort)=>{
    const f=await fixture(true,selected,scored);saveConfig({[dimension]:value});
    const r=await f.policy.externalRequest('root',f.request,new AbortController().signal);
    expect(r.request).toEqual({...f.request,model,reasoning:{...f.request.reasoning,effort}});expect(f.policy.sessions.size).toBe(1);f.rpc.close();
  });
});

it('a confirmed manual settings change during managed assessment wins in both native fields',async()=>{
  let release!:()=>void; const f=await fixture(false,'fixture-B','max',new Promise<void>(r=>{release=r;}));
  const run=f.policy.client(f.start);await vi.waitFor(()=>expect(f.sent).toHaveLength(1));
  await f.rpc.onResponse({},'thread/settings/update',{threadId:'root',model:'fixture-C',effort:'low'});release();await run;
  expect(f.forward).toHaveBeenCalledOnce();expect(f.forward.mock.calls[0]![0]).toMatchObject({params:{model:'fixture-C',effort:'low',collaborationMode:{settings:{model:'fixture-C',reasoning_effort:'low'}}}});
  expect(f.fetchImpl).toHaveBeenCalledOnce();f.rpc.close();
});
