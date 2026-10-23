import { Window, type HTMLElement } from 'happy-dom';
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
  const ids = ['admission', 'allocation', 'workers', 'router', 'compact'] as const;
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
type Page = ReturnType<typeof page>;

const text = (p: Page, id: string) => p.get(id).textContent ?? '';
// An execution opens as its own view at #run=<id>; an empty hash returns to the overview.
const go = (p: Page, id: string | null) => { p.w.location.hash = id === null ? '' : '#run=' + encodeURIComponent(id); p.w.dispatchEvent(new p.w.Event('hashchange')); };
const opened = (p: Page) => text(p, 'step-detail');
const rows = (p: Page) => p.get('runs').querySelectorAll('a[data-run]');
const stage = (p: Page, id: string) => p.w.document.querySelector(`#stages button[data-feature="${id}"]`)! as HTMLElement;
const line = (p: Page, id: string) => stage(p, id).querySelector('.sn .d')!.textContent ?? '';
const filled = (p: Page) => [...p.get('rc').querySelectorAll('button[data-call]')];
const marks = (p: Page) => [...p.get('trace').querySelectorAll('.bar em')].map(e => e.textContent);

it('only attaches populated history rows and reuses their links when 200 runs reorder', async () => {
  const p = page(), history = Array.from({ length: 200 }, (_, i) => run('history-' + i, 'claude', [step('s-' + i, 'router', 'host')]));
  p.push(snapshot(history));
  expect([...rows(p)].every(b => b.textContent?.trim() && b.getAttribute('aria-label'))).toBe(true);
  // Batched frames run in a disposable DOM alongside the full suite; this checks eventual
  // population/identity. Actual rendering latency and layout are covered by Chromium.
  await vi.waitFor(() => expect(rows(p)).toHaveLength(200), { timeout: 4000 });
  const link = p.w.document.querySelector('[data-run="history-100"]')!;
  expect(link.getAttribute('href')).toBe('#run=history-100');
  link.dispatchEvent(new p.w.PointerEvent('pointerdown', { bubbles: true }));
  const reordered = [history[100]!, ...history.filter((_, i) => i !== 100)];
  p.push(snapshot(reordered));
  expect(rows(p)[100]).toBe(link);
  link.dispatchEvent(new p.w.PointerEvent('pointerup', { bubbles: true }));
  await vi.waitFor(() => expect(rows(p)[0]).toBe(link), { timeout: 4000 });
  expect([...rows(p)].every(b => b.textContent?.trim() && b.getAttribute('aria-label'))).toBe(true);
});

it('keeps a worker stage without a contract verdict honest in both languages', () => {
  const p = page();
  for (const outcome of [undefined, 'host_ended'] as const) {
    p.push(snapshot([run('native', 'claude', [step('native', 'workers', 'host', outcome ? { outcome } : {})])]));
    expect(line(p, 'workers')).toMatch(/^판정 없음/);
  }
  expect(line(p, 'workers')).toContain('호스트 종료');
  p.click('#language'); expect(line(p, 'workers')).toMatch(/^No verdict · Host ended/);
});

it('shows doctor activity counts in the stage table and the complete facts in each stage title', () => {
  const p = page(), s = snapshot([run('r', 'claude', [step('x', 'router', 'host')])]);
  const facts = [{ feature: 'router', level: 'warn', metrics: { fired: 9, applied: 3, effect: null, regression: 1 } }];
  p.push({ ...s, activity24h: { all: facts, claude: facts, codex: [] } });
  const cells = () => [...stage(p, 'router').querySelectorAll('.v')].map(e => e.textContent);
  expect(cells()).toEqual(['9', '3', '1']); expect(stage(p, 'router').querySelector('.v.r')!.classList.contains('er')).toBe(true);
  expect(stage(p, 'router').classList.contains('err')).toBe(true);
  expect(stage(p, 'router').title).toContain('24h 주의 · 발화 9 · 적용 3 · 회귀 1'); expect(stage(p, 'router').title).toContain('효과 (루트 비용 추정) 미확인');
  p.click('#language'); expect(stage(p, 'router').title).toContain('effect (root cost estimate) unknown');
  p.click('[data-host=codex]'); expect(stage(p, 'router').title).toMatch(/^24h untrackable/); expect(cells()).toEqual(['–', '–', '–']);
});

it('shows each host Compact facts without borrowing Claude restore metrics for Codex', () => {
  const p = page(), s = snapshot([]);
  const claude = { feature: 'compact', level: 'ok', metrics: { fired: 2, applied: 1, effect: null, regression: 0, restored: 2, budgetUsed: 1200, budget: 8000 } };
  const codex = { feature: 'compact', level: 'warn', metrics: { fired: 4, applied: 3, effect: null, regression: 1, codexAssessed: 2, codexSubmitted: 3, codexCompleted: 1 } };
  p.push({ ...s, activity24h: { all: [claude, codex], claude: [claude], codex: [codex] } });
  const title = () => stage(p, 'compact').title;
  expect(title()).toContain('발화 6 · 적용 4 · 회귀 1');
  expect(title()).toContain('Claude 복원 2');
  expect(title()).toContain('Codex Jev 판정 2 · 전송 적용 3 · 응답 완료 1');
  p.click('[data-host=codex]');
  expect(title()).not.toMatch(/복원|예산/);
  expect(title()).toContain('총 토큰 효과 미측정');
  p.click('#language');
  expect(title()).toContain('Jev assessed 2 · applied submissions 3 · completed responses 1');
  p.click('[data-host=claude]');
  expect(title()).toContain('restored 2 · budget 1,200 / 8,000');
  expect(title()).not.toContain('Jev assessed');
});

it.each([[0, '+$0.00'], [-.67486, '−$0.67'], [[-.1, .2], '−$0.10 / +$0.20']])('renders Router net %j without cache-price assumptions', (effect, expected) => {
  const p = page(), s = snapshot([]), facts = [{ feature: 'router', level: 'ok', metrics: { fired: 1, applied: 1, regression: 0, effect } }];
  p.push({ ...s, activity24h: { all: facts, claude: facts, codex: [] } });
  expect(line(p, 'router')).toBe('기록 없음');
  expect(stage(p, 'router').title).toContain(expected);
});

it.each(['tool_editing_floor', 'tool_read_only', 'tool_editing', 'not_checked', 'upgrade_allowed', 'cost_allows', 'basis_absent', 'child_pair_changed_before_submission', 'ok', 'invalid', 'unknown_model', 'ambiguous'])('labels emitted reason %s and preserves future codes in either language', reason => {
  const p = page(), s = (code: string) => snapshot([run('r', 'claude', [step('x', 'router', 'host', { routing: { scope: 'root', baseline: 'opus', modelReason: code, effortReason: code } })])]);
  p.push(s(reason)); expect(line(p, 'router')).not.toContain(reason);
  p.click('#language'); expect(line(p, 'router')).not.toContain(reason);
  p.push(s('future_reason_987')); go(p, 'r');
  for (let i = 0; i < 2; i++) {
    expect(line(p, 'router')).not.toContain('future_reason_987');
    const raw = p.get('step-detail').querySelector('details.raw')!; expect(raw.hasAttribute('open')).toBe(false); expect(raw.textContent).toContain('future_reason_987');
    expect(p.get('step-detail').querySelector('dl')!.textContent).not.toContain('future_reason_987'); p.click('#language');
  }
});

it('keeps raw hook diagnostics folded while the decision and its cause remain human readable (#330)', () => {
  const p = page(), diagnostic = 'loaded hook version 0.8.33 · 0123456789abcdef';
  p.push(snapshot([run('diag', 'codex', [step('d', 'router', 'host', { summary: 'legacy_model', cause: 'fable_disabled_by_config', state: 'error', details: [diagnostic], routing: { scope: 'root', baseline: 'gpt-6.1-sol', modelReason: 'fable_disabled_by_config', effortReason: 'selected' } })])]));
  go(p, 'diag');
  const detail = p.get('step-detail'), raw = detail.querySelector('details.raw')!;
  expect(raw.hasAttribute('open')).toBe(false); expect(raw.textContent).toContain(diagnostic); expect(raw.textContent).toContain('fable_disabled_by_config');
  expect(detail.querySelector('dl')!.textContent).not.toMatch(/loaded.hook|0123456789abcdef|legacy_model|fable_disabled_by_config/);
  expect(detail.querySelector('dl')!.textContent).toContain('이전 모델 기록');
});

describe('dashboard live interactions', () => {
  it('shows the running version and honest latest-release status only when a version is known, in both languages', () => {
    const p = page(), release = { latest: '0.8.15', checkedAt: stamp, error: null }, badge = () => p.get('version-badge'), aria = () => (badge() as unknown as { ariaLabel: string }).ariaLabel;
    expect(badge().hidden).toBe(true);
    p.push({ ...snapshot([]), version: { running: null, installed: null, release: null } });
    expect(badge().hidden).toBe(true);
    p.push({ ...snapshot([]), version: { running: '0.8.14', installed: '0.8.14', release } });
    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe('v0.8.14 → 0.8.15'); expect(badge().dataset.state).toBe('update');
    p.push({ ...snapshot([]), version: { running: '0.8.15', installed: '0.8.15', release } });
    expect(badge().dataset.state).toBe('current'); expect(badge().textContent).toBe('v0.8.15'); expect(aria()).toContain('최신');
    p.click('#language'); expect(aria()).toContain('Current');
    p.push({ ...snapshot([]), version: { running: '0.8.15', installed: '0.8.15', release: { ...release, latest: null, error: 'offline' } } });
    expect(badge().dataset.state).toBe('unknown'); expect(aria()).toContain('unknown');
    p.push({ ...snapshot([]), version: { running: '0.8.14', installed: '0.8.15', release } });
    expect(badge().dataset.state).toBe('mismatch'); expect(badge().textContent).toBe('v0.8.14 ≠ v0.8.15');
  });
  it('shows model facts from the opened stage without turning another response into its observed model', () => {
    const p = page();
    const selected = { selected: 'gpt-6-luna', observed: null, status: 'unobserved' as const, selectedEffort: 'low', observedEffort: null };
    p.push(snapshot([run('models', 'codex', [step('response', 'router', 'host', { model: { ...selected, selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed' } }), step('request', 'router', 'host', { model: selected })])]));
    go(p, 'models'); p.click('[data-step="response"]');
    expect(opened(p)).toContain('gpt-6.1-sol'); expect(opened(p)).toContain('일치');
    p.click('[data-step="request"]');
    expect(opened(p)).toContain('gpt-6-luna'); expect(opened(p)).toContain('응답 모델 기록 없음'); expect(opened(p)).not.toContain('gpt-6.1-sol');
    expect(p.get('trace').querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    p.click('#language'); expect(opened(p)).toContain('No response model recorded');
  });
  it('names the actual warning category in the header and opens the failing stage', () => {
    const p = page();
    p.push(snapshot([run('effort', 'codex', [step('old', 'router', 'host', { state: 'error', issue: 'request_effort', summary: '선택 high · 전송 xhigh' }), step('recent', 'router', 'host')], { state: 'attention' })]));
    expect(text(p, 'k-att')).toBe('1'); expect(text(p, 'k-diag')).toContain('API 전송 effort 불일치 1건');
    p.click('#language'); expect(text(p, 'k-diag')).toContain('API request effort mismatch');
    p.click('#language'); go(p, 'effort'); expect(opened(p)).toContain('선택 high · 전송 xhigh');
    expect(p.w.document.querySelector('#trace [aria-pressed="true"]')?.getAttribute('data-step')).toBe('old');
  });
  it('shows Compact selection evidence in its stage detail and the measured response in the call log', () => {
    const p = page();
    p.push(snapshot([run('compact', 'claude', [step('selection', 'compact', 'jev', { durationMs: 220, details: ['후보 8/16 · 필수 근거 3', 'Jev 작업 의존 근거 선택'] })])]));
    expect(filled(p)[0]!.textContent).toContain('220ms');
    go(p, 'compact'); expect(opened(p)).toContain('후보 8/16 · 필수 근거 3'); expect(text(p, 'trace')).not.toContain('호스트 훅에서 결과 이벤트가 빠진');
  });
  it.each([
    ['no_current_task', '사람이 입력한 현재 작업 없음', 'No current human task'],
    ['no_prior_assistant', '이전 assistant 메시지 없음', 'No prior assistant message'],
  ] as const)('renders classic Compact reason %s in both languages', (selection, ko, en) => {
    const p = page();
    const operations = buildOperations([], [{ at: stamp, component: 'compact', rec: { event: 'compact', path: 'classic', session_id: 's', stage: 'pre', guided: true, selection } }], new Date(stamp), { trace: true });
    p.push({ ...snapshot([]), operations }); go(p, operations.runs[0]!.id);
    expect(opened(p)).toContain(ko);
    p.click('#language');
    expect(opened(p)).toContain(`Jev selection · ${en}`);
  });
  it('renders all five real feature stages and never invents traffic on first load', () => {
    const p = page(); p.push(snapshot([run('c', 'claude', [step('a', 'admission', 'jev', { durationMs: 70 })]), run('x', 'codex', [step('l', 'workers', 'host', { lifecycle: true })])]));
    expect([...p.w.document.querySelectorAll('#stages button.st')].map(n => (n as HTMLElement).dataset['feature'])).toEqual(['admission', 'allocation', 'workers', 'router', 'compact']);
    expect(line(p, 'workers')).toBe('기록 없음'); expect(stage(p, 'workers').classList.contains('busy')).toBe(false);
    expect(stage(p, 'admission').classList.contains('busy')).toBe(true);
    expect(p.w.document.querySelectorAll('.lane,.stem,.fresh,.hit,.hot')).toHaveLength(0); expect(filled(p)).toHaveLength(1);
    expect(text(p, 'j-p50') + text(p, 'j-p50-u')).toBe('70ms'); expect(p.get('rc').querySelectorAll('li')).toHaveLength(8);
  });
  it('recomputes host-filtered latency and treats a filter change as a static view, not new traffic', () => {
    const p = page(), s = snapshot([run('c', 'claude', [step('a', 'admission', 'jev', { durationMs: 70 })]), run('x', 'codex', [step('r', 'router', 'jev', { durationMs: 210 })])]);
    p.push(s); p.push(s); p.click('[data-host="codex"]');
    expect(text(p, 'runs')).toContain('codex execution'); expect(text(p, 'runs')).not.toContain('claude execution');
    expect(text(p, 'j-p50') + text(p, 'j-p50-u')).toBe('210ms'); expect(text(p, 'j-p95')).toBe('p50 · p95 210ms');
    expect(filled(p)).toHaveLength(1); expect(p.w.document.querySelectorAll('.lane,.stem,.fresh')).toHaveLength(0);
    expect(p.w.document.querySelector('[data-host="codex"]')?.getAttribute('aria-pressed')).toBe('true');
  });
  it('exposes the run filter state and never leaves an empty list without its reason', () => {
    const p = page(); p.push(snapshot([run('one', 'claude', [step('allocation', 'allocation', 'jev')]), run('other', 'codex', [step('g', 'workers', 'policy')])]));
    expect(rows(p)).toHaveLength(2); expect(text(p, 'n-all')).toBe('2'); expect(text(p, 'n-active')).toBe('0');
    p.click('[data-state=active]'); expect(p.w.document.querySelector('[data-state=active]')?.getAttribute('aria-pressed')).toBe('true');
    expect(rows(p)).toHaveLength(0); expect(p.get('runs').querySelector('li.empty')?.textContent).toContain('조건에 맞는 실행이 없습니다');
    for (const li of p.get('runs').querySelectorAll('li')) expect(li.textContent?.trim()).not.toBe('');
  });
  it('says so when an opened execution is not in the records', () => {
    const p = page(); p.push(snapshot([run('one', 'claude', [step('a', 'admission', 'jev')])])); go(p, 'gone');
    expect(p.get('overview').hidden).toBe(true); expect(p.get('trace-view').hidden).toBe(false);
    expect(text(p, 'rd-name')).toBe('실행을 찾을 수 없습니다'); expect(p.get('trace').querySelector('li.empty')).not.toBeNull();
    go(p, null); expect(p.get('overview').hidden).toBe(false); expect(p.get('trace-view').hidden).toBe(true);
  });
  it('updates values and the call log immediately, independently of round-trip motion', async () => {
    const p = page(), a = step('a', 'admission', 'jev', { durationMs: 60 }); p.push(snapshot([run('one', 'claude', [a])])); p.push(snapshot([run('one', 'claude', [a])]));
    p.push(snapshot([run('one', 'claude', [a, step('b', 'allocation', 'jev', { durationMs: 80, at: new Date().toISOString() })]), run('other', 'codex', [step('w', 'workers', 'host', { at: new Date().toISOString() })])]));
    expect(line(p, 'allocation')).not.toBe('기록 없음'); expect(filled(p)).toHaveLength(2);
    await vi.waitFor(() => expect(filled(p)).toHaveLength(2), { timeout: 5000 });
    expect(line(p, 'allocation')).not.toBe('기록 없음'); expect(line(p, 'workers')).not.toBe('기록 없음');
    expect(text(p, 'rc')).not.toContain('워커');
  });
  it('preserves keyboard focus when a live snapshot updates the stages', () => {
    const p = page(); const a = step('a', 'admission', 'jev'); p.push(snapshot([run('one', 'claude', [a])]));
    (stage(p, 'allocation') as unknown as { focus(): void }).focus();
    p.push(snapshot([run('one', 'claude', [a, step('b', 'allocation', 'jev')])]));
    expect(p.w.document.activeElement?.getAttribute('data-feature')).toBe('allocation');
  });
  it('pauses updates without motion, resumes the pending snapshot and keeps mismatch explicit in the stage detail', () => {
    const p = page(); p.push(snapshot([run('one', 'claude', [step('a', 'admission', 'jev', { durationMs: 50 })])])); p.click('#pause');
    p.push(snapshot([run('one', 'claude', [step('m', 'workers', 'host', { model: { selected: 'opus', observed: 'claude-sonnet-5', status: 'mismatch', selectedEffort: 'high', observedEffort: null } }), step('b', 'allocation', 'jev', { durationMs: 90, at: new Date(Date.parse(stamp) + 1000).toISOString() })])]));
    expect(text(p, 'j-p95')).toBe('p50 · p95 50ms'); expect(p.w.document.querySelectorAll('.lane,.stem')).toHaveLength(0); expect(p.get('pause').getAttribute('aria-pressed')).toBe('true');
    expect(text(p, 'connection')).toBe('일시정지 · +1'); expect(text(p, 'log-resume')).toBe('새 호출 1건 · 재개');
    p.click('#log-resume'); expect(text(p, 'j-p95')).toBe('p50 · p95 90ms'); expect(p.get('log-resume').hidden).toBe(true);
    go(p, 'one'); p.click('[data-step="m"]'); expect(opened(p)).toContain('불일치'); expect(opened(p)).toContain('claude-sonnet-5');
    p.click('#language'); expect(opened(p)).toContain('Mismatch'); expect(p.w.document.documentElement.lang).toBe('en');
    p.click('#theme'); expect(p.w.document.documentElement.dataset.theme).toBe('light');
  });
  it('shows the observed request effort without claiming an unreported response effort', () => {
    const p = page(); p.push(snapshot([run('codex', 'codex', [step('wire', 'router', 'host', { model: { selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed', selectedEffort: 'low', observedEffort: null, forwardedEffort: 'low', effortSource: 'provider_request' } })])]));
    go(p, 'codex'); expect(opened(p)).toContain('API 전송 effort low'); expect(opened(p)).toContain('호스트 응답에 미제공');
    p.click('#language'); expect(opened(p)).toContain('API request effort low'); expect(opened(p)).toContain('Not reported by host');
  });
  it('fully translates the run list, stages, call log and stage detail without changing model IDs', () => {
    const p = page(); const r = run('translated', 'codex', [step('observed', 'router', 'host', {
      title: 'Router · root_result', summary: '선택 모델과 실제 모델 일치 · gpt-6.1-sol', details: ['기존 모델 gpt-6.1-sol'],
      model: { selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed', selectedEffort: null, observedEffort: null },
    })], { title: 'Codex 실행' }); p.push(snapshot([r])); p.click('#language');
    const overview = ['runs', 'stages', 'rc', 'basis'].map(id => text(p, id)).join(' ');
    go(p, 'translated');
    const all = overview + ' ' + ['crumb', 'rd-name', 'rd-meta', 'rd-stats', 'trace', 'step-detail'].map(id => text(p, id)).join(' ');
    expect(all).not.toMatch(/[가-힣]/); expect(all).toContain('Selected and observed models match');
    expect(all).toContain('Decision basis'); expect(all).toContain('gpt-6.1-sol');
  });
  it.each([['실행 전 점검 충돌', 'Preflight conflict'], ['실행 예약 기록 불가', 'Reservation unavailable'], ['Codex 워커 시작 거부', 'Codex worker start rejected'], ['Codex 워커 턴 실패', 'Codex worker turn failed'], ['워커 중단', 'Worker interrupted'], ['워커 종료 미확인 · 예약 유지', 'Worker termination unconfirmed · reservation kept'],
    ['부모 권한 전달 불가', 'Parent permissions unavailable'], ['Worktree 생성 불가', 'Worktree unavailable'], ['배정 모델·effort 사용 불가', 'Allocated model or effort unavailable'], ['시작 전 취소', 'Cancelled before start']])('translates the Codex dispatch failure reason %s (#233, #287)', (ko, en) => {
    const p = page(); p.push(snapshot([run('failed', 'codex', [step('f', 'workers', 'host', { title: '호스트 호출 실패', state: 'error', summary: `${ko} · jev-gate:worker`, details: ['워커 미실행 · 완료 주장 없음'] })], { title: 'Codex 실행' })]));
    p.click('#language'); go(p, 'failed');
    const all = ['trace', 'step-detail'].map(id => text(p, id)).join(' ');
    expect(all).not.toMatch(/[가-힣]/); expect(all).toContain(`${en} · jev-gate:worker`); expect(all).toContain('Worker not started · no completion claimed');
  });
  it('renders metadata as text and supports attention filtering and the stage call-log filter', () => {
    const p = page(); const hostile = '<img src=x onerror="alert(1)">';
    p.push(snapshot([run('one', 'claude', [step('a', 'admission', 'jev', { summary: hostile, durationMs: 40 })]), run('other', 'codex', [step('r', 'router', 'jev', { state: 'unconfirmed', durationMs: 50 })], { state: 'attention' })]));
    expect(p.w.document.querySelector('#overview img')).toBeNull();
    p.click('[data-state="attention"]'); expect(text(p, 'runs')).not.toContain('claude execution'); expect(text(p, 'runs')).toContain('codex execution');
    p.click('[data-state="all"]'); expect(rows(p)).toHaveLength(2);
    // A stage filters the call log only; the run list keeps every execution.
    p.click('#stages [data-feature="admission"]'); expect(filled(p).map(b => b.getAttribute('data-call'))).toEqual(['a']); expect(rows(p)).toHaveLength(2);
    expect(text(p, 'log-filter')).toBe('Gate A만'); expect(stage(p, 'admission').getAttribute('aria-pressed')).toBe('true'); expect(p.get('log-clear').hidden).toBe(false);
    p.click('#stages [data-feature="admission"]'); expect(filled(p)).toHaveLength(2); expect(text(p, 'log-filter')).toBe('최신순');
    p.click('#stages [data-feature="router"]'); p.click('#log-clear'); expect(filled(p)).toHaveLength(2); expect(p.get('log-clear').hidden).toBe(true);
    go(p, 'one'); expect(opened(p)).toContain(hostile); expect(p.get('trace-view').querySelector('img')).toBeNull();
    expect(text(p, 'rd-name')).toBe('claude execution'); expect(text(p, 'crumb-run')).toBe('claude execution'); expect(p.get('crumb').hidden).toBe(false); expect(p.get('host-filters').hidden).toBe(true);
  });
  it('shows Router as model and effort without confidence, other decisions with their recorded confidence', () => {
    const rc = (choice: string, extra: object = {}) => ({ status: 200, code: null, model: 'jev-1.14.0', input: 1200, output: 40, costUsd: 0.0012, choice, confidence: .87, threshold: null, direction: null, ...extra });
    const p = page(); p.push(snapshot([run('r', 'claude', [step('a', 'admission', 'jev', { durationMs: 90, receipt: rc('direct') }), step('m', 'router', 'jev', { at: new Date(Date.parse(stamp) - 1000).toISOString(), durationMs: 120, receipt: rc('claude-sonnet-5 · high', { threshold: .6, direction: 'downgrade' }) })])]));
    expect(line(p, 'router')).toMatch(/^sonnet · high/); expect(line(p, 'router')).not.toMatch(/87%|확신/); expect(line(p, 'admission')).toMatch(/^직접 · 확신 87%/);
    // The log row carries input tokens; probability and threshold live once, in the decision basis panel.
    expect(text(p, 'rc')).toContain('1.2k'); expect(text(p, 'rc')).not.toContain('0.87'); expect(text(p, 'rc')).not.toContain('≈$');
    expect(text(p, 'basis-meta')).toContain('Gate A'); expect(text(p, 'basis-q')).toContain('0.87'); expect(p.get('basis-q').querySelector('b')).toBeNull();
    p.click('#rc button[data-call=m]'); expect(text(p, 'basis-meta')).toContain('Router'); expect(text(p, 'basis-q')).toContain('sonnet');
    expect(p.get('basis-q').querySelector('b')!.getAttribute('style')).toContain('left: 60%'); expect(p.get('basis-q').querySelector('.tr i')!.getAttribute('style')).toContain('scaleX(0.87)');
  });
  it('keeps eight five-column call-log rows newest first, pins a row through updates and unpins it on a second press', async () => {
    const calls = (n: number) => Array.from({ length: n }, (_, i) => step('c' + i, 'router', 'jev', { durationMs: 100 + i, at: new Date(Date.parse(stamp) + i * 10).toISOString() }));
    const p = page(); p.push(snapshot([run('r', 'claude', calls(3))]));
    expect(p.get('rc').querySelectorAll('li')).toHaveLength(8); expect(filled(p)).toHaveLength(3); expect(filled(p)[0]!.textContent).toContain('102ms');
    for (const b of filled(p)) expect(b.children).toHaveLength(5);
    expect(filled(p)[0]!.children[4]!.textContent).toBe('–'); expect(filled(p)[0]!.classList.contains('on')).toBe(true);
    p.click('#rc button[data-call=c1]'); expect(p.w.document.querySelector('#rc button[data-call=c1]')?.getAttribute('aria-pressed')).toBe('true');
    p.push(snapshot([run('r', 'claude', calls(5))]));
    await vi.waitFor(() => expect(filled(p)).toHaveLength(5), { timeout: 5000 }); expect(filled(p)[0]!.textContent).toContain('104ms');
    expect(p.w.document.querySelector('#rc button[data-call=c1]')?.getAttribute('aria-pressed')).toBe('true'); expect(p.w.document.querySelector('#rc button.on')?.getAttribute('data-call')).toBe('c1');
    p.click('#rc button[data-call=c1]'); expect(p.w.document.querySelectorAll('#rc [aria-pressed=true]')).toHaveLength(0); expect(p.w.document.querySelector('#rc button.on')?.getAttribute('data-call')).toBe('c4');
  });
  it('counts a request awaiting its response up in its own row', async () => {
    const at = new Date(Date.now() - 1500).toISOString();
    const p = page(); p.push(snapshot([run('r', 'claude', [step('w', 'admission', 'jev', { state: 'active', at }), step('d', 'router', 'jev', { at: new Date(Date.now() - 3000).toISOString(), durationMs: 80, receipt: { status: 200, code: null, model: 'jev-1.14.0', input: 10, output: 1, costUsd: null, choice: 'claude-sonnet-5 · high', confidence: .9, threshold: .6, direction: null } })])]));
    const wait = p.w.document.querySelector('#rc button[data-call=w]')!;
    expect(wait.textContent).toContain('응답 대기'); expect(wait.querySelector('.run[data-since]')).not.toBeNull();
    expect(text(p, 'basis-verdict')).toBe('응답 대기'); expect(text(p, 'j-p50') + text(p, 'j-p50-u')).toBe('80ms');
    const first = wait.querySelector('.run')!.textContent; await vi.waitFor(() => expect(wait.querySelector('.run')!.textContent).not.toBe(first), { timeout: 3000 });
  });
  it('estimates today cost from recorded tokens only and labels it as an estimate', () => {
    const p = page(), s = snapshot([run('r', 'claude', [step('c', 'router', 'jev', { durationMs: 100 })])]);
    p.push(s); expect(text(p, 'j-cost')).toBe('–'); expect(text(p, 'k-tok')).toBe('– tok');
    p.push({ ...s, operations: { ...s.operations, latency: { ...s.operations.latency, today: { claude: { calls: 3, input: 9000, costUsd: 0.0042, unpriced: 1 } } } } });
    const note = p.get('j-cost').title;
    expect(text(p, 'j-cost')).toBe('$0.00420'); expect(p.get('k-today').getAttribute('aria-label')).toBe('3회'); expect(text(p, 'k-tok')).toBe('9.0k tok');
    expect(note).toContain('정가 추정'); expect(note).toContain('API가 알려주지 않습니다'); expect(note).toContain('1회는 제외');
    // Both Jev versions stay priced so records written before an upgrade still cost out; one price, listed once.
    expect(note).toContain('jev-1.13.0 · jev-1.14.0, 100만 토큰당 $0.042'); expect(note.match(/\$0\.042/g)).toHaveLength(1);
  });
  it('saves independent shared preferences and surfaces a failed write without changing its switch', async () => {
    const p = page(); p.push(snapshot([])); const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: false }) }).mockResolvedValueOnce({ ok: false }); Object.assign(p.w, { fetch });
    p.click('#recording'); await vi.waitFor(() => expect(p.get('recording').getAttribute('aria-checked')).toBe('false')); expect(p.get('dashboard-auto').getAttribute('aria-checked')).toBe('true');
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/recording'); p.click('#dashboard-auto'); await vi.waitFor(() => expect(p.get('notice').textContent).toContain('저장하지 못했습니다')); expect(p.get('dashboard-auto').getAttribute('aria-checked')).toBe('true');
  });
});

it('shows a rejected Terra proposal with its probability and threshold in the stage detail in both languages', () => {
  const p = page(); p.push(snapshot([run('proposal-proof', 'codex', [step('response', 'router', 'host', {
    routing: { scope: 'root', baseline: 'gpt-6.1-sol', modelReason: 'low_confidence', effortReason: 'selected', proposedModel: 'gpt-5.6-terra', probability: .55, threshold: .6 },
    model: { selected: 'gpt-6.1-sol', observed: 'gpt-6.1-sol', status: 'confirmed', selectedEffort: 'medium', observedEffort: null },
  })])]));
  go(p, 'proposal-proof'); let t = opened(p);
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
  go(p, 'control-proof'); expect(opened(p)).toContain(korean); expect(opened(p)).not.toContain('사용자가 고정');
  p.click('#language'); expect(opened(p)).toContain(english); expect(opened(p)).not.toContain('User locked');
});

it('shows routing scope, baseline and keep reasons in the stage detail in both languages', () => {
  const p = page(); p.push(snapshot([run('route-proof', 'claude', [step('response', 'router', 'host', {
    routing: { scope: 'root', baseline: 'claude-opus-5-5', modelReason: 'same_value', effortReason: 'cache_preserved' },
    model: { selected: 'claude-opus-5-5', observed: 'claude-opus-5-5', status: 'confirmed', selectedEffort: 'xhigh', observedEffort: null, forwardedEffort: 'xhigh', effortSource: 'host_hook' },
  })])]));
  go(p, 'route-proof'); let t = opened(p);
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
  go(p, 'codex'); expect(opened(p)).toContain('API 전송 설정'); expect(opened(p)).toContain('일치'); expect(opened(p)).toContain('응답 모델 기록 없음');
});

it('shows verified request settings of a waiting request in the stage detail in both languages', () => {
  const p = page(); p.push(snapshot([run('request-live', 'codex', [step('waiting', 'router', 'host', { lifecycle: true, state: 'active', title: '모델 · 응답 대기', model: { selected: 'gpt-6-luna', observed: null, status: 'unobserved', selectedEffort: 'low', observedEffort: null, requestApplied: true } })])]));
  go(p, 'request-live'); expect(opened(p)).toContain('API 전송 설정'); expect(opened(p)).toContain('응답 대기');
  p.click('#language'); expect(opened(p)).toContain('API request settings'); expect(opened(p)).toContain('Awaiting response');
});

it('renders typed decision probabilities once while retaining other decision evidence', () => {
  const p = page(); p.push(snapshot([run('decision', 'claude', [step('assess', 'router', 'jev', { judgements: [{ question: 'control', value: 'task_clear', confidence: .8, probabilities: [{ label: 'task_clear', value: .8 }, { label: 'unclear', value: .2 }] }], details: ['control: task_clear · 확신 80% · task_clear 80% / unclear 20%', '기존 모델 claude-opus-5-5'] })])]));
  go(p, 'decision');
  const terms = [...p.get('step-detail').querySelectorAll('dd')].filter(d => d.textContent?.includes('20%'));
  expect(terms).toHaveLength(1); expect(opened(p)).not.toContain('control: task_clear'); expect(opened(p)).toContain('기존 모델 claude-opus-5-5');
});

it('shows a Jev response\'s questions once, in the decision basis panel, with six fixed slots, threshold ticks and its trace link', () => {
  const q = (n: number) => Array.from({ length: n }, (_, i) => ({ question: i ? 'q' + i : 'model', value: 'v' + i, confidence: .7, probabilities: [{ label: 'v' + i, value: .7 }, { label: 'x', value: .3 }] }));
  const rc = { status: 200, code: 'model_selected', model: 'jev-1.14.0', input: 300, output: 20, costUsd: null, choice: 'v0', confidence: .7, threshold: .65, direction: null };
  const p = page(); p.push(snapshot([run('decision', 'claude', [step('few', 'admission', 'jev', { durationMs: 40, receipt: rc, judgements: q(2) }), step('many', 'admission', 'jev', { durationMs: 50, at: new Date(Date.parse(stamp) - 1000).toISOString(), receipt: rc, judgements: q(14) })])]));
  const slots = () => [...p.get('basis-q').querySelectorAll('li')];
  expect(slots()).toHaveLength(6); expect(slots().filter(l => l.textContent)).toHaveLength(2);
  expect(p.get('basis-q').querySelectorAll('b')).toHaveLength(1); expect(slots()[0]!.textContent).toContain('모델'); expect(slots()[0]!.textContent).toContain('0.70');
  expect(p.get('basis-code').title).toBe(text(p, 'basis-code')); expect(text(p, 'basis-code')).not.toContain('model_selected');
  expect(p.get('basis-trace').getAttribute('href')).toBe('#run=decision');
  p.click('#rc button[data-call=many]'); expect(slots()).toHaveLength(6); expect(slots()[5]!.textContent).toBe('외 9개'); expect(slots()[4]!.textContent).toContain('q4');
  p.click('#language'); expect(slots()[5]!.textContent).toBe('+9 more');
});

it('reads a Gate decision as one stage with plain-word basis and next stage (#269)', () => {
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
  // The stage line names the decision and the policy's reason once.
  expect(line(p, 'admission')).toContain('직접 처리 · 확신 기준 충족');
  expect(filled(p).find(b => b.getAttribute('data-call') === 'a')?.textContent).toContain('직접 처리 · 확신 기준 충족');
  // The response and its policy are one stage, named by the policy.
  go(p, 'g');
  const stages = [...p.get('trace').querySelectorAll('button[data-step]')];
  expect(stages.map(b => b.getAttribute('data-step'))).toEqual(['a', 'w']); expect(stages[0]!.textContent).toContain('Gate A 판정');
  expect(text(p, 'rd-stats')).toContain('2h 1m');
});

it('folds consecutive identical settled records into one stage with their count and span (#269)', () => {
  const t = (s: number) => new Date(Date.parse(stamp) + s * 1000).toISOString();
  const check = (i: number, extra: Partial<OperationStep> = {}) => step('c' + i, 'router', 'local', { at: t(i), title: 'Router · 루트 응답 모델 확인', summary: '일치', ...extra });
  const p = page(); p.push(snapshot([run('r', 'claude', [check(0), check(1), check(2), check(3, { summary: '불일치', state: 'error' })])])); go(p, 'r');
  const stages = [...p.get('trace').querySelectorAll('button[data-step]')];
  expect(stages.map(b => b.getAttribute('data-step'))).toEqual(['c2', 'c3']); expect(stages[0]!.textContent).toContain('×3'); expect(stages[1]!.textContent).not.toContain('×');
  // A repeated row spans its first record to its last.
  expect(stages[0]!.querySelector('.du')!.textContent).toBe('2.0s');
  p.click('#trace button[data-step=c2]'); expect(opened(p)).toContain('반복 기록'); expect(opened(p)).toContain('3건');
  expect(text(p, 'sd-h')).toBe('Router · 루트 응답 모델 확인');
});

it('names the policy reason under each stage and says when a stage has no record', () => {
  const rc = { status: 200, code: null, model: 'jev-1.14.0', input: 300, output: 20, costUsd: null, choice: 'direct', confidence: .82, threshold: null, direction: null };
  const p = page(); p.push(snapshot([run('c', 'claude', [step('a', 'admission', 'jev', { durationMs: 40, receipt: rc }), step('pa', 'admission', 'policy', { summary: '직접 처리 · 확신 기준 충족' })])]));
  expect(line(p, 'admission')).toBe('직접 · 확신 82% · 직접 처리 · 확신 기준 충족');
  expect(line(p, 'router')).toBe('기록 없음');
});

it('names the scope on the Router stage when its last routing step is not the root turn (#290)', () => {
  const later = new Date(Date.parse(stamp) + 1000).toISOString(), routing = (scope: 'root' | 'child') => ({ scope, baseline: 'claude-opus-5-5', modelReason: 'same_value', effortReason: 'selected' });
  const p = page(); p.push(snapshot([run('scoped', 'claude', [step('root', 'router', 'host', { routing: routing('root') }), step('child', 'router', 'host', { at: later, routing: routing('child') })])]));
  expect(line(p, 'router')).toMatch(/ · 하위 단계 · \S/); p.click('#language'); expect(line(p, 'router')).toMatch(/ · Child step · \S/);
  p.push(snapshot([run('rooted', 'claude', [step('root', 'router', 'host', { routing: routing('root') })])])); expect(line(p, 'router')).not.toMatch(/Child step|Root turn/);
});

it('makes connection loss explicit and freezes the displayed clock at disconnect', async () => {
  const p = page(); p.push(snapshot([run('r', 'claude', [step('r', 'router', 'jev', { state: 'active' })], { state: 'active', firstAt: new Date(Date.now() - 5000).toISOString() })]));
  const since = () => p.get('runs').querySelector('[data-since]')!.textContent;
  p.disconnect(); const before = since();
  expect(text(p, 'connection')).toBe('재연결 중'); expect(p.get('connection').classList.contains('warn')).toBe(true); expect(p.w.document.body.classList.contains('still')).toBe(true);
  await new Promise(r => setTimeout(r, 1100)); expect(since()).toBe(before);
});
it('preserves setting-save failures through incoming snapshots', async () => {
  const p = page(); Object.assign(p.w, { fetch: async () => ({ ok: false }) });
  const value = snapshot([]); p.push(value); p.click('#recording');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(p.get('notice').textContent).toContain('설정을 저장하지 못했습니다');
  p.push(value); expect(p.get('notice').textContent).toContain('설정을 저장하지 못했습니다');
});

it('shows a ten-thousand-step execution in a bounded timeline and applies a patch that arrives before the next draw', async () => {
  const p = page(), steps = Array.from({ length: 10001 }, (_, i) => step('cycle' + i, 'router', 'host', { summary: 'cycle ' + i })); p.push(snapshot([run('large', 'codex', steps)]));
  go(p, 'large');
  await vi.waitFor(() => expect(p.get('trace').children).toHaveLength(100)); expect(p.get('trace').querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
  // A patch applies to the frame it follows and is drawn; the frame is not drawn over it later.
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
  expect(shown()).toHaveLength(20); expect(shown().every(Boolean)).toBe(true);
  expect(text(p, 'n-all')).toBe('45');
  await vi.waitFor(() => expect(shown()).toHaveLength(45)); expect(shown().every(Boolean)).toBe(true);
});

it('counts the last minute of calls and shows a burst immediately alongside the scoped median', () => {
  const old = step('old', 'router', 'jev', { at: new Date(Date.now() - 90_000).toISOString(), durationMs: 40 });
  const base = Date.now(), records = (n: number) => Array.from({ length: n }, (_, i) => step(`r${i}`, 'router', 'jev', { durationMs: 50 + i, at: new Date(base + i).toISOString() }));
  const p = page(); p.push(snapshot([run('r', 'claude', [old, ...records(3)])]));
  expect(filled(p)).toHaveLength(4); expect(text(p, 'k-rate')).toBe('+3/min'); expect(text(p, 'j-p50') + text(p, 'j-p50-u')).toBe('40ms');
  expect(text(p, 't-rate')).toBe('0.3 rps · 3건'); expect(p.get('dots').querySelectorAll('.dot')).toHaveLength(3);
  p.click('#language'); expect(text(p, 't-rate')).toBe('0.3 rps · 3 calls');
  const burst = page(); burst.push(snapshot([run('r', 'claude', records(1))])); burst.push(snapshot([run('r', 'claude', records(1))]));
  burst.push(snapshot([run('r', 'claude', records(40))]));
  // Even a burst larger than the motion budget shows its newest value immediately.
  expect(burst.get('rc').querySelector('button')!.textContent).toContain('89ms'); expect(burst.get('j-wire').querySelectorAll('.lane').length).toBeLessThanOrEqual(6);
});

it('keeps decision causes in the basis and distinct model evidence in the stage detail (#338)', () => {
  const p = page(), response = step('dedup', 'router', 'jev', { title: 'Router', summary: '선택 모델과 실제 모델 일치', durationMs: 82,
    receipt: { status: 200, code: null, model: 'jev-1.14.0', input: 1200, output: 0, costUsd: null, choice: 'gpt-6-luna · low', confidence: .9, threshold: .6, direction: null },
    routing: { scope: 'root', baseline: 'gpt-6.1-sol', modelReason: 'selected', effortReason: 'selected' },
    model: { selected: 'gpt-6-luna', observed: 'gpt-6-luna', status: 'confirmed', selectedEffort: 'low', observedEffort: null } });
  p.push(snapshot([run('dedup-run', 'codex', [response])]));
  expect(filled(p)[0]!.querySelector('.v b')!.textContent).toBe('luna · low'); expect(text(p, 'basis-code')).toContain('변경 선택');
  expect(text(p, 'rc')).not.toContain('변경 선택'); expect(text(p, 'basis-verdict')).toBe('luna · low');
  go(p, 'dedup-run'); expect(opened(p)).toContain('호스트 응답에 미제공');
});

it('refreshes a completed call when its decision changes in place and preserves its full failure cause (#338)', () => {
  const p = page(), s = step('mutable', 'router', 'jev', { durationMs: 80, receipt: { status: 200, code: null, model: 'jev-1.14.0', input: 100, output: 0, costUsd: null, choice: 'gpt-6.1-sol · high', confidence: .9, threshold: .6, direction: null } });
  p.push(snapshot([run('mutable-run', 'codex', [s])])); expect(filled(p)[0]!.textContent).toContain('sol · high');
  p.push(snapshot([run('mutable-run', 'codex', [{ ...s, receipt: { ...s.receipt!, input: 200, choice: 'gpt-6-luna · low' } }])]));
  expect(filled(p)[0]!.textContent).toContain('luna · low'); expect(filled(p)[0]!.textContent).toContain('0.2k');
  p.push(snapshot([run('mutable-run', 'codex', [{ ...s, state: 'error', cause: 'Upstream refused this exact request', receipt: { ...s.receipt!, status: 503, choice: null } }])]));
  expect(filled(p)[0]!.querySelector('.v b')!.textContent).toBe('요청 오류'); expect(text(p, 'basis-code')).toBe('Upstream refused this exact request');
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
  expect(line(p, 'allocation')).not.toBe('기록 없음'); expect(filled(p)[0]!.textContent).toContain('80ms');
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
  const kept = p.get('runs').querySelector('[data-run="other"] .sub'), changed = p.get('runs').querySelector('[data-run="one"] .sub');
  p.patch(next(snapshot([run('one', 'claude', [step('a', 'admission', 'jev', { durationMs: 60 }), step('b', 'allocation', 'jev', { durationMs: 80 })], { state: 'active' }), other])));
  expect(p.get('runs').querySelector('[data-run="other"] .sub')).toBe(kept);
  expect(p.get('runs').querySelector('[data-run="one"] .sub')).not.toBe(changed); expect(p.get('runs').querySelector('[data-run="one"] .sub')!.textContent).toMatch(/^진행 중/);
});

it('counts an active step live from its recorded start', async () => {
  const started = new Date(Date.now() - 5000).toISOString(), p = page();
  p.push(snapshot([run('r', 'claude', [step('m', 'router', 'host', { state: 'active', at: started, startedAt: started })], { state: 'active', firstAt: started })])); go(p, 'r');
  const du = () => p.get('trace').querySelector('[data-step="m"] .du')!.textContent!;
  // The row counts the stage live; its open detail does not repeat that count.
  expect(du()).toMatch(/^5\.\ds$/); expect(opened(p)).not.toContain('기록 사이 경과');
  await new Promise(r => setTimeout(r, 1100));
  expect(Number.parseFloat(du())).toBeGreaterThanOrEqual(6);
});

it('grows the bar of a running stage on the same tick as its duration', async () => {
  const now = Date.now(), started = new Date(now - 2000).toISOString(), p = page();
  p.push(snapshot([run('r', 'claude', [step('d', 'router', 'host', { at: new Date(now - 10_000).toISOString(), durationMs: 1000 }), step('m', 'router', 'host', { state: 'active', at: started, startedAt: started })], { state: 'active' })])); go(p, 'r');
  const width = (id: string) => Number.parseFloat((p.get('trace').querySelector(`[data-step="${id}"] .bar i`) as HTMLElement).style.width);
  const running = width('m'), settled = width('d');
  await vi.waitFor(() => expect(width('m')).toBeGreaterThan(running + 1), { timeout: 3000 });
  // The span grows with it, so the settled stage takes a smaller share.
  expect(width('d')).toBeLessThan(settled);
});

it('fetches the detail fields a frame leaves out for the opened stage only, and keeps them while that stage is unchanged', async () => {
  const next = frames(), p = page();
  const full = step('s2', 'router', 'host', { details: ['baseline gpt-6.1-sol · xhigh'], sessionId: 'cx-9', routing: { scope: 'root', baseline: 'gpt-6.1-sol', modelReason: 'same_value', effortReason: 'same_value' } });
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('s2') ? full : { ...step('s1', 'router', 'host', { summary: 'First result' }), details: ['first stage evidence'] } }));
  Object.assign(p.w, { fetch });
  const { details: _details, sessionId: _session, routing: _routing, ...slim } = full, { details: _first, ...first } = step('s1', 'router', 'host', { summary: 'First result' });
  const frame = (more: OperationRun[] = []) => snapshot([run('r/1', 'codex', [first, slim] as OperationStep[]), ...more]);
  p.push(next(frame())); expect(fetch).not.toHaveBeenCalled();
  go(p, 'r/1');
  expect(opened(p)).toContain('요약Recorded result'); expect(opened(p)).not.toContain('라우팅 대상');
  expect(fetch.mock.calls.map(c => c[0])).toEqual(['/api/step?run=r%2F1&step=s2']);
  await vi.waitFor(() => expect(opened(p)).toContain('라우팅 대상메인 턴')); expect(opened(p)).toContain('baseline gpt-6.1-sol · xhigh');
  p.patch(next(frame([run('other', 'claude', [step('g', 'workers', 'policy')])])));
  expect(opened(p)).toContain('baseline gpt-6.1-sol · xhigh'); expect(fetch).toHaveBeenCalledTimes(1);
  p.click('[data-step="s1"]'); await vi.waitFor(() => expect(opened(p)).toContain('first stage evidence'));
  p.click('[data-step="s2"]'); expect(opened(p)).toContain('baseline gpt-6.1-sol · xhigh'); expect(fetch).toHaveBeenCalledTimes(2);
});

it('lights the stage of a newly recorded host step without a Jev round trip', async () => {
  const base = run('x', 'codex', [step('t0', 'workers', 'host', { title: 'Codex · 도구 시작', at: new Date(Date.now() - 2000).toISOString() })]);
  const p = page(); p.push(snapshot([base])); p.push(snapshot([base]));
  expect(stage(p, 'workers').classList.contains('hit')).toBe(false);
  p.push(snapshot([run('x', 'codex', [...base.steps, step('t1', 'workers', 'host', { title: 'Codex · 도구 결과', at: new Date().toISOString() })])]));
  await vi.waitFor(() => expect(stage(p, 'workers').classList.contains('hit')).toBe(true), { timeout: 3000, interval: 5 });
  expect(p.w.document.querySelectorAll('.lane,.stem')).toHaveLength(0); expect(filled(p)).toHaveLength(0);
});

it('counts only current failures at the top, keeps settled ones as past errors and redraws a reclassification from a patch (#223)', () => {
  const day = new Date(Date.now() - 86_400_000).toISOString(), next = frames();
  const outage = (now: 'unknown' | 'later_ok') => run('outage', 'codex', [step('cfg', 'admission', 'jev', { at: day, state: 'error', issue: 'jev', cause: 'network', sessionId: 'cx-session-1', title: 'Gate A · Jev 응답', impact: { now, lastAt: now === 'unknown' ? day : stamp, lastState: now === 'unknown' ? 'error' : 'done' } })], { state: now === 'unknown' ? 'attention' : 'past_error', firstAt: day, lastAt: day });
  const refused = run('refused', 'codex', [step('bad', 'workers', 'host', { at: day, state: 'error', issue: 'host', sessionId: 'cx-session-2', title: 'Codex · 도구 결과', impact: { now: 'later_ok', lastAt: stamp, lastState: 'done' } })], { state: 'past_error', firstAt: day, lastAt: day });
  // #269: two mismatches in one run are one execution to check, so the diagnosis counts it once.
  const wrong = (id: string) => step(id, 'router', 'host', { state: 'error', model: { selected: 'claude-opus-5-5', observed: 'claude-sonnet-5', status: 'mismatch', selectedEffort: null, observedEffort: null }, impact: { now: 'unknown', lastAt: stamp, lastState: 'error' } });
  const mismatch = run('mismatch', 'claude', [wrong('m'), wrong('m2')], { state: 'attention', source: 'router' });
  // A count lives once, at the top, and each row shows its own state.
  const p = page(), shown = (cls: string) => p.get('runs').querySelectorAll('a.row.' + cls).length;
  p.push(next(snapshot([mismatch, outage('unknown'), refused])));
  expect(text(p, 'k-att')).toBe('2'); expect(text(p, 'k-diag')).toBe('실제 응답 모델 불일치 1건 · Jev 판정 오류 1건');
  expect([shown('er'), shown('past')]).toEqual([2, 1]); expect(text(p, 'n-attention')).toBe('2');
  go(p, 'outage');
  for (const fact of ['원인연결 오류', '현재 영향현재 영향 미확인', '호스트Codex', '세션cx-session-1']) expect(opened(p)).toContain(fact);
  go(p, 'refused');
  expect(opened(p)).toContain('현재 영향이후 같은 작업 정상 기록'); expect(opened(p)).toContain('마지막 관측');
  // A later success arrives as a patch: the same row is redrawn as a past error and leaves the current count.
  go(p, null); p.patch(next(snapshot([mismatch, outage('later_ok'), refused])));
  expect(text(p, 'k-att')).toBe('1'); expect(text(p, 'k-diag')).toBe('실제 응답 모델 불일치 1건');
  expect([shown('er'), shown('past')]).toEqual([1, 2]);
  expect(p.get('runs').querySelector('[data-run="outage"] .sub')!.textContent).toMatch(/^지난 오류/);
  go(p, 'outage'); expect(opened(p)).toContain('현재 영향이후 같은 작업 정상 기록'); expect(opened(p)).not.toContain('상태오류'); expect(p.get('trace').querySelector('[aria-pressed="true"] .bar em')!.textContent).toBe('오류');
  go(p, null); p.click('[data-host="codex"]');
  expect(text(p, 'k-att')).toBe('0'); expect(text(p, 'k-diag')).toBe('지난 오류 2건');
  p.click('[data-state="attention"]'); expect(rows(p)).toHaveLength(0);
  p.click('[data-host="claude"]'); expect(text(p, 'k-att')).toBe('1'); expect(rows(p)).toHaveLength(1);
  p.click('#language'); p.click('[data-host="all"]'); go(p, 'mismatch');
  expect(opened(p)).toContain('Current impactCurrent impact unknown'); go(p, null); expect(text(p, 'k-diag')).toBe('Response model mismatch 1 recorded');
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
  const id = p.get('runs').querySelector('a[data-run]')!.getAttribute('data-run')!, state = () => p.get('runs').querySelector(`[data-run="${id}"] .sub`)!.textContent;
  expect(rows(p)).toHaveLength(1); expect(text(p, 'k-att')).toBe('1'); expect(text(p, 'k-diag')).toBe('워커 계약 미충족 1건'); expect(state()).toMatch(/^확인 필요/);
  expect(line(p, 'workers')).toMatch(/^계약 미충족/);
  go(p, id);
  expect(marks(p)).toContain('계약 미충족'); expect(marks(p)).not.toContain('계약 수락');
  // The later host end stays visible as its own row, never as acceptance.
  expect(marks(p)).toContain('호스트 종료');
  for (const fact of ['단일 워커 · 계약 미충족 · 작업 완료 조건 미충족 · 통과 보고 검사의 실행 미관측', '미관측 #1', '원인보고 검사의 실행 미관측', '현재 영향현재 영향 미확인']) expect(opened(p)).toContain(fact);
  expect(text(p, 'trace')).not.toContain('transcript shows');
  p.click('#language');
  expect(marks(p)).toContain('Contract not met');
  expect(opened(p)).toContain('Reported pass not seen in the worker transcript');
  // A later accept of the same task arrives as a patch: the refusal stays recorded and only leaves the current count.
  p.patch(next(view([...records, post(9, 'accept', null, [])])));
  expect(marks(p)).toEqual(expect.arrayContaining(['Contract not met', 'Contract accepted']));
  go(p, null); expect(text(p, 'k-att')).toBe('0'); expect(text(p, 'k-diag')).toBe('1 past errors');
  p.click('#language'); expect(state()).toMatch(/^지난 오류/);
});
