import { Window, type HTMLElement, type SVGElement } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_PAGE } from '../src/dashboard-page.js';
import type { OperationRun, OperationStep, OperationsView } from '../src/operations.js';

const windows: Window[] = [];
afterEach(async () => { for (const w of windows.splice(0)) await w.happyDOM.close(); });
const stamp = new Date().toISOString();
const step = (id: string, feature: OperationStep['feature'], lane: OperationStep['lane'], extra: Partial<OperationStep> = {}): OperationStep => ({ id, feature, lane, at: stamp, state: 'done', title: `${feature} outcome`, summary: 'Recorded result', details: [], ...extra });
const run = (id: string, host: 'claude' | 'codex', steps: OperationStep[], extra: Partial<OperationRun> = {}): OperationRun => ({ id, host, title: `${host} execution`, source: 'gate', mode: 'auto', firstAt: stamp, lastAt: stamp, state: 'done', steps, ...extra });
const snapshot = (runs: OperationRun[]) => {
  const all = runs.flatMap(r => r.steps.map(s => ({ ...s, host: r.host, runId: r.id, runTitle: r.title })));
  const ids = ['admission', 'allocation', 'planning', 'workers', 'guard', 'router', 'compact', 'evidence'] as const;
  const values = all.filter(s => s.lane === 'jev' && s.durationMs !== undefined).map(s => ({ at: s.at, ms: s.durationMs! }));
  const operations: OperationsView = { runs, feed: all.slice().reverse(), active: 0, attention: 0, requests: values.length,
    features: ids.map(id => ({ id, label: id, source: 'trace', count: all.filter(s => !s.lifecycle && s.feature === id).length, lastAt: all.some(s => !s.lifecycle && s.feature === id) ? stamp : null, state: all.some(s => !s.lifecycle && s.feature === id) ? 'observed' : 'waiting' })),
    latency: { measured: values.length, p50: values[0]?.ms ?? null, p95: values.at(-1)?.ms ?? null, fastest: values[0]?.ms ?? null, latest: values.at(-1)?.ms ?? null, recent: values }, sig: 'fixture' };
  return { at: stamp, host: 'mixed', operations, unreadable: 0, version: { running: '0.8.1', installed: '0.8.1' }, recording: { enabled: true }, dashboard: { enabled: true } };
};
function page() {
  // Evaluate only the checked-in dashboard asset in this disposable DOM.
  const w = new Window({ url: 'http://127.0.0.1:4733/', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } }); windows.push(w);
  let stream: { onmessage?: (e: { data: string }) => void; onopen?: () => void; onerror?: () => void };
  class Stream { constructor() { stream = this; } }
  Object.assign(w, { EventSource: Stream });
  const [html, tail] = DASHBOARD_PAGE.split('<script>');
  w.document.write(html! + '</body></html>'); w.eval(tail!.split('</script>')[0]!);
  const get = (id: string) => w.document.getElementById(id)! as HTMLElement;
  const click = (selector: string) => { const e = w.document.querySelector(selector); if (!e) throw Error('Missing selector: ' + selector); (e as unknown as { click(): void }).click(); };
  return { w, get, click, disconnect: () => stream!.onerror!(), push: (s: unknown) => stream!.onmessage!({ data: JSON.stringify(s) }) };
}

describe('dashboard live interactions', () => {
  it('shows the running version and honest latest-release status only when a version is known, in both languages', () => {
    const p = page(), release = { latest: '0.8.15', checkedAt: stamp, error: null };
    expect(p.get('version-badge').hidden).toBe(true);
    p.push({ ...snapshot([]), version: { running: null, installed: null, release: null } });
    expect(p.get('version-badge').hidden).toBe(true);
    p.push({ ...snapshot([]), version: { running: '0.8.14', installed: '0.8.14', release } });
    expect(p.get('version-badge').hidden).toBe(false);
    expect(p.get('version-badge').textContent).toContain('v0.8.14'); expect(p.get('version-badge').dataset.state).toBe('update');
    p.push({ ...snapshot([]), version: { running: '0.8.15', installed: '0.8.15', release } });
    expect(p.get('version-badge').dataset.state).toBe('current'); expect(p.get('version-badge').textContent).toContain('최신');
    p.click('#language'); expect(p.get('version-badge').textContent).toContain('Current');
    p.push({ ...snapshot([]), version: { running: '0.8.15', installed: '0.8.15', release: { ...release, latest: null, error: 'offline' } } });
    expect(p.get('version-badge').dataset.state).toBe('unknown'); expect(p.get('version-badge').textContent).toContain('unknown');
    p.push({ ...snapshot([]), version: { running: '0.8.14', installed: '0.8.15', release } });
    expect(p.get('version-badge').dataset.state).toBe('mismatch');
  });
  it('shows internal worker work in the released layout and updates only from observed tool evidence', () => {
    const p=page(),w={sessionId:'session',agentId:'agent',role:'worker',taskId:'t1',state:'active',lastAt:stamp,coverage:'recent',selectedModel:'claude-opus-5-5',observedModel:null,selectedEffort:'high',modelRequestAt:stamp,modelResponseAt:stamp,tools:[{id:'read',name:'Read',action:'read',target:'src/app.ts',state:'active',startedAt:stamp,endedAt:null,durationMs:null}]};
    const s={...snapshot([]),workerActivity:{items:[w],limited:false,sig:'first'}};p.push(s);
    expect(p.get('worker-internals').hidden).toBe(false);expect(p.get('worker-internals').querySelectorAll('.worker-entry')).toHaveLength(1);
    expect(p.get('worker-internals').textContent).toContain('워커 t1');expect(p.get('worker-internals').textContent).toContain('읽기 · Read');expect(p.get('worker-internals').textContent).toContain('src/app.ts');
    expect(p.get('worker-internals').textContent).toContain('요청 opus-5-5 · high');expect(p.get('worker-internals').textContent).toContain('응답 미관측');expect(p.get('worker-internals').querySelector('[data-live-since]')).not.toBeNull();
    expect(p.get('pipeline').querySelector('.circuit-node')).not.toBeNull();expect(p.get('worker-internals').querySelector('details')).toBeNull();
    const next=structuredClone(s);Object.assign(next.workerActivity.items[0]!.tools[0]!,{state:'error',endedAt:stamp,durationMs:420});p.push(next);
    expect(p.get('worker-internals').querySelector('.worker-stage-state.error')?.textContent).toBe('오류');expect(p.get('worker-internals').textContent).toContain('420 ms');
    p.click('#pause');p.push(s);expect(p.get('worker-internals').querySelector('.worker-stage-state.error')).not.toBeNull();p.click('#pause');expect(p.get('worker-internals').querySelector('.worker-stage-state.error')).toBeNull();
    p.click('[data-host=codex]');expect(p.get('worker-internals').hidden).toBe(true);p.click('[data-host=claude]');expect(p.get('worker-internals').hidden).toBe(false);
    p.click('#language');expect(p.get('worker-internals').textContent).toContain('Worker internal work');
  });
  it('keeps every active worker visible and limits only recent endings, with state-specific phases', () => {
    const p=page(),old=new Date(Date.parse(stamp)-7_200_000).toISOString(),workers=Array.from({length:18},(_,i)=>({sessionId:'s',agentId:'a'+i,role:'worker',taskId:'t'+i,state:i<16?'active':'completed',lastAt:old,coverage:'complete',selectedModel:null,observedModel:null,selectedEffort:null,modelRequestAt:old,modelResponseAt:null,jevRequestAt:i===0?stamp:null,jevResponseAt:null,tools:[]}));
    p.push({...snapshot([]),workerActivity:{items:workers,limited:false,sig:'many'}});const window=p.get('window') as unknown as {value:string;dispatchEvent(e:unknown):void};window.value='3600000';window.dispatchEvent(new p.w.Event('change'));
    expect(p.get('worker-internals').querySelectorAll('.worker-entry')).toHaveLength(16);expect(p.get('worker-internals').textContent).toContain('Jev · 다음 모델 선택');expect(p.get('worker-internals').textContent).toContain('모델 추론 · 응답 대기');
    p.push(snapshot([]));expect(p.get('worker-internals').hidden).toBe(true);
  });
  it('shows model facts from the selected stage without turning another response into its observed model', () => {
    const p = page();
    const selected = { selected: 'gpt-6-luna', observed: null, status: 'unobserved' as const, selectedEffort: 'low', observedEffort: null };
    p.push(snapshot([run('models', 'codex', [step('response', 'router', 'host', { model: { ...selected, selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed' } }), step('request', 'router', 'host', { model: selected })])]));
    p.click('[data-step="response"]');
    expect(p.get('model-proof').textContent).toContain('선택한 단계');
    expect(p.get('model-proof').textContent).toContain('선택과 실제 실행 일치');
    p.click('[data-step="request"]');
    expect(p.get('model-proof').textContent).toContain('gpt-6-luna');
    expect(p.get('model-proof').textContent).toContain('이 단계에 응답 모델 기록 없음');
    expect(p.get('model-proof').textContent).not.toContain('gpt-6.1-sol');
    expect(p.get('model-proof').textContent).not.toContain('확인 대기');
    p.click('#language');
    expect(p.get('model-proof').textContent).toContain('No response model in this stage');
  });
  it('shows the actual warning category and clears historical errors outside the selected window', () => {
    const p = page(); const old = new Date(Date.now() - 7_200_000).toISOString();
    p.push(snapshot([run('effort', 'codex', [step('old', 'router', 'host', { at: old, state: 'error', issue: 'request_effort', summary: '선택 high · 전송 xhigh' }), step('recent', 'router', 'host')], { state: 'attention' })]));
    expect(p.get('trace').textContent).toContain('API 전송 effort 불일치 1건');
    expect(p.get('trace').textContent).not.toContain('실패 또는 모델 불일치가 기록됐습니다.');
    const range = p.get('window'); (range as unknown as { value: string }).value = '3600000'; range.dispatchEvent(new p.w.Event('change'));
    expect(p.w.document.querySelector('.run-diagnosis')).toBeNull();
    expect(p.get('signal').textContent).not.toContain('오류·설정 불일치 기록');
  });
  it('shows Compact selection evidence and identifies historic request-purpose gaps without inventing a missing hook', () => {
    const p = page();
    p.push(snapshot([run('historic', 'codex', [step('unknown', 'router', 'host', { state: 'unconfirmed', issue: 'request_unconfirmed', summary: 'API 설정 관측 · 요청 종류 미확인' })], { state: 'unconfirmed' }), run('compact', 'claude', [step('selection', 'compact', 'jev', { durationMs: 220, details: ['후보 8/16 · 필수 근거 3', 'Jev 작업 의존 근거 선택'] })])]));
    expect(p.get('trace').textContent).toContain('요청 종류 미확인');
    expect(p.get('trace').textContent).not.toContain('호스트 훅에서 결과 이벤트가 빠진');
    p.click('.circuit-node[data-feature=compact]');
    expect(p.get('circuit-inspector').textContent).toContain('후보 8/16 · 필수 근거 3');
  });
  it('renders all eight real feature states and never invents activity on first load', () => {
    const p = page(); p.push(snapshot([run('c', 'claude', [step('a', 'admission', 'jev', { durationMs: 70 })]), run('x', 'codex', [step('l', 'workers', 'host', { lifecycle: true })])]));
    expect(p.w.document.querySelectorAll('.circuit-node')).toHaveLength(8);
    expect(p.w.document.querySelector('.circuit-node[data-feature="workers"]')?.classList.contains('waiting')).toBe(true);
    expect(p.w.document.querySelectorAll('.wire-packet.arriving,.circuit-node.flash')).toHaveLength(0);
    expect(p.get('latest').textContent).toBe('70 ms');
    expect(p.get('signal').textContent).toContain('70');
  });
  it('recomputes host-filtered latency and treats a filter change as a static view, not new traffic', () => {
    const p = page(); p.push(snapshot([run('c', 'claude', [step('a', 'admission', 'jev', { durationMs: 70 })]), run('x', 'codex', [step('r', 'router', 'jev', { durationMs: 210 })])]));
    p.click('[data-host="codex"]');
    expect(p.get('runs').textContent).toContain('codex execution'); expect(p.get('runs').textContent).not.toContain('claude execution');
    expect(p.get('p50').textContent).toBe('210 ms'); expect(p.get('measured').textContent).toBe('1');
    expect(p.w.document.querySelectorAll('.wire-packet.arriving,.circuit-node.flash')).toHaveLength(0);
    expect(p.w.document.querySelector('[data-host="codex"]')?.getAttribute('aria-pressed')).toBe('true');
  });
  it('excludes earlier steps from a recent time range even when their execution has a recent event', () => {
    const p = page(); const old = new Date(Date.now() - 7_200_000).toISOString();
    p.push(snapshot([run('mixed-age', 'claude', [step('old', 'admission', 'jev', { at: old, durationMs: 900 }), step('recent', 'router', 'jev', { durationMs: 80 })])]));
    const range = p.get('window'); (range as unknown as { value: string }).value = '3600000'; range.dispatchEvent(new p.w.Event('change'));
    expect(p.get('p50').textContent).toBe('80 ms'); expect(p.get('measured').textContent).toBe('1');
    expect(p.get('trace').textContent).not.toContain('admission outcome');
  });
  it('searches visible feature names, exposes filter state and distinguishes a missing source from an idle feature', () => {
    const p = page(); const s = snapshot([run('searchable', 'claude', [step('allocation', 'allocation', 'jev')])]);
    s.operations.features.find(f => f.id === 'compact')!.state = 'unavailable'; p.push(s);
    const search = p.get('search'); (search as unknown as { value: string }).value = 'Gate B'; search.dispatchEvent(new p.w.Event('input'));
    expect(p.get('runs').textContent).toContain('claude execution'); expect(p.get('coverage').textContent).toContain('기록원 읽기 불가');
    p.click('[data-state=unconfirmed]'); expect(p.w.document.querySelector('[data-state=unconfirmed]')?.getAttribute('aria-pressed')).toBe('true');
    p.click('#language'); expect(p.get('coverage').textContent).toContain('Source unavailable');
    expect(p.w.document.querySelectorAll('#latest')).toHaveLength(1);
  });
  it('pulses independent feature receipts and never joins unrelated execution tracks', () => {
    const p = page(); const a = step('a', 'admission', 'jev', { durationMs: 60 });p.push(snapshot([run('one', 'claude', [a])]));
    p.push(snapshot([run('one', 'claude', [a, step('b', 'allocation', 'jev', { durationMs: 80 })])]));
    expect(p.w.document.querySelectorAll('.wire-packet.arriving')).toHaveLength(1);
    p.push(snapshot([run('one', 'claude', [a, step('b', 'allocation', 'jev', { durationMs: 80 })]), run('other', 'codex', [step('w', 'workers', 'host')])]));
    // Each actual feature arrival has its own receipt; no cross-execution link is drawn.
    expect(p.w.document.querySelectorAll('.wire-packet.arriving')).toHaveLength(2);
    expect(p.w.document.querySelectorAll('[data-edge]')).toHaveLength(0);
    expect(p.w.document.querySelectorAll('[data-rail-actor]')).toHaveLength(2);
    expect(p.w.document.querySelector('.circuit-node[data-feature="workers"]')?.classList.contains('flash')).toBe(true);
  });
  it('preserves keyboard focus and circuit scroll when a live snapshot replaces children', () => {
    const p = page(); const a = step('a', 'admission', 'jev');p.push(snapshot([run('one', 'claude', [a])]));
    const b = p.w.document.querySelector('.circuit-node[data-feature="allocation"]')!; (b as unknown as { focus(): void }).focus();
    const scroller = p.w.document.querySelector('.circuit-scroll')!;scroller.scrollLeft = 160;
    p.push(snapshot([run('one', 'claude', [a, step('b', 'allocation', 'jev')])]));
    expect(p.w.document.activeElement?.getAttribute('data-feature')).toBe('allocation');
    expect(p.w.document.querySelector('.circuit-scroll')?.scrollLeft).toBe(160);
  });
  it('pauses updates, resumes the pending snapshot and keeps mismatch explicit in model proof', () => {
    const p = page();p.push(snapshot([run('one', 'claude', [step('a', 'admission', 'jev', { durationMs: 50 })])]));p.click('#pause');
    p.push(snapshot([run('one', 'claude', [step('m', 'workers', 'host', { model: { selected: 'opus', observed: 'claude-sonnet-5', status: 'mismatch', selectedEffort: 'high', observedEffort: null } }), step('b', 'allocation', 'jev', { durationMs: 90 })])]));
    expect(p.get('latest').textContent).toBe('50 ms');p.click('#pause');expect(p.get('latest').textContent).toBe('90 ms');
    expect(p.get('model-proof').textContent).toContain('불일치');expect(p.get('model-proof').textContent).toContain('claude-sonnet-5');
    p.click('#language');expect(p.get('model-proof').textContent).toContain('Mismatch');expect(p.w.document.documentElement.lang).toBe('en');
    p.click('#theme');expect(p.w.document.documentElement.dataset.theme).toBe('light');
  });
  it('shows the observed request effort without claiming an unreported response effort', () => {
    const p = page(); p.push(snapshot([run('codex', 'codex', [step('wire', 'router', 'host', { model: { selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed', selectedEffort: 'low', observedEffort: null, forwardedEffort: 'low', effortSource: 'provider_request' } })])]));
    expect(p.get('model-proof').textContent).toContain('API 전송 effort low'); expect(p.get('model-proof').textContent).toContain('호스트 응답에 미제공');
    p.click('#language'); expect(p.get('model-proof').textContent).toContain('API request effort low'); expect(p.get('model-proof').textContent).toContain('Not reported by host');
  });
  it('fully translates model confirmation and decision evidence without changing model IDs', () => {
    const p = page(); const r = run('translated', 'codex', [step('observed', 'router', 'host', {
      title: 'Router · root_result', summary: '선택 모델과 실제 모델 일치 · gpt-6.1-sol', details: ['기존 모델 gpt-6.1-sol'],
      model: { selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed', selectedEffort: null, observedEffort: null },
    })], { title: 'Codex 실행' }); p.push(snapshot([r])); p.click('#language');
    const text = ['runs', 'signal', 'detail', 'circuit-inspector'].map(id => p.get(id).textContent).join(' ');
    expect(text).not.toMatch(/[가-힣]/); expect(text).toContain('Selected and observed models match');
    expect(text).toContain('Decision evidence'); expect(text).toContain('gpt-6.1-sol');
  });
  it('renders metadata as text and supports searching, feature selection and attention drill-down', () => {
    const p = page();const hostile = '<img src=x onerror="alert(1)">';
    p.push(snapshot([run('one', 'claude', [step('a', 'admission', 'jev', { summary: hostile })]),run('other', 'codex', [step('r', 'router', 'policy', { state: 'unconfirmed' })], { state: 'attention' })]));
    expect(p.get('detail').textContent).toContain(hostile);expect(p.get('detail').querySelector('img')).toBeNull();expect(p.w.document.getElementById('feed')).toBeNull();
    p.click('.review-shortcut');expect(p.get('runs').textContent).not.toContain('claude execution');
    p.click('[data-state="all"]');p.click('.circuit-node[data-feature="admission"]');expect(p.get('circuit-inspector').textContent).toContain(hostile);p.click('.inspector-action');expect(p.get('runs').textContent).toContain('claude execution');expect(p.get('runs').textContent).not.toContain('codex execution');
    p.click('.circuit-node[data-feature="admission"]');expect(p.get('runs').textContent).toContain('codex execution');expect(p.get('runs').textContent).toContain('claude execution');const search=p.get('search') as unknown as { value: string; dispatchEvent(e: unknown): void };search.value='codex';search.dispatchEvent(new p.w.Event('input'));
    expect(p.get('runs').textContent).toContain('codex execution');expect(p.get('runs').textContent).not.toContain('claude execution');
  });
  it('filters runs, the run count and the timeline from a circuit node and clears on a second click', () => {
    const p = page();
    p.push(snapshot([run('one', 'claude', [step('a', 'admission', 'jev')]), run('two', 'codex', [step('r', 'router', 'policy')])]));
    expect(p.w.document.getElementById('nav')).toBeNull();expect(p.w.document.querySelector('aside.rail')).toBeNull();
    expect(p.get('runs').querySelectorAll('.run-row')).toHaveLength(2);expect(p.get('run-count').textContent).toBe('2건');
    p.click('.circuit-node[data-feature="router"]');
    expect(p.get('runs').querySelectorAll('.run-row')).toHaveLength(1);expect(p.get('runs').textContent).toContain('codex execution');expect(p.get('run-count').textContent).toBe('1건 · Router');
    expect(p.get('circuit-inspector').textContent).toContain('Router');
    p.click('.circuit-node[data-feature="router"]');
    expect(p.get('runs').querySelectorAll('.run-row')).toHaveLength(2);expect(p.get('run-count').textContent).toBe('2건');
    p.click('[data-circuit-mode="run"]');p.click('.circuit-node[data-feature="admission"]');
    expect(p.get('runs').querySelectorAll('.run-row')).toHaveLength(2);
  });
  it('saves independent shared preferences and surfaces a failed write without changing its switch', async () => {
    const p = page();p.push(snapshot([]));const fetch=vi.fn().mockResolvedValueOnce({ ok:true, json:async()=>({enabled:false}) }).mockResolvedValueOnce({ok:false});Object.assign(p.w,{fetch});
    p.click('#recording');await vi.waitFor(()=>expect(p.get('recording').getAttribute('aria-checked')).toBe('false'));expect(p.get('dashboard-auto').getAttribute('aria-checked')).toBe('true');
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/recording');p.click('#dashboard-auto');await vi.waitFor(()=>expect(p.get('notice').textContent).toContain('저장하지 못했습니다'));expect(p.get('dashboard-auto').getAttribute('aria-checked')).toBe('true');
  });
});


it('shows a rejected Terra proposal with its probability and threshold in both languages', () => {
  const p = page(); p.push(snapshot([run('proposal-proof', 'codex', [step('response', 'router', 'host', {
    routing: { scope: 'root', baseline: 'gpt-6.1-sol', modelReason: 'low_confidence', effortReason: 'selected', proposedModel: 'gpt-5.6-terra', probability: .55, threshold: .6 },
    model: { selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed', selectedEffort: 'medium', observedEffort: null },
  })])]));
  p.click('.circuit-node[data-feature="router"]');
  let text = p.get('circuit-inspector').textContent;
  expect(text).toContain('Jev 제안 모델'); expect(text).toContain('gpt-5.6-terra'); expect(text).toContain('55%'); expect(text).toContain('60%'); expect(text).toContain('변경 기준 미충족');
  p.click('#language'); text = p.get('circuit-inspector').textContent;
  expect(text).toContain('Jev proposed model'); expect(text).toContain('Proposal probability'); expect(text).toContain('Change threshold'); expect(text).not.toMatch(/[가-힣]/);
});

it.each([
  ['control_invalid', '요청 해석 응답 검증 실패', 'Invalid control assessment'],
  ['control_low_confidence', '요청 해석 기준 미충족', 'Low control confidence'],
  ['control_unclear', '요청 해석 불명확', 'Unclear request'],
  ['context_missing', '판단할 문맥 부족', 'Insufficient context'],
])('does not show a user pin for an unconfirmed routing assessment: %s', (reason, korean, english) => {
  const p = page(); p.push(snapshot([run('control-proof', 'claude', [step('response', 'router', 'host', {
    routing: { scope: 'root', baseline: 'claude-fable-5-1', modelReason: reason, effortReason: reason },
    model: { selected: 'claude-fable-5-1', observed: 'claude-fable-5-1', status: 'confirmed', selectedEffort: 'xhigh', observedEffort: null },
  })])]));
  p.click('.circuit-node[data-feature="router"]');
  expect(p.get('circuit-inspector').textContent).toContain(korean);
  expect(p.get('circuit-inspector').textContent).not.toContain('사용자가 고정');
  p.click('#language');
  expect(p.get('circuit-inspector').textContent).toContain(english);
  expect(p.get('circuit-inspector').textContent).not.toContain('User locked');
});

it('shows routing scope, baseline and keep reasons in the circuit inspector in both languages', () => {
  const p = page(); p.push(snapshot([run('route-proof', 'claude', [step('response', 'router', 'host', {
    routing: { scope: 'root', baseline: 'claude-opus-5-5', modelReason: 'same_value', effortReason: 'cache_preserved' },
    model: { selected: 'claude-opus-5-5', observed: 'claude-opus-5-5', status: 'confirmed', selectedEffort: 'xhigh', observedEffort: null, forwardedEffort: 'xhigh', effortSource: 'host_hook' },
  })])]));
  p.click('.circuit-node[data-feature="router"]');
  let text = p.get('circuit-inspector').textContent;
  expect(text).toContain('메인 턴'); expect(text).toContain('기존 모델'); expect(text).toContain('현재 모델·설정 유지'); expect(text).toContain('캐시 재사용을 위해 유지');
  p.click('#language'); text = p.get('circuit-inspector').textContent;
  expect(text).toContain('Main turn'); expect(text).toContain('Baseline model'); expect(text).toContain('Kept for cache reuse'); expect(text).not.toMatch(/[가-힣]/);
});


describe('host progress overview', () => {
  it('separates simultaneous host activity and measured Jev speed', () => {
    const p=page();
    p.push(snapshot([
      run('claude-live','claude',[step('j','router','jev',{durationMs:481}),step('wait','router','host',{lifecycle:true,state:'active',title:'모델 · 응답 대기',summary:'모델 응답 대기'})]),
      run('codex-live','codex',[step('cj','router','jev',{durationMs:123,state:'done'})])
    ]));
    const cards=p.get('now').querySelectorAll('[data-progress-host]');expect(cards).toHaveLength(2);
    expect(p.get('latest').textContent).toContain('123');expect(cards[0]!.querySelector('[data-live-since]')).not.toBeNull();
    expect(cards[1]!.querySelectorAll('.signal-tick')).toHaveLength(1);expect(cards[1]!.querySelector('[data-live-since]')).toBeNull();
    expect(cards[0]!.querySelectorAll('.progress-stage')).toHaveLength(0);expect(p.w.document.querySelectorAll('#p50')).toHaveLength(1);expect(p.w.document.querySelectorAll('.metrics,.live-event-ribbon')).toHaveLength(0);
    p.click('[data-host="codex"]');expect(p.get('now').querySelectorAll('[data-progress-host]')).toHaveLength(1);
  });
  it('shows elapsed time for the active host tool instead of an earlier completed event', () => {
    const p=page();p.push(snapshot([run('tools','codex',[
      step('old','router','host',{lifecycle:true,state:'done'}),
      step('tool','workers','host',{lifecycle:true,state:'active',startedAt:new Date().toISOString()})
    ])]));
    expect(p.get('now').querySelector('.running [data-live-since]')).not.toBeNull();
  });
  it('animates new observations only and stops motion when paused', () => {
    const p=page();p.push(snapshot([run('r','claude',[step('one','router','jev',{durationMs:90})])]));
    expect(p.get('now').querySelector('.event-arrival')).toBeNull();
    p.push(snapshot([run('r','claude',[step('one','router','jev',{durationMs:90}),step('two','router','jev',{state:'active'})])]));
    expect(p.get('now').querySelector('.event-arrival')).not.toBeNull();
    p.click('#pause');expect(p.get('now').querySelector('.event-arrival')).toBeNull();
    expect(p.get('now').querySelector('.paused')).not.toBeNull();
  });
});


it('distinguishes verified Codex request settings from an unobserved response model', () => {
  const p=page();p.push(snapshot([run('codex','codex',[step('s','router','host',{model:{selected:'gpt-6-luna',observed:null,status:'unobserved',selectedEffort:'low',observedEffort:null,requestApplied:true}})])]));
  expect(p.get('model-proof').textContent).toContain('API 전송 설정 일치 확인');
  expect(p.get('model-proof').textContent).toContain('이 단계에 응답 모델 기록 없음');
});


it('counts active work outside the bounded event feed and keeps host and header status consistent', () => {
  const p=page();const s=snapshot([run('ongoing','codex',[step('tool','workers','host',{lifecycle:true,state:'active',startedAt:stamp})]),run('recent','claude',[step('done','compact','local')])]);
  s.operations.feed=s.operations.feed.filter(event=>event.id!=='tool');p.push(s);
  expect(p.get('pipeline-state').textContent).toBe('1개 단계 진행 중');
  expect(p.get('now').querySelector('[data-progress-host="codex"].running')).not.toBeNull();
  p.click('[data-host="claude"]');expect(p.get('pipeline-state').textContent).toBe('대기');
});

it('keeps model and effort rows out of the circuit inspector and shows verified request settings only in the model record', () => {
  const p=page();p.push(snapshot([run('request-live','codex',[step('waiting','router','host',{lifecycle:true,state:'active',title:'모델 · 응답 대기',model:{selected:'gpt-6-luna',observed:null,status:'unobserved',selectedEffort:'low',observedEffort:null,requestApplied:true}})])]));
  p.click('.circuit-node[data-feature="router"]');
  const inspector=()=>p.get('circuit-inspector').textContent||'';
  for(const row of ['선택 모델','응답 모델','선택·응답 비교','선택 effort','응답 effort','API 전송 설정'])expect(inspector()).not.toContain(row);
  expect(p.get('model-proof').textContent).toContain('API 전송 설정 일치 확인');expect(p.get('model-proof').textContent).toContain('응답 대기');
  p.click('#language');
  for(const row of ['Selected model','Response model','Selection / response','Selected effort','Response effort','API request settings'])expect(inspector()).not.toContain(row);
  expect(p.get('model-proof').textContent).toContain('API request settings verified');expect(p.get('model-proof').textContent).toContain('Awaiting response');
});

it('renders typed decision probabilities once while retaining other decision evidence', () => {
  const p=page();p.push(snapshot([run('decision','claude',[step('assess','router','jev',{judgements:[{question:'control',value:'task_clear',confidence:.8,probabilities:[{label:'task_clear',value:.8},{label:'unclear',value:.2}]}],details:['control: task_clear · 확신 80% · task_clear 80% / unclear 20%','기존 모델 claude-opus-5-5']})])]));
  expect(p.get('detail').querySelectorAll('.distribution')).toHaveLength(1);
  expect(p.get('detail').textContent).not.toContain('control: task_clear');
  expect(p.get('detail').textContent).toContain('기존 모델 claude-opus-5-5');
});

it('shows directional receipts for quick independent calls without inventing them on load or filter changes', () => {
  const p=page(), first=step('r1','router','jev',{durationMs:65});
  p.push(snapshot([run('r','claude',[first])]));
  expect(p.w.document.querySelector('[data-receipt]')).toBeNull();
  p.push(snapshot([run('r','claude',[first,step('r2','router','jev',{state:'active'})])]));
  expect(p.w.document.querySelector('[data-receipt="router-in"]')).not.toBeNull();
  p.push(snapshot([run('r','claude',[first,step('r2','router','jev',{durationMs:54})])]));
  expect(p.w.document.querySelector('[data-receipt="router-out"]')).not.toBeNull();
  p.click('[data-host="claude"]');expect(p.w.document.querySelector('[data-receipt]')).toBeNull();
  p.click('[data-circuit-mode="run"]');expect(p.w.document.querySelector('[data-receipt]')).toBeNull();
});
it('makes connection loss explicit and freezes the displayed clock at disconnect rather than snapshot time', () => {
  const p=page();p.push(snapshot([run('r','claude',[step('r','router','jev',{state:'active',at:new Date(Date.now()-5000).toISOString()})])]));
  const before=p.get('now').querySelector('[data-live-since]')!.textContent;
  p.disconnect();
  expect(p.get('pipeline-state').textContent).toContain('연결 끊김');
  expect(p.get('now').querySelector('[data-live-since]')!.textContent).toBe(before);
});
it('preserves setting-save failures through incoming snapshots', async () => {
  const p=page();Object.assign(p.w,{fetch:async()=>({ok:false})});
  const value=snapshot([]);p.push(value);p.click('#recording');
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(p.get('notice').textContent).toContain('설정을 저장하지 못했습니다');
  p.push(value);expect(p.get('notice').textContent).toContain('설정을 저장하지 못했습니다');
});

it('does not animate a completed Gate path because an unrelated host tool remains active', () => {
  const p=page();p.push(snapshot([run('r','codex',[
    step('a','admission','jev'),step('b','allocation','jev'),step('w','workers','host'),
    step('tool','workers','host',{lifecycle:true,state:'active'})
  ])]));
  expect(p.w.document.querySelector('.gate-grid .wire-flow')).toBeNull();
  expect(p.get('now').querySelector('.running')).not.toBeNull();
});

it('keeps old active work on the live rails while removing completed historical steps from the time filter', () => {
  const p=page(),old=new Date(Date.now()-7_200_000).toISOString();
  p.push(snapshot([run('old-active','codex',[step('old-pending','workers','host',{lifecycle:true,state:'active',at:old,startedAt:old})],{lastAt:old}),run('new','claude',[step('new','router','jev')])]));
  const range=p.get('window') as unknown as {value:string;dispatchEvent(e:unknown):void};range.value='3600000';range.dispatchEvent(new p.w.Event('change'));
  expect(p.w.document.querySelector('[data-rail-actor="run:old-active"] .worker-stage-state.active')).not.toBeNull();
  expect(p.get('pipeline-state').textContent).toContain('1개 단계 진행 중');
});

it('shows a ten-thousand-step execution only in the time axis, with no second paginated record list', () => {
  const p=page(),steps=Array.from({length:10001},(_,i)=>step('cycle'+i,'router','host',{summary:'cycle '+i}));p.push(snapshot([run('large','codex',steps)]));
  expect(p.get('rail-history').hidden).toBe(true);expect(p.get('rail-history').querySelectorAll('.rail-record')).toHaveLength(0);
  expect(p.w.document.querySelector('[data-rail-page]')).toBeNull();expect(p.w.document.getElementById('rail-follow')).toBeNull();
  expect(p.get('trace').querySelectorAll('.span-row')).toHaveLength(100);
});

it('shows native inference cycles without tool calls and pages the complete worker tool history', async () => {
  const p=page(),tools=Array.from({length:231},(_,i)=>({id:'tool'+i,name:'Read',action:'read',target:'src/file'+i+'.ts',state:'done',startedAt:stamp,endedAt:stamp,durationMs:20})),models=[{id:'model0',at:stamp,model:'claude-opus-5-5',tools:[]},{id:'model1',at:stamp,model:'claude-sonnet-5',tools:['tool230']}],worker={sessionId:'s',agentId:'a',role:'worker',taskId:'t1',state:'active',lastAt:stamp,coverage:'recent',selectedModel:'claude-sonnet-5',observedModel:null,selectedEffort:'low',modelRequestAt:stamp,modelResponseAt:stamp,tools:tools.slice(-40)};
  const fetch=vi.fn(async (url:string)=>{const offset=Number(new URL(url,'http://localhost').searchParams.get('offset'));return{ok:true,json:async()=>({worker,tools:tools.slice(offset,offset+100),models:offset===0?models:[models[1]],coverage:'complete',skippedRows:0,total:231,next:offset+100<231?offset+100:null})}});Object.assign(p.w,{fetch});
  p.push({...snapshot([]),workerActivity:{items:[worker],limited:false,sig:'full'}});
  await vi.waitFor(()=>expect(p.get('rail-history').textContent).toContain('201–231 / 231'));
  expect(p.get('rail-history').querySelectorAll('.rail-record')).toHaveLength(31);expect(p.get('rail-history').textContent).toContain('src/file230.ts');expect(p.get('rail-history').textContent).toContain('추론 모델 sonnet-5');
  p.click('[data-rail-page="-1"]');await vi.waitFor(()=>expect(p.get('rail-history').textContent).toContain('101–200 / 231'));expect(p.get('rail-history').querySelectorAll('.rail-record')).toHaveLength(100);
  p.click('[data-history-kind="models"]');await vi.waitFor(()=>expect(p.get('rail-history').textContent).toContain('도구 호출 0개'));expect(p.get('rail-history').textContent).toContain('응답 모델 opus-5-5');expect(p.get('rail-history').textContent).toContain('응답 모델 sonnet-5');
});

it('ignores a late history response from a previously selected worker', async () => {
  const p=page(),worker=(id:string)=>({sessionId:'s',agentId:id,role:'worker',taskId:id,state:'active',lastAt:stamp,coverage:'recent',selectedModel:null,observedModel:null,selectedEffort:null,modelRequestAt:null,modelResponseAt:null,tools:[]});
  let resolve:(v:unknown)=>void=()=>{};const fetch=vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValue({ok:true,json:async()=>({tools:[],models:[],total:0,coverage:'complete'})});Object.assign(p.w,{fetch});
  p.push({...snapshot([]),workerActivity:{items:[worker('a'),worker('b')],limited:false,sig:'both'}});p.click('[data-actor="worker:s:b"]');
  await vi.waitFor(()=>expect(p.get('rail-history').textContent).toContain('워커 b'));resolve({ok:true,json:async()=>({tools:[{name:'POISON',state:'done',startedAt:stamp}],models:[],total:1,coverage:'complete'})});await new Promise(r=>setTimeout(r,0));
  expect(p.get('rail-history').textContent).toContain('워커 b');expect(p.get('rail-history').textContent).not.toContain('POISON');
});

it('draws one tick per record of the last minute with its rate, and one packet per new record up to the cap', () => {
  const old = step('old', 'router', 'jev', { at: new Date(Date.now() - 90_000).toISOString(), durationMs: 40 });
  const records = (n: number) => Array.from({ length: n }, (_, i) => step(`r${i}`, 'router', 'jev', { durationMs: 50 + i }));
  const p = page(), node = () => p.w.document.querySelector('.circuit-node[data-feature="router"]')!;
  p.push(snapshot([run('r', 'claude', [old, ...records(3)])]));
  // The record from 90 seconds ago is neither a tick nor part of the rate; the first frame invents no packet.
  expect(node().querySelectorAll('.activity-drift i')).toHaveLength(3);
  expect(node().querySelector('.activity-rate')!.textContent).toBe('분당 3회');
  expect(node().getAttribute('aria-label')).toContain('분당 3회');
  expect(node().querySelector('.activity-strip')!.getAttribute('aria-hidden')).toBe('true');
  expect(p.w.document.querySelectorAll('.wire-packet')).toHaveLength(0);
  // Four new records are four packets, evenly spaced across the frame interval.
  p.push(snapshot([run('r', 'claude', [old, ...records(7)])]));
  const delays = [...p.w.document.querySelectorAll('[data-receipt="router-out"]')].map(e => parseFloat((e as unknown as SVGElement).style.animationDelay)).sort((a, b) => a - b);
  expect(delays).toHaveLength(4);
  expect(delays[0]).toBeCloseTo(0, 1);
  expect(delays[2]! - delays[1]!).toBeCloseTo(delays[1]! - delays[0]!, 3);
  // A burst is capped at 12 packets per frame and channel; the rate still counts every record.
  const burst = page();
  burst.push(snapshot([run('r', 'claude', [records(1)[0]!])]));
  burst.push(snapshot([run('r', 'claude', records(40))]));
  expect(burst.w.document.querySelectorAll('[data-receipt="router-out"]')).toHaveLength(12);
  expect(burst.w.document.querySelector('.circuit-node[data-feature="router"] .activity-rate')!.textContent).toBe('분당 40회');
});
