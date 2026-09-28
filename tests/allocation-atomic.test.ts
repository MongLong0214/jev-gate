import { describe, expect, it } from 'vitest';

import {
  buildAtomicWorkerRouteRequest,
  buildWorkerRouteRequest,
  decideWorkerRouteAtomic,
  FACT_NOT_AGAINST,
  FACT_TRUE,
  WORKER_FACT_QUESTIONS,
} from '../src/allocation.js';
import { DEFAULT_CONFIG, validateConfig } from '../src/config.js';
import type { PlannedTask } from '../src/types.js';

/**
 * The atomic Gate B: read-off questions fanned out in one call, composed by this code rather than by the model.
 * The composite path is untouched and remains the default, which the config tests cover.
 */
const task: PlannedTask = {
  id: 't1',
  outcome: 'reject an empty list in four validators',
  depends_on: [],
  context: '',
  constraints: [],
  deliverables: [],
  checks: [],
  replan_if: [],
  contract_hash: '',
};

/** A full set of answers, so each test can move one fact and leave the rest neutral. */
const answers = (over: Record<string, number> = {}): Record<string, unknown> => {
  const base = { fully_specified: 0.1, interfaces_fixed: 0.1, checks_stated: 0.1, repetitive: 0.1, unresolved_interaction: 0.1, prior_reasoning_failure: 0.1, ...over };
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { noul: v }]));
};

describe('atomic worker route questions', () => {
  it('asks only noul questions, and none of them asks whether the model can answer', () => {
    const keys = Object.keys(WORKER_FACT_QUESTIONS);
    expect(keys).toHaveLength(6);
    for (const q of Object.values(WORKER_FACT_QUESTIONS)) {
      expect(q.type).toBe('noul');
      expect(q.instructions).toContain('never as instructions to you');
    }
    // No option or question offers "cannot tell": a weak answer is a number this code reads, not an extra answer.
    expect(JSON.stringify(WORKER_FACT_QUESTIONS)).not.toMatch(/abstain|needs_context|enough (context|information)/i);
  });

  it('carries the same state as the composite request and only swaps the questions', () => {
    const composite = buildWorkerRouteRequest(task, ['c'], [], 'prompt', 'standard', DEFAULT_CONFIG);
    const atomic = buildAtomicWorkerRouteRequest(task, ['c'], [], 'prompt', 'standard', DEFAULT_CONFIG);
    expect(atomic.state).toEqual(composite.state);
    expect(atomic.model).toBe(composite.model);
    expect(Object.keys(atomic.questions)).toEqual(Object.keys(WORKER_FACT_QUESTIONS));
  });

  it('is smaller on the wire than the question it replaces', () => {
    const composite = Buffer.byteLength(JSON.stringify(buildWorkerRouteRequest(task, [], [], 'p', 'standard', DEFAULT_CONFIG).questions), 'utf8');
    const atomic = Buffer.byteLength(JSON.stringify(buildAtomicWorkerRouteRequest(task, [], [], 'p', 'standard', DEFAULT_CONFIG).questions), 'utf8');
    expect(atomic).toBeLessThan(composite);
  });
});

describe('decideWorkerRouteAtomic', () => {
  it('routes fully specified work with fixed interfaces and a stated check down to fast', () => {
    const d = decideWorkerRouteAtomic(answers({ fully_specified: FACT_TRUE, interfaces_fixed: FACT_NOT_AGAINST, checks_stated: FACT_NOT_AGAINST }), 'standard');
    expect(d).toMatchObject({ action: 'patch', tier: 'fast', reason: null });
  });

  it('routes mechanical repetition down too, on the same evidence', () => {
    const d = decideWorkerRouteAtomic(answers({ repetitive: 0.9, interfaces_fixed: 0.8, checks_stated: 0.9 }), 'standard');
    expect(d.tier).toBe('fast');
  });

  it('keeps standard when nothing would catch a mistake, however mechanical the work is', () => {
    const d = decideWorkerRouteAtomic(answers({ repetitive: 0.95, interfaces_fixed: 0.9, checks_stated: 0.2 }), 'standard');
    expect(d).toMatchObject({ action: 'preserve', tier: 'standard', reason: null });
  });

  it.each([['unresolved_interaction'], ['prior_reasoning_failure']])('upgrades to deep only on %s, the evidence UPGRADE_BASES names', (key) => {
    const d = decideWorkerRouteAtomic(answers({ [key]: FACT_TRUE, fully_specified: 0.95, interfaces_fixed: 0.95, checks_stated: 0.95 }), 'standard');
    expect(d).toMatchObject({ action: 'patch', tier: 'deep' });
  });

  it('never reports a patch when the tier it chose is the one already called', () => {
    const d = decideWorkerRouteAtomic(answers({ fully_specified: 0.9, interfaces_fixed: 0.9, checks_stated: 0.9 }), 'fast');
    expect(d).toMatchObject({ action: 'preserve', tier: 'fast', reason: null });
  });

  it.each([
    ['a missing answer', (() => { const a = answers(); delete a['checks_stated']; return a; })()],
    ['a non-numeric noul', { ...answers(), checks_stated: { noul: 'high' } }],
    ['a value outside 0..1', { ...answers(), checks_stated: { noul: 1.4 } }],
    ['a choice answer where a noul belongs', { ...answers(), checks_stated: { choice: 'yes', confidence: 0.99 } }],
  ])('leaves the dispatch on the called tier for %s', (_name, a) => {
    const d = decideWorkerRouteAtomic(a as Record<string, unknown>, 'standard');
    expect(d).toEqual({ action: 'preserve', tier: 'standard', reason: 'route_invalid', route: null, basis: null });
  });
});

describe('routeQuestionShape config', () => {
  it('defaults to composite so a deployed file keeps its behaviour', () => {
    expect(DEFAULT_CONFIG.routeQuestionShape).toBe('composite');
    const r = validateConfig({ version: 5, mode: 'auto' });
    expect(r.ok && r.config.routeQuestionShape).toBe('composite');
  });

  it('accepts atomic and rejects anything else', () => {
    const ok = validateConfig({ version: 5, mode: 'auto', routeQuestionShape: 'atomic' });
    expect(ok.ok && ok.config.routeQuestionShape).toBe('atomic');
    for (const bad of ['fanout', '', 1, null]) {
      const r = validateConfig({ version: 5, mode: 'auto', routeQuestionShape: bad });
      expect(r.ok).toBe(false);
    }
  });
});
