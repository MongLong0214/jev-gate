import { createServer, type ServerResponse } from 'node:http';
import type { Window } from 'happy-dom';
// Browser globals are typed locally; adding lib.dom globally would change the Node HTTP tests.
declare const document: Window['document'];
declare const requestAnimationFrame: Window['requestAnimationFrame'];
declare const getComputedStyle: Window['getComputedStyle'];
declare const MutationObserver: Window['MutationObserver'];
declare const innerWidth: number;
declare const innerHeight: number;
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
function snapshot(runs: OperationRun[]) {
  const feed = runs.flatMap(r => r.steps.map(s => ({ ...s, host: r.host ?? 'claude', runId: r.id, runTitle: r.title }))).sort((a,b) => b.at.localeCompare(a.at));
  const ids = ['admission','allocation','planning','workers','guard','router','compact','evidence'] as const;
  const measured = feed.filter(s => s.lane==='jev' && s.durationMs!==undefined), values = measured.map(s => s.durationMs!).sort((a,b) => a-b), pct = (p: number) => values.length ? values[Math.ceil(values.length*p)-1]! : null;
  const today: Record<string, { calls: number; input: number; costUsd: number; unpriced: number }> = {};
  for (const s of measured) { const t = today[s.host] ??= { calls:0, input:0, costUsd:0, unpriced:0 }; t.calls++; t.input += s.receipt?.input ?? 0; if (s.receipt?.costUsd != null) t.costUsd += s.receipt.costUsd; else t.unpriced++; }
  return { at:ago(0), host:'mixed', unreadable:0, recording:{enabled:true}, dashboard:{enabled:true}, operations:{runs,feed,active:runs.filter(r=>r.state==='active').length,attention:runs.filter(r=>r.state==='attention').length,requests:measured.length,
    features:ids.map(id=>({id,label:id,source:'trace',count:feed.filter(s=>!s.lifecycle&&s.feature===id).length,lastAt:feed.find(s=>!s.lifecycle&&s.feature===id)?.at??null,state:feed.some(s=>!s.lifecycle&&s.feature===id)?'observed':'waiting'})),
    latency:{measured:values.length,p50:pct(.5),p95:pct(.95),fastest:values[0]??null,latest:measured[0]?.durationMs??null,recent:measured.map(s=>({at:s.at,ms:s.durationMs!})).reverse(),today}} };
}

// Actual browser, native EventSource and disposable HTTP server. No user browser, credentials or paid requests.
describe.skipIf(process.env['JEV_DASHBOARD_BROWSER_E2E'] !== '1')('dashboard Chromium runtime', () => {
  let browser: Browser; let url: string; let current: ReturnType<typeof snapshot> & { credit?: { exhausted: boolean } } = snapshot([]); const clients = new Set<ServerResponse>();
  const output = process.env['JEV_DASHBOARD_QA_DIR'] ?? join(tmpdir(), 'jev-dashboard-browser-qa');
  const errors: string[] = [];
  const server = createServer((req,res) => {
    if(req.url?.split('?')[0]==='/api/live'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(`data: ${JSON.stringify(current)}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;}
    if(req.method==='POST'){res.writeHead(503);res.end('{}');return;}
    res.writeHead(200,{'content-type':'text/html'});res.end(DASHBOARD_PAGE);
  });
  const push = (runs: OperationRun[], extra: { credit?: { exhausted: boolean } } = {}) => {current={...snapshot(runs),...extra};for(const res of clients)res.write(`data: ${JSON.stringify(current)}\n\n`);};
  const page = async (width=1440,height=900) => {const p=await browser.newPage({viewport:{width,height}});p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.waitForSelector('#pipeline .node');return p;};
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  beforeAll(async()=>{mkdirSync(output,{recursive:true});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const local='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';browser=await chromium.launch({headless:true,...(process.env['JEV_CHROMIUM_PATH']?{executablePath:process.env['JEV_CHROMIUM_PATH']}:existsSync(local)?{executablePath:local}:{} )});});
  afterAll(async()=>{const closed=new Promise<void>(r=>server.close(()=>r()));for(const res of clients)res.end();server.closeAllConnections();try{await browser?.close();}finally{await closed;}expect(errors).toEqual([]);}, 30_000);
  const settle = (p: Page) => p.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
  // Every user-reported layout defect in one pass: page overflow, text wrapping about one character per line, per-minute rate text,
  // accent bars on selected items, empty run items, and nodes or wires that overlap, clip or leave the viewport.
  const problems = (p: Page) => p.evaluate(() => {
    const out: string[] = [];if(document.documentElement.scrollWidth>innerWidth)out.push('document overflow');
    const probe=document.createElement('i');probe.style.color='var(--accent)';document.body.appendChild(probe);const accent=getComputedStyle(probe).color;probe.remove();
    const style=getComputedStyle as unknown as (node: unknown, pseudo?: string) => {boxShadow:string;borderLeftWidth:string;borderLeftColor:string;borderRightColor:string};
    for(const e of document.querySelectorAll('body *'))for(const pseudo of [undefined,'::before','::after']){const s=style(e,pseudo);if(s.boxShadow.includes('inset'))out.push('inset shadow on '+e.className);if(parseFloat(s.borderLeftWidth)>0&&s.borderLeftColor===accent&&s.borderRightColor!==accent)out.push('accent left border on '+e.className);}
    const walk=document.createTreeWalker(document.body,4);for(let n=walk.nextNode();n;n=walk.nextNode()){const text=(n.textContent||'').replace(/\s/g,'');if(text.length<2)continue;const range=document.createRange();range.selectNodeContents(n);
      const lines=new Set([...(range as unknown as {getClientRects():Array<{top:number;width:number}>}).getClientRects()].filter(r=>r.width>0).map(r=>Math.round(r.top))).size;if(lines>1&&lines>=text.length/2)out.push('character wrap: '+text);}
    if(/\/분|최근 1분|분당|처리량|\/min|per minute|throughput/i.test((document.body as unknown as {innerText:string}).innerText))out.push('rate text');
    for(const li of document.querySelectorAll('#runs li'))if(!li.textContent?.trim()||li.classList.contains('empty')&&li.querySelector('.sel'))out.push('empty run item');
    for(const b of document.querySelectorAll('#runs .row'))if(!b.querySelector('.nm b')?.textContent?.trim())out.push('run row without a title');
    const nodes=[...document.querySelectorAll('#pipeline .node')].map(e=>e.getBoundingClientRect());if(nodes.length!==8)out.push('node count '+nodes.length);
    nodes.forEach((a,i)=>{if(a.width<120)out.push('narrow node');if(a.left<0||a.right>innerWidth+1)out.push('offscreen node');for(const b of nodes.slice(i+1))if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)out.push('overlapping nodes');});
    for(const e of document.querySelectorAll('#pipeline .node :is(.t,.dec)')){const box=e as unknown as {scrollWidth:number;clientWidth:number};if(box.scrollWidth>box.clientWidth+1)out.push('clipped node text: '+e.textContent);}
    for(const l of document.querySelectorAll('#pipeline svg.wires line')){const r=l.getBoundingClientRect();if(!r.height)continue;if(nodes.some(n=>r.left>n.left+1&&r.left<n.right-1&&r.top<n.bottom-1&&r.bottom>n.top+1))out.push('wire crosses a node');}
    if(nodes[0]!.top>innerHeight-100)out.push('circuit below the first viewport: '+Math.round(nodes[0]!.top));
    for(const e of document.querySelectorAll('.stat dd.s')){const box=e as unknown as {scrollWidth:number;clientWidth:number};if(box.scrollWidth>box.clientWidth+1)out.push('clipped header line: '+e.textContent);}
    // Below 900 px the call log cannot fit every column, as in the mock; it must then scroll inside its card rather than clip.
    for(const e of document.querySelectorAll('.tw')){const box=e as unknown as {scrollWidth:number;clientWidth:number};if(box.scrollWidth>box.clientWidth+1&&(innerWidth>900||getComputedStyle(e).overflowX!=='auto'))out.push('call log does not fit: '+box.scrollWidth+' > '+box.clientWidth);}
    const search=document.getElementById('search') as unknown as {clientWidth:number};if(search.clientWidth<100)out.push('search box too narrow: '+search.clientWidth);
    return out;
  });
  // Records motion as it happens: dots leaving, rail pings, latency labels, node flashes and new call-log rows, each with its page time.
  const record = (p: Page) => p.evaluate(() => {const log:Array<[string,number]>=[];(globalThis as unknown as {motion:typeof log}).motion=log;let lat:string|null|undefined=document.querySelector('.rail .lat')?.textContent;
    new MutationObserver(list=>{const t=performance.now(),flashed=new Set<unknown>();for(const m of list){const target=m.target as unknown as {classList:{contains(c:string):boolean};dataset:{feature?:string};textContent:string|null};
      if(m.type==='attributes'&&target.classList.contains('zap')&&!String(m.oldValue).includes('zap')&&!flashed.has(target)&&flashed.add(target))log.push(['zap:'+(target.dataset.feature||'run'),t]);
      if(m.type!=='childList')continue;if(target.classList.contains('lat')&&target.textContent!==lat){lat=target.textContent;log.push(['lat:'+lat,t]);}
      for(const n of m.addedNodes as unknown as Array<{classList?:{contains(c:string):boolean};tagName?:string;parentElement?:{classList:{contains(c:string):boolean}}|null}>){if(n.classList?.contains('trip'))log.push(['trip',t]);if(n.tagName==='B'&&n.parentElement?.classList.contains('ln'))log.push(['ping',t]);if(n.tagName==='TR'&&n.classList?.contains('in'))log.push(['row',t]);}}})
      .observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class'],attributeOldValue:true});});
  const motion = (p: Page) => p.evaluate(() => (globalThis as unknown as {motion:Array<[string,number]>}).motion);
  const count = (log: Array<[string,number]>, kind: string) => log.filter(([k]) => k===kind).length;

  it('shows live version status without overflow in the actual browser', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-dashboard-version-'));
    const releaseFetch = (async () => new Response(JSON.stringify({ tag_name: 'v0.8.20', draft: false, prerelease: false, html_url: 'https://github.com/MongLong0214/jev-gate/releases/tag/v0.8.20' }))) as typeof fetch;
    const local = await startDashboard(dashboardSources({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), JEV_GATE_TRACE_DIR: join(home, 'claude-traces'), JEV_CODEX_TRACE_DIR: join(home, 'codex-traces') }), 0, { releaseFetch });
    try {
      for (const width of [1440, 390, 320]) {
        const p = await browser.newPage({ viewport: { width, height: 900 } });
        p.on('pageerror', e => errors.push(e.message));
        await p.goto(local.url);
        await p.waitForFunction(() => document.getElementById('version-badge')?.textContent?.includes('0.8.20'));
        expect(await p.locator('#version-badge').getAttribute('data-state')).toBe('update');
        expect(await p.locator('#version-badge').textContent()).toContain('0.8.19');
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
    try {
      for (const p of [a, b]) { p.on('pageerror', e => errors.push(e.message)); await p.goto(local.url); await p.waitForFunction(() => document.getElementById('connection')?.textContent === '실시간 연결'); }
      local.ensureOpen(); expect(opened).toHaveLength(0);
      await a.reload(); await a.waitForFunction(() => document.getElementById('connection')?.textContent === '실시간 연결');
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
      expect(await p.locator('#k-p50').textContent()).toBe('92');expect(await p.locator('#k-p95').textContent()).toBe('p95 181ms · 표본 2');
      expect(await p.locator('#k-today').textContent()).toBe('오늘 2회');expect(await p.locator('#k-last').textContent()).toMatch(/^마지막 응답 (\d\.\d초|\d+초) 전$/);
      expect(await p.locator('#comm i').count()).toBe(2);expect(await p.locator('#comm').getAttribute('aria-hidden')).toBe('true');
      expect(await p.locator('.stats').evaluate(e=>e.getBoundingClientRect().top)).toBeLessThan(260);
      expect(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
      await p.emulateMedia({reducedMotion:'reduce'});expect(await p.locator('#comm i').first().evaluate(e=>getComputedStyle(e).animationName)).toBe('none');
      await p.screenshot({path:join(output,`top-${width}.png`)});await p.close();
    }
  });

  it('counts running executions from runs rather than the recent feed and scopes them by host', async () => {
    push([run('old-active','codex',[step('old-tool','workers',{lifecycle:true,lane:'host',state:'active',startedAt:ago(0)})],{state:'active'}),run('new','claude',[call('new-output','compact',80)])]);
    current.operations.feed=current.operations.feed.filter(event=>event.id!=='old-tool');
    const p=await page();await settle(p);
    expect(await p.locator('#k-active').textContent()).toBe('1');expect(await p.locator('#k-hosts').textContent()).toBe('Claude 0 · Codex 1');
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
    expect(await p.locator('#k-active').textContent()).toBe('1');expect(await p.locator('#rd-state').textContent()).toBe('진행 중');
    show([request, { ...response, request_id: 'another-request' }]);await settle(p);
    expect(await p.locator('#k-active').textContent()).toBe('1');
    show([request, response]);
    await p.waitForFunction(() => document.getElementById('k-active')?.textContent === '0');
    expect(await p.locator('#trace').textContent()).toContain('gpt-6-luna');
    expect(await p.locator('#trace .sd:not([hidden])').textContent()).toContain('일치');
    await p.close();
  });

  it('separates current incidents from past error records in the header, filters and stage detail, and reclassifies them live (#223)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-dashboard-223-')), claude = join(home, 'claude-traces'), codex = join(home, 'codex-traces');
    mkdirSync(claude); mkdirSync(codex);
    const write = (dir: string, name: string, value: object) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
    const evidence = (request_id: string, session_id: string, written_at: string, extra: object) => ({ phase: 'evidence_result', host: 'codex', session_id, request_id, written_at, backend: 'local', items: 0, remote_calls: 0, cache_hits: 0, duration_ms: 0, coverage: { read_files: 0, candidates: 0, unjudged_on_page: 0 }, ...extra });
    const jev = (parent: string, session_id: string, written_at: string, code: string, status: number) => ({ phase: 'evidence_jev_result', host: 'codex', session_id, request_id: `${parent}:1`, parent_request_id: parent, written_at, attempted: true, candidates: 3, http: { status, code, duration_ms: 140 } });
    const router = (turn: string, session_id: string, written_at: string, confirmation: string, observed: string | null) => ({ phase: 'claude_router', host: 'claude', session_id, event: 'root_result', turn, written_at, requested: 'claude-opus-5-5', observed, confirmation });
    // The reported case: yesterday's Codex invalid-input refusal followed by successful Evidence, beside a current outage and a model check.
    write(codex, 'ev-old', evidence('ev-old', 'codex-old-session', ago(26 * 3_600_000), { status: 'unavailable', is_error: true, reason_codes: ['invalid_input'] }));
    write(codex, 'ev-ok', evidence('ev-ok', 'codex-new-session', ago(3_600_000), { status: 'ok', is_error: false, items: 3, remote_calls: 1, reason_codes: [] }));
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
      expect(await p.locator('#k-att').textContent()).toBe(count('attention'));
      expect(await p.locator('#state-filters [data-state=attention] em').textContent()).toBe(count('attention'));
      expect(await p.locator('#state-filters [data-state=past_error] em').textContent()).toBe(count('past_error'));
      await p.locator('#state-filters [data-state=all]').click();
      for (const r of runs) expect(await p.locator(`#runs [data-run="${r.id}"] .c-st`).textContent()).toBe(label[r.state]);
      return s;
    };
    try {
      const p = await page();await p.goto(local.url);await p.waitForFunction(() => document.querySelectorAll('#runs .row').length === 6);
      let s = await agree(p);
      expect(await p.locator('#k-att').textContent()).toBe('3');
      const diag = await p.locator('#k-diag').textContent();expect(diag).toContain('Jev 판정 오류 2건');expect(diag).toContain('실제 응답 모델 불일치 1건');expect(diag).not.toContain('Evidence');
      await p.locator('[data-host=codex]').click();await agree(p, 'codex');await p.locator('[data-host=claude]').click();await agree(p, 'claude');await p.locator('[data-host=all]').click();
      const outage = runOf(s, 'http_401', 'unknown'), refused = runOf(s, 'invalid_input', 'request_only');
      await p.locator('[data-state=attention]').click();await p.locator(`#runs [data-run="${outage}"]`).click();
      const detail = () => p.locator('#trace .sd:not([hidden])').textContent();
      for (const fact of ['원인http_401', '현재 영향현재 영향 미확인', '호스트Codex', '세션codex-session-b', '마지막 관측']) expect(await detail()).toContain(fact);
      expect(await problems(p)).toEqual([]);
      await p.locator('.stats').screenshot({ path: join(output, '223-1440-dark-ko-top.png') });await p.locator('#run-detail').screenshot({ path: join(output, '223-1440-dark-ko-detail-current.png') });
      await p.locator('[data-state=past_error]').click();await p.locator(`#runs [data-run="${refused}"]`).click();
      for (const fact of ['상태오류', '원인invalid_input · 요청 인자·범위 오류', '현재 영향이 요청만 실패 · 서비스 장애 아님', '세션codex-old-session']) expect(await detail()).toContain(fact);
      await p.locator('#run-detail').screenshot({ path: join(output, '223-1440-dark-ko-detail-past.png') });
      // A later success of the same Jev call on the same host arrives on the open stream; both outage records become past errors.
      await p.locator('[data-state=attention]').click();await p.locator(`#runs [data-run="${outage}"]`).click();
      write(codex, 'jev-3', jev('j3', 'codex-session-c', ago(0), 'ok', 200));
      await p.waitForFunction(() => document.getElementById('k-att')?.textContent === '1');
      s = await agree(p);
      expect(s.operations.runs.find(r => r.id === outage)).toMatchObject({ state: 'past_error', steps: [{ cause: 'http_401', impact: { now: 'later_ok' } }] });
      expect(await p.locator('#k-diag').textContent()).toBe('실제 응답 모델 불일치 1건');
      await p.locator('[data-state=past_error]').click();expect(await p.locator('#runs .row').count()).toBe(3);await p.locator(`#runs [data-run="${outage}"]`).click();
      expect(await detail()).toContain('현재 영향이후 같은 작업 정상 기록');expect(await detail()).toContain('상태오류');
      await p.locator('[data-host=codex]').click();expect(await p.locator('#k-diag').textContent()).toBe('지난 오류 3건');await agree(p, 'codex');
      await p.locator('#language').click();expect(await p.locator('#k-diag').textContent()).toBe('3 past errors');await p.locator('#language').click();await p.close();
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });phone.on('pageerror', e => errors.push(e.message));await phone.goto(local.url);
      await phone.waitForFunction(() => document.querySelectorAll('#runs .row').length === 7);await agree(phone);expect(await problems(phone)).toEqual([]);
      await phone.locator('.stats').screenshot({ path: join(output, '223-390-top.png') });
      await phone.locator('[data-state=attention]').click();await phone.locator('#run-detail').screenshot({ path: join(output, '223-390-detail-current.png') });
      await phone.locator('[data-state=past_error]').click();await phone.locator(`#runs [data-run="${refused}"]`).click();await phone.locator('#run-detail').screenshot({ path: join(output, '223-390-detail-past.png') });
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
    type Snap = { operations: { attention: number; runs: Array<{ id: string; host: string; state: string; steps: Array<{ outcome?: string; cause?: string; details: string[]; impact?: { now: string } }> }> } };
    const snap = async () => await (await fetch(new URL('/api/snapshot', local.url))).json() as Snap;
    try {
      let s = await snap();
      const refused = (cause: string) => s.operations.runs.find(r => r.steps.some(x => x.outcome === 'rejected' && x.cause === cause))!;
      expect(s.operations.attention).toBe(2); expect(refused('check_unobserved')).toMatchObject({ host: 'claude', state: 'attention' }); expect(refused('worker_blocked')).toMatchObject({ host: 'codex', state: 'attention' });
      expect(refused('check_unobserved').steps.find(x => x.outcome === 'rejected')!.details).toContain('실행 기록 read · 미관측 #1');
      expect(refused('worker_blocked').steps.find(x => x.outcome === 'rejected')!.details).toContain('worker 보고 pass 0 · fail 1 · 미실행 0');
      expect(s.operations.runs.flatMap(r => r.steps).filter(x => x.outcome === 'host_ended')).toHaveLength(3);
      for (const secret of [unobserved, blocked, 'worker reply text', 'reply note', 'npm test']) expect(JSON.stringify(s)).not.toContain(secret);
      const p = await page();await p.goto(local.url);await p.waitForFunction(() => document.getElementById('k-att')?.textContent === '2');
      expect(await p.locator('#k-diag').textContent()).toBe('워커 계약 미충족 2건');
      for (const r of [refused('check_unobserved'), refused('worker_blocked')]) expect(await p.locator(`#runs [data-run="${r.id}"] .c-st`).textContent()).toBe('확인 필요');
      const id = refused('check_unobserved').id, marks = () => p.locator('#trace .sx-r').allTextContents(), detail = () => p.locator('#trace .sd:not([hidden])').textContent();
      await p.locator(`#runs [data-run="${id}"]`).click();
      // The host end and the policy delivery after it are kept as lifecycle records; neither shows as a completed stage here.
      expect(await marks()).toEqual(['계약 미충족']);
      for (const fact of ['single · 계약 미충족 · incomplete · 통과 보고 검사의 실행 미관측', '실행 기록 read · 미관측 #1', '원인check_unobserved', '현재 영향현재 영향 미확인', '세션claude-232']) expect(await detail()).toContain(fact);
      expect(await problems(p)).toEqual([]);
      await p.locator('#run-detail').screenshot({ path: join(output, '232-1440-dark-ko-detail-rejected.png') });
      await p.locator(`#runs [data-run="${refused('worker_blocked').id}"]`).click();
      expect(await detail()).toContain('single · 계약 미충족 · incomplete · 워커가 차단·재계획 보고');
      await p.locator('#run-detail').screenshot({ path: join(output, '232-1440-dark-ko-detail-blocked.png') });
      // A genuine retry of the same task is accepted later on the open stream: it is its own record, and the refusal stays as it was.
      write(claude, 'retry', post(c, ago(0), 'sonnet', 'accept', null, { pass: 1, fail: 0, not_run: 0 }, { transcript: 'read', contradicted: [], unobserved: [], stale: [] }));
      await p.waitForFunction(() => document.getElementById('k-att')?.textContent === '1');
      s = await snap();
      const retried = s.operations.runs.find(r => r.id === id)!;
      expect(retried.state).toBe('past_error'); expect(retried.steps.filter(x => x.outcome === 'rejected' || x.outcome === 'accepted').map(x => [x.outcome, x.impact?.now ?? null])).toEqual([['rejected', 'later_ok'], ['accepted', null]]);
      await p.locator('[data-state=past_error]').click();await p.locator(`#runs [data-run="${id}"]`).click();
      expect(await p.locator(`#runs [data-run="${id}"] .c-st`).textContent()).toBe('지난 오류');
      expect(await marks()).toEqual(expect.arrayContaining(['계약 미충족', '계약 수락'])); expect(await detail()).toContain('현재 영향이후 같은 작업 정상 기록');
      await p.locator('#run-detail').screenshot({ path: join(output, '232-1440-dark-ko-detail-retried.png') });
      await p.locator('#language').click();expect(await marks()).toEqual(expect.arrayContaining(['Contract not met', 'Contract accepted']));
      expect(await detail()).toContain('Reported pass not seen in the worker transcript');await p.locator('#language').click();
      await p.close();
    } finally { await local.close(); rmSync(home, { recursive: true, force: true }); }
  }, 60_000);

  it('labels request effort discrepancies precisely in the header and the stage detail', async () => {
    push([run('effort', 'codex', [step('old', 'router', { at: ago(7_200_000), lane: 'host', state: 'error', issue: 'request_effort', summary: '선택 high · 전송 xhigh' }), step('recent', 'router', { lane: 'host' })], { state: 'attention' })]);
    const p = await page();
    expect(await p.locator('#k-att').textContent()).toBe('1');expect(await p.locator('#k-diag').textContent()).toContain('API 전송 effort 불일치 1건');
    expect(await p.locator('[data-step=old]').getAttribute('aria-expanded')).toBe('true');expect(await p.locator('#trace .sd:not([hidden])').textContent()).toContain('선택 high · 전송 xhigh');
    await p.close();
  });

  it('keeps the call log at eight rows of fixed height, holds it on demand and shows only recorded values', async () => {
    const calls=[call('c1','router',120,{at:ago(1000)},{choice:'sonnet · high',threshold:0.6}),call('c2','admission',80,{executionPath:'direct'},{confidence:null,input:null,output:null,costUsd:null})];
    push([run('rc','claude',calls,{title:'호출 기록 실행'})]);const p=await page();await settle(p);
    const cells=(i:number)=>p.locator(`#rc tr:nth-child(${i}) td`).allTextContents();
    expect(await p.locator('#rc tr').count()).toBe(8);
    expect((await cells(1)).slice(1)).toEqual(['호출 기록 실행','Gate A','실행 형태?','직접','–','80ms','–','–']);
    expect((await cells(2)).slice(1)).toEqual(['호출 기록 실행','Router','이 턴 모델?','sonnet · high','0.87','120ms','1.2K → 40','≈$0.00120']);
    const heights=()=>p.evaluate(()=>({rows:[...document.querySelectorAll('#rc tr')].map(e=>e.getBoundingClientRect().height),panel:document.querySelector('.jev')!.getBoundingClientRect().height,below:document.getElementById('run-detail')!.getBoundingClientRect().top+document.documentElement.scrollTop}));
    const before=await heights();expect(new Set(before.rows).size).toBe(1);
    for(let i=0;i<9;i++)calls.push(call('more'+i,'compact',60+i,{at:ago((9-i)*10)}));push([run('rc','claude',calls,{title:'호출 기록 실행'})]);
    await p.waitForFunction(()=>document.querySelector('#rc tr td:nth-child(7)')?.textContent==='68ms',undefined,{timeout:8000});
    const after=await heights();expect(after.rows).toEqual(before.rows);expect(after.panel).toBe(before.panel);expect(after.below).toBe(before.below);
    await p.locator('[data-rc=hold]').click();expect(await p.locator('[data-rc=hold]').getAttribute('aria-pressed')).toBe('true');const held=await cells(1);
    calls.push(call('late','evidence',77));push([run('rc','claude',calls,{title:'호출 기록 실행'})]);
    await p.waitForFunction(()=>document.getElementById('rc-new')?.textContent==='+1 새 기록',undefined,{timeout:8000});expect(await cells(1)).toEqual(held);
    await p.locator('[data-rc=live]').click();expect((await cells(1))[6]).toBe('77ms');expect(await p.locator('#rc-new').textContent()).toBe('');
    expect(await p.locator('#rc').evaluate(e=>e.closest('table')!.querySelectorAll('th:not([scope=col])').length)).toBe(0);
    await p.close();
  });

  it('reports the Jev panel from recorded calls, colours failures and estimates cost from list prices', async () => {
    const calls=[call('j1','router',120,{at:ago(4000)},{choice:'sonnet · high'}),call('j2','admission',80,{at:ago(3000)},{model:'unknown-model',costUsd:null}),call('j3','evidence',300,{state:'error',at:ago(2000)},{status:402,code:'payment_required',model:null,input:null,output:null,costUsd:null,confidence:null}),call('j4','compact',90,{},{status:429,code:'rate_limited'})];
    push([run('j','claude',calls)],{credit:{exhausted:true}});
    for(const width of [1440,768,320]){
      const p=await page(width);await settle(p);
      expect(await p.locator('#j-p50').textContent()).toBe('90');expect(await p.locator('#j-latest').textContent()).toBe('90ms');expect(await p.locator('#j-p95').textContent()).toBe('300ms');expect(await p.locator('#j-today').textContent()).toBe('4회');
      expect(await p.locator('#j-cost').textContent()).toBe('≈ $0.00240');expect(await p.locator('#j-cost-note').textContent()).toContain('응답 2회는 제외');expect(await p.locator('#j-cost-note').textContent()).toContain('실제 차감 크레딧은 API가 알려주지 않습니다');
      expect(await p.locator('#ct i.e').count()).toBe(1);expect(await p.locator('#ct i.w').count()).toBe(1);expect(await p.locator('#ct i').count()).toBe(4);
      expect(await p.locator('#credit').textContent()).toBe('크레딧 소진');
      expect(await problems(p)).toEqual([]);await p.locator('.js').screenshot({path:join(output,`jev-panel-${width}.png`)});await p.close();
    }
    push([run('j','claude',[call('u','router',70,{},{model:null,costUsd:null})])]);const p=await page();await settle(p);expect(await p.locator('#j-cost').textContent()).toBe('–');await p.close();
  });

  it('renders empty and long mixed-host data in 28 viewport/theme/language states without overflow, overlap, character wrapping, rate text or accent bars',async()=>{
    const long='long '.repeat(60);
    push([run('c','claude',[call('a','admission',63,{executionPath:'direct'}),call('b','allocation',88,{},{choice:'claude-sonnet-5'}),step('w','workers',{lane:'host',summary:long,model:{selected:'claude-opus-5-5',observed:'claude-sonnet-5',status:'mismatch',selectedEffort:null,observedEffort:null}}),call('r','router',91,{},{choice:'sonnet · medium',threshold:0.6,direction:'downgrade'})],{title:'Claude '+long,state:'active'}),
      run('x','codex',[call('xr','router',140,{},{choice:'gpt-6.1-sol · minimal'}),step('g','guard',{lane:'policy',summary:'허용'}),call('e','evidence',70,{summary:'<img src=x onerror="alert(1)">'},{status:402,code:'payment_required',costUsd:null}),call('k','compact',220)],{title:'Codex '+long,state:'attention'})]);
    const failures:string[]=[];
    for(const [width,height] of [[1920,1080],[1440,900],[1280,800],[1024,768],[768,1024],[390,844],[320,740]] as const){
      const p=await page(width,height);
      for(const theme of ['dark','light'])for(const lang of ['ko','en']){
        await p.evaluate(({theme,lang})=>{document.documentElement.dataset.theme=theme;if(document.documentElement.lang!==lang)(document.getElementById('language') as unknown as {click():void}).click();},{theme,lang});await p.waitForTimeout(900);
        const found=await problems(p);
        if(width===320)await p.screenshot({path:join(output,`320-${theme}-${lang}-viewport.png`)});await p.screenshot({path:join(output,`${width}-${theme}-${lang}.png`),fullPage:true});if(found.length)failures.push(`${width} ${theme} ${lang}: ${found.join(' | ')}`);
      }
      expect(await p.locator('img').count()).toBe(0);await p.close();
    }
    expect(failures).toEqual([]);
    push([]);const p=await page();expect(await p.locator('#pipeline .node').count()).toBe(8);expect(await p.locator('.trip').count()).toBe(0);expect(await p.locator('#circuit-inspector .kv dd').first().textContent()).toBe('–');
    expect(await p.locator('#runs li').allTextContents()).toEqual(['조건에 맞는 실행이 없습니다.']);expect(await p.locator('#rc tr').count()).toBe(8);expect(await problems(p)).toEqual([]);await p.close();
  },180_000);

  it('keeps the Router decision segments and the node footer still across 3 s of live updates', async () => {
    const values=['sonnet · high','gpt-6.1-sol · minimal','haiku · low','opus · xhigh','gpt-6-astra · none','fable · medium','sonnet · max'];
    for(const [width,lang] of [[1440,'ko'],[320,'en']] as const){
      const steps=[call(`g${width}-0`,'router',120,{},{choice:values[0]!})];push([run('geo','claude',steps,{state:'active'})]);
      const p=await page(width);if(lang==='en')await p.locator('#language').click();await settle(p);
      const sampling=p.evaluate(()=>new Promise<{moved:string[];texts:number;frames:number}>(resolve=>{
        const parts=()=>[...document.querySelectorAll('#pipeline .node[data-feature=router] :is(.dec,.dec b,.dec b span,.foot,.ago)')];
        const box=(e:{getBoundingClientRect():{left:number;top:number;width:number;height:number}})=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.width,r.height].map(v=>v.toFixed(2)).join(',')};
        const first=parts().map(box),moved=new Set<string>(),texts=new Set<string>(),end=performance.now()+3000;let frames=0;
        const frame=()=>{frames++;const now=parts();if(now.length!==first.length)moved.add('segment count '+now.length);now.forEach((e,i)=>{if(box(e)!==first[i])moved.add(e.className+' '+e.textContent+' '+box(e)+' was '+first[i])});texts.add(document.querySelector('#pipeline .node[data-feature=router] .dec b')!.textContent!);
          if(performance.now()<end)requestAnimationFrame(frame);else resolve({moved:[...moved],texts:texts.size,frames})};requestAnimationFrame(frame);}));
      for(let k=1;k<=10;k++){await wait(250);steps.push(call(`g${width}-${k}`,'router',80+37*(k%5),{},{choice:values[k%values.length]!}));push([run('geo','claude',steps,{state:'active'})]);}
      const result=await sampling;expect(result.moved,`${width}`).toEqual([]);expect(result.texts).toBeGreaterThan(3);expect(result.frames).toBeGreaterThan(60);
      expect(await p.locator('#pipeline .node[data-feature=router] .dec b span').allTextContents()).toHaveLength(2);await p.close();
    }
  });

  it('plays one round trip per recorded Jev call, staggers a frame across its interval and gives other records a flash and a tick only', async () => {
    const steps=[call('rt0','admission',60)];push([run('rt','claude',steps,{state:'active'})]);const p=await page();await settle(p);await record(p);
    const comm=await p.locator('#comm i').count();await wait(1000);
    steps.push(call('rt1','router',90,{at:ago(600)},{choice:'haiku · low'}),step('pol','guard',{lane:'policy',at:ago(450),summary:'허용'}),call('rt2','compact',110,{at:ago(300)}),call('rt3','evidence',70));push([run('rt','claude',steps,{state:'active'})]);
    await p.waitForSelector('.trip',{state:'attached'});push([run('rt','claude',steps,{state:'active'}),run('other','codex',[step('o','planning',{lane:'host'})])]);
    await vi.waitFor(async()=>expect(count(await motion(p),'row')).toBe(3),{timeout:8000});await settle(p);const log=await motion(p);
    expect(count(log,'trip')).toBe(6);expect(count(log,'ping')).toBe(3);expect(log.filter(([k])=>k.startsWith('lat:')).map(([k])=>k)).toEqual(['lat:90ms','lat:110ms','lat:70ms']);
    expect(log.filter(([k])=>k.startsWith('zap:')&&k!=='zap:run').map(([k])=>k).sort()).toEqual(['zap:compact','zap:evidence','zap:guard','zap:planning','zap:router']);
    const pings=log.filter(([k])=>k==='ping').map(([,t])=>t);expect(pings[2]!-pings[0]!).toBeGreaterThan(300);
    for(const feature of ['router','compact','evidence']){const at=(k:string)=>log.find(([x])=>x===k)![1];expect(at('zap:'+feature)).toBeGreaterThan(pings[0]!);}
    expect(log.findIndex(([k])=>k==='trip')).toBeLessThan(log.findIndex(([k])=>k==='ping'));
    expect(await p.locator('#comm i').count()).toBe(comm+3);expect(await p.locator('#pipeline .node[data-feature=guard] .strip i').count()).toBe(1);
    expect(await p.locator('#rc tr:first-child td:nth-child(3)').textContent()).toBe('Evidence');expect(await p.locator('#runs [data-run=rt] .jc .n').textContent()).toBe('4');
    expect(await p.locator('#runs [data-run=rt] .md .rec em').last().textContent()).toBe('Evidence');
    expect(await p.locator('.trip').count()).toBe(0);expect(await p.locator('.rail .lat').textContent()).toBe('70ms');
    await p.locator('#pipeline').screenshot({path:join(output,'circuit-after-trips.png')});await p.close();
  });

  it('stops motion and freezes values on pause, disconnection and reduced motion without inventing traffic', async () => {
    const steps=[call('m0','router',50,{},{choice:'sonnet · high'})];push([run('m','claude',steps,{state:'active'})]);const p=await page();await settle(p);await record(p);
    const ago0=p.locator('#pipeline .node[data-feature=router] .ago');
    await p.locator('#pause').click();expect(await p.locator('body').getAttribute('class')).toContain('still');expect(await p.locator('#connection').textContent()).toBe('연결됨 · 화면 일시정지');
    expect(await p.locator('#pipeline .node[data-feature=router] .strip i').first().evaluate(e=>getComputedStyle(e).animationPlayState)).toBe('paused');
    const frozen=[await ago0.textContent(),await p.locator('#k-last').textContent()];
    steps.push(call('m1','router',95,{},{choice:'haiku · low'}));push([run('m','claude',steps,{state:'active'})]);await wait(2200);
    expect(await motion(p)).toEqual([]);expect(await p.locator('.rail .lat').textContent()).toBe('50ms');expect([await ago0.textContent(),await p.locator('#k-last').textContent()]).toEqual(frozen);
    expect(await p.locator('#rc tr:first-child td:nth-child(7)').textContent()).toBe('50ms');
    await p.locator('#pause').click();await p.waitForFunction(()=>document.querySelector('.rail .lat')?.textContent==='95ms');expect(count(await motion(p),'ping')).toBe(1);
    for(const client of clients)client.end();clients.clear();
    await p.waitForFunction(()=>document.getElementById('connection')!.classList.contains('warn'));expect(await p.locator('body').getAttribute('class')).toContain('still');
    const offline=await ago0.textContent();await wait(1200);expect(await ago0.textContent()).toBe(offline);
    await p.waitForFunction(()=>document.getElementById('connection')!.textContent==='실시간 연결',undefined,{timeout:10000});
    await p.emulateMedia({reducedMotion:'reduce'});const before=(await motion(p)).length;
    steps.push(call('m2','router',120,{},{choice:'opus · xhigh'}));push([run('m','claude',steps,{state:'active'})]);
    await p.waitForFunction(()=>document.querySelector('.rail .lat')?.textContent==='120ms');expect((await motion(p)).slice(before).filter(([k])=>k==='trip'||k==='ping')).toEqual([]);
    expect(await p.locator('#pipeline .node[data-feature=router] .dec b').textContent()).toBe('opusxhigh');
    expect(await p.locator('#comm i').first().evaluate(e=>getComputedStyle(e).animationName)).toBe('none');await p.close();
  });

  it('filters runs from a node, scopes the circuit to the selected run and keeps focus across updates',async()=>{
    const a=call('fa','admission',60,{executionPath:'direct'}),r=call('fr','router',80,{},{choice:'sonnet · high'});push([run('c','claude',[a]),run('x','codex',[r])]);const p=await page();await settle(p);
    const node=(id:string)=>p.locator(`#pipeline .node[data-feature=${id}]`);
    await node('router').click();expect(await node('router').getAttribute('aria-pressed')).toBe('true');expect(await p.locator('#circuit-inspector h2').textContent()).toBe('Router');expect(await p.locator('#circuit-inspector').textContent()).toContain('Codex');
    expect(await p.locator('#runs .row').count()).toBe(1);expect(await p.locator('#run-count').textContent()).toBe('실행 1개 표시 · Router 기록만');
    await node('router').click();expect(await p.locator('#runs .row').count()).toBe(2);
    await node('router').focus();await record(p);push([run('c','claude',[a]),run('x','codex',[r,call('fr2','router',95,{},{choice:'haiku · low'})])]);
    await p.waitForFunction(()=>document.querySelector('#circuit-inspector')?.textContent?.includes('95ms'));expect(await node('router').evaluate(e=>e===document.activeElement)).toBe(true);
    expect(await node('admission').locator('.dec b span').allTextContents()).toEqual(['직접','0.87']);
    await p.locator('[data-circuit-mode=run]').click();await p.locator('#runs [data-run=c]').click();await settle(p);
    expect(await node('router').locator('.dec b').textContent()).toBe('–');expect(await node('admission').locator('.dec b').textContent()).toBe('직접0.87');
    const trips=(await motion(p)).length;push([run('c','claude',[a]),run('x','codex',[r,call('fr2','router',95,{},{choice:'haiku · low'}),call('fr3','router',99)])]);await wait(1200);
    expect((await motion(p)).slice(trips).filter(([k])=>k==='trip'||k==='ping')).toEqual([]);
    await p.locator('#runs [data-run=c]').focus();push([run('c','claude',[a,call('fb','allocation',70)]),run('x','codex',[r])]);await p.waitForFunction(()=>document.querySelector('#pipeline .node[data-feature=allocation] .dec b')?.textContent!=='–');
    expect(await p.locator('#runs [data-run=c]').evaluate(e=>e===document.activeElement)).toBe(true);
    await p.locator('[data-circuit-mode=live]').click();await node('evidence').click();await p.locator('#circuit-inspector button[data-inspect-feature]').click();expect(await p.locator('#search').evaluate(e=>e===document.activeElement)).toBe(true);
    await p.close();
  });

  it('never renders an empty run item and marks the selected run with a tint only',async()=>{
    push([run('a','claude',[call('ea','admission',60)]),run('b','codex',[call('eb','router',70)],{state:'attention'})]);const p=await page();await settle(p);
    const tint=(sel:string)=>p.locator(sel).evaluate(e=>getComputedStyle(e).backgroundColor);
    await p.locator('#runs [data-run=b]').click();expect(await p.locator('#runs .row.sel').count()).toBe(1);expect(await p.locator('#runs [data-run=b]').getAttribute('aria-pressed')).toBe('true');
    expect(await tint('#runs [data-run=b]')).not.toBe(await tint('#runs [data-run=a]'));expect(await problems(p)).toEqual([]);
    await p.locator('[data-state=unconfirmed]').click();expect(await p.locator('#runs li').allTextContents()).toEqual(['조건에 맞는 실행이 없습니다.']);expect(await p.locator('#runs .sel').count()).toBe(0);expect(await problems(p)).toEqual([]);
    await p.locator('[data-state=all]').click();await p.locator('#search').fill('zzz');expect(await p.locator('#runs li').allTextContents()).toEqual(['조건에 맞는 실행이 없습니다.']);
    await p.locator('#search').fill('');await p.keyboard.press('Escape');await p.locator('body').click({position:{x:2,y:2}});await p.keyboard.press('/');expect(await p.locator('#search').evaluate(e=>e===document.activeElement)).toBe(true);await p.close();
  });

  it('opens one stage at a time in the run detail and keeps its scroll and keyboard focus', async () => {
    const model = { selected: 'gpt-6-luna', observed: null, status: 'unobserved' as const, selectedEffort: 'low', observedEffort: null };
    push([run('inspection', 'codex', Array.from({length:80}, (_, i) => step('stage-'+i, 'router', {lane:'host',model})))]);
    const p = await page();
    const row = p.locator('[data-step="stage-60"]');
    await row.focus();
    const before = await p.locator('#trace').evaluate(e => e.scrollTop);
    expect(before).toBeGreaterThan(0);
    await p.keyboard.press('Enter');
    expect(await row.evaluate(e => e === document.activeElement)).toBe(true);expect(await row.getAttribute('aria-expanded')).toBe('true');
    expect(await p.locator('#trace [aria-expanded=true]').count()).toBe(1);
    expect(await p.locator('#trace').evaluate(e => e.scrollTop)).toBeCloseTo(before, 0);
    expect(await p.locator('#'+await row.getAttribute('aria-controls')).textContent()).toContain('gpt-6-luna');
    await p.keyboard.press('Enter');expect(await row.getAttribute('aria-expanded')).toBe('false');expect(await p.locator('#trace [aria-expanded=true]').count()).toBe(0);
    await p.close();
  });

  it('separates errors, missing results and interruption; failed settings writes retain the saved state',async()=>{
    push([run('c','claude',[step('m','workers',{lane:'host',state:'error',summary:'actual model mismatch',model:{selected:'opus',observed:'sonnet',status:'mismatch',selectedEffort:null,observedEffort:null}})],{state:'attention'}),run('x','codex',[step('u','router',{state:'unconfirmed'})],{state:'unconfirmed'}),run('stop','codex',[step('stop','compact',{state:'interrupted'})],{state:'interrupted'})]);const p=await page();
    expect(await p.locator('#pipeline .node[data-feature=workers]').getAttribute('class')).toContain('err');expect(await p.locator('#k-diag').textContent()).toContain('실제 응답 모델 불일치 1건');
    await p.locator('#pipeline .node[data-feature=workers]').click();expect(await p.locator('#circuit-inspector .kv dd').first().textContent()).toBe('오류');expect(await p.locator('#runs .row').count()).toBe(1);await p.locator('#pipeline .node[data-feature=workers]').click();
    await p.locator('[data-state=unconfirmed]').click();expect(await p.locator('#runs .row').count()).toBe(1);expect(await p.locator('#rd-state').textContent()).toBe('결과 미관측');
    await p.locator('[data-state=all]').click();await p.locator('#runs [data-run=stop]').click();expect(await p.locator('#rd-state').textContent()).toBe('사용자 중단');
    await p.locator('#recording').click();await p.waitForFunction(()=>document.getElementById('notice')!.textContent!.includes('저장하지 못했습니다'));expect(await p.locator('#recording').getAttribute('aria-checked')).toBe('true');
    push([run('c','claude',[step('later','compact',{durationMs:39})])]);await settle(p);expect(await p.locator('#notice').textContent()).toContain('저장하지 못했습니다');
    await p.locator('#language').click();expect(await p.locator('html').getAttribute('lang')).toBe('en');await p.close();
  });

  it('hides wires and dots on a phone while the rail ping and the decision still update, and keeps inspection reachable by keyboard',async()=>{
    const steps=[call('p0','router',58,{},{choice:'sonnet · high'})];push([run('phone','codex',steps,{state:'active'})]);const p=await page(390,844);await settle(p);await record(p);
    expect(await p.locator('#pipeline svg.wires').evaluate(e=>getComputedStyle(e).display)).toBe('none');
    steps.push(call('p1','router',43,{},{choice:'haiku · low'}));push([run('phone','codex',steps,{state:'active'})]);
    await p.waitForFunction(()=>document.querySelector('.rail .lat')?.textContent==='43ms');await p.waitForFunction(()=>document.querySelector('#pipeline .node[data-feature=router] .dec b')?.textContent==='haikulow');expect(count(await motion(p),'ping')).toBe(1);
    await p.locator('#pipeline .node[data-feature=router]').click();expect(await p.locator('#circuit-inspector').evaluate(e=>e.getBoundingClientRect().top)).toBeLessThan(100);
    await p.screenshot({path:join(output,'mobile-stage-inspection.png')});
    await p.locator('#pipeline .node[data-feature=allocation]').focus();await p.keyboard.press('Enter');expect(await p.locator('#pipeline .node[data-feature=allocation]').getAttribute('aria-pressed')).toBe('true');
    expect(await p.locator('#circuit-inspector h2').textContent()).toBe('Gate B');expect(await p.locator('#pipeline .node[aria-pressed=true]').count()).toBe(1);await p.close();
  });

  it('reconnects the real event stream and preserves theme/language after a reload', async () => {
    push([run('reconnect', 'claude', [call('a', 'admission', 60)])]); const p = await page();
    await p.locator('#theme').click(); await p.locator('#language').click();
    expect(await p.locator('html').getAttribute('data-theme')).toBe('light');
    for (const client of clients) client.end();
    await p.waitForFunction(() => document.getElementById('connection')!.textContent === 'Reconnecting');
    await p.waitForFunction(() => document.getElementById('connection')!.textContent === 'Live connection', undefined, { timeout: 10000 });
    expect(await p.locator('.trip').count()).toBe(0);
    await p.reload(); await p.waitForSelector('#pipeline .node');
    expect(await p.locator('html').getAttribute('lang')).toBe('en');
    expect(await p.locator('html').getAttribute('data-theme')).toBe('light');
    expect(await p.locator('.stats .stat').count()).toBe(4); await p.close();
  });
});
