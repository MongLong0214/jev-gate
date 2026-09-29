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
import { DEFAULT_CONFIG } from '../src/config.js';

/**
 * Gate A decomposed: read-offs from the request, composed here as vetoes and a price, with depth deciding first.
 * Since 0.4.0 the price is the admission: delegate when the root turns it removes, each re-reading `depth`, outweigh
 * what the worker reads doing them.
 */
const MODEL = delegationModel(DEFAULT_CONFIG);
const FLOOR = costModelFloor(MODEL);
const DEEP = 406_000;

const answers = (over: Record<string, number> = {}): Record<string, unknown> => {
  const { size = 3, tool_calls = 4, ...facts } = { forbids_delegation: 0.05, external_tools: 0.05, plan_only: 0.05, parallel_outcomes: 0.05, ...over };
  return {
    ...Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, { type: 'noul', noul: v }])),
    size: { type: 'score', score: size, confidence: 0.9 },
    tool_calls: { type: 'score', score: tool_calls, confidence: 0.9 },
  };
};

describe('atomic admission questions', () => {
  it('asks two vetoes, one cost score and three shape read-offs, and none of them is a forecast', () => {
    expect(Object.keys(ADMISSION_FACT_QUESTIONS)).toEqual(['forbids_delegation', 'external_tools', 'plan_only', 'parallel_outcomes', 'size', 'tool_calls']);
    expect(ADMISSION_FACT_QUESTIONS.size.type).toBe('score');
    expect(ADMISSION_FACT_QUESTIONS.tool_calls.type).toBe('score');
    for (const k of ['forbids_delegation', 'external_tools', 'plan_only', 'parallel_outcomes'] as const) {
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
    expect(Object.keys(atomic.questions)).toEqual(Object.keys(ADMISSION_FACT_QUESTIONS));
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
    expect(d).toEqual({ shape: 'orchestrated', decided: true, reason: null, answer: null, estimate: { turns: 51.5, saving_tokens: (51.5 - 11) * DEEP - 51.5 * 40_000 } });
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
    ['a request that needs a connector', DEEP, FLOOR, { external_tools: FACT_TRUE }, 'admission_external_tools'],
    ['work too small to repay the coordinator', DEEP, FLOOR, { tool_calls: 2 }, 'admission_not_worth'],
    ['a reply', DEEP, FLOOR, { tool_calls: 0 }, 'admission_not_worth'],
  ])('stays direct for %s', (_name, depth, floor, over, reason) => {
    expect(decideAdmissionAtomic(answers(over as Record<string, number>), depth, floor, MODEL)).toMatchObject({ shape: 'direct', decided: false, reason });
  });

  it('lets a connector step through when the coordinator may call it itself', () => {
    expect(decideAdmissionAtomic(answers({ external_tools: 0.95 }), DEEP, FLOOR, MODEL, false).shape).toBe('orchestrated');
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
    ['a missing noul', (() => { const a = answers(); delete a['external_tools']; return a; })()],
    ['a non-numeric noul', { ...answers(), external_tools: { type: 'noul', noul: 'high' } }],
    ['a noul outside 0..1', { ...answers(), forbids_delegation: { type: 'noul', noul: 1.2 } }],
    ['a choice answer where a noul belongs', { ...answers(), external_tools: { choice: 'yes', confidence: 0.99 } }],
    ['a missing tool-call score', (() => { const a = answers(); delete a['tool_calls']; return a; })()],
    ['a noul where the tool-call score belongs', { ...answers(), tool_calls: { type: 'noul', noul: 0.9 } }],
    ['a tool-call score above the question\'s own scale', { ...answers(), tool_calls: { type: 'score', score: 999, confidence: 0.9 } }],
    ['a tool-call score below the question\'s own scale', { ...answers(), tool_calls: { type: 'score', score: -1, confidence: 0.9 } }],
    ['a noul number under a choice type', { ...answers(), external_tools: { type: 'choice', noul: 0.05 } }],
    ['a noul number with no type', { ...answers(), forbids_delegation: { noul: 0.05 } }],
    ['a score answered as a noul type', { ...answers(), tool_calls: { type: 'noul', score: 4 } }],
    ['a missing shape answer', (() => { const a = answers(); delete a['parallel_outcomes']; return a; })()],
    ['a malformed shape answer', { ...answers(), plan_only: { type: 'noul', noul: 2 } }],
    ['a size outside its scale', { ...answers(), size: { type: 'score', score: 9 } }],
  ])('leaves the turn direct for %s', (_name, a) => {
    expect(decideAdmissionAtomic(a as Record<string, unknown>, DEEP, FLOOR, MODEL)).toEqual({ shape: 'direct', decided: false, reason: 'admission_invalid', answer: null, estimate: null });
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
