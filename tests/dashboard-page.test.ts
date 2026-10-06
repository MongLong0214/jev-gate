import { Window } from 'happy-dom';
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
  const ids = ['admission', 'allocation', 'planning', 'workers', 'guard', 'lean', 'router', 'compact', 'output', 'evidence'] as const;
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
  const get = (id: string) => w.document.getElementById(id)!;
  const click = (selector: string) => { const e = w.document.querySelector(selector); if (!e) throw Error('Missing selector: ' + selector); (e as unknown as { click(): void }).click(); };
  return { w, get, click, push: (s: ReturnType<typeof snapshot>) => stream!.onmessage!({ data: JSON.stringify(s) }) };
}

describe('dashboard live interactions', () => {
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
    p.click('#nav [data-feature=compact]');
    expect(p.get('circuit-inspector').textContent).toContain('후보 8/16 · 필수 근거 3');
  });
  it('renders all ten real feature states, keeps Lean separate and never invents activity on first load', () => {
    const p = page(); p.push(snapshot([run('c', 'claude', [step('a', 'admission', 'jev', { durationMs: 70 })]), run('x', 'codex', [step('l', 'workers', 'host', { lifecycle: true })])]));
    expect(p.w.document.querySelectorAll('.circuit-node')).toHaveLength(10);
    expect(p.w.document.querySelector('.circuit-node[data-feature="lean"]')?.classList.contains('waiting')).toBe(true);
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
    s.operations.features.find(f => f.id === 'lean')!.state = 'unavailable'; p.push(s);
    const search = p.get('search'); (search as unknown as { value: string }).value = 'Gate B'; search.dispatchEvent(new p.w.Event('input'));
    expect(p.get('runs').textContent).toContain('claude execution'); expect(p.get('coverage').textContent).toContain('기록원 읽기 불가');
    p.click('[data-state=unconfirmed]'); expect(p.w.document.querySelector('[data-state=unconfirmed]')?.getAttribute('aria-pressed')).toBe('true');
    p.click('#language'); expect(p.get('coverage').textContent).toContain('Source unavailable');
    expect(p.w.document.querySelectorAll('#latest')).toHaveLength(1);
  });
  it('only pulses an edge for a newly observed linked stage in the same execution', () => {
    const p = page(); const a = step('a', 'admission', 'jev', { durationMs: 60 });p.push(snapshot([run('one', 'claude', [a])]));
    p.push(snapshot([run('one', 'claude', [a, step('b', 'allocation', 'jev', { durationMs: 80 })])]));
    expect(p.w.document.querySelectorAll('.wire-packet.arriving')).toHaveLength(1);
    p.push(snapshot([run('one', 'claude', [a, step('b', 'allocation', 'jev', { durationMs: 80 })]), run('other', 'codex', [step('w', 'workers', 'host')])]));
    // The first transfer continues at its original offset; unrelated worker traffic adds no second edge.
    expect(p.w.document.querySelectorAll('.wire-packet.arriving')).toHaveLength(1);
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
    expect(p.get('feed').textContent).toContain(hostile);expect(p.get('feed').querySelector('img')).toBeNull();
    p.click('.review-shortcut');expect(p.get('runs').textContent).not.toContain('claude execution');
    p.click('[data-state="all"]');p.click('.circuit-node[data-feature="admission"]');expect(p.get('circuit-inspector').textContent).toContain(hostile);p.click('.inspector-action');expect(p.get('runs').textContent).toContain('claude execution');expect(p.get('runs').textContent).not.toContain('codex execution');
    p.click('#nav [data-feature="all"]');const search=p.get('search') as unknown as { value: string; dispatchEvent(e: unknown): void };search.value='codex';search.dispatchEvent(new p.w.Event('input'));
    expect(p.get('runs').textContent).toContain('codex execution');expect(p.get('runs').textContent).not.toContain('claude execution');
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

it('shows routing scope, baseline and keep reasons next to the observed response in both languages', () => {
  const p = page(); p.push(snapshot([run('route-proof', 'claude', [step('response', 'router', 'host', {
    routing: { scope: 'root', baseline: 'claude-opus-5-5', modelReason: 'same_value', effortReason: 'cache_preserved' },
    model: { selected: 'claude-opus-5-5', observed: 'claude-opus-5-5', status: 'confirmed', selectedEffort: 'xhigh', observedEffort: null, forwardedEffort: 'xhigh', effortSource: 'host_hook' },
  })])]));
  p.click('.circuit-node[data-feature="router"]');
  let text = p.get('circuit-inspector').textContent;
  expect(text).toContain('메인 턴'); expect(text).toContain('기존 모델'); expect(text).toContain('현재 모델·설정 유지'); expect(text).toContain('캐시 재사용을 위해 유지'); expect(text).toContain('호스트 응답에 미제공');
  p.click('#language'); text = p.get('circuit-inspector').textContent;
  expect(text).toContain('Main turn'); expect(text).toContain('Baseline model'); expect(text).toContain('Kept for cache reuse'); expect(text).toContain('Not reported by host'); expect(text).not.toMatch(/[가-힣]/);
});
