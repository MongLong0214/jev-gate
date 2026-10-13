import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadActivity, type ActivitySnapshot } from '../src/activity.js';
import { diffFrame, type FrameMemo } from '../src/dashboard-patch.js';
import type { OperationRun, OperationStep } from '../src/operations.js';
import { applyPatch } from './live-frames.js';

const step = (id: string, extra: Partial<OperationStep> = {}): OperationStep => ({ id, at: '2026-10-13T01:00:00.000Z', feature: 'router', state: 'done', lane: 'jev', title: 't', summary: 's', details: [], ...extra });
const run = (id: string, steps: OperationStep[], extra: Partial<OperationRun> = {}): OperationRun => ({ id, title: id, source: 'router', mode: 'm', firstAt: steps[0]?.at ?? '', lastAt: steps.at(-1)?.at ?? '', state: 'done', steps, ...extra });
const snapshot = (runs: OperationRun[], extra: Record<string, unknown> = {}): ActivitySnapshot => ({
  host: 'claude', at: new Date().toISOString(), traceDir: null, traceFiles: 1, unreadable: 0, liveness: null, jevCalls: 0, credit: { exhausted: false, at: null }, direct: 0, orchestrated: 0, routerChanges: 0, events: [], notes: [],
  live: { mode: 'waiting', sig: 'x' } as unknown as ActivitySnapshot['live'],
  operations: { runs, features: [], feed: runs.flatMap(r => r.steps.map(s => ({ ...s, runId: r.id, runTitle: r.title, host: 'claude' as const }))), active: 0, attention: 0, requests: 0,
    latency: { measured: 0, p50: null, p95: null, fastest: null, latest: null, recent: [], today: {} } },
  ...extra,
}) as ActivitySnapshot;

/** Feeds snapshots through the server diff and the page's patch function; returns what the page holds after each one. */
const stream = () => {
  let memo: FrameMemo | null = null, held: Record<string, unknown> | null = null, n = 0;
  return (next: ActivitySnapshot): { patch: string | null; held: Record<string, unknown> } => {
    const base = memo?.key, diff = diffFrame(memo, next, () => `k${++n}`);
    memo = diff.memo;
    if (!held) held = { ...JSON.parse(JSON.stringify(next)) as Record<string, unknown>, frame: memo.key };
    else if (diff.patch) {
      const applied = applyPatch(held, { base, frame: memo.key, p: JSON.parse(diff.patch) as unknown });
      if (!applied) throw new Error('patch rejected');
      held = applied;
    }
    return { patch: diff.patch, held };
  };
};
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const same = (held: Record<string, unknown>, next: ActivitySnapshot): void => {
  const { frame: _frame, at: _at, ...rest } = held, { at: _nextAt, ...expected } = next;
  expect(plain(rest)).toEqual(plain(expected));
};

describe('dashboard frame patches', () => {
  it('sends nothing when only the build time moved, and only the changed steps of a changed run', () => {
    const feed = stream();
    const a = run('a', [step('a1'), step('a2')]), b = run('b', [step('b1')]);
    feed(snapshot([a, b]));
    expect(feed(snapshot([a, b], { at: '2030-01-01T00:00:00.000Z' })).patch).toBeNull();
    const grown = run('a', [step('a1'), step('a2'), step('a3', { state: 'active', startedAt: '2026-10-13T01:00:00.000Z' })]);
    const before = feed(snapshot([a, b])).held;
    const { patch, held } = feed(snapshot([grown, b]));
    const sent = JSON.parse(patch!) as { runs: Record<string, { put: Record<string, unknown>; steps: string[] }> };
    expect(Object.keys(sent.runs)).toEqual(['a']);
    expect(Object.keys(sent.runs['a']!.put)).toEqual(['a3']);
    expect(sent.runs['a']!.steps).toEqual(['a1', 'a2', 'a3']);
    same(held, snapshot([grown, b]));
    // The page keeps the objects that did not change, so it can skip redrawing them.
    const runsOf = (s: Record<string, unknown>) => (s['operations'] as { runs: Array<{ id: string; steps: unknown[] }> }).runs;
    expect(runsOf(held)[1]).toBe(runsOf(before)[1]);
    expect(runsOf(held)[0]!.steps[0]).toBe(runsOf(before)[0]!.steps[0]);
  });

  it('follows new, removed and reordered runs, removed fields, duplicate step ids and the feed', () => {
    const feed = stream();
    const a = run('a', [step('a1')]), b = run('b', [step('b1')]), c = run('c', [step('c1')]);
    feed({ ...snapshot([a, b]), retired: { items: [], sig: 'w' } } as unknown as ActivitySnapshot);
    const changes: ActivitySnapshot[] = [
      snapshot([c, b, a]),
      snapshot([b, c]),
      snapshot([b, run('c', [step('c1'), step('c1', { state: 'error' })])]),
      snapshot([b, run('c', [step('c2')])], { notes: ['n'] }),
    ];
    for (const next of changes) same(feed(next).held, next);
  });

  it('refuses a patch that does not follow the frame the page holds', () => {
    expect(applyPatch({ frame: 'k1', operations: { runs: [], feed: [] } }, { base: 'k0', frame: 'k2', p: {} })).toBeNull();
    expect(applyPatch(null, { base: 'k1', frame: 'k2' })).toBeNull();
    expect(applyPatch({ frame: 'k1', operations: { runs: [], feed: [] } }, { base: 'k1', frame: 'k2', p: { order: ['missing'] } })).toBeNull();
  });

  describe('on recorded history', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
    it('rebuilds to the same snapshot a whole frame would carry', () => {
      const trace = mkdtempSync(join(tmpdir(), 'jev-patch-')); dirs.push(trace);
      const write = (name: string, value: object) => writeFileSync(join(trace, name), JSON.stringify(value));
      const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
      const feed = stream(), env = { HOME: trace, JEV_GATE_STATE_DIR: trace };
      const load = () => loadActivity({ traceDir: trace, env });
      write('a1.json', { phase: 'admission_intent', session_id: 's', prompt_id: 'p1', request_id: 'r1', written_at: at(1) });
      feed(load());
      write('a2.json', { phase: 'admission_result', session_id: 's', prompt_id: 'p1', request_id: 'r1', attempted: true, written_at: at(2), http: { status: 200, duration_ms: 210 }, decision: { shape: 'direct' } });
      write('m1.json', { phase: 'mod_router', event: 'request', session_id: 's', turn: 't1', host: 'claude', version: 5, invocation_id: 'i1', written_at: at(3) });
      let next = load(); same(feed(next).held, next);
      write('m2.json', { phase: 'mod_router', event: 'root_result', session_id: 's', turn: 't1', host: 'claude', version: 5, invocation_id: 'i2', written_at: at(4), sent: true, jev_ms: 180, assessment: 'ok' });
      write('p2.json', { phase: 'admission_intent', session_id: 's2', prompt_id: 'p2', request_id: 'r2', written_at: at(5) });
      next = load(); same(feed(next).held, next);
      rmSync(join(trace, 'p2.json'));
      next = load(); same(feed(next).held, next);
    });
    it('carries a failure that a later success settles as a changed run state and step impact (#223)', () => {
      const trace = mkdtempSync(join(tmpdir(), 'jev-patch-')); dirs.push(trace);
      const write = (name: string, value: object) => writeFileSync(join(trace, name), JSON.stringify(value));
      const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
      const feed = stream(), env = { HOME: trace, JEV_GATE_STATE_DIR: trace }, load = () => loadActivity({ traceDir: trace, env });
      const result = (request_id: string, written_at: string, extra: object) => ({ host: 'codex', session_id: `s-${request_id}`, phase: 'evidence_result', request_id, written_at, backend: 'local', items: 0, remote_calls: 0, cache_hits: 0, duration_ms: 0, ...extra });
      write('e1.json', result('e1', at(1), { status: 'unavailable', is_error: true, reason_codes: ['unavailable_config'] }));
      let next = load(); const failed = next.operations.runs[0]!;
      expect(failed).toMatchObject({ state: 'attention', steps: [{ impact: { now: 'unknown' } }] }); expect(next.operations.attention).toBe(1);
      feed(next);
      write('e2.json', result('e2', at(2), { status: 'ok', is_error: false, items: 2, reason_codes: [] }));
      next = load();
      const { patch, held } = feed(next), sent = JSON.parse(patch!) as { ops: Record<string, unknown>; runs: Record<string, { meta: OperationRun; put: Record<string, OperationStep> }> };
      expect(sent.ops['attention']).toBe(0);
      expect(sent.runs[failed.id]!.meta.state).toBe('past_error');
      expect(Object.values(sent.runs[failed.id]!.put)).toMatchObject([{ state: 'error', impact: { now: 'later_ok', lastState: 'done' } }]);
      same(held, next);
      const runs = (held['operations'] as { runs: OperationRun[] }).runs;
      expect(runs.find(r => r.id === failed.id)).toMatchObject({ state: 'past_error', steps: [{ state: 'error', impact: { now: 'later_ok' } }] });
    });
  });
});
