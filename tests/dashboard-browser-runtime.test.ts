import { createServer, type ServerResponse } from 'node:http';
import type { Window } from 'happy-dom';
// Browser globals are typed locally; adding lib.dom globally would change the Node HTTP tests.
declare const document: Window['document'];
declare const requestAnimationFrame: Window['requestAnimationFrame'];
declare const getComputedStyle: Window['getComputedStyle'] & ((node: unknown, pseudo: string) => ReturnType<Window['getComputedStyle']>);
declare const MutationObserver: Window['MutationObserver'];
declare const innerWidth: number;
declare const location: { hash: string };
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { diffFrame, type FrameMemo, type FrameSnapshot } from '../src/dashboard-patch.js';
import { DASHBOARD_PAGE } from '../src/dashboard-page.js';
import { dashboardSources, startDashboard } from '../src/dashboard.js';
import { buildOperations, type JevReceipt, type OperationRun, type OperationStep } from '../src/operations.js';
import { reportedSingleVerdict } from '../src/plan.js';
import { refusalReason } from '../src/verify.js';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const step = (id: string, feature: OperationStep['feature'], extra: Partial<OperationStep> = {}): OperationStep => ({ id, feature, lane: 'jev', at: ago(0), state: 'done', title: `${feature} recorded result`, summary: 'Recorded result', details: [], ...extra });
const receipt = (extra: Partial<JevReceipt> = {}): JevReceipt => ({ status: 200, code: null, model: 'claude-haiku-4-5', input: 1200, output: 40, costUsd: 0.0012, choice: null, confidence: 0.87, threshold: null, direction: null, ...extra });
// One measured Jev response with its receipt; the page shows it as one call everywhere.
const call = (id: string, feature: OperationStep['feature'], durationMs: number, extra: Partial<OperationStep> = {}, rc: Partial<JevReceipt> = {}): OperationStep => step(id, feature, { durationMs, receipt: receipt(rc), ...extra });
const run = (id: string, host: 'claude' | 'codex', steps: OperationStep[], extra: Partial<OperationRun> = {}): OperationRun => ({ id, host, title: `${host} execution ${id}`, source: 'gate', mode: 'auto', firstAt: steps[0]?.at ?? ago(0), lastAt: steps.at(-1)?.at ?? ago(0), state: 'done', steps, ...extra });
// As the dashboard server sends it: in the page and in every snapshot.
const VERSION = { running: '0.8.32', installed: '0.8.32', release: { latest: '0.8.32' } };
function snapshot(runs: OperationRun[]) {
  const feed = runs.flatMap(r => r.steps.map(s => ({ ...s, host: r.host ?? 'claude', runId: r.id, runTitle: r.title }))).sort((a,b) => b.at.localeCompare(a.at));
  const ids = ['admission','allocation','workers','router','compact'] as const;
  const measured = feed.filter(s => s.lane==='jev' && s.durationMs!==undefined), values = measured.map(s => s.durationMs!).sort((a,b) => a-b), pct = (p: number) => values.length ? values[Math.ceil(values.length*p)-1]! : null;
  const today: Record<string, { calls: number; input: number; costUsd: number; unpriced: number }> = {};
  for (const s of measured) { const t = today[s.host] ??= { calls:0, input:0, costUsd:0, unpriced:0 }; t.calls++; t.input += s.receipt?.input ?? 0; if (s.receipt?.costUsd != null) t.costUsd += s.receipt.costUsd; else t.unpriced++; }
  return { at:ago(0), host:'mixed', unreadable:0, version:VERSION, recording:{enabled:true}, dashboard:{enabled:true}, operations:{runs,feed,active:runs.filter(r=>r.state==='active').length,attention:runs.filter(r=>r.state==='attention').length,requests:measured.length,
    features:ids.map(id=>({id,label:id,source:'trace',count:feed.filter(s=>!s.lifecycle&&s.feature===id).length,lastAt:feed.find(s=>!s.lifecycle&&s.feature===id)?.at??null,state:feed.some(s=>!s.lifecycle&&s.feature===id)?'observed':'waiting'})),
    latency:{measured:values.length,p50:pct(.5),p95:pct(.95),fastest:values[0]??null,latest:measured[0]?.durationMs??null,recent:measured.map(s=>({at:s.at,ms:s.durationMs!})).reverse(),today}} };
}
// Layout shifts not caused by input, with the moved nodes, from the moment this runs (buffered from navigation in an init script).
const observeShifts = () => {type Shift={value:number;hadRecentInput:boolean;sources:Array<{node:{nodeName:string;id?:string;className?:unknown}|null;previousRect:unknown;currentRect:unknown}>};
  const g=globalThis as unknown as {shifts:string[];PerformanceObserver:new(cb:(l:{getEntries():Shift[]})=>void)=>{observe(o:{type:string;buffered:boolean}):void}};g.shifts=[];
  new g.PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)g.shifts.push(e.value.toFixed(4)+' '+e.sources.map(s=>s.node?s.node.nodeName+(s.node.id?'#'+s.node.id:'')+(typeof s.node.className==='string'&&s.node.className?'.'+s.node.className:'')+' '+JSON.stringify([s.previousRect,s.currentRect]):'?').join(', '));}).observe({type:'layout-shift',buffered:true});};

// Actual browser, native EventSource and disposable HTTP server. No user browser, credentials or paid requests.
describe.skipIf(process.env['JEV_DASHBOARD_BROWSER_E2E'] !== '1')('dashboard Chromium runtime', () => {
  let browser: Browser; let url: string; let current: ReturnType<typeof snapshot> & { credit?: { exhausted: boolean }; frame?: string } = snapshot([]);let memo:FrameMemo|null=null, frameId=0; const clients = new Set<ServerResponse>();
  const output = process.env['JEV_DASHBOARD_QA_DIR'] ?? join(tmpdir(), 'jev-dashboard-browser-qa');
  const errors: string[] = [];
  const server = createServer((req,res) => {
    if(req.url?.split('?')[0]==='/api/live'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(`data: ${JSON.stringify(current)}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;}
    if(req.method==='POST'){res.writeHead(503);res.end('{}');return;}
    res.writeHead(200,{'content-type':'text/html'});res.end(DASHBOARD_PAGE.replace('/*JEV_VERSION*/null',JSON.stringify(VERSION)));
  });
  const push = (runs: OperationRun[], extra: { credit?: { exhausted: boolean }; version?: typeof VERSION } = {}) => {const next={...snapshot(runs),...extra};memo=diffFrame(null,next as unknown as FrameSnapshot,()=>String(++frameId)).memo;current={...next,frame:memo.key};for(const res of clients)res.write(`data: ${JSON.stringify(current)}\n\n`);};
  const patch = (runs:OperationRun[])=>{const next=snapshot(runs),base=memo!.key,out=diffFrame(memo,next as unknown as FrameSnapshot,()=>String(++frameId));memo=out.memo;current={...next,frame:memo.key};expect(out.patch).not.toBeNull();for(const res of clients)res.write(`event: patch\ndata: ${JSON.stringify({base,frame:memo.key,p:JSON.parse(out.patch!)})}\n\n`);};
  const page = async (width=1440,height=900) => {const p=await browser.newPage({viewport:{width,height}});p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.waitForSelector('#stages button.st');return p;};
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  beforeAll(async()=>{mkdirSync(output,{recursive:true});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const local='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';browser=await chromium.launch({headless:true,...(process.env['JEV_CHROMIUM_PATH']?{executablePath:process.env['JEV_CHROMIUM_PATH']}:existsSync(local)?{executablePath:local}:{} )});});
  afterAll(async()=>{const closed=new Promise<void>(r=>server.close(()=>r()));for(const res of clients)res.end();server.closeAllConnections();try{await browser?.close();}finally{await closed;}expect(errors).toEqual([]);}, 30_000);
  const settle = (p: Page) => p.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
  // The trace is its own view at #run=<id>; null returns to the overview.
  const go = async (p: Page, id: string | null) => {await p.evaluate(id=>{location.hash=id?'#run='+encodeURIComponent(id):''},id);await p.waitForFunction(on=>(document.getElementById('trace-view') as unknown as {hidden:boolean}).hidden===!on,!!id);await settle(p);};
  const stage = (p: Page, id: string) => p.locator(`#stages [data-feature=${id}]`);
  const shifts = (p: Page) => p.evaluate(() => (globalThis as unknown as {shifts:string[]}).shifts);
  const running = (p: Page, scope = '#stages,#rc,#dots,#j-wire,#basis,#runs') => p.evaluate(scope => [...document.querySelectorAll(scope)].flatMap(e=>(e as unknown as {getAnimations(o:{subtree:boolean}):Array<{playState:string;animationName?:string;transitionProperty?:string;effect:{target:{className:unknown}|null}}>}).getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>(a.animationName||a.transitionProperty)+' '+String(a.effect.target?.className))), scope);
  // Every user-reported layout defect in one pass: page overflow, content that leaves the viewport unclipped, sideways
  // scrollers, text wrapping about one character per line, accent bars on selected items and empty or untitled run rows.
  const problems = (p: Page) => p.evaluate(() => {
    const out: string[] = [], d = document.documentElement;if(d.scrollWidth>innerWidth)out.push('document overflow');
    const probe=document.createElement('i');probe.style.color='var(--accent)';document.body.appendChild(probe);const accent=getComputedStyle(probe).color;probe.remove();
    const style=getComputedStyle as unknown as (node: unknown, pseudo?: string) => {boxShadow:string;borderLeftWidth:string;borderLeftColor:string;borderRightColor:string;overflowX:string};
    const name=(e:{id:string;className:unknown;tagName:string})=>e.id||String(e.className)||e.tagName;
    for(const e of document.querySelectorAll('body *')){
      for(const pseudo of [undefined,'::before','::after']){const s=style(e,pseudo);if(s.boxShadow.includes('inset'))out.push('inset shadow on '+e.className);if(parseFloat(s.borderLeftWidth)>0&&s.borderLeftColor===accent&&s.borderRightColor!==accent)out.push('accent left border on '+e.className);}
      if(e.closest('[hidden]'))continue;const box=e as unknown as {scrollWidth:number;clientWidth:number};if(/auto|scroll/.test(style(e).overflowX)&&box.scrollWidth>box.clientWidth+1)out.push('horizontal scroller '+name(e)+' '+box.scrollWidth+'/'+box.clientWidth);
      const r=e.getBoundingClientRect();if(!r.width||r.right<=d.clientWidth+1)continue;let a=e.parentElement,clipped=false;while(a&&a!==document.body){if(style(a).overflowX!=='visible'){clipped=true;break;}a=a.parentElement;}if(!clipped)out.push('offscreen '+name(e)+' '+Math.round(r.right));}
    const walk=document.createTreeWalker(document.body,4);for(let n=walk.nextNode();n;n=walk.nextNode()){const text=(n.textContent||'').replace(/\s/g,'');if(text.length<2)continue;const range=document.createRange();range.selectNodeContents(n);
      const lines=new Set([...(range as unknown as {getClientRects():Array<{top:number;width:number}>}).getClientRects()].filter(r=>r.width>0).map(r=>Math.round(r.top))).size;if(lines>1&&lines>=text.length/2)out.push('character wrap: '+text);}
    for(const li of document.querySelectorAll('#runs li'))if(!li.textContent?.trim())out.push('empty run item');
    for(const a of document.querySelectorAll('#runs .row'))if(!a.querySelector('.nm')?.textContent?.trim())out.push('run row without a title');
    return out;
  });
  // Records motion as it happens: stage and feature-row flashes, fresh dots and their stems, round-trip packets with the
  // duration they replay, and new call-log rows, each with its page time.
  const record = (p: Page) => p.evaluate(() => {const log:Array<[string,number]>=[];(globalThis as unknown as {motion:typeof log}).motion=log;
    type Node={classList?:{contains(c:string):boolean};dataset?:{feature?:string};style?:{getPropertyValue(n:string):string};tagName?:string};
    new MutationObserver(list=>{const t=performance.now();for(const m of list){const target=m.target as unknown as Node;
      if(m.type==='attributes'){const old=String(m.oldValue).split(' ');for(const c of ['hit','fresh'])if(target.classList?.contains(c)&&!old.includes(c))log.push([c==='hit'&&target.dataset?.feature?'hit:'+target.dataset.feature:c,t]);continue;}
      for(const n of m.addedNodes as unknown as Node[]){if(n.classList?.contains('lane'))log.push(['lane',t],['lat:'+n.style!.getPropertyValue('--d'),t]);if(n.classList?.contains('stem'))log.push(['stem',t]);if(n.tagName==='LI'&&n.classList?.contains('in'))log.push(['row',t]);}}})
      .observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class'],attributeOldValue:true});});
  const motion = (p: Page) => p.evaluate(() => (globalThis as unknown as {motion:Array<[string,number]>}).motion);
  const count = (log: Array<[string,number]>, kind: string) => log.filter(([k]) => k===kind).length;

  it('shows doctor failures and host-specific Compact facts from the actual snapshot API (#297-299, #319)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-dashboard-activity-'));
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), JEV_GATE_TRACE_DIR: join(home, 'claude'), JEV_CODEX_TRACE_DIR: join(home, 'codex') };
    for (const host of ['claude', 'codex'] as const) {
      const dir = join(home, host); mkdirSync(dir, { recursive: true });
      const base = { host, session_id: 'synthetic-activity', written_at: ago(1000) };
      const records = [
        { ...base, phase: 'dispatch', role: 'single_worker', tool_use_id: 'failed' },
        { ...base, phase: 'failure', tool_use_id: 'failed', subagent_type: 'jev-gate:worker-fast', verdict_reason: 'worker_failed', not_executed: false },
        { ...base, phase: 'background_terminal', tool_use_id: 'failed', status: 'failed' },
        { ...base, phase: 'post', tool_use_id: 'readonly', subagent_type: 'jev-gate:worker-fast', verdict: 'accept', changed_files_count: 0, reported_checks: { pass: 0, fail: 0, not_run: 0 } },
        host === 'claude' ? { ...base, phase: 'mod_router', event: 'root_result', requested: 'claude-sonnet-5-5', observed: 'claude-opus-5-5' }
          : { ...base, phase: 'codex_router_response', selected_model: 'gpt-6-luna', observed_model: 'gpt-6.1-sol' },
        ...(host === 'claude' ? [
          { ...base, phase: 'mod_compact', run_id: 'compact-example', stage: 'started' },
          { ...base, phase: 'mod_compact', run_id: 'compact-example', stage: 'completed', applied: true, budget: 8000, digestChars: 400, tailChars: 800 },
        ] : [
          { ...base, phase: 'codex_compact', stage: 'selection_result', reason: 'assessed' },
          { ...base, phase: 'codex_compact', stage: 'selection_result', reason: 'timeout' },
          { ...base, phase: 'codex_compact', stage: 'submitted', applied: true },
          { ...base, phase: 'codex_compact', stage: 'submitted', applied: true },
          { ...base, phase: 'codex_compact', stage: 'result', applied: true, outcome: 'completed' },
          { ...base, phase: 'codex_compact', stage: 'result', applied: true, outcome: 'failed' },
        ]),
      ];
      records.forEach((r, i) => writeFileSync(join(dir, i + '.json'), JSON.stringify(r)));
    }
    const releaseFetch = (async () => new Response(JSON.stringify({ tag_name: 'v0.8.32', draft: false, prerelease: false }))) as typeof fetch;
    const local = await startDashboard(dashboardSources(env), 0, { releaseFetch });
    const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await p.goto(local.url);
      const response = await p.request.get(new URL('/api/snapshot', local.url).href);
      expect(response.status()).toBe(200);
      const data = await response.json();
      for (const host of ['all', 'claude', 'codex']) {
        expect(data.activity24h[host].find((c: { feature: string }) => c.feature === 'router')).toMatchObject({ level: 'fail' });
        expect(data.activity24h[host].find((c: { feature: string }) => c.feature === 'workers')).toMatchObject({ level: 'warn', metrics: { failed: host === 'all' ? 2 : 1, accepted: host === 'all' ? 2 : 1 } });
      }
      expect(data.activity24h.codex.find((c: { feature: string }) => c.feature === 'compact').metrics).toMatchObject({ codexAssessed: 1, codexSubmitted: 2, codexCompleted: 1 });
      // Doctor's 24h facts sit in each stage row: counts in its columns, the full check in its title.
      await expect.poll(() => stage(p, 'router').getAttribute('title')).toContain('24h 오류');
      expect(await stage(p, 'workers').getAttribute('title')).toContain('실행 실패 2');
      const compact = stage(p, 'compact');
      expect(await compact.locator('.v').allTextContents()).toEqual(['3', '3', '2']);expect(await compact.locator('.v.r').getAttribute('class')).toContain('er');
      for (const fact of ['발화 3 · 적용 3 · 회귀 2', 'Claude 복원 0 · 예산 1,200 / 8,000', 'Codex Jev 판정 1 · 전송 적용 2 · 응답 완료 1']) expect(await compact.getAttribute('title')).toContain(fact);
      await p.locator('[data-host=codex]').click();
      for (const width of [320, 1440]) {
        await p.setViewportSize({ width, height: 1000 }); await settle(p);
        const title = await compact.getAttribute('title');
        expect(title).toContain('Jev 판정 1 · 전송 적용 2 · 응답 완료 1 · 총 토큰 효과 미측정');
        expect(title).not.toMatch(/복원|예산/);
        expect(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        await p.screenshot({ path: join(output, `compact-facts-${width}.png`), fullPage: true });
      }
    } finally { await p.close(); await local.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it('renders empty and long mixed-host data in 32 viewport/theme/language states of both views without overflow, sideways scrolling, character wrapping or accent bars',async()=>{
    const long='long '.repeat(60);
    push([run('c','claude',[call('a','admission',63,{executionPath:'direct'}),call('b','allocation',88,{},{choice:'claude-sonnet-5'}),step('w','workers',{lane:'host',summary:long,model:{selected:'claude-opus-5-5',observed:'claude-sonnet-5',status:'mismatch',selectedEffort:null,observedEffort:null}}),call('r','router',91,{},{choice:'sonnet · medium',threshold:0.6,direction:'downgrade'})],{title:'Claude '+long,state:'active'}),
      run('x','codex',[call('xr','router',140,{},{choice:'gpt-6.1-sol · minimal'}),step('g','workers',{lane:'policy',summary:'허용'}),call('e','allocation',70,{summary:'<img src=x onerror="alert(1)">'},{status:402,code:'payment_required',costUsd:null}),call('k','compact',220)],{title:'Codex '+long,state:'attention'}),
      run('u','claude',[call('ur','router',80)],{title:'Router 실행',state:'unconfirmed'})]);
    const failures:string[]=[];
    // 720 × 450 is the CSS viewport of a 1440 × 900 window at 200% zoom.
    for(const [width,height] of [[1920,1080],[1440,900],[1280,800],[1024,768],[768,1024],[720,450],[390,844],[320,740]] as const){
      const p=await page(width,height);
      for(const theme of ['dark','light'])for(const lang of ['ko','en']){
        await p.evaluate(theme=>{document.documentElement.dataset.theme=theme},theme);if(await p.locator('html').getAttribute('lang')!==lang)await p.locator('#language').click();
        for(const view of ['c',null]){
          await go(p,view);await p.waitForTimeout(300);const found=await problems(p);if(found.length)failures.push(`${width} ${theme} ${lang} ${view?'trace':'overview'}: ${found.join(' | ')}`);
          await p.screenshot({path:join(output,`${width}-${theme}-${lang}${view?'-trace':''}.png`),fullPage:true});
        }
      }
      expect(await p.locator('img').count()).toBe(0);await p.close();
    }
    expect(failures).toEqual([]);
    push([]);const p=await page();expect(await p.locator('#stages button.st').count()).toBe(5);expect(await p.locator('#basis-verdict').textContent()).toBe('–');expect(await p.locator('#j-last').textContent()).toBe('–');
    expect(await p.locator('#runs li').allTextContents()).toEqual(['조건에 맞는 실행이 없습니다.']);expect(await p.locator('#rc li').count()).toBe(8);expect(await p.locator('#basis-q li').count()).toBe(6);expect(await problems(p)).toEqual([]);await p.close();
  },240_000);

  it('preserves a short visible run list on prepend, lets scrolling to the top expose the newest run and opens a run from its row (#338)',async()=>{
    const old=run('old','codex',[call('old-r','router',91)],{title:'Existing run'});push([old]);const p=await page();await p.locator('#runs').scrollIntoViewIfNeeded();await settle(p);
    const row=p.locator('#runs [data-run=old]'),before=await row.boundingBox();
    const newer=run('new','claude',[call('new-r','router',61)],{title:'Newest run'});push([newer,old]);await settle(p);
    expect(await row.boundingBox()).toEqual(before);expect(await p.locator('#runs .row').first().getAttribute('data-run')).toBe('new');
    expect(await p.locator('#runs').evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
    await p.locator('#runs').evaluate(e=>{e.scrollTop=0});await settle(p);
    const first=await p.locator('#runs .row').first().boundingBox(),list=await p.locator('#runs').boundingBox();expect(first!.y).toBe(list!.y);
    expect(await p.locator('#runs').evaluate(e=>e.style.paddingBottom)).toBe('');push([newer,old]);await settle(p);expect(await p.locator('#runs').evaluate(e=>({top:e.scrollTop,padding:e.style.paddingBottom}))).toEqual({top:0,padding:''});
    await p.locator('#runs .row').first().click();await p.waitForFunction(()=>location.hash==='#run=new');await settle(p);
    expect(await p.locator('#overview').isVisible()).toBe(false);expect(await p.locator('#rd-name').textContent()).toBe('Newest run');expect(await p.locator('#crumb-run').textContent()).toBe('Newest run');
    await p.locator('#crumb a').click();await p.waitForFunction(()=>!(document.getElementById('overview') as unknown as {hidden:boolean}).hidden);expect(await p.locator('#trace-view').isVisible()).toBe(false);await p.close();
  });

  it('resets run-list scope filters without restoring an unrelated anchor (#338)',async()=>{
    const history=Array.from({length:12},(_,i)=>run('scope-'+i,i%2?'codex':'claude',[call('scope-r-'+i,'router',91),call('scope-a-'+i,'admission',71)],{title:'Scope '+i,state:i%2?'active':'done'}));push(history);const p=await page();
    const check=async(action:()=>Promise<unknown>)=>{await p.locator('#runs').evaluate(e=>{e.scrollTop=180});await action();await settle(p);expect(await p.locator('#runs').evaluate(e=>({top:e.scrollTop,padding:e.style.paddingBottom}))).toEqual({top:0,padding:''});};
    await check(()=>p.locator('[data-state=active]').click());await check(()=>p.locator('[data-state=all]').click());
    await check(()=>p.locator('[data-host=codex]').click());await check(()=>p.locator('[data-host=all]').click());await p.close();
  });

  it('keeps already-read rows above the reading anchor until returning to the latest order (#338)',async()=>{
    const a=run('a','claude',[call('a-r','router',91)],{title:'Reading anchor',state:'active'}),b=run('b','codex',[call('b-r','router',71)]),n=run('n','claude',[call('n-r','admission',61)],{title:'Newly introduced run',state:'active'});
    push([a,b]);const p=await page(1440,900);await p.locator('#runs').scrollIntoViewIfNeeded();await settle(p);
    await p.evaluate(observeShifts);await wait(1100);await p.evaluate(()=>{(globalThis as unknown as {shifts:string[]}).shifts.length=0});
    const anchor=p.locator('#runs [data-run=a]'),before=await anchor.boundingBox();push([n,a,b]);await settle(p);const top=await p.locator('#runs').evaluate(e=>e.scrollTop);
    expect(top).toBeGreaterThan(0);expect(await anchor.boundingBox()).toEqual(before);
    push([a,n,b]);await settle(p);expect(await anchor.boundingBox()).toEqual(before);expect(await p.locator('#runs').evaluate(e=>e.scrollTop)).toBe(top);
    expect(await shifts(p)).toEqual([]);
    expect(await p.locator('#runs .row').evaluateAll(es=>es.map(e=>e.getAttribute('data-run')))).toEqual(['n','a','b']);
    await p.locator('#runs').evaluate(e=>{e.scrollTop=0});await p.waitForFunction(()=>document.querySelector('#runs .row')?.getAttribute('data-run')==='a');
    expect(await p.locator('#runs').evaluate(e=>({top:e.scrollTop,padding:e.style.paddingBottom}))).toEqual({top:0,padding:''});
    push([a,n,b]);await settle(p);expect(await p.locator('#runs .row').first().getAttribute('data-run')).toBe('a');await p.close();
  });

  it('keeps text at AA contrast in both themes and exposes focus, reduced-motion and paused states', async () => {
    push([run('access','claude',[call('access-a','admission',80,{executionPath:'direct',at:ago(3000)}),call('access-r','router',90,{at:ago(2000)},{choice:'sonnet · high',threshold:0.6}),call('access-e','allocation',70,{state:'error',at:ago(1000)},{status:402,code:'payment_required'}),call('access-w','compact',1200,{at:ago(500)},{status:429,code:'rate_limited'}),step('access-pending','router',{state:'active'})],{state:'attention'})]);
    Object.assign(current,{activity24h:{all:[{feature:'router',level:'fail',metrics:{fired:3,applied:2,regression:1,effect:null}}],claude:[],codex:[]}});
    const p=await page();
    for(const theme of ['dark','light']){
      await p.evaluate(theme=>{document.documentElement.dataset.theme=theme},theme);await p.emulateMedia({reducedMotion:'reduce'});await settle(p);
      for(const highlighted of [false,true]){
        const ratios=await p.evaluate(highlighted=>{
          for(const n of document.querySelectorAll('#stages button.st'))n.classList.toggle('hit',highlighted);document.querySelector('#rc .cr')!.classList.toggle('on',highlighted);
          const rgb=(v:string)=>v.match(/[\d.]+/g)!.slice(0,3).map(n=>Number(n)*(v.startsWith('color(srgb')?255:1)),lum=(v:string)=>rgb(v).reduce((sum,c,i)=>{c/=255;return sum+[.2126,.7152,.0722][i]!*(c<=.04045?c/12.92:((c+.055)/1.055)**2.4)},0);
          return [...document.querySelectorAll('.kl,.kn,.kn small,.ks,.ph h2,.ph .desc,#t-rate,.seg button,.yt span,.ax span,.mini>span,.p50l span,.rl span,.rl b,#j-last,#j-last-u,.nd,.tc,.wl span,.ft>span,.st.h span,#stages :is(.sn b,.sn .cap,.sn .d,.v),#rc :is(.t,.f,.v b,.v i,.ms,.tk),#basis-meta,#basis-verdict,#basis-code,.bq :is(.k,.a,.p),#basis-peers,#basis-trace,#runs :is(.nm,.h,.ago,.du,.sub),.rt button,.tabs button,.chk,#connection,.tb,.home,.ver')]
            .filter(e=>e.getClientRects().length&&e.textContent?.trim()&&getComputedStyle(e).visibility!=='hidden').map(e=>{
              let parent=e;while(getComputedStyle(parent).backgroundColor==='rgba(0, 0, 0, 0)'&&parent.parentElement)parent=parent.parentElement;
              const a=lum(getComputedStyle(e).color),b=lum(getComputedStyle(parent).backgroundColor);return {text:e.className+' '+e.textContent,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
            });
        },highlighted);
        expect(ratios.length).toBeGreaterThan(60);for(const item of ratios)expect.soft(item.ratio,theme+' '+highlighted+' '+item.text).toBeGreaterThanOrEqual(4.5);
      }
      await p.evaluate(()=>{for(const n of document.querySelectorAll('.hit,.cr.on'))n.classList.remove('hit','on')});
      for(const target of [stage(p,'router'),p.locator('#rc button').first(),p.locator('#runs .row').first()]){
        await target.focus();await p.keyboard.press('Shift+Tab');await p.keyboard.press('Tab');
        expect(await target.evaluate(e=>e.matches(':focus-visible')),await target.evaluate(e=>e.outerHTML.slice(0,120)+' active: '+document.activeElement?.outerHTML.slice(0,120))).toBe(true);expect(await target.evaluate(e=>getComputedStyle(e).outlineWidth)).toBe('2px');
      }
      expect(await p.locator('.live-btn i').evaluate(e=>getComputedStyle(e).animationName)).toBe('none');
      await p.emulateMedia({reducedMotion:'no-preference'});expect(await p.locator('.live-btn i').evaluate(e=>getComputedStyle(e).animationName)).toBe('blink');
      await p.locator('#pause').click();await wait(800);expect(await p.evaluate(()=>(document as unknown as {getAnimations():Array<{playState:string}>}).getAnimations().filter(a=>a.playState==='running').length)).toBe(0);await p.locator('#pause').click();
    }
    await p.close();
  });

  it('reads complete values and responds to actual patches within 100ms with no idle or layout motion (#330)',async()=>{
    const measurements:unknown[]=[];
    for(const [width,height]of [[1440,900],[1280,720],[390,844]]){
      const initial=call('initial','router',91,{at:ago(5000),summary:'이전 모델 기록 · legacy_model',details:['loaded hook version 0.8.33 · 0123456789abcdef'],routing:{scope:'root',baseline:'gpt-6.1-sol',modelReason:'fable_disabled_by_config',effortReason:'selected'}},{choice:'gpt-6-luna · low'});
      const rs=[run('patch','codex',[initial])];push(rs);
      const p=await browser.newPage({viewport:{width:width!,height:height!}});p.on('pageerror',e=>errors.push(e.message));
      await p.addInitScript(observeShifts);
      await p.addInitScript(()=>{
        type EventStream={addEventListener(name:string,cb:()=>void):void};
        const g=globalThis as unknown as {EventSource:new(url:string)=>EventStream;patchAt:number;opens:number;reactions:Record<string,number>};
        g.patchAt=0;g.opens=0;g.reactions={};
        const Native=g.EventSource;g.EventSource=class extends Native{constructor(url:string){super(url);this.addEventListener('open',()=>g.opens++);this.addEventListener('patch',()=>{g.patchAt=performance.now()})}};
        const seen=(kind:string)=>{if(g.patchAt&&g.reactions[kind]===undefined)g.reactions[kind]=performance.now()-g.patchAt;};
        new MutationObserver(list=>{for(const m of list){const t=m.target as unknown as {classList:{contains(c:string):boolean}};
          if(m.type==='attributes'){if(t.classList.contains('hit')&&t.classList.contains('st'))seen('stage');if(t.classList.contains('fresh'))seen('dot');continue;}
          for(const raw of m.addedNodes)if((raw as unknown as {classList?:{contains(c:string):boolean}}).classList?.contains('lane'))seen('packet');}}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
      });
      await p.goto(url);await p.waitForSelector('#stages button.st');await settle(p);
      for(const language of ['ko','en']){
        if(language==='en')await p.locator('#language').click();
        expect(await stage(p,'router').locator('.sn .d').textContent()).not.toMatch(/legacy_model|fable_disabled_by_config|loaded.hook|0123456789abcdef/);
        expect(await p.locator('#rc li:first-child .v').textContent()).not.toMatch(/legacy_model|fable_disabled_by_config|loaded.hook|0123456789abcdef/);
        await go(p,'patch');const raw=p.locator('#step-detail details.raw');expect(await raw.getAttribute('open')).toBeNull();expect(await raw.textContent()).toContain('fable_disabled_by_config');
        expect(await p.locator('#step-detail .kvl').first().textContent()).not.toMatch(/fable_disabled_by_config|0123456789abcdef/);
        expect(await problems(p)).toEqual([]);await go(p,null);
      }
      // The views above were opened through the hash, which Chrome does not count as input; only the patch below is measured.
      await p.locator('#language').click();await settle(p);await wait(1100);await p.evaluate(()=>{(globalThis as unknown as {shifts:string[]}).shifts.length=0});
      const batch=[call('patch-router','router',73,{},{choice:'gpt-6.1-sol · high'}),call('patch-compact','compact',82),call('patch-allocation','allocation',94)];patch([{...rs[0]!,steps:[...rs[0]!.steps,...batch],lastAt:ago(0)}]);
      await expect.poll(()=>p.evaluate(()=>Object.keys((globalThis as unknown as {reactions:Record<string,number>}).reactions).length)).toBe(3);
      const measured=await p.evaluate(()=>{const g=globalThis as unknown as {reactions:Record<string,number>;opens:number};return {reactions:g.reactions,opens:g.opens}});
      for(const [kind,ms]of Object.entries(measured.reactions))expect(ms,`${width} ${kind}`).toBeLessThanOrEqual(100);
      expect(measured.opens).toBe(1);expect(await p.locator('#k-rate').textContent()).toBe('+4/min');expect(await p.locator('#rc button[data-call]').count()).toBe(4);
      await p.screenshot({path:join(output,`readability-${width}-active.png`),fullPage:true});await wait(2000);
      const idle=await running(p);expect(idle).toEqual([]);
      const moved=await shifts(p);writeFileSync(join(output,'patch-shifts-'+width+'.json'),JSON.stringify(moved,null,2));expect(moved,`${width}`).toEqual([]);measurements.push({width,...measured,idle});
      await p.screenshot({path:join(output,`readability-${width}-idle.png`),fullPage:true});await p.close();
    }
    writeFileSync(join(output,'readability-patch-measurements.json'),JSON.stringify(measurements,null,2));
  },45_000);

  it('keeps execution rows dense, readable and stable when their latest decision changes (#338)', async()=>{
    const at=ago(1000),stages=['admission','allocation','workers','router','compact'] as const;
    const records=stages.map((id,i)=>call('dense-'+i,id,70+i,{at},{choice:id==='router'?'claude-opus-5-5 · medium':id==='admission'?'direct':'selected'}));
    const rs=Array.from({length:10},(_,i)=>run('dense-'+i,'claude',i===2?records:[records[3]!],{title:i===2?'여러 단계 실행':'Router 실행'}));
    for(const width of [1440,1280,390]){
      push(rs);const p=await page(width);await settle(p);
      for(const language of ['ko','en']){
        if(language==='en')await p.locator('#language').click();
        const metric=await p.locator('#runs').evaluate(root=>{const box=root.getBoundingClientRect();return {heights:[...root.querySelectorAll('.row')].map(e=>e.getBoundingClientRect().height),full:[...root.children].filter(e=>{const r=e.getBoundingClientRect();return r.top>=box.top&&r.bottom<=box.bottom+1}).length,overflow:document.documentElement.scrollWidth>innerWidth};});
        expect(new Set(metric.heights),`${width} ${language}`).toEqual(new Set([48]));expect(metric.full).toBeGreaterThanOrEqual(4);expect(metric.overflow).toBe(false);
        expect(await p.locator('#runs .sub').first().textContent()).not.toMatch(/confidence|확신|ms/);
      }
      const before=await p.locator('#runs .row').evaluateAll(rows=>rows.map(e=>e.getBoundingClientRect().height));
      const updated=rs.map(r=>({...r,steps:r.steps.map(s=>s.feature==='router'?{...s,receipt:{...s.receipt!,choice:'gpt-6.1-sol · xhigh'}}:s)}));
      patch(updated);await expect.poll(()=>p.locator('#runs .sub').first().textContent()).toContain('sol');
      expect(await p.locator('#runs .row').evaluateAll(rows=>rows.map(e=>e.getBoundingClientRect().height))).toEqual(before);
      await p.screenshot({path:join(output,`execution-density-${width}.png`),fullPage:true});await p.close();
    }
  },30_000);

  it('counts a pending request up in its call-log row, replaces it in place with the response and ignores identical snapshots (#338)',async()=>{
    const request=step('same-id','router',{state:'active',at:ago(500),callId:'exchange',summary:'응답 대기'}),r=run('same-run','codex',[request],{state:'active'});
    push([r]);const p=await page();await settle(p);await record(p);
    const first=p.locator('#rc li:first-child');
    expect(await first.locator('.v b').textContent()).toBe('응답 대기');expect(await first.locator('.ms').getAttribute('class')).toContain('run');
    const elapsed=async()=>{const t=(await first.locator('.ms').textContent())!;return parseFloat(t)*(t.endsWith('ms')?1:1000)};const counted=await elapsed();await wait(300);expect(await elapsed()).toBeGreaterThan(counted);
    const response=call('same-id','router',63,{...request,state:'done',summary:'선택 모델과 실제 모델 일치',model:{selected:'gpt-6-luna',observed:'gpt-6-luna',status:'confirmed',selectedEffort:'low',observedEffort:null}},{choice:'gpt-6-luna · low'});
    patch([{...r,state:'done',steps:[response]}]);
    await expect.poll(async()=>count(await motion(p),'hit:router')).toBeGreaterThan(0);
    expect(await first.locator('.ms').textContent()).toBe('63ms');expect(await first.locator('.ms').getAttribute('class')).not.toContain('run');expect(await p.locator('#rc button[data-call]').count()).toBe(1);
    await wait(1200);const log=await motion(p);expect(count(log,'lane')).toBe(1);
    push([{...r,state:'done',steps:[{...response}]}]);await wait(250);
    expect((await motion(p)).length).toBe(log.length);expect(await running(p)).toEqual([]);
    await p.close();
  });

  it('shows live version status without overflow in the actual browser', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-dashboard-version-'));
    const releaseFetch = (async () => new Response(JSON.stringify({ tag_name: 'v99.0.0', draft: false, prerelease: false, html_url: 'https://github.com/MongLong0214/jev-gate/releases/tag/v99.0.0' }))) as typeof fetch;
    const local = await startDashboard(dashboardSources({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), JEV_GATE_TRACE_DIR: join(home, 'claude-traces'), JEV_CODEX_TRACE_DIR: join(home, 'codex-traces') }), 0, { releaseFetch });
    try {
      for (const width of [1440, 390, 320]) {
        const p = await browser.newPage({ viewport: { width, height: 900 } });
        p.on('pageerror', e => errors.push(e.message));
        await p.goto(local.url);
        // The server puts the version in the page, so the badge has its text, and its width, without waiting for /api/version.
        expect(await p.locator('#version-badge').textContent()).toBe(`v${JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')).version} → 99.0.0`);
        expect(await p.locator('#version-badge').getAttribute('data-state')).toBe('update');
        expect(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        await p.screenshot({ path: join(output, `version-${width}.png`), fullPage: true });
        await p.close();
      }
    } finally { await local.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it('tracks real tabs across reloads and reopens only when the last tab has closed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-dashboard-tabs-'));
    const opened: string[] = [];
    const local = await startDashboard(dashboardSources({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state') }), 0, { openBrowser: url => opened.push(url) });
    const a = await browser.newPage(), b = await browser.newPage();
    const live = (p: Page) => p.waitForFunction(() => (document.getElementById('connection') as unknown as { dataset: { label?: string } } | null)?.dataset.label === '실시간 연결');
    try {
      for (const p of [a, b]) { p.on('pageerror', e => errors.push(e.message)); await p.goto(local.url); await live(p); }
      local.ensureOpen(); expect(opened).toHaveLength(0);
      await a.reload(); await live(a);
      await a.close(); await new Promise(resolve => setTimeout(resolve, 1200));
      local.ensureOpen(); expect(opened).toHaveLength(0);
      await b.close();
      await vi.waitFor(() => expect(opened).toEqual([local.url]), { timeout: 3000 });
      local.ensureOpen(); expect(opened).toHaveLength(1);
    } finally { await a.close(); await b.close(); await local.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it('shows both hosts, recorded Jev traffic and the median at the top without overflow', async () => {
    push([run('live-claude','claude',[call('judgment','router',92,{},{choice:'sonnet · high'}),step('request','router',{lane:'host',lifecycle:true,state:'active',title:'모델 · 응답 대기'})],{state:'active'}),run('live-codex','codex',[call('other','router',181)],{state:'active'})]);
    for(const width of [1440,768,390,320]) {
      const p=await page(width);await settle(p);
      expect(await p.locator('#k-active').textContent()).toBe('2');expect(await p.locator('#k-hosts').textContent()).toBe('Claude 1 · Codex 1');
      expect([await p.locator('#j-p50').textContent(),await p.locator('#j-p50-u').textContent()]).toEqual(['92','ms']);expect(await p.locator('#j-p95').textContent()).toBe('p50 · p95 181ms');
      expect(await p.locator('#k-today').getAttribute('aria-label')).toBe('2회');expect(await p.locator('#k-rate').textContent()).toBe('+2/min');
      expect(await p.locator('#connection').textContent()).toMatch(/^Live · (now|\d+s)$/);
      expect(await p.locator('.kp').evaluate(e=>e.getBoundingClientRect().top)).toBeLessThan(260);
      expect(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
      await p.emulateMedia({reducedMotion:'reduce'});expect(await p.locator('.edge-l').evaluate(e=>getComputedStyle(e).animationName)).toBe('none');
      await p.screenshot({path:join(output,`top-${width}.png`)});await p.close();
    }
  });

  it('keeps Compact visible in Codex and Claude views (#317)', async () => {
    const codex=run('cx','codex',[call('cx-router','router',90),call('cx-compact','compact',81)]);
    for(const rows of [[run('cl','claude',[call('cl-compact','compact',80)]),codex],[codex]]){
      push(rows);
      const p=await page();await settle(p);
      const card=stage(p,'compact');
      expect(await card.isVisible()).toBe(true);
      await card.click();expect(await p.locator('#log-filter').textContent()).toBe('Compact만');expect(new Set(await p.locator('#rc button .f').allTextContents())).toEqual(new Set(['Compact']));
      await p.locator('[data-host="codex"]').click();await settle(p);
      expect.soft(await card.isVisible()).toBe(true);expect.soft(await p.locator('#rc button[data-call]').count()).toBe(1);
      expect.soft(await p.locator('#runs [data-run="cx"]').count()).toBe(1);
      await p.locator('[data-host="claude"]').click();await settle(p);expect.soft(await card.isVisible()).toBe(true);
      await p.locator('[data-host="all"]').click();await settle(p);expect.soft(await card.isVisible()).toBe(true);expect.soft(await p.locator('#runs .row').count()).toBe(rows.length);
      await p.close();
    }
  });

  it('counts running executions from runs rather than the recent feed and scopes them by host', async () => {
    push([run('old-active','codex',[step('old-tool','workers',{lifecycle:true,lane:'host',state:'active',startedAt:ago(0)})],{state:'active'}),run('new','claude',[call('new-output','compact',80)])]);
    current.operations.feed=current.operations.feed.filter(event=>event.id!=='old-tool');
    const p=await page();await settle(p);
    expect(await p.locator('#k-active').textContent()).toBe('1');expect(await p.locator('#k-hosts').textContent()).toBe('Claude 0 · Codex 1');expect(await p.locator('#n-active').textContent()).toBe('1');
    await p.locator('[data-host="claude"]').click();expect(await p.locator('#k-active').textContent()).toBe('0');expect(await p.locator('#runs .row').count()).toBe(1);
    await p.close();
  });

  it('settles promptless native Codex requests only after their exact response', async () => {
    const stamp = ago(0);
    const request = { host: 'codex', session_id: 'native-session', prompt_id: null, request_id: 'native-request', written_at: stamp, phase: 'codex_model_request', submitted_model: 'gpt-6-luna' };
    const response = { ...request, written_at: new Date(Date.parse(stamp) + 100).toISOString(), phase: 'codex_router_response', selected_model: 'gpt-6-luna', observed_model: 'gpt-6-luna' };
    const show = (records: Record<string, unknown>[]) => push(buildOperations(records, [], new Date(), { trace: true }).runs);
    show([request]);
    const p = await page();
    expect(await p.locator('#k-active').textContent()).toBe('1');expect(await p.locator('#runs .row .sub').textContent()).toMatch(/^진행 중 · /);
    show([request, { ...response, request_id: 'another-request' }]);await settle(p);
    expect(await p.locator('#k-active').textContent()).toBe('1');
    show([request, response]);
    await p.waitForFunction(() => document.getElementById('k-active')?.textContent === '0');
    await go(p, (await p.locator('#runs .row').first().getAttribute('data-run'))!);
    expect(await p.locator('#trace').textContent()).toContain('gpt-6-luna');
    expect(await p.locator('#step-detail').textContent()).toContain('일치');
    await p.close();
  });

  it('separates current incidents from past error records in the header, run states and stage detail, and reclassifies them live (#223)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-dashboard-223-')), claude = join(home, 'claude-traces'), codex = join(home, 'codex-traces');
    mkdirSync(claude); mkdirSync(codex);
    const write = (dir: string, name: string, value: object) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
    const jev = (request_id: string, session_id: string, written_at: string, code: string, status: number) => ({ phase: 'admission_result', host: 'codex', session_id, request_id, written_at, attempted: true, http: { status, code, duration_ms: 140 } });
    const router = (turn: string, session_id: string, written_at: string, confirmation: string, observed: string | null) => ({ phase: 'claude_router', host: 'claude', session_id, event: 'root_result', turn, written_at, requested: 'claude-opus-5-5', observed, confirmation });
    // Yesterday's Codex network failure followed by a successful call, beside a current outage and a model check.
    write(codex, 'jev-old', jev('j-old', 'codex-old-session', ago(26 * 3_600_000), 'network', 0));
    write(codex, 'jev-ok', jev('j-ok', 'codex-new-session', ago(3_600_000), 'ok', 200));
    write(codex, 'jev-1', jev('j1', 'codex-session-a', ago(1_800_000), 'http_401', 401));
    write(codex, 'jev-2', jev('j2', 'codex-session-b', ago(300_000), 'http_401', 401));
    write(claude, 'rt-mismatch', router('t1', 'claude-session-1', ago(7_200_000), 'mismatch', 'claude-sonnet-5'));
    write(claude, 'rt-unobserved', router('t2', 'claude-session-2', ago(600_000), 'unobserved', null));
    const local = await startDashboard(dashboardSources({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), JEV_GATE_TRACE_DIR: claude, JEV_CODEX_TRACE_DIR: codex }), 0);
    type Snap = { operations: { attention: number; runs: Array<{ id: string; host: string; state: string; steps: Array<{ cause?: string; impact?: { now: string } }> }> } };
    const label: Record<string, string> = { attention: '확인 필요', past_error: '지난 오류', done: '완료', unconfirmed: '결과 미관측' };
    const snap = async () => await (await fetch(new URL('/api/snapshot', local.url))).json() as Snap;
    const runOf = (s: Snap, cause: string, now: string) => s.operations.runs.find(r => r.steps.some(x => x.cause === cause && x.impact?.now === now))!.id;
    // The server snapshot, the frame the page holds from the live stream and what it shows must say the same thing.
    const agree = async (p: Page, host: 'all' | 'claude' | 'codex' = 'all') => {
      const s = await snap(), held = JSON.parse(await p.evaluate('JSON.stringify(data.operations.runs.map(r=>[r.id,r.state]))')) as Array<[string, string]>;
      expect(held).toEqual(s.operations.runs.map(r => [r.id, r.state]));
      const runs = s.operations.runs.filter(r => host === 'all' || r.host === host), count = (state: string) => String(runs.filter(r => r.state === state).length);
      if (host === 'all') expect(String(s.operations.attention)).toBe(count('attention'));
      expect(await p.locator('#k-att').textContent()).toBe(count('attention'));expect(await p.locator('#n-attention').textContent()).toBe(count('attention'));expect(await p.locator('#n-all').textContent()).toBe(String(runs.length));
      await p.locator('#state-filters [data-state=all]').click();
      for (const r of runs) expect(await p.locator(`#runs [data-run="${r.id}"] .sub`).textContent()).toMatch(new RegExp(`^${label[r.state]} · `));
      return s;
    };
    try {
      const p = await page();await p.goto(local.url);await p.waitForFunction(() => document.querySelectorAll('#runs .row').length === 6);
      let s = await agree(p);
      expect(await p.locator('#k-att').textContent()).toBe('3');
      const diag = await p.locator('#k-diag').textContent();expect(diag).toContain('Jev 판정 오류 2건');expect(diag).toContain('실제 응답 모델 불일치 1건');
      await p.locator('[data-host=codex]').click();await agree(p, 'codex');await p.locator('[data-host=claude]').click();await agree(p, 'claude');await p.locator('[data-host=all]').click();
      const outage = runOf(s, 'http_401', 'unknown'), settled = runOf(s, 'network', 'later_ok');
      await p.locator('[data-state=attention]').click();expect(await p.locator(`#runs [data-run="${outage}"]`).count()).toBe(1);expect(await p.locator(`#runs [data-run="${settled}"]`).count()).toBe(0);
      await p.locator('.kp').screenshot({ path: join(output, '223-1440-dark-ko-top.png') });
      const detail = () => p.locator('#step-detail').textContent();
      await go(p, outage);
      for (const fact of ['원인HTTP 401 오류', '현재 영향현재 영향 미확인', '호스트Codex', '세션codex-session-b', '마지막 관측']) expect(await detail()).toContain(fact);
      expect(await p.locator('#rd-state').textContent()).toBe('확인 필요');
      expect(await problems(p)).toEqual([]);
      await p.screenshot({ path: join(output, '223-1440-dark-ko-detail-current.png'), fullPage: true });
      await go(p, settled);
      // The result line already shows the state, so the fact list does not repeat it.
      for (const fact of ['원인연결 오류', '현재 영향이후 같은 작업 정상 기록', '세션codex-old-session']) expect(await detail()).toContain(fact);
      expect(await detail()).not.toContain('상태오류');expect(await p.locator('#trace [aria-pressed="true"] .bar em').textContent()).toBe('오류');expect(await p.locator('#rd-state').textContent()).toBe('지난 오류');
      await p.screenshot({ path: join(output, '223-1440-dark-ko-detail-past.png'), fullPage: true });
      // A later success of the same Jev call on the same host arrives on the open stream; both outage records become past errors.
      await go(p, null);
      write(codex, 'jev-3', jev('j3', 'codex-session-c', ago(0), 'ok', 200));
      await p.waitForFunction(() => document.getElementById('k-att')?.textContent === '1');
      s = await agree(p);
      expect(s.operations.runs.find(r => r.id === outage)).toMatchObject({ state: 'past_error', steps: [{ cause: 'http_401', impact: { now: 'later_ok' } }, { lane: 'policy' }] });
      expect(await p.locator('#k-diag').textContent()).toBe('실제 응답 모델 불일치 1건');
      await go(p, outage);
      expect(await detail()).toContain('현재 영향이후 같은 작업 정상 기록');expect(await detail()).not.toContain('상태오류');expect(await p.locator('#trace [aria-pressed="true"] .bar em').textContent()).toBe('오류');
      await go(p, null);
      await p.locator('[data-host=codex]').click();expect(await p.locator('#k-diag').textContent()).toBe('지난 오류 3건');await agree(p, 'codex');
      await p.locator('#language').click();expect(await p.locator('#k-diag').textContent()).toBe('3 past errors');await p.locator('#language').click();await p.close();
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });phone.on('pageerror', e => errors.push(e.message));await phone.goto(local.url);
      await phone.waitForFunction(() => document.querySelectorAll('#runs .row').length === 7);await agree(phone);expect(await problems(phone)).toEqual([]);
      await phone.locator('.kp').screenshot({ path: join(output, '223-390-top.png') });
      await go(phone, settled);expect(await problems(phone)).toEqual([]);await phone.screenshot({ path: join(output, '223-390-detail-past.png'), fullPage: true });
      await phone.close();
    } finally { await local.close(); rmSync(home, { recursive: true, force: true }); }
  }, 60_000);

  it('keeps refused worker contracts refused from real Claude and Codex trace files through a later host end, and shows a later accept separately (#232)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-dashboard-232-')), claude = join(home, 'claude-traces'), codex = join(home, 'codex-traces');
    mkdirSync(claude); mkdirSync(codex);
    const write = (dir: string, name: string, value: object) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
    const unobserved = refusalReason({ transcript: 'read', contradicted: [], unobserved: ['#1'], stale: [] })!;
    const blocked = reportedSingleVerdict({ status: 'blocked', summary: 'worker reply text', changed_files: [], interfaces: [], checks: [{ check_id: 'npm test', result: 'fail', note: 'reply note' }], blockers: [] }).reason!;
    // The two reported receipts in the v0.8.18 shape: Claude hook rows carry no host, Codex rows do.
    const post = (own: object, written_at: string, model: string, verdict: string, verdict_reason: string | null, checks: object, verification: object | null) => ({ ...own, phase: 'post', prompt_id: 'p', tool_use_id: `${model}-call`, invocation_id: `${model}-${written_at}`, written_at,
      task_id: 'single', rev: 0, attempt: 1, verdict, verdict_reason, reported_checks: checks, ready_task_ids: [], plan_complete: false, evidence_format_only: false, root_fallback: false,
      subagent_type: 'jev-gate:worker', requested_model: model, resolved_model: `claude-${model}-5`, tool_response: { status: 'completed', agentId: `${model}-agent` }, root_effort: null, ...(verification ? { verification } : {}), advisory: null });
    const c = { session_id: 'claude-232', mode: 'auto', version: '0.8.18' }, x = { host: 'codex', session_id: 'codex-232', mode: 'auto', version: '0.8.18' };
    write(claude, 'post', post(c, ago(240_000), 'sonnet', 'incomplete', unobserved, { pass: 1, fail: 0, not_run: 0 }, { transcript: 'read', contradicted: [], unobserved: ['#1'], stale: [] }));
    write(claude, 'terminal', { ...c, phase: 'background_terminal', prompt_id: 'q', execution_prompt_id: 'p', tool_use_id: 'sonnet-call', invocation_id: 'c-terminal', written_at: ago(200_000), status: 'completed', task_id: 'single' });
    write(claude, 'delivery', { ...c, phase: 'background_policy_delivery', prompt_id: 'q', execution_prompt_id: 'p', invocation_id: 'c-delivery', written_at: ago(190_000), reason: 'policy_delivered_no_active_execution', admission_blocked: false });
    write(codex, 'post', post(x, ago(180_000), 'haiku', 'incomplete', blocked, { pass: 0, fail: 1, not_run: 0 }, null));
    write(codex, 'terminal', { ...x, phase: 'background_terminal', prompt_id: 'p', tool_use_id: 'haiku-call', invocation_id: 'x-terminal', written_at: ago(170_000), status: 'completed', agent_id: 'haiku-agent' });
    write(codex, 'stop', { ...x, phase: 'codex_event', event: 'SubagentStop', agent_id: 'haiku-agent', agent_type: 'jev-gate:worker', invocation_id: 'x-stop', written_at: ago(169_000) });
    const local = await startDashboard(dashboardSources({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), JEV_GATE_TRACE_DIR: claude, JEV_CODEX_TRACE_DIR: codex }), 0);
    type Snap = { operations: { attention: number; runs: Array<{ id: string; host: string; state: string; steps: Array<{ id: string; outcome?: string; cause?: string; details?: string[]; impact?: { now: string } }> }> } };
    const snap = async () => await (await fetch(new URL('/api/snapshot', local.url))).json() as Snap;
    try {
      let s = await snap();
      const refused = (cause: string) => s.operations.runs.find(r => r.steps.some(x => x.outcome === 'rejected' && x.cause === cause))!;
      expect(s.operations.attention).toBe(2); expect(refused('check_unobserved')).toMatchObject({ host: 'claude', state: 'attention' }); expect(refused('worker_blocked')).toMatchObject({ host: 'codex', state: 'attention' });
      // Frames omit step details; the full step comes from /api/step when a detail opens.
      const details = async (cause: string) => { const r = refused(cause), x = r.steps.find(y => y.outcome === 'rejected')!;
        return (await (await fetch(new URL(`/api/step?run=${encodeURIComponent(r.id)}&step=${encodeURIComponent(x.id)}`, local.url))).json() as { details: string[] }).details; };
      expect(await details('check_unobserved')).toContain('실행 기록 read · 미관측 #1');
      expect(await details('worker_blocked')).toContain('worker 보고 pass 0 · fail 1 · 미실행 0');
      expect(s.operations.runs.flatMap(r => r.steps).filter(x => x.outcome === 'host_ended')).toHaveLength(3);
      for (const secret of [unobserved, blocked, 'worker reply text', 'reply note', 'npm test']) expect(JSON.stringify(s)).not.toContain(secret);
      const p = await page();await p.goto(local.url);await p.waitForFunction(() => document.getElementById('k-att')?.textContent === '2');
      expect(await p.locator('#k-diag').textContent()).toBe('워커 계약 미충족 2건');
      for (const r of [refused('check_unobserved'), refused('worker_blocked')]) expect(await p.locator(`#runs [data-run="${r.id}"] .sub`).textContent()).toMatch(/^확인 필요 · /);
      // The host's own end of the call is a lifecycle record, so the stage keeps the refusal as its latest decision.
      expect(await stage(p, 'workers').locator('.sn .d').textContent()).toMatch(/^계약 미충족/);
      const id = refused('check_unobserved').id, marks = () => p.locator('#trace .bar em').allTextContents(), detail = () => p.locator('#step-detail').textContent();
      await go(p, id);
      // The host end shows as its own row, never as acceptance; the policy delivery after it stays a lifecycle record.
      expect(await marks()).toEqual(['계약 미충족', '호스트 종료']);
      await p.waitForFunction(() => document.getElementById('step-detail')?.textContent?.includes('미관측 #1'));
      for (const fact of ['단일 워커 · 계약 미충족 · 작업 완료 조건 미충족 · 통과 보고 검사의 실행 미관측', '실행 기록 read · 미관측 #1', '원인보고 검사의 실행 미관측', '현재 영향현재 영향 미확인', '세션claude-232']) expect(await detail()).toContain(fact);
      expect(await problems(p)).toEqual([]);
      await p.screenshot({ path: join(output, '232-1440-dark-ko-detail-rejected.png'), fullPage: true });
      await go(p, refused('worker_blocked').id);
      expect(await detail()).toContain('단일 워커 · 계약 미충족 · 작업 완료 조건 미충족 · 워커가 차단·재계획 보고');
      await p.screenshot({ path: join(output, '232-1440-dark-ko-detail-blocked.png'), fullPage: true });
      // A genuine retry of the same task is accepted later on the open stream: it is its own record, and the refusal stays as it was.
      await go(p, null);
      write(claude, 'retry', post(c, ago(0), 'sonnet', 'accept', null, { pass: 1, fail: 0, not_run: 0 }, { transcript: 'read', contradicted: [], unobserved: [], stale: [] }));
      await p.waitForFunction(() => document.getElementById('k-att')?.textContent === '1');
      s = await snap();
      const retried = s.operations.runs.find(r => r.id === id)!;
      expect(retried.state).toBe('past_error'); expect(retried.steps.filter(x => x.outcome === 'rejected' || x.outcome === 'accepted').map(x => [x.outcome, x.impact?.now ?? null])).toEqual([['rejected', 'later_ok'], ['accepted', null]]);
      expect(await p.locator(`#runs [data-run="${id}"] .sub`).textContent()).toMatch(/^지난 오류 · /);
      await go(p, id);
      expect(await marks()).toEqual(expect.arrayContaining(['계약 미충족', '계약 수락']));
      await p.locator('#trace button[data-step]').first().click();expect(await detail()).toContain('현재 영향이후 같은 작업 정상 기록');
      await p.screenshot({ path: join(output, '232-1440-dark-ko-detail-retried.png'), fullPage: true });
      await p.locator('#language').click();expect(await marks()).toEqual(expect.arrayContaining(['Contract not met', 'Contract accepted']));
      expect(await detail()).toContain('Reported pass not seen in the worker transcript');await p.locator('#language').click();
      await p.close();
    } finally { await local.close(); rmSync(home, { recursive: true, force: true }); }
  }, 60_000);

  it('labels request effort discrepancies precisely in the header and the stage detail', async () => {
    push([run('effort', 'codex', [step('old', 'router', { at: ago(7_200_000), lane: 'host', state: 'error', issue: 'request_effort', summary: '선택 high · 전송 xhigh' }), step('recent', 'router', { lane: 'host' })], { state: 'attention' })]);
    const p = await page();
    expect(await p.locator('#k-att').textContent()).toBe('1');expect(await p.locator('#k-diag').textContent()).toContain('API 전송 effort 불일치 1건');
    await go(p, 'effort');
    expect(await p.locator('[data-step=old]').getAttribute('aria-pressed')).toBe('true');expect(await p.locator('#step-detail').textContent()).toContain('선택 high · 전송 xhigh');
    await p.close();
  });

  it('keeps the call log at eight five-column rows of fixed height, pins a row on demand and shows only recorded values', async () => {
    const calls=[call('c1','router',120,{at:ago(5000)},{choice:'sonnet · high',threshold:0.6}),call('c2','admission',80,{at:ago(4000),executionPath:'direct'},{confidence:null,input:null,output:null,costUsd:null})];
    push([run('rc','claude',calls,{title:'호출 기록 실행'})]);const p=await page();await settle(p);
    const row=(i:number)=>p.locator(`#rc li:nth-child(${i}) button`).evaluate(b=>['.f','.v b','.ms','.tk'].map(q=>b.querySelector(q)?.textContent));
    expect(await p.locator('#rc li').count()).toBe(8);expect(await p.locator('#rc li:first-child button > span').count()).toBe(5);expect(await p.locator('#rc li:nth-child(3) button').count()).toBe(0);
    expect(await row(1)).toEqual(['Gate A','직접','80ms','–']);
    expect(await row(2)).toEqual(['Router','sonnet · high','120ms','1.2k']);
    const heights=()=>p.evaluate(()=>({rows:[...document.querySelectorAll('#rc li')].map(e=>e.getBoundingClientRect().height),log:document.getElementById('rc')!.closest('section')!.getBoundingClientRect().height,basis:document.getElementById('basis')!.getBoundingClientRect().height}));
    const before=await heights();expect(new Set(before.rows)).toEqual(new Set([32]));
    for(let i=0;i<9;i++)calls.push(call('more'+i,'compact',60+i,{at:ago(3000-i*100)}));push([run('rc','claude',calls,{title:'호출 기록 실행'})]);
    await p.waitForFunction(()=>document.querySelector('#rc li:first-child .ms')?.textContent==='68ms',undefined,{timeout:8000});
    expect(await heights()).toEqual(before);
    await p.locator('#rc li:nth-child(2) button').click();expect(await p.locator('#rc li:nth-child(2) button').getAttribute('aria-pressed')).toBe('true');
    expect(await p.locator('#rc li:nth-child(2) button').getAttribute('class')).toContain('on');expect(await p.locator('#basis-meta').textContent()).toMatch(/^\d{2}:\d{2}:\d{2} · Compact$/);
    const pinned=await p.locator('#basis-meta').textContent();
    calls.push(call('late','allocation',77));push([run('rc','claude',calls,{title:'호출 기록 실행'})]);
    await p.waitForFunction(()=>document.querySelector('#rc li:first-child .ms')?.textContent==='77ms',undefined,{timeout:8000});
    expect(await p.locator('#rc [aria-pressed=true]').getAttribute('data-call')).toBe('more7');expect(await p.locator('#basis-meta').textContent()).toBe(pinned);expect(await heights()).toEqual(before);
    // A second press releases the pin; the basis follows the newest call again.
    await p.locator('#rc [aria-pressed=true]').click();expect(await p.locator('#rc [aria-pressed=true]').count()).toBe(0);expect(await p.locator('#basis-meta').textContent()).toMatch(/ · Gate B$/);
    await p.close();
  });

  it('keeps header and stage geometry stable when the periodic version status changes',async()=>{
    for(const width of [1440,768,390,320]){
      const history=[run('version','claude',[call('version-call','router',60)])];push(history);const p=await page(width);await settle(p);
      const geometry=()=>p.evaluate(()=>['header','#version-badge','#connection','#pause','#stages'].map(s=>{const b=document.querySelector(s)!.getBoundingClientRect();return [b.x,b.y,b.width,b.height]}));
      const before=await geometry();
      for(const [state,version,text] of [['update',{...VERSION,release:{latest:'0.8.99'}},'v0.8.32 → 0.8.99'],['mismatch',{...VERSION,installed:'0.8.99'},'v0.8.32 ≠ v0.8.99'],['current',VERSION,'v0.8.32']] as const){
        push(history,{version});await p.waitForFunction(s=>document.getElementById('version-badge')!.getAttribute('data-state')===s,state);expect(await geometry(),`${width}: ${state}`).toEqual(before);
        expect(await p.locator('#version-badge').textContent()).toBe(text);expect(await p.locator('#version-badge').getAttribute('aria-label')).toContain('실행 중인 대시보드: 0.8.32');
      }
      await p.close();
    }
  });

  // Layout shifts are buffered from navigation, so the first frame before any data counts as much as the live updates after it.
  it('shifts nothing from the first frame through live calls, a new run on top, attention, credit, pinning and unpinning at five widths', async () => {
    const failures:string[]=[];
    for(const width of [1440,1024,768,390,320]){
      const a=[call('s0','admission',63,{at:ago(9000),executionPath:'direct'},{choice:'direct'}),call('s1','router',91,{at:ago(7000)},{choice:'sonnet · medium',threshold:0.6}),step('s2','workers',{lane:'policy',summary:'허용',at:ago(6000)})];
      const runs=[run('a','claude',a,{title:'Claude 실행',state:'active'}),run('b','codex',[call('b0','compact',220,{at:ago(20000)})],{title:'Codex 실행'})];push(runs);
      const p=await browser.newPage({viewport:{width,height:900}});p.on('pageerror',e=>errors.push(e.message));
      await p.addInitScript(observeShifts);await p.goto(url);await p.waitForSelector('#stages button.st');
      for(let i=0;i<10;i++){
        await wait(300);
        if(i===3)runs.unshift(run('n','claude',[call('n0','admission',55,{},{choice:'orchestrated'})],{title:'새 실행 '+'x'.repeat(30),state:'active'}));
        else if(i===6)runs[2]!.state='attention';
        else if(i%3===2)a.push(step('w'+i,'workers',{state:'active',lane:'host'}));
        else a.push(call('c'+i,(['router','compact','allocation'] as const)[i%3]!,40+i*37,{},{choice:i%3===0?'haiku · low':null,confidence:0.5+i/50,threshold:0.6}));
        runs.find(r=>r.steps===a)!.lastAt=ago(0);push(runs.slice().sort((x,y)=>y.lastAt.localeCompare(x.lastAt)),i>=7?{credit:{exhausted:true}}:{});
        if(i===4)await p.click('#rc li:nth-child(3) button');
        if(i===8)await p.click('#rc button[aria-pressed=true]');
      }
      await wait(1000);
      const moved=await shifts(p);writeFileSync(join(output,'live-shifts-'+width+'.json'),JSON.stringify(moved,null,2));if(moved.length)failures.push(`${width}: ${moved.join(' | ')}`);
      await p.close();
    }
    expect(failures).toEqual([]);
  },120_000);

  it('reports the Jev panel from recorded calls, colours failures and estimates cost from list prices', async () => {
    const calls=[call('j1','router',120,{at:ago(4000)},{choice:'sonnet · high'}),call('j2','admission',80,{at:ago(3000)},{model:'unknown-model',costUsd:null}),call('j3','allocation',300,{state:'error',at:ago(2000)},{status:402,code:'payment_required',model:null,input:null,output:null,costUsd:null,confidence:null}),call('j4','compact',90,{},{status:429,code:'rate_limited'})];
    push([run('j','claude',calls)],{credit:{exhausted:true}});
    for(const width of [1440,768,320]){
      const p=await page(width);await settle(p);
      expect([await p.locator('#j-p50').textContent(),await p.locator('#j-p50-u').textContent()]).toEqual(['90','ms']);expect(await p.locator('#j-p95').textContent()).toBe('p50 · p95 300ms');
      expect(await p.locator('#j-cost').textContent()).toBe('$0.00240');expect(await p.locator('#k-tok').textContent()).toBe('3.6k tok');
      expect(await p.locator('#j-cost').getAttribute('title')).toContain('응답 2회는 제외');expect(await p.locator('#j-cost').getAttribute('title')).toContain('실제 차감 크레딧은 API가 알려주지 않습니다');
      expect(await p.locator('#credit').textContent()).toBe('크레딧 소진');expect([await p.locator('#j-last').textContent(),await p.locator('#j-last-u').textContent()]).toEqual(['90','ms']);
      expect(await p.locator('#j-within').textContent()).toBe('100%');expect(await p.locator('#j-pp').textContent()).toBe('p50 90ms · p95 300ms');
      expect(await p.locator('#rc button[data-call=j3] .ms').getAttribute('class')).toContain(' e');expect(await p.locator('#rc button[data-call=j4] .ms').getAttribute('class')).toContain(' w');
      expect(await problems(p)).toEqual([]);await p.locator('.tp').screenshot({path:join(output,`jev-panel-${width}.png`)});await p.close();
    }
    const u=call('u','router',70,{at:ago(1000)},{model:null,costUsd:null});push([run('j','claude',[u])]);const p=await page();await settle(p);await record(p);expect(await p.locator('#j-cost').textContent()).toBe('–');expect(await p.locator('#j-wire .lane').count()).toBe(0);
    push([run('j','claude',[u,call('v','router',240)])]);await p.waitForFunction(()=>document.getElementById('j-last')?.textContent==='240');await expect.poll(async()=>count(await motion(p),'lat:240ms')).toBe(1);await p.close();
  });

  it('shows burst values immediately, replays concurrent round trips and flashes every stage that recorded', async () => {
    const steps=[call('rt0','admission',60,{at:ago(5000)})];push([run('rt','claude',steps,{state:'active'})]);const p=await page();await settle(p);await record(p);
    steps.push(call('rt1','router',90,{at:ago(600)},{choice:'haiku · low'}),step('pol','workers',{lane:'policy',at:ago(450),summary:'허용'}),call('rt2','compact',110,{at:ago(300)}),call('rt3','allocation',70));push([run('rt','claude',steps,{state:'active'}),run('other','codex',[step('o','admission',{lane:'host'})])]);
    await p.waitForFunction(()=>document.querySelector('#rc li:first-child .f')?.textContent==='Gate B');
    expect(await p.locator('#rc li:first-child .ms').textContent()).toBe('70ms');expect(await p.locator('#k-today').getAttribute('aria-label')).toBe('4회');expect(await p.locator('#runs [data-run=rt] .sub').textContent()).toBe('진행 중 · 완료');
    await wait(800);const log=await motion(p);
    expect(count(log,'lane')).toBe(3);expect(log.filter(([k])=>k.startsWith('lat:')).map(([k])=>k)).toEqual(['lat:90ms','lat:110ms','lat:80ms']);
    expect([...new Set(log.filter(([k])=>k.startsWith('hit:')).map(([k])=>k))].sort()).toEqual(['hit:admission','hit:allocation','hit:compact','hit:router','hit:workers']);
    expect(count(log,'fresh')).toBe(3);expect(count(log,'stem')).toBe(3);expect(count(log,'row')).toBe(3);
    const lanes=log.filter(([k])=>k==='lane').map(([,t])=>t);expect(lanes[2]!-lanes[0]!).toBeLessThan(150);
    expect(await p.locator('#j-wire .lane').count()).toBe(0);
    await p.locator('.tp').screenshot({path:join(output,'traffic-after-burst.png')});await p.close();
  });

  it('caps a burst at six packets while the newest decision and counters update immediately', async () => {
    push([run('cap','claude',[])]);const p=await page();await settle(p);await record(p);
    const steps=Array.from({length:40},(_,i)=>call('cap-'+i,'router',100+i,{at:ago(40-i)},{choice:i===39?'opus · high':'haiku · low'}));
    push([run('cap','claude',steps)]);
    await p.waitForFunction(()=>document.querySelector('#rc li:first-child .v b')?.textContent==='opus · high');
    expect(await stage(p,'router').locator('.sn .d').textContent()).toMatch(/^opus · high/);expect(await p.locator('#k-rate').textContent()).toBe('+40/min');
    expect(await p.locator('#runs [data-run=cap] .sub').textContent()).toBe('완료 · opus · high');expect(await p.locator('#k-today').getAttribute('aria-label')).toBe('40회');
    expect(await p.locator('#j-wire .lane').count()).toBeLessThanOrEqual(6);
    // Saturated calls skip motion rather than waiting for a slot.
    await wait(800);expect(count(await motion(p),'lane')).toBe(6);expect(await p.locator('#j-wire .lane').count()).toBe(0);await p.close();
  });

  it('stops motion and freezes values on pause, disconnection and reduced motion, and never replays held calls', async () => {
    const steps=[call('m0','router',50,{at:ago(3000)},{choice:'sonnet · high'})];push([run('m','claude',steps,{state:'active'})]);const p=await page();await settle(p);await record(p);
    const age=stage(p,'router').locator('.sn .cap'),first=p.locator('#rc li:first-child .ms');
    await p.locator('#pause').click();expect(await p.locator('body').getAttribute('class')).toContain('still');expect(await p.locator('#connection').textContent()).toBe('일시정지 · +0');
    const frozen=[await age.textContent(),await p.locator('#j-last').textContent()];
    steps.push(call('m1','router',95,{},{choice:'haiku · low'}));push([run('m','claude',steps,{state:'active'})]);await wait(2200);
    expect(await motion(p)).toEqual([]);expect([await age.textContent(),await p.locator('#j-last').textContent()]).toEqual(frozen);expect(await first.textContent()).toBe('50ms');
    expect(await p.locator('#connection').textContent()).toBe('일시정지 · +1');expect(await p.locator('#log-resume').textContent()).toBe('새 호출 1건 · 재개');
    await p.locator('#log-resume').click();await p.waitForFunction(()=>document.querySelector('#rc li:first-child .ms')?.textContent==='95ms');
    expect(await p.locator('#log-resume').isVisible()).toBe(false);await wait(600);expect((await motion(p)).filter(([k])=>k==='lane'||k==='fresh')).toEqual([]);
    for(const client of clients)client.end();clients.clear();
    await p.waitForFunction(()=>document.getElementById('connection')!.classList.contains('warn'));expect(await p.locator('body').getAttribute('class')).toContain('still');expect(await p.locator('#connection').textContent()).toBe('재연결 중');
    const offline=await age.textContent();await wait(1200);expect(await age.textContent()).toBe(offline);
    await p.waitForFunction(()=>(document.getElementById('connection') as unknown as {dataset:{label?:string};classList:{contains(c:string):boolean}}).dataset.label==='실시간 연결',undefined,{timeout:10000});
    await p.emulateMedia({reducedMotion:'reduce'});const before=(await motion(p)).length;
    steps.push(call('m2','router',120,{},{choice:'opus · xhigh'}));push([run('m','claude',steps,{state:'active'})]);
    await p.waitForFunction(()=>document.querySelector('#rc li:first-child .ms')?.textContent==='120ms');await wait(400);expect((await motion(p)).slice(before).filter(([k])=>k!=='row')).toEqual([]);
    expect(await stage(p,'router').locator('.sn .d').textContent()).toMatch(/^opus · xhigh/);
    expect(await p.locator('.live-btn i').evaluate(e=>getComputedStyle(e).animationName)).toBe('none');await p.close();
  });

  it('scopes the call log to a stage, keeps focus across updates and clears the scope',async()=>{
    const a=call('fa','admission',60,{executionPath:'direct',at:ago(3000)}),r=call('fr','router',80,{at:ago(2000)},{choice:'sonnet · high'});push([run('c','claude',[a]),run('x','codex',[r])]);const p=await page();await settle(p);
    await stage(p,'router').click();expect(await stage(p,'router').getAttribute('aria-pressed')).toBe('true');expect(await p.locator('#log-filter').textContent()).toBe('Router만');expect(await p.locator('#log-clear').isVisible()).toBe(true);
    expect(await p.locator('#rc button[data-call]').count()).toBe(1);expect(await p.locator('#runs .row').count()).toBe(2);
    await stage(p,'router').focus();push([run('c','claude',[a]),run('x','codex',[r,call('fr2','router',95,{},{choice:'haiku · low'})])]);
    await p.waitForFunction(()=>document.querySelector('#rc li:first-child .ms')?.textContent==='95ms');expect(await stage(p,'router').evaluate(e=>e===document.activeElement)).toBe(true);expect(await p.locator('#rc button[data-call]').count()).toBe(2);
    expect(await stage(p,'admission').locator('.sn .d').textContent()).toMatch(/^직접 · 확신 87%/);
    await p.locator('#log-clear').click();expect(await stage(p,'router').getAttribute('aria-pressed')).toBe('false');expect(await p.locator('#rc button[data-call]').count()).toBe(3);expect(await p.locator('#log-filter').textContent()).toBe('최신순');
    expect(await stage(p,'admission').evaluate(e=>e===document.activeElement)).toBe(true);
    await stage(p,'compact').click();await stage(p,'compact').click();expect(await p.locator('#stages [aria-pressed=true]').count()).toBe(0);
    await p.locator('#language').click();await stage(p,'router').click();expect(await p.locator('#log-filter').textContent()).toBe('Router only');await p.close();
  });

  it('keeps long stage values readable in the trace without inner scrollbars, moving the timeline or losing focus (#316)', async () => {
    for (const width of [1440, 768, 390, 320]) {
      const initial = call('status-call', 'router', 92, { summary: 'Recorded result' });
      push([run('status-run', 'codex', [initial])]);
      const p = await page(width); await p.emulateMedia({ reducedMotion: 'reduce' }); await go(p, 'status-run');
      const geometry = () => p.evaluate(() => ['#rd-name', '#tl-h', '#step-detail'].map(q => {
        const r = document.querySelector(q)!.closest('.panel')!.getBoundingClientRect(); return [r.x, r.y + (globalThis as unknown as {scrollY:number}).scrollY, r.width, q === '#step-detail' ? 0 : r.height];
      }));
      const before = await geometry();
      const row = p.locator('[data-step="status-call"]'); await row.focus(); const scroll = await p.evaluate(() => (globalThis as unknown as {scrollY:number}).scrollY);
      const note = 'Preserved complete status: ' + 'the original request remains active and response usage is unknown; '.repeat(28);
      push([run('status-run', 'codex', [{ ...initial, summary: note }])]);
      await p.waitForFunction(() => document.getElementById('step-detail')?.textContent?.includes('Preserved complete status:'));
      expect(await geometry()).toEqual(before);
      expect(await p.locator('#step-detail').textContent()).toContain(note.trim());
      expect((await p.locator('#step-detail').textContent())!.split('Preserved complete status:')).toHaveLength(2);
      const full = 'full-model-identifier-' + ('아주 긴 이유 error details with spaces '.repeat(30)) + '-END';
      push([run('status-run', 'codex', [{ ...initial, summary: note, cause: full, state: 'error', model: { selected: full, observed: full, status: 'mismatch', selectedEffort: 'xhigh', observedEffort: 'high' } }], { title: full, state: 'attention' })]);
      await p.waitForFunction(() => document.getElementById('step-detail')?.textContent?.includes('-END'));
      expect(await geometry()).toEqual(before);
      expect(await p.locator('#step-detail dd').evaluateAll(es => es.filter(e => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1 || getComputedStyle(e).overflowY !== 'visible').map(e => e.textContent))).toEqual([]);
      expect(await row.evaluate(e => e === document.activeElement)).toBe(true);expect(await p.evaluate(() => (globalThis as unknown as {scrollY:number}).scrollY)).toBe(scroll);
      expect(await problems(p)).toEqual([]);
      await p.screenshot({ path: join(output, `status-${width}.png`), fullPage: true });
      await p.close();
    }
  }, 30_000);

  // #261: a Router or Compact call that a host record follows still shows its own Jev facts.
  it('shows the Jev call basis and its stage facts when a host record follows the call (#261)',async()=>{
    const c=call('ic','router',226,{at:ago(2000)},{choice:'opus · xhigh',model:'jev-1.14.0',input:3394,output:203,costUsd:0.000142548,confidence:0.91,threshold:0.6});
    push([run('i','claude',[c,step('ih','router',{lane:'host',summary:'Model confirmed'})])]);const p=await page();await settle(p);
    expect(await p.locator('#basis-verdict').textContent()).toBe('opus · xhigh');expect(await p.locator('#basis-q li').first().getAttribute('aria-label')).toBe('이 턴 모델? opus · xhigh 0.91 · 문턱 0.60');
    expect(await p.locator('#basis-q li .p').allTextContents()).toEqual(['0.91']);expect(await p.locator('#basis-peers').textContent()).toBe('같은 기능 최근 1건');
    await p.locator('#basis-trace').click();await p.waitForFunction(()=>location.hash==='#run=i');await settle(p);
    await p.locator('[data-step=ic]').click();const text=await p.locator('#step-detail').textContent();
    for(const x of ['3.4K → 203','≈$0.00014','226ms','jev-1.14.0','opus · xhigh'])expect(text).toContain(x);
    await p.locator('[data-step=ih]').click();expect(await p.locator('#step-detail').textContent()).toContain('Model confirmed');
    expect(await problems(p)).toEqual([]);await p.close();
  });

  it('keeps 200-run history populated, anchored and focusable through live reorder and pointer presses (#313)',async()=>{
    const history=Array.from({length:200},(_,i)=>run('history-'+i,'claude',[call('history-call-'+i,'router',60,{at:ago(200_000-i)})]));
    push(history);const p=await browser.newPage({viewport:{width:1440,height:900}});p.on('pageerror',e=>errors.push(e.message));
    await p.addInitScript(()=>{const g=globalThis as unknown as {emptyHistory:number};g.emptyHistory=0;
      new MutationObserver(()=>{for(const a of document.querySelectorAll('#runs a'))if(!a.textContent?.trim()||!a.getAttribute('aria-label'))g.emptyHistory++;}).observe(document,{childList:true,subtree:true});});
    await p.goto(url);await p.waitForFunction(()=>document.querySelectorAll('#runs .row').length===200);
    const focused=p.locator('#runs [data-run=history-100]');await focused.focus();
    const anchor=await focused.evaluate(e=>({y:e.getBoundingClientRect().top,scroll:document.getElementById('runs')!.scrollTop}));
    const reordered=[history[199]!,...history.slice(0,199)];push(reordered);
    await p.waitForFunction(()=>document.querySelector('#runs a')?.getAttribute('data-run')==='history-199');
    expect(await focused.evaluate(e=>e===document.activeElement)).toBe(true);
    expect(await focused.evaluate(e=>e.getBoundingClientRect().top)).toBeCloseTo(anchor.y,0);
    expect(await p.locator('#runs').evaluate(e=>e.scrollTop)).toBeGreaterThan(anchor.scroll);
    // A row under a press keeps its place until the press ends, so the press opens the run it started on.
    const bounds=await focused.boundingBox();await p.mouse.move(bounds!.x+20,bounds!.y+20);await p.mouse.down();
    const beforePress=await p.locator('#runs a').evaluateAll(es=>es.map(e=>e.getAttribute('data-run')));
    push(history.slice().reverse());await wait(180);
    expect(await p.locator('#runs a').evaluateAll(es=>es.map(e=>e.getAttribute('data-run')))).toEqual(beforePress);
    await p.mouse.up();await p.waitForFunction(()=>location.hash==='#run=history-100');await settle(p);
    expect(await p.locator('#rd-name').textContent()).toBe('claude execution history-100');
    await go(p,null);await p.waitForFunction(()=>document.querySelector('#runs a')?.getAttribute('data-run')==='history-199');
    expect(await p.evaluate(()=>(globalThis as unknown as {emptyHistory:number}).emptyHistory)).toBe(0);
    await p.screenshot({path:join(output,'history-200-reorder.png')});await p.close();
  });

  it('never renders an empty run item and shows run states only through their rows',async()=>{
    push([run('a','claude',[call('ea','admission',60)]),run('b','codex',[call('eb','router',70)],{state:'attention'})]);const p=await page();await settle(p);
    expect(await p.locator('#runs [data-run=b]').getAttribute('class')).toBe('row er');expect(await p.locator('#runs [data-run=a]').getAttribute('class')).toBe('row ok');expect(await problems(p)).toEqual([]);
    await p.locator('[data-state=active]').click();expect(await p.locator('#runs li').allTextContents()).toEqual(['조건에 맞는 실행이 없습니다.']);expect(await problems(p)).toEqual([]);
    await p.locator('#attention').click();expect(await p.locator('[data-state=attention]').getAttribute('aria-pressed')).toBe('true');expect(await p.locator('#runs .row').count()).toBe(1);
    expect(await p.locator('[data-state=attention]').evaluate(e=>e===document.activeElement)).toBe(true);await p.close();
  });

  it('shows a generated run title in English in the trace and the row label (#237)',async()=>{
    push([run('t','claude',[call('tr','router',90)],{title:'Router 실행'})]);const p=await page(1280,800);await p.locator('#language').click();
    expect(await p.locator('#runs [data-run=t] .nm').textContent()).toBe('Router run');expect(await p.locator('#runs [data-run=t]').getAttribute('aria-label')).toMatch(/^Router run, /);
    await go(p,'t');expect(await p.locator('#rd-name').textContent()).toBe('Router run');expect(await p.title()).toBe('Jev Gate · Router run');await p.close();
  });

  it('selects one stage at a time in the trace and keeps the page scroll and keyboard focus', async () => {
    const model = { selected: 'gpt-6-luna', observed: null, status: 'unobserved' as const, selectedEffort: 'low', observedEffort: null };
    push([run('inspection', 'codex', Array.from({length:80}, (_, i) => step('stage-'+i, 'router', {lane:'host',model,summary:'Recorded result '+i})))]);
    const p = await page();await go(p, 'inspection');
    const row = p.locator('[data-step="stage-60"]');
    await row.focus();
    const before = await p.evaluate(() => (globalThis as unknown as {scrollY:number}).scrollY);
    expect(before).toBeGreaterThan(0);
    await p.keyboard.press('Enter');
    expect(await row.evaluate(e => e === document.activeElement)).toBe(true);expect(await row.getAttribute('aria-pressed')).toBe('true');
    expect(await p.locator('#trace [aria-pressed=true]').count()).toBe(1);
    expect(await p.evaluate(() => (globalThis as unknown as {scrollY:number}).scrollY)).toBe(before);
    expect(await p.locator('#step-detail').textContent()).toContain('Recorded result 60');expect(await p.locator('#step-detail').textContent()).toContain('gpt-6-luna');
    await p.close();
  });

  it('separates errors, missing results and interruption; failed settings writes retain the saved state',async()=>{
    push([run('c','claude',[step('m','workers',{lane:'host',state:'error',summary:'actual model mismatch',model:{selected:'opus',observed:'sonnet',status:'mismatch',selectedEffort:null,observedEffort:null}})],{state:'attention'}),run('x','codex',[step('u','router',{state:'unconfirmed'})],{state:'unconfirmed'}),run('stop','codex',[step('stop','compact',{state:'interrupted'})],{state:'interrupted'})]);const p=await page();
    expect(await stage(p,'workers').getAttribute('class')).toContain('err');expect(await p.locator('#k-diag').textContent()).toContain('실제 응답 모델 불일치 1건');expect(await stage(p,'workers').locator('.sn .d').textContent()).toMatch(/^판정 없음/);
    expect(await p.locator('#runs [data-run=x] .sub').textContent()).toMatch(/^결과 미관측 · /);expect(await p.locator('#runs [data-run=stop] .sub').textContent()).toMatch(/^사용자 중단 · /);
    await go(p,'c');expect(await p.locator('#rd-state').textContent()).toBe('확인 필요');expect(await p.locator('#rd-stats .kn.er').textContent()).toBe('1');await go(p,null);
    await p.locator('#recording').click();await p.waitForFunction(()=>document.getElementById('notice')!.textContent!.includes('저장하지 못했습니다'));expect(await p.locator('#recording').getAttribute('aria-checked')).toBe('true');
    push([run('c','claude',[step('later','compact',{durationMs:39})])]);await settle(p);expect(await p.locator('#notice').textContent()).toContain('저장하지 못했습니다');
    await p.locator('#language').click();expect(await p.locator('html').getAttribute('lang')).toBe('en');await p.close();
  });

  it('keeps live calls, stage lines and round trips on a phone, with stage scoping reachable by keyboard',async()=>{
    const steps=[call('p0','router',58,{at:ago(3000)},{choice:'sonnet · high'})];push([run('phone','codex',steps,{state:'active'})]);const p=await page(390,844);await settle(p);await record(p);
    steps.push(call('p1','router',43,{},{choice:'haiku · low'}));push([run('phone','codex',steps,{state:'active'})]);
    await p.waitForFunction(()=>document.querySelector('#rc li:first-child .ms')?.textContent==='43ms');expect(await stage(p,'router').locator('.sn .d').textContent()).toMatch(/^haiku · low/);
    await wait(600);expect(count(await motion(p),'lane')).toBe(1);
    await p.screenshot({path:join(output,'mobile-overview.png'),fullPage:true});
    await stage(p,'allocation').focus();await p.keyboard.press('Enter');expect(await stage(p,'allocation').getAttribute('aria-pressed')).toBe('true');
    expect(await p.locator('#stages [aria-pressed=true]').count()).toBe(1);expect(await p.locator('#log-filter').textContent()).toBe('Gate B만');expect(await problems(p)).toEqual([]);await p.close();
  });

  it('reconnects the real event stream and preserves theme/language after a reload', async () => {
    push([run('reconnect', 'claude', [call('a', 'admission', 60)])]); const p = await page();
    await p.locator('#theme').click(); await p.locator('#language').click();
    expect(await p.locator('html').getAttribute('data-theme')).toBe('light');
    for (const client of clients) client.end();
    await p.waitForFunction(() => document.getElementById('connection')!.textContent === 'Reconnecting');
    await p.waitForFunction(() => document.getElementById('connection')!.textContent!.startsWith('Live'), undefined, { timeout: 10000 });
    expect(await p.locator('#j-wire .lane').count()).toBe(0);
    await p.reload(); await p.waitForSelector('#stages button.st');
    expect(await p.locator('html').getAttribute('lang')).toBe('en');
    expect(await p.locator('html').getAttribute('data-theme')).toBe('light');
    expect(await p.locator('#stages button.st').count()).toBe(5); await p.close();
  });
});
