import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderSingleRouteNote } from '../src/coordinator.js';
import { runHook, type HookDeps, type HookResult } from '../src/hook.js';
import { jobPath, readJob, updateJob } from '../src/job.js';
import { appendLiveness, LIVENESS_WINDOW, readLiveness } from '../src/liveness.js';
import { composeSingleWorkerPrompt, MAX_COMPOSED_BYTES } from '../src/plan.js';
import { ADMISSION_ANSWERS, ROUTE_ANSWERS, UPGRADE_BASES, type JobState, type WorkerReply } from '../src/types.js';
import { costModelFloor, delegationModel } from '../src/admission.js';
import { DEFAULT_CONFIG } from '../src/config.js';

/** The atomic Gate A's shipped pre-filter: the shallowest depth at which any tool-call answer could pay. */
const COST_FLOOR = costModelFloor(delegationModel(DEFAULT_CONFIG));

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
  externalTools?: number;
  /** Gate A's tool-call read-off; 4 prices an admitted job at the depths these tests run. */
  toolCalls?: number;
  boundedToolWork?: number;
  route?: string;
  basis?: string;
  /** Returns this question's answer with its numbers intact but typed `choice`, as a malformed Jev response would. */
  mistype?: string;
  onCall?: (questions: string[], state: Record<string, unknown>) => void;
}

const ATOMIC_ROUTE_FACTS: Record<string, Record<string, number>> = {
  fast: { fully_specified: 0.9, interfaces_fixed: 0.9, checks_stated: 0.9 },
  standard: {},
  deep: { unresolved_interaction: 0.9 },
};

const isRecordValue = (v: unknown): boolean => typeof v === 'object' && v !== null;

const fakeJev = (opts: FakeAnswers = {}): ReturnType<typeof vi.fn> =>
  vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown>; state: Record<string, unknown> };
    const questions = Object.keys(body.questions);
    opts.onCall?.(questions, body.state);
    const answers: Record<string, unknown> = {};
    if (questions.includes('execution')) answers['execution'] = choice(ADMISSION_ANSWERS, opts.execution ?? 'orchestrated');
    // Gate A is atomic by default since 2026-09-19, so the double answers its read-offs the way an admitted job reads.
    if (questions.includes('forbids_delegation')) {
      if (opts.boundedToolWork !== undefined) answers['bounded_tool_work'] = { type: 'choice', choice: 'bounded', confidence: opts.boundedToolWork, probabilities: { bounded: opts.boundedToolWork, other: 1 - opts.boundedToolWork, unclear: 0 } };
      answers['forbids_delegation'] = { type: 'noul', noul: opts.forbidsDelegation ?? 0.05 };
      answers['external_tools'] = { type: 'noul', noul: opts.externalTools ?? 0.05 };
      const score = opts.toolCalls ?? 4;
      answers['task_context'] = choice(['self_contained', 'needs_context', 'unclear'], 'self_contained');
      answers['tool_calls'] = {
        type: 'score',
        score,
        confidence: 0.9,
        probabilities: Object.fromEntries([0, 1, 2, 3, 4].map((i) => [i, Math.max(0, 1 - Math.abs(i - score))])),
      };
    }
    if (questions.includes('route')) answers['route'] = choice(ROUTE_ANSWERS, opts.route ?? 'standard');
    // Gate B is atomic by default since 0.4.0: the same `route` option is answered as the facts that compose to it.
    if (questions.includes('fully_specified')) {
      const facts = ATOMIC_ROUTE_FACTS[opts.route ?? 'standard'] ?? {};
      for (const k of questions) answers[k] = { type: 'noul', noul: facts[k] ?? 0.1 };
    }
    if (questions.includes('upgrade_basis')) answers['upgrade_basis'] = choice(UPGRADE_BASES, opts.basis ?? 'no_specific_basis');
    if (opts.mistype !== undefined && isRecordValue(answers[opts.mistype])) answers[opts.mistype] = { ...(answers[opts.mistype] as object), type: 'choice' };
    return new Response(JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  });

/** A Jev double that answers Gate A and then fails Gate B, so a dispatch reaches the preserve paths with a reason. */
const jevFailingRoute = (): ReturnType<typeof vi.fn> => {
  const answering = fakeJev({ execution: 'orchestrated' });
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    if ('route' in body.questions || 'fully_specified' in body.questions) return new Response('upstream is down', { status: 500 });
    return await (answering as unknown as typeof fetch)(url, init);
  });
};

const stdinOf = (value: unknown): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  })();

type Env = Record<string, string | undefined>;
const SERIAL_POLICY = { delegationDepthFloor: null };
const gateConfig = join(tmp, 'gate-default.json');
writeFileSync(gateConfig, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY }));
const makeEnv = (over: Env = {}): Env => ({
  JEV_GATE_CONFIG: gateConfig,
  TYPESAFE_API_KEY: KEY,
  HOME: join(tmp, 'home'),
  JEV_GATE_MODE: 'auto',
  JEV_GATE_STATE_DIR: mkdtempSync(join(tmp, 'state-')),
  CLAUDE_CODE_FORK_SUBAGENT: '0',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  ...over,
});

/** Gate A ships atomic; the four-way choice is still supported and its own tests select it explicitly. */
let compositeSeq = 0;
const compositeGateAEnv = (over: Env = {}): Env => {
  const cfg = join(tmp, `composite-gate-a-${(compositeSeq += 1)}.json`);
  writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY, admissionQuestionShape: 'composite' }));
  return makeEnv({ JEV_GATE_CONFIG: cfg, ...over });
};

/** Gate B ships atomic since 0.4.0; the five-way choice is still supported and its own tests select it explicitly. */
const compositeGateBEnv = (over: Env = {}): Env => {
  const cfg = join(tmp, `composite-gate-b-${(compositeSeq += 1)}.json`);
  writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY, routeQuestionShape: 'composite' }));
  return makeEnv({ JEV_GATE_CONFIG: cfg, ...over });
};

const run = (env: Env, event: unknown, fetchImpl?: unknown, extra: Partial<HookDeps> = {}): Promise<HookResult> =>
  runHook({ env, stdin: stdinOf(event), ...(fetchImpl ? { fetchImpl: fetchImpl as typeof fetch } : {}), ...extra });

const parse = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;
const hookOutput = (r: HookResult): Record<string, unknown> => (r.stdout === null ? {} : parse(r.stdout)['hookSpecificOutput'] ?? {}) as Record<string, unknown>;
const context = (r: HookResult): string => String(hookOutput(r)['additionalContext'] ?? '');
const updatedInput = (r: HookResult): Record<string, unknown> => hookOutput(r)['updatedInput'] as Record<string, unknown>;
const fence = (value: unknown): string => 'summary prose\n```json\n' + JSON.stringify(value) + '\n```';

/**
 * Gate A is asked only when the session is already deep (depth-gate decision 1), so every prompt event carries a
 * transcript whose last usage line is past the shipped floor. The sidechain line is deliberately enormous: a subagent's
 * context is not this session's, and reading it instead would admit jobs on a number that describes another turn.
 */
let transcriptSeq = 0;
const transcriptAt = (tokens: number, model?: string): string => {
  const p = join(tmp, `transcript-${(transcriptSeq += 1)}.jsonl`);
  writeFileSync(
    p,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'an earlier turn' } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { cache_read_input_tokens: 9_000_000 } } }),
      JSON.stringify({ type: 'assistant', message: { ...(model !== undefined ? { model } : {}), usage: { cache_read_input_tokens: tokens - 1000, cache_creation_input_tokens: 600, input_tokens: 400 } } }),
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
  prompt: 'Implement the store.',
  run_in_background: false,
  ...over,
});

const workerReply = (over: Partial<WorkerReply> = {}): WorkerReply => ({
  status: 'done',
  summary: 'implemented the store',
  changed_files: ['src/t1.ts'],
  interfaces: ['createStore()'],
  checks: [{ check_id: 'npm test', result: 'pass', note: '' }],
  blockers: [],
  ...over,
});

/** The host's layout: the parent transcript's folder, then `<session>/subagents/agent-<agentId>.jsonl`. */
const workerTranscript = (runs: Array<{ command: string; failed: boolean }>, editAfter = false): { parent: string; agentId: string } => {
  const dir = mkdtempSync(join(tmp, 'project-dir-'));
  const agentId = `a${Math.random().toString(16).slice(2, 12)}`;
  mkdirSync(join(dir, 's1', 'subagents'), { recursive: true });
  const lines: string[] = [];
  runs.forEach((run, i) => {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: run.command } }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu${i}`, is_error: run.failed, content: run.failed ? 'Exit code 1' : 'ok' }] } }));
  });
  if (editAfter) lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tuE', name: 'Edit', input: { file_path: 'src/t1.ts' } }] } }));
  writeFileSync(join(dir, 's1', 'subagents', `agent-${agentId}.jsonl`), lines.join('\n') + '\n');
  return { parent: join(dir, 's1.jsonl'), agentId };
};

const toolUseLine = (id: string, name: string, input: Record<string, unknown>, cwd?: string): string =>
  JSON.stringify({ type: 'assistant', ...(cwd === undefined ? {} : { cwd }), message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResultLine = (id: string, isError?: boolean): string =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, ...(isError === undefined ? {} : { is_error: isError }), content: 'x' }] } });
const workerLines = (lines: string[]): { parent: string; agentId: string } => {
  const dir = mkdtempSync(join(tmp, 'project-dir-'));
  const agentId = `a${Math.random().toString(16).slice(2, 12)}`;
  mkdirSync(join(dir, 's1', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 's1', 'subagents', `agent-${agentId}.jsonl`), `${lines.join('\n')}\n`);
  return { parent: join(dir, 's1.jsonl'), agentId };
};
const bashLines = (id: string, command: string, mark: 'pass' | 'fail' | 'unknown' | 'pending', cwd?: string): string[] => {
  const started = toolUseLine(id, 'Bash', { command }, cwd);
  if (mark === 'pending') return [started];
  if (mark === 'unknown') return [started, toolResultLine(id)];
  return [started, toolResultLine(id, mark === 'fail')];
};
const editLines = (id: string, name: 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit', mark: 'done' | 'fail' | 'pending'): string[] => {
  const started = toolUseLine(id, name, { file_path: 'src/t1.ts' });
  if (mark === 'pending') return [started];
  return [started, toolResultLine(id, mark === 'fail')];
};

/** Every command a fixture worker reports. A worker that reports them passing ran them, as a real one does. */
const FIXTURE_CHECK_COMMANDS = ['npm test', 'npm run typecheck', 'npm run lint', 'npm run build'];

/** A worker's result, with the transcript of a worker that ran every fixture check and saw it pass. */
const workerPost = (toolUseId: string, reply: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => {
  const ran = workerTranscript(FIXTURE_CHECK_COMMANDS.map((command) => ({ command, failed: false })));
  return {
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    prompt_id: 'p1',
    tool_name: 'Agent',
    tool_use_id: toolUseId,
    effort: 'high',
    transcript_path: ran.parent,
    tool_input: { subagent_type: 'jev-gate:worker' },
    tool_response: { status: 'completed', agentId: ran.agentId, resolvedModel: 'claude-sonnet-5', content: [{ type: 'text', text: fence(reply) }] },
    ...over,
  };
};

const state = (env: Env): JobState => {
  const r = readJob(env, 's1');
  if (!r.ok || !r.value) throw new Error('no job state');
  return r.value;
};

/** Drives admission and the one worker dispatch, so a test can start from a dispatched job. */
const seedDispatched = async (env: Env, fetchImpl: unknown = fakeJev(), over: Record<string, unknown> = {}): Promise<HookResult> => {
  await run(env, promptEvent(), fetchImpl);
  return await run(env, preEvent('Agent', agentInput(over)), fetchImpl);
};

describe('a mode the Gate does not know', () => {
  // A deployed file, JEV_GATE_MODE or the gateMode option may still hold a value from an older release. It is refused as
  // invalid config: the Gate does nothing (no request, no job state, the host's own Agent call untouched) and never throws.
  const old = join(tmp, 'old-mode.json');
  writeFileSync(old, JSON.stringify({ version: 5, mode: 'lean' }));
  it.each([
    ['JEV_GATE_MODE', { JEV_GATE_MODE: 'lean' }],
    ['the gateMode option', { JEV_GATE_MODE: undefined, CLAUDE_PLUGIN_OPTION_GATEMODE: 'lean' }],
    ['the config file', { JEV_GATE_MODE: undefined, JEV_GATE_CONFIG: old }],
  ] as Array<[string, Env]>)('skips every event for %s and preserves the Agent call', async (_name, over) => {
    const env = makeEnv(over);
    const fetchImpl = fakeJev();
    expect(await run(env, promptEvent(), fetchImpl)).toMatchObject({ kind: 'skip', code: 'config_invalid', stdout: null });
    expect(await run(env, preEvent('Bash', { command: 'ls' }), fetchImpl)).toMatchObject({ kind: 'skip', code: 'config_invalid', stdout: null });
    expect(await run(env, preEvent('Agent', agentInput()), fetchImpl)).toMatchObject({ kind: 'preserve', code: 'config_invalid', stdout: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(jobPath(env, 's1'))).toBe(false);
  });
});

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
    expect(context(r)).toContain('Dispatch this request once, whole, to jev-gate:worker');
    expect(context(r)).not.toContain('settings page');
    expect(state(env).current).toMatchObject({ prompt_id: 'p1', shape: 'orchestrated', execution: 'single' });
  });

  it.each([
    ['direct', 'direct', null],
    ['needs_context', 'direct', 'admission_needs_context'],
    ['abstain', 'direct', 'admission_abstain'],
  ])('composite answer %s produces the direct shape', async (answer, shape, code) => {
    const env = compositeGateAEnv();
    const r = await run(env, promptEvent(), fakeJev({ execution: answer }));
    expect(r.code).toBe(code);
    expect(context(r)).toBe('');
    expect(hookOutput(r)['additionalContext']).toBeUndefined();
    expect(state(env).current.shape).toBe(shape);
  });

  it('keeps needs_context direct after exactly one call, without reading or sending earlier prompts', async () => {
    const dir = join(tmp, `trace-needs-context-${++transcriptSeq}`);
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const transcript = join(tmp, `followup-${++transcriptSeq}.jsonl`);
    writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'private earlier constraint' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 500000 } } }),
    ].join('\n'));
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).state.request).toBe('continue');
      const response = await (fakeJev() as unknown as typeof fetch)(_url, init);
      const json = await response.json() as { answers: Record<string, unknown> };
      json.answers.task_context = { type: 'choice', choice: 'needs_context', confidence: 0.9,
        probabilities: { self_contained: 0.05, needs_context: 0.9, unclear: 0.05 } };
      return new Response(JSON.stringify(json));
    });
    const r = await run(env, promptEvent({ transcript_path: transcript, prompt: 'continue' }), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ code: 'admission_needs_context', stdout: null });
    expect(state(env).current).toMatchObject({ shape: 'direct', request: null });
    const results = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>).filter(row => row['phase'] === 'admission_result');
    expect(results).toHaveLength(1);
    expect(results[0]).not.toHaveProperty('context_turns');
  });

  it('sends no request at all when the session is not yet deep enough to be worth delegating', async () => {
    const dir = join(tmp, 'trace-shallow');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    const r = await run(env, promptEvent({ transcript_path: transcriptAt(40_000) }), fetchImpl);
    // Below the cost model's floor no answer could pay, so the cheapest gate is no gate.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.code).toBe('depth_below_floor');
    expect(context(r)).toBe('');
    expect(hookOutput(r)['additionalContext']).toBeUndefined();
    expect(state(env).current.shape).toBe('direct');
    const record = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>).find((x) => x['phase'] === 'admission_result');
    expect(record).toMatchObject({ attempted: false, context_tokens: 40_000, depth_floor: COST_FLOOR, depth_floor_source: 'cost_model', decision: { reason: 'depth_below_floor', changed_default: false } });
  });

  it('prices the job: a request too small to repay the coordinator stays direct at depth', async () => {
    const dir = join(tmp, 'trace-not-worth');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const r = await run(env, promptEvent({ transcript_path: transcriptAt(55_000) }), fakeJev({ toolCalls: 3 }));
    expect(r.code).toBe('admission_not_worth');
    expect(state(env).current.shape).toBe('direct');
    const record = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>).find((x) => x['phase'] === 'admission_result');
    expect(record).toMatchObject({ attempted: true, decision: { shape: 'direct', reason: 'admission_not_worth' }, estimate: { turns: 26.5, saving_tokens: -207_500 } });
  });

  it('sends no request just below the derived floor, and one request at it', async () => {
    expect(COST_FLOOR).toBe(50_865);
    const belowDir = join(tmp, 'trace-floor-below');
    const belowEnv = makeEnv({ JEV_GATE_TRACE_DIR: belowDir });
    const belowFetch = fakeJev({ toolCalls: 4 });
    const below = await run(belowEnv, promptEvent({ transcript_path: transcriptAt(50_864) }), belowFetch);
    expect(belowFetch).not.toHaveBeenCalled();
    expect(below.code).toBe('depth_below_floor');
    const belowRecord = readdirSync(belowDir).map((f) => JSON.parse(readFileSync(join(belowDir, f), 'utf8')) as Record<string, unknown>).find((x) => x['phase'] === 'admission_result');
    expect(belowRecord).toMatchObject({ attempted: false, context_tokens: 50_864, depth_floor: 50_865, depth_floor_source: 'cost_model', decision: { reason: 'depth_below_floor', changed_default: false } });

    const atDir = join(tmp, 'trace-floor-at');
    const atEnv = makeEnv({ JEV_GATE_TRACE_DIR: atDir });
    const atFetch = fakeJev({ toolCalls: 4 });
    const at = await run(atEnv, promptEvent({ transcript_path: transcriptAt(50_865) }), atFetch);
    expect(atFetch).toHaveBeenCalledTimes(1);
    expect(at.code).toBeNull();
    expect(state(atEnv).current.shape).toBe('orchestrated');
    const atRecord = readdirSync(atDir).map((f) => JSON.parse(readFileSync(join(atDir, f), 'utf8')) as Record<string, unknown>).find((x) => x['phase'] === 'admission_result');
    expect(atRecord).toMatchObject({ attempted: true, context_tokens: 50_865, depth_floor: 50_865, depth_floor_source: 'cost_model', decision: { shape: 'orchestrated', reason: null }, estimate: { turns: 51.5, saving_tokens: 33 } });
  });

  it('asks below the derived floor when an explicit delegationDepthFloor says to, and the price still decides', async () => {
    const cfg = join(tmp, 'floor-explicit-below-derived.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY, delegationDepthFloor: 40_000 }));
    const fetchImpl = fakeJev({ toolCalls: 4 });
    const r = await run(makeEnv({ JEV_GATE_CONFIG: cfg }), promptEvent({ transcript_path: transcriptAt(50_000) }), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.code).toBe('admission_not_worth');
  });

  it.each([
    // A 200K model with nothing configured: the host compacts at 200K, so the floor is 0.6 x 200K and 150K is admitted.
    ['claude-haiku-4-5', 200_000, 120_000, true],
    // A native-1M model with nothing configured: the floor stays at 300K, and 150K is not deep enough.
    ['claude-opus-5-5', 1_000_000, 300_000, false],
  ])('with no window configured, the composite gate takes the window from the session model %s', async (model, window, floor, asked) => {
    const dir = join(tmp, `trace-model-${model}`);
    // The atomic gate prices each request and ignores the window; the composite gate keeps the window rule.
    const env = compositeGateAEnv({ JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent({ transcript_path: transcriptAt(150_000, model) }), fetchImpl);
    expect(fetchImpl.mock.calls.length > 0).toBe(asked);
    const record = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>).find((x) => x['phase'] === 'admission_result');
    expect(record).toMatchObject({ context_tokens: 150_000, host_window: window, host_window_source: `default:model:${model}`, depth_floor: floor });
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
    // #114: the reason reaches the user as a systemMessage, and only the user -- the model context is unchanged.
    const body = JSON.parse(r.stdout as string) as Record<string, unknown>;
    expect(String(body['systemMessage'])).toContain('depth_unknown');
    expect(body['hookSpecificOutput']).toBeUndefined();
  });

  it('carries the depth into the record of an admitted job, so a bench case can prove it primed the session', async () => {
    const dir = join(tmp, 'trace-deep');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    await run(env, promptEvent(), fakeJev({ execution: 'orchestrated' }));
    const record = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>).find((x) => x['phase'] === 'admission_result');
    expect(record).toMatchObject({ attempted: true, context_tokens: 406_000, depth_floor: COST_FLOOR, decision: { shape: 'orchestrated' } });
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
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY, delegationDepthFloor: 0 }));
    const env = makeEnv({ JEV_GATE_CONFIG: cfg });
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent({ transcript_path: transcriptAt(1_000) }), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['composite', 'atomic'])('keeps an unreadable transcript direct with the floor off (%s)', async (shape) => {
    const cfg = join(tmp, `floor-off-unreadable-${shape}.json`);
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY, delegationDepthFloor: 0, admissionQuestionShape: shape }));
    const env = makeEnv({ JEV_GATE_CONFIG: cfg });
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    const r = await run(env, { ...promptEvent(), transcript_path: undefined }, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(context(r)).toBe('');
    expect(hookOutput(r)['additionalContext']).toBeUndefined();
    expect(state(env).current.shape).toBe('direct');
  });

  it('asks only the consumed facts and records selection without claiming application', async () => {
    const cfg = join(tmp, 'gate-a-atomic.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY, admissionQuestionShape: 'atomic' }));
    const dir = join(tmp, 'trace-atomic-selection');
    const env = makeEnv({ JEV_GATE_CONFIG: cfg, JEV_GATE_TRACE_DIR: dir });
    const reply = fakeJev();
    let asked: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      asked = Object.keys(JSON.parse(String(init.body)).questions);
      return await (reply as unknown as typeof fetch)(url, init);
    });
    const r = await run(env, promptEvent(), fetchImpl);
    expect(asked).toEqual(['forbids_delegation', 'task_context', 'tool_calls', 'bounded_tool_work']);
    expect(context(r)).toContain('Dispatch this request once');
    expect(state(env).current).toMatchObject({ shape: 'orchestrated', execution: 'single', admission_revision: 'atomic-context-v1' });
    const record = readdirSync(dir)
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      .find((x) => x.phase === 'admission_result');
    expect(record.selected_execution).toBe('single');
    expect(record.recommendation).toBeUndefined();
  });

  it.each(['forbids_delegation', 'tool_calls'])('keeps invalid required %s direct', async (key) => {
    const env = makeEnv();
    const r = await run(env, promptEvent(), fakeJev({ mistype: key }));
    expect(context(r)).toBe('');
    expect(hookOutput(r)['additionalContext']).toBeUndefined();
    expect(state(env).current.shape).toBe('direct');
  });

  it('records prompt_id_absent and creates no orchestrated state', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    const r = await run(env, promptEvent({ prompt_id: undefined }), fetchImpl);
    expect(r).toMatchObject({ kind: 'skip', code: 'prompt_id_absent', stdout: null });
    expect(context(r)).toBe('');
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
    expect(state(env).current).toMatchObject({ shape: 'orchestrated', execution: 'single', forced: true });
    // Only Gate A is skipped: the allocation gate still makes a real request.
    expect(await run(env, preEvent('Agent', agentInput()), fetchImpl)).toMatchObject({ kind: 'patch' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to direct without a key and skips blank, slash and child prompts', async () => {
    const env = makeEnv({ TYPESAFE_API_KEY: undefined });
    expect(await run(env, promptEvent())).toMatchObject({ kind: 'skip', code: 'key_missing', stdout: null });
    for (const over of [{ prompt: '   ' }, { prompt: '/model opus' }, { agent_id: 'child' }, { agent_type: 'custom' }]) {
      expect(await run(makeEnv(), promptEvent(over))).toMatchObject({ kind: 'skip', code: null });
    }
  });

  it('releases an unreturned reservation before superseding the generation', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedDispatched(env, fetchImpl);
    expect(Object.keys(state(env).current.active)).toEqual(['toolu_1']);
    const r = await run(env, promptEvent({ prompt_id: 'p2' }), fetchImpl);
    expect(context(r)).not.toContain('superseded by this request');
    const after = state(env);
    expect(after.current).toMatchObject({ prompt_id: 'p2', active: {} });
    expect(after.history[0]?.active).toEqual({});
    expect(after.history[0]?.receipts[0]).toMatchObject({ verdict: 'unknown', verdict_reason: 'worker_no_result' });
    // A late result cannot recreate the released reservation or accept the new job.
    const late = await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    expect(late).toMatchObject({ kind: 'skip', code: null });
    expect(state(env).current.receipts).toEqual([]);
  });

  it('#284: a late Gate A answer for an older generation of the same prompt_id is recorded, never applied to the newer one', async () => {
    const env = makeEnv();
    let newer: string | undefined;
    // The host re-sends the prompt_id (a queued prompt or a notice) while the first answer is still in flight.
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (newer === undefined) {
        await run(env, promptEvent(), fakeJev({ forbidsDelegation: 0.95 }));
        newer = state(env).current.generation_id;
      }
      return await (fakeJev({ execution: 'orchestrated' }) as unknown as typeof fetch)(url, init);
    });
    expect(await run(env, promptEvent(), fetchImpl)).toMatchObject({ kind: 'skip', code: 'generation_changed' });
    const after = state(env);
    expect(after.current).toMatchObject({ prompt_id: after.history[0]?.prompt_id, generation_id: newer, shape: 'direct', request: null });
    expect(after.history[0]?.generation_id).not.toBe(newer);
  });
});

describe('liveness ring (#48 P2)', () => {
  it('records a below-floor decision as not attempted, with the reason', async () => {
    const env = makeEnv();
    await run(env, promptEvent({ transcript_path: transcriptAt(40_000) }), fakeJev({ execution: 'orchestrated' }));
    expect(readLiveness(env)?.recent).toEqual([{ at: expect.any(String), attempted: false, reason: 'depth_below_floor' }]);
  });

  it('records an unreadable depth as not attempted, with the reason', async () => {
    const env = makeEnv();
    await run(env, { ...promptEvent(), transcript_path: undefined }, fakeJev({ execution: 'orchestrated' }));
    expect(readLiveness(env)?.recent).toEqual([{ at: expect.any(String), attempted: false, reason: 'depth_unknown' }]);
  });

  it('records a real Gate A call as attempted, whatever it decides', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev({ execution: 'orchestrated' }));
    expect(readLiveness(env)?.recent).toEqual([{ at: expect.any(String), attempted: true, reason: null }]);
  });

  it('records key_missing as not attempted', async () => {
    const env = makeEnv({ TYPESAFE_API_KEY: undefined });
    await run(env, promptEvent());
    expect(readLiveness(env)?.recent).toEqual([{ at: expect.any(String), attempted: false, reason: 'key_missing' }]);
  });

  it('records a host that never sends a prompt id as not attempted', async () => {
    const env = makeEnv();
    await run(env, promptEvent({ prompt_id: undefined }));
    expect(readLiveness(env)?.recent).toEqual([{ at: expect.any(String), attempted: false, reason: 'prompt_id_absent' }]);
  });

  it('never records the forced bench control arm -- it never asks Gate A on purpose', async () => {
    const env = makeEnv({ JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' });
    await run(env, promptEvent({ transcript_path: transcriptAt(55_000) }), fakeJev());
    expect(readLiveness(env)).toBeNull();
  });

  it('never records mode=native -- it is a deliberate configuration, not an admission decision', async () => {
    const env = makeEnv({ JEV_GATE_MODE: 'native' });
    await run(env, promptEvent(), fakeJev());
    expect(readLiveness(env)).toBeNull();
  });
});

describe('#48: a session whose Agent calls can only run in the background', () => {
  // An interactive session's default: fork mode, no run_in_background field, no forced foreground.
  const backgroundOnly: Env = { CLAUDE_CODE_FORK_SUBAGENT: undefined, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: undefined };
  const admission = (dir: string): Record<string, unknown> | undefined =>
    readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>).find((x) => x['phase'] === 'admission_result');

  it('stays direct before Gate A at a depth that would be asked, sends nothing, and says why', async () => {
    const dir = join(tmp, 'trace-background-only');
    const env = makeEnv({ ...backgroundOnly, JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    const r = await run(env, promptEvent(), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.code).toBe('host_unsupported');
    expect(state(env).current.shape).toBe('direct');
    expect(admission(dir)).toMatchObject({ attempted: false, known_not_sent: true, decision: { shape: 'direct', reason: 'host_unsupported', changed_default: false } });
    expect(readLiveness(env)?.recent).toEqual([{ at: expect.any(String), attempted: false, reason: 'host_unsupported' }]);
  });

  it('never guards the main session: a direct turn lets its own edits through', async () => {
    const env = makeEnv(backgroundOnly);
    await run(env, promptEvent(), fakeJev({ execution: 'orchestrated' }));
    expect(await run(env, preEvent('Edit', {}))).toMatchObject({ kind: 'skip', code: 'not_agent_tool', stdout: null });
  });

  it.each([
    ['forced foreground', { CLAUDE_CODE_FORK_SUBAGENT: undefined, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }],
    ['fork mode off, where the call can say run_in_background: false', { CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: undefined }],
  ])('still asks Gate A with %s', async (_label, launch) => {
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(makeEnv(launch), promptEvent(), fetchImpl);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('stays direct under forced forking even with the foreground forced', async () => {
    const env = makeEnv({ CLAUDE_CODE_FORK_SUBAGENT: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    const r = await run(env, promptEvent(), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.code).toBe('host_unsupported');
  });

  it('says so at SessionStart at once, to the user and not the model, without waiting for the liveness window', async () => {
    const r = await run(makeEnv(backgroundOnly), { hook_event_name: 'SessionStart', session_id: 's1' });
    expect(r).toMatchObject({ kind: 'notice', code: 'host_unsupported' });
    const body = JSON.parse(r.stdout as string) as Record<string, unknown>;
    expect(String(body['systemMessage'])).toContain('no verified fresh owned Agent profile');
    expect(String(body['systemMessage'])).toContain('CLAUDE_CODE_FORK_SUBAGENT=0');
    expect(body).not.toHaveProperty('hookSpecificOutput');
  });

  it('says nothing at SessionStart when the gate is off or native', async () => {
    for (const mode of ['off', 'native']) {
      expect(await run(makeEnv({ ...backgroundOnly, JEV_GATE_MODE: mode }), { hook_event_name: 'SessionStart', session_id: 's1' })).toMatchObject({ stdout: null });
    }
  });

  it('pays no transcript scan for a turn it refuses, and none for a missing key either', async () => {
    const dir = join(tmp, 'trace-background-only-depth');
    await run(makeEnv({ ...backgroundOnly, JEV_GATE_TRACE_DIR: dir }), promptEvent());
    expect(admission(dir)).toMatchObject({ blocker: 'background_only' });
    expect(admission(dir)).not.toHaveProperty('context_depth_read');
    const keyless = join(tmp, 'trace-keyless-depth');
    const r = await run(makeEnv({ TYPESAFE_API_KEY: undefined, JEV_GATE_TRACE_DIR: keyless }), promptEvent());
    expect(r.code).toBe('key_missing');
    expect(admission(keyless)).not.toHaveProperty('context_depth_read');
  });

  it.each(['auto', 'native'])('refuses the forced arm in %s mode: no job would reach a worker, and the main session keeps its edits', async (mode) => {
    const dir = join(tmp, `trace-forced-background-only-${mode}`);
    const env = makeEnv({ ...backgroundOnly, JEV_GATE_MODE: mode, JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated', JEV_GATE_TRACE_DIR: dir });
    const r = await run(env, promptEvent(), fakeJev({ execution: 'orchestrated' }));
    expect(r.code).toBe('host_unsupported');
    expect(state(env).current.shape).toBe('direct');
    expect(state(env).current).not.toHaveProperty('forced');
    expect(admission(dir)).toMatchObject({ forced: false, forced_requested: true, blocker: 'background_only', decision: { shape: 'direct', reason: 'host_unsupported' } });
    // A refused bench arm is a configuration fact, not an admission outage.
    expect(readLiveness(env)).toBeNull();
    expect(await run(env, preEvent('Edit', {}))).toMatchObject({ kind: 'skip', code: 'not_agent_tool', stdout: null });
  });
});

describe('#48: a forced subagent model every owned Agent call refuses', () => {
  const admission = (dir: string): Record<string, unknown> | undefined =>
    readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>).find((x) => x['phase'] === 'admission_result');

  it.each([
    ['a forced model', { CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }],
    ['the force flag', { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }],
  ])('stays direct before Gate A under %s', async (_label, override) => {
    const dir = join(tmp, `trace-override-${Object.keys(override).length}`);
    const env = makeEnv({ ...override, JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    const r = await run(env, promptEvent(), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.code).toBe('host_unsupported');
    expect(admission(dir)).toMatchObject({ blocker: 'subagent_model_override', decision: { shape: 'direct', reason: 'host_unsupported' } });
    expect(await run(env, preEvent('Edit', {}))).toMatchObject({ kind: 'skip', code: 'not_agent_tool' });
  });

  it('refuses the forced arm under the override too', async () => {
    const env = makeEnv({ CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' });
    expect((await run(env, promptEvent())).code).toBe('host_unsupported');
    expect(state(env).current.shape).toBe('direct');
  });

  it.each(['inherit', 'opus'])('still asks Gate A, and says nothing at SessionStart, when CLAUDE_CODE_SUBAGENT_MODEL is %s without _FORCE', async (value) => {
    // A concrete value is only the default of a child that names no model; every owned role names one.
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(makeEnv({ CLAUDE_CODE_SUBAGENT_MODEL: value }), promptEvent(), fetchImpl);
    expect(fetchImpl).toHaveBeenCalled();
    expect(await run(makeEnv({ CLAUDE_CODE_SUBAGENT_MODEL: value }), { hook_event_name: 'SessionStart', session_id: 's1' })).toMatchObject({ kind: 'skip', stdout: null });
  });

  it('names the override at SessionStart', async () => {
    const r = await run(makeEnv({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }), { hook_event_name: 'SessionStart', session_id: 's1' });
    expect(r).toMatchObject({ kind: 'notice', code: 'host_unsupported' });
    expect(String((JSON.parse(r.stdout as string) as Record<string, unknown>)['systemMessage'])).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE');
  });
});

describe('SessionStart liveness warning (#48 P2)', () => {
  const sessionStart = (): Record<string, unknown> => ({ hook_event_name: 'SessionStart', session_id: 's1' });
  const fillRing = (env: Env, n: number, attempted: boolean): void => {
    for (let i = 0; i < n; i++) appendLiveness(env, { at: `t${i}`, attempted, reason: attempted ? null : 'depth_below_floor' });
  };

  it('says nothing before the ring has a full window of decisions, even if none of them attempted', async () => {
    const env = makeEnv();
    fillRing(env, LIVENESS_WINDOW - 1, false);
    expect(await run(env, sessionStart())).toMatchObject({ kind: 'skip', stdout: null });
  });

  it('warns, via a systemMessage and not model context, once a full window never attempted a call', async () => {
    const env = makeEnv();
    fillRing(env, LIVENESS_WINDOW, false);
    const r = await run(env, sessionStart());
    expect(r.kind).toBe('notice');
    const body = JSON.parse(r.stdout as string) as Record<string, unknown>;
    expect(typeof body['systemMessage']).toBe('string');
    expect(String(body['systemMessage'])).toContain(String(LIVENESS_WINDOW));
    expect(body).not.toHaveProperty('hookSpecificOutput');
  });

  it('says nothing when even one of the last window attempted a call', async () => {
    const env = makeEnv();
    fillRing(env, LIVENESS_WINDOW - 1, false);
    appendLiveness(env, { at: 'last', attempted: true, reason: null });
    expect(await run(env, sessionStart())).toMatchObject({ kind: 'skip', stdout: null });
  });

  it('says nothing with no liveness history at all', async () => {
    expect(await run(makeEnv(), sessionStart())).toMatchObject({ kind: 'skip', stdout: null });
  });

  it('never checks in native mode, whatever the ring says', async () => {
    const env = makeEnv({ JEV_GATE_MODE: 'native' });
    fillRing(env, LIVENESS_WINDOW, false);
    expect(await run(env, sessionStart())).toMatchObject({ kind: 'skip', stdout: null });
  });

  it('never checks when the gate is off', async () => {
    const env = makeEnv({ JEV_GATE_MODE: 'off' });
    fillRing(env, LIVENESS_WINDOW, false);
    expect(await run(env, sessionStart())).toMatchObject({ kind: 'skip', code: 'mode_off', stdout: null });
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
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY }));
    return makeEnv({ JEV_GATE_CONFIG: cfg });
  };

  it('admits the turn, and tells the coordinator to dispatch it once rather than plan it', async () => {
    const env = singleEnv();
    const r = await run(env, promptEvent(), fakeJev({ execution: 'orchestrated' }));
    expect(r.kind).toBe('guidance');
    expect(context(r)).toContain('Execution shape: orchestrated');
    expect(context(r)).toContain('Dispatch this request once, whole, to jev-gate:worker');
    // No planner or task marker is offered: neither exists (#289).
    expect(context(r)).not.toContain('JEV_TASK');
    expect(context(r)).not.toMatch(/planner/i);
    expect(state(env).current).toMatchObject({ shape: 'orchestrated', execution: 'single', request: 'Build a settings page, migrate the store and wire the two together.' });
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
    expect(prompt).toContain('It is the task. Implement what it asks,');
    expect(prompt).not.toContain('[Jev Gate task contract]');
    expect(prompt).toContain('[Jev Gate route note]');
    // The route note cannot point at a contract that does not exist.
    expect(prompt).not.toContain('The task contract above is authoritative');
  });

  it('leaves root tools to the coordinator: a root non-Agent call gets no output and no decision (#289)', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    const calls = fetchImpl.mock.calls.length;
    for (const [tool, input] of [['Edit', { file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' }], ['Bash', { command: 'ls' }], ['mcp__x__y', {}]] as const) {
      expect(await run(env, preEvent(tool, input), fetchImpl), tool).toMatchObject({ kind: 'skip', code: 'not_agent_tool', stdout: null });
    }
    // A child caller and a session without state are left alone the same way.
    expect(await run(env, preEvent('Edit', {}, { agent_id: 'child' }), fetchImpl)).toMatchObject({ stdout: null });
    expect(await run(makeEnv(), preEvent('Edit', {}), fetchImpl)).toMatchObject({ stdout: null });
    expect(fetchImpl.mock.calls.length).toBe(calls);
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

  it("records the receipt as the worker's own report, and completes the job on it", async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    const post = await run(env, workerPost('toolu_1', workerReply({ checks: [{ check_id: 'npm test', result: 'pass', note: 'all passed' }] })), fetchImpl);
    // The accept is stated as reported rather than verified: this shape has no contract for code to check.
    expect(context(post)).toContain('does not establish requirement coverage');
    expect(state(env).current.root_fallback_reason).toBe('accepted');
    expect(context(post)).not.toContain('Ready task ids');
    const gen = state(env).current;
    expect(gen.active).toEqual({});
    expect(gen.receipts).toHaveLength(1);
    // The contract hash is empty because there is no contract; the check the worker reported is kept as it wrote it.
    expect(gen.receipts[0]).toMatchObject({ task_id: 'single', contract_hash: '', verdict: 'accept', provenance: 'worker_reported' });
    expect(gen.receipts[0]?.reply?.checks).toEqual([{ check_id: 'npm test', result: 'pass', note: 'all passed' }]);
    await run(env, { hook_event_name: 'Stop', session_id: 's1' });
    expect(state(env).current.outcome).toBe('completed');
  });

  it('does not accept a worker that changed files on its word alone: no passing check, or one that names no command', async () => {
    for (const [reply, reason] of [
      [workerReply({ checks: [] }), 'worker_checks_missing'],
      [workerReply({ checks: [{ check_id: 'unit tests', result: 'pass', note: '' }] }), 'shows no passing run'],
    ] as const) {
      const env = singleEnv();
      const fetchImpl = fakeJev({ execution: 'orchestrated' });
      await run(env, promptEvent(), fetchImpl);
      await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
      await run(env, workerPost('toolu_1', reply), fetchImpl);
      const receipt = state(env).current.receipts[0];
      expect(receipt?.verdict).toBe('incomplete');
      expect(receipt?.verdict_reason).toContain(reason);
    }
  });

  it('accepts a worker that changed nothing and had nothing to check', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply({ changed_files: [], checks: [] })), fetchImpl);
    expect(state(env).current.receipts[0]?.verdict).toBe('accept');
  });

  it('does not complete the job when the one worker says it did not finish', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    const post = await run(env, workerPost('toolu_1', workerReply({ status: 'blocked', blockers: ['the store is missing'] })), fetchImpl);
    expect(context(post)).toContain('reported that it did not finish');
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
    const reply = workerReply({ checks: [{ check_id: 'npm run typecheck', result: 'pass', note: 'no errors' }] });
    await run(env, workerPost('toolu_1', reply), fetchImpl);
    const receipt = state(env).current.receipts[0];
    expect(receipt).toMatchObject({ task_id: 'single', verdict: 'accept' });
    // The name is kept as the worker wrote it, so the record says which check ran.
    expect(receipt?.reply?.checks).toEqual([{ check_id: 'npm run typecheck', result: 'pass', note: 'no errors' }]);
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
    expect(state(env).current.root_fallback).toBe(true);
    expect(await run(env, preEvent('Edit', { file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' }), fetchImpl)).toMatchObject({ kind: 'skip' });
    expect(await run(env, preEvent('Bash', { command: 'npm test' }), fetchImpl)).toMatchObject({ kind: 'skip' });
    const third = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' }), { tool_use_id: 'toolu_3' }), fetchImpl);
    expect(third).toMatchObject({ kind: 'deny', code: 'bounds_exhausted' });
    expect(String(hookOutput(third)['permissionDecisionReason'])).toContain('allowed attempts');
    expect(state(env).current.active['toolu_3']).toBeUndefined();
  });

  it('grants one same-tier retry for a check hidden by an output suffix without accepting it', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' }), { tool_use_id: 'toolu_1' }), fetchImpl);
    const ran = workerTranscript([{ command: 'npm test; echo "exit=$?"', failed: false }]);
    const reply = workerReply({ checks: [{ check_id: 'npm test', result: 'pass', note: '' }] });
    const first = await run(env, workerPost('toolu_1', reply, {
      transcript_path: ran.parent,
      tool_response: { status: 'completed', agentId: ran.agentId, resolvedModel: 'claude-sonnet-5', content: [{ type: 'text', text: fence(reply) }] },
    }), fetchImpl);
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'incomplete', evidence_format_only: true, requested_tier: 'standard' });
    expect(state(env).current.root_fallback).toBeUndefined();
    expect(context(first)).toContain('npm test; echo');
    expect(context(first)).toContain('same worker profile');
    const wrongTier = await run(env, preEvent('Agent', agentInput({ subagent_type: 'jev-gate:worker-deep', prompt: 'Do what the request asks.' }), { tool_use_id: 'toolu_wrong' }), fetchImpl);
    expect(wrongTier).toMatchObject({ kind: 'deny', code: 'attempt_mismatch' });
    const retry = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' }), { tool_use_id: 'toolu_2' }), fetchImpl);
    expect(retry).toMatchObject({ kind: 'patch' });
    expect(updatedInput(retry)['model']).toBe('sonnet');
    expect(state(env).current.active['toolu_2']).toMatchObject({ task_id: 'single', attempt: 2 });
    await run(env, workerPost('toolu_2', reply), fetchImpl);
    expect(state(env).current.receipts.at(-1)?.verdict).toBe('accept');
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
    expect(prompt).toContain('It is the task. Implement what it asks,');
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
    expect(prompt).toContain('It is the task. Implement what it asks,');
  });

  it('preserves the called profile when Jev abstains, and still carries the request', async () => {
    // Only the composite Gate B has an abstain answer; the atomic one composes facts and always names a tier.
    const env = compositeGateBEnv();
    const r = await seedDispatched(env, fakeJev({ route: 'abstain' }), { subagent_type: 'jev-gate:worker-deep', prompt: 'Do what the request asks.' });
    expect(r.code).toBe('route_abstain');
    expect(updatedInput(r)).not.toHaveProperty('model');
    expect(updatedInput(r)['subagent_type']).toBe('jev-gate:worker-deep');
    expect(String(updatedInput(r)['prompt'])).toContain('[Jev Gate user request]');
  });

  it('carries the request on a pinned dispatch, and leaves the pin exactly as called', async () => {
    const env = singleEnv();
    const fetchImpl = fakeJev({ execution: 'orchestrated' });
    await run(env, promptEvent(), fetchImpl);
    const r = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.', model: 'claude-opus-5-5' })), fetchImpl);
    expect(r).toMatchObject({ kind: 'patch', code: 'pinned' });
    expect(updatedInput(r)['model']).toBe('claude-opus-5-5');
    expect(String(updatedInput(r)['prompt'])).toContain('Build a settings page, migrate the store and wire the two together.');
  });

  it('denies an owned call that cannot be validated as a dispatch instead of waving it through', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await run(env, promptEvent(), fetchImpl);
    const before = fetchImpl.mock.calls.length;
    for (const over of [{ run_in_background: 'invalid' }, { resume: 'agent-1' }, { prompt: '  ' }]) {
      const r = await run(env, preEvent('Agent', agentInput(over)), fetchImpl);
      expect(r, JSON.stringify(over)).toMatchObject({ kind: 'deny', code: 'dispatch_ineligible' });
      expect(String(hookOutput(r)['permissionDecisionReason'])).toContain('background call');
    }
    expect(fetchImpl.mock.calls.length).toBe(before);
    expect(state(env).current.active).toEqual({});
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
      if (('route' in body.questions || 'fully_specified' in body.questions) && !superseded) {
        superseded = true;
        await run(env, promptEvent({ prompt_id: 'p2', prompt: 'actually, do something else' }), admit);
      }
      return await (admit as unknown as typeof fetch)(url, init);
    });
    const r = await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    expect(r).toMatchObject({ kind: 'deny', code: 'stale_generation' });
  });

});

describe('worker check verification (0.4.0)', () => {
  const postWith = (reply: WorkerReply, t: { parent: string; agentId: string }): Record<string, unknown> =>
    workerPost('toolu_1', reply, {
      transcript_path: t.parent,
      tool_response: { status: 'completed', agentId: t.agentId, resolvedModel: 'claude-sonnet-5', content: [{ type: 'text', text: fence(reply) }] },
    });
  // A dispatch has no contract, so a check is named by its command and recorded by its position (#1).
  const dispatched = async (env: Env): Promise<ReturnType<typeof vi.fn>> => {
    const fetchImpl = fakeJev();
    await seedDispatched(env, fetchImpl);
    return fetchImpl;
  };
  const ACCEPTED = 'The worker reported done with no blockers';

  it('refuses a reported pass whose last run in the worker transcript failed', async () => {
    const env = makeEnv();
    await dispatched(env);
    const post = await run(env, postWith(workerReply(), workerTranscript([{ command: 'npm test', failed: true }])));
    expect(context(post)).not.toContain(ACCEPTED);
    const receipt = state(env).current.receipts[0];
    expect(receipt).toMatchObject({ verdict: 'incomplete', verification: { transcript: 'read', contradicted: ['#1'] } });
    expect(receipt?.verdict_reason).toContain("reported pass, but its last run in the worker's own transcript failed");
  });

  it('does not accept a later run that adds arguments when the exact check failed', async () => {
    const env = makeEnv();
    await dispatched(env);
    const t = workerTranscript([{ command: 'npm test', failed: true }, { command: 'npm  test -- --run', failed: false }], true);
    const post = await run(env, postWith(workerReply(), t));
    expect(context(post)).not.toContain(ACCEPTED);
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'incomplete', verification: { contradicted: ['#1'], unobserved: [], stale: [] } });
    expect(state(env).current.receipts[0]?.verdict_reason).toContain("last run in the worker's own transcript failed");
    expect(state(env).current.receipts[0]?.verdict_reason).not.toContain('npm test');
  });

  it('refuses a reported pass the whole transcript shows no run of', async () => {
    const env = makeEnv();
    await dispatched(env);
    await run(env, postWith(workerReply(), workerTranscript([{ command: 'npm run lint', failed: false }])));
    const receipt = state(env).current.receipts[0];
    expect(receipt).toMatchObject({ verdict: 'incomplete', verification: { transcript: 'read', unobserved: ['#1'] } });
    expect(receipt?.verdict_reason).toContain('shows no passing run of its command');
  });

  it('does not let a later command that only mentions the check mask its failed run', async () => {
    const env = makeEnv();
    await dispatched(env);
    await run(env, postWith(workerReply(), workerTranscript([{ command: 'npm test', failed: true }, { command: 'echo npm test', failed: false }])));
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'incomplete', verification: { contradicted: ['#1'] } });
  });

  // A missing transcript cannot show that the check ran, so its pass is the worker's word alone and is not accepted.
  // On a host whose layout moved this refuses every reported pass, and the receipt names why.
  it('refuses a reported pass when there is no transcript to read, and says why', async () => {
    const env = makeEnv();
    await dispatched(env);
    await run(env, workerPost('toolu_1', workerReply(), { transcript_path: undefined }));
    const receipt = state(env).current.receipts[0];
    expect(receipt).toMatchObject({ verdict: 'incomplete', verification: { transcript: 'unavailable', contradicted: [], unobserved: ['#1'] } });
    expect(receipt?.verdict_reason).toContain('could not be read');
  });

  it('reads nothing when verifyWorkerChecks is off', async () => {
    const cfg = join(tmp, 'no-verify.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY, verifyWorkerChecks: false }));
    const env = makeEnv({ JEV_GATE_CONFIG: cfg });
    await dispatched(env);
    await run(env, postWith(workerReply(), workerTranscript([{ command: 'npm test', failed: true }])));
    const receipt = state(env).current.receipts[0];
    expect(receipt?.verdict).toBe('incomplete');
    expect(receipt).not.toHaveProperty('verification');
  });

  it('holds the single shape to the command it names as its check id', async () => {
    const cfg = join(tmp, 'verify-single.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY }));
    const env = makeEnv({ JEV_GATE_CONFIG: cfg });
    const fetchImpl = fakeJev();
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    const reply = workerReply({ checks: [{ check_id: 'npm run build', result: 'pass', note: 'built' }] });
    await run(env, postWith(reply, workerTranscript([{ command: 'npm run build', failed: true }])));
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'incomplete', verification: { contradicted: ['#1'] } });
  });

  it('names a single-shape check by its position, so the command it ran never reaches the trace', async () => {
    const dir = join(tmp, 'trace-verify-secret');
    const cfg = join(tmp, 'verify-single-secret.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY }));
    const env = makeEnv({ JEV_GATE_CONFIG: cfg, JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev();
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do what the request asks.' })), fetchImpl);
    const command = 'curl -fsS -H "Authorization: Bearer sk-test-SECRET" https://example.invalid/health';
    const reply = workerReply({ checks: [{ check_id: command, result: 'pass', note: 'ok' }] });
    await run(env, postWith(reply, workerTranscript([{ command, failed: true }])));
    const receipt = state(env).current.receipts[0];
    expect(receipt).toMatchObject({ verdict: 'incomplete', verification: { contradicted: ['#1'] } });
    expect(receipt?.verdict_reason).not.toContain('SECRET');
    const traced = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    expect(traced).toMatch(/"contradicted": \[\s*"#1"\s*\]/);
    expect(traced).not.toContain('SECRET');
  });

  it('judges a pass against the check start and the last observed edit', async () => {
    const rows: Array<{ label: string; lines: string[]; verdict: 'accept' | 'incomplete'; contradicted?: string[]; unobserved?: string[]; stale?: string[] }> = [
      { label: 'pass then write', lines: [...bashLines('b', 'npm test', 'pass'), ...editLines('w', 'Write', 'done')], verdict: 'incomplete', stale: ['#1'] },
      { label: 'write then pass', lines: [...editLines('w', 'MultiEdit', 'done'), ...bashLines('b', 'npm test', 'pass')], verdict: 'accept' },
      { label: 'pass write pass', lines: [...bashLines('b1', 'npm test', 'pass'), ...editLines('w', 'Edit', 'done'), ...bashLines('b2', 'npm test', 'pass')], verdict: 'accept' },
      { label: 'pass write fail', lines: [...bashLines('b1', 'npm test', 'pass'), ...editLines('w', 'Write', 'done'), ...bashLines('b2', 'npm test', 'fail')], verdict: 'incomplete', contradicted: ['#1'] },
      { label: 'check start then write then success', lines: [...bashLines('b', 'npm test', 'pending'), ...editLines('w', 'Write', 'done'), toolResultLine('b', false)], verdict: 'incomplete', stale: ['#1'] },
      {
        label: 'write start, check start, write done, check success',
        lines: [toolUseLine('w', 'Write', { file_path: 'src/t1.ts' }), toolUseLine('b', 'Bash', { command: 'npm test' }), toolResultLine('w', false), toolResultLine('b', false)],
        verdict: 'incomplete',
        stale: ['#1'],
      },
      { label: 'newer pending', lines: [...bashLines('b1', 'npm test', 'pass'), ...bashLines('b2', 'npm test', 'pending')], verdict: 'incomplete', unobserved: ['#1'] },
      { label: 'open write before the check', lines: [...editLines('w', 'NotebookEdit', 'pending'), ...bashLines('b', 'npm test', 'pass')], verdict: 'incomplete', stale: ['#1'] },
    ];
    for (const row of rows) {
      const env = makeEnv();
      await dispatched(env);
      const post = await run(env, postWith(workerReply(), workerLines(row.lines)));
      const receipt = state(env).current.receipts[0];
      expect({ label: row.label, verdict: receipt?.verdict, contradicted: receipt?.verification?.contradicted, unobserved: receipt?.verification?.unobserved, stale: receipt?.verification?.stale }).toEqual({
        label: row.label,
        verdict: row.verdict,
        contradicted: row.contradicted ?? [],
        unobserved: row.unobserved ?? [],
        stale: row.stale ?? [],
      });
      if (row.verdict === 'accept') expect(context(post)).toContain(ACCEPTED);
      else expect(context(post)).not.toContain(ACCEPTED);
      if (row.stale && !row.contradicted && !row.unobserved) {
        expect(receipt?.verdict_reason).toBe(`check ${row.stale.join(', ')}: 마지막 관측 변경 이후의 검사 결과 필요`);
        expect(receipt?.verdict_reason).not.toContain('npm');
      }
      if (row.contradicted) expect(receipt?.verdict_reason).toContain('last run');
      if (row.unobserved) expect(receipt?.verdict_reason).toContain('shows no passing run');
    }
  });

  it('does not accept the three reproduced command confusions, and a same-command mark still stands', async () => {
    const confused: Array<{ planned: string; actual: string; cwd?: string }> = [
      { planned: "! grep -Fq 'a  b' double.txt", actual: "! grep -Fq 'a b' double.txt" },
      { planned: "! grep -Fq 'prefix a' prefix.txt", actual: "! grep -Fq 'prefix /w/repo/a' prefix.txt", cwd: '/w/repo' },
      { planned: 'false', actual: 'false | cat' },
    ];
    for (const c of confused) {
      const env = makeEnv();
      await dispatched(env);
      const post = await run(env, postWith(workerReply({ checks: [{ check_id: c.planned, result: 'pass', note: '' }] }), workerLines(bashLines('b', c.actual, 'pass', c.cwd))));
      const receipt = state(env).current.receipts[0];
      expect(receipt?.verdict).toBe('incomplete');
      expect(receipt?.verification).toMatchObject({ contradicted: [], unobserved: ['#1'], stale: [] });
      expect(context(post)).not.toContain(ACCEPTED);
      expect(receipt?.verdict_reason ?? '').not.toContain('prefix');
      expect(receipt?.verdict_reason ?? '').not.toContain('double');
      expect(receipt?.verdict_reason ?? '').not.toContain('|');
    }
    const marks: Array<{ mark: 'pass' | 'fail' | 'unknown'; verdict: 'accept' | 'incomplete'; key: 'contradicted' | 'unobserved' | 'stale'; ids: string[] }> = [
      { mark: 'pass', verdict: 'accept', key: 'stale', ids: [] },
      { mark: 'fail', verdict: 'incomplete', key: 'contradicted', ids: ['#1'] },
      { mark: 'unknown', verdict: 'incomplete', key: 'unobserved', ids: ['#1'] },
    ];
    for (const mark of marks) {
      const env = makeEnv();
      await dispatched(env);
      await run(env, postWith(workerReply({ checks: [{ check_id: 'false', result: 'pass', note: '' }] }), workerLines(bashLines('b', 'false', mark.mark))));
      const receipt = state(env).current.receipts[0];
      expect(receipt?.verdict).toBe(mark.verdict);
      expect(receipt?.verification?.[mark.key]).toEqual(mark.ids);
    }
  });

  it('does not copy an && list failure onto the member, or let an unrelated failure erase a pass', async () => {
    const rows: Array<{ command: string; failed: boolean; verdict: 'accept' | 'incomplete'; contradicted: string[]; unobserved: string[] }> = [
      { command: 'npm test && echo ok', failed: false, verdict: 'accept', contradicted: [], unobserved: [] },
      { command: 'npm test && echo ok', failed: true, verdict: 'incomplete', contradicted: [], unobserved: ['#1'] },
      { command: 'false && npm test', failed: true, verdict: 'incomplete', contradicted: [], unobserved: ['#1'] },
      { command: 'cd pkg && npm test', failed: false, verdict: 'incomplete', contradicted: [], unobserved: ['#1'] },
    ];
    for (const row of rows) {
      const env = makeEnv();
      await dispatched(env);
      await run(env, postWith(workerReply(), workerTranscript([{ command: row.command, failed: row.failed }])));
      expect(state(env).current.receipts[0]).toMatchObject({ verdict: row.verdict, verification: { contradicted: row.contradicted, unobserved: row.unobserved } });
    }
    const env = makeEnv();
    await dispatched(env);
    const post = await run(env, postWith(workerReply(), workerTranscript([{ command: 'npm test', failed: false }, { command: 'npm run lint', failed: true }])));
    expect(context(post)).toContain(ACCEPTED);
    const hidden = makeEnv();
    await dispatched(hidden);
    await run(hidden, postWith(workerReply(), workerTranscript([{ command: 'npm test', failed: false }, { command: 'npm test && echo ok', failed: true }])));
    expect(state(hidden).current.receipts[0]).toMatchObject({ verdict: 'incomplete', verification: { contradicted: [], unobserved: ['#1'], stale: [] } });
  });

  it('reads the worker transcript, not a pass recorded on the parent', async () => {
    const env = makeEnv();
    await dispatched(env);
    const t = workerTranscript([{ command: 'npm test', failed: true }]);
    writeFileSync(t.parent, [...bashLines('p', 'npm test', 'pass'), ''].join('\n'));
    const post = await run(env, postWith(workerReply(), t));
    expect(context(post)).not.toContain(ACCEPTED);
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'incomplete', verification: { contradicted: ['#1'] } });
  });
});

describe('receipts', () => {

  it.each(['Stop', 'UserPromptSubmit'])('releases an unreturned reservation at %s exactly once', async event => {
    const dir = join(tmp, `trace-stale-${++transcriptSeq}`), env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    await seedDispatched(env);
    const boundary = event === 'Stop' ? { hook_event_name: event, session_id: 's1' } : promptEvent({ prompt_id: 'p2' });
    await run(env, boundary, fakeJev()); await run(env, boundary, fakeJev());
    const generations = [state(env).current, ...state(env).history];
    expect(generations.every(g => Object.keys(g.active).length === 0)).toBe(true);
    const receipts = generations.flatMap(g => g.receipts).filter(r => r.tool_use_id === 'toolu_1');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ verdict: 'unknown', verdict_reason: 'worker_no_result' });
    const rows = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    expect(rows.filter(r => r.phase === 'post' && r.verdict_reason === 'worker_no_result')).toHaveLength(1);
  });

  it.each([
    ['worker_check_failed', [{ check_id: 'npm test', result: 'pass', note: '' }, { check_id: 'npm run build', result: 'fail', note: '' }]],
    ['worker_check_not_run', [{ check_id: 'npm test', result: 'pass', note: '' }, { check_id: 'npm run build', result: 'not_run', note: '' }]],
    ['worker_check_duplicate', [{ check_id: 'npm test', result: 'pass', note: '' }, { check_id: 'npm test', result: 'pass', note: '' }]],
  ] as const)('never accepts %s despite an observed passing check', async (reason, checks) => {
    const env = makeEnv(); await seedDispatched(env);
    await run(env, workerPost('toolu_1', workerReply({ checks: JSON.parse(JSON.stringify(checks)) })));
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'incomplete', verdict_reason: reason });
  });

  it.each(['failed', 'cancelled'])('records a safe reason for native status %s', async status => {
    const dir = join(tmp, `trace-worker-status-${++transcriptSeq}`), env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    await seedDispatched(env);
    await run(env, workerPost('toolu_1', workerReply(), { tool_response: { status } }));
    expect(state(env).current.active).toEqual({});
    expect(state(env).current.receipts[0]).toMatchObject({ verdict: 'unknown', verdict_reason: status === 'cancelled' ? 'worker_cancelled' : 'worker_failed' });
    const rows = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    expect(rows.find(r => r.phase === 'post').verdict_reason).toBe(status === 'cancelled' ? 'worker_cancelled' : 'worker_failed');
  });

  it('releases the reservation and records an unknown receipt when the call fails', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedDispatched(env, fetchImpl);
    const r = await run(env, { ...workerPost('toolu_1', workerReply()), hook_event_name: 'PostToolUseFailure', error: 'Agent terminated early\nsecond line' });
    expect(r).toMatchObject({ kind: 'skip' });
    expect(state(env).current.active).toEqual({});
    expect(state(env).current.receipts[0]).toMatchObject({ task_id: 'single', contract_hash: '', verdict: 'unknown', verdict_reason: 'worker_failed' });
  });
});

describe('native mode', () => {
  it('makes no request and lets the coordinator start a bounded worker as called', async () => {
    const env = makeEnv({ JEV_GATE_MODE: 'native' });
    const fetchImpl = fakeJev();
    const guidance = await run(env, promptEvent(), fetchImpl);
    expect(context(guidance)).not.toMatch(/planner|JEV_TASK/i);
    expect(state(env).current.shape).toBe('direct');
    // #289: with no planner to start orchestration from, a native worker call is the bounded one, left as called.
    expect(await run(env, preEvent('Agent', agentInput()), fetchImpl)).toMatchObject({ kind: 'preserve', code: 'mode_native', stdout: null });
    expect(Object.keys(state(env).current.active)).toEqual(['toolu_1']);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    expect(state(env).current.active).toEqual({});
    expect(await run(env, preEvent('Bash', {}), fetchImpl)).toMatchObject({ kind: 'skip', code: 'not_agent_tool' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('initializes the orchestrated arm from the experiment variable with no request', async () => {
    const env = makeEnv({ JEV_GATE_MODE: 'native', JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' });
    const fetchImpl = fakeJev();
    const r = await run(env, promptEvent(), fetchImpl);
    expect(context(r)).toContain('Dispatch this request once, whole, to jev-gate:worker');
    expect(context(r)).not.toContain('JEV_TASK');
    expect(state(env).current).toMatchObject({ shape: 'orchestrated', execution: 'single' });
    expect(await run(env, preEvent('Edit', {}), fetchImpl)).toMatchObject({ kind: 'skip', code: 'not_agent_tool' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('traces', () => {
  it('does not price an Agent aggregate as one long-context request', async () => {
    const dir = mkdtempSync(join(tmp, 'aggregate-trace-'));
    const env = makeEnv({ JEV_GATE_MODE: 'native', JEV_GATE_TRACE_DIR: dir });
    await run(env, { hook_event_name: 'PostToolUse', session_id: 's', prompt_id: 'p', tool_name: 'Agent', tool_use_id: 'call',
      tool_input: { subagent_type: 'general-purpose', model: 'haiku', prompt: 'bounded work' },
      tool_response: { status: 'completed', resolvedModel: 'claude-haiku-5-5', modelsUsed: ['claude-haiku-5-5'],
        usage: { input_tokens: 150000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3000 } } });
    const post = readdirSync(dir).map(file => JSON.parse(readFileSync(join(dir, file), 'utf8'))).find(r => r.phase === 'post');
    expect(post.tool_response).toMatchObject({ accounting_scope: 'agent_aggregate', accounting: { input: 150000, output: 3000 }, cost: { usd: null, reason: 'aggregate_request_prices_unknown' } });
  });
  it('records both gate phases and the result without the prompt or the key', async () => {
    const dir = join(tmp, 'trace-full');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev();
    await seedDispatched(env, fetchImpl);
    await run(env, preEvent('Bash', { command: 'ls' }), fetchImpl);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    const phases = readdirSync(dir).map((f) => f.split('-')[0]);
    for (const phase of ['admission', 'pre', 'post']) expect(phases.join(' '), phase).toContain(phase);
    // #289: nothing writes a guard or plan phase any more, and T11: nor a result or scope phase.
    for (const gone of ['guard', 'plan', 'result_intent', 'result_result', 'scope_intent', 'scope_result']) expect(readdirSync(dir).some((f) => f.startsWith(`${gone}-`)), gone).toBe(false);
    // JG5-06: every attempted gate records the decision it applied, so accounting never re-derives policy.
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    const attempted = (phase: string, role?: string): Record<string, unknown> | undefined =>
      records.find((r) => r['phase'] === phase && r['attempted'] === true && (role === undefined || r['role'] === role));
    // A17 item 6: every gate records its decision in the same place, nested under `decision`.
    expect(attempted('admission_result')).toMatchObject({ forced: false, decision: { shape: 'orchestrated', decided: true, reason: null, changed_default: true } });
    // Atomic Gate B (the default since 0.4.0) composes to the tier the coordinator called here, so it keeps it.
    expect(attempted('pre_result', 'worker')).toMatchObject({
      decision: { action: 'preserve', tier: 'standard', reason: 'route_not_fast' },
    });
    // A17 item 7: every gate records whether it changed what would have happened without it.
    expect(attempted('pre_result', 'worker')).toMatchObject({ decision: { changed_default: false } });
    const all = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('settings page');
    expect(all).toContain('"version": 5');
  });

  it('records changed_default true only when the applied outcome differs from the no-Jev outcome (A17)', async () => {
    const dir = join(tmp, 'trace-changed');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir, CLAUDE_PLUGIN_OPTION_ROUTERALLOWFABLE: 'true' });
    const fetchImpl = fakeJev({ route: 'deep', basis: 'unresolved_contract_reasoning' });
    await seedDispatched(env, fetchImpl);
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    const decision = (role: string): Record<string, unknown> =>
      (records.find((r) => r['phase'] === 'pre_result' && r['attempted'] === true && r['role'] === role)?.['decision'] ?? {}) as Record<string, unknown>;
    // Worker: deep instead of the called standard profile.
    expect(decision('worker')).toMatchObject({ tier: 'deep', changed_default: true });
  });

  it('preserves the policy execution when optional intent recording fails', async () => {
    const file = join(tmp, 'not-a-dir');
    writeFileSync(file, 'x');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: join(file, 'sub') });
    const fetchImpl = fakeJev();
    const r = await run(env, promptEvent(), fetchImpl);
    expect(r.kind).toBe('guidance');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /**
   * #48 P0-2: this is the exact shape 22 Fable runs went unrecorded in -- a root-caller Agent call for which no job
   * ever started (no promptEvent, so no state at all for this session), meaning `handlePostToolUse` used to return
   * `skip('no_state')` with no trace write. `requested_model` reads the agent's frontmatter model (opus); `resolved_model`
   * reads what the host actually reported (fable): the gap between the two is exactly what went unobserved before.
   */
  it('records subagent_type, requested_model and resolved_model for a native call with no job state', async () => {
    const dir = join(tmp, 'trace-no-job');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const r = await run(
      env,
      workerPost('toolu_native', workerReply(), {
        tool_input: { subagent_type: 'jev-gate:worker-frontier' },
        tool_response: { status: 'completed', resolvedModel: 'fable', content: [{ type: 'text', text: fence(workerReply()) }] },
      }),
    );
    expect(r).toMatchObject({ kind: 'skip', code: 'no_state' });
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    const post = records.find((rec) => rec['phase'] === 'post' && rec['job_state'] === 'absent');
    expect(post).toMatchObject({ matched: false, subagent_type: 'jev-gate:worker-frontier', requested_model: 'claude-fable-5-1', resolved_model: 'fable' });
  });

  /** #48 P0-2 review: an unpatched call runs on the frontmatter, so the owner's own model table is not what it requested. */
  it('reports the frontmatter model, not the configured tier model, for an unpinned call the hook did not patch', async () => {
    const dir = join(tmp, 'trace-no-job-configured');
    const cfg = join(tmp, 'models-sonnet-frontier.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        version: 5,
        mode: 'auto',
        models: { fast: 'haiku', standard: 'sonnet', deep: 'opus', frontier: 'sonnet' },
      }),
    );
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir, JEV_GATE_CONFIG: cfg });
    await run(env, workerPost('toolu_native', workerReply(), { tool_input: { subagent_type: 'jev-gate:worker-frontier' }, tool_response: { status: 'completed', resolvedModel: 'opus', content: [] } }));
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    expect(records.find((rec) => rec['phase'] === 'post')).toMatchObject({ requested_model: 'claude-fable-5-1', resolved_model: 'opus' });
  });

  it('records the same fields for a PostToolUseFailure with no job state', async () => {
    const dir = join(tmp, 'trace-failure-no-job');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    await run(env, { hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Agent', tool_use_id: 'toolu_x', tool_input: { subagent_type: 'jev-gate:worker-frontier' }, error: 'boom' });
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    const failure = records.find((rec) => rec['phase'] === 'failure');
    expect(failure).toMatchObject({ subagent_type: 'jev-gate:worker-frontier', requested_model: 'claude-fable-5-1', resolved_model: null });
  });

  it('#233: records only a closed Codex failure category and stage, never an invented one', async () => {
    const dir = join(tmp, 'trace-failure-codex-category');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    await run(env, { hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Agent', tool_use_id: 'ok', error: 'native_start_rejected', codex_failure: { category: 'native_start_rejected', stage: 'thread_start', not_executed: true } });
    await run(env, { hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Agent', tool_use_id: 'raw', error: 'boom', codex_failure: { category: 'secret /home/user/path', stage: 'thread_start', not_executed: true } });
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>).filter((rec) => rec['phase'] === 'failure');
    expect(records.find((rec) => rec['tool_use_id'] === 'ok')).toMatchObject({ failure_category: 'native_start_rejected', failure_stage: 'thread_start', not_executed: true });
    expect(records.find((rec) => rec['tool_use_id'] === 'raw')).not.toHaveProperty('failure_category');
  });

  it('records subagent_type and resolved_model on an orchestrated worker-result post record too', async () => {
    const dir = join(tmp, 'trace-orchestrated-post');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev();
    await seedDispatched(env, fetchImpl);
    await run(env, workerPost('toolu_1', workerReply()), fetchImpl);
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    const post = records.find((rec) => rec['phase'] === 'post' && rec['task_id'] === 'single');
    expect(post).toMatchObject({ subagent_type: 'jev-gate:worker', requested_model: 'sonnet', resolved_model: 'claude-sonnet-5', verdict: 'accept' });
  });

  it('#53 review: an orchestrated worker post record keeps an explicit model pin as requested_model', async () => {
    const dir = join(tmp, 'trace-orchestrated-pin');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev();
    await seedDispatched(env, fetchImpl, { model: 'haiku' });
    await run(env, workerPost('toolu_1', workerReply(), { tool_input: { subagent_type: 'jev-gate:worker', model: 'haiku' } }), fetchImpl);
    const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    expect(records.find((rec) => rec['phase'] === 'post' && rec['task_id'] === 'single')).toMatchObject({ requested_model: 'haiku' });
  });

  it('writes no trace record at all in mode off, even with JEV_GATE_TRACE_DIR set', async () => {
    const dir = join(tmp, 'trace-mode-off');
    const env = makeEnv({ JEV_GATE_MODE: 'off', JEV_GATE_TRACE_DIR: dir });
    await run(env, promptEvent(), fakeJev());
    await run(env, workerPost('toolu_1', workerReply()));
    expect(existsSync(dir)).toBe(false);
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
    // A foreground profile, so the one code is the missing key rather than the background-only host refused before it.
    const guidance = exec(promptEvent(), { JEV_GATE_MODE: 'auto', CLAUDE_CODE_FORK_SUBAGENT: '0' });
    expect(guidance.status).toBe(0);
    expect(guidance.stdout.trim().split('\n')).toHaveLength(1);
    expect(guidance.stderr).toBe('jev-gate: key_missing\n');
    expect(exec(preEvent('Agent', agentInput()), {})).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: mode_off\n' });
    expect(exec('{not json', { JEV_GATE_MODE: 'auto' })).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: stdin_invalid_json\n' });
    const big = exec('{"hook_event_name":"PreToolUse","prompt":"' + 'y'.repeat(300 * 1024) + '"}', { JEV_GATE_MODE: 'auto' });
    expect(big).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: stdin_too_large\n' });
  });

  // #257: retention ran only when the evidence server started, so a session without it kept every record.
  it('prunes trace records older than the retention window at SessionStart, without the evidence server', async () => {
    const traces = mkdtempSync(join(tmp, 'proc-traces-'));
    const old = join(traces, 'post-00000000-0000-4000-8000-000000000000.json'), fresh = join(traces, 'post-11111111-1111-4111-8111-111111111111.json');
    writeFileSync(old, '{}'); writeFileSync(fresh, '{}');
    const past = (Date.now() - 15 * 86_400_000) / 1000;
    utimesSync(old, past, past);
    expect(exec({ hook_event_name: 'SessionStart', session_id: 's1' }, { JEV_GATE_MODE: 'auto', JEV_GATE_TRACE_DIR: traces }).status).toBe(0);
    await vi.waitFor(() => expect(existsSync(old)).toBe(false), { timeout: 10_000, interval: 50 });
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(traces, '.retention'))).toBe(true);
  });

  it('registers one command per event, PreToolUse without a matcher and Stop present', () => {
    const hooks = JSON.parse(readFileSync(join(dist, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    };
    // Exactly the six events the V5 gate dispatches, all commanding dist/entry.js (#48 P2), which dynamically
    // imports dist/hook.js only once it knows the gate might be on (src/entry.ts). SessionStart (#48 P2) is the
    // liveness warning; the `^Grep$` group was the withdrawn search filter's, and nothing registers it any more --
    // adding one back would run this hook on every search result.
    expect(Object.keys(hooks.hooks).sort()).toEqual(['PostCompact', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit', 'WorktreeCreate']);
    // The classic Compact hooks are a second entry point (dist/compact-hook.js), on PreCompact, PostCompact and
    // SessionStart's `compact` source only; the gate's own SessionStart group is the other one.
    for (const event of ['PreCompact', 'PostCompact']) expect(hooks.hooks[event], event).toEqual([{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/compact-hook.js"', timeout: 10 }] }]);
    expect(hooks.hooks['SessionStart']).toHaveLength(2);
    expect(hooks.hooks['SessionStart']!.find((g) => g.matcher === 'compact')).toEqual({ matcher: 'compact', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/compact-hook.js"', timeout: 10 }] });
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionStart']) {
      const gate = hooks.hooks[event]!.filter((g) => g.matcher !== 'compact');
      expect(gate, event).toHaveLength(1);
      for (const group of gate) expect(group.hooks).toEqual([{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/entry.js"', timeout: 5 }]);
    }
    expect(hooks.hooks['UserPromptSubmit']![0]!.matcher).toBeUndefined();
    expect(hooks.hooks['PreToolUse']![0]!.matcher).toBeUndefined();
    expect(hooks.hooks['Stop']![0]!.matcher).toBeUndefined();
    expect(hooks.hooks['SessionStart']![0]!.matcher).toBeUndefined();
    expect(hooks.hooks['PostToolUse']!.map((g) => g.matcher)).toEqual(['^(Agent|TaskStop)$']);
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
      expect(src, f).not.toMatch(/subagent_type|jev-gate:worker|Claude|claude/);
    }
  });

  it('keeps every agent definition in step with OWNED_AGENTS', () => {
    const files = readdirSync(join(__dirname, '..', 'agents')).filter((f) => f.endsWith('.md'));
    expect(files.sort()).toEqual(['worker-deep.md', 'worker-fast.md', 'worker-frontier.md', 'worker.md']);
    const workerBodies = new Set<string>();
    for (const f of files) {
      const text = readFileSync(join(__dirname, '..', 'agents', f), 'utf8');
      const body = text.slice(text.indexOf('\n---', 4) + 4);
      // No `tools:` allowlist, so connected MCPs stay inherited; delegation is withheld instead.
      expect(text, f).not.toMatch(/^tools:/m);
      expect(text, f).toMatch(/^disallowedTools: Agent, SendMessage, /m);
      expect(text, f).toContain('background: false');
      workerBodies.add(body);
      expect(body.match(/```json\n/g), f).toHaveLength(1);
    }
    expect(workerBodies.size).toBe(1);
  });
});

describe('state recovery', () => {
  it('leaves root tools alone and lets a worker call through, unreserved, over corrupt state', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev());
    mkdirSync(join(String(env['JEV_GATE_STATE_DIR']), 'jev-gate', 'jobs'), { recursive: true });
    writeFileSync(jobPath(env, 's1'), '{"version":5,"session_id":"s1","curren');
    expect(await run(env, preEvent('Bash', {}), fakeJev())).toMatchObject({ kind: 'skip', code: 'not_agent_tool' });
    const worker = await run(env, preEvent('Agent', agentInput()), fakeJev());
    // The call runs as a bounded worker the coordinator owns; the unreadable file is reported, never overwritten.
    expect(worker).toMatchObject({ kind: 'preserve' });
    expect(readJob(env, 's1')).toEqual({ ok: false, code: 'state_corrupt' });
  });

  it('leaves root tools alone for an unreadable state file of any kind', async () => {
    const env = makeEnv();
    mkdirSync(join(String(env['JEV_GATE_STATE_DIR']), 'jev-gate', 'jobs'), { recursive: true });
    const real = join(tmp, `symlink-target-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(real, '{}');
    symlinkSync(real, jobPath(env, 's1'));
    expect(await run(env, preEvent('Bash', {}), fakeJev())).toMatchObject({ kind: 'skip', code: 'not_agent_tool' });
  });

  it('treats a call with no prompt identity over corrupt state the same way (A2)', async () => {
    const env = makeEnv();
    mkdirSync(join(String(env['JEV_GATE_STATE_DIR']), 'jev-gate', 'jobs'), { recursive: true });
    writeFileSync(jobPath(env, 's1'), '{"version":5,"session_id":"s1","curren');
    const noPrompt = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: {} };
    expect(await run(env, noPrompt, fakeJev())).toMatchObject({ kind: 'skip' });
    const worker = await run(env, { ...preEvent('Agent', agentInput()), prompt_id: undefined }, fakeJev());
    expect(worker).toMatchObject({ kind: 'preserve' });
    expect(readJob(env, 's1')).toEqual({ ok: false, code: 'state_corrupt' });
  });
});

describe('host-observed input shapes', () => {
  it('reads the object-shaped effort the host actually sends, so the receipt records a root effort', async () => {
    const env = makeEnv();
    const fetchImpl = fakeJev();
    await seedDispatched(env, fetchImpl);
    await run(env, workerPost('toolu_1', workerReply(), { effort: { level: 'xhigh' } }), fetchImpl);
    expect(state(env).current.receipts[0]).toMatchObject({ task_id: 'single', root_effort: 'xhigh' });
  });
});

describe('R15: the simple paths this change must not break', () => {
  it('leaves off, native, pins and cancellation exactly as they were', async () => {
    // off: no request, no state, no output.
    const off = makeEnv({ JEV_GATE_MODE: 'off' });
    const offFetch = fakeJev();
    expect(await run(off, promptEvent(), offFetch)).toMatchObject({ kind: 'skip', code: 'mode_off' });
    expect(offFetch).not.toHaveBeenCalled();
    expect(existsSync(jobPath(off, 's1'))).toBe(false);

    // native: a worker call with no Jev request at all, left as called.
    const native = makeEnv({ JEV_GATE_MODE: 'native' });
    const nativeFetch = fakeJev();
    await run(native, promptEvent(), nativeFetch);
    expect(await run(native, preEvent('Agent', agentInput()), nativeFetch)).toMatchObject({ kind: 'preserve', code: 'mode_native', stdout: null });
    expect(nativeFetch).not.toHaveBeenCalled();

    // a user pin keeps its model and still receives the request; a root tool gets no decision (#289).
    const pinned = makeEnv();
    const fetchImpl = fakeJev();
    const pin = await seedDispatched(pinned, fetchImpl, { model: 'haiku' });
    expect(pin).toMatchObject({ kind: 'patch', code: 'pinned' });
    expect(updatedInput(pin)).toMatchObject({ model: 'haiku' });
    expect(await run(pinned, preEvent('Edit', {}), fetchImpl)).toMatchObject({ kind: 'skip', code: 'not_agent_tool' });
    // A cancelled call is recorded as unknown and releases its reservation, as before.
    const cancelled = await run(pinned, workerPost('toolu_1', workerReply(), { tool_response: { status: 'cancelled', content: [] } }), fetchImpl);
    expect(context(cancelled)).toContain('no usable reply');
    expect(state(pinned).current.active).toEqual({});
  });

  it('still reads a job the removed planner path wrote, and lets its reservations close (#289)', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev());
    const current = state(env).current;
    // A generation in the shape the hierarchy wrote: phase, plan, planner attempts, an active planner and no execution.
    const legacy = {
      version: 5,
      session_id: 's1',
      updated_at: new Date().toISOString(),
      current: {
        ...current,
        execution: undefined,
        phase: 'planning',
        plan: null,
        planner_tier: 'deep',
        attempts: { planner: 1, replans: 0, tasks: {} },
        active: { toolu_plan: { role: 'planner', task_id: null, contract_hash: null, rev: null, tier: 'deep', attempt: 1, deliverables: [], started_at: new Date().toISOString() } },
        receipts: [{ task_id: 't1', contract_hash: 'h', rev: 1, attempt: 1, tool_use_id: 'toolu_old', provenance: 'worker_reported', reply: null, verdict: 'accept', verdict_reason: null, advisory: 'accept', observed_model: null, root_effort: null, recorded_at: new Date().toISOString() }],
      },
      history: [],
    };
    writeFileSync(jobPath(env, 's1'), JSON.stringify(legacy));
    expect(readJob(env, 's1').ok).toBe(true);
    // The planner's result releases its reservation instead of leaving the turn waiting on it.
    const post = await run(env, { hook_event_name: 'PostToolUse', session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', tool_use_id: 'toolu_plan', tool_input: { subagent_type: 'jev-gate:planner' }, tool_response: { status: 'completed', content: [{ type: 'text', text: 'a plan' }] } });
    expect(post.kind).not.toBe('deny');
    expect(state(env).current.active).toEqual({});
    // The historical receipt is preserved as it was recorded, not rewritten.
    expect(state(env).current.receipts[0]).toMatchObject({ advisory: 'accept', verdict: 'accept' });
    expect(await run(env, preEvent('Edit', {}))).toMatchObject({ kind: 'skip', code: 'not_agent_tool' });
    await run(env, { hook_event_name: 'Stop', session_id: 's1' });
    expect(state(env).current.outcome).not.toBeNull();
  });

});

describe('receipt selection and observation keys (2026-09-20)', () => {

  it('records the model each decision asked for, and records none where it asked for none', async () => {
    const dir = join(tmp, 'trace-model');
    const env = makeEnv({ JEV_GATE_TRACE_DIR: dir, CLAUDE_PLUGIN_OPTION_ROUTERALLOWFABLE: 'true' });
    const fetchImpl = fakeJev({ route: 'deep', basis: 'unresolved_contract_reasoning' });
    const patched = await seedDispatched(env, fetchImpl);
    const decision = (role: string): Record<string, unknown> =>
      (readdirSync(dir)
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
        .find((r) => r['phase'] === 'pre_result' && r['attempted'] === true && r['role'] === role)?.['decision'] ?? {}) as Record<string, unknown>;
    // A reader of a stored trace cannot know which `models` map was in force when it was written, and deriving the
    // model from the tier through today's map would answer a question about yesterday with today's configuration.
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
    await seedDispatched(env, fetchImpl);
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
    await run(env, promptEvent(), fakeJev({ execution: 'orchestrated', forbidsDelegation: 0.07, externalTools: 0.02, toolCalls: 3.6 }));
    const record = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>).find((x) => x['phase'] === 'admission_result');
    const answers = (record?.['answers'] ?? {}) as Record<string, Record<string, unknown>>;
    // The shipped Gate A decides on these numbers, so a trace without them says which questions were asked and not
    // what was answered -- the observation cannot reproduce its own decision.
    expect(answers['size']).toBeUndefined();
    expect(answers['task_context']).toMatchObject({ choice: 'self_contained' });
    expect(answers['tool_calls']).toMatchObject({ type: 'score', score: 3.6, choice: null });
    expect(answers['forbids_delegation']).toMatchObject({ type: 'noul', noul: 0.07 });
    expect(answers['external_tools']).toBeUndefined();
    expect(record?.['estimate']).toMatchObject({ turns: 41.5, cost_basis: 'tokens', saving_tokens: (41.5 - 11) * 406_000 - 41.5 * 40_000, cost_support: 1 });
  });

  it('records available Claude price components from native depth while keeping unobserved delegation costs unknown', async () => {
    const dir = join(tmp, 'trace-claude-partial-prices'); const env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    await run(env, promptEvent({ transcript_path: transcriptAt(406000, 'claude-opus-5-5[1m]') }), fakeJev());
    const record = readdirSync(dir).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))).find(r => r.phase === 'admission_result');
    expect(record?.estimate).toMatchObject({ cost_basis: 'tokens', cost: { savingUsd: null, components: { m1: expect.any(Number), m2: null, m3: null, m4: null, m5: null } } });
  });
});

describe('atomic required request delivery and root handoff (#108/#111)', () => {
  const envFor = () => {
    const cfg = join(tmp, `required-${compositeSeq++}.json`);
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', ...SERIAL_POLICY }));
    return makeEnv({ JEV_GATE_CONFIG: cfg });
  };
  it('supersedes the old generation before refusing an oversized new request, with HTTP0', async () => {
    const env = envFor();
    const fetchImpl = fakeJev();
    await run(env, promptEvent(), fetchImpl);
    const before = fetchImpl.mock.calls.length;
    const r = await run(env, promptEvent({ prompt_id: 'p2', prompt: 'r'.repeat(65537) }), fetchImpl);
    expect(r.code).toBe('admission_delivery_failed');
    expect(fetchImpl).toHaveBeenCalledTimes(before);
    expect(state(env).current).toMatchObject({ prompt_id: 'p2', shape: 'direct' });
    expect(state(env).current.admission_revision).toBeUndefined();
    expect(state(env).history[0]?.admission_revision).toBe('atomic-context-v1');
    expect((await run(env, preEvent('Edit', { file_path: 'src/a.ts' }), fetchImpl)).kind).toBe('skip');
  });
  it.each(['ASCII', '한국어😀"\\\n'])('uses UTF-8 boundaries for the actual minimum single packet: %s', (prefix) => {
    const fixed = Buffer.byteLength(composeSingleWorkerPrompt('', prefix, true), 'utf8');
    const request = prefix + 'r'.repeat(MAX_COMPOSED_BYTES - fixed);
    expect(Buffer.byteLength(composeSingleWorkerPrompt('', request, true), 'utf8')).toBe(MAX_COMPOSED_BYTES);
    return (async () => {
      const env = envFor();
      const fetchImpl = fakeJev();
      const r = await run(env, promptEvent({ prompt: request + 'r' }), fetchImpl);
      expect(r.code).toBe('admission_delivery_failed');
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(state(env).current.shape).toBe('direct');
    })();
  });
  it.each([-1, 0, 1])('checks the complete final packet before reservation or paid Gate B, byte delta %s', async (delta) => {
    const env = envFor();
    const fetchImpl = fakeJev();
    const brief = 'Do this.';
    const overhead = Math.max(
      ...(['fast', 'standard', 'deep', 'frontier'] as const).map((t) =>
        Buffer.byteLength(composeSingleWorkerPrompt(brief, '', true) + renderSingleRouteNote(t), 'utf8'),
      ),
    );
    const request = '한국어😀"\\\n' + 'r'.repeat(MAX_COMPOSED_BYTES - overhead - Buffer.byteLength('한국어😀"\\\n') + delta);
    await run(env, promptEvent({ prompt: request }), fetchImpl);
    expect(state(env).current.execution).toBe('single');
    const before = fetchImpl.mock.calls.length;
    const r = await run(env, preEvent('Agent', agentInput({ prompt: brief })), fetchImpl);
    if (delta <= 0) {
      expect(r.kind).toBe('patch');
      expect(String(updatedInput(r).prompt)).toContain(request);
      expect(state(env).current.active['toolu_1']).toBeDefined();
    } else {
      expect(r.kind).toBe('deny');
      expect(fetchImpl).toHaveBeenCalledTimes(before);
      expect(state(env).current.active).toEqual({});
      expect(state(env).current.attempts.tasks).toEqual({});
      expect(state(env).current.root_fallback_reason).toBe('delivery_failed');
      expect(String(hookOutput(r).permissionDecisionReason)).toContain('No worker attempt');
      expect((await run(env, preEvent('Bash', { command: 'npm test' }), fetchImpl)).kind).toBe('skip');
    }
  });
  it.each(['omitted', '한국어 원문 "x" 😀\n제약: 기존 이름 유지'])(
    'preserves a required original even on pinned model bypass: %s',
    async (request) => {
      const env = envFor();
      const fetchImpl = fakeJev();
      await run(env, promptEvent({ prompt: request }), fetchImpl);
      const r = await run(env, preEvent('Agent', agentInput({ prompt: 'Do this.', model: 'opus' })), fetchImpl);
      expect(updatedInput(r).model).toBe('opus');
      expect(String(updatedInput(r).prompt)).toContain(request);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(state(env).current.admission_revision).toBe('atomic-context-v1');
    },
  );
  it('does not release an active worker when another oversized dispatch arrives', async () => {
    const env = envFor();
    const fetchImpl = fakeJev();
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do this.' })), fetchImpl);
    const before = fetchImpl.mock.calls.length;
    const r = await run(
      env,
      preEvent('Agent', agentInput({ prompt: 'r'.repeat(MAX_COMPOSED_BYTES) }), { tool_use_id: 'toolu_2' }),
      fetchImpl,
    );
    expect(r.code).toBe('task_active');
    expect(fetchImpl).toHaveBeenCalledTimes(before);
    expect(Object.keys(state(env).current.active)).toEqual(['toolu_1']);
    expect(state(env).current.root_fallback).toBeUndefined();
  });
  it('hands the turn back only after terminal acceptance, keeps outcome undecided, and ignores a duplicate post', async () => {
    const env = envFor();
    const fetchImpl = fakeJev();
    await run(env, promptEvent(), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'Do this.' })), fetchImpl);
    const event = workerPost('toolu_1', workerReply({ checks: [{ check_id: 'npm test', result: 'pass', note: '' }] }));
    const post = await run(env, event, fetchImpl);
    expect(context(post)).toContain('confirmed command pass 1');
    expect(state(env).current).toMatchObject({ root_fallback: true, root_fallback_reason: 'accepted', outcome: null });
    expect((await run(env, preEvent('Bash', { command: 'npm test' }), fetchImpl)).kind).toBe('skip');
    expect((await run(env, preEvent('Edit', { file_path: 'src/a.ts' }), fetchImpl)).kind).toBe('skip');
    const receipt = state(env).current.receipts[0];
    await run(env, event, fetchImpl);
    expect(state(env).current.receipts).toEqual([receipt]);
    expect(state(env).current.outcome).toBeNull();
  });
});

describe('full candidate pair in the existing Gate B batch', () => {
  it('applies the sixth model/max to a worker without an extra Jev call', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev());
    const base = fakeJev();
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body));
      expect(Object.keys(req.questions.model.criteria)).toContain('fixture-F');
      const old = await (base as unknown as typeof fetch)(url, init); const body = await old.json() as {answers:Record<string,unknown>};
      for (const [name, q] of Object.entries(req.questions) as Array<[string, {type:string;criteria:Record<string,string>|string[]}]>) {
        if (name === 'model' || name === 'control' || name === 'action_risk') body.answers[name] = choice(Object.keys(q.criteria), name === 'model' ? 'fixture-F' : name === 'control' ? 'task_clear' : 'ordinary', 1);
        if (name.startsWith('effort_')) body.answers[name] = {type:'score', probabilities:Object.fromEntries((q.criteria as string[]).map((v,i)=>[i,v.startsWith('Maximum')?1:0]))};
      }
      return new Response(JSON.stringify(body));
    });
    const allocation = { candidates: () => ['A','B','C','D','E','F'].map(n=>({id:`fixture-${n}`,description:'fixture coding model',efforts:['high','max'],omitEffort:false})), allowed: (model:string)=>model.startsWith('fixture-') || model === 'opus', toolModel: () => 'opus' };
    const result = await run(env, preEvent('Agent',agentInput()), fetchImpl, {allocation});
    expect(result.kind).toBe('patch'); expect(updatedInput(result).model).toBe('opus'); expect(fetchImpl).toHaveBeenCalledOnce();
    expect(state(env).current.active['toolu_1']?.allocation_pair).toEqual({model:'fixture-F',effort_edit:{kind:'set',value:'max'}});
  });
  it('dispatches a retry one role above the model its failed attempt recorded, in the same batch', async () => {
    const env = makeEnv();
    await run(env, promptEvent(), fakeJev());
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body));
      const old = await (fakeJev() as unknown as typeof fetch)(url, init); const body = await old.json() as {answers:Record<string,unknown>};
      for (const [name, q] of Object.entries(req.questions) as Array<[string, {criteria:Record<string,unknown>|string[]}]>) {
        if (name === 'capability' || name === 'control' || name === 'action_risk') body.answers[name] = choice(Object.keys(q.criteria), name === 'capability' ? 'mechanical' : name === 'control' ? 'task_clear' : 'ordinary', 1);
        if (name.startsWith('effort_')) body.answers[name] = {type:'score', probabilities:Object.fromEntries((q.criteria as string[]).map((_,i)=>[i,i===0?1:0]))};
      }
      return new Response(JSON.stringify(body));
    });
    const ranks: Record<string, number> = { 'fixture-fast': 0, 'fixture-standard': 1, 'fixture-deep': 2 };
    const allocation = { candidates: () => Object.entries(ranks).map(([id, rank]) => ({ id, rank, description: 'fixture', efforts: ['low', 'high'], omitEffort: false })),
      canonical: (model: string) => model in ranks ? model : 'fixture-deep', allowed: () => true, toolModel: () => 'opus' };
    await run(env, preEvent('Agent', agentInput()), fetchImpl, { allocation });
    expect(state(env).current.active['toolu_1']?.allocation_pair?.model).toBe('fixture-fast');
    await run(env, workerPost('toolu_1', workerReply({ status: 'blocked' })), fetchImpl);
    await run(env, preEvent('Agent', agentInput({ prompt: 'redo' }), { tool_use_id: 'toolu_2' }), fetchImpl, { allocation });
    expect(state(env).current.active['toolu_2']?.allocation_pair?.model).toBe('fixture-standard');
  });
});

it.each([
  'Find all parseRecord declarations and callers in src/ and return file paths and line numbers. Do not edit.',
  'PR 본문 지금 코드에 맞게 고쳐줘',
])('admits one shallow bounded outcome to the fast worker using one Gate A batch and preserves the full request: %s', async prompt => {
  const cfg = join(tmp, 'bounded-tool.json'); writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', delegationDepthFloor: 0 }));
  const env = makeEnv({ JEV_GATE_CONFIG: cfg });
  const fetchImpl = fakeJev({ toolCalls: 1, boundedToolWork: .99 });
  const result = await run(env, promptEvent({ prompt, transcript_path: transcriptAt(1000) }), fetchImpl);
  expect(result.kind).toBe('guidance'); expect(result.stdout).toContain('jev-gate:worker-fast'); expect(result.stdout).not.toMatch(/planner/i);
  expect(fetchImpl).toHaveBeenCalledOnce(); expect(state(env).current).toMatchObject({ execution: 'single', request: prompt });
  const worker = await run(env, preEvent('Agent', { ...agentInput(), subagent_type: 'jev-gate:worker-fast', prompt: 'Complete the requested bounded outcome and verify it against the current source.' }), fakeJev({ route: 'fast' }));
  expect(worker.kind).toBe('patch'); expect(updatedInput(worker).model).toBeUndefined(); expect(updatedInput(worker).prompt).toContain(prompt);
  // The requested fast profile is already Haiku; preserve native frontmatter rather than add a redundant model pin.
});

it.each(['Do not delegate or use a subagent.', "Don't use workers.", 'No delegation.', '위임하지 마.', '워커를 사용하지 마.', '서브 에이전트 사용 금지.'])('honors an explicit delegation veto before HTTP even if forced or Jev would admit: %s', async veto => {
  for (const forced of [false, true]) {
    const env = makeEnv(forced ? { JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' } : {});
    const fetchImpl = fakeJev({ boundedToolWork: .99, forbidsDelegation: .48 });
    const result = await run(env, promptEvent({ prompt: `Find parseRecord in src/lookup.ts. ${veto}` }), fetchImpl);
    expect(result.code).toBe('admission_forbids_delegation'); expect(result.stdout).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled(); expect(state(env).current.shape).toBe('direct');
  }
});


describe('final allocation execution receipts', () => {
  it.each(['worker', 'failure'])('records the reserved host model for %s, even if the legacy profile is different', async role => {
    const dir = mkdtempSync(join(tmp, 'final-pair-trace-')), env = makeEnv({ JEV_GATE_TRACE_DIR: dir });
    const fetchImpl = fakeJev();
    await seedDispatched(env, fetchImpl);
    const tool = 'toolu_1';
    updateJob(env, 's1', prev => prev ? { ...prev, current: { ...prev.current, active: { ...prev.current.active, [tool]: { ...prev.current.active[tool]!, allocation_pair: { model: 'claude-sonnet-5-5', effort_edit: { kind: 'set', value: 'high' } } } } } } : null);
    if (role === 'failure') await run(env, { ...preEvent('Agent', agentInput()), hook_event_name: 'PostToolUseFailure', error: 'test failure' }, fetchImpl);
    else await run(env, workerPost(tool, workerReply()), fetchImpl);
    const records = readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')));
    expect(state(env).current.receipts.at(-1)?.requested_model).toBe('claude-sonnet-5-5');
    expect(records.find(r => r.phase === (role === 'failure' ? 'failure' : 'post'))?.requested_model).toBe('claude-sonnet-5-5');
  });
});
