import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GUARD_DENY_REASON, STOP_REASON } from '../src/coordinator.js';
import { DENIALS_BEFORE_STOP } from '../src/brief.js';
import { runHook, type HookDeps, type HookResult } from '../src/hook.js';
import { CLAUSE_VERDICTS, MAX_INTERPRETATION_CLAUSES } from '../src/interpretation.js';
import { jobPath, newGeneration, readJob, updateJob } from '../src/job.js';
import { chainDepth, composeTaskPrompt, contractHash, MAX_COMPOSED_BYTES } from '../src/plan.js';
import { ADMISSION_ANSWERS, PLANNER_ROUTE_ANSWERS, ROUTE_ANSWERS, UPGRADE_BASES, type JobState, type PlannedTask, type WorkerReply } from '../src/types.js';

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
  forbidsDelegation?: number;
  answerOnly?: number;
  size?: number;
  route?: string;
  basis?: string;
  planning_tier?: string;
  onCall?: (questions: string[], state: Record<string, unknown>) => void;
}

const fakeJev = (opts: FakeAnswers = {}): ReturnType<typeof vi.fn> =>
  vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown>; state: Record<string, unknown> };
    const questions = Object.keys(body.questions);
    opts.onCall?.(questions, body.state);
    const answers: Record<string, unknown> = {};
    if (questions.includes('execution')) answers['execution'] = choice(ADMISSION_ANSWERS, opts.execution ?? 'orchestrated');
    // Gate A is atomic by default since 2026-09-19, so the double answers its read-offs the way an admitted job reads.
    if (questions.includes('forbids_delegation')) {
      answers['forbids_delegation'] = { type: 'noul', noul: opts.forbidsDelegation ?? 0.05 };
      answers['answer_only'] = { type: 'noul', noul: opts.answerOnly ?? 0.05 };
      answers['size'] = { type: 'score', score: opts.size ?? 3, confidence: 0.9 };
    }
    if (questions.includes('route')) answers['route'] = choice(ROUTE_ANSWERS, opts.route ?? 'standard');
    if (questions.includes('upgrade_basis')) answers['upgrade_basis'] = choice(UPGRADE_BASES, opts.basis ?? 'no_specific_basis');
    if (questions.includes('planning_tier')) answers['planning_tier'] = choice(PLANNER_ROUTE_ANSWERS, opts.planning_tier ?? 'deep');
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  });

/** A Jev double that answers Gate A and then fails Gate B, so a dispatch reaches the preserve paths with a reason. */
const jevFailingRoute = (): ReturnType<typeof vi.fn> => {
  const answering = fakeJev({ execution: 'orchestrated' });
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    if ('route' in body.questions) return new Response('upstream is down', { status: 500 });
    return await (answering as unknown as typeof fetch)(url, init);
  });
};

const stdinOf = (value: unknown): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  })();

type Env = Record<string, string | undefined>;
const makeEnv = (over: Env = {}): Env => ({ TYPESAFE_API_KEY: KEY, HOME: join(tmp, 'home'), JEV_GATE_MODE: 'auto', JEV_GATE_STATE_DIR: mkdtempSync(join(tmp, 'state-')), ...over });

/** Gate A ships atomic; the four-way choice is still supported and its own tests select it explicitly. */
let compositeSeq = 0;
const compositeGateAEnv = (over: Env = {}): Env => {
  const cfg = join(tmp, `composite-gate-a-${(compositeSeq += 1)}.json`);
  writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', admissionQuestionShape: 'composite' }));
  return makeEnv({ JEV_GATE_CONFIG: cfg, ...over });
};

/** T5: the default is one worker, so any test that needs concurrency has to raise the cap explicitly. */
let capSeq = 0;
const capEnv = (cap: number, over: Env = {}): Env => {
  const cfg = join(tmp, `cap-${cap}-${(capSeq += 1)}.json`);
  writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', maxParallelWorkers: cap }));
  return makeEnv({ JEV_GATE_CONFIG: cfg, ...over });
};

const run = (env: Env, event: unknown, fetchImpl?: unknown, extra: Partial<HookDeps> = {}): Promise<HookResult> =>
  runHook({ env, stdin: stdinOf(event), ...(fetchImpl ? { fetchImpl: fetchImpl as typeof fetch } : {}), ...extra });

const parse = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;
const hookOutput = (r: HookResult): Record<string, unknown> => (parse(r.stdout as string)['hookSpecificOutput'] ?? {}) as Record<string, unknown>;
const context = (r: HookResult): string => String(hookOutput(r)['additionalContext'] ?? '');
const updatedInput = (r: HookResult): Record<string, unknown> => hookOutput(r)['updatedInput'] as Record<string, unknown>;
const fence = (value: unknown): string => 'summary prose\n```json\n' + JSON.stringify(value) + '\n```';

/**
 * Gate A is asked only when the session is already deep (depth-gate decision 1), so every prompt event carries a
 * transcript whose last usage line is past the shipped floor. The sidechain line is deliberately enormous: a subagent's
 * context is not this session's, and reading it instead would admit jobs on a number that describes another turn.
 */
let transcriptSeq = 0;
const transcriptAt = (tokens: number): string => {
  const p = join(tmp, `transcript-${(transcriptSeq += 1)}.jsonl`);
  writeFileSync(
    p,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'an earlier turn' } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { cache_read_input_tokens: 9_000_000 } } }),
      JSON.stringify({ type: 'assistant', message: { usage: { cache_read_input_tokens: tokens - 1000, cache_creation_input_tokens: 600, input_tokens: 400 } } }),
      '',
    ].join('\n'),
  );
  return p;
};
const DEEP_TRANSCRIPT = transcriptAt(406_000);
/** A transcript the host wrote but that carries no usage yet: real at the very start of a session. */
const write_no_usage = (): string => {
  const p = join(tmp, `transcript-nousage-${(transcriptSeq += 1)}.jsonl`);
  writeFileSync(p, JSON.stringify({ type: 'user', message: { role: 'user', content: 'the first prompt' } }) + '\n');
  return p;
};

const promptEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: 's1',
  prompt_id: 'p1',
  cwd: '/w',
  transcript_path: DEEP_TRANSCRIPT,
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
  spec: { interfaces: ['createStore(): Store'], data_shapes: ['Store = { get(key: string): string | null }'], invariants: ['reads never throw'], files: ['src/store.ts'] },
  uncertainty: { unresolved: [], interacts_with: [], prior_failure: null },
  fully_specified: false,
  ...over,
});

const PLAN_TASKS = [rawTask('t1'), rawTask('t2'), rawTask('t3', { depends_on: ['t1', 't2'] })];
/** A17: a ready reply states its own chain depth, and the parser rejects a claim its graph does not support. */
const planReply = (tasks: Array<Omit<PlannedTask, 'contract_hash'>>): Record<string, unknown> => ({
  status: 'ready',
  goal: 'ship settings',
  assumptions: ['the store is local'],
  constraints: ['keep the public API'],
  tasks,
  chain_depth: chainDepth(tasks),
});
const PLAN_REPLY = planReply(PLAN_TASKS);

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
  ])('composite answer %s produces the direct shape', async (answer, shape, code) => {
    const env = compositeGateAEnv();
    const r = await run(env, promptEvent(), fakeJev({ execution: answer }));
    expect(r.code).toBe(code);
    expect(context(r)).toContain('Execution shape: direct');
    expect(state(env).current.shape).toBe(shape);
  });

  it('sends no request at all when the session is not yet deep enough to be worth delegating', async () => {
    const dir = join(tmp, 'trace-shallow');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    const r = await run(env, promptEvent({ transcript_path: transcriptAt(55_000) }), fetchImpl);
    // The saving is the whole point: at 55K the measured forced arm was +182%, so the cheapest gate is no gate.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.code).toBe('depth_below_floor');
    expect(context(r)).toContain('Execution shape: direct');
    expect(state(env).current.shape).toBe('direct');
    const record = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>).find((x) => x['phase'] === 'admission_result');
    expect(record).toMatchObject({ attempted: false, context_tokens: 55_000, depth_floor: 300_000, decision: { reason: 'depth_below_floor', changed_default: false } });
  });

  it.each([
    ['no transcript path', {}],
    ['a transcript that is not there', { transcript_path: join(tmp, 'gone.jsonl') }],
    ['a transcript with no usage line', { transcript_path: write_no_usage() }],
  ])('treats %s as too shallow rather than guessing', async (_name, over) => {
    const env = makeEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    const r = await run(env, { ...promptEvent(), transcript_path: undefined, ...over }, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.code).toBe('depth_unknown');
    expect(state(env).current.shape).toBe('direct');
  });

  it('carries the depth into the record of an admitted job, so a bench case can prove it primed the session', async () => {
    const dir = join(tmp, 'trace-deep');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    await run(env, promptEvent(), fakeJev({ execution: 'orchestrated' }));
    const record = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>).find((x) => x['phase'] === 'admission_result');
    expect(record).toMatchObject({ attempted: true, context_tokens: 406_000, depth_floor: 300_000, decision: { shape: 'orchestrated' } });
  });

  it('does not floor the forced arm: it is the only measurement of what orchestration costs when shallow', async () => {
    const env = makeEnv({ JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' });
    const fetchImpl = fakeJev();
    const r = await run(env, promptEvent({ transcript_path: transcriptAt(55_000) }), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(context(r)).toContain('Execution shape: orchestrated');
  });

  it('asks on every prompt when the floor is turned off', async () => {
    const cfg = join(tmp, 'floor-off.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', delegationDepthFloor: 0 }));
    const env = makeEnv({ JEV_GATE_CONFIG: cfg });
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, { ...promptEvent(), transcript_path: undefined }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks the atomic Gate A questions and admits on them when the shape is atomic', async () => {
    const cfg = join(tmp, 'gate-a-atomic.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', admissionQuestionShape: 'atomic' }));
    const env = makeEnv({ JEV_GATE_CONFIG: cfg });
    let asked: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      asked = Object.keys(body.questions);
      const answers: Record<string, unknown> = { size: { type: 'score', score: 3, confidence: 0.9 } };
      for (const k of ['forbids_delegation', 'answer_only', 'plan_only', 'parallel_outcomes']) answers[k] = { type: 'noul', noul: 0.05 };
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
    });
    const r = await run(env, promptEvent(), fetchImpl);
    expect(asked).toEqual(['forbids_delegation', 'answer_only', 'plan_only', 'parallel_outcomes', 'size']);
    expect(context(r)).toContain('Execution shape: orchestrated');
    expect(state(env).current.shape).toBe('orchestrated');
  });

  it('A21: records the shape the request asked for, and applies the configured one', async () => {
    const cfg = join(tmp, 'gate-a-recommend.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', admissionQuestionShape: 'atomic' }));
    const dir = join(tmp, 'trace-recommend');
    const env = makeEnv({ JEV_GATE_CONFIG: cfg, JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = vi.fn(async () => {
      const answers: Record<string, unknown> = { size: { type: 'score', score: 3, confidence: 0.9 } };
      for (const k of ['forbids_delegation', 'answer_only']) answers[k] = { type: 'noul', noul: 0.05 };
      // The request says, loudly, that it wants separate outcomes and only a plan.
      for (const k of ['plan_only', 'parallel_outcomes']) answers[k] = { type: 'noul', noul: 0.95 };
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
    });
    await run(env, promptEvent(), fetchImpl);
    const record = readdirSync(dir)
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
      .find((x) => x['phase'] === 'admission_result');
    expect(record?.['recommendation']).toEqual({ admitted_shape: 'hierarchy', plan_only: true, applied: false });
    // The generation keeps the configured shape. `execution` is set only where `admittedShape` is `single`, so the
    // default leaves it unset -- and a recommendation of `hierarchy` must not start writing it either. Following the
    // request's own words is what a measurement would have to justify; `applied: false` records that it was not.
    expect(state(env).current.execution).toBeUndefined();
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

/**
 * A19: the single-executor shape. The product does two things to an admitted turn at once -- it moves the work into a
 * fresh context and it splits the work -- and every cost figure in this repository confounds them. This shape does the
 * first and not the second, so a pre-registered run can attribute the saving instead of observing it.
 */
describe('single executor (A19)', () => {
  const singleEnv = (): Env => {
    const cfg = join(tmp, `single-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', admittedShape: 'single' }));
    return makeEnv({ JEV_GATE_CONFIG: cfg });
  };

  it('admits the turn, and tells the coordinator to dispatch it once rather than plan it', async () => {
    const env = singleEnv();
    const r = await run(env, promptEvent(), fakeJev({ execution: 'orchestrated' }));
    expect(r.kind).toBe('guidance');
    expect(context(r)).toContain('Execution shape: orchestrated');
    expect(context(r)).toContain('Dispatch this request once, whole, to jev-gate:worker');
    // None of the hierarchy machinery is offered, because none of it runs on this shape.
    expect(context(r)).not.toContain('[JEV_TASK rev=<n> id=<id>]');
    expect(context(r)).not.toContain('Planner first');
    expect(state(env).current).toMatchObject({ shape: 'orchestrated', execution: 'single', request: 'Build a settings page, migrate the store and wire the two together.' });
  });

  it('denies the planner, and says what to do instead', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    const denied = await run(env, plannerPre(), fetchImpl);
    expect(denied).toMatchObject({ kind: 'deny', code: 'single_shape' });
    expect(String(hookOutput(denied)['permissionDecisionReason'])).toContain('Dispatch the whole request once to jev-gate:worker');
    expect(state(env).current.plan).toBeNull();
  });

  it('dispatches one worker carrying the request itself, with no contract and no marker', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    const r = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    expect(r.kind).toBe('patch');
    const prompt = String(updatedInput(r)['prompt']);
    expect(prompt).toContain('Do what the request asks.');
    expect(prompt).toContain('[Jev Gate user request]');
    expect(prompt).toContain('Build a settings page, migrate the store and wire the two together.');
    expect(prompt).toContain('It is the task: there is no plan and no task contract for this dispatch.');
    expect(prompt).not.toContain('[Jev Gate task contract]');
    expect(prompt).toContain('[Jev Gate route note]');
    // The route note cannot point at a contract that does not exist.
    expect(prompt).not.toContain('The task contract above is authoritative');
  });

  it('keeps the root guard on, so the coordinator still cannot implement the job itself', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    const denied = await run(env, preEvent('Edit', { file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' }), fetchImpl);
    expect(denied).toMatchObject({ kind: 'deny', code: 'guard_denied' });
  });

  /**
   * A19 defect found in the stage 1 run: the shape dispatched a worker nobody had reserved, so a passing job recorded
   * no receipt, stayed `incomplete` at Stop, and its worker records read as orphans in the report. The work is the
   * same; only the bookkeeping was missing.
   */
  it('reserves its one dispatch, so the result has a reservation to land on', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    expect(state(env).current.active['toolu_1']).toMatchObject({ role: 'worker', task_id: 'single', rev: null, attempt: 1, deliverables: [] });
  });

  it('records the receipt as the worker\'s own report, and completes the job on it', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    const post = await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    // The accept is stated as reported rather than verified: this shape has no contract for code to check.
    expect(context(post)).toContain('recorded as reported rather than verified');
    expect(context(post)).not.toContain('Ready task ids');
    const gen = state(env).current;
    expect(gen.active).toEqual({});
    expect(gen.receipts).toHaveLength(1);
    // The contract hash is empty because there is no contract, and the checks the worker reported are kept unjudged.
    expect(gen.receipts[0]).toMatchObject({ task_id: 'single', contract_hash: '', verdict: 'accept', provenance: 'worker_reported' });
    expect(gen.receipts[0]?.reply?.checks).toEqual([{ check_id: 'c1', result: 'pass', note: 'npm test' }]);
    await run(env, { hook_event_name: 'Stop', session_id: 's1' });
    expect(state(env).current.outcome).toBe('completed');
  });

  it('does not complete the job when the one worker says it did not finish', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    const post = await run(env, workerPost('toolu_1', workerReply({ status: 'blocked', blockers: ['the store is missing'] })), fetchImpl);
    expect(context(post)).toContain('There is no replan path on this shape');
    expect(state(env).current.receipts[0]).toMatchObject({ task_id: 'single', verdict: 'incomplete' });
    await run(env, { hook_event_name: 'Stop', session_id: 's1' });
    expect(state(env).current.outcome).toBe('incomplete');
  });

  /**
   * A19 defect found in the depth-ladder run: one worker's 86.6 seconds and 43 tool calls were thrown away because a
   * check id it named itself contained a space. The id grammar belongs to a contract this shape does not have.
   */
  it("keeps a reply whose check ids the worker named itself, because there is no contract to name them", async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    const reply = workerReply({ checks: [{ check_id: 'empty array rejected', result: 'pass', note: 'node --test' }] });
    await run(env, workerPost('toolu_1', reply), fetchImpl);
    const receipt = state(env).current.receipts[0];
    expect(receipt).toMatchObject({ task_id: 'single', verdict: 'accept' });
    // The name is kept as the worker wrote it, so the record says which check ran.
    expect(receipt?.reply?.checks).toEqual([{ check_id: 'empty array rejected', result: 'pass', note: 'node --test' }]);
    await run(env, { hook_event_name: 'Stop', session_id: 's1' });
    expect(state(env).current.outcome).toBe('completed');
  });

  it('allows the second dispatch that repairs a discarded reply, and denies a third under the existing task bound', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    const first = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' }), { tool_use_id: 'toolu_1' }), fetchImpl);
    expect(first.kind).toBe('patch');
    await run(env, workerPost('toolu_1', 'no fenced json here at all'), fetchImpl);
    const second = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(second.kind).toBe('patch');
    expect(state(env).current.active['toolu_2']).toMatchObject({ task_id: 'single', attempt: 2 });
    await run(env, workerPost('toolu_2', 'still nothing parseable'), fetchImpl);
    const third = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' }), { tool_use_id: 'toolu_3' }), fetchImpl);
    expect(third).toMatchObject({ kind: 'deny', code: 'bounds_exhausted' });
    expect(String(hookOutput(third)['permissionDecisionReason'])).toContain('allowed attempts');
    expect(state(env).current.active['toolu_3']).toBeUndefined();
  });

  /**
   * A19 defect found in the 2026-09-20 review: every preserve reason on this path returned before the request was
   * composed in, while `renderSingleBrief` tells the coordinator the hook appends the request verbatim. A brief
   * written against that promise is not a statement of the work on its own, so a preserved dispatch sent a worker
   * off with the brief alone. One published cell ran this path and only passed because the coordinator happened to
   * restate the whole task itself.
   */
  it('carries the request on a preserved dispatch too, because the brief was written expecting it', async () => {
    const env = singleEnv();
    const fetchImpl = jevFailingRoute();
    await run(env, promptEvent(), fetchImpl);
    const r = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    expect(r).toMatchObject({ kind: 'patch', code: 'http_other' });
    const patched = updatedInput(r);
    // A preserve leaves the model alone. That is all it leaves alone: the task still has to reach the worker.
    expect(patched['model']).toBeUndefined();
    expect(patched['subagent_type']).toBe('jev-gate:worker');
    const prompt = String(patched['prompt']);
    expect(prompt).toContain('Do what the request asks.');
    expect(prompt).toContain('[Jev Gate user request]');
    expect(prompt).toContain('Build a settings page, migrate the store and wire the two together.');
    expect(prompt).toContain('It is the task: there is no plan and no task contract for this dispatch.');
  });

  /**
   * A4/T2 defect found in the same review: the hierarchy re-runs every dispatch conflict under the lock, and this
   * path ran none of them, so two Agent calls in one assistant message both reserved and both dispatched the job.
   */
  it('refuses a second dispatch while the first is still running, and counts no attempt for it', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    const first = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' }), { tool_use_id: 'toolu_1' }), fetchImpl);
    expect(first.kind).toBe('patch');
    const second = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(second).toMatchObject({ kind: 'deny', code: 'task_active' });
    expect(state(env).current.active['toolu_2']).toBeUndefined();
    // T2: deleting a reservation is bookkeeping, not a stopped process, so the denial costs the job no attempt.
    expect(state(env).current.attempts.tasks['single']).toBe(1);
  });

  /**
   * Every reason this path can preserve on, in one table. A preserve leaves the model as the coordinator called it;
   * it must never also leave the worker without the task. The environment is mutated after admission so the turn is
   * admitted as `single` and then meets the condition, which is exactly the order these arise in a real session.
   */
  it.each([
    ['a failed Gate B', (_env: Env): unknown => jevFailingRoute(), 'http_other'],
    ['native mode', (env: Env): unknown => { env['JEV_GATE_MODE'] = 'native'; return fakeJev({ execution: 'orchestrated' }); }, 'mode_native'],
    ['a missing key', (env: Env): unknown => { delete env['TYPESAFE_API_KEY']; return fakeJev({ execution: 'orchestrated' }); }, 'key_missing'],
  ])('carries the request through %s, because the brief was written expecting it', async (_name, after, code) => {
    const env = singleEnv();
    const admit = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), admit);
    const fetchImpl = after(env);
    const r = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    expect(r).toMatchObject({ kind: 'patch', code });
    const patched = updatedInput(r);
    // A preserve leaves the model alone. That is all it leaves alone: the task still has to reach the worker.
    expect(patched['model']).toBeUndefined();
    expect(patched['subagent_type']).toBe('jev-gate:worker');
    const prompt = String(patched['prompt']);
    expect(prompt).toContain('Do what the request asks.');
    expect(prompt).toContain('[Jev Gate user request]');
    expect(prompt).toContain('Build a settings page, migrate the store and wire the two together.');
    expect(prompt).toContain('It is the task: there is no plan and no task contract for this dispatch.');
  });

  it('carries the request on a pinned dispatch, and leaves the pin exactly as called', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    const r = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.', model: 'claude-opus-5' })), fetchImpl);
    expect(r).toMatchObject({ kind: 'patch', code: 'pinned' });
    expect(updatedInput(r)['model']).toBe('claude-opus-5');
    expect(String(updatedInput(r)['prompt'])).toContain('Build a settings page, migrate the store and wire the two together.');
  });

  /**
   * T2: the lock is not held across the Jev call, so a turn that moves on while the router is thinking leaves a
   * dispatch whose generation no longer exists. The hierarchy re-confirms ownership after its call; this path did not.
   */
  it('refuses a dispatch whose generation was superseded while Jev was still answering', async () => {
    const env = singleEnv();
    const admit = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), admit);
    let superseded = false;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      // The user sends the next prompt while this dispatch is waiting on its route answer.
      if ('route' in body.questions && !superseded) {
        superseded = true;
        await run(env, promptEvent({ prompt_id: 'p2', prompt: 'actually, do something else' }), admit);
      }
      return await (admit as unknown as typeof fetch)(url, init);
    });
    const r = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    expect(r).toMatchObject({ kind: 'deny', code: 'stale_generation' });
  });

  it('is off unless the config asks for it', async () => {
    const env = makeEnv();
    const r = await run(env, promptEvent(), fakeJev({ execution: 'orchestrated' }));
    expect(context(r)).toContain('[JEV_TASK rev=<n> id=<id>]');
    expect(state(env).current.execution).toBeUndefined();
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
    // A direct turn under the atomic gate: the request only wants an answer, so the veto fires and nothing is guarded.
    const direct = makeEnv();
    await run(direct, promptEvent(), fakeJev({ answerOnly: 0.9 }));
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

  /**
   * A18/v5-job2-orbit-2026-09-19: the coordinator's replan brief was 771 characters of fix instruction and nothing
   * else. The planner is a fresh session, so it took the repository's existing tests for the specification and
   * returned a revision missing three modules the request had named. Neither the request nor the revision it was
   * revising is something the planner can recall, so the hook carries both, as it does for a worker dispatch.
   */
  it('carries the request into every planner call, and the plan in force into a replan', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await run(env, promptEvent(), fetchImpl);
    const first = await run(env, plannerPre(), fetchImpl);
    const firstPrompt = String(updatedInput(first)['prompt']);
    expect(firstPrompt).toContain('Plan this request.');
    expect(firstPrompt).toContain('[Jev Gate user request]');
    expect(firstPrompt).toContain('Build a settings page, migrate the store and wire the two together.');
    // Nothing is in force yet, so a first plan is not told it is revising one.
    expect(firstPrompt).not.toContain('[Jev Gate plan in force]');

    await run(env, plannerPost(PLAN_REPLY), fetchImpl);
    const replan = await run(env, plannerPre(), fetchImpl);
    const replanPrompt = String(updatedInput(replan)['prompt']);
    expect(replanPrompt).toContain('[Jev Gate user request]');
    expect(replanPrompt).toContain('[Jev Gate plan in force]');
    // The revision in force is shown by what a revision can lose: its tasks, their order and what each one owes.
    for (const fragment of ['"rev": 1', '"id": "t1"', '"id": "t3"', '"depends_on"', '"deliverables"']) {
      expect(replanPrompt).toContain(fragment);
    }
    expect(replanPrompt).toContain('a revision that drops a deliverable or an interface the request names is a regression');
    // A17's order holds on this call too: the request outranks the revision planned from it.
    expect(replanPrompt.indexOf('[Jev Gate user request]')).toBeLessThan(replanPrompt.indexOf('[Jev Gate plan in force]'));
  });

  it('marks what did not fit rather than planning as though it never existed, dropping the request last', async () => {
    const replanWith = async (request: string): Promise<string> => {
      const env = makeEnv();
      const fetchImpl = fakeJev();
      await run(env, promptEvent({ prompt: request }), fetchImpl);
      await run(env, plannerPre(), fetchImpl);
      await run(env, plannerPost(PLAN_REPLY), fetchImpl);
      expect(state(env).current.request).toBe(request);
      const replan = await run(env, plannerPre(), fetchImpl);
      expect(replan.kind).toBe('patch');
      return String(updatedInput(replan)['prompt']);
    };
    // A17's order: under byte pressure the revision in force goes first, because the request outranks it.
    const planDropped = await replanWith(`Build a settings page. ${'x'.repeat(65000)}`);
    expect(planDropped).toContain('this call is a revision, not a first plan');
    expect(planDropped).not.toContain('"id": "t1"');
    expect(planDropped).toContain('[Jev Gate user request]');
    expect(planDropped).toContain('Build a settings page.');
    // Larger still, and the request goes too -- stated as an absence, never passed off as nothing having been asked.
    const bothDropped = await replanWith(`Build a settings page. ${'x'.repeat(65400)}`);
    expect(bothDropped).toContain('this call is a revision, not a first plan');
    expect(bothDropped).toContain('The request was not carried');
    expect(bothDropped).not.toContain('x'.repeat(1024));
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
    const noPlan = await run(env, plannerPre(), fakeJev());
    expect(noPlan).toMatchObject({ kind: 'deny', code: 'bounds_exhausted' });
    // No plan ever became ready here, so there is nothing to dispatch and reporting the blocker is all that is left.
    expect(String(hookOutput(noPlan)['permissionDecisionReason'])).toContain('Report the blocker to the user instead of retrying');
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
    const denied = await run(env, plannerPre(), fetchImpl);
    expect(denied).toMatchObject({ kind: 'deny', code: 'bounds_exhausted' });
    // v5-job2-orbit-2026-09-19: the refusal must not read as nothing left to do. Revision 1 is accepted and dispatchable,
    // and a coordinator told only to report the blocker dispatched no worker at all and shipped nothing at full price.
    const text = String(hookOutput(denied)['permissionDecisionReason']);
    expect(text).toContain('revision 1 cannot be revised again');
    expect(text).toContain('Ready task ids: t1, t2');
    expect(text).not.toContain('Report the blocker to the user instead of retrying');
    expect(state(env).current).toMatchObject({ phase: 'planned', plan: { rev: 1 }, attempts: { planner: 1, replans: 2 } });
  });

  it('R06: a terminal planner result that is not a plan never leaves the job idling in planning (T4)', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev());
    await run(env, plannerPre(), fakeJev());
    const r = await run(env, plannerPost(PLAN_REPLY, { tool_response: { status: 'error', content: [] } }));
    // The reservation is released AND the job returns to a state the coordinator can act on, with the reason.
    expect(context(r)).toContain('The planner returned status error');
    expect(state(env).current).toMatchObject({ phase: 'admitted', active: {}, attempts: { planner: 1 } });
    // The second terminal failure blocks the job instead of leaving it retryable forever.
    await run(env, plannerPre(), fakeJev());
    const second = await run(env, plannerPost(PLAN_REPLY, { tool_response: { status: 'cancelled', content: [] } }));
    expect(context(second)).toContain('No planner attempts remain');
    expect(state(env).current).toMatchObject({ phase: 'blocked', active: {} });
  });

  it('R06: refuses a second planner while one is already running (T4)', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await run(env, promptEvent(), fetchImpl);
    expect((await run(env, plannerPre(), fetchImpl)).kind).toBe('patch');
    expect(Object.keys(state(env).current.active)).toEqual(['toolu_plan']);
    const second = await run(env, plannerPre({}), fetchImpl);
    expect(second).toMatchObject({ kind: 'deny', code: 'planner_active' });
    // The refused call neither reserved nor spent an attempt.
    expect(Object.keys(state(env).current.active)).toEqual(['toolu_plan']);
    expect(state(env).current.attempts.planner).toBe(1);
  });

  it('R06: records whether the model the host ran was the planning profile this job asked for (T4)', async () => {
    const matched = makeEnv();
    await seedPlanned(matched, PLAN_REPLY, fakeJev());
    // The fake host reports claude-opus-5 and the deep profile is configured as opus.
    expect(state(matched).current).toMatchObject({ planner_tier: 'deep', planner_model: 'match' });

    const mismatched = makeEnv();
    const fetchImpl = fakeJev();
    await run(mismatched, promptEvent(), fetchImpl);
    await run(mismatched, plannerPre(), fetchImpl);
    const wrong = await run(mismatched, plannerPost(PLAN_REPLY, { tool_response: { status: 'completed', resolvedModel: 'claude-haiku-5', content: [{ type: 'text', text: fence(PLAN_REPLY) }] } }));
    expect(state(mismatched).current.planner_model).toBe('mismatch');
    expect(context(wrong)).toContain('not evidence that a strong planner produced it');
    // The plan itself is still usable: the pin being wrong is recorded, not used to throw away valid work.
    expect(state(mismatched).current).toMatchObject({ phase: 'planned', plan: { rev: 1 } });

    const unknown = makeEnv();
    const f2 = fakeJev();
    await run(unknown, promptEvent(), f2);
    await run(unknown, plannerPre(), f2);
    const unnamed = await run(unknown, plannerPost(PLAN_REPLY, { tool_response: { status: 'completed', content: [{ type: 'text', text: fence(PLAN_REPLY) }] } }));
    expect(state(unknown).current.planner_model).toBe('unverified');
    expect(context(unnamed)).toContain('unverified');
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

  /**
   * A17/v5-job2-orbit-2026-09-19: the accepted plan had renamed four of the request's exports and dropped a fifth.
   * No worker could have caught that, because until now nothing carried the request past the planner.
   */
  it('carries the admitted request into the worker contract, ahead of the plan that paraphrased it', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    expect(state(env).current.request).toBe('Build a settings page, migrate the store and wire the two together.');
    const r = await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const prompt = String(updatedInput(r)['prompt']);
    expect(prompt).toContain('[Jev Gate user request]');
    expect(prompt).toContain('Build a settings page, migrate the store and wire the two together.');
    expect(prompt.indexOf('[Jev Gate user request]')).toBeLessThan(prompt.indexOf('[Jev Gate task contract]'));
    expect(prompt).toContain('It outranks the contract below on what was asked for');
  });

  it('says the request was not carried when it does not fit, and still dispatches', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    // Stored whole (under REQUEST_MAX_BYTES) but too large to compose into the contract, which is the case that has to
    // be visible: the worker must not read the contract as the whole of what was asked.
    const huge = `Build a settings page. ${'x'.repeat(65000)}`;
    await run(env, promptEvent({ prompt: huge }), fetchImpl);
    await run(env, plannerPre(), fetchImpl);
    await run(env, plannerPost(PLAN_REPLY), fetchImpl);
    expect(state(env).current.request).toBe(huge);
    const r = await run(env, preEvent('Agent', agentInput()), fetchImpl);
    expect(r.kind).toBe('patch');
    const prompt = String(updatedInput(r)['prompt']);
    expect(prompt).toContain('The request was not carried');
    expect(prompt).not.toContain('x'.repeat(1024));
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
    const env = capEnv(2);
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
    const env = capEnv(2);
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
    await seedPlanned(env, planReply(tasks), fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const overlap = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(overlap).toMatchObject({ kind: 'deny', code: 'deliverable_overlap' });
    const cfg = join(tmp, 'cap1.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', maxParallelWorkers: 1 }));
    const capped = makeEnv({ JEV_GATE_CONFIG: cfg });
    await seedPlanned(capped, planReply(tasks), fetchImpl);
    await run(capped, preEvent('Agent', agentInput()), fetchImpl);
    const second = await run(capped, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t4]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(second).toMatchObject({ kind: 'deny', code: 'parallel_cap' });
  });

  it('denies a composed prompt over the byte bound instead of dropping constraints', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, planReply([rawTask('t1', { context: 'z'.repeat(8 * 1024) })]), fetchImpl);
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

  it('R03: denies a dispatch whose generation was replaced during the Gate B call instead of letting it run (T2)', async () => {
    const env = makeEnv();
    await seedPlanned(env, PLAN_REPLY, fakeJev());
    // A new user prompt lands while the allocation call is in flight. The original call must not be waved through
    // with its own input: it belongs to a plan that is no longer in force.
    const racing = fakeJev({
      onCall: (questions) => {
        if (questions.includes('route')) updateJob(env, 's1', (prev) => newGeneration(prev, 's1', 'p2', 'orchestrated').state);
      },
    });
    const r = await run(env, preEvent('Agent', agentInput()), racing);
    expect(r).toMatchObject({ kind: 'deny', code: 'stale_generation' });
    expect(hookOutput(r)['permissionDecision']).toBe('deny');
    expect(String(hookOutput(r)['permissionDecisionReason'])).toContain('no longer in force');
    // The new generation is untouched by the refused call.
    expect(state(env).current).toMatchObject({ prompt_id: 'p2', plan: null });
  });

  it('R04: refuses a rework while the first writer is still running, rather than replacing it (T2)', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    expect(state(env).current.active['toolu_1']).toMatchObject({ task_id: 't1', attempt: 1 });
    const rework = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(rework).toMatchObject({ kind: 'deny', code: 'task_active' });
    expect(String(hookOutput(rework)['permissionDecisionReason'])).toContain('never observed to stop');
    // The live reservation is still exactly the one that was taken; nothing was deleted to make room.
    expect(Object.keys(state(env).current.active)).toEqual(['toolu_1']);
    expect(state(env).current.attempts.tasks['t1']).toBe(1);
  });

  it('R04: an attempt number in the text confers nothing; the counted attempts decide (T1)', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    // No attempt of t1 has been recorded, so "attempt=7" is not the attempt this task is on.
    const lying = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=7]\nredo' })), fetchImpl);
    expect(lying).toMatchObject({ kind: 'deny', code: 'attempt_mismatch' });
    expect(String(hookOutput(lying)['permissionDecisionReason'])).toContain('next attempt=1');
    expect(state(env).current.active).toEqual({});
    // The honest number for a first dispatch is no attempt marker at all.
    expect((await run(env, preEvent('Agent', agentInput()), fetchImpl)).kind).toBe('patch');
  });
});

describe('rework evidence (A17)', () => {
  it('evaluates attempt 2 on strictly more evidence than attempt 1', async () => {
    const env = makeEnv();
    const routeStates: Array<Record<string, unknown>> = [];
    const fetchImpl = fakeJev({ onCall: (q, st) => void (q.includes('route') && routeStates.push(st)) });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply({ checks: [{ check_id: 'c1', result: 'fail', note: 'ordering' }] })), fetchImpl);
    const second = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(routeStates).toHaveLength(2);
    expect(routeStates[0]?.['prior_attempt']).toBeNull();
    // T11: a required check the worker itself reported as failed is a rework, decided by code and no second model.
    expect(routeStates[1]?.['prior_attempt']).toMatchObject({ attempt: 1, verdict: 'rework', failed_checks: ['c1'], provenance: 'worker_reported', observed_model_confirmed: true });
    expect(JSON.stringify(routeStates[1]).length).toBeGreaterThan(JSON.stringify(routeStates[0]).length);
    // The worker sees the same failure the gate saw.
    expect(String(updatedInput(second)['prompt'])).toContain('Previous attempt of this task (worker_reported)');
  });
});

describe('receipts', () => {
  it('binds the receipt to the tool_use_id with the observed model and root effort, then unlocks dependents', async () => {
    const env = capEnv(2);
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
    // T11: the worker's own report of a failed required check is the verdict; no request was made to reach it.
    expect(context(r)).toContain('reported a required check as failed');
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'rework', advisory: null });
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

  /** T11: the result gate is gone from the normal path. No result verdict is ever requested, whatever the outcome. */
  it('R14: makes no Gate C request on accept, incomplete, invalid or unknown, and still enforces the checks', async () => {
    const env = makeEnv();
    const sets: string[][] = [];
    const fetchImpl = fakeJev({ onCall: (q) => sets.push(q) });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);

    // accept
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const accepted = await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    expect(context(accepted)).toContain('Task t1 accepted');
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'accept', advisory: null });

    // incomplete: a required check reported not_run is still refused, exactly as before.
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    const incomplete = await run(env, workerPost('toolu_2', workerReply({ checks: [{ check_id: 'c1', result: 'not_run', note: '' }] })), fetchImpl);
    expect(context(incomplete)).toContain('Task t2 is incomplete');
    expect(state(env).current.receipts[1]).toMatchObject({ verdict: 'incomplete', advisory: null });

    // invalid
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2 attempt=2]\nredo' }), { tool_use_id: 'toolu_3' }), fetchImpl);
    const invalid = await run(env, workerPost('toolu_3', 'x', { tool_response: { status: 'completed', content: [{ type: 'text', text: 'all done, trust me' }] } }), fetchImpl);
    expect(context(invalid)).toContain('report-format failure');

    // unknown
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t3]\nwork' }), { tool_use_id: 'toolu_4' }), fetchImpl);
    const unknown = await run(env, workerPost('toolu_4', workerReply(), { tool_response: { status: 'cancelled', content: [] } }), fetchImpl);
    expect(unknown.kind === 'context' || unknown.kind === 'skip').toBe(true);

    // Not one request in the whole walk asked for a result verdict, and t3 never opened on a failed t2.
    expect(sets.some((q) => q.includes('result'))).toBe(false);
    expect(sets.every((q) => q.every((k) => !k.startsWith('scope_')))).toBe(true);
    expect(context(accepted)).toContain('Ready task ids: t2');
  });

  it('R14: reaches rework and replan from the worker\'s own report, never by promoting a refused result', async () => {
    const env = makeEnv();
    const sets: string[][] = [];
    const fetchImpl = fakeJev({ onCall: (q) => sets.push(q) });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const reworked = await run(env, workerPost('toolu_1', workerReply({ checks: [{ check_id: 'c1', result: 'fail', note: 'ordering' }] })), fetchImpl);
    expect(context(reworked)).toContain('reported a required check as failed');
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'rework', advisory: null });

    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    const replanned = await run(env, workerPost('toolu_2', workerReply({ status: 'replan', checks: [] })), fetchImpl);
    expect(context(replanned)).toContain("plan's assumptions no longer hold");
    expect(state(env).current.receipts[1]).toMatchObject({ verdict: 'replan' });

    // t3 depends on both, so neither recovery verdict opens it.
    const blocked = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t3]\nwork' }), { tool_use_id: 'toolu_3' }), fetchImpl);
    expect(blocked).toMatchObject({ code: 'deps_incomplete' });
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

describe('replan and contract reuse (A3, T3)', () => {
  it('R05: does not reuse a completion receipt across a plan revision, and keeps it as history', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    expect(state(env).current.receipts).toHaveLength(1);

    await run(env, plannerPre(), fetchImpl);
    const again = await run(env, plannerPost(PLAN_REPLY));
    expect(context(again)).toContain('Revision 2');
    // Byte-identical tasks: the previous accept still does not carry into the new revision.
    const after = state(env);
    expect(after.current.receipts).toEqual([]);
    expect(context(again)).toContain('Ready task ids: t1, t2');
    // A3: the receipt is retired to history, never deleted; the work it records still happened.
    expect(after.history[0]?.receipts).toMatchObject([{ task_id: 't1', verdict: 'accept' }]);
    expect(after.history[0]?.outcome).toBe('superseded');
  });

  it('R05: a changed global constraint or implementation context does not auto-complete the new plan', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);

    // Only the plan-level constraints change: the task hashes are identical, which is exactly the case the old
    // carry-forward rule accepted as "the same contract".
    await run(env, plannerPre(), fetchImpl);
    const v2 = { ...planReply(PLAN_TASKS), constraints: ['drop the public API and start from the new one'] };
    const changed = await run(env, plannerPost(v2));
    expect(context(changed)).toContain('Ready task ids: t1, t2');
    expect(state(env).current.receipts).toEqual([]);
    // t1 must be dispatchable again rather than refused as already accepted.
    const redispatch = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=2 id=t1]\nwork' }), { tool_use_id: 'toolu_v2' }), fetchImpl);
    expect(redispatch.kind).toBe('patch');
    expect(String(updatedInput(redispatch)['prompt'])).toContain('drop the public API');
  });

  it('R05: a task whose implementation context changed is not treated as already satisfied', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    await run(env, plannerPre(), fetchImpl);
    // `context` is deliberately outside contract_hash, so this revision's t1 hashes identically to the accepted one.
    const respecified = [rawTask('t1', { context: 'the store API is now keyed by tenant, not by user' }), rawTask('t2'), rawTask('t3', { depends_on: ['t1', 't2'] })];
    expect(contractHash(respecified[0] as Omit<PlannedTask, 'contract_hash'>)).toBe(contractHash(PLAN_TASKS[0] as Omit<PlannedTask, 'contract_hash'>));
    const r = await run(env, plannerPost(planReply(respecified)));
    expect(context(r)).toContain('Ready task ids: t1, t2');
    expect(state(env).current.receipts).toEqual([]);
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
    await run(done, promptEvent(), fakeJev({ answerOnly: 0.9 }));
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
    for (const phase of ['admission', 'guard', 'pre', 'plan', 'post']) expect(phases.join(' '), phase).toContain(phase);
    // T11: nothing writes a result or scope phase any more, because neither gate is called.
    for (const gone of ['result_intent', 'result_result', 'scope_intent', 'scope_result']) expect(readdirSync(dir).some((f) => f.startsWith(gone)), gone).toBe(false);
    // JG5-06: every attempted gate records the decision it applied, so accounting never re-derives policy.
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    const attempted = (phase: string, role?: string): Record<string, unknown> | undefined =>
      records.find((r) => r['phase'] === phase && r['attempted'] === true && (role === undefined || r['role'] === role));
    // A17 item 6: every gate records its decision in the same place, nested under `decision`.
    expect(attempted('admission_result')).toMatchObject({ forced: false, decision: { shape: 'orchestrated', decided: true, reason: null, changed_default: true } });
    expect(attempted('pre_result', 'planner')).toMatchObject({ decision: { action: 'patch', tier: 'deep', reason: null } });
    expect(attempted('pre_result', 'worker')).toMatchObject({ decision: { action: 'patch', tier: 'standard', reason: null } });
    // A17 item 7: every gate records whether it changed what would have happened without it.
    expect(attempted('pre_result', 'worker')).toMatchObject({ decision: { changed_default: false } });
    // T4/T11: the plan record carries the computed depth, the planner's own claim and the model agreement.
    const plan = records.find((r) => r['phase'] === 'plan');
    expect(plan).toMatchObject({ outcome: 'ready', chain_depth: 2, chain_depth_claimed: 2, planner_model: { agreement: 'match' } });
    const all = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('settings page');
    expect(all).toContain('"version": 5');
  });

  it('records changed_default true only when the applied outcome differs from the no-Jev outcome (A17)', async () => {
    const dir = join(tmp, 'trace-changed');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev({ planning_tier: 'frontier', route: 'deep', basis: 'unresolved_contract_reasoning' });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    const decision = (role: string): Record<string, unknown> =>
      (records.find((r) => r['phase'] === 'pre_result' && r['attempted'] === true && r['role'] === role)?.['decision'] ?? {}) as Record<string, unknown>;
    // Planner: frontier instead of the configured deep default. Worker: deep instead of the called standard profile.
    expect(decision('planner')).toMatchObject({ tier: 'frontier', changed_default: true });
    expect(decision('worker')).toMatchObject({ tier: 'deep', changed_default: true });
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
    // Exactly the five events the V5 gate dispatches. SessionStart and the `^Grep$` group were the withdrawn search
    // filter's, and nothing registers them any more; adding one back would run this hook on every search result.
    expect(Object.keys(hooks.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
      expect(hooks.hooks[event], event).toHaveLength(1);
      for (const group of hooks.hooks[event]!) expect(group.hooks).toEqual([{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"', timeout: 5 }]);
    }
    expect(hooks.hooks['UserPromptSubmit']![0]!.matcher).toBeUndefined();
    expect(hooks.hooks['PreToolUse']![0]!.matcher).toBeUndefined();
    expect(hooks.hooks['Stop']![0]!.matcher).toBeUndefined();
    expect(hooks.hooks['PostToolUse']!.map((g) => g.matcher)).toEqual(['^Agent$']);
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
      expect(src, f).not.toMatch(/\.credentials|keychain/);
      // Only the hook names the transcript, and only to hand the path to the depth reader; no gate module sees it.
      if (f !== 'hook.ts') expect(src, f).not.toMatch(/transcript_path/);
    }
    for (const f of ['jev.ts', 'admission.ts', 'allocation.ts', 'plan.ts', 'job.ts', 'trace.ts']) {
      const src = readFileSync(join(__dirname, '..', 'src', f), 'utf8');
      expect(src, f).not.toMatch(/subagent_type|jev-gate:worker|jev-gate:planner|Claude|claude/);
    }
  });

  it('keeps every agent definition in step with OWNED_AGENTS', () => {
    const all = readdirSync(join(__dirname, '..', 'agents')).filter((f) => f.endsWith('.md'));
    // JGL-04: `executor.md` belongs to lean, which shares no role, tier or reply format with these six.
    const files = all.filter((f) => f !== 'executor.md');
    expect(all.sort()).toEqual(['executor.md', 'planner-frontier.md', 'planner.md', 'worker-deep.md', 'worker-fast.md', 'worker-frontier.md', 'worker.md']);
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

  it('keeps the lean executor out of the legacy contract: inherited model, no reply format, a fail-safe', () => {
    const text = readFileSync(join(__dirname, '..', 'agents', 'executor.md'), 'utf8');
    expect(text).toContain('model: inherit');
    expect(text).toContain('disallowedTools: Agent, SendMessage');
    expect(text).toContain('background: false');
    // No WorkerReply JSON, no check_id list, no length quota: the executor reports in prose.
    expect(text).not.toContain('```json');
    expect(text).not.toContain('check_id');
    expect(text).toContain('handoff_unavailable');
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

describe('current attempt versus history (T1)', () => {
  /** Drives the plan to "t1 and t2 accepted", which is the state the old `acceptedReceipt` could not let go of. */
  const seedAccepted = async (env: Env, fetchImpl: unknown): Promise<void> => {
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    await run(env, workerPost('toolu_2', workerReply({ changed_files: ['src/t2.ts'] })), fetchImpl);
  };

  it('R01: a failed rework is not covered by the accept it replaced, and Stop does not call the job completed', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedAccepted(env, fetchImpl);
    // Both predecessors are accepted, so t3 is the ready task at this point.
    expect(state(env).current.receipts.map((r) => r.verdict)).toEqual(['accept', 'accept']);

    // A deliberate rework of an accepted t1, which then fails.
    const rework = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_r' }), fetchImpl);
    expect(rework.kind).toBe('patch');
    await run(env, workerPost('toolu_r', workerReply({ status: 'blocked', blockers: ['the store cannot be keyed that way'] })), fetchImpl);

    const after = state(env);
    // Both receipts survive; the later one is the one that decides.
    const t1Receipts = after.current.receipts.filter((r) => r.task_id === 't1');
    expect(t1Receipts.map((r) => r.verdict)).toEqual(['accept', 'incomplete']);
    // t3 depends on t1: the old accept must not reopen it.
    const blocked = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t3]\nwork' }), { tool_use_id: 'toolu_3b' }), fetchImpl);
    expect(blocked).toMatchObject({ kind: 'deny', code: 'deps_incomplete' });
    await run(env, { hook_event_name: 'Stop', session_id: 's1' });
    expect(state(env).current.outcome).toBe('incomplete');
  });

  it('R02: a predecessor under rework locks its dependents and blocks completion while it runs', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedAccepted(env, fetchImpl);
    // t3 was ready on the strength of the two accepts.
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_r' }), fetchImpl);
    expect(state(env).current.active['toolu_r']).toMatchObject({ task_id: 't1', attempt: 2 });

    // While that rework is in flight, nothing downstream opens and nothing reports the job finished.
    const blocked = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t3]\nwork' }), { tool_use_id: 'toolu_3' }), fetchImpl);
    expect(blocked).toMatchObject({ kind: 'deny', code: 'deps_incomplete' });
    await run(env, { hook_event_name: 'Stop', session_id: 's1' });
    expect(state(env).current.outcome).toBe('incomplete');
  });

  it('R02: a predecessor is not reworked underneath a dependent that is already running', async () => {
    const env = capEnv(2);
    const fetchImpl = fakeJev();
    await seedAccepted(env, fetchImpl);
    const dependent = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t3]\nwork' }), { tool_use_id: 'toolu_3' }), fetchImpl);
    expect(dependent.kind).toBe('patch');
    const rework = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_r' }), fetchImpl);
    expect(rework).toMatchObject({ kind: 'deny', code: 'dependent_active' });
    expect(String(hookOutput(rework)['permissionDecisionReason'])).toContain('Let the dependent finish');
  });

  it('R01: a late result from an earlier attempt does not re-accept the task', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply({ checks: [{ check_id: 'c1', result: 'fail', note: '' }] })), fetchImpl);
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'rework' });
    // The first attempt's tool_use_id arrives again after its reservation is long gone: it is not reserved, so it
    // records nothing and cannot turn the task back into an accepted one.
    const late = await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    expect(late).toMatchObject({ kind: 'skip' });
    expect(state(env).current.receipts).toHaveLength(1);
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'rework' });
  });
});

describe('parallel write scope (T5)', () => {
  it('R07: two spellings of one deliverable collide, and the configured cap is what actually runs', async () => {
    const aliased = [rawTask('t1', { deliverables: ['src/shared.ts'] }), rawTask('t2', { deliverables: ['src/./shared.ts'] }), rawTask('t4', { deliverables: ['src/other.ts'] })];
    const env = capEnv(3);
    const fetchImpl = fakeJev();
    await seedPlanned(env, planReply(aliased), fetchImpl);
    expect((await run(env, preEvent('Agent', agentInput()), fetchImpl)).kind).toBe('patch');
    const alias = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(alias).toMatchObject({ kind: 'deny', code: 'deliverable_overlap' });
    // A genuinely different file still runs alongside it.
    expect((await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t4]\nwork' }), { tool_use_id: 'toolu_4' }), fetchImpl)).kind).toBe('patch');
  });

  it('R07: an out-of-root deliverable is treated as shared scope, not as a distinct file', async () => {
    const outside = [rawTask('t1', { deliverables: ['../sibling/a.ts'] }), rawTask('t2', { deliverables: ['/tmp/b.ts'] })];
    const env = capEnv(3);
    const fetchImpl = fakeJev();
    await seedPlanned(env, planReply(outside), fetchImpl);
    expect((await run(env, preEvent('Agent', agentInput()), fetchImpl)).kind).toBe('patch');
    const second = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(second).toMatchObject({ kind: 'deny', code: 'deliverable_overlap' });
  });

  it('R07: the default build runs one worker and tells the coordinator exactly that', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    const guidance = await run(env, promptEvent(), fetchImpl);
    expect(context(guidance)).toContain('dispatch one ready task at a time');
    expect(context(guidance)).not.toContain('in one message so they run in parallel');
    await run(env, plannerPre(), fetchImpl);
    const planned = await run(env, plannerPost(PLAN_REPLY));
    expect(context(planned)).toContain('dispatch one ready task at a time');
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const second = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(second).toMatchObject({ kind: 'deny', code: 'parallel_cap' });
  });
});

describe('failure evidence and report repair (T9, T10)', () => {
  const NAMED_CHECKS = [
    { id: 'store-unit', description: 'unit tests', required: true, command: 'npm test' },
    { id: 'store-types', description: 'typecheck', required: true, command: 'npm run typecheck' },
  ];
  const namedPlan = (): Record<string, unknown> => planReply([rawTask('t1', { checks: NAMED_CHECKS }), rawTask('t2', { checks: NAMED_CHECKS })]);

  it('R12: the rework of a task carries its own previous failure, and no failure from another task', async () => {
    const env = capEnv(2);
    const routeStates: Array<Record<string, unknown>> = [];
    const fetchImpl = fakeJev({ onCall: (q, st) => void (q.includes('route') && routeStates.push(st)) });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply({ status: 'blocked', blockers: ['the cache contract is ambiguous'] })), fetchImpl);

    // A different task dispatched after that failure must not inherit it.
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(routeStates[1]?.['prior_attempt']).toBeNull();

    // The rework of t1 does carry it, to the gate and to the worker.
    const rework = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_r' }), fetchImpl);
    expect(routeStates[2]?.['prior_attempt']).toMatchObject({ attempt: 1, status: 'blocked', blockers: ['the cache contract is ambiguous'], provenance: 'worker_reported' });
    const prompt = String(updatedInput(rework)['prompt']);
    expect(prompt).toContain('Previous attempt of this task (worker_reported)');
    expect(prompt).toContain('the cache contract is ambiguous');
  });

  it('R12: a transport failure is not promoted to a reasoning failure', async () => {
    const env = makeEnv();
    const routeStates: Array<Record<string, unknown>> = [];
    const fetchImpl = fakeJev({ onCall: (q, st) => void (q.includes('route') && routeStates.push(st)) });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, { ...workerPost('toolu_1', workerReply()), hook_event_name: 'PostToolUseFailure', error: 'Agent terminated early' });
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'unknown', reply: null });
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_r' }), fetchImpl);
    expect(routeStates[1]?.['prior_attempt']).toBeNull();
  });

  it('R12: names the previous attempt as omitted when it does not fit, instead of sending a short input silently', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    const plan = state(env).current.plan;
    const task = plan?.tasks.find((t) => t.id === 't1');
    if (!plan || !task) throw new Error('no planned task');
    // Sized so the contract and the route note fit with room to spare, and only the prior attempt overflows.
    const head = '[JEV_TASK rev=1 id=t1]\n';
    const overhead = Buffer.byteLength(composeTaskPrompt(head, task, plan.constraints, []), 'utf8');
    const long = head + 'y'.repeat(MAX_COMPOSED_BYTES - overhead - 4096);
    expect((await run(env, preEvent('Agent', agentInput({ prompt: long })), fetchImpl)).kind).toBe('patch');
    await run(env, workerPost('toolu_1', workerReply({ status: 'blocked', summary: 'z'.repeat(6 * 1024), checks: [] })), fetchImpl);

    const rework = await run(env, preEvent('Agent', agentInput({ prompt: long.replace('id=t1]', 'id=t1 attempt=2]') }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(rework.kind).toBe('patch');
    const prompt = String(updatedInput(rework)['prompt']);
    expect(prompt).toContain('omitted because it did not fit the size bound');
    expect(prompt).not.toContain('zzzzzzzzzz');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(MAX_COMPOSED_BYTES);
  });

  it('R13: a format-invalid reply is answered with the real check ids of this task and a report-first instruction', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, namedPlan(), fetchImpl);
    const first = await run(env, preEvent('Agent', agentInput()), fetchImpl);
    // T10: the contract states the ids this task is accepted on, so the generic c1 cannot be copied from the template.
    expect(String(updatedInput(first)['prompt'])).toContain('Required check ids (report each of these exactly once, using these ids): ["store-unit","store-types"]');

    const invalid = await run(env, workerPost('toolu_1', 'x', { tool_response: { status: 'completed', content: [{ type: 'text', text: '```json\n{"status":"done","checks":[{"check_id":"","result":"pass"}]}\n```' }] } }), fetchImpl);
    expect(context(invalid)).toContain('check_id must match');
    expect(context(invalid)).toContain('report-format failure');
    expect(context(invalid)).toContain('Do not ask it to redo an implementation that was not shown to fail');
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'invalid', reply: null });

    // The repair dispatch gets the exact ids again, and the parser still refuses a near-miss id rather than matching it.
    const repair = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nfix the report' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(String(updatedInput(repair)['prompt'])).toContain('["store-unit","store-types"]');
    const fuzzy = await run(env, workerPost('toolu_2', workerReply({ checks: [{ check_id: 'store_unit', result: 'pass', note: '' }, { check_id: 'store-types', result: 'pass', note: '' }] })), fetchImpl);
    expect(context(fuzzy)).toContain('unknown check id store_unit');
    expect(state(env).current.receipts[1]).toMatchObject({ verdict: 'incomplete' });
  });

  it('R13: a report-only repair is accepted without the parser filling anything in', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, namedPlan(), fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', 'x', { tool_response: { status: 'completed', content: [{ type: 'text', text: 'I finished it, honestly' }] } }), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nfix the report' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    // A corrected report with no new code is accepted, and both attempts stay on the record with their cost.
    const fixed = await run(env, workerPost('toolu_2', workerReply({ changed_files: [], checks: [{ check_id: 'store-unit', result: 'pass', note: 'npm test' }, { check_id: 'store-types', result: 'pass', note: 'tsc' }] })), fetchImpl);
    expect(context(fixed)).toContain('Task t1 accepted');
    expect(state(env).current.receipts.map((r) => r.verdict)).toEqual(['invalid', 'accept']);
    expect(state(env).current.attempts.tasks['t1']).toBe(2);
    // A reply that simply omits a required check is still refused; nothing is inferred to fill the gap.
    const other = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_3' }), fetchImpl);
    expect(other.kind).toBe('patch');
    const partial = await run(env, workerPost('toolu_3', workerReply({ checks: [{ check_id: 'store-unit', result: 'pass', note: '' }] })), fetchImpl);
    expect(context(partial)).toContain('required check store-types was not reported');
  });
});

describe('R15: the simple paths this change must not break', () => {
  it('leaves off, native, pins, permissions and cancellation exactly as they were', async () => {
    // off: no request, no state, no output.
    const off = makeEnv({ JEV_GATE_MODE: 'off' });
    const offFetch = fakeJev();
    expect(await run(off, promptEvent(), offFetch)).toMatchObject({ kind: 'skip', code: 'mode_off' });
    expect(offFetch).not.toHaveBeenCalled();
    expect(existsSync(jobPath(off, 's1'))).toBe(false);

    // native: the full orchestration shape with no Jev request at all.
    const native = makeEnv({ JEV_GATE_MODE: 'native' });
    const nativeFetch = fakeJev();
    await run(native, promptEvent(), nativeFetch);
    await run(native, plannerPre(), nativeFetch);
    await run(native, plannerPost(PLAN_REPLY));
    const worker = await run(native, preEvent('Agent', agentInput()), nativeFetch);
    expect(worker).toMatchObject({ kind: 'patch', code: 'mode_native' });
    expect(updatedInput(worker)).not.toHaveProperty('model');
    expect(nativeFetch).not.toHaveBeenCalled();

    // a user pin keeps its model and still receives the contract; the guard still denies a root mutation tool.
    const pinned = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(pinned, PLAN_REPLY, fetchImpl);
    const pin = await run(pinned, preEvent('Agent', agentInput({ model: 'haiku' })), fetchImpl);
    expect(pin).toMatchObject({ kind: 'patch', code: 'pinned' });
    expect(updatedInput(pin)).toMatchObject({ model: 'haiku' });
    expect(await run(pinned, preEvent('Edit', {}), fetchImpl)).toMatchObject({ kind: 'deny', code: 'guard_denied' });
    // A cancelled call is recorded as unknown and releases its reservation, as before.
    const cancelled = await run(pinned, workerPost('toolu_1', workerReply(), { tool_response: { status: 'cancelled', content: [] } }), fetchImpl);
    expect(context(cancelled)).toContain('did not complete');
    expect(state(pinned).current.active).toEqual({});
  });

  it('still reads a stored job written before this change, advisory and all', async () => {
    const env = makeEnv();
    await seedPlanned(env, PLAN_REPLY, fakeJev());
    const current = state(env).current;
    const t1 = current.plan?.tasks.find((t) => t.id === 't1');
    if (!t1) throw new Error('no planned task');
    // A generation in the shape earlier revisions wrote: a Gate C advisory on the receipt and no planner_model field.
    const legacy = {
      version: 5,
      session_id: 's1',
      updated_at: new Date().toISOString(),
      current: {
        ...current,
        planner_model: undefined,
        receipts: [
          {
            task_id: 't1',
            contract_hash: t1.contract_hash,
            rev: 1,
            attempt: 1,
            tool_use_id: 'toolu_old',
            provenance: 'worker_reported',
            reply: { status: 'done', summary: 'built earlier', changed_files: ['src/t1.ts'], interfaces: [], checks: [{ check_id: 'c1', result: 'pass', note: '' }], blockers: [] },
            verdict: 'accept',
            verdict_reason: null,
            advisory: 'accept',
            observed_model: 'claude-sonnet-5',
            root_effort: 'high',
            recorded_at: new Date().toISOString(),
          },
        ],
      },
      history: [],
    };
    writeFileSync(jobPath(env, 's1'), JSON.stringify(legacy));
    const fetchImpl = fakeJev();
    // The stored accept still counts: t1 is refused as already accepted and t2 is still dispatchable.
    expect(await run(env, preEvent('Agent', agentInput()), fetchImpl)).toMatchObject({ kind: 'deny', code: 'task_accepted' });
    expect((await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl)).kind).toBe('patch');
    // The historical advisory is preserved as it was recorded, not rewritten.
    expect(state(env).current.receipts[0]).toMatchObject({ advisory: 'accept', verdict: 'accept' });
  });
});

/**
 * Three defects found reading the code on 2026-09-20, each with the test that would have caught it. All of them are
 * the same shape: a path that closes or records a decision chose its own key instead of reading the one the decision
 * was made under.
 */
describe('planner routing input (2026-09-20)', () => {
  /**
   * The state field Gate A2 fills is named `request`, and it was being given the coordinator's brief. What decides a
   * planning tier is how hard the job is, and the job is the request the plan is written from. Observed on
   * 2026-09-19 (`v5-job2-orbit` r1): the replan brief was 771 characters of fix instruction, so the tier for
   * replanning a whole job was chosen from a patch note.
   */
  it('routes the planner on the request the plan is written from, not on the coordinator brief', async () => {
    const env = makeEnv();
    const states: Array<Record<string, unknown>> = [];
    const fetchImpl = fakeJev({ onCall: (q, st) => void (q.includes('planning_tier') && states.push(st)) });
    await run(env, promptEvent(), fetchImpl);
    await run(env, plannerPre({ prompt: 'Plan this. Keep it small.' }), fetchImpl);
    expect(states).toHaveLength(1);
    expect(states[0]?.['request']).toBe('Build a settings page, migrate the store and wire the two together.');
  });

  it('falls back to the brief when no request was carried, rather than sending nothing', async () => {
    const env = makeEnv();
    const states: Array<Record<string, unknown>> = [];
    const fetchImpl = fakeJev({ onCall: (q, st) => void (q.includes('planning_tier') && states.push(st)) });
    // A direct-shape generation recovered at the planner dispatch has no stored request to carry.
    await run(env, plannerPre({ prompt: 'Plan this. Keep it small.' }), fetchImpl);
    expect(states[0]?.['request']).toBe('Plan this. Keep it small.');
  });
});

describe('prior failure classification (A22)', () => {
  const atomicEnv = (name: string, extra: Record<string, string> = {}): ReturnType<typeof makeEnv> => {
    const cfg = join(tmp, `${name}.json`);
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', routeQuestionShape: 'atomic' }));
    return makeEnv({ JEV_GATE_CONFIG: cfg, ...extra });
  };
  const atomicJev = (asked: string[][]): ReturnType<typeof vi.fn> =>
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      const keys = Object.keys(body.questions);
      const answers: Record<string, unknown> = {};
      if (keys.includes('execution')) answers['execution'] = { type: 'choice', choice: 'orchestrated', probabilities: { orchestrated: 0.95, direct: 0.02, needs_context: 0.02, abstain: 0.01 }, confidence: 0.95 };
      if (keys.includes('planning_tier')) answers['planning_tier'] = { type: 'choice', choice: 'deep', probabilities: { deep: 0.9, frontier: 0.05, abstain: 0.05 }, confidence: 0.9 };
      if (keys.includes('fully_specified')) {
        asked.push(keys);
        for (const k of keys) answers[k] = { type: 'noul', noul: k === 'prior_environment_failure' || k === 'prior_missing_information' ? 0.9 : 0.05 };
      }
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
    });

  it('asks what an earlier attempt reported only when there was one', async () => {
    const asked: string[][] = [];
    const env = atomicEnv('atomic-prior');
    const fetchImpl = atomicJev(asked);
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply({ checks: [{ check_id: 'c1', result: 'fail', note: 'ordering' }] })), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(asked).toHaveLength(2);
    // A question about what an earlier attempt reported, asked where there was no earlier attempt, is a question
    // about nothing that every first dispatch pays for.
    expect(asked[0]).not.toContain('prior_environment_failure');
    expect(asked[1]).toContain('prior_environment_failure');
    expect(asked[1]).toContain('prior_report_format');
  });

  it('records the kinds the rework reported and applies none of them', async () => {
    const asked: string[][] = [];
    const dir = join(tmp, 'trace-prior-failure');
    const env = atomicEnv('atomic-prior-trace', { JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = atomicJev(asked);
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply({ checks: [{ check_id: 'c1', result: 'fail', note: 'ordering' }] })), fetchImpl);
    const rework = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    // Trace file names are random by design, so the read order is not the write order; `written_at` is.
    const records = readdirSync(dir)
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
      .filter((r) => r['phase'] === 'pre_result' && r['role'] === 'worker' && r['attempted'] === true)
      .sort((a, b) => String(a['written_at']).localeCompare(String(b['written_at'])));
    expect(records[0]?.['prior_failure']).toBeUndefined();
    expect(records[1]?.['prior_failure']).toEqual({ kinds: ['prior_environment_failure', 'prior_missing_information'], unreadable: [], applied: false });
    // Two kinds that would argue against spending a stronger model are recorded, and the tier is still whatever the
    // acted-on facts decided. Reading a worker's account of its own failure as established cause is the error.
    expect(rework.kind).toBe('patch');
    expect((records[1]?.['decision'] as Record<string, unknown>)['tier']).toBe('standard');
  });
});

describe('worker routing input (2026-09-20)', () => {
  /**
   * A20: the worker receives the brief, the admitted request, the contract, the constraints, the predecessors and any
   * prior attempt. Every one of those was a field of the Gate B state except the request -- the one that says what the
   * work is for -- so the tier for a task was chosen from a covering note and a contract hash.
   */
  const routeStates = (states: Array<Record<string, unknown>>): ReturnType<typeof fakeJev> =>
    fakeJev({ onCall: (q, st) => void ((q.includes('route') || q.includes('fully_specified')) && states.push(st)) });

  it('sends the admitted request to Gate B as the field the worker receives it as', async () => {
    const env = makeEnv();
    const states: Array<Record<string, unknown>> = [];
    const fetchImpl = routeStates(states);
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    expect(states).toHaveLength(1);
    expect(states[0]?.['request']).toBe('Build a settings page, migrate the store and wire the two together.');
    // The brief keeps its own field: substituting one for the other hides half the packet either way.
    expect(states[0]?.['original_prompt']).toContain('[JEV_TASK');
  });

  it('says a request was not carried rather than that there was none', async () => {
    const env = makeEnv();
    const states: Array<Record<string, unknown>> = [];
    const fetchImpl = routeStates(states);
    // A17: a generation the coordinator started at the planner is orchestrated, so it was started by a request even
    // though this hook never saw one. Sending null there would tell the gate the work has no statement of purpose,
    // which is a different and false claim; the marker says the gate is reading a packet with a hole in it.
    await run(env, plannerPre({ prompt: 'Plan this.' }), fetchImpl);
    await run(env, plannerPost(PLAN_REPLY), fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    expect(states.at(-1)?.['request']).toBe('omitted');
  });

  it('drops the request with its marker rather than losing the gate call to the byte bound', async () => {
    const env = makeEnv();
    const states: Array<Record<string, unknown>> = [];
    const fetchImpl = routeStates(states);
    // Quotes double under JSON escaping, so this fits the worker's composed bound (65,536) and not the gate
    // request's (131,072). Measured: the state without a request is 3,958 bytes, so the window is narrow and real.
    const big = '"'.repeat(64_000);
    await run(env, promptEvent({ prompt: big }), fetchImpl);
    await run(env, plannerPre(), fetchImpl);
    await run(env, plannerPost(PLAN_REPLY), fetchImpl);
    const dispatch = await run(env, preEvent('Agent', agentInput()), fetchImpl);
    // The dispatch still happens and the gate still ran: without the drop it would have been refused outright and the
    // call would have kept the coordinator's tier with no routing at all.
    expect(dispatch.kind).toBe('patch');
    expect(states.at(-1)?.['request']).toBe('omitted');
  });
});

describe('receipt selection and observation keys (2026-09-20)', () => {
  it('T1: a rework whose call fails covers the accept it replaced, so its dependent is not ready', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t2]\nwork' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    await run(env, workerPost('toolu_2', workerReply()), fetchImpl);
    // t3 depends on both and is ready at this point; the rework of t1 is what takes that away.
    await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t1 attempt=2]\nredo' }), { tool_use_id: 'toolu_r' }), fetchImpl);
    await run(env, { ...workerPost('toolu_r', workerReply()), hook_event_name: 'PostToolUseFailure', error: 'Agent terminated early' });

    // The failure is recorded under the contract it was dispatched on. Written with an empty hash it was invisible to
    // `currentReceipt`, so the superseded accept still read as t1's result and a dependent dispatched on nothing.
    const gen = state(env).current;
    const t1 = gen.plan?.tasks.find((t) => t.id === 't1');
    expect(gen.receipts[gen.receipts.length - 1]).toMatchObject({ task_id: 't1', verdict: 'unknown', contract_hash: t1?.contract_hash });
    const denied = await run(env, preEvent('Agent', agentInput({ prompt: '[JEV_TASK rev=1 id=t3]\nwork' }), { tool_use_id: 'toolu_3' }), fetchImpl);
    expect(denied).toMatchObject({ kind: 'deny', code: 'deps_incomplete' });
  });

  it('records the model each decision asked for, and records none where it asked for none', async () => {
    const dir = join(tmp, 'trace-model');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev({ planning_tier: 'frontier', route: 'deep', basis: 'unresolved_contract_reasoning' });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    const patched = await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const decision = (role: string): Record<string, unknown> =>
      (readdirSync(dir)
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
        .find((r) => r['phase'] === 'pre_result' && r['attempted'] === true && r['role'] === role)?.['decision'] ?? {}) as Record<string, unknown>;
    // A reader of a stored trace cannot know which `models` map was in force when it was written, and deriving the
    // model from the tier through today's map would answer a question about yesterday with today's configuration.
    expect(decision('planner')).toMatchObject({ tier: 'frontier', model: 'fable' });
    expect(decision('worker')).toMatchObject({ tier: 'deep', model: 'opus' });
    // The recorded model is the one the patch actually carried; a record that drifts from the emitted call is worse
    // than no record, because it reads as evidence.
    const emitted = JSON.parse(patched.stdout ?? '{}') as { hookSpecificOutput?: { updatedInput?: { model?: string } } };
    expect(emitted.hookSpecificOutput?.updatedInput?.model).toBe(decision('worker')['model']);
  });

  it('records no model on a preserve, because the call keeps the one the coordinator named', async () => {
    const dir = join(tmp, 'trace-preserve-model');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = jevFailingRoute();
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    await run(env, preEvent('Agent', agentInput()), fetchImpl);
    const decision = readdirSync(dir)
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
      .find((r) => r['phase'] === 'pre_result' && r['role'] === 'worker' && r['attempted'] === true)?.['decision'] as Record<string, unknown>;
    expect(decision).toMatchObject({ action: 'preserve', reason: 'http_other' });
    // Naming the tier's model here would claim the gate asked for a model it deliberately did not ask for.
    expect(decision['model']).toBeNull();
  });

  it('records the numbers the atomic gates decide on, not only the fields a choice answer has', async () => {
    const dir = join(tmp, 'trace-atomic-answers');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    await run(env, promptEvent(), fakeJev({ execution: 'orchestrated', size: 3, forbidsDelegation: 0.07, answerOnly: 0.02 }));
    const record = readdirSync(dir)
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
      .find((x) => x['phase'] === 'admission_result');
    const answers = (record?.['answers'] ?? {}) as Record<string, Record<string, unknown>>;
    // The shipped Gate A decides on these three numbers and on nothing else, so a trace without them says which
    // questions were asked and not what was answered -- the observation cannot reproduce its own decision.
    expect(answers['size']).toMatchObject({ type: 'score', score: 3, choice: null });
    expect(answers['forbids_delegation']).toMatchObject({ type: 'noul', noul: 0.07 });
    expect(answers['answer_only']).toMatchObject({ type: 'noul', noul: 0.02 });
  });
});

// -----------------------------------------------------------------------------------------------------------------
// A23: the plan is compared against the request before it is adopted, and the comparison decides nothing.
// -----------------------------------------------------------------------------------------------------------------
describe('plan interpretation (A23)', () => {
  let a23Seq = 0;
  const a23Env = (on: boolean, extra: Record<string, string> = {}): ReturnType<typeof makeEnv> => {
    const cfg = join(tmp, `a23-${(a23Seq += 1)}.json`);
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...(on ? { planInterpretation: true } : {}) }));
    return makeEnv({ JEV_GATE_CONFIG: cfg, ...extra });
  };

  /** Answers the clause questions by id; anything it does not recognise falls through to the ordinary double. */
  const clauseJev = (verdict: (id: string) => string, seen: { keys: string[]; state: Record<string, unknown> }[] = []): ReturnType<typeof vi.fn> => {
    const base = fakeJev();
    return vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown>; state: Record<string, unknown> };
      const keys = Object.keys(body.questions);
      if (!keys.some((k) => /^c\d+$/.test(k))) return await (base as unknown as typeof fetch)(url, init);
      seen.push({ keys, state: body.state });
      const answers: Record<string, unknown> = {};
      for (const k of keys) {
        const winner = verdict(k);
        answers[k] = { type: 'choice', choice: winner, probabilities: Object.fromEntries(CLAUSE_VERDICTS.map((v) => [v, v === winner ? 0.91 : 0.03])), confidence: 0.91 };
      }
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
    });
  };

  const planRecords = (dir: string): Record<string, unknown>[] =>
    readdirSync(dir)
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
      .filter((r) => r['phase'] === 'plan')
      .sort((a, b) => String(a['written_at']).localeCompare(String(b['written_at'])));

  it('asks nothing extra unless the option is on', async () => {
    const seen: { keys: string[]; state: Record<string, unknown> }[] = [];
    const env = a23Env(false);
    const fetchImpl = clauseJev(() => 'supported', seen);
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    // Two calls, both pre-existing: Gate A on the prompt and the planner route on the dispatch. The planner's
    // PostToolUse made none before this option existed and still makes none.
    expect(seen).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(state(env).current.phase).toBe('planned');
  });

  it('compares each plan clause against the request and adopts the plan whatever it finds', async () => {
    const seen: { keys: string[]; state: Record<string, unknown> }[] = [];
    const dir = join(tmp, 'trace-a23-contradicted');
    const env = a23Env(true, { JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = clauseJev(() => 'contradicted', seen);
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.keys).toEqual(['c0']);
    // The clause, the request it is compared against and the interfaces it is compared to are all in the state.
    expect(seen[0]?.state['clauses']).toEqual([{ id: 'c0', constraint: 'keep the public API' }]);
    expect(String(seen[0]?.state['request'])).toContain('Build a settings page');
    expect((seen[0]?.state['proposed'] as { interfaces: string[] }[])[0]?.interfaces).toEqual(['createStore(): Store']);
    // A contradiction is a finding for a reader, never a veto: the plan is adopted exactly as it would have been.
    expect(state(env).current.phase).toBe('planned');
    expect(state(env).current.plan?.rev).toBe(1);
    const plan = planRecords(dir).at(-1);
    expect(plan?.['interpretation']).toEqual({ clauses: [{ id: 'c0', verdict: 'contradicted' }], unasked: 0, applied: false });
  });

  it('bounds the clauses it asks about and says how many it did not ask', async () => {
    const seen: { keys: string[]; state: Record<string, unknown> }[] = [];
    const dir = join(tmp, 'trace-a23-bounded');
    const env = a23Env(true, { JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = clauseJev((id) => (id === 'c0' ? 'omitted' : 'supported'), seen);
    const constraints = Array.from({ length: MAX_INTERPRETATION_CLAUSES + 3 }, (_, i) => `constraint ${i}`);
    await seedPlanned(env, { ...PLAN_REPLY, constraints }, fetchImpl);
    expect(seen[0]?.keys).toHaveLength(MAX_INTERPRETATION_CLAUSES);
    const interpretation = planRecords(dir).at(-1)?.['interpretation'] as { clauses: unknown[]; unasked: number };
    expect(interpretation.clauses).toHaveLength(MAX_INTERPRETATION_CLAUSES);
    // A clause dropped for size is named as unasked rather than silently absent, which is why the cap is on the
    // clause count and not on the serialized bytes.
    expect(interpretation.unasked).toBe(3);
  });

  it('adopts the plan when the comparison call fails', async () => {
    const dir = join(tmp, 'trace-a23-failed');
    const env = a23Env(true, { JEV_GATE_TRACE_DIR: dir });
    const base = fakeJev();
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      if (Object.keys(body.questions).some((k) => /^c\d+$/.test(k))) return new Response('upstream is down', { status: 500 });
      return await (base as unknown as typeof fetch)(url, init);
    });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    // A failed call leaves the plan unexamined, which is the state every plan was in before this option existed.
    expect(state(env).current.phase).toBe('planned');
    expect(state(env).current.plan?.rev).toBe(1);
    expect(planRecords(dir).at(-1)?.['interpretation']).toBeUndefined();
  });

  it('does not adopt a plan whose reservation was released while the comparison was in flight', async () => {
    const env = a23Env(true);
    const base = fakeJev();
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      if (!Object.keys(body.questions).some((k) => /^c\d+$/.test(k))) return await (base as unknown as typeof fetch)(url, init);
      // The window this call opens is real: nothing holds the job lock across it.
      updateJob(env, 's1', (prev) => (prev === null ? null : { ...prev, current: { ...prev.current, active: {} } }));
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { c0: { type: 'choice', choice: 'supported', probabilities: { supported: 0.9, contradicted: 0.04, omitted: 0.03, unknown: 0.03 }, confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    });
    await seedPlanned(env, PLAN_REPLY, fetchImpl);
    expect(state(env).current.plan).toBeNull();
    expect(state(env).current.phase).toBe('planning');
  });
});
