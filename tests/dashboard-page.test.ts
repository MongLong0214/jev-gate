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
