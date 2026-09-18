import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GUARD_DENY_REASON, STOP_REASON } from '../src/coordinator.js';
import { DENIALS_BEFORE_STOP } from '../src/brief.js';
import { runHook, type HookDeps, type HookResult } from '../src/hook.js';
import { jobPath, newGeneration, readJob, updateJob } from '../src/job.js';
import { composeTaskPrompt, contractHash, MAX_COMPOSED_BYTES } from '../src/plan.js';
import { ADMISSION_ANSWERS, PLANNER_ROUTE_ANSWERS, RESULT_VERDICTS, ROUTE_ANSWERS, UPGRADE_BASES, type JobState, type PlannedTask, type WorkerReply } from '../src/types.js';

const KEY = 'ts-secret-key-123';
const tmp = mkdtempSync(join(tmpdir(), 'jev-hook-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const choice = (keys: readonly string[], winner: string, p = 0.95, confidence = p): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === winner ? p : (1 - p) / (keys.length - 1)])),
  confidence,
});

interface FakeAnswers {
  execution?: string;
  route?: string;
  basis?: string;
  planning_tier?: string;
  result?: string;
  onCall?: (questions: string[]) => void;
}

const fakeJev = (opts: FakeAnswers = {}): ReturnType<typeof vi.fn> =>
  vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    const questions = Object.keys(body.questions);
    opts.onCall?.(questions);
    const answers: Record<string, unknown> = {};
    if (questions.includes('execution')) answers['execution'] = choice(ADMISSION_ANSWERS, opts.execution ?? 'orchestrated');
    if (questions.includes('route')) answers['route'] = choice(ROUTE_ANSWERS, opts.route ?? 'standard');
    if (questions.includes('upgrade_basis')) answers['upgrade_basis'] = choice(UPGRADE_BASES, opts.basis ?? 'no_specific_basis');
    if (questions.includes('planning_tier')) answers['planning_tier'] = choice(PLANNER_ROUTE_ANSWERS, opts.planning_tier ?? 'deep');
    if (questions.includes('result')) answers['result'] = choice(RESULT_VERDICTS, opts.result ?? 'accept');
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  });

const stdinOf = (value: unknown): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  })();

type Env = Record<string, string | undefined>;
const makeEnv = (over: Env = {}): Env => ({ TYPESAFE_API_KEY: KEY, HOME: join(tmp, 'home'), JEV_GATE_MODE: 'auto', JEV_GATE_STATE_DIR: mkdtempSync(join(tmp, 'state-')), ...over });

const run = (env: Env, event: unknown, fetchImpl?: unknown, extra: Partial<HookDeps> = {}): Promise<HookResult> =>
  runHook({ env, stdin: stdinOf(event), ...(fetchImpl ? { fetchImpl: fetchImpl as typeof fetch } : {}), ...extra });

const parse = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;
const hookOutput = (r: HookResult): Record<string, unknown> => (parse(r.stdout as string)['hookSpecificOutput'] ?? {}) as Record<string, unknown>;
const context = (r: HookResult): string => String(hookOutput(r)['additionalContext'] ?? '');
const updatedInput = (r: HookResult): Record<string, unknown> => hookOutput(r)['updatedInput'] as Record<string, unknown>;
const fence = (value: unknown): string => 'summary prose\n```json\n' + JSON.stringify(value) + '\n```';

const promptEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: 's1',
  prompt_id: 'p1',
  cwd: '/w',
  prompt: 'Build a settings page, migrate the store and wire the two together.',
  ...over,
});

const preEvent = (toolName: string, toolInput: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: 'PreToolUse',
  session_id: 's1',
  prompt_id: 'p1',
  tool_name: toolName,
  tool_use_id: 'toolu_1',
  tool_input: toolInput,
  ...over,
});

const agentInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  subagent_type: 'jev-gate:worker',
  description: 'implement the store',
  prompt: '[JEV_TASK rev=1 id=t1]\nImplement the store as planned.',
  run_in_background: false,
  ...over,
});

const rawTask = (id: string, over: Partial<PlannedTask> = {}): Omit<PlannedTask, 'contract_hash'> => ({
  id,
  outcome: `deliver ${id}`,
  depends_on: [],
  context: '',
  constraints: [],
  deliverables: [`src/${id}.ts`],
  checks: [{ id: 'c1', description: 'tests pass', required: true, command: 'npm test' }],
  replan_if: [],
  ...over,
});

const PLAN_TASKS = [rawTask('t1'), rawTask('t2'), rawTask('t3', { depends_on: ['t1', 't2'] })];
const PLAN_REPLY = { status: 'ready', goal: 'ship settings', assumptions: ['the store is local'], constraints: ['keep the public API'], tasks: PLAN_TASKS };

const plannerPre = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  preEvent('Agent', { subagent_type: 'jev-gate:planner', description: 'plan it', prompt: 'Plan this request.', run_in_background: false, ...over }, { tool_use_id: 'toolu_plan' });

const plannerPost = (reply: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: 'PostToolUse',
  session_id: 's1',
  prompt_id: 'p1',
  tool_name: 'Agent',
  tool_use_id: 'toolu_plan',
  tool_input: { subagent_type: 'jev-gate:planner' },
  tool_response: { status: 'completed', resolvedModel: 'claude-opus-5', content: [{ type: 'text', text: fence(reply) }] },
  ...over,
});

const workerReply = (over: Partial<WorkerReply> = {}): WorkerReply => ({
  status: 'done',
  summary: 'implemented the store',
  changed_files: ['src/t1.ts'],
  interfaces: ['createStore()'],
  checks: [{ check_id: 'c1', result: 'pass', note: 'npm test' }],
  blockers: [],
  ...over,
});

const workerPost = (toolUseId: string, reply: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: 'PostToolUse',
  session_id: 's1',
  prompt_id: 'p1',
  tool_name: 'Agent',
  tool_use_id: toolUseId,
  effort: 'high',
  tool_input: { subagent_type: 'jev-gate:worker' },
  tool_response: { status: 'completed', resolvedModel: 'claude-sonnet-5', content: [{ type: 'text', text: fence(reply) }] },
  ...over,
});

const state = (env: Env): JobState => {
  const r = readJob(env, 's1');
  if (!r.ok || !r.value) throw new Error('no job state');
  return r.value;
};

/** Drives admission → planner dispatch → planner reply, so a test can start from a planned job. */
const seedPlanned = async (env: Env, reply: unknown = PLAN_REPLY, fetchImpl: unknown = fakeJev()): Promise<void> => {
  await run(env, promptEvent(), fetchImpl);
  await run(env, plannerPre(), fetchImpl);
  await run(env, plannerPost(reply), fetchImpl);
};

describe('mode off', () => {
  it('makes no request and never touches job state', async () => {
    const env = makeEnv({ JEV_GATE_MODE: 'off' });
    const fetchImpl = fakeJev();
    for (const event of [promptEvent(), preEvent('Bash', { command: 'ls' }), workerPost('toolu_1', workerReply())]) {
      expect(await run(env, event, fetchImpl)).toMatchObject({ kind: 'skip', code: 'mode_off' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(jobPath(env, 's1'))).toBe(false);
  });
});

describe('Gate A admission', () => {
  it('admits an orchestrated job with one request and emits the orchestration guidance', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    const r = await run(env, promptEvent(), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.kind).toBe('guidance');
    expect(hookOutput(r)['hookEventName']).toBe('UserPromptSubmit');
    expect(context(r)).toContain('Execution shape: orchestrated');
    expect(context(r)).toContain('[JEV_TASK rev=<n> id=<id>]');
    expect(context(r)).not.toContain('settings page');
    expect(state(env).current).toMatchObject({ prompt_id: 'p1', shape: 'orchestrated', phase: 'admitted' });
  });

  it.each([
    ['direct', 'direct', null],
    ['needs_context', 'direct', 'admission_needs_context'],
    ['abstain', 'direct', 'admission_abstain'],
  ])('answer %s produces the direct shape', async (answer, shape, code) => {
    const env = makeEnv();
    const r = await run(env, promptEvent(), fakeJev({ execution: answer }));
    expect(r.code).toBe(code);
    expect(context(r)).toContain('Execution shape: direct');
    expect(state(env).current.shape).toBe(shape);
  });

  it('records prompt_id_absent and creates no orchestrated state', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    const r = await run(env, promptEvent({ prompt_id: undefined }), fetchImpl);
    expect(r).toMatchObject({ kind: 'guidance', code: 'prompt_id_absent' });
    expect(context(r)).toContain('Execution shape');
    expect(context(r)).not.toContain('you coordinate');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(jobPath(env, 's1'))).toBe(false);
  });

  it('forces an orchestrated job in auto with no Gate A request when the control variable is set (A16)', async () => {
    const env = makeEnv({ JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' });
    const fetchImpl = fakeJev({ execution: 'direct' });
    const r = await run(env, promptEvent(), fetchImpl);
    expect(r).toMatchObject({ kind: 'guidance', code: 'admission_forced' });
    expect(context(r)).toContain('Execution shape: orchestrated');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state(env).current).toMatchObject({ shape: 'orchestrated', phase: 'admitted', forced: true });
    expect(await run(env, preEvent('Bash', {}), fetchImpl)).toMatchObject({ kind: 'deny', code: 'guard_denied' });
    // Only Gate A is skipped: the allocation gate still makes a real request.
    expect(await run(env, plannerPre(), fetchImpl)).toMatchObject({ kind: 'patch' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to direct without a key and skips blank, slash and child prompts', async () => {
    const env = makeEnv({ TYPESAFE_API_KEY: undefined });
    expect(await run(env, promptEvent())).toMatchObject({ kind: 'guidance', code: 'key_missing' });
    for (const over of [{ prompt: '   ' }, { prompt: '/model opus' }, { agent_id: 'child' }, { agent_type: 'custom' }]) {
      expect(await run(makeEnv(), promptEvent(over))).toMatchObject({ kind: 'skip', code: null });
    }
  });

  it('supersedes an unfinished generation and tells the coordinator', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    expect(Object.keys(state(env).current.active)).toEqual(['toolu_1']);
    const r = await run(env, promptEvent({ prompt_id: 'p2' }), fetchImpl);
    expect(context(r)).toContain('superseded by this request');
    const after = state(env);
    expect(after.current).toMatchObject({ prompt_id: 'p2', plan: null });
    expect(after.history[0]?.active['toolu_1']).toMatchObject({ orphaned: true });
    // A late result from the superseded generation is recorded, never applied to the new one.
    const late = await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    expect(late).toMatchObject({ kind: 'skip', code: 'generation_changed' });
    expect(state(env).current.receipts).toEqual([]);
  });
});

describe('root guard (A6 allow-list)', () => {
  const orchestrate = async (): Promise<Env> => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev({ execution: 'orchestrated' }));
    return env;
  };

  it('passes allowed tools with no output and denies the rest with the fixed reason', async () => {
    const env = await orchestrate();
    for (const tool of ['Read', 'Grep', 'TodoWrite', 'TaskCreate']) {
      expect(await run(env, preEvent(tool, {})), tool).toMatchObject({ kind: 'skip', code: null, stdout: null });
    }
    for (const tool of ['Bash', 'Edit', 'Write', 'Skill', 'mcp__unknown__write']) {
      const r = await run(env, preEvent(tool, {}));
      expect(r.kind, tool).toBe('deny');
      expect(hookOutput(r)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: GUARD_DENY_REASON });
    }
    const other = await run(env, preEvent('Agent', { subagent_type: 'Explore', prompt: 'x' }));
    expect(other.kind).toBe('deny');
  });

  it('adds continue:false once the denial budget of one prompt is spent', async () => {
    const env = await orchestrate();
    for (let i = 1; i < DENIALS_BEFORE_STOP; i += 1) {
      const denial = await run(env, preEvent('Bash', { command: 'ls' }));
      expect(parse(denial.stdout as string)).not.toHaveProperty('continue');
    }
    const last = await run(env, preEvent('Bash', { command: 'ls' }));
    expect(parse(last.stdout as string)).toMatchObject({ continue: false, stopReason: STOP_REASON });
    expect(state(env).current.denials).toBe(DENIALS_BEFORE_STOP);
  });

  it('never guards a child caller, a direct job or a session without state', async () => {
    const env = await orchestrate();
    expect(await run(env, preEvent('Bash', {}, { agent_id: 'child' }))).toMatchObject({ kind: 'skip', code: 'child_caller' });
    const direct = makeEnv();
    await run(direct, promptEvent(), fakeJev({ execution: 'direct' }));
    expect(await run(direct, preEvent('Bash', {}))).toMatchObject({ kind: 'skip', code: 'shape_direct' });
    expect(await run(makeEnv(), preEvent('Bash', {}))).toMatchObject({ kind: 'skip', code: 'no_state' });
  });
});

describe('planner dispatch', () => {
  it('patches the configured default tier and upgrades to frontier on a confident answer', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev());
    const deep = await run(env, plannerPre(), fakeJev({ planning_tier: 'deep' }));
    expect(updatedInput(deep)).toMatchObject({ subagent_type: 'jev-gate:planner', model: 'opus' });
    expect(state(env).current).toMatchObject({ phase: 'planning', planner_tier: 'deep' });

    const frontierEnv = makeEnv();
    await run(frontierEnv, promptEvent(), fakeJev());
    const frontier = await run(frontierEnv, plannerPre(), fakeJev({ planning_tier: 'frontier' }));
    expect(updatedInput(frontier)).toMatchObject({ subagent_type: 'jev-gate:planner-frontier', model: 'fable' });

    const cfg = join(tmp, 'frontier-default.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', plannerDefaultTier: 'frontier' }));
    const defaulted = makeEnv({ JEV_GATE_CONFIG: cfg });
    await run(defaulted, promptEvent(), fakeJev());
    const abstained = await run(defaulted, plannerPre(), fakeJev({ planning_tier: 'abstain' }));
    expect(updatedInput(abstained)).toMatchObject({ subagent_type: 'jev-gate:planner-frontier', model: 'fable' });
    expect(abstained.code).toBe('route_abstain');
  });

  it('denies a planner pinned outside the configured strong models and keeps a valid pin untouched', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev());
    const conflict = await run(env, plannerPre({ model: 'haiku' }), fakeJev());
    expect(conflict).toMatchObject({ kind: 'deny', code: 'planner_pin_conflict' });
    expect(String(hookOutput(conflict)['permissionDecisionReason'])).toContain('strong planning models');
    const pinned = await run(env, plannerPre({ model: 'fable' }), fakeJev());
    expect(pinned).toMatchObject({ kind: 'preserve', code: 'pinned', stdout: null });
    expect(state(env).current.active['toolu_plan']).toMatchObject({ role: 'planner' });
  });

  it('denies a replan while workers are active and stops after the bounds are used up', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    expect(await run(env, plannerPre(), fetchImpl)).toMatchObject({ kind: 'deny', code: 'workers_active' });
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    await run(env, plannerPre(), fetchImpl);
    await run(env, plannerPost(PLAN_REPLY));
    await run(env, plannerPre(), fetchImpl);
    await run(env, plannerPost(PLAN_REPLY));
    expect(await run(env, plannerPre(), fetchImpl)).toMatchObject({ kind: 'deny', code: 'bounds_exhausted' });
  });

  it('stores a ready plan with contract hashes and reports the ready ids', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev());
    await run(env, plannerPre(), fakeJev());
    const r = await run(env, plannerPost(PLAN_REPLY));
    expect(r.kind).toBe('context');
    expect(context(r)).toContain('Ready task ids: t1, t2');
    const current = state(env).current;
    expect(current).toMatchObject({ phase: 'planned', plan: { rev: 1 }, active: {} });
    expect(current.plan?.tasks[0]?.contract_hash).toBe(contractHash(PLAN_TASKS[0] as Omit<PlannedTask, 'contract_hash'>));
  });

  it('returns to admitted once on a blocked plan and blocks the job on the second failure', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev());
    await run(env, plannerPre(), fakeJev());
    const first = await run(env, plannerPost({ status: 'blocked', reason: 'the repository has no store', findings: [] }));
    expect(context(first)).toContain('planner returned blocked');
    expect(state(env).current).toMatchObject({ phase: 'admitted', attempts: { planner: 1, replans: 0 } });
    await run(env, plannerPre(), fakeJev());
    const second = await run(env, plannerPost('not json at all'));
    expect(context(second)).toContain('No planner attempts remain');
    expect(state(env).current).toMatchObject({ phase: 'blocked', attempts: { planner: 2, replans: 0 } });
    expect(await run(env, plannerPre(), fakeJev())).toMatchObject({ kind: 'deny', code: 'bounds_exhausted' });
  });

  it('counts planning attempts and replans separately, so replanning never spends an initial planning attempt', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    expect(state(env).current.attempts).toMatchObject({ planner: 1, replans: 0 });
    for (const attempt of [1, 2]) {
      await run(env, plannerPre(), fetchImpl);
      await run(env, plannerPost({ status: 'blocked', reason: 'no change after all', findings: [] }));
      expect(state(env).current).toMatchObject({ phase: 'planned', attempts: { planner: 1, replans: attempt } });
    }
    // The replan bound is used up while the planning bound still shows a single attempt.
    expect(await run(env, plannerPre(), fetchImpl)).toMatchObject({ kind: 'deny', code: 'bounds_exhausted' });
    expect(state(env).current).toMatchObject({ phase: 'planned', plan: { rev: 1 }, attempts: { planner: 1, replans: 2 } });
  });

  it('leaves the phase unchanged and releases the reservation when the planner does not complete', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev());
    await run(env, plannerPre(), fakeJev());
    const r = await run(env, plannerPost(PLAN_REPLY, { tool_response: { status: 'error', content: [] } }));
    expect(r).toMatchObject({ kind: 'skip' });
    expect(state(env).current).toMatchObject({ phase: 'planning', active: {} });
  });
});

describe('worker dispatch', () => {
  it('composes the contract, patches the tier and keeps the original prompt as an exact prefix', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev({ route: 'deep', basis: 'unresolved_contract_reasoning' });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    const original = agentInput().prompt as string;
    const r = await run(env, preEvent('Agent', agentInput({ extra: { keep: true } })), fetchImpl);
    expect(r.kind).toBe('patch');
    const patched = updatedInput(r);
    expect(patched).toMatchObject({ subagent_type: 'jev-gate:worker-deep', model: 'opus', description: 'implement the store', run_in_background: false, extra: { keep: true } });
    const prompt = String(patched['prompt']);
    expect(prompt.startsWith(original)).toBe(true);
    expect(prompt).toContain('[Jev Gate task contract]');
    expect(prompt).toContain('Global constraints: ["keep the public API"]');
    expect(prompt).toContain('[Jev Gate route note] Tier: deep');
    expect(state(env).current.active['toolu_1']).toMatchObject({ role: 'worker', task_id: 't1', rev: 1, deliverables: ['src/t1.ts'] });
  });

  it('preserves the called profile when Jev abstains but still appends the contract', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev({ route: 'abstain' });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    const r = await run(env, preEvent('Agent', agentInput({ subagent_type: 'jev-gate:worker-deep' })), fetchImpl);
    expect(r.code).toBe('route_abstain');
    expect(updatedInput(r)).not.toHaveProperty('model');
    expect(updatedInput(r)['subagent_type']).toBe('jev-gate:worker-deep');
    expect(String(updatedInput(r)['prompt'])).toContain('[Jev Gate task contract]');
  });

  it('appends the contract without a model for a pinned worker and on an HTTP failure', async () => {
    const env = makeEnv();
    await seedPlanned(env, PLAN_REPLY, fakeJev());
    const pinned = await run(env, preEvent('Agent', agentInput({ model: 'haiku' })), fakeJev());
    expect(pinned).toMatchObject({ kind: 'patch', code: 'pinned' });
    expect(updatedInput(pinned)).toMatchObject({ model: 'haiku', subagent_type: 'jev-gate:worker' });
    expect(String(updatedInput(pinned)['prompt'])).toContain('[Jev Gate task contract]');
    const failing = vi.fn(async () => new Response('{}', { status: 429 }));
    const failed = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), failing);
    expect(failed).toMatchObject({ kind: 'patch', code: 'http_429' });
    expect(String(updatedInput(failed)['prompt'])).toContain('[Jev Gate task contract]');
    expect(updatedInput(failed)).not.toHaveProperty('model');
  });

  it.each([
    ['no marker', { prompt: 'Implement the store.' }, 'no_marker'],
    ['an unknown id', { prompt: '[JEV_TASK rev=1 id=ghost]\nwork' }, 'unknown_task'],
    ['a stale revision', { prompt: '[JEV_TASK rev=0 id=t1]\nwork' }, 'stale_rev'],
    ['incomplete dependencies', { prompt: '[JEV_TASK rev=1 id=t3]\nwork' }, 'deps_incomplete'],
  ])('denies %s', async (_name, over, code) => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    const before = fetchImpl.mock.calls.length;
    const r = await run(env, preEvent('Agent', agentInput(over)), fetchImpl);
    expect(r).toMatchObject({ kind: 'deny', code });
    expect(fetchImpl.mock.calls.length).toBe(before);
  });

  it('denies a duplicate dispatch, an accepted task, an overlapping deliverable and a full parallel cap', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    expect(await run(env, preEvent('Agent', agentInput(), { tool_use_id: 'toolu_dup' }), fetchImpl)).toMatchObject({ kind: 'deny', code: 'task_active' });
    // A second ready task with disjoint deliverables runs in parallel with the first.
    const disjoint = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_x' }), fetchImpl);
    expect(disjoint.kind).toBe('patch');
    expect(Object.keys(state(env).current.active).sort()).toEqual(['toolu_1', 'toolu_x']);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    expect(await run(env, preEvent('Agent', agentInput(), { tool_use_id: 'toolu_again' }), fetchImpl)).toMatchObject({ kind: 'deny', code: 'task_accepted' });
    const rework = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_rework' }), fetchImpl);
    expect(rework.kind).toBe('patch');
  });

  it('denies an overlapping deliverable and a full parallel cap', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    const tasks = [rawTask('t1', { deliverables: ['src/shared.ts'] }), rawTask('t2', { deliverables: ['src/shared.ts'] }), rawTask('t4'), rawTask('t5')];
    await seedPlanned(env, { ...PLAN_REPLY, tasks }, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const overlap = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(overlap).toMatchObject({ kind: 'deny', code: 'deliverable_overlap' });
    const cfg = join(tmp, 'cap1.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', maxParallelWorkers: 1 }));
    const capped = makeEnv({ JEV_GATE_CONFIG: cfg });
    await seedPlanned(capped, { ...PLAN_REPLY, tasks }, fetchImpl);
    await run(capped, preEvent('Agent', agentInput()), fetchImpl);
    const second = await run(capped, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t4]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(second).toMatchObject({ kind: 'deny', code: 'parallel_cap' });
  });

  it('denies a composed prompt over the byte bound instead of dropping constraints', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, { ...PLAN_REPLY, tasks: [rawTask('t1', { context: 'z'.repeat(8 * 1024) })] }, fetchImpl);
    const r = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1]\n' + 'y'.repeat(60 * 1024) })), fetchImpl);
    expect(r).toMatchObject({ kind: 'deny', code: 'composed_too_large' });
  });

  it('denies an owned call that cannot be validated as a dispatch instead of waving it through', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    const before = fetchImpl.mock.calls.length;
    for (const over of [{ run_in_background: true }, { resume: 'agent-1' }, { prompt: '  ' }]) {
      const r = await run(env, preEvent('Agent', agentInput(over)), fetchImpl);
      expect(r, JSON.stringify(over)).toMatchObject({ kind: 'deny', code: 'dispatch_ineligible' });
      expect(String(hookOutput(r)['permissionDecisionReason'])).toContain('foreground call');
    }
    expect(fetchImpl.mock.calls.length).toBe(before);
    expect(state(env).current.active).toEqual({});
  });

  it('re-runs the conflict checks under the lock, so two dispatches on one snapshot cannot both reserve', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    // Both calls read the same pre-lock state; the second must lose inside updateJob, not on the stale read.
    const stale = state(env).current;
    expect(stale.active).toEqual({});
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const second = await run(env, preEvent('Agent', agentInput(), { tool_use_id: 'toolu_second' }), fetchImpl);
    expect(second).toMatchObject({ kind: 'deny', code: 'task_active' });
    expect(Object.keys(state(env).current.active)).toEqual(['toolu_1']);
  });

  it('counts the route note against the composed byte bound', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    const plan = state(env).current.plan;
    const task = plan?.tasks.find((t) => t.id === 't1');
    if (!plan || !task) throw new Error('no planned task');
    const head = '[JEV_TASK rev=1 id=t1]\nx';
    const overhead = Buffer.byteLength(composeTaskPrompt(head, task, plan.constraints, []), 'utf8');
    // Sized so the contract alone fits with 10 bytes to spare and only the route note pushes it over.
    const prompt = head + 'y'.repeat(MAX_COMPOSED_BYTES - overhead - 10);
    expect(Buffer.byteLength(composeTaskPrompt(prompt, task, plan.constraints, []), 'utf8')).toBeLessThan(MAX_COMPOSED_BYTES);
    const r = await run(env, preEvent('Agent', agentInput({ prompt })), fetchImpl);
    expect(r).toMatchObject({ kind: 'deny', code: 'composed_too_large' });
  });

  it('denies a worker while the plan is not ready and stops after two attempts on the same task', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await run(env, promptEvent(), fetchImpl);
    expect(await run(env, preEvent('Agent', agentInput()), fetchImpl)).toMatchObject({ kind: 'deny', code: 'phase_not_planned' });
    await run(env, plannerPre(), fetchImpl);
    await run(env, plannerPost(PLAN_REPLY));
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply({ status: 'blocked' })), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    await run(env, workerPost('toolu_2', workerReply({ status: 'blocked' })), fetchImpl);
    const third = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=3]\nredo' }), { tool_use_id: 'toolu_3' }), fetchImpl);
    expect(third).toMatchObject({ kind: 'deny', code: 'bounds_exhausted' });
  });

  it('preserves the call when a new prompt replaced the generation during the Gate B call', async () => {
    const env = makeEnv();
    await seedPlanned(env, PLAN_REPLY, fakeJev());
    // A new user prompt lands while the allocation call is in flight; the patch must be dropped, not applied late.
    const racing = fakeJev({
      onCall: (questions) => {
        if (questions.includes('route')) updateJob(env, 's1', (prev) => newGeneration(prev, 's1', 'p2', 'orchestrated').state);
      },
    });
    expect(await run(env, preEvent('Agent', agentInput()), racing)).toMatchObject({ kind: 'preserve', code: 'generation_changed' });
  });
});

describe('receipts and Gate C', () => {
  it('binds the receipt to the tool_use_id with the observed model and root effort, then unlocks dependents', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    const first = await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    expect(context(first)).toContain('Task t1 accepted');
    expect(context(first)).toContain('Ready task ids: none');
    expect(state(env).current.active['toolu_2']).toMatchObject({ task_id: 't2' });
    const receipt = state(env).current.receipts[0];
    expect(receipt).toMatchObject({ task_id: 't1', tool_use_id: 'toolu_1', verdict: 'accept', observed_model: 'claude-sonnet-5', root_effort: 'high', provenance: 'worker_reported' });
    const second = await run(env, workerPost('toolu_2', workerReply({ changed_files: ['src/t2.ts'] })), fetchImpl);
    expect(context(second)).toContain('Ready task ids: t3');
    expect(state(env).current.active).toEqual({});
  });

  it('keeps an incomplete receipt from unlocking dependents', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const r = await run(env, workerPost('toolu_1', workerReply({ checks: [{ check_id: 'c1', result: 'fail', note: '' }] })), fetchImpl);
    expect(context(r)).toContain('Task t1 is incomplete');
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'incomplete' });
    expect(await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t3]\nwork' }), { tool_use_id: 'toolu_3' }), fetchImpl)).toMatchObject({ code: 'deps_incomplete' });
  });

  it('records an invalid reply and an incomplete call without accepting either', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const invalid = await run(env, workerPost('toolu_1', 'no json here', { tool_response: { status: 'completed', content: [{ type: 'text', text: 'all done, trust me' }] } }));
    expect(context(invalid)).toContain('no valid WorkerReply');
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'invalid' });
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    const unknown = await run(env, workerPost('toolu_2', workerReply(), { tool_response: { status: 'cancelled', content: [] } }));
    expect(context(unknown)).toContain('did not complete');
    expect(state(env).current.receipts.some((r) => r.verdict === 'unknown')).toBe(true);
  });

  it('asks Gate C only on a deterministic accept and records the advisory without changing readiness', async () => {
    const env = makeEnv();
    const questionSets: string[][] = [];
    const fetchImpl = fakeJev({ result: 'rework', onCall: (q) => questionSets.push(q) });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const accepted = await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    expect(questionSets.some((q) => q.includes('result'))).toBe(true);
    expect(context(accepted)).toContain('Task t1 accepted');
    expect(context(accepted)).toContain('Advisory (does not change readiness): rework');
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'accept', advisory: 'rework' });

    const noGate = makeEnv();
    const sets: string[][] = [];
    const fetch2 = fakeJev({ onCall: (q) => sets.push(q) });
    await seedPlanned(noGate, PLAN_REPLY, fetch2);
    await run(noGate, preEvent('Agent', agentInput()), fetch2);
    await run(noGate, workerPost('toolu_1', workerReply({ status: 'blocked' })), fetch2);
    expect(sets.some((q) => q.includes('result'))).toBe(false);
  });

  it('releases the reservation and records an unknown receipt when the call fails', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const r = await run(env, { ...workerPost('toolu_1', workerReply()), hook_event_name: 'PostToolUseFailure', error: 'Agent terminated early\nsecond line' });
    expect(r).toMatchObject({ kind: 'skip' });
    expect(state(env).current.active).toEqual({});
    expect(state(env).current.receipts[0]).toMatchObject({ task_id: 't1', verdict: 'unknown' });
  });
});

describe('replan (A3)', () => {
  it('carries an accepted receipt forward for an identical contract and resets a changed task with its dependents', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    expect(state(env).current.receipts).toHaveLength(1);

    await run(env, plannerPre(), fetchImpl);
    const same = await run(env, plannerPost(PLAN_REPLY));
    expect(context(same)).toContain('Revision 2');
    expect(state(env).current.receipts).toHaveLength(1);

    await run(env, plannerPre(), fetchImpl);
    const changed = [rawTask('t1', { outcome: 'deliver t1 differently' }), rawTask('t2'), rawTask('t3', { depends_on: ['t1', 't2'] })];
    const after = await run(env, plannerPost({ ...PLAN_REPLY, tasks: changed }));
    expect(context(after)).toContain('Revision 3');
    const reset = state(env);
    expect(reset.current.receipts).toHaveLength(0);
    // A3: a reset receipt is moved to history, never deleted.
    expect(reset.history[0]?.receipts).toMatchObject([{ task_id: 't1', verdict: 'accept' }]);
    expect(reset.history[0]?.outcome).toBe('superseded');
  });
});

describe('replan failures (A7)', () => {
  it('keeps the current plan in force when a replan fails, and still counts the attempt', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    await run(env, plannerPre(), fetchImpl);
    const failed = await run(env, plannerPost({ status: 'blocked', reason: 'the interface did not change after all', findings: [] }));
    expect(context(failed)).toContain('plan revision 1 stays in force');
    const current = state(env).current;
    expect(current).toMatchObject({ phase: 'planned', plan: { rev: 1 } });
    expect(current.attempts.replans).toBe(1);
    expect(current.receipts).toHaveLength(1);
    // Pending work is not stalled by the failed replan.
    const dispatch = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(dispatch.kind).toBe('patch');
  });
});

describe('native mode', () => {
  it('makes no request, composes prompt-only and lets the coordinator start orchestration', async () => {
    const env = makeEnv({ JEV_GATE_MODE: 'native' });
    const fetchImpl = fakeJev();
    const guidance = await run(env, promptEvent(), fetchImpl);
    expect(context(guidance)).toContain('you decide whether this request needs planning');
    expect(state(env).current.shape).toBe('direct');
    const planner = await run(env, plannerPre(), fetchImpl);
    expect(planner).toMatchObject({ kind: 'preserve', code: 'mode_native' });
    expect(state(env).current).toMatchObject({ shape: 'orchestrated', phase: 'planning' });
    await run(env, plannerPost(PLAN_REPLY));
    const worker = await run(env, preEvent('Agent', agentInput()), fetchImpl);
    expect(worker).toMatchObject({ kind: 'patch', code: 'mode_native' });
    expect(updatedInput(worker)).not.toHaveProperty('model');
    expect(updatedInput(worker)['subagent_type']).toBe('jev-gate:worker');
    expect(String(updatedInput(worker)['prompt'])).toContain('[Jev Gate task contract]');
    const post = await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    expect(context(post)).toContain('Task t1 accepted');
    expect(await run(env, preEvent('Bash', {}), fetchImpl)).toMatchObject({ kind: 'deny' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('initializes the orchestrated arm from the experiment variable with no request', async () => {
    const env = makeEnv({ JEV_GATE_MODE: 'native', JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' });
    const fetchImpl = fakeJev();
    const r = await run(env, promptEvent(), fetchImpl);
    expect(context(r)).toContain('You decide whether to start planning');
    expect(context(r)).toContain('[JEV_TASK rev=<n> id=<id>]');
    expect(state(env).current.shape).toBe('orchestrated');
    expect(await run(env, preEvent('Edit', {}), fetchImpl)).toMatchObject({ kind: 'deny', code: 'guard_denied' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Stop', () => {
  it('records completed, incomplete and blocked outcomes without output', async () => {
    const done = makeEnv();
    const fetchImpl = fakeJev();
    await run(done, promptEvent(), fakeJev({ execution: 'direct' }));
    expect(await run(done, { hook_event_name: 'Stop', session_id: 's1' })).toMatchObject({ kind: 'skip', stdout: null });
    expect(state(done).current.outcome).toBe('completed');

    const partial = makeEnv();
    await seedPlanned(partial, PLAN_REPLY, fetchImpl);
    await run(partial, { hook_event_name: 'Stop', session_id: 's1' });
    expect(state(partial).current.outcome).toBe('incomplete');

    const blocked = makeEnv();
    await run(blocked, promptEvent(), fetchImpl);
    await run(blocked, plannerPre(), fetchImpl);
    await run(blocked, plannerPost({ status: 'blocked', reason: 'x', findings: [] }));
    await run(blocked, plannerPre(), fetchImpl);
    await run(blocked, plannerPost({ status: 'blocked', reason: 'x', findings: [] }));
    await run(blocked, { hook_event_name: 'Stop', session_id: 's1' });
    expect(state(blocked).current.outcome).toBe('blocked');
  });
});

describe('traces', () => {
  it('records both gate phases, the guard and the plan without the prompt or the key', async () => {
    const dir = join(tmp, 'trace-full');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Bash', { command: 'ls' }), fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    const phases = readdirSync(dir).map((f) => f.split('-')[0]);
    for (const phase of ['admission', 'guard', 'pre', 'plan', 'post', 'result']) expect(phases.join(' '), phase).toContain(phase);
    // JG5-06: every attempted gate records the decision it applied, so accounting never re-derives policy.
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    const attempted = (phase: string, role?: string): Record<string, unknown> | undefined =>
      records.find((r) => r['phase'] === phase && r['attempted'] === true && (role === undefined || r['role'] === role));
    expect(attempted('admission_result')).toMatchObject({ decision: 'orchestrated', decided: true, reason: null, forced: false });
    expect(attempted('pre_result', 'planner')).toMatchObject({ decision: { action: 'patch', tier: 'deep', reason: null } });
    expect(attempted('pre_result', 'worker')).toMatchObject({ decision: { action: 'patch', tier: 'standard', reason: null } });
    expect(attempted('result_result')).toMatchObject({ decision: { verdict: 'accept', reason: null, advisory_only: true } });
    const all = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('settings page');
    expect(all).toContain('"version": 5');
  });

  it('blocks the request when the intent record cannot be written', async () => {
    const file = join(tmp, 'not-a-dir');
    writeFileSync(file, 'x');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: join(file, 'sub') });
    const fetchImpl = fakeJev();
    const r = await run(env, promptEvent(), fetchImpl);
    expect(r.code).toBe('trace_intent_failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('dist/hook.js (process)', () => {
  let dist: string;
  let hookPath: string;
  beforeAll(() => {
    dist = mkdtempSync(join(tmp, 'plugin dir '));
    const out = join(dist, 'dist');
    const r = spawnSync(process.execPath, [join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(__dirname, '..', 'tsconfig.json'), '--outDir', out], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    hookPath = join(out, 'hook.js');
    cpSync(join(__dirname, '..', 'hooks'), join(dist, 'hooks'), { recursive: true });
  }, 60_000);

  const exec = (stdin: unknown, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } => {
    const stateDir = mkdtempSync(join(tmp, 'proc-state-'));
    const r = spawnSync(process.execPath, [hookPath], {
      input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home'), JEV_GATE_STATE_DIR: stateDir, ...env },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('always exits 0 and writes at most one JSON object plus one fixed code', () => {
    const guidance = exec(promptEvent(), { JEV_GATE_MODE: 'auto' });
    expect(guidance.status).toBe(0);
    expect(guidance.stdout.trim().split('\n')).toHaveLength(1);
    expect(guidance.stderr).toBe('jev-gate: key_missing\n');
    expect(exec(preEvent('Agent', agentInput()), {})).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: mode_off\n' });
    expect(exec('{not json', { JEV_GATE_MODE: 'auto' })).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: stdin_invalid_json\n' });
    const big = exec('{"hook_event_name":"PreToolUse","prompt":"' + 'y'.repeat(300 * 1024) + '"}', { JEV_GATE_MODE: 'auto' });
    expect(big).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: stdin_too_large\n' });
  });

  it('registers one command per event, PreToolUse without a matcher and Stop present', () => {
    const hooks = JSON.parse(readFileSync(join(dist, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    };
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
      expect(hooks.hooks[event], event).toHaveLength(1);
      expect(hooks.hooks[event]![0]!.hooks).toEqual([{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"', timeout: 5 }]);
    }
    expect(hooks.hooks['PreToolUse']![0]!.matcher).toBeUndefined();
    expect(hooks.hooks['Stop']![0]!.matcher).toBeUndefined();
    expect(hooks.hooks['PostToolUse']![0]!.matcher).toBe('^Agent$');
    const resolved = hooks.hooks['PreToolUse']![0]!.hooks[0]!.command.replace('${CLAUDE_PLUGIN_ROOT}', dist);
    const r = spawnSync(resolved, {
      shell: true,
      input: JSON.stringify(preEvent('Agent', agentInput())),
      encoding: 'utf8',
      cwd: tmpdir(),
      env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home'), JEV_GATE_STATE_DIR: mkdtempSync(join(tmp, 'proc-state-')), JEV_GATE_MODE: 'auto' },
    });
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: key_missing\n' });
  });
});

describe('sources', () => {
  it('the host-neutral core names no host tool, and no module spawns processes or reads credentials', () => {
    for (const f of ['hook.ts', 'jev.ts', 'brief.ts', 'config.ts', 'coordinator.ts', 'trace.ts', 'admission.ts', 'allocation.ts', 'plan.ts', 'job.ts']) {
      const src = readFileSync(join(__dirname, '..', 'src', f), 'utf8');
      expect(src, f).not.toMatch(/child_process|execSync|spawn\(/);
      expect(src, f).not.toMatch(/\.credentials|keychain|transcript_path/);
    }
    for (const f of ['jev.ts', 'admission.ts', 'allocation.ts', 'plan.ts', 'job.ts', 'trace.ts']) {
      const src = readFileSync(join(__dirname, '..', 'src', f), 'utf8');
      expect(src, f).not.toMatch(/subagent_type|jev-gate:worker|jev-gate:planner|Claude|claude/);
    }
  });

  it('keeps every agent definition in step with OWNED_AGENTS', () => {
    const files = readdirSync(join(__dirname, '..', 'agents')).filter((f) => f.endsWith('.md'));
    expect(files.sort()).toEqual(['planner-frontier.md', 'planner.md', 'worker-deep.md', 'worker-fast.md', 'worker-frontier.md', 'worker.md']);
    const workerBodies = new Set<string>();
    for (const f of files) {
      const text = readFileSync(join(__dirname, '..', 'agents', f), 'utf8');
      const body = text.slice(text.indexOf('\n---', 4) + 4);
      expect(text, f).toContain('disallowedTools: Agent, SendMessage');
      expect(text, f).toContain('background: false');
      if (f.startsWith('worker')) workerBodies.add(body);
      expect(body.match(/```json\n/g), f).toHaveLength(1);
    }
    expect(workerBodies.size).toBe(1);
  });
});

describe('state recovery', () => {
  it('keeps the guard on, denies workers and lets a planner recover from corrupt state', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev());
    mkdirSync(join(String(env['JEV_GATE_STATE_DIR']), 'jev-gate', 'jobs'), { recursive: true });
    writeFileSync(jobPath(env, 's1'), '{"version":5,"session_id":"s1","curren');
    expect(await run(env, preEvent('Bash', {}), fakeJev())).toMatchObject({ kind: 'deny', code: 'guard_denied' });
    expect(await run(env, preEvent('Agent', agentInput()), fakeJev())).toMatchObject({ kind: 'deny', code: 'phase_not_planned' });
    const planner = await run(env, plannerPre(), fakeJev());
    expect(planner.kind).toBe('patch');
    expect(state(env).current).toMatchObject({ shape: 'orchestrated', phase: 'planning' });
  });

  it('keeps the guard on for an unreadable state file of any kind', async () => {
    const env = makeEnv();
    mkdirSync(join(String(env['JEV_GATE_STATE_DIR']), 'jev-gate', 'jobs'), { recursive: true });
    const real = join(tmp, `symlink-target-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(real, '{}');
    symlinkSync(real, jobPath(env, 's1'));
    expect(await run(env, preEvent('Bash', {}), fakeJev())).toMatchObject({ kind: 'deny', code: 'guard_denied' });
  });

  it('never guards a recovered generation that has no prompt identity (A2)', async () => {
    const env = makeEnv();
    mkdirSync(join(String(env['JEV_GATE_STATE_DIR']), 'jev-gate', 'jobs'), { recursive: true });
    writeFileSync(jobPath(env, 's1'), '{"version":5,"session_id":"s1","curren');
    const noPrompt = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: {} };
    expect(await run(env, noPrompt, fakeJev())).toMatchObject({ kind: 'skip' });
    const planner = await run(env, { ...plannerPre(), prompt_id: undefined }, fakeJev());
    expect(planner.kind).toBe('patch');
    expect(state(env).current).toMatchObject({ prompt_id: null, shape: 'direct' });
  });
});

describe('host-observed input shapes', () => {
  it('reads the object-shaped effort the host actually sends, so the receipt records a root effort', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply(), { effort: { level: 'xhigh' } }), fetchImpl);
    expect(state(env).current.receipts[0]).toMatchObject({ task_id: 't1', root_effort: 'xhigh' });
  });
});
