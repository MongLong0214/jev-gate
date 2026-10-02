import { createServer, type ServerResponse } from 'node:http';
import type { Window, HTMLElement, SVGElement } from 'happy-dom';
// Browser globals are typed locally; adding lib.dom globally would change the Node HTTP tests.
declare const document: Window['document'];
declare const requestAnimationFrame: Window['requestAnimationFrame'];
declare const getComputedStyle: Window['getComputedStyle'];
declare const innerWidth: number;
declare const innerHeight: number;
type SVGPathElement = SVGElement & { getTotalLength(): number; getScreenCTM(): unknown; getPointAtLength(n: number): { matrixTransform(matrix: unknown): { x: number; y: number } } };
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DASHBOARD_PAGE } from '../src/dashboard-page.js';
import type { OperationRun, OperationStep } from '../src/operations.js';

const stamp = new Date().toISOString();
const step = (id: string, feature: OperationStep['feature'], extra: Partial<OperationStep> = {}): OperationStep => ({ id, feature, lane: 'jev', at: stamp, state: 'done', title: `${feature} recorded result`, summary: 'Recorded result', details: [], ...extra });
const run = (id: string, host: 'claude' | 'codex', steps: OperationStep[], extra: Partial<OperationRun> = {}): OperationRun => ({ id, host, title: `${host} execution ${id}`, source: 'gate', mode: 'auto', firstAt: stamp, lastAt: stamp, state: 'done', steps, ...extra });
function snapshot(runs: OperationRun[]) {
  const feed = runs.flatMap(r => r.steps.map(s => ({ ...s, host: r.host, runId: r.id, runTitle: r.title }))).sort((a,b) => b.at.localeCompare(a.at));
  const ids = ['admission','allocation','planning','workers','guard','lean','router','compact','output','evidence'] as const;
  const latency = feed.filter(s => s.lane==='jev' && s.durationMs!==undefined).map(s => ({ at:s.at, ms:s.durationMs! }));
  return { at:stamp, host:'mixed', unreadable:0, recording:{enabled:true}, dashboard:{enabled:true}, operations:{runs,feed,active:runs.filter(r=>r.state==='active').length,attention:0,requests:latency.length,
    features:ids.map(id=>({id,label:id,source:'trace',count:feed.filter(s=>!s.lifecycle&&s.feature===id).length,lastAt:feed.find(s=>!s.lifecycle&&s.feature===id)?.at??null,state:feed.some(s=>!s.lifecycle&&s.feature===id)?'observed':'waiting'})),
    latency:{measured:latency.length,p50:latency[0]?.ms??null,p95:latency.at(-1)?.ms??null,fastest:latency[0]?.ms??null,latest:latency.at(-1)?.ms??null,recent:latency},sig:JSON.stringify(runs)} };
}

// Actual browser, native EventSource and disposable HTTP server. No user browser, credentials or paid requests.
describe.skipIf(process.env['JEV_DASHBOARD_BROWSER_E2E'] !== '1')('dashboard Chromium runtime', () => {
  let browser: Browser; let url: string; let current = snapshot([]); const clients = new Set<ServerResponse>();
  const output = process.env['JEV_DASHBOARD_QA_DIR'] ?? join(tmpdir(), 'jev-dashboard-browser-qa');
  const errors: string[] = [];
  const server = createServer((req,res) => {
    if(req.url==='/api/live'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(`data: ${JSON.stringify(current)}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;}
    if(req.method==='POST'){res.writeHead(503);res.end('{}');return;}
    res.writeHead(200,{'content-type':'text/html'});res.end(DASHBOARD_PAGE);
  });
  const push = (runs: OperationRun[]) => {current=snapshot(runs);for(const res of clients)res.write(`data: ${JSON.stringify(current)}\n\n`);};
  const page = async (width=1440,height=900) => {const p=await browser.newPage({viewport:{width,height}});p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.waitForSelector('.circuit-node');return p;};
  beforeAll(async()=>{mkdirSync(output,{recursive:true});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const local='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';browser=await chromium.launch({headless:true,...(process.env['JEV_CHROMIUM_PATH']?{executablePath:process.env['JEV_CHROMIUM_PATH']}:existsSync(local)?{executablePath:local}:{} )});});
  afterAll(async()=>{await browser?.close();for(const res of clients)res.end();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));expect(errors).toEqual([]);});
  const settle = (p: Page) => p.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));

  it('renders empty and long mixed-host metadata in 28 viewport/theme/language states without overflow or overlap',async()=>{
    const a=step('a','admission',{durationMs:63}),b=step('b','allocation',{durationMs:88}),w=step('w','workers',{lane:'host',summary:'long '.repeat(180),model:{selected:'claude-opus-5-5',observed:'claude-sonnet-5',status:'mismatch',selectedEffort:null,observedEffort:null}});
    push([run('c','claude',[a,b,w]),run('x','codex',[step('r','router',{durationMs:91}),step('e','evidence',{lane:'local',summary:'<img src=x onerror="alert(1)">'})])]);
    for(const [width,height] of [[1920,1080],[1440,900],[1280,800],[1024,768],[768,1024],[390,844],[320,740]]){
      const p=await page(width,height);
      for(const theme of ['dark','light'])for(const lang of ['ko','en']){
        await p.evaluate(({theme,lang})=>{document.documentElement.dataset.theme=theme;if(document.documentElement.lang!==lang)(document.getElementById('language') as HTMLElement).click();},{theme,lang});await settle(p);
        const problems=await p.evaluate(()=>{const out:string[]=[];if(document.documentElement.scrollWidth>innerWidth)out.push('document overflow');const cards=[...document.querySelectorAll<HTMLElement>('.circuit-node')];
          for(const c of cards){const r=c.getBoundingClientRect();if(r.width<115)out.push('unreadable card width');if(c.scrollWidth>c.clientWidth+1||c.scrollHeight>c.clientHeight+1)out.push('card content clipped');if(r.left<0||r.right>innerWidth+1)out.push('offscreen card');}
          for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++){const a=cards[i]!.getBoundingClientRect(),b=cards[j]!.getBoundingClientRect();if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)out.push('overlapping nodes');}
          for(const path of document.querySelectorAll<SVGPathElement>('.wire')){const matrix=path.getScreenCTM();if(!matrix)continue;const length=path.getTotalLength();for(let i=1;i<40;i++){const point=path.getPointAtLength(length*i/40).matrixTransform(matrix);if(cards.some(c=>{const r=c.getBoundingClientRect();return point.x>r.left+1&&point.x<r.right-1&&point.y>r.top+1&&point.y<r.bottom-1}))out.push('wire crosses node '+path.getAttribute('data-edge'));}}
          const first=cards[0]!.getBoundingClientRect();if(first.top>innerHeight-100)out.push('Gate below first viewport: '+Math.round(first.top));return out;});
        if(width===320)await p.screenshot({path:join(output,`320-${theme}-${lang}-viewport.png`)});await p.screenshot({path:join(output,`${width}-${theme}-${lang}.png`),fullPage:true});expect(problems,`${width} ${theme} ${lang}`).toEqual([]);
      }await p.close();
    }
    push([]);const p=await page();expect(await p.locator('.circuit-node').count()).toBe(10);expect(await p.locator('.wire-packet').count()).toBe(0);expect(await p.locator('#circuit-inspector').textContent()).toContain('아직 실행 기록');await p.close();
  },60000);

  it('keeps stage inspection local, switches run scope and preserves focused controls across updates',async()=>{
    const a=step('a','admission'),r=step('r','router');push([run('c','claude',[a]),run('x','codex',[r])]);const p=await page();
    await p.locator('.circuit-node[data-feature=router]').click();expect(await p.locator('#circuit-inspector').textContent()).toContain('Codex');expect(await p.locator('#runs .run-row').count()).toBe(2);
    await p.locator('.circuit-node[data-feature=router]').focus();push([run('c','claude',[a]),run('x','codex',[r,step('r2','router',{summary:'new receipt'})])]);await p.waitForFunction(()=>document.getElementById('circuit-inspector')!.textContent!.includes('new receipt'));expect(await p.locator('.circuit-node[data-feature=router]').evaluate(e=>e===document.activeElement)).toBe(true);
    await p.locator('#circuit-run').focus();push([run('c','claude',[a,step('b','allocation')]),run('x','codex',[r])]);await settle(p);expect(await p.locator('#circuit-run').evaluate(e=>e===document.activeElement)).toBe(true);
    await p.selectOption('#circuit-run','x');await p.locator('.circuit-node[data-feature=allocation]').click();expect(await p.locator('#circuit-inspector').textContent()).toContain('이 실행에는');expect(await p.locator('.wire.in-run').count()).toBe(0);
    await p.selectOption('#circuit-run','c');await settle(p);expect(await p.locator('.wire.in-run').count()).toBe(1);await p.locator('.inspector-action').click();expect(await p.locator('#runs .run-row').count()).toBe(1);expect(await p.locator('#search').evaluate(e=>e===document.activeElement)).toBe(true);await p.close();
  });

  it('animates only observed consecutive transitions, detects same-ID state changes and pauses/resumes safely',async()=>{
    const a=step('a','admission',{state:'active'});push([run('c','claude',[a],{state:'active'})]);const p=await page();expect(await p.locator('.wire-packet').count()).toBe(0);
    const done={...a,state:'done' as const,durationMs:70};push([run('c','claude',[done,step('b','allocation',{state:'active'})],{state:'active'})]);await p.waitForSelector('.wire-packet.arriving',{state:'attached'});await settle(p);
    expect(await p.locator('.wire-packet').count()).toBe(1);const d=await p.locator('.wire-packet').getAttribute('d');expect(d).toMatch(/^M[\d.]+ [\d.]+ H[\d.]+$/);
    // Capture every 60 Hz sample across the 850 ms transfer. No dependency on wall-clock capture cadence.
    for(let frame=0;frame<=51;frame++){const values=await p.evaluate(t=>{const paths=[...document.querySelectorAll<SVGPathElement>('.wire-packet')];const animations=paths.flatMap(e=>e.getAnimations());for(const a of animations){a.pause();a.currentTime=t;}return paths.map(e=>({offset:parseFloat(getComputedStyle(e).strokeDashoffset),opacity:Number(getComputedStyle(e).opacity),d:e.getAttribute('d')}));},frame*1000/60);expect(values.every(v=>Number.isFinite(v.offset)&&Number.isFinite(v.opacity)&&v.d===d),JSON.stringify(values)).toBe(true);if(frame%6===0||frame===51)await p.locator('.gate-grid').screenshot({path:join(output,`transfer-${String(frame).padStart(2,'0')}.png`)});}
    await p.locator('#pause').click();push([run('c','claude',[done,step('b','allocation',{durationMs:95})])]);expect(await p.locator('#latest').textContent()).toBe('70 ms');await p.locator('#pause').click();await p.waitForFunction(()=>document.getElementById('latest')!.textContent==='95 ms');
    push([run('c','claude',[done,step('b','allocation',{durationMs:95})]),run('x','codex',[step('w','workers',{lane:'host'})])]);await settle(p);expect(await p.locator('.wire-packet[data-edge="allocation:workers"]').count()).toBe(0);
    await p.locator('[data-host=codex]').click();expect(await p.locator('.wire-packet').count()).toBe(0);await p.close();
  });


  it('isolates transfer animation by execution, keeps selection focus and renders the recorded direct branch', async () => {
    const a = step('a', 'admission'), b = step('b', 'allocation');
    push([run('one', 'claude', [a, b]), run('two', 'codex', [step('x', 'admission')])]);
    const p = await page();
    await p.locator('#circuit-run').focus();
    await p.selectOption('#circuit-run', 'one');
    expect(await p.locator('#circuit-run').evaluate(e => e === document.activeElement)).toBe(true);
    await p.locator('.circuit-node[data-feature=admission]').click();
    push([run('one', 'claude', [a, b]), run('two', 'codex', [step('x', 'admission'), step('y', 'allocation')])]);
    await p.waitForFunction(() => document.querySelectorAll('#circuit-run option').length === 2);
    await settle(p);
    expect(await p.locator('.wire-packet').count()).toBe(0);
    await p.locator('[data-circuit-mode=live]').click();
    expect(await p.locator('.wire-packet').count()).toBe(0);
    push([run('direct', 'claude', [step('direct', 'admission', { executionPath: 'direct', lane: 'jev', summary: 'direct · selected' })])]);
    await p.waitForSelector('.circuit-direct.recorded');
    await p.selectOption('#circuit-run', 'direct');
    await settle(p);
    expect(await p.locator('.wire.in-run[data-edge="admission:direct"]').count()).toBe(1);
    expect(await p.locator('.wire.in-run[data-edge="admission:allocation"]').count()).toBe(0);
    expect(await p.locator('.circuit-node[data-feature=admission]').textContent()).toContain('루트에서 직접 처리');
    expect(await p.locator('.circuit-direct').textContent()).toContain('실행 완료와 별도');
    await p.close();
  });
  it('separates errors, missing results and interruption; failed settings writes retain the saved state',async()=>{
    push([run('c','claude',[step('m','workers',{lane:'host',state:'error',summary:'actual model mismatch',model:{selected:'opus',observed:'sonnet',status:'mismatch',selectedEffort:null,observedEffort:null}})],{state:'attention'}),run('x','codex',[step('u','router',{state:'unconfirmed'})],{state:'unconfirmed'}),run('stop','codex',[step('stop','output',{state:'interrupted'})],{state:'interrupted'})]);const p=await page();
    await p.locator('.circuit-node[data-feature=workers]').click();expect(await p.locator('.inspector-record').textContent()).toContain('불일치');expect(await p.locator('.inspector-record.error').count()).toBe(1);
    await p.locator('.review-shortcut[data-review=unconfirmed]').click();expect(await p.locator('#runs .run-row').count()).toBe(1);expect(await p.locator('#trace').textContent()).toContain('성공·실패는 알 수 없습니다');
    await p.locator('#recording').click();await p.waitForFunction(()=>document.getElementById('notice')!.textContent!.includes('저장하지 못했습니다'));expect(await p.locator('#recording').getAttribute('aria-checked')).toBe('true');await p.locator('#language').click();expect(await p.locator('html').getAttribute('lang')).toBe('en');await p.close();
  });

  it('honors reduced motion and keyboard navigation without inventing traffic',async()=>{
    push([run('c','claude',[step('a','admission')])]);const p=await page(390,844);await p.emulateMedia({reducedMotion:'reduce'});push([run('c','claude',[step('a','admission'),step('b','allocation')])]);await p.waitForSelector('.wire-packet',{state:'attached'});expect(await p.locator('.wire-packet').evaluate(e=>getComputedStyle(e).opacity)).toBe('0');await p.locator('.circuit-node[data-feature=allocation]').focus();await p.keyboard.press('Enter');expect(await p.locator('.circuit-node[data-feature=allocation]').getAttribute('aria-pressed')).toBe('true');expect(await p.locator('#circuit-inspector h3').textContent()).toBe('Gate B');await p.close();
  });
  it('reconnects the real event stream and preserves theme/language after a reload', async () => {
    push([run('reconnect', 'claude', [step('a', 'admission')])]); const p = await page();
    await p.locator('#theme').click(); await p.locator('#language').click();
    expect(await p.locator('html').getAttribute('data-theme')).toBe('light');
    for (const client of clients) client.end();
    await p.waitForFunction(() => document.getElementById('connection')!.textContent === 'Reconnecting');
    await p.waitForFunction(() => document.getElementById('connection')!.textContent === 'Live connection', undefined, { timeout: 10000 });
    expect(await p.locator('.wire-packet').count()).toBe(0);
    await p.reload(); await p.waitForSelector('.circuit-node');
    expect(await p.locator('html').getAttribute('lang')).toBe('en');
    expect(await p.locator('html').getAttribute('data-theme')).toBe('light');
    expect(await p.locator('#latest').count()).toBe(1);
    expect(await p.locator('.metric').count()).toBe(4); await p.close();
  });
});
