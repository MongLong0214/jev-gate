import { Window, type HTMLElement, type SVGElement } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivitySnapshot } from '../src/activity.js';
import { DASHBOARD_PAGE } from '../src/dashboard-page.js';
import { diffFrame, type FrameMemo } from '../src/dashboard-patch.js';
import { buildOperations, type OperationRun, type OperationStep, type OperationsView } from '../src/operations.js';

const windows: Window[] = [];
afterEach(async () => { for (const w of windows.splice(0)) await w.happyDOM.close(); });
const stamp = new Date().toISOString();
const step = (id: string, feature: OperationStep['feature'], lane: OperationStep['lane'], extra: Partial<OperationStep> = {}): OperationStep => ({ id, feature, lane, at: stamp, state: 'done', title: `${feature} outcome`, summary: 'Recorded result', details: [], ...extra });
const run = (id: string, host: 'claude' | 'codex', steps: OperationStep[], extra: Partial<OperationRun> = {}): OperationRun => ({ id, host, title: `${host} execution`, source: 'gate', mode: 'auto', firstAt: stamp, lastAt: stamp, state: 'done', steps, ...extra });
const snapshot = (runs: OperationRun[]) => {
  const all = runs.flatMap(r => r.steps.map(s => ({ ...s, host: r.host, runId: r.id, runTitle: r.title })));
  const ids = ['admission', 'allocation', 'workers', 'router', 'compact', 'evidence'] as const;
  const values = all.filter(s => s.lane === 'jev' && s.durationMs !== undefined).map(s => ({ at: s.at, ms: s.durationMs! }));
  // The frame key replaced the operations signature; Omit keeps this fixture valid with or without the field.
  const operations: OperationsView = { runs, feed: all.slice().reverse(), active: 0, attention: 0, requests: values.length,
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
const filled = (p: ReturnType<typeof page>) => [...p.get('rc').querySelectorAll('li button')];

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
  it('renders all six real feature states and never invents traffic on first load', () => {
    const p = page(); p.push(snapshot([run('c', 'claude', [step('a', 'admission', 'jev', { durationMs: 70 })]), run('x', 'codex', [step('l', 'workers', 'host', { lifecycle: true })])]));
    expect(p.w.document.querySelectorAll('#pipeline .node')).toHaveLength(6);
    expect(node(p, 'workers').classList.contains('idle')).toBe(true); expect(node(p, 'workers').querySelector('.dec b')!.textContent).toBe('–');
    expect(node(p, 'admission').classList.contains('idle')).toBe(false);
    expect(p.w.document.querySelectorAll('.trip,.node.zap,.rail .ln b')).toHaveLength(0); expect(filled(p)).toHaveLength(1);
    expect(p.get('k-p50')).toBeNull(); expect(text(p, 'j-p50')).toBe('70ms'); expect(p.get('rc').querySelectorAll('li')).toHaveLength(14);
  });
  it('recomputes host-filtered latency and treats a filter change as a static view, not new traffic', () => {
    const p = page(), s = snapshot([run('c', 'claude', [step('a', 'admission', 'jev', { durationMs: 70 })]), run('x', 'codex', [step('r', 'router', 'jev', { durationMs: 210 })])]);
    p.push(s); p.push(s); p.click('[data-host="codex"]');
    expect(text(p, 'runs')).toContain('codex execution'); expect(text(p, 'runs')).not.toContain('claude execution');
    expect(text(p, 'j-p50')).toBe('210ms'); expect(text(p, 'j-p95')).toBe('210ms');
    expect(filled(p)).toHaveLength(1); expect(p.w.document.querySelectorAll('.trip')).toHaveLength(0);
    expect(p.w.document.querySelector('[data-host="codex"]')?.getAttribute('aria-pressed')).toBe('true');
  });
  it('searches feature names, exposes filter state and never leaves an empty highlighted run', () => {
    const p = page(); p.push(snapshot([run('searchable', 'claude', [step('allocation', 'allocation', 'jev')]), run('other', 'codex', [step('g', 'workers', 'policy')])]));
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
    expect(text(p, 'j-p95')).toBe('50ms'); expect(p.w.document.querySelectorAll('.trip')).toHaveLength(0); expect(p.get('pause').getAttribute('aria-pressed')).toBe('true');
    p.click('#pause'); expect(text(p, 'j-p95')).toBe('90ms');
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
  it.each([['실행 전 점검 충돌', 'Preflight conflict'], ['실행 예약 기록 불가', 'Reservation unavailable'], ['Codex 워커 시작 거부', 'Codex worker start rejected'], ['Codex 워커 턴 실패', 'Codex worker turn failed'], ['워커 중단', 'Worker interrupted'], ['워커 종료 미확인 · 예약 유지', 'Worker termination unconfirmed · reservation kept']])('translates the Codex dispatch failure reason %s (#233)', (ko, en) => {
    const p = page(); p.push(snapshot([run('failed', 'codex', [step('f', 'workers', 'host', { title: '호스트 호출 실패', state: 'error', summary: `${ko} · jev-gate:worker`, details: ['워커 미실행 · 완료 주장 없음'] })], { title: 'Codex 실행' })]));
    p.click('#language'); p.click('.node[data-feature=workers]');
    const all = ['trace', 'circuit-inspector'].map(id => text(p, id)).join(' ');
    expect(all).not.toMatch(/[가-힣]/); expect(all).toContain(`${en} · jev-gate:worker`); expect(all).toContain('Worker not started · no completion claimed');
  });
  it('renders metadata as text and supports attention filtering and inspector drill-down', () => {
    const p = page(); const hostile = '<img src=x onerror="alert(1)">';
    p.push(snapshot([run('one', 'claude', [step('a', 'admission', 'jev', { summary: hostile })]), run('other', 'codex', [step('r', 'router', 'policy', { state: 'unconfirmed' })], { state: 'attention' })]));
    expect(opened(p)).toContain(hostile); expect(p.get('trace').querySelector('img')).toBeNull();
    p.click('[data-state="attention"]'); expect(text(p, 'runs')).not.toContain('claude execution'); expect(text(p, 'runs')).toContain('codex execution');
    p.click('[data-state="all"]'); p.click('.node[data-feature="admission"]'); p.click('#circuit-inspector [data-inspect-feature]');
    expect(text(p, 'runs')).toContain('claude execution'); expect(text(p, 'runs')).not.toContain('codex execution'); expect(text(p, 'rd-name')).toBe('claude execution');
    // The detail header holds only what the selected row does not show: the start, and the duration where the row hides it.
    expect([...p.get('rd-meta').querySelectorAll('dt')].map(e => e.textContent)).toEqual(['시작', '소요']); expect(p.get('rd-meta').lastElementChild!.className).toBe('rd-du'); expect(p.w.document.getElementById('rd-state')).toBeNull();
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
    const rc = (choice: string, extra: object = {}) => ({ status: 200, code: null, model: 'jev-1.14.0', input: 1200, output: 40, costUsd: 0.0012, choice, confidence: .87, threshold: null, direction: null, ...extra });
    const p = page(); p.push(snapshot([run('r', 'claude', [step('a', 'admission', 'jev', { durationMs: 90, receipt: rc('direct') }), step('m', 'router', 'jev', { durationMs: 120, receipt: rc('claude-sonnet-5 · high', { threshold: .6, direction: 'downgrade' }) })])]));
    const segs = (id: string) => [...node(p, id).querySelectorAll('.dec b span')].map(s => s.textContent);
    expect(segs('router')).toEqual(['sonnet', 'high']); expect(segs('admission')).toEqual(['직접', '0.87']);
    p.click('.node[data-feature=router]'); expect(text(p, 'circuit-inspector')).toContain('120ms'); expect(text(p, 'circuit-inspector')).not.toMatch(/87|60%|0\.6/);
    // The log row carries input tokens; probability and threshold live once, in the decision basis panel.
    expect(text(p, 'rc')).toContain('1,200'); expect(text(p, 'rc')).not.toContain('0.87'); expect(text(p, 'rc')).not.toContain('≈$');
    expect(text(p, 'basis-meta')).toContain('최신 호출을 따라갑니다'); expect(text(p, 'basis-q')).toContain('0.87'); expect(p.get('basis-q').querySelector('b')).toBeNull();
    p.click('#rc button[data-call=m]'); expect(text(p, 'basis-meta')).toContain('고정한 호출'); expect(text(p, 'basis-q')).toContain('sonnet');
    expect(p.get('basis-q').querySelector('b')!.getAttribute('style')).toContain('left: 60%'); expect(p.get('basis-q').querySelector('i.d')!.getAttribute('style')).toContain('width: 87%');
  });
  it('keeps fourteen six-column call-log rows newest first, pins a row and follows the latest again', async () => {
    const calls = (n: number) => Array.from({ length: n }, (_, i) => step('c' + i, 'router', 'jev', { durationMs: 100 + i, at: new Date(Date.parse(stamp) + i * 10).toISOString() }));
    const p = page(); p.push(snapshot([run('r', 'claude', calls(3))]));
    expect(p.get('rc').querySelectorAll('li')).toHaveLength(14); expect(filled(p)).toHaveLength(3); expect(filled(p)[0]!.textContent).toContain('102ms');
    expect(p.w.document.querySelectorAll('.rch > span')).toHaveLength(6); for (const b of filled(p)) expect(b.children).toHaveLength(6);
    expect(filled(p)[0]!.children[3]!.textContent).toBe('–'); expect(p.get('follow').style.visibility).toBe('hidden');
    p.click('#rc button[data-call=c1]'); expect(p.w.document.querySelector('#rc button[data-call=c1]')?.getAttribute('aria-pressed')).toBe('true');
    expect(p.get('follow').style.visibility).toBe('visible');
    p.push(snapshot([run('r', 'claude', calls(5))]));
    await vi.waitFor(() => expect(filled(p)).toHaveLength(5), { timeout: 5000 }); expect(filled(p)[0]!.textContent).toContain('104ms');
    expect(p.w.document.querySelector('#rc button[data-call=c1]')?.getAttribute('aria-pressed')).toBe('true'); expect(text(p, 'basis-meta')).toContain('고정한 호출');
    p.click('#follow'); expect(p.w.document.querySelectorAll('#rc [aria-pressed=true]')).toHaveLength(0); expect(text(p, 'basis-meta')).toContain('최신 호출을 따라갑니다');
  });
  it('counts a request awaiting its response up in its own row and in the badge', async () => {
    const at = new Date(Date.now() - 1500).toISOString();
    const p = page(); p.push(snapshot([run('r', 'claude', [step('w', 'admission', 'jev', { state: 'active', at }), step('d', 'router', 'jev', { durationMs: 80, receipt: { status: 200, code: null, model: 'jev-1.14.0', input: 10, output: 1, costUsd: null, choice: 'claude-sonnet-5 · high', confidence: .9, threshold: .6, direction: null } })])]));
    const wait = p.w.document.querySelector('#rc button[data-call=w]')!;
    expect(wait.textContent).toContain('응답 대기'); expect(wait.querySelector('.run[data-since]')).not.toBeNull();
    expect(p.w.document.querySelector('#pipeline .jb .v')?.textContent).toBe('1.14'); expect(p.w.document.querySelector('#pipeline .rail')?.classList.contains('wait')).toBe(true);
    const first = wait.querySelector('.run')!.textContent; await vi.waitFor(() => expect(wait.querySelector('.run')!.textContent).not.toBe(first), { timeout: 3000 });
  });
  it('estimates today cost from recorded tokens only and labels it as an estimate', () => {
    const p = page(), s = snapshot([run('r', 'claude', [step('c', 'router', 'jev', { durationMs: 100 })])]);
    p.push(s); expect(text(p, 'j-cost')).toBe('–');
    p.push({ ...s, operations: { ...s.operations, latency: { ...s.operations.latency, today: { claude: { calls: 3, input: 9000, costUsd: 0.0042, unpriced: 1 } } } } });
    const note = p.get('j-cost').title;
    expect(text(p, 'j-cost')).toBe('≈ $0.00420'); expect(text(p, 'k-today')).toBe('오늘 3회');
    expect(note).toContain('정가 추정'); expect(note).toContain('API가 알려주지 않습니다'); expect(note).toContain('1회는 제외');
    // Both Jev versions stay priced so records written before an upgrade still cost out; one price, listed once.
    expect(note).toContain('jev-1.13.0 · jev-1.14.0, 100만 토큰당 $0.042'); expect(note.match(/\$0\.042/g)).toHaveLength(1);
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

it('shows a Jev response\'s questions once, in the decision basis panel, with twelve fixed slots, threshold ticks and its reason code', () => {
  const q = (n: number) => Array.from({ length: n }, (_, i) => ({ question: i ? 'q' + i : 'model', value: 'v' + i, confidence: .7, probabilities: [{ label: 'v' + i, value: .7 }, { label: 'x', value: .3 }] }));
  const rc = { status: 200, code: 'model_selected', model: 'jev-1.14.0', input: 300, output: 20, costUsd: null, choice: 'v0', confidence: .7, threshold: .65, direction: null };
  const p = page(); p.push(snapshot([run('decision', 'claude', [step('few', 'admission', 'jev', { durationMs: 40, receipt: rc, judgements: q(2) }), step('many', 'admission', 'jev', { durationMs: 50, at: new Date(Date.parse(stamp) - 1000).toISOString(), receipt: rc, judgements: q(14) })])]));
  const slots = () => [...p.get('basis-q').querySelectorAll('li')];
  expect(slots()).toHaveLength(12); expect(slots().filter(l => l.textContent)).toHaveLength(2);
  expect(p.get('basis-q').querySelectorAll('b')).toHaveLength(1); expect(slots()[0]!.textContent).toContain('모델'); expect(slots()[0]!.textContent).toContain('0.70');
  expect(text(p, 'basis-code')).toBe('model_selected');
  p.click('#rc button[data-call=many]'); expect(slots()).toHaveLength(12); expect(slots()[11]!.textContent).toBe('외 3개'); expect(slots()[10]!.textContent).toContain('q10');
  if (p.w.document.querySelector('#trace button[data-step=few]')?.getAttribute('aria-expanded') !== 'true') p.click('#trace button[data-step=few]');
  expect(opened(p)).not.toContain('70%'); expect(opened(p)).toContain('판단 근거 패널에서 보기');
  p.click('#trace .sd:not([hidden]) button[data-inspect-call]');
  expect(p.w.document.querySelector('#rc button[data-call=few]')?.getAttribute('aria-pressed')).toBe('true'); expect(p.w.document.activeElement?.getAttribute('data-call')).toBe('few');
  p.click('#language'); expect(text(p, 'basis-meta')).toContain('Pinned call');
  p.click('#rc button[data-call=many]'); expect(slots()[11]!.textContent).toBe('+3 more');
});

it('reads a Gate decision as one stage with plain-word basis, call scope, reason and next stage (#269)', () => {
  const rc = { status: 200, code: null, model: 'jev-1.14.0', input: 300, output: 20, costUsd: null, choice: 'direct', confidence: .81, threshold: null, direction: null };
  const next = new Date(Date.parse(stamp) + 1000).toISOString();
  const p = page(); p.push(snapshot([run('g', 'claude', [
    step('a', 'admission', 'jev', { title: 'Gate A · Jev 응답', durationMs: 40, receipt: rc, judgements: [
      { question: 'need_worker', value: '참 확률 19%', confidence: null, probabilities: [{ label: '참', value: .19 }, { label: '거짓', value: .81 }] },
      { question: 'effort_2', value: 'high', confidence: .6, probabilities: [{ label: 'high', value: .6 }, { label: 'low', value: .4 }] }] }),
    step('pa', 'admission', 'policy', { title: 'Gate A · 판정', summary: '직접 처리 · 확신 기준 충족' }),
    step('w', 'workers', 'host', { at: next, title: '워커 · 실행', summary: '완료' }),
  ], { firstAt: new Date(Date.parse(stamp) - 7_260_000).toISOString() })]));
  const slots = [...p.get('basis-q').querySelectorAll('li')].map(l => l.textContent ?? '');
  expect(slots[0]).toContain('거짓'); expect(slots[0]).toContain('0.81'); expect(slots[0]).not.toContain('참 확률');
  expect(slots[1]).toContain('추론 강도 3');
  expect(filled(p).find(b => b.getAttribute('data-call') === 'a')?.textContent).toContain('사용자 요청');
  // The response and its policy are one stage, named by the policy.
  const stages = [...p.get('trace').querySelectorAll('button[data-step]')];
  expect(stages.map(b => b.getAttribute('data-step'))).toEqual(['a', 'w']); expect(stages[0]!.textContent).toContain('Gate A · 판정');
  expect(text(p, 'rd-meta')).toContain('2시간 1분');
  p.click('.node[data-feature=admission]');
  // The card already names the reason, so the inspector does not repeat it.
  expect(node(p, 'admission').querySelector('.nt')!.textContent).toBe('직접 처리 · 확신 기준 충족'); expect(text(p, 'circuit-inspector')).not.toContain('확신 기준 충족'); expect(text(p, 'circuit-inspector')).toContain('워커 · 실행');
  p.click('#language'); expect(text(p, 'rd-meta')).toContain('2h 1m');
});

it('folds consecutive identical settled records into one stage with their count and span (#269)', () => {
  const t = (s: number) => new Date(Date.parse(stamp) + s * 1000).toISOString();
  const check = (i: number, extra: Partial<OperationStep> = {}) => step('c' + i, 'router', 'local', { at: t(i), title: 'Router · 루트 응답 모델 확인', summary: '일치', ...extra });
  const p = page(); p.push(snapshot([run('r', 'claude', [check(0), check(1), check(2), check(3, { summary: '불일치', state: 'error' })])]));
  const stages = [...p.get('trace').querySelectorAll('button[data-step]')];
  expect(stages.map(b => b.getAttribute('data-step'))).toEqual(['c2', 'c3']); expect(stages[0]!.textContent).toContain('×3'); expect(stages[1]!.textContent).not.toContain('×');
  p.click('#trace button[data-step=c2]'); expect(opened(p)).toContain('반복 기록'); expect(opened(p)).toContain('3건');
});

it('names the reason under each circuit card and draws its recorded confidence as a bar', () => {
  const rc = { status: 200, code: null, model: 'jev-1.14.0', input: 300, output: 20, costUsd: null, choice: 'direct', confidence: .82, threshold: null, direction: null };
  const p = page(); p.push(snapshot([run('c', 'claude', [step('a', 'admission', 'jev', { durationMs: 40, receipt: rc }), step('pa', 'admission', 'policy', { summary: '직접 처리 · 확신 기준 충족' })])]));
  expect(node(p, 'admission').querySelector('.nt')!.textContent).toBe('직접 처리 · 확신 기준 충족');
  expect(node(p, 'admission').querySelector('.pb i')!.getAttribute('style')).toContain('width: 82%');
  expect(node(p, 'router').querySelector('.nt')!.textContent).toBe(''); expect(node(p, 'router').querySelector('.pb i')!.getAttribute('style')).toContain('width: 0%');
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

it('shows a ten-thousand-step execution in a bounded timeline with one record list, drawn in the task after its frame', async () => {
  const p = page(), steps = Array.from({ length: 10001 }, (_, i) => step('cycle' + i, 'router', 'host', { summary: 'cycle ' + i })); p.push(snapshot([run('large', 'codex', steps)]));
  expect(p.get('trace').querySelectorAll('[data-step]')).toHaveLength(0);
  await vi.waitFor(() => expect(p.get('trace').children).toHaveLength(100)); expect(p.get('trace').querySelectorAll('[aria-expanded="true"]')).toHaveLength(1);
  // A patch that arrives before that draw applies to the frame it follows and is drawn; the frame is not drawn over it later.
  const next = frames(), q = page(), large = run('large', 'codex', steps), streams = q.streams();
  q.push(next(snapshot([large]))); q.patch(next(snapshot([large, run('small', 'claude', [step('g', 'workers', 'policy')])])));
  expect(rows(q)).toHaveLength(2);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(rows(q)).toHaveLength(2); expect(q.streams()).toBe(streams);
});

it('fills the first rows of a long list at once and the rest in later tasks, counting all of them', async () => {
  const p = page(), many = Array.from({ length: 45 }, (_, i) => run('run' + i, 'claude', [step('a' + i, 'admission', 'jev', { durationMs: 60 })]));
  p.push(snapshot(many));
  const shown = () => [...rows(p)].map(b => b.textContent);
  expect(shown()).toHaveLength(45); expect(shown().filter(Boolean)).toHaveLength(20);
  expect(p.w.document.querySelector('#state-filters em')).toBeNull(); expect(text(p, 'run-count')).toContain('45');
  await vi.waitFor(() => expect(shown().every(Boolean)).toBe(true));
});

it('draws one strip tick per record of the last minute, caps a burst of trips and shows no per-minute rate', () => {
  const old = step('old', 'router', 'jev', { at: new Date(Date.now() - 90_000).toISOString(), durationMs: 40 });
  const base = Date.now(), records = (n: number) => Array.from({ length: n }, (_, i) => step(`r${i}`, 'router', 'jev', { durationMs: 50 + i, at: new Date(base + i).toISOString() }));
  const p = page(); p.push(snapshot([run('r', 'claude', [old, ...records(3)])]));
  expect(node(p, 'router').querySelectorAll('.strip .tr i')).toHaveLength(3); expect(node(p, 'router').querySelector('.strip')!.getAttribute('aria-hidden')).toBe('true');
  expect(filled(p)).toHaveLength(4);
  const rate = /\/분|분당|최근 1분|처리량|per minute|\/min/;
  expect(p.w.document.body.textContent).not.toMatch(rate); p.click('#language'); expect(p.w.document.body.textContent).not.toMatch(rate);
  const burst = page(); burst.push(snapshot([run('r', 'claude', records(1))])); burst.push(snapshot([run('r', 'claude', records(1))]));
  burst.push(snapshot([run('r', 'claude', records(40))]));
  // The newest 24 wait for their trips; the older backlog shows at once.
  expect(burst.get('rc').querySelector('button')!.textContent).toContain('65ms');
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
  const next = frames(), a = step('a', 'admission', 'jev', { durationMs: 60 }), other = run('other', 'codex', [step('g', 'workers', 'policy')]);
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
  const next = frames(), other = run('other', 'codex', [step('g', 'workers', 'policy')]);
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
  // The row counts the stage live; its open detail does not repeat that count.
  expect(du()).toMatch(/^5\.\ds$/); expect(opened(p)).not.toContain('기록 사이 경과');
  await new Promise(r => setTimeout(r, 1100));
  expect(Number.parseFloat(du())).toBeGreaterThanOrEqual(6);
});

it('grows the bar of a running stage on the same tick as its duration', async () => {
  const now = Date.now(), started = new Date(now - 2000).toISOString(), p = page();
  p.push(snapshot([run('r', 'claude', [step('d', 'router', 'host', { at: new Date(now - 10_000).toISOString(), durationMs: 1000 }), step('m', 'router', 'host', { state: 'active', at: started, startedAt: started })], { state: 'active' })]));
  const width = (id: string) => Number.parseFloat((p.get('trace').querySelector(`[data-step="${id}"] .bar i`) as HTMLElement).style.width);
  const running = width('m'), settled = width('d');
  await vi.waitFor(() => expect(width('m')).toBeGreaterThan(running + 1), { timeout: 3000 });
  // The span grows with it, so the settled stage takes a smaller share.
  expect(width('d')).toBeLessThan(settled);
});

it('fetches the detail fields a frame leaves out for the opened stage and the inspected card only, and keeps them while that stage is unchanged', async () => {
  const next = frames(), p = page();
  const full = step('s2', 'router', 'host', { details: ['baseline gpt-6.1-sol · xhigh'], sessionId: 'cx-9', routing: { scope: 'root', baseline: 'gpt-6.1-sol', modelReason: 'same_value', effortReason: 'same_value' } });
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('s2') ? full : { ...step('s1', 'router', 'host', { summary: 'First result' }), details: ['first stage evidence'] } }));
  Object.assign(p.w, { fetch });
  const { details: _details, sessionId: _session, routing: _routing, ...slim } = full, { details: _first, ...first } = step('s1', 'router', 'host', { summary: 'First result' });
  const frame = (more: OperationRun[] = []) => snapshot([run('r/1', 'codex', [first, slim] as OperationStep[]), ...more]);
  p.push(next(frame()));
  expect(opened(p)).toContain('결과Recorded result'); expect(opened(p)).not.toContain('라우팅 대상');
  // The inspector reads its card's stage (s1, the first of the latest records) and the run detail its opened stage.
  expect(fetch.mock.calls.map(c => c[0])).toEqual(['/api/step?run=r%2F1&step=s1', '/api/step?run=r%2F1&step=s2']);
  await vi.waitFor(() => expect(opened(p)).toContain('라우팅 대상메인 턴')); expect(opened(p)).toContain('baseline gpt-6.1-sol · xhigh');
  p.patch(next(frame([run('other', 'claude', [step('g', 'workers', 'policy')])])));
  expect(opened(p)).toContain('baseline gpt-6.1-sol · xhigh'); expect(fetch).toHaveBeenCalledTimes(2);
  p.click('[data-step="s1"]'); await vi.waitFor(() => expect(opened(p)).toContain('first stage evidence'));
  expect(fetch).toHaveBeenCalledTimes(2);
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

it('counts only current failures at the top, keeps settled ones as past errors and redraws a reclassification from a patch (#223)', () => {
  const day = new Date(Date.now() - 86_400_000).toISOString(), next = frames();
  const outage = (now: 'unknown' | 'later_ok') => run('outage', 'codex', [step('cfg', 'evidence', 'local', { at: day, state: 'error', issue: 'evidence', cause: 'unavailable_config', sessionId: 'cx-session-1', title: 'Evidence · 근거 결과', impact: { now, lastAt: now === 'unknown' ? day : stamp, lastState: now === 'unknown' ? 'error' : 'done' } })], { state: now === 'unknown' ? 'attention' : 'past_error', title: 'Evidence 검색', source: 'evidence', firstAt: day, lastAt: day });
  const refused = run('refused', 'codex', [step('bad', 'evidence', 'local', { at: day, state: 'error', issue: 'evidence', cause: 'invalid_input', sessionId: 'cx-session-2', title: 'Evidence · 근거 결과', impact: { now: 'request_only', lastAt: stamp, lastState: 'done' } })], { state: 'past_error', title: 'Evidence 검색', source: 'evidence', firstAt: day, lastAt: day });
  // #269: two mismatches in one run are one execution to check, so the diagnosis counts it once.
  const wrong = (id: string) => step(id, 'router', 'host', { state: 'error', model: { selected: 'claude-opus-5-5', observed: 'claude-sonnet-5', status: 'mismatch', selectedEffort: null, observedEffort: null }, impact: { now: 'unknown', lastAt: stamp, lastState: 'error' } });
  const mismatch = run('mismatch', 'claude', [wrong('m'), wrong('m2')], { state: 'attention', source: 'router' });
  // The filters carry labels only; a count lives once, at the top, and each row shows its own state.
  const p = page(), shown = (cls: string) => p.get('runs').querySelectorAll('.c-st.' + cls).length;
  p.push(next(snapshot([mismatch, outage('unknown'), refused])));
  expect(text(p, 'k-att')).toBe('2'); expect(text(p, 'k-diag')).toBe('실제 응답 모델 불일치 1건 · Evidence 사용 불가·오류 1건');
  expect([shown('er'), shown('past')]).toEqual([2, 1]); expect(p.w.document.querySelector('#state-filters em')).toBeNull();
  p.click('[data-run="outage"]');
  for (const fact of ['원인unavailable_config', '현재 영향현재 영향 미확인', '호스트Codex', '세션cx-session-1']) expect(opened(p)).toContain(fact);
  p.click('[data-run="refused"]');
  expect(opened(p)).toContain('원인invalid_input · 요청 인자·범위 오류'); expect(opened(p)).toContain('현재 영향이 요청만 실패 · 서비스 장애 아님'); expect(opened(p)).toContain('마지막 관측');
  // A later success arrives as a patch: the same row is redrawn as a past error and leaves the current count.
  p.patch(next(snapshot([mismatch, outage('later_ok'), refused])));
  expect(text(p, 'k-att')).toBe('1'); expect(text(p, 'k-diag')).toBe('실제 응답 모델 불일치 1건');
  expect([shown('er'), shown('past')]).toEqual([1, 2]);
  expect(p.get('runs').querySelector('[data-run="outage"] .c-st')!.textContent).toBe('지난 오류');
  p.click('[data-run="outage"]'); expect(opened(p)).toContain('현재 영향이후 같은 작업 정상 기록'); expect(opened(p)).not.toContain('상태오류'); expect(p.get('trace').querySelector('[aria-expanded="true"] .sx-r')!.textContent).toBe('오류');
  p.click('[data-host="codex"]');
  expect(text(p, 'k-att')).toBe('0'); expect(text(p, 'k-diag')).toBe('지난 오류 2건');
  p.click('[data-state="past_error"]'); expect(rows(p)).toHaveLength(2);
  p.click('[data-host="claude"]'); expect(text(p, 'k-att')).toBe('1'); expect(rows(p)).toHaveLength(0);
  p.click('#language'); p.click('[data-host="all"]'); p.click('[data-state="attention"]'); p.click('[data-run="mismatch"]');
  expect(text(p, 'k-diag')).toBe('Response model mismatch 1 recorded'); expect(opened(p)).toContain('Current impactCurrent impact unknown');
});

it('shows a refused worker contract as its own failure through a later host end and draws a later accept as a separate record (#232)', () => {
  const t = (sec: number) => new Date(Date.now() - 60_000 + sec * 1000).toISOString(), own = { session_id: 'claude-232', mode: 'auto', version: '0.8.18' };
  const post = (sec: number, verdict: string, reason: string | null, unobserved: string[]) => ({ ...own, phase: 'post', prompt_id: 'p', tool_use_id: `w${sec}`, invocation_id: `post-${sec}`, written_at: t(sec), task_id: 'single', attempt: 1,
    verdict, verdict_reason: reason, reported_checks: { pass: 1, fail: 0, not_run: 0 }, requested_model: 'sonnet', resolved_model: 'claude-sonnet-5', subagent_type: 'jev-gate:worker',
    tool_response: { status: 'completed' }, verification: { transcript: 'read', contradicted: [], unobserved, stale: [] } });
  const records = [post(1, 'incomplete', "check #1 was reported pass, but the worker's own transcript shows no passing run of it", ['#1']),
    { ...own, phase: 'background_terminal', prompt_id: 'q', execution_prompt_id: 'p', tool_use_id: 'w1', invocation_id: 'terminal-2', written_at: t(2), status: 'completed', task_id: 'single' },
    { ...own, phase: 'background_policy_delivery', prompt_id: 'q', execution_prompt_id: 'p', invocation_id: 'delivery-3', written_at: t(3), reason: 'policy_delivered_no_active_execution' }];
  const view = (rs: object[]) => ({ ...snapshot([]), operations: buildOperations(rs as never, [], new Date(), { trace: true }) }), next = frames(), p = page();
  p.push(next(view(records)));
  const id = p.get('runs').querySelector('button[data-run]')!.getAttribute('data-run')!, state = () => p.get('runs').querySelector(`[data-run="${id}"] .c-st`)!.textContent;
  expect(rows(p)).toHaveLength(1); expect(text(p, 'k-att')).toBe('1'); expect(text(p, 'k-diag')).toBe('워커 계약 미충족 1건'); expect(state()).toBe('확인 필요');
  p.click(`[data-run="${id}"]`);
  const marks = () => [...p.get('trace').querySelectorAll('.sx-r')].map(e => e.textContent);
  expect(marks()).toContain('계약 미충족'); expect(marks()).not.toContain('계약 수락');
  // The later host end stays visible as its own row, never as acceptance.
  expect(marks()).toContain('호스트 종료');
  for (const fact of ['single · 계약 미충족 · incomplete · 통과 보고 검사의 실행 미관측', '미관측 #1', '원인check_unobserved', '현재 영향현재 영향 미확인']) expect(opened(p)).toContain(fact);
  expect(text(p, 'trace')).not.toContain('transcript shows');
  // The inspector does not repeat the decision its selected card shows.
  p.click('.node[data-feature=workers]'); expect(node(p, 'workers').querySelector('.dec b')!.textContent).toBe('계약 미충족'); expect(text(p, 'circuit-inspector')).not.toContain('계약 미충족');
  p.click('#language');
  expect(marks()).toContain('Contract not met'); expect(text(p, 'k-diag')).toBe('Worker contract not met 1 recorded');
  expect(opened(p)).toContain('Reported pass not seen in the worker transcript');
  // A later accept of the same task arrives as a patch: the refusal stays recorded and only leaves the current count.
  p.patch(next(view([...records, post(9, 'accept', null, [])])));
  expect(text(p, 'k-att')).toBe('0'); expect(marks()).toEqual(expect.arrayContaining(['Contract not met', 'Contract accepted']));
  p.click('#language'); expect(state()).toBe('지난 오류');
});
