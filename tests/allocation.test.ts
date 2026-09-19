import { describe, expect, it } from 'vitest';

import { buildPlannerRouteRequest, buildWorkerRouteRequest, decidePlannerRoute, decideWorkerRoute, PLANNER_TIER_QUESTION, ROUTE_QUESTION, UPGRADE_BASIS_QUESTION } from '../src/allocation.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { contractHash, ROUTING_TARGET_MARK, type PriorAttemptSummary } from '../src/plan.js';
import { PLANNER_ROUTE_ANSWERS, ROUTE_ANSWERS, UPGRADE_BASES, type PlannedTask, type PlannerRouteAnswer, type RouteAnswer, type UpgradeBasis } from '../src/types.js';

const pick = <K extends string>(keys: readonly K[], winner: K, p = 0.9, confidence = p): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === winner ? p : (1 - p) / (keys.length - 1)])),
  confidence,
});
const route = (winner: RouteAnswer, p?: number, c?: number): Record<string, unknown> => pick(ROUTE_ANSWERS, winner, p, c);
const basis = (winner: UpgradeBasis, p?: number, c?: number): Record<string, unknown> => pick(UPGRADE_BASES, winner, p, c);
const planning = (winner: PlannerRouteAnswer, p?: number, c?: number): Record<string, unknown> => pick(PLANNER_ROUTE_ANSWERS, winner, p, c);

const bare = {
  id: 't1',
  outcome: 'Implement the store',
  depends_on: [],
  context: '',
  constraints: ['keep the public API'],
  deliverables: ['src/store.ts'],
  checks: [{ id: 'c1', description: 'unit tests pass', required: true, command: 'npm test' }],
  replan_if: [],
  spec: { interfaces: ['createStore(): Store'], data_shapes: ['Store = { get(key: string): string | null }'], invariants: ['reads never throw'], files: ['src/store-types.ts'] },
  uncertainty: { unresolved: [], interacts_with: [], prior_failure: null },
  fully_specified: false,
};
const task: PlannedTask = { ...bare, contract_hash: contractHash(bare) };
const withEvidence = (over: Partial<PlannedTask>): PlannedTask => {
  const raw = { ...bare, ...over };
  return { ...raw, contract_hash: contractHash(raw) };
};

describe('requests', () => {
  it('builds the worker request from fields, sending the contract content once rather than twice', () => {
    const original = '[JEV_TASK rev=1 id=t1]\nStart from the existing module and keep the tests green.';
    const request = buildWorkerRouteRequest(task, ['global'], [{ task_id: 't0', summary: 'done', interfaces: ['f()'] }], original, 'deep', DEFAULT_CONFIG);
    expect(Object.keys(request.questions)).toEqual(['route', 'upgrade_basis']);
    expect(Object.keys(request.state)).toEqual([
      'role',
      'default_tier',
      'called_tier',
      'task',
      'global_constraints',
      'predecessor_results',
      'prior_attempt',
      'original_prompt',
      'tier_profiles',
    ]);
    expect(request.state.prior_attempt).toBeNull();
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

  /**
   * #33/A18: the tier gate reads the plan with routing targets removed, so planner text cannot read as a route
   * request. `ROUTE_QUESTION` also instructs the model to ignore such text; this does not depend on it obeying.
   * Before A18 the same text was rejected at parse time, which rejected the whole plan.
   */
  it('removes tier and model names from the plan text the gate reads, and only from that copy (#33/A18)', () => {
    const asking = withEvidence({
      constraints: ['serialize must deep-copy the state', 'run this on opus'],
      uncertainty: { unresolved: ['needs the frontier tier'], interacts_with: [], prior_failure: null },
    });
    const request = buildWorkerRouteRequest(asking, ['prefer the deep tier'], [], 'p', 'standard', DEFAULT_CONFIG);
    expect(request.state.task.constraints).toEqual(['serialize must deep-copy the state', `run this on ${ROUTING_TARGET_MARK}`]);
    expect(request.state.task.uncertainty?.unresolved).toEqual([`needs the ${ROUTING_TARGET_MARK} tier`]);
    expect(request.state.global_constraints).toEqual([`prefer the ${ROUTING_TARGET_MARK} tier`]);
    // The contract the worker implements is untouched, and the hash the receipt is matched on does not move.
    expect(asking.constraints).toEqual(['serialize must deep-copy the state', 'run this on opus']);
    expect(request.state.task.contract_hash).toBe(asking.contract_hash);
    // Not a rule about the word "opus": it is a configured model id, and a host that configures another gets that one.
    const renamed = { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models, deep: 'some-other-model' } };
    expect(buildWorkerRouteRequest(asking, [], [], 'p', 'standard', renamed).state.task.constraints[1]).toBe('run this on opus');
  });

  it('builds the planner request with the configured default tier', () => {
    const planner = buildPlannerRouteRequest('plan this', { ...DEFAULT_CONFIG, plannerDefaultTier: 'frontier' });
    expect(planner.state).toMatchObject({ role: 'planner', default_tier: 'frontier', request: 'plan this' });
    expect(Object.keys(planner.questions)).toEqual(['planning_tier']);
    expect(Object.keys(PLANNER_TIER_QUESTION.criteria)).toEqual([...PLANNER_ROUTE_ANSWERS]);
  });

  /** T11: the result gate is gone from the module, so nothing here can build a Gate C request at all. */
  it('R14: exports no result-gate question, request or decision', async () => {
    const allocation = (await import('../src/allocation.js')) as Record<string, unknown>;
    for (const name of ['RESULT_QUESTION', 'buildResultRequest', 'decideResult', 'SCOPE_QUESTION', 'buildPlanScopeRequest', 'decidePlanScope']) {
      expect(allocation[name], name).toBeUndefined();
    }
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

describe('routing evidence reaches the route question (#33)', () => {
  const unresolvedTask = withEvidence({
    uncertainty: { unresolved: ['whether writes go through the cache'], interacts_with: ['the persistence layer', 'the public API'], prior_failure: 'attempt 1 lost the ordering invariant' },
  });
  const mechanicalTask = withEvidence({ fully_specified: true, uncertainty: { unresolved: [], interacts_with: [], prior_failure: null } });

  it('sends uncertainty and fully_specified inside the task, once', () => {
    const request = buildWorkerRouteRequest(unresolvedTask, [], [], 'p', 'standard', DEFAULT_CONFIG);
    expect(request.state.task.uncertainty).toEqual(unresolvedTask.uncertainty);
    expect(request.state.task.fully_specified).toBe(false);
    expect(JSON.stringify(request).split('the ordering invariant')).toHaveLength(2);
    expect(ROUTE_QUESTION.criteria.fast).toContain('fully specified');
    expect(ROUTE_QUESTION.criteria.deep).toContain('residual uncertainty');
    expect(ROUTE_QUESTION.criteria.frontier).toContain('previous attempt');
  });

  it('upgrades an evidence-bearing task when Jev answers deep or frontier on a supported basis', () => {
    expect(decideWorkerRoute({ route: route('deep'), upgrade_basis: basis('unresolved_contract_reasoning') }, 0.8, 'standard')).toMatchObject({ action: 'patch', tier: 'deep' });
    expect(decideWorkerRoute({ route: route('frontier'), upgrade_basis: basis('observed_reasoning_failure') }, 0.8, 'standard')).toMatchObject({ action: 'patch', tier: 'frontier' });
  });

  it('routes a fully specified task to fast when Jev answers fast with sufficient confidence', () => {
    expect(buildWorkerRouteRequest(mechanicalTask, [], [], 'p', 'standard', DEFAULT_CONFIG).state.task.fully_specified).toBe(true);
    expect(decideWorkerRoute({ route: route('fast'), upgrade_basis: basis('no_specific_basis') }, 0.8, 'standard')).toMatchObject({ action: 'patch', tier: 'fast', reason: null });
    expect(decideWorkerRoute({ route: route('fast', 0.9, 0.79), upgrade_basis: basis('no_specific_basis') }, 0.8, 'standard')).toMatchObject({ action: 'preserve', reason: 'route_low_confidence' });
  });

  it('carries a failed attempt of the same task into its rework, so an observed failure is reachable', () => {
    const prior: PriorAttemptSummary = {
      attempt: 1,
      verdict: 'incomplete',
      verdict_reason: 'required check c1 reported fail',
      status: 'done',
      summary: 'ordering wrong',
      blockers: [],
      failed_checks: ['c1'],
      observed_model_confirmed: true,
      provenance: 'worker_reported',
    };
    const first = buildWorkerRouteRequest(mechanicalTask, [], [], 'p', 'standard', DEFAULT_CONFIG);
    const second = buildWorkerRouteRequest(mechanicalTask, [], [], 'p', 'standard', DEFAULT_CONFIG, prior);
    expect(first.state.prior_attempt).toBeNull();
    expect(second.state.prior_attempt).toMatchObject({ attempt: 1, failed_checks: ['c1'] });
    expect(JSON.stringify(second).length).toBeGreaterThan(JSON.stringify(first).length);
  });

  it('does not weaken the gate: evidence present, deep still needs a basis', () => {
    expect(decideWorkerRoute({ route: route('deep'), upgrade_basis: basis('no_specific_basis') }, 0.8, 'standard')).toMatchObject({ action: 'preserve', tier: 'standard', reason: 'basis_absent' });
  });

  /** Document §7: an absent field is unknown, not a claim that the work is mechanical. */
  it('sends a task with no evidence fields as it is, and says so in the question text', () => {
    const bare: PlannedTask = { ...task };
    delete bare.spec;
    delete bare.uncertainty;
    delete bare.fully_specified;
    const request = buildWorkerRouteRequest(bare, [], [], 'p', 'standard', DEFAULT_CONFIG);
    expect(request.state.task).not.toHaveProperty('spec');
    expect(request.state.task).not.toHaveProperty('uncertainty');
    expect(request.state.task).not.toHaveProperty('fully_specified');
    expect(ROUTE_QUESTION.instructions).toContain('absent evidence is unknown, not a claim that the work is mechanical');
    // T9/T10: a malformed report is not evidence that a stronger model is needed.
    expect(UPGRADE_BASIS_QUESTION.instructions).toContain('the format of its report');
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
