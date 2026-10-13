import { Window, type HTMLElement, type SVGElement } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivitySnapshot } from '../src/activity.js';
import { DASHBOARD_PAGE } from '../src/dashboard-page.js';
import { diffFrame, type FrameMemo } from '../src/dashboard-patch.js';
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
  // The frame key replaced the operations signature; Omit keeps this fixture valid with or without the field.
  const operations: Omit<OperationsView, 'sig'> = { runs, feed: all.slice().reverse(), active: 0, attention: 0, requests: values.length,
    features: ids.map(id => ({ id, label: id, source: 'trace', count: all.filter(s => !s.lifecycle && s.feature === id).length, lastAt: all.some(s => !s.lifecycle && s.feature === id) ? stamp : null, state: all.some(s => !s.lifecycle && s.feature === id) ? 'observed' : 'waiting' })),
    latency: { measured: values.length, p50: values[0]?.ms ?? null, p95: values.at(-1)?.ms ?? null, fastest: values[0]?.ms ?? null, latest: values.at(-1)?.ms ?? null, recent: values, today: {} } };
  return { at: stamp, host: 'mixed', operations, unreadable: 0, version: { running: '0.8.1', installed: '0.8.1' }, recording: { enabled: true }, dashboard: { enabled: true } };
};
function page() {
  // Evaluate only the checked-in dashboard asset in this disposable DOM.
  const w = new Window({ url: 'http://127.0.0.1:4733/', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } }); windows.push(w);
  let stream: { onmessage?: (e: { data: string }) => void; onopen?: () => void; onerror?: () => void; patch?: (e: { data: string }) => void }, opened = 0;
  class Stream { patch?: (e: { data: string }) => void; constructor() { stream = this; opened++; } addEventListener(type: string, f: (e: { data: string }) => void) { if (type === 'patch') this.patch = f; } close() {} }
  Object.assign(w, { EventSource: Stream });
  const [html, tail] = DASHBOARD_PAGE.split('<script>');
  w.document.write(html! + '</body></html>'); w.eval(tail!.split('</script>')[0]!);
  const get = (id: string) => w.document.getElementById(id)! as HTMLElement;
  const click = (selector: string) => { const e = w.document.querySelector(selector); if (!e) throw Error('Missing selector: ' + selector); (e as unknown as { click(): void }).click(); };
  return { w, get, click, disconnect: () => stream!.onerror!(), push: (s: unknown) => stream!.onmessage!({ data: JSON.stringify(s) }), patch: (m: unknown) => stream!.patch!({ data: JSON.stringify(m) }), streams: () => opened };
}

const text = (p: ReturnType<typeof page>, id: string) => p.get(id).textContent ?? '';
const opened = (p: ReturnType<typeof page>) => p.w.document.querySelector('#trace .sd:not([hidden])')?.textContent ?? '';
const rows = (p: ReturnType<typeof page>) => p.get('runs').querySelectorAll('button[data-run]');
const node = (p: ReturnType<typeof page>, id: string) => p.w.document.querySelector(`#pipeline .node[data-feature="${id}"]`)! as HTMLElement;
const filled = (p: ReturnType<typeof page>) => [...p.get('rc').querySelectorAll('tr')].filter(r => r.textContent);

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
  it('shows model facts from the opened stage without turning another response into its observed model', () => {
    const p = page();
    const selected = { selected: 'gpt-6-luna', observed: null, status: 'unobserved' as const, selectedEffort: 'low', observedEffort: null };
    p.push(snapshot([run('models', 'codex', [step('response', 'router', 'host', { model: { ...selected, selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed' } }), step('request', 'router', 'host', { model: selected })])]));
    p.click('[data-step="response"]');
    expect(opened(p)).toContain('gpt-6.1-sol'); expect(opened(p)).toContain('일치');
    p.click('[data-step="request"]');
    expect(opened(p)).toContain('gpt-6-luna'); expect(opened(p)).toContain('응답 모델 기록 없음'); expect(opened(p)).not.toContain('gpt-6.1-sol');
    expect(p.get('trace').querySelectorAll('[aria-expanded="true"]')).toHaveLength(1);
    p.click('#language'); expect(opened(p)).toContain('No response model recorded');
  });
  it('names the actual warning category in the header and opens the failing stage', () => {
    const p = page();
    p.push(snapshot([run('effort', 'codex', [step('old', 'router', 'host', { state: 'error', issue: 'request_effort', summary: '선택 high · 전송 xhigh' }), step('recent', 'router', 'host')], { state: 'attention' })]));
    expect(text(p, 'k-att')).toBe('1'); expect(text(p, 'k-diag')).toContain('API 전송 effort 불일치 1건');
    expect(opened(p)).toContain('선택 high · 전송 xhigh');
    p.click('#language'); expect(text(p, 'k-diag')).toContain('API request effort mismatch');
  });
  it('shows Compact selection evidence in its stage detail and the measured response in the inspector', () => {
    const p = page();
    p.push(snapshot([run('compact', 'claude', [step('selection', 'compact', 'jev', { durationMs: 220, details: ['후보 8/16 · 필수 근거 3', 'Jev 작업 의존 근거 선택'] })])]));
    expect(opened(p)).toContain('후보 8/16 · 필수 근거 3'); expect(text(p, 'trace')).not.toContain('호스트 훅에서 결과 이벤트가 빠진');
    p.click('.node[data-feature=compact]'); expect(text(p, 'circuit-inspector')).toContain('220ms');
  });
  it('renders all eight real feature states and never invents traffic on first load', () => {
    const p = page(); p.push(snapshot([run('c', 'claude', [step('a', 'admission', 'jev', { durationMs: 70 })]), run('x', 'codex', [step('l', 'workers', 'host', { lifecycle: true })])]));
    expect(p.w.document.querySelectorAll('#pipeline .node')).toHaveLength(8);
    expect(node(p, 'workers').classList.contains('idle')).toBe(true); expect(node(p, 'workers').querySelector('.dec b')!.textContent).toBe('–');
    expect(node(p, 'admission').classList.contains('idle')).toBe(false);
    expect(p.w.document.querySelectorAll('.trip,.node.zap,.rail .ln b')).toHaveLength(0); expect(filled(p)).toHaveLength(1);
    expect(text(p, 'k-p50')).toBe('70'); expect(text(p, 'j-latest')).toBe('70ms'); expect(p.get('rc').querySelectorAll('tr')).toHaveLength(8);
  });
  it('recomputes host-filtered latency and treats a filter change as a static view, not new traffic', () => {
    const p = page(), s = snapshot([run('c', 'claude', [step('a', 'admission', 'jev', { durationMs: 70 })]), run('x', 'codex', [step('r', 'router', 'jev', { durationMs: 210 })])]);
    p.push(s); p.push(s); p.click('[data-host="codex"]');
    expect(text(p, 'runs')).toContain('codex execution'); expect(text(p, 'runs')).not.toContain('claude execution');
    expect(text(p, 'k-p50')).toBe('210'); expect(text(p, 'k-p95')).toContain('표본 1');
    expect(filled(p)).toHaveLength(1); expect(p.w.document.querySelectorAll('.trip')).toHaveLength(0);
    expect(p.w.document.querySelector('[data-host="codex"]')?.getAttribute('aria-pressed')).toBe('true');
  });
  it('searches feature names, exposes filter state and never leaves an empty highlighted run', () => {
    const p = page(); p.push(snapshot([run('searchable', 'claude', [step('allocation', 'allocation', 'jev')]), run('other', 'codex', [step('g', 'guard', 'policy')])]));
    const search = p.get('search') as unknown as { value: string; dispatchEvent(e: unknown): void }; search.value = 'Gate B'; search.dispatchEvent(new p.w.Event('input'));
    expect(rows(p)).toHaveLength(1); expect(text(p, 'runs')).toContain('claude execution');
    p.click('[data-state=unconfirmed]'); expect(p.w.document.querySelector('[data-state=unconfirmed]')?.getAttribute('aria-pressed')).toBe('true');
    expect(rows(p)).toHaveLength(0); expect(p.get('runs').querySelector('li.empty')?.textContent).toContain('조건에 맞는 실행이 없습니다');
    for (const li of p.get('runs').querySelectorAll('li')) expect(li.textContent?.trim()).not.toBe('');
    expect(text(p, 'rd-name')).toBe(''); expect(p.get('trace').querySelector('li.empty')).not.toBeNull();
  });
  it('plays one round trip per new record and updates the node and the call log only on arrival', async () => {
    const p = page(), a = step('a', 'admission', 'jev', { durationMs: 60 }); p.push(snapshot([run('one', 'claude', [a])])); p.push(snapshot([run('one', 'claude', [a])]));
    p.push(snapshot([run('one', 'claude', [a, step('b', 'allocation', 'jev', { durationMs: 80, at: new Date().toISOString() })]), run('other', 'codex', [step('w', 'workers', 'host', { at: new Date().toISOString() })])]));
    expect(node(p, 'allocation').querySelector('.dec b')!.textContent).toBe('–'); expect(filled(p)).toHaveLength(1);
    await vi.waitFor(() => expect(filled(p)).toHaveLength(2), { timeout: 5000 });
    expect(node(p, 'allocation').querySelector('.dec b')!.textContent).not.toBe('–'); expect(node(p, 'workers').querySelector('.dec b')!.textContent).not.toBe('–');
    expect(text(p, 'rc')).not.toContain('workers');
  });
  it('preserves keyboard focus when a live snapshot updates the circuit', () => {
    const p = page(); const a = step('a', 'admission', 'jev'); p.push(snapshot([run('one', 'claude', [a])]));
    (node(p, 'allocation') as unknown as { focus(): void }).focus();
    p.push(snapshot([run('one', 'claude', [a, step('b', 'allocation', 'jev')])]));
    expect(p.w.document.activeElement?.getAttribute('data-feature')).toBe('allocation');
  });
  it('pauses updates without motion, resumes the pending snapshot and keeps mismatch explicit in the stage detail', () => {
    const p = page(); p.push(snapshot([run('one', 'claude', [step('a', 'admission', 'jev', { durationMs: 50 })])])); p.click('#pause');
    p.push(snapshot([run('one', 'claude', [step('m', 'workers', 'host', { model: { selected: 'opus', observed: 'claude-sonnet-5', status: 'mismatch', selectedEffort: 'high', observedEffort: null } }), step('b', 'allocation', 'jev', { durationMs: 90 })])]));
    expect(text(p, 'j-latest')).toBe('50ms'); expect(p.w.document.querySelectorAll('.trip')).toHaveLength(0); expect(p.get('pause').getAttribute('aria-pressed')).toBe('true');
    p.click('#pause'); expect(text(p, 'j-latest')).toBe('90ms');
    expect(opened(p)).toContain('불일치'); expect(opened(p)).toContain('claude-sonnet-5');
    p.click('#language'); expect(opened(p)).toContain('Mismatch'); expect(p.w.document.documentElement.lang).toBe('en');
    p.click('#theme'); expect(p.w.document.documentElement.dataset.theme).toBe('light');
  });
  it('shows the observed request effort without claiming an unreported response effort', () => {
    const p = page(); p.push(snapshot([run('codex', 'codex', [step('wire', 'router', 'host', { model: { selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed', selectedEffort: 'low', observedEffort: null, forwardedEffort: 'low', effortSource: 'provider_request' } })])]));
    expect(opened(p)).toContain('API 전송 effort low'); expect(opened(p)).toContain('호스트 응답에 미제공');
    p.click('#language'); expect(opened(p)).toContain('API request effort low'); expect(opened(p)).toContain('Not reported by host');
  });
  it('fully translates the run list, stage detail, inspector and call log without changing model IDs', () => {
    const p = page(); const r = run('translated', 'codex', [step('observed', 'router', 'host', {
      title: 'Router · root_result', summary: '선택 모델과 실제 모델 일치 · gpt-6.1-sol', details: ['기존 모델 gpt-6.1-sol'],
      model: { selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed', selectedEffort: null, observedEffort: null },
    })], { title: 'Codex 실행' }); p.push(snapshot([r])); p.click('#language'); p.click('.node[data-feature=router]');
    const all = ['runs', 'trace', 'rd-meta', 'circuit-inspector', 'rc', 'pipeline'].map(id => text(p, id)).join(' ');
    expect(all).not.toMatch(/[가-힣]/); expect(all).toContain('Selected and observed models match');
    expect(all).toContain('Decision evidence'); expect(all).toContain('gpt-6.1-sol');
  });
  it('renders metadata as text and supports attention filtering and inspector drill-down', () => {
    const p = page(); const hostile = '<img src=x onerror="alert(1)">';
    p.push(snapshot([run('one', 'claude', [step('a', 'admission', 'jev', { summary: hostile })]), run('other', 'codex', [step('r', 'router', 'policy', { state: 'unconfirmed' })], { state: 'attention' })]));
    expect(opened(p)).toContain(hostile); expect(p.get('trace').querySelector('img')).toBeNull();
    p.click('[data-state="attention"]'); expect(text(p, 'runs')).not.toContain('claude execution'); expect(text(p, 'runs')).toContain('codex execution');
    p.click('[data-state="all"]'); p.click('.node[data-feature="admission"]'); p.click('#circuit-inspector [data-inspect-feature]');
    expect(text(p, 'runs')).toContain('claude execution'); expect(text(p, 'runs')).not.toContain('codex execution'); expect(text(p, 'rd-name')).toBe('claude execution');
    p.click('.node[data-feature="admission"]'); expect(text(p, 'runs')).toContain('codex execution');
    const search = p.get('search') as unknown as { value: string; dispatchEvent(e: unknown): void }; search.value = 'codex'; search.dispatchEvent(new p.w.Event('input'));
    expect(text(p, 'runs')).toContain('codex execution'); expect(text(p, 'runs')).not.toContain('claude execution');
  });
  it('filters runs and the run count from a circuit node and clears on a second click', () => {
    const p = page();
    p.push(snapshot([run('one', 'claude', [step('a', 'admission', 'jev')]), run('two', 'codex', [step('r', 'router', 'policy')])]));
    expect(p.w.document.querySelectorAll('#runs')).toHaveLength(1); expect(rows(p)).toHaveLength(2); expect(text(p, 'run-count')).toBe('실행 2개 표시');
    p.click('.node[data-feature="router"]');
    expect(rows(p)).toHaveLength(1); expect(text(p, 'runs')).toContain('codex execution'); expect(text(p, 'run-count')).toBe('실행 1개 표시 · Router 기록만');
    expect(p.get('circuit-inspector').querySelector('h2')?.textContent).toBe('Router'); expect(node(p, 'router').getAttribute('aria-pressed')).toBe('true');
    p.click('.node[data-feature="router"]'); expect(rows(p)).toHaveLength(2); expect(text(p, 'run-count')).toBe('실행 2개 표시');
    p.click('[data-circuit-mode="run"]'); p.click('.node[data-feature="admission"]'); expect(rows(p)).toHaveLength(2);
  });
  it('shows Router as model and effort without confidence, other decisions with their recorded confidence', () => {
    const rc = (choice: string, extra: object = {}) => ({ status: 200, code: null, model: 'jev-1.13.0', input: 1200, output: 40, costUsd: 0.0012, choice, confidence: .87, threshold: null, direction: null, ...extra });
    const p = page(); p.push(snapshot([run('r', 'claude', [step('a', 'admission', 'jev', { durationMs: 90, receipt: rc('direct') }), step('m', 'router', 'jev', { durationMs: 120, receipt: rc('claude-sonnet-5 · high', { threshold: .6, direction: 'downgrade' }) })])]));
    const segs = (id: string) => [...node(p, id).querySelectorAll('.dec b span')].map(s => s.textContent);
    expect(segs('router')).toEqual(['sonnet', 'high']); expect(segs('admission')).toEqual(['직접', '0.87']);
    p.click('.node[data-feature=router]'); expect(text(p, 'circuit-inspector')).toContain('확신 87% · 변경 기준 60%');
    expect(text(p, 'rc')).toContain('1.2K → 40'); expect(text(p, 'rc')).toContain('≈$0.00120'); expect(text(p, 'rc')).toContain('0.87');
  });
  it('keeps eight call-log rows newest first and holds them with a count of new calls', async () => {
    const calls = (n: number) => Array.from({ length: n }, (_, i) => step('c' + i, 'router', 'jev', { durationMs: 100 + i, at: new Date(Date.parse(stamp) + i * 10).toISOString() }));
    const p = page(); p.push(snapshot([run('r', 'claude', calls(3))]));
    expect(p.get('rc').querySelectorAll('tr')).toHaveLength(8); expect(filled(p)).toHaveLength(3); expect(filled(p)[0]!.textContent).toContain('102ms');
    expect(filled(p)[0]!.querySelectorAll('td')[7]!.textContent).toBe('–');
    p.click('[data-rc="hold"]'); p.push(snapshot([run('r', 'claude', calls(5))]));
    await vi.waitFor(() => expect(text(p, 'rc-new')).toBe('+2 새 기록'), { timeout: 5000 }); expect(filled(p)).toHaveLength(3); expect(p.w.document.querySelector('[data-rc="hold"]')?.getAttribute('aria-pressed')).toBe('true');
    p.click('[data-rc="live"]'); expect(filled(p)).toHaveLength(5); expect(filled(p)[0]!.textContent).toContain('104ms'); expect(text(p, 'rc-new')).toBe('');
  });
  it('estimates today cost from recorded tokens only and labels it as an estimate', () => {
    const p = page(), s = snapshot([run('r', 'claude', [step('c', 'router', 'jev', { durationMs: 100 })])]);
    p.push(s); expect(text(p, 'j-cost')).toBe('–');
    p.push({ ...s, operations: { ...s.operations, latency: { ...s.operations.latency, today: { claude: { calls: 3, input: 9000, costUsd: 0.0042, unpriced: 1 } } } } });
    expect(text(p, 'j-cost')).toBe('≈ $0.00420'); expect(text(p, 'j-today')).toBe('3회'); expect(text(p, 'k-today')).toBe('오늘 3회');
    expect(text(p, 'j-cost-note')).toContain('정가 추정'); expect(text(p, 'j-cost-note')).toContain('API가 알려주지 않습니다'); expect(text(p, 'j-cost-note')).toContain('1회는 제외');
  });
  it('saves independent shared preferences and surfaces a failed write without changing its switch', async () => {
    const p = page();p.push(snapshot([]));const fetch=vi.fn().mockResolvedValueOnce({ ok:true, json:async()=>({enabled:false}) }).mockResolvedValueOnce({ok:false});Object.assign(p.w,{fetch});
    p.click('#recording');await vi.waitFor(()=>expect(p.get('recording').getAttribute('aria-checked')).toBe('false'));expect(p.get('dashboard-auto').getAttribute('aria-checked')).toBe('true');
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/recording');p.click('#dashboard-auto');await vi.waitFor(()=>expect(p.get('notice').textContent).toContain('저장하지 못했습니다'));expect(p.get('dashboard-auto').getAttribute('aria-checked')).toBe('true');
  });
});

it('shows a rejected Terra proposal with its probability and threshold in the stage detail in both languages', () => {
  const p = page(); p.push(snapshot([run('proposal-proof', 'codex', [step('response', 'router', 'host', {
    routing: { scope: 'root', baseline: 'gpt-6.1-sol', modelReason: 'low_confidence', effortReason: 'selected', proposedModel: 'gpt-5.6-terra', probability: .55, threshold: .6 },
    model: { selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed', selectedEffort: 'medium', observedEffort: null },
  })])]));
  let t = opened(p);
  expect(t).toContain('Jev 제안 모델'); expect(t).toContain('gpt-5.6-terra'); expect(t).toContain('55%'); expect(t).toContain('60%'); expect(t).toContain('변경 기준 미충족');
  p.click('#language'); t = opened(p);
  expect(t).toContain('Jev proposed model'); expect(t).toContain('Proposal probability'); expect(t).toContain('Change threshold'); expect(t).not.toMatch(/[가-힣]/);
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
  expect(opened(p)).toContain(korean); expect(opened(p)).not.toContain('사용자가 고정');
  p.click('#language'); expect(opened(p)).toContain(english); expect(opened(p)).not.toContain('User locked');
});

it('shows routing scope, baseline and keep reasons in the stage detail in both languages', () => {
  const p = page(); p.push(snapshot([run('route-proof', 'claude', [step('response', 'router', 'host', {
    routing: { scope: 'root', baseline: 'claude-opus-5-5', modelReason: 'same_value', effortReason: 'cache_preserved' },
    model: { selected: 'claude-opus-5-5', observed: 'claude-opus-5-5', status: 'confirmed', selectedEffort: 'xhigh', observedEffort: null, forwardedEffort: 'xhigh', effortSource: 'host_hook' },
  })])]));
  let t = opened(p);
  expect(t).toContain('메인 턴'); expect(t).toContain('기존 모델'); expect(t).toContain('현재 모델·설정 유지'); expect(t).toContain('캐시 재사용을 위해 유지');
  p.click('#language'); t = opened(p);
  expect(t).toContain('Main turn'); expect(t).toContain('Baseline model'); expect(t).toContain('Kept for cache reuse'); expect(t).not.toMatch(/[가-힣]/);
});

it('separates simultaneous host activity in the header, including in-flight work outside the bounded feed', () => {
  const p = page(), s = snapshot([run('claude-live', 'claude', [step('j', 'router', 'jev', { durationMs: 481 })], { state: 'active' }), run('codex-live', 'codex', [step('cj', 'router', 'jev', { durationMs: 123 })], { state: 'active' }), run('done', 'claude', [step('d', 'compact', 'local')])]);
  s.operations.feed = s.operations.feed.filter(e => e.id !== 'cj'); p.push(s);
  expect(text(p, 'k-active')).toBe('2'); expect(text(p, 'k-hosts')).toBe('Claude 1 · Codex 1'); expect(p.get('runs').querySelectorAll('[data-since]')).toHaveLength(2);
  p.click('[data-host="codex"]'); expect(text(p, 'k-active')).toBe('1'); expect(text(p, 'k-hosts')).toBe('Claude 0 · Codex 1');
  p.click('[data-host="claude"]'); expect(text(p, 'k-hosts')).toBe('Claude 1 · Codex 0');
});

it('distinguishes verified Codex request settings from an unobserved response model', () => {
  const p = page(); p.push(snapshot([run('codex', 'codex', [step('s', 'router', 'host', { model: { selected: 'gpt-6-luna', observed: null, status: 'unobserved', selectedEffort: 'low', observedEffort: null, requestApplied: true } })])]));
  expect(opened(p)).toContain('API 전송 설정'); expect(opened(p)).toContain('일치'); expect(opened(p)).toContain('응답 모델 기록 없음');
});

it('keeps model and effort rows out of the circuit inspector and shows verified request settings only in the stage detail', () => {
  const p = page(); p.push(snapshot([run('request-live', 'codex', [step('waiting', 'router', 'host', { lifecycle: true, state: 'active', title: '모델 · 응답 대기', model: { selected: 'gpt-6-luna', observed: null, status: 'unobserved', selectedEffort: 'low', observedEffort: null, requestApplied: true } })])]));
  p.click('.node[data-feature="router"]');
  const inspector = () => text(p, 'circuit-inspector');
  for (const row of ['선택 모델', '응답 모델', '선택·응답 비교', '선택 effort', '응답 effort', 'API 전송 설정']) expect(inspector()).not.toContain(row);
  expect(opened(p)).toContain('API 전송 설정'); expect(opened(p)).toContain('응답 대기');
  p.click('#language');
  for (const row of ['Selected model', 'Response model', 'Selection / response', 'Selected effort', 'Response effort', 'API request settings']) expect(inspector()).not.toContain(row);
  expect(opened(p)).toContain('API request settings'); expect(opened(p)).toContain('Awaiting response');
});

it('renders typed decision probabilities once while retaining other decision evidence', () => {
  const p = page(); p.push(snapshot([run('decision', 'claude', [step('assess', 'router', 'jev', { judgements: [{ question: 'control', value: 'task_clear', confidence: .8, probabilities: [{ label: 'task_clear', value: .8 }, { label: 'unclear', value: .2 }] }], details: ['control: task_clear · 확신 80% · task_clear 80% / unclear 20%', '기존 모델 claude-opus-5-5'] })])]));
  const terms = [...p.get('trace').querySelectorAll('.sd:not([hidden]) dd')].filter(d => d.textContent?.includes('20%'));
  expect(terms).toHaveLength(1); expect(opened(p)).not.toContain('control: task_clear'); expect(opened(p)).toContain('기존 모델 claude-opus-5-5');
});

it('makes connection loss explicit and freezes the displayed clock at disconnect', async () => {
  const p = page(); p.push(snapshot([run('r', 'claude', [step('r', 'router', 'jev', { state: 'active' })], { state: 'active', firstAt: new Date(Date.now() - 5000).toISOString() })]));
  const since = () => p.get('runs').querySelector('[data-since]')!.textContent;
  p.disconnect(); const before = since();
  expect(text(p, 'connection')).toBe('재연결 중'); expect(p.get('connection').classList.contains('warn')).toBe(true);
  await new Promise(r => setTimeout(r, 1100)); expect(since()).toBe(before);
});
it('preserves setting-save failures through incoming snapshots', async () => {
  const p=page();Object.assign(p.w,{fetch:async()=>({ok:false})});
  const value=snapshot([]);p.push(value);p.click('#recording');
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(p.get('notice').textContent).toContain('설정을 저장하지 못했습니다');
  p.push(value);expect(p.get('notice').textContent).toContain('설정을 저장하지 못했습니다');
});

it('shows a ten-thousand-step execution in a bounded timeline with one record list', () => {
  const p = page(), steps = Array.from({ length: 10001 }, (_, i) => step('cycle' + i, 'router', 'host', { summary: 'cycle ' + i })); p.push(snapshot([run('large', 'codex', steps)]));
  expect(p.get('trace').children).toHaveLength(100); expect(p.get('trace').querySelectorAll('[aria-expanded="true"]')).toHaveLength(1);
});

it('draws one strip tick per record of the last minute, caps a burst of trips and shows no per-minute rate', () => {
  const old = step('old', 'router', 'jev', { at: new Date(Date.now() - 90_000).toISOString(), durationMs: 40 });
  const base = Date.now(), records = (n: number) => Array.from({ length: n }, (_, i) => step(`r${i}`, 'router', 'jev', { durationMs: 50 + i, at: new Date(base + i).toISOString() }));
  const p = page(); p.push(snapshot([run('r', 'claude', [old, ...records(3)])]));
  expect(node(p, 'router').querySelectorAll('.strip .tr i')).toHaveLength(3); expect(node(p, 'router').querySelector('.strip')!.getAttribute('aria-hidden')).toBe('true');
  expect(p.get('ct').querySelectorAll('i')).toHaveLength(3); expect(filled(p)).toHaveLength(4);
  const rate = /\/분|분당|최근 1분|처리량|per minute|\/min/;
  expect(p.w.document.body.textContent).not.toMatch(rate); p.click('#language'); expect(p.w.document.body.textContent).not.toMatch(rate);
  const burst = page(); burst.push(snapshot([run('r', 'claude', records(1))])); burst.push(snapshot([run('r', 'claude', records(1))]));
  burst.push(snapshot([run('r', 'claude', records(40))]));
  // The newest 24 wait for their trips; the older backlog shows at once.
  expect(burst.get('rc').querySelector('tr')!.textContent).toContain('65ms');
});

it('marks selection with a tint or a border colour only, never an inset or left accent bar', () => {
  expect(DASHBOARD_PAGE).not.toMatch(/inset\s+\d+px\s+0\s+0[^;}]*accent|border-left:[^;}]*accent/);
});

// The server's own diff: the first snapshot is a whole frame with its key, each later one a patch against the last key.
const frames = () => {
  let memo: FrameMemo | null = null, n = 0;
  return (s: ReturnType<typeof snapshot>) => {
    const base = memo?.key, r = diffFrame(memo, s as unknown as ActivitySnapshot, () => 'f' + ++n); memo = r.memo;
    return base === undefined ? { ...s, frame: memo.key } : { base, frame: memo.key, p: r.patch ? JSON.parse(r.patch) : undefined };
  };
};

it('applies live patches to the frame it holds, to the pending frame while paused, and reconnects on a gap', async () => {
  const next = frames(), a = step('a', 'admission', 'jev', { durationMs: 60 }), other = run('other', 'codex', [step('g', 'guard', 'policy')]);
  const p = page(); p.push(next(snapshot([run('one', 'claude', [a]), other])));
  p.patch(next(snapshot([run('one', 'claude', [a, step('b', 'allocation', 'jev', { durationMs: 80, at: new Date().toISOString() })]), other])));
  await vi.waitFor(() => expect(filled(p)).toHaveLength(2), { timeout: 5000 });
  expect(node(p, 'allocation').querySelector('.dec b')!.textContent).not.toBe('–'); expect(filled(p)[0]!.textContent).toContain('80ms');
  p.click('#pause');
  p.patch(next(snapshot([run('one', 'claude', [a, step('b', 'allocation', 'jev', { durationMs: 80 }), step('c', 'router', 'jev', { durationMs: 90, at: new Date().toISOString() })]), other])));
  expect(filled(p)).toHaveLength(2);
  p.click('#pause'); await vi.waitFor(() => expect(filled(p)).toHaveLength(3), { timeout: 5000 }); expect(filled(p)[0]!.textContent).toContain('90ms');
  const streams = p.streams(); p.patch({ base: 'stale', frame: 'f99', p: { order: [] } });
  expect(p.streams()).toBe(streams + 1); expect(rows(p)).toHaveLength(2);
});

it('keeps the row of an unchanged run as the same element when a patch changes another run', () => {
  const next = frames(), other = run('other', 'codex', [step('g', 'guard', 'policy')]);
  const p = page(); p.push(next(snapshot([run('one', 'claude', [step('a', 'admission', 'jev', { durationMs: 60 })]), other])));
  const kept = p.get('runs').querySelector('[data-run="other"] .c-st'), changed = p.get('runs').querySelector('[data-run="one"] .c-st');
  p.patch(next(snapshot([run('one', 'claude', [step('a', 'admission', 'jev', { durationMs: 60 }), step('b', 'allocation', 'jev', { durationMs: 80 })], { state: 'active' }), other])));
  expect(p.get('runs').querySelector('[data-run="other"] .c-st')).toBe(kept);
  expect(p.get('runs').querySelector('[data-run="one"] .c-st')).not.toBe(changed); expect(p.get('runs').querySelector('[data-run="one"]')!.textContent).toContain('진행 중');
});

it('counts an active step live from its recorded start', async () => {
  const started = new Date(Date.now() - 5000).toISOString(), p = page();
  p.push(snapshot([run('r', 'claude', [step('m', 'router', 'host', { state: 'active', at: started, startedAt: started })], { state: 'active', firstAt: started })]));
  const du = () => p.get('trace').querySelector('[data-step="m"] .du2')!.textContent!;
  expect(du()).toMatch(/^5\.\ds$/); expect(opened(p)).toMatch(/기록 사이 경과5\.\ds/);
  await new Promise(r => setTimeout(r, 1100));
  expect(Number.parseFloat(du())).toBeGreaterThanOrEqual(6); expect(opened(p)).toMatch(/기록 사이 경과[6-9]\.\ds/);
});

it('lands a recorded host step on its node, strip and run row without a Jev round trip', async () => {
  const base = run('x', 'codex', [step('t0', 'workers', 'host', { lifecycle: true, title: 'Codex · 도구 시작', at: new Date(Date.now() - 2000).toISOString() })]);
  const p = page(); p.push(snapshot([base])); p.push(snapshot([base]));
  const ticks = () => node(p, 'workers').querySelectorAll('.strip .tr i').length; expect(ticks()).toBe(1);
  p.push(snapshot([run('x', 'codex', [...base.steps, step('t1', 'workers', 'host', { lifecycle: true, title: 'Codex · 도구 결과', at: new Date().toISOString() })])]));
  expect(ticks()).toBe(1);
  await vi.waitFor(() => { expect(node(p, 'workers').classList.contains('zap')).toBe(true); expect(p.get('runs').querySelector('[data-run="x"]')!.classList.contains('zap')).toBe(true); }, { timeout: 3000, interval: 5 });
  expect(ticks()).toBe(2); expect(p.w.document.querySelectorAll('.trip,.rail .ln b')).toHaveLength(0); expect(filled(p)).toHaveLength(0);
});
