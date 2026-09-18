import { describe, expect, it } from 'vitest';

import {
  buildPlannerRouteRequest,
  buildResultRequest,
  buildWorkerRouteRequest,
  decidePlannerRoute,
  decideResult,
  decideWorkerRoute,
  PLANNER_TIER_QUESTION,
  RESULT_QUESTION,
  ROUTE_QUESTION,
  UPGRADE_BASIS_QUESTION,
} from '../src/allocation.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { contractHash } from '../src/plan.js';
import {
  PLANNER_ROUTE_ANSWERS,
  RESULT_VERDICTS,
  ROUTE_ANSWERS,
  UPGRADE_BASES,
  type PlannedTask,
  type PlannerRouteAnswer,
  type ResultVerdict,
  type RouteAnswer,
  type UpgradeBasis,
  type WorkerReply,
} from '../src/types.js';

const pick = <K extends string>(keys: readonly K[], winner: K, p = 0.9, confidence = p): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === winner ? p : (1 - p) / (keys.length - 1)])),
  confidence,
});
const route = (winner: RouteAnswer, p?: number, c?: number): Record<string, unknown> => pick(ROUTE_ANSWERS, winner, p, c);
const basis = (winner: UpgradeBasis, p?: number, c?: number): Record<string, unknown> => pick(UPGRADE_BASES, winner, p, c);
const planning = (winner: PlannerRouteAnswer, p?: number, c?: number): Record<string, unknown> => pick(PLANNER_ROUTE_ANSWERS, winner, p, c);
const result = (winner: ResultVerdict, p?: number, c?: number): Record<string, unknown> => pick(RESULT_VERDICTS, winner, p, c);

const bare = {
  id: 't1',
  outcome: 'Implement the store',
  depends_on: [],
  context: '',
  constraints: ['keep the public API'],
  deliverables: ['src/store.ts'],
  checks: [{ id: 'c1', description: 'unit tests pass', required: true, command: 'npm test' }],
  replan_if: [],
};
const task: PlannedTask = { ...bare, contract_hash: contractHash(bare) };
const reply: WorkerReply = { status: 'done', summary: 's', changed_files: ['src/store.ts'], interfaces: [], checks: [{ check_id: 'c1', result: 'pass', note: '' }], blockers: [] };

describe('requests', () => {
  it('builds the worker request from fields, sending the contract content once rather than twice', () => {
    const original = '[JEV_TASK rev=1 id=t1]\nStart from the existing module and keep the tests green.';
    const request = buildWorkerRouteRequest(task, ['global'], [{ task_id: 't0', summary: 'done', interfaces: ['f()'] }], original, 'deep', DEFAULT_CONFIG);
    expect(Object.keys(request.questions)).toEqual(['route', 'upgrade_basis']);
    expect(Object.keys(request.state)).toEqual(['role', 'default_tier', 'called_tier', 'task', 'global_constraints', 'predecessor_results', 'original_prompt', 'tier_profiles']);
    expect(request.state).toMatchObject({ role: 'worker', default_tier: 'standard', called_tier: 'deep', original_prompt: original, global_constraints: ['global'] });
    // The canonical block is built from the fields, so it must not also be inside original_prompt.
    expect(request.state.original_prompt).not.toContain('[Jev Gate task contract]');
    const body = JSON.stringify(request);
    expect(body.split(task.contract_hash)).toHaveLength(2);
    expect(body.split('src/store.ts')).toHaveLength(2);
    expect(Object.keys(request.state.tier_profiles)).toEqual(['fast', 'standard', 'deep', 'frontier']);
    expect(Object.keys(ROUTE_QUESTION.criteria)).toEqual([...ROUTE_ANSWERS]);
    expect(Object.keys(UPGRADE_BASIS_QUESTION.criteria)).toEqual([...UPGRADE_BASES]);
    expect(ROUTE_QUESTION.instructions).toContain('File count, subject name, prompt length and general complexity alone');
    expect(UPGRADE_BASIS_QUESTION.instructions).toContain('network, authentication, permission or missing-dependency failure');
  });

  it('builds the planner request with the configured default tier and the result request with the reply', () => {
    const planner = buildPlannerRouteRequest('plan this', { ...DEFAULT_CONFIG, plannerDefaultTier: 'frontier' });
    expect(planner.state).toMatchObject({ role: 'planner', default_tier: 'frontier', request: 'plan this' });
    expect(Object.keys(planner.questions)).toEqual(['planning_tier']);
    expect(Object.keys(PLANNER_TIER_QUESTION.criteria)).toEqual([...PLANNER_ROUTE_ANSWERS]);
    const judged = buildResultRequest(task, reply, DEFAULT_CONFIG);
    expect(Object.keys(judged.questions)).toEqual(['result']);
    expect(judged.state).toEqual({ task, reply });
    expect(Object.keys(RESULT_QUESTION.criteria)).toEqual([...RESULT_VERDICTS]);
  });
});

describe('decideWorkerRoute', () => {
  it.each([
    ['fast without any basis', { route: route('fast'), upgrade_basis: basis('no_specific_basis') }, 'patch', 'fast'],
    ['standard', { route: route('standard'), upgrade_basis: basis('unknown') }, 'patch', 'standard'],
    ['deep with contract reasoning', { route: route('deep'), upgrade_basis: basis('unresolved_contract_reasoning') }, 'patch', 'deep'],
    ['frontier with an observed failure', { route: route('frontier'), upgrade_basis: basis('observed_reasoning_failure') }, 'patch', 'frontier'],
  ])('patches for %s', (_name, answers, action, tier) => {
    expect(decideWorkerRoute(answers, 0.8, 'standard')).toMatchObject({ action, tier, reason: null });
  });

  it.each([
    ['deep without a basis', { route: route('deep'), upgrade_basis: basis('no_specific_basis') }, 'basis_absent'],
    ['deep with an unknown basis', { route: route('deep'), upgrade_basis: basis('unknown') }, 'basis_absent'],
    ['deep with a low-confidence basis', { route: route('deep'), upgrade_basis: basis('unresolved_contract_reasoning', 0.9, 0.5) }, 'basis_low_confidence'],
    ['deep with an invalid basis', { route: route('deep'), upgrade_basis: { type: 'choice' } }, 'basis_invalid'],
    ['an invalid route', { route: { type: 'text' }, upgrade_basis: basis('unknown') }, 'route_invalid'],
    ['abstain', { route: route('abstain'), upgrade_basis: basis('unknown') }, 'route_abstain'],
    ['the V4 case: top .82 with confidence .77 under a .8 floor', { route: route('fast', 0.82, 0.77), upgrade_basis: basis('unknown') }, 'route_low_confidence'],
  ])('preserves the called profile on %s', (_name, answers, reason) => {
    expect(decideWorkerRoute(answers, 0.8, 'standard')).toMatchObject({ action: 'preserve', tier: 'standard', reason });
  });

  it('preserves the called profile rather than the standard default when the call was deep', () => {
    expect(decideWorkerRoute({ route: route('abstain'), upgrade_basis: basis('unknown') }, 0.8, 'deep')).toMatchObject({ action: 'preserve', tier: 'deep' });
    expect(decideWorkerRoute({ route: route('abstain'), upgrade_basis: basis('unknown') }, 0.8, 'fast')).toMatchObject({ action: 'preserve', tier: 'fast' });
  });

  it('treats a route tie as no decision', () => {
    const tie = { type: 'choice', choice: 'deep', probabilities: { fast: 0, standard: 0.45, deep: 0.45, frontier: 0.1, abstain: 0 }, confidence: 0.95 };
    expect(decideWorkerRoute({ route: tie, upgrade_basis: basis('unresolved_contract_reasoning') }, 0.8, 'standard')).toMatchObject({ action: 'preserve', reason: 'route_tie' });
  });
});

describe('decidePlannerRoute', () => {
  it('upgrades to frontier only on a confident unique answer, and otherwise patches the configured default', () => {
    expect(decidePlannerRoute({ planning_tier: planning('frontier') }, 0.8, 'deep')).toMatchObject({ action: 'patch', tier: 'frontier', reason: null });
    expect(decidePlannerRoute({ planning_tier: planning('deep') }, 0.8, 'deep')).toMatchObject({ tier: 'deep', reason: null });
    expect(decidePlannerRoute({ planning_tier: planning('abstain') }, 0.8, 'frontier')).toMatchObject({ action: 'patch', tier: 'frontier', reason: 'route_abstain' });
    expect(decidePlannerRoute({ planning_tier: planning('frontier', 0.82, 0.77) }, 0.8, 'deep')).toMatchObject({ tier: 'deep', reason: 'route_low_confidence' });
    expect(decidePlannerRoute({}, 0.8, 'deep')).toMatchObject({ tier: 'deep', reason: 'route_invalid' });
  });
});

describe('decideResult', () => {
  it('returns a verdict only when it is valid, unique and confident', () => {
    expect(decideResult({ result: result('rework') }, 0.8)).toMatchObject({ verdict: 'rework', reason: null });
    expect(decideResult({ result: result('abstain') }, 0.8)).toMatchObject({ verdict: null, reason: 'result_abstain' });
    expect(decideResult({ result: result('replan', 0.82, 0.77) }, 0.8)).toMatchObject({ verdict: null, reason: 'result_low_confidence' });
    expect(decideResult({}, 0.8)).toMatchObject({ verdict: null, reason: 'result_invalid' });
  });
});
