import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { acceptDecision, acceptPick, BASELINE, ordered, summarize, testHash, wilsonUpper, type ItemRecord, type Route } from '../src/bench/router.js';
import { claudeCandidates } from '../src/claude-candidates.js';
import { offerRoute } from '../src/router-selection.js';

const offer = offerRoute({ baseline: { ...BASELINE }, candidates: claudeCandidates({ baseline: BASELINE.model, aliases: {}, allowFable: false }), model: true, effort: true, upgrade: 0.8, downgrade: 0.6, scope: 'root' })!;
const capability = (p: Record<string, number>) => {
  const probabilities = { mechanical: 0, routine: 0, complex: 0, unclear: 0, ...p };
  return { type: 'choice', choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0], confidence: 0.9, probabilities };
};
const sure = { control: { type: 'choice', choice: 'task_clear', confidence: 1, probabilities: { task_clear: 1, model_lock: 0, effort_lock: 0, explicit_lock: 0, needs_context: 0, unclear: 0 } },
  action_risk: { type: 'choice', choice: 'ordinary', confidence: 1, probabilities: { ordinary: 1, consequential: 0, unclear: 0 } },
  effort_0: { type: 'score', probabilities: { 0: 1, 1: 0, 2: 0 } }, effort_1: { type: 'score', probabilities: { 0: 0, 1: 1, 2: 0 } } };
const route = (rank: number, effort = 'xhigh'): Route => ({ model: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'][rank]!, rank, effort, reasons: { model: 'selected', effort: 'selected' } });
const rec = (id: string, label: string, rank: number, pair_of?: string): ItemRecord => ({ id, split: 'test', label, effort_range: ['high', 'max'], ...(pair_of ? { pair_of } : {}),
  arms: { cheapest_first: { ok: true, duration_ms: 100, top: label, ordered: route(rank), accept: route(rank) }, capable_first: { ok: true, duration_ms: 200, top: label, ordered: route(rank), accept: route(rank) }, pair: { ok: true, duration_ms: 300, ordered: route(rank) } } });

describe('bench router', () => {
  it('takes the argmax role at its accept bar, else the more capable of the top two, ties to the more capable', () => {
    expect(acceptPick(offer, { capability: capability({ mechanical: 0.86, routine: 0.14 }) })).toBe('mechanical');
    expect(acceptPick(offer, { capability: capability({ mechanical: 0.8, routine: 0.15, complex: 0.05 }) })).toBe('routine');
    expect(acceptPick(offer, { capability: capability({ routine: 0.55, complex: 0.3, mechanical: 0.15 }) })).toBe('complex');
    expect(acceptPick(offer, { capability: capability({ routine: 0.55, mechanical: 0.45 }) })).toBe('routine');
    expect(acceptPick(offer, { capability: { ...capability({ routine: 0.4, complex: 0.4, mechanical: 0.2 }), choice: 'routine' } })).toBeNull();
    expect(acceptPick(offer, { capability: capability({ unclear: 0.7, mechanical: 0.3 }) })).toBeNull();
  });
  it('routes the accept-bar pick through the production guards', () => {
    expect(acceptDecision(offer, { ...sure, capability: capability({ mechanical: 0.8, routine: 0.15, complex: 0.05 }) }).patch.model).toBe('claude-sonnet-5-5');
    expect(acceptDecision(offer, { ...sure, action_risk: { ...sure.action_risk, choice: 'consequential', probabilities: { ordinary: 0, consequential: 1, unclear: 0 } }, capability: capability({ mechanical: 0.9, routine: 0.1 }) }).reasons.model).toBe('risk_blocks_downgrade');
  });
  it('reorders the options without changing their criteria, unclear last', () => {
    const q = (o: typeof offer) => o.questions['capability']!.type === 'choice' ? Object.keys((o.questions['capability'] as { criteria: object }).criteria) : [];
    expect(q(ordered(offer, true))).toEqual(['complex', 'routine', 'mechanical', 'unclear']);
    expect(q(ordered(offer, false))).toEqual(['mechanical', 'routine', 'complex', 'unclear']);
  });
  it('scores under-routing with its Wilson bound and flags a probe routed below its pair', () => {
    expect(wilsonUpper(0, 60)).toBeCloseTo(0.0602, 3);
    const s = summarize([rec('a', 'complex', 1), rec('b', 'mechanical', 0), rec('c', 'routine', 2), rec('p', 'complex', 0, 'a')]) as Record<string, { ordered: Record<string, unknown>; latency_ms: { p50: number } }>;
    expect(s['cheapest_first']!.ordered).toMatchObject({ n: 3, exact_pct: 33.3, under_pct: 33.3, over_pct: 33.3, injection: { downgraded_vs_pair: ['p'], below_label: ['p'] } });
    expect(s['pair']!.latency_ms.p50).toBe(300);
  });
  it('keeps the frozen test split unchanged', () => {
    const golden = JSON.parse(readFileSync('bench/router/golden.json', 'utf8')) as { frozen_test_sha256: string; items: Parameters<typeof testHash>[0] };
    expect(testHash(golden.items)).toBe(golden.frozen_test_sha256);
    expect(golden.items.filter(i => i.split === 'test' && !i.pair_of).length).toBeGreaterThanOrEqual(60);
  });
});
