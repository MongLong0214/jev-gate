import { describe, expect, it } from 'vitest';

import {
  buildPlanInterpretationRequest,
  classifyInterpretation,
  interpretationClauses,
  MAX_INTERPRETATION_CLAUSES,
  proposedInterfaces,
} from '../src/interpretation.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const choice = (winner: string, p = 0.9): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: { supported: winner === 'supported' ? p : (1 - p) / 3, contradicted: winner === 'contradicted' ? p : (1 - p) / 3, omitted: winner === 'omitted' ? p : (1 - p) / 3, unknown: winner === 'unknown' ? p : (1 - p) / 3 },
  confidence: p,
});

const TASKS = [
  { id: 't1', outcome: 'build the store', deliverables: ['src/store.ts'], spec: { interfaces: ['createStore(): Store'], data_shapes: [], invariants: [], files: [] } },
  { id: 't2', outcome: 'wire the page', deliverables: ['src/page.tsx'] },
];

describe('plan interpretation (A23)', () => {
  it('gives every clause an id a reader can quote back', () => {
    const clauses = interpretationClauses(['keep the API', 'no new dependencies']);
    // The ids are the whole point: a finding names the clause it is about, rather than the plan as a whole.
    expect(clauses).toEqual([
      { id: 'c0', constraint: 'keep the API' },
      { id: 'c1', constraint: 'no new dependencies' },
    ]);
  });

  it('asks one question per clause and stops at the cap', () => {
    const constraints = Array.from({ length: MAX_INTERPRETATION_CLAUSES + 5 }, (_, i) => `c${i}`);
    const built = buildPlanInterpretationRequest('the request', 'the goal', constraints, TASKS, DEFAULT_CONFIG);
    expect(Object.keys(built.request.questions)).toHaveLength(MAX_INTERPRETATION_CLAUSES);
    expect(built.request.state.request).toBe('the request');
    // Each question carries its own clause text, so an answer cannot be attributed to the wrong constraint.
    expect(built.request.questions['c3']?.instructions).toContain('c3');
  });

  it('reads a task with no spec as proposing no interfaces rather than as missing', () => {
    expect(proposedInterfaces(TASKS)).toEqual([
      { task_id: 't1', outcome: 'build the store', deliverables: ['src/store.ts'], interfaces: ['createStore(): Store'] },
      { task_id: 't2', outcome: 'wire the page', deliverables: ['src/page.tsx'], interfaces: [] },
    ]);
  });

  it('records the verdicts and applies none of them', () => {
    const clauses = interpretationClauses(['a', 'b']);
    const got = classifyInterpretation({ c0: choice('contradicted'), c1: choice('supported') }, clauses, 2);
    expect(got).toEqual({
      clauses: [
        { id: 'c0', verdict: 'contradicted' },
        { id: 'c1', verdict: 'supported' },
      ],
      unasked: 0,
      applied: false,
    });
  });

  it('falls to unknown on a tie and on an unreadable answer', () => {
    const clauses = interpretationClauses(['a', 'b', 'c']);
    const tie = { type: 'choice', choice: 'supported', probabilities: { supported: 0.4, contradicted: 0.4, omitted: 0.1, unknown: 0.1 }, confidence: 0.4 };
    const got = classifyInterpretation({ c0: tie, c1: 'not an answer' }, clauses, 3);
    // `contradicted` is the only verdict a reader would act on, so anything short of one decisive answer has to land
    // on the verdict that asks for nothing rather than on a plausible-looking finding.
    expect(got.clauses.map((c) => c.verdict)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(got.applied).toBe(false);
  });

  it('counts the clauses a plan carried past the cap', () => {
    const constraints = Array.from({ length: 15 }, (_, i) => `c${i}`);
    const clauses = interpretationClauses(constraints);
    expect(classifyInterpretation({}, clauses, constraints.length).unasked).toBe(3);
  });
});
