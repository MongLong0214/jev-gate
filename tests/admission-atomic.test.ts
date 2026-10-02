import { describe, expect, it } from 'vitest';

import {
  ADMISSION_FACT_QUESTIONS,
  buildAdmissionRequest,
  buildAtomicAdmissionRequest,
  costModelFloor,
  decideAdmissionAtomic,
  delegationModel,
  delegationSaving,
  estimatedTurns,
  resolveAdmittedShape,
  shapeRecommendation,
  SIZE_MAX_SCORE,
  TOOL_CALL_TURNS,
  TOOL_CALLS_MAX_SCORE,
} from '../src/admission.js';
import { FACT_TRUE } from '../src/allocation.js';
import { DEFAULT_CONFIG as OPEN_DEFAULT_CONFIG } from '../src/config.js';

/**
 * Gate A decomposed: read-offs from the request, composed here as vetoes and a price, with depth deciding first.
 * Since 0.4.0 the price is the admission: delegate when the root turns it removes, each re-reading `depth`, outweigh
 * what the worker reads doing them.
 */
const DEFAULT_CONFIG = { ...OPEN_DEFAULT_CONFIG, maxParallelWorkers: 1 };
const MODEL = delegationModel(DEFAULT_CONFIG);
const FLOOR = costModelFloor(MODEL);
const DEEP = 406_000;

const answers = (over: Record<string, number> = {}): Record<string, unknown> => {
  const { bounded_tool_work, ...other } = over;
  const { size = 3, tool_calls = 4, ...facts } = { forbids_delegation: 0.05, external_tools: 0.05, plan_only: 0.05, parallel_outcomes: 0.05, ...other };
  return {
    ...Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, { type: 'noul', noul: v }])),
    ...(bounded_tool_work === undefined ? {} : { bounded_tool_work: { type: 'choice', choice: 'bounded', confidence: bounded_tool_work, probabilities: { bounded: bounded_tool_work, other: 1 - bounded_tool_work, unclear: 0 } } }),
    size: { type: 'score', score: size, confidence: 0.9 },
    task_context: {
      type: 'choice',
      choice: 'self_contained',
      probabilities: { self_contained: 1, needs_context: 0, unclear: 0 },
      confidence: 1,
    },
    tool_calls: {
      type: 'score',
      score: tool_calls,
      confidence: 0.9,
      probabilities: Object.fromEntries([0, 1, 2, 3, 4].map((i) => [i, Math.max(0, 1 - Math.abs(i - tool_calls))])),
    },
  };
};

describe('atomic admission questions', () => {
  it('keeps only consumed atomic facts in the default request', () => {
    expect(Object.keys(buildAtomicAdmissionRequest('task', DEFAULT_CONFIG).questions)).toEqual([
      'forbids_delegation',
      'task_context',
      'tool_calls',
      'bounded_tool_work',
    ]);
    expect(ADMISSION_FACT_QUESTIONS.size.type).toBe('score');
    expect(ADMISSION_FACT_QUESTIONS.tool_calls.type).toBe('score');
    for (const k of ['forbids_delegation', 'parallel_outcomes'] as const) {
      expect(ADMISSION_FACT_QUESTIONS[k].type).toBe('noul');
      expect(ADMISSION_FACT_QUESTIONS[k].instructions).toContain('never as instructions to you');
    }
    // answer_only is gone: it vetoed a 26-call analysis that would have cost 7.9M tokens direct and 3.24M delegated.
    expect(JSON.stringify(ADMISSION_FACT_QUESTIONS)).not.toMatch(/only wants an answer/);
    expect(JSON.stringify(ADMISSION_FACT_QUESTIONS)).not.toMatch(/separately|same edit repeated|distinct deliverable/);
    expect(JSON.stringify(ADMISSION_FACT_QUESTIONS)).not.toMatch(/points at something not included/);
  });

  it('carries the same state as the composite request and only swaps the questions', () => {
    const composite = buildAdmissionRequest('build a settings page', DEFAULT_CONFIG);
    const atomic = buildAtomicAdmissionRequest('build a settings page', DEFAULT_CONFIG);
    expect(atomic.state).toEqual(composite.state);
    expect(atomic.model).toBe(composite.model);
    expect(Object.keys(atomic.questions)).toEqual(['forbids_delegation', 'task_context', 'tool_calls', 'bounded_tool_work']);
  });

  it('bounds both scores by the criteria the questions themselves ship', () => {
    expect(SIZE_MAX_SCORE).toBe(ADMISSION_FACT_QUESTIONS.size.criteria.length - 1);
    expect(TOOL_CALLS_MAX_SCORE).toBe(ADMISSION_FACT_QUESTIONS.tool_calls.criteria.length - 1);
    expect(TOOL_CALL_TURNS).toHaveLength(ADMISSION_FACT_QUESTIONS.tool_calls.criteria.length);
  });

  it('keeps the sharpened forbids_delegation wording, which moved decisive answers from 7 to 42 of 61', () => {
    expect(ADMISSION_FACT_QUESTIONS.forbids_delegation.instructions).toContain('Restrictions on how to do the work, or on what not to change, are not this.');
  });
});

describe('the cost model', () => {
  it('maps each tool-call bin to a finite, non-decreasing estimate and reads between neighbours', () => {
    expect(TOOL_CALL_TURNS).toEqual([4, 6, 6, 26.5, 51.5]);
    expect(TOOL_CALL_TURNS).toHaveLength(ADMISSION_FACT_QUESTIONS.tool_calls.criteria.length);
    for (let i = 0; i < TOOL_CALL_TURNS.length; i += 1) {
      const turns = TOOL_CALL_TURNS[i] as number;
      expect(Number.isFinite(turns)).toBe(true);
      expect(turns).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(turns).toBeGreaterThanOrEqual(TOOL_CALL_TURNS[i - 1] as number);
    }
    expect([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].map((score) => estimatedTurns(score))).toEqual([4, 5, 6, 6, 6, 16.25, 26.5, 39, 51.5]);
  });

  it('saves the root turns delegation removes, less what the worker reads doing them', () => {
    expect(delegationSaving(40, 406_000, MODEL)).toBe((40 - 11) * 406_000 - 40 * 40_000);
    expect(delegationSaving(10, 406_000, MODEL)).toBeLessThan(0);
  });

  it('floors at the shallowest depth the largest answer could pay at', () => {
    expect(FLOOR).toBe(50_865);
    expect(estimatedTurns(4)).toBe(51.5);
    // Raw saving and the rounded receipt are different facts: 32.5 rounds to 33, and -8 does not admit.
    expect(delegationSaving(51.5, 50_864, MODEL)).toBe(-8);
    expect(delegationSaving(51.5, 50_865, MODEL)).toBe(32.5);
    expect(delegationSaving(51.5, FLOOR, MODEL)).toBeGreaterThan(0);
    expect(delegationSaving(51.5, FLOOR - 1, MODEL)).toBeLessThanOrEqual(0);
    // No map entry can pay once the coordinator takes at least as many turns as the largest estimate.
    expect(costModelFloor({ coordinatorTurns: 51.5, workerTokensPerCall: 40_000 })).toBe(Number.POSITIVE_INFINITY);
    expect(costModelFloor({ coordinatorTurns: 80, workerTokensPerCall: 1 })).toBe(Number.POSITIVE_INFINITY);
  });

  it('prices other coordinator and worker constants through the same function', () => {
    const model = delegationModel({ ...DEFAULT_CONFIG, delegationCoordinatorTurns: 20, delegationWorkerTokensPerCall: 10_000 });
    expect(model).toEqual({ coordinatorTurns: 20, workerTokensPerCall: 10_000 });
    expect(costModelFloor(model)).toBe(Math.floor((51.5 * 10_000) / (51.5 - 20)) + 1);
    expect(costModelFloor(model)).not.toBe(FLOOR);
    expect(delegationSaving(26.5, 200_000, model)).toBe((26.5 - 20) * 200_000 - 26.5 * 10_000);
  });

  it('treats an exact zero saving as not worth admitting', () => {
    const model = { coordinatorTurns: 3, workerTokensPerCall: 1_000 };
    expect(delegationSaving(estimatedTurns(2), 2_000, model)).toBe(0);
    expect(decideAdmissionAtomic(answers({ tool_calls: 2 }), 2_000, costModelFloor(model), model)).toMatchObject({
      shape: 'direct',
      decided: false,
      reason: 'admission_not_worth',
      estimate: { turns: 6, saving_tokens: 0 },
    });
  });
});

describe('decideAdmissionAtomic', () => {
  it('admits a large job at depth and records the price, with no confidence floor consulted', () => {
    const d = decideAdmissionAtomic(answers(), DEEP, FLOOR, MODEL);
    expect(d).toEqual({
      shape: 'orchestrated',
      execution: 'single',
      decided: true,
      reason: null,
      answer: null,
      estimate: { turns: 51.5, saving_tokens: (51.5 - 11) * DEEP - 51.5 * 40_000, cost_support: 1 },
    });
  });

  it('prices the same request differently at different depths', () => {
    // 39 turns pays at 406K but not at 55K, where the coordinator's own 11 turns are most of what it would remove.
    expect(decideAdmissionAtomic(answers({ tool_calls: 3.5 }), DEEP, FLOOR, MODEL).shape).toBe('orchestrated');
    expect(decideAdmissionAtomic(answers({ tool_calls: 3.5 }), 55_000, FLOOR, MODEL)).toMatchObject({ shape: 'direct', reason: 'admission_not_worth', estimate: { turns: 39, saving_tokens: -20_000 } });
  });

  it.each([
    ['score 3 at a depth where 26.5 turns pay', 3, 406_000, { turns: 26.5, saving_tokens: 5_233_000 }, 'orchestrated', null],
    ['score 3 at 55K', 3, 55_000, { turns: 26.5, saving_tokens: -207_500 }, 'direct', 'admission_not_worth'],
    ['score 3.5 at 55K', 3.5, 55_000, { turns: 39, saving_tokens: -20_000 }, 'direct', 'admission_not_worth'],
    ['the largest answer just below the derived floor', 4, 50_864, null, 'direct', 'depth_below_floor'],
    ['the largest answer at the derived floor', 4, 50_865, { turns: 51.5, saving_tokens: 33 }, 'orchestrated', null],
  ] as const)('%s', (_name, score, depth, estimate, shape, reason) => {
    expect(decideAdmissionAtomic(answers({ tool_calls: score }), depth, FLOOR, MODEL)).toMatchObject({
      shape,
      decided: shape === 'orchestrated',
      reason,
      estimate,
    });
  });

  it.each([0, 1, 2])('keeps score %s direct under the default constants: the estimate is under 11 coordinator turns', (score) => {
    expect(estimatedTurns(score)).toBeLessThan(MODEL.coordinatorTurns);
    const d = decideAdmissionAtomic(answers({ tool_calls: score }), DEEP, FLOOR, MODEL);
    expect(d).toMatchObject({ shape: 'direct', decided: false, reason: 'admission_not_worth' });
    expect(d.estimate?.saving_tokens).toBeLessThanOrEqual(0);
  });

  it('stays direct when a cost-eligible answer still forbids delegation', () => {
    expect(decideAdmissionAtomic(answers({ tool_calls: 3 }), DEEP, FLOOR, MODEL)).toMatchObject({ shape: 'orchestrated', estimate: { turns: 26.5, saving_tokens: 5_233_000 } });
    expect(decideAdmissionAtomic(answers({ tool_calls: 3, forbids_delegation: FACT_TRUE }), DEEP, FLOOR, MODEL)).toMatchObject({
      shape: 'direct',
      decided: false,
      reason: 'admission_forbids_delegation',
      estimate: null,
    });
  });

  it('uses the floor it was given, including one that is not the derived default', () => {
    // Below the derived floor the prefilter never asks; a lower explicit floor lets the price decide, and -8 stays direct.
    expect(decideAdmissionAtomic(answers({ tool_calls: 4 }), 50_864, 40_000, MODEL)).toMatchObject({
      shape: 'direct',
      reason: 'admission_not_worth',
      estimate: { turns: 51.5, saving_tokens: -8 },
    });
    expect(decideAdmissionAtomic(answers({ tool_calls: 4 }), DEEP, 500_000, MODEL).reason).toBe('depth_below_floor');
    expect(decideAdmissionAtomic(answers(), null, 0, MODEL).reason).toBe('depth_unknown');
  });

  it.each([
    ['depth unknown', null, FLOOR, {}, 'depth_unknown'],
    ['a session below the floor', 40_000, FLOOR, {}, 'depth_below_floor'],
    ['a request that refuses delegation', DEEP, FLOOR, { forbids_delegation: FACT_TRUE }, 'admission_forbids_delegation'],
    ['work too small to repay the coordinator', DEEP, FLOOR, { tool_calls: 2 }, 'admission_not_worth'],
    ['a reply', DEEP, FLOOR, { tool_calls: 0 }, 'admission_not_worth'],
  ])('stays direct for %s', (_name, depth, floor, over, reason) => {
    expect(decideAdmissionAtomic(answers(over as Record<string, number>), depth, floor, MODEL)).toMatchObject({ shape: 'direct', decided: false, reason });
  });

  it('lets a connector step through regardless of the root guard setting', () => {
    expect(decideAdmissionAtomic(answers({ external_tools: 0.95 }), DEEP, FLOOR, MODEL).shape).toBe('orchestrated');
  });

  it('reads depth before anything else, so a veto never masks a shallow session', () => {
    expect(decideAdmissionAtomic(answers({ forbids_delegation: 0.99 }), 40_000, FLOOR, MODEL).reason).toBe('depth_below_floor');
  });

  it('applies no depth test when the floor is off, and the price still decides', () => {
    expect(decideAdmissionAtomic(answers(), 1_000, 0, MODEL).reason).toBe('admission_not_worth');
    expect(decideAdmissionAtomic(answers({ forbids_delegation: 0.9 }), 1_000, 0, MODEL).reason).toBe('admission_forbids_delegation');
  });

  it('lets a shape read-off shape the turn but never veto it', () => {
    const loud = decideAdmissionAtomic(answers({ plan_only: 0.95, parallel_outcomes: 0.95 }), DEEP, FLOOR, MODEL);
    expect(loud).toMatchObject({ shape: 'orchestrated', decided: true });
  });

  it.each([
    [
      'a missing noul',
      (() => {
        const a = answers();
        delete a['forbids_delegation'];
        return a;
      })(),
    ],
    ['a non-numeric noul', { ...answers(), forbids_delegation: { type: 'noul', noul: 'high' } }],
    ['a noul outside 0..1', { ...answers(), forbids_delegation: { type: 'noul', noul: 1.2 } }],
    ['a choice answer where a noul belongs', { ...answers(), forbids_delegation: { choice: 'yes', confidence: 0.99 } }],
    [
      'a missing tool-call score',
      (() => {
        const a = answers();
        delete a['tool_calls'];
        return a;
      })(),
    ],
    ['a noul where the tool-call score belongs', { ...answers(), tool_calls: { type: 'noul', noul: 0.9 } }],
    ["a tool-call score above the question's own scale", { ...answers(), tool_calls: { type: 'score', score: 999, confidence: 0.9 } }],
    ["a tool-call score below the question's own scale", { ...answers(), tool_calls: { type: 'score', score: -1, confidence: 0.9 } }],
    ['a noul number under a choice type', { ...answers(), forbids_delegation: { type: 'choice', noul: 0.05 } }],
    ['a noul number with no type', { ...answers(), forbids_delegation: { noul: 0.05 } }],
    ['a score answered as a noul type', { ...answers(), tool_calls: { type: 'noul', score: 4 } }],
  ])('leaves the turn direct for %s', (_name, a) => {
    expect(decideAdmissionAtomic(a as Record<string, unknown>, DEEP, FLOOR, MODEL)).toEqual({
      shape: 'direct',
      execution: null,
      decided: false,
      reason: 'admission_invalid',
      answer: null,
      estimate: null,
    });
  });
});

describe('shape', () => {
  const facts = (parallel: number | null, size: number | null, planOnly = 0.1): Record<string, unknown> => ({
    ...(parallel === null ? {} : { parallel_outcomes: { type: 'noul', noul: parallel } }),
    ...(size === null ? {} : { size: { type: 'score', score: size } }),
    plan_only: { type: 'noul', noul: planOnly },
  });

  it('recommends hierarchy only for separate outcomes or a whole project', () => {
    expect(shapeRecommendation(facts(0.95, 2, 0.95))).toEqual({ admitted_shape: 'hierarchy', plan_only: true, applied: false });
    expect(shapeRecommendation(facts(0.1, 4))).toMatchObject({ admitted_shape: 'hierarchy' });
    expect(shapeRecommendation(facts(0.1, 3), true)).toEqual({ admitted_shape: 'single', plan_only: false, applied: true });
    // Unreadable is unknown, not a recommendation of either shape.
    expect(shapeRecommendation({})).toEqual({ admitted_shape: null, plan_only: null, applied: false });
  });

  it('resolves auto from the request, and a configured shape outright', () => {
    expect(resolveAdmittedShape('auto', facts(0.95, 2))).toBe('hierarchy');
    expect(resolveAdmittedShape('auto', facts(0.1, 3))).toBe('single');
    expect(resolveAdmittedShape('auto', {})).toBe('single');
    // No Gate A answers at all (the forced arm, native mode): the shape those arms were built to measure.
    expect(resolveAdmittedShape('auto', null)).toBe('hierarchy');
    expect(resolveAdmittedShape('hierarchy', facts(0.1, 1))).toBe('hierarchy');
    expect(resolveAdmittedShape('single', facts(0.95, 4))).toBe('single');
  });
});

describe('atomic context and distribution support', () => {
  const decide = (a: Record<string, unknown>, cfg = DEFAULT_CONFIG) => decideAdmissionAtomic(a, DEEP, FLOOR, MODEL, cfg);
  const withScore = (score: number, p: number[], confidence = 0) => ({
    ...answers(),
    tool_calls: { type: 'score', score, confidence, probabilities: Object.fromEntries(p.map((v, i) => [i, v])) },
  });
  it.each([
    [3, [0, 0, 0, 1, 0], 1, 'orchestrated'],
    [3, [0.25, 0, 0, 0, 0.75], 0.75, 'direct'],
    [3.5, [0, 0, 0, 0.5, 0.5], 1, 'orchestrated'],
    [3.2, [0.2, 0, 0, 0, 0.8], 0.8, 'orchestrated'],
    [3.16, [0.21, 0, 0, 0, 0.79], 0.79, 'direct'],
  ] as const)('separates point saving from support: score %s distribution %j', (score, p, support, shape) => {
    const result = decide(withScore(score, [...p]));
    expect(result.shape).toBe(shape);
    expect(result.estimate?.cost_support).toBeCloseTo(support);
    expect(result.estimate?.saving_tokens).toBeGreaterThan(0);
  });
  it.each([
    { type: 'score', score: 4, confidence: 1, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0 } },
    { type: 'score', score: 3, confidence: 1 },
    { type: 'score', score: 3, confidence: 1, probabilities: [0, 0, 0, 1, 0] },
    { type: 'score', score: 3, confidence: 1, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 } },
    { type: 'score', score: 3, confidence: NaN, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0 } },
    { type: 'score', score: 3, confidence: 1, probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.9, 4: 0 } },
  ])('refuses malformed or inconsistent Score answers', (tool_calls) => {
    expect(decide({ ...answers(), tool_calls })).toMatchObject({ shape: 'direct', reason: 'admission_invalid' });
  });
  it('normalizes only its calculation copy and keeps raw point estimation', () => {
    const a = withScore(3.02, [0, 0, 0, 0.98, 0.02]);
    // Rounded probabilities have a 1.01 sum; they are accepted under the shared two-decimal rule.
    const value = a.tool_calls as { score: number; probabilities: Record<string, number> };
    value.score = 3.05;
    value.probabilities = { 0: 0, 1: 0, 2: 0, 3: 0.99, 4: 0.02 };
    const before = JSON.stringify(a);
    expect(decide(a).estimate?.cost_support).toBe(1);
    expect(JSON.stringify(a)).toBe(before);
  });
  it.each([
    ['self_contained', 0.8, 'orchestrated'],
    ['self_contained', 0.79, 'direct'],
    ['needs_context', 0.95, 'direct'],
    ['unclear', 0.95, 'direct'],
  ] as const)('requires unique self-contained support, without a separate confidence floor: %s %s', (pick, p, shape) => {
    const labels = ['self_contained', 'needs_context', 'unclear'];
    const task_context = {
      type: 'choice',
      choice: pick,
      confidence: 0,
      probabilities: Object.fromEntries(labels.map((k) => [k, k === pick ? p : (1 - p) / 2])),
    };
    expect(decide({ ...answers(), task_context }).shape).toBe(shape);
  });
  it('keeps an earlier explicit veto even when later answers are invalid', () => {
    expect(decide({ ...answers({ forbids_delegation: 0.6 }), task_context: null, tool_calls: null })).toMatchObject({
      reason: 'admission_forbids_delegation',
      execution: null,
    });
  });
  it('asks five facts only when auto can actually choose a hierarchy', () => {
    const cfg = { ...DEFAULT_CONFIG, maxParallelWorkers: 2 };
    expect(Object.keys(buildAtomicAdmissionRequest('task', cfg).questions)).toEqual([
      'forbids_delegation',
      'task_context',
      'tool_calls',
      'bounded_tool_work',
      'parallel_outcomes',
      'size',
    ]);
    expect(Object.keys(buildAtomicAdmissionRequest('task', { ...cfg, admittedShape: 'hierarchy' }).questions)).toEqual([
      'forbids_delegation',
      'task_context',
      'tool_calls',
    ]);
  });
  it('does not guess single when a required shape answer is invalid; decisive OR evidence short-circuits', () => {
    const cfg = { ...DEFAULT_CONFIG, maxParallelWorkers: 2 };
    expect(decide({ ...answers(), size: null }, cfg)).toMatchObject({
      shape: 'direct',
      execution: null,
      reason: 'admission_shape_unknown',
    });
    expect(decide({ ...answers({ parallel_outcomes: 0.6 }), size: null }, cfg)).toMatchObject({
      shape: 'orchestrated',
      execution: 'hierarchy',
    });
    expect(decide({ ...answers({ size: 4 }), parallel_outcomes: null }, cfg)).toMatchObject({
      shape: 'orchestrated',
      execution: 'hierarchy',
    });
    expect(decide({ ...answers(), size: null, parallel_outcomes: null })).toMatchObject({ shape: 'orchestrated', execution: 'single' });
  });
});

it('preserves the exact .8 support boundary across floating-point addition', () => {
  const a = answers();
  a.tool_calls = { type: 'score', score: 2.5, confidence: 0.99, probabilities: { 0: 0.2, 1: 0, 2: 0, 3: 0.7, 4: 0.1 } };
  expect(decideAdmissionAtomic(a, DEEP, FLOOR, MODEL).shape).toBe('orchestrated');
});

describe('bounded fast-worker preference', () => {
  const decide = (a: Record<string, unknown>, cfg = DEFAULT_CONFIG) => decideAdmissionAtomic(a, 1000, 0, MODEL, cfg);
  it.each([1, 2])('admits one whole bounded tool outcome at shallow depth without claiming savings: %s', tool_calls => {
    const result = decide(answers({ tool_calls, bounded_tool_work: .99 }));
    expect(result).toMatchObject({ shape: 'orchestrated', execution: 'single', preference: 'bounded_tool_worker' });
    expect(result.estimate?.saving_tokens).toBeLessThan(0);
  });
  it.each([undefined, .79, NaN, 1.1])('does not create a preference from absent, uncertain or invalid facts: %s', value => {
    const a = answers({ tool_calls: 1, ...(value === undefined ? {} : { bounded_tool_work: value }) });
    expect(decide(a)).toMatchObject({ shape: 'direct', reason: 'admission_not_worth' });
  });
  it('requires the asked choice type, a unique bounded choice and the unchanged .8 support', () => {
    for (const bounded_tool_work of [
      { type: 'noul', noul: 1 },
      { type: 'choice', choice: 'unknown', confidence: 1, probabilities: { unknown: 1 } },
      { type: 'choice', choice: 'bounded', confidence: 1, probabilities: { bounded: .5, other: .5, unclear: 0 } },
      { type: 'choice', choice: 'other', confidence: 1, probabilities: { bounded: 0, other: 1, unclear: 0 } },
    ]) expect(decide({ ...answers({ tool_calls: 1 }), bounded_tool_work }).shape).toBe('direct');
    expect(decide(answers({ tool_calls: 1, bounded_tool_work: .8 })).preference).toBe('bounded_tool_worker');
  });
  it('preserves no-delegation, missing context, conversational answers, broad work and explicit hierarchy', () => {
    const base = answers({ tool_calls: 1, bounded_tool_work: .99 });
    for (const a of [answers({ tool_calls: 1, bounded_tool_work: .99, forbids_delegation: .9 }), { ...base, task_context: { type: 'choice', choice: 'needs_context', confidence: 1, probabilities: { self_contained: 0, needs_context: 1, unclear: 0 } } }, answers({ tool_calls: 0, bounded_tool_work: .99 }), answers({ tool_calls: 3, bounded_tool_work: .99 })]) expect(decide(a).shape).toBe('direct');
    expect(decide(base, { ...DEFAULT_CONFIG, admittedShape: 'hierarchy' }).shape).toBe('direct');
    expect(decideAdmissionAtomic(base, null, 0, MODEL, DEFAULT_CONFIG).shape).toBe('direct');
    expect(decideAdmissionAtomic(base, 1000, 2000, MODEL, DEFAULT_CONFIG).shape).toBe('direct');
  });
  it('does not flatten independent outcomes, projects or unknown shape facts into one fast worker', () => {
    const cfg = { ...DEFAULT_CONFIG, maxParallelWorkers: 4 };
    for (const a of [answers({ tool_calls: 1, bounded_tool_work: .99, parallel_outcomes: .9 }), answers({ tool_calls: 1, bounded_tool_work: .99, size: 4 }), { ...answers({ tool_calls: 1, bounded_tool_work: .99 }), size: undefined }, { ...answers({ tool_calls: 1, bounded_tool_work: .99 }), parallel_outcomes: undefined }]) expect(decide(a, cfg).shape).toBe('direct');
    expect(decide(answers({ tool_calls: 1, bounded_tool_work: .99 }), cfg).preference).toBe('bounded_tool_worker');
  });
});
