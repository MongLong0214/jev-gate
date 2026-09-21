import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { runHook, type HookDeps, type HookResult } from '../src/hook.js';
import { readJob, updateJob } from '../src/job.js';
import { HANDOFF_SCOPE_ANSWERS, RELATION_ANSWERS, WORK_SHAPE_ANSWERS } from '../src/lean.js';
import { LEAN_EXECUTOR_AGENT } from '../src/types.js';

const KEY = 'ts-secret-key-123';
const tmp = mkdtempSync(join(tmpdir(), 'jev-lean-hook-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const choice = (keys: readonly string[], winner: string, confidence = 0.95): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === winner ? 0.9 : 0.1 / (keys.length - 1)])),
  confidence,
});

interface LeanAnswers {
  work?: string;
  scope?: string;
  /** Per-group relation; the default omits every group but the last. */
  relation?: (id: string, index: number, total: number) => string;
  model?: string | null;
  onCall?: (questions: string[], state: Record<string, unknown>) => void;
}

const fakeJev = (opts: LeanAnswers = {}): ReturnType<typeof vi.fn> =>
  vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown>; state: Record<string, unknown> };
    const questions = Object.keys(body.questions);
    opts.onCall?.(questions, body.state);
    const relations = questions.filter((q) => q.startsWith('relation_'));
    const answers: Record<string, unknown> = {
      work_shape: choice(WORK_SHAPE_ANSWERS, opts.work ?? 'sustained_task'),
      handoff_scope: choice(HANDOFF_SCOPE_ANSWERS, opts.scope ?? 'self_contained'),
    };
    relations.forEach((q, i) => {
      const id = q.slice('relation_'.length);
      answers[q] = choice(RELATION_ANSWERS, opts.relation ? opts.relation(id, i, relations.length) : i < relations.length - 1 ? 'omit' : 'keep');
    });
    const model = opts.model === undefined ? 'jev-1.13.0' : opts.model;
    return new Response(JSON.stringify({ model, answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  });

const stdinOf = (value: unknown): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield Buffer.from(JSON.stringify(value), 'utf8');
  })();

type Env = Record<string, string | undefined>;
const makeEnv = (over: Env = {}): Env => ({
  TYPESAFE_API_KEY: KEY,
  HOME: join(tmp, 'home'),
  JEV_GATE_MODE: 'lean',
  JEV_GATE_STATE_DIR: mkdtempSync(join(tmp, 'state-')),
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  ...over,
});

const run = (env: Env, event: unknown, fetchImpl?: unknown, extra: Partial<HookDeps> = {}): Promise<HookResult> =>
  runHook({ env, stdin: stdinOf(event), ...(fetchImpl ? { fetchImpl: fetchImpl as typeof fetch } : {}), ...extra });

const parse = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;
const hookOutput = (r: HookResult): Record<string, unknown> => (parse(r.stdout as string)['hookSpecificOutput'] ?? {}) as Record<string, unknown>;
const context = (r: HookResult): string => String(hookOutput(r)['additionalContext'] ?? '');
const updatedInput = (r: HookResult): Record<string, unknown> => hookOutput(r)['updatedInput'] as Record<string, unknown>;
const markerOf = (r: HookResult): string => /jev-lean-[0-9a-f]{16}/.exec(context(r))?.[0] ?? '';

let seq = 0;
const human = (uuid: string, content: string): unknown => ({ type: 'user', uuid, message: { role: 'user', content } });
const interaction = (n: number, file: string, body: string): unknown[] => [
  { type: 'assistant', uuid: `a${n}`, message: { role: 'assistant', content: [{ type: 'text', text: `reading ${file}` }, { type: 'tool_use', id: `tu${n}`, name: 'Read', input: { file_path: file } }] } },
  { type: 'user', uuid: `r${n}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${n}`, content: body }] } },
];
const writeTranscript = (entries: unknown[], path?: string): string => {
  const p = path ?? join(tmp, `t-${(seq += 1)}.jsonl`);
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
};

const REQUEST = '`parseQuote`의 반올림 버그를 고쳐줘. `as any`는 절대 쓰지 마.';
const CONSTRAINT = '예외: 기존 공용 컴포넌트는 수정하지 말 것';
const baseEntries = (): unknown[] => [
  human('u1', CONSTRAINT),
  ...interaction(1, 'src/quote.ts', 'export const parseQuote = (s: string) => Math.round(Number(s));'),
  ...interaction(2, 'docs/unrelated.md', 'a changelog entry from last year'),
  ...interaction(3, 'src/other.ts', 'unrelated helper'),
];

const promptEvent = (transcriptPath: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: 's1',
  prompt_id: 'p1',
  prompt: REQUEST,
  cwd: '/repo',
  transcript_path: transcriptPath,
  ...over,
});

const agentEvent = (marker: string, over: Record<string, unknown> = {}, inputOver: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: 'PreToolUse',
  session_id: 's1',
  tool_name: 'Agent',
  tool_use_id: 'tu-exec-1',
  cwd: '/repo',
  tool_input: { subagent_type: LEAN_EXECUTOR_AGENT, description: 'fix the rounding bug', prompt: `Fix the rounding bug.\n${marker}\n`, ...inputOver },
  ...over,
});

describe('lean — local checks before anything is sent', () => {
  it.each([
    ['off', { JEV_GATE_MODE: 'off' }],
    ['no key', { TYPESAFE_API_KEY: undefined }],
  ])('makes no request and reads no source with %s', async (_name, over) => {
    const fetchImpl = fakeJev();
    const r = await run(makeEnv(over), promptEvent(writeTranscript(baseEntries())), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.kind).toBe('skip');
    expect(r.stdout).toBeNull();
  });

  it('makes no request when there is no selectable optional evidence', async () => {
    const fetchImpl = fakeJev();
    const r = await run(makeEnv(), promptEvent(writeTranscript([human('u1', 'the only thing said so far')])), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.code).toBe('no_optional_groups');
  });

  it('stays native, without a request, when the source cannot be read', async () => {
    const fetchImpl = fakeJev();
    const r = await run(makeEnv(), promptEvent(join(tmp, 'absent.jsonl')), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.code).toBe('source_unavailable');
  });

  it('runs no legacy gate: no admission, route, planner or interpretation question is ever asked', async () => {
    const asked: string[] = [];
    const fetchImpl = fakeJev({ onCall: (q) => asked.push(...q) });
    await run(makeEnv(), promptEvent(writeTranscript(baseEntries())), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(asked).not.toContain('execution');
    expect(asked).not.toContain('route');
    expect(asked).not.toContain('planning_tier');
    expect(asked).not.toContain('size');
    expect(asked.filter((q) => q.startsWith('relation_')).length).toBeGreaterThan(0);
  });

  it('has no depth condition: a shallow session with removable evidence still qualifies', async () => {
    // Nothing in this transcript carries usage at all, so the legacy depth floor could never have admitted it.
    const r = await run(makeEnv(), promptEvent(writeTranscript(baseEntries())), fakeJev());
    expect(r.kind).toBe('guidance');
    expect(markerOf(r)).toMatch(/^jev-lean-[0-9a-f]{16}$/);
  });
});

describe('lean — the recommendation', () => {
  it('emits one short recommendation with an opaque marker and no packet', async () => {
    const r = await run(makeEnv(), promptEvent(writeTranscript(baseEntries())), fakeJev());
    const text = context(r);
    expect(text).toContain('jev-gate:executor');
    expect(text).toContain(markerOf(r));
    // The packet is never pasted into the root's context: that would pay for it twice.
    expect(text).not.toContain('parseQuote = (s: string)');
    expect(text).not.toContain(CONSTRAINT);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(1000);
  });

  it('stays native, keeping the call it already paid for, when nothing is actually omitted', async () => {
    const fetchImpl = fakeJev({ relation: () => 'keep' });
    const r = await run(makeEnv(), promptEvent(writeTranscript(baseEntries())), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.kind).toBe('skip');
    expect(r.code).toBe('no_effect');
  });

  it.each([
    ['short_step', { work: 'short_step' }],
    ['needs_missing_context', { scope: 'needs_missing_context' }],
    ['forbidden', { scope: 'forbidden' }],
    ['an unexpected model', { model: 'jev-9.9.9' }],
    ['no model at all', { model: null }],
  ])('stays native on %s', async (_name, over) => {
    const r = await run(makeEnv(), promptEvent(writeTranscript(baseEntries())), fakeJev(over as LeanAnswers));
    expect(r.kind).toBe('skip');
    expect(r.stdout).toBeNull();
  });

  it('records a native decision without leaving anything dispatchable', async () => {
    const env = makeEnv();
    await run(env, promptEvent(writeTranscript(baseEntries())), fakeJev({ work: 'short_step' }));
    const job = readJob(env, 's1');
    expect(job.ok && job.value?.current.lean).toMatchObject({ outcome: 'native', packet: '' });
  });
});

describe('lean — one request, one attempt', () => {
  it('reuses the decision when the same request is delivered twice instead of spending again', async () => {
    const env = makeEnv();
    const path = writeTranscript(baseEntries());
    const fetchImpl = fakeJev();
    const first = await run(env, promptEvent(path), fetchImpl);
    const second = await run(env, promptEvent(path), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(markerOf(second)).toBe(markerOf(first));
    expect(second.code).toBe('duplicate_request');
  });

  it('does not re-decide a duplicate of a request that already went native', async () => {
    const env = makeEnv();
    const path = writeTranscript(baseEntries());
    const fetchImpl = fakeJev({ work: 'short_step' });
    await run(env, promptEvent(path), fetchImpl);
    const again = await run(env, promptEvent(path), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(again.code).toBe('duplicate_request');
    expect(again.stdout).toBeNull();
  });

  it('a dispatched packet is not offered again to a repeat of its own request', async () => {
    const env = makeEnv();
    const path = writeTranscript(baseEntries());
    const rec = await run(env, promptEvent(path), fakeJev());
    await run(env, agentEvent(markerOf(rec), { transcript_path: path }));
    const fetchImpl = fakeJev();
    const again = await run(env, promptEvent(path), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(again.code).toBe('lean_executor_active');
  });

  it('records an ignored recommendation at the next request rather than forcing it', async () => {
    const traceDir = mkdtempSync(join(tmp, 'trace-ignored-'));
    const env = makeEnv({ JEV_GATE_TRACE_DIR: traceDir });
    const path = writeTranscript(baseEntries());
    await run(env, promptEvent(path), fakeJev());
    await run(env, promptEvent(path, { prompt_id: 'p2', prompt: 'something else entirely' }), fakeJev());
    const bodies = readdirSync(traceDir).map((f) => readFileSync(join(traceDir, f), 'utf8')).join('\n');
    expect(bodies).toContain('recommendation_not_taken');
  });
});

describe('lean — applying the packet to the owned call', () => {
  const recommendAndDispatch = async (
    env: Env,
    entries: unknown[] = baseEntries(),
    opts: { dispatchEntries?: unknown[]; inputOver?: Record<string, unknown>; jev?: LeanAnswers } = {},
  ): Promise<{ recommendation: HookResult; dispatch: HookResult; transcriptPath: string }> => {
    const path = writeTranscript(entries);
    const recommendation = await run(env, promptEvent(path), fakeJev(opts.jev ?? {}));
    if (opts.dispatchEntries) writeTranscript(opts.dispatchEntries, path);
    const dispatch = await run(env, agentEvent(markerOf(recommendation), { transcript_path: path }, opts.inputOver ?? {}));
    return { recommendation, dispatch, transcriptPath: path };
  };

  it('patches the prompt with the packet and preserves every other field of the original input', async () => {
    const { dispatch } = await recommendAndDispatch(makeEnv(), baseEntries(), { inputOver: { run_in_background: false, description: 'fix the rounding bug' } });
    expect(dispatch.kind).toBe('patch');
    const patched = updatedInput(dispatch);
    expect(patched['subagent_type']).toBe(LEAN_EXECUTOR_AGENT);
    expect(patched['description']).toBe('fix the rounding bug');
    expect(patched['run_in_background']).toBe(false);
    // No model is added: the executor profile inherits, and a saving from a cheaper model would not be this feature's.
    expect(Object.prototype.hasOwnProperty.call(patched, 'model')).toBe(false);
    // The coordinator's own text survives as the prefix; the packet is appended as lower-authority context.
    expect(String(patched['prompt']).startsWith('Fix the rounding bug.')).toBe(true);
  });

  it('carries the exact request, the exception and the code anchors into the worker prompt', async () => {
    const { dispatch } = await recommendAndDispatch(makeEnv());
    const prompt = String(updatedInput(dispatch)['prompt']);
    expect(prompt).toContain(REQUEST);
    expect(prompt).toContain(CONSTRAINT);
    expect(prompt).toContain('export const parseQuote = (s: string) => Math.round(Number(s));');
    // The request appears once in the packet the hook composed.
    expect(prompt.split(REQUEST).length - 1).toBe(1);
    expect(prompt).toContain('earlier interaction group');
  });

  it('never returns permissionDecision=allow on the patch path', async () => {
    const { dispatch } = await recommendAndDispatch(makeEnv());
    expect(JSON.stringify(parse(dispatch.stdout as string))).not.toContain('permissionDecision');
  });

  it('leaves an ordinary assistant/tool append for the same request valid', async () => {
    const { dispatch } = await recommendAndDispatch(makeEnv(), baseEntries(), {
      dispatchEntries: [...baseEntries(), human('u9', REQUEST), ...interaction(7, 'src/quote.ts', 'reading again')],
    });
    expect(dispatch.kind).toBe('patch');
  });

  it.each([
    ['a new human instruction', () => [...baseEntries(), human('u9', REQUEST), human('u10', 'stop, do something else')]],
    ['a compaction', () => [
      ...baseEntries(),
      { type: 'system', uuid: 'b1', subtype: 'compact_boundary', compactMetadata: { preservedSegment: { headUuid: 'a3', anchorUuid: 's1', tailUuid: 'r3' } } },
      { type: 'user', uuid: 's1', isCompactSummary: true, message: { role: 'user', content: 'Summary: ...' } },
      human('u9', REQUEST),
    ]],
    ['a destructive rewrite of earlier source', () => [human('u1', 'a completely different constraint'), ...interaction(1, 'src/quote.ts', 'x'), ...interaction(2, 'y.md', 'y'), ...interaction(3, 'z.ts', 'z')]],
  ])('denies the dispatch after %s', async (_name, entries) => {
    const { dispatch } = await recommendAndDispatch(makeEnv(), baseEntries(), { dispatchEntries: entries() });
    expect(dispatch.kind).toBe('deny');
    expect(dispatch.code).toBe('marker_stale');
  });

  it('denies a packet built in a different working tree', async () => {
    const env = makeEnv();
    const path = writeTranscript(baseEntries());
    const rec = await run(env, promptEvent(path), fakeJev());
    const dispatch = await run(env, agentEvent(markerOf(rec), { transcript_path: path, cwd: '/some/other/worktree' }));
    expect(dispatch.kind).toBe('deny');
    expect(dispatch.code).toBe('marker_stale');
  });

  it('denies a marker-only call rather than running an empty task', async () => {
    const env = makeEnv();
    const r = await run(env, agentEvent('jev-lean-0123456789abcdef'));
    expect(r.kind).toBe('deny');
    expect(r.code).toBe('marker_unresolved');
  });

  it('denies an executor call with no marker at all', async () => {
    const r = await run(makeEnv(), agentEvent('', {}, { prompt: 'just do something' }));
    expect(r.kind).toBe('deny');
    expect(r.code).toBe('marker_unresolved');
  });

  it('applies the packet at most once: a duplicate dispatch of the same marker is denied', async () => {
    const env = makeEnv();
    const { dispatch, recommendation, transcriptPath } = await recommendAndDispatch(env);
    expect(dispatch.kind).toBe('patch');
    const again = await run(env, agentEvent(markerOf(recommendation), { transcript_path: transcriptPath, tool_use_id: 'tu-exec-2' }));
    expect(again.kind).toBe('deny');
  });

  it.each([
    ['a model pin', { model: 'haiku' }],
    ['a background run', { run_in_background: true }],
    ['a resume control', { resume: 'agent-1' }],
    ['a fork control', { fork: true }],
  ])('refuses rather than half-patching a call carrying %s', async (_name, inputOver) => {
    const { dispatch } = await recommendAndDispatch(makeEnv(), baseEntries(), { inputOver });
    expect(dispatch.kind).toBe('deny');
    // A call-shape problem is not a stale packet: the two say different things to whoever reads the trace.
    expect(dispatch.code).toBe('dispatch_ineligible');
  });

  it('refuses when the packet plus this call’s own notes exceeds the prompt bound', async () => {
    const env = makeEnv();
    const path = writeTranscript([human('u1', 'x'.repeat(20 * 1024)), ...interaction(1, 'a.ts', 'y'.repeat(20 * 1024)), ...interaction(2, 'b.ts', 'z'.repeat(1024))]);
    const rec = await run(env, promptEvent(path), fakeJev());
    expect(rec.kind).toBe('guidance');
    const notes = `${'n'.repeat(40 * 1024)}\n${markerOf(rec)}\n`;
    const dispatch = await run(env, agentEvent(markerOf(rec), { transcript_path: path }, { prompt: notes }));
    expect(dispatch.kind).toBe('deny');
    expect(dispatch.code).toBe('composed_too_large');
  });
});

describe('lean — one executor, and everything else untouched', () => {
  it('does not start a second automatic executor while the first has not been observed to finish', async () => {
    const env = makeEnv();
    const path = writeTranscript(baseEntries());
    const first = await run(env, promptEvent(path), fakeJev());
    await run(env, agentEvent(markerOf(first), { transcript_path: path }));
    const fetchImpl = fakeJev();
    const second = await run(env, promptEvent(path, { prompt_id: 'p2', prompt: 'another request entirely' }), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(second.code).toBe('lean_executor_active');
  });

  it('a new prompt cannot certify a running worker finished; only an observed terminal event releases it', async () => {
    const env = makeEnv();
    const path = writeTranscript(baseEntries());
    const first = await run(env, promptEvent(path), fakeJev());
    await run(env, agentEvent(markerOf(first), { transcript_path: path }));
    await run(env, promptEvent(path, { prompt_id: 'p2', prompt: 'another request entirely' }), fakeJev());
    const stillActive = readJob(env, 's1');
    expect(Object.keys(stillActive.ok ? (stillActive.value?.current.active ?? {}) : {})).toEqual(['tu-exec-1']);

    await run(env, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Agent', tool_use_id: 'tu-exec-1', tool_response: { status: 'completed', content: [{ type: 'text', text: 'I changed src/quote.ts and ran npm test: 12 passed.' }] } });
    const released = readJob(env, 's1');
    expect(Object.keys(released.ok ? (released.value?.current.active ?? {}) : {})).toEqual([]);
  });

  it('a late result from an interrupted old worker does not complete a different call', async () => {
    const env = makeEnv();
    const path = writeTranscript(baseEntries());
    const first = await run(env, promptEvent(path), fakeJev());
    await run(env, agentEvent(markerOf(first), { transcript_path: path }));
    await run(env, { hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Agent', tool_use_id: 'tu-someone-else', error: 'boom' });
    const job = readJob(env, 's1');
    expect(Object.keys(job.ok ? (job.value?.current.active ?? {}) : {})).toEqual(['tu-exec-1']);
  });

  it('accepts a plaintext worker report without asking for a format correction', async () => {
    const env = makeEnv();
    const r = await run(env, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Agent', tool_use_id: 'tu-exec-1', tool_response: { status: 'completed', content: [{ type: 'text', text: 'no JSON here, just prose' }] } });
    expect(r.kind).toBe('skip');
    expect(r.stdout).toBeNull();
  });

  it('leaves other agents and other tools alone', async () => {
    const env = makeEnv();
    for (const event of [
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'rm -rf build' } },
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: 'a.ts' } },
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent', tool_use_id: 't3', tool_input: { subagent_type: 'general-purpose', prompt: 'go' } },
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent', tool_use_id: 't4', tool_input: { subagent_type: 'jev-gate:worker', prompt: 'go' } },
    ]) {
      const r = await run(env, event);
      expect(r.stdout).toBeNull();
    }
  });

  it('never blocks the root: an ignored recommendation leaves root tools untouched', async () => {
    const env = makeEnv();
    await run(env, promptEvent(writeTranscript(baseEntries())), fakeJev());
    const r = await run(env, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit', tool_use_id: 't9', tool_input: { file_path: 'src/quote.ts' } });
    expect(r.kind).toBe('skip');
    expect(r.stdout).toBeNull();
  });
});

describe('lean — profile and diagnostics', () => {
  it('a lean artifact with a legacy mode selected diagnoses instead of starting a guard for missing roles', async () => {
    const env = makeEnv({ JEV_GATE_MODE: 'auto' });
    const fetchImpl = fakeJev();
    const r = await run(env, promptEvent(writeTranscript(baseEntries())), fetchImpl, { argv: ['node', 'hook.js', '--lean'] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.code).toBe('profile_mode_mismatch');
    const guard = await run(env, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit', tool_use_id: 't1', tool_input: {} }, undefined, { argv: ['--lean'] });
    expect(guard.stdout).toBeNull();
  });

  it('writes safe identifiers and counts to a trace, never source text or the key', async () => {
    const traceDir = mkdtempSync(join(tmp, 'trace-'));
    const env = makeEnv({ JEV_GATE_TRACE_DIR: traceDir });
    await run(env, promptEvent(writeTranscript(baseEntries())), fakeJev());
    const bodies = readdirSync(traceDir).map((f) => readFileSync(join(traceDir, f), 'utf8')).join('\n');
    expect(bodies).toContain('lean_result');
    expect(bodies).not.toContain(KEY);
    expect(bodies).not.toContain('parseQuote = (s: string)');
    expect(bodies).not.toContain(CONSTRAINT);
  });
});

describe('lean — the installed entrypoint, not just the unit', () => {
  const packed = join(tmp, 'packed');
  const build = (): void => {
    if (existsSync(join(packed, 'dist', 'hook.js'))) return;
    const out = mkdtempSync(join(tmp, 'zip-'));
    expect(spawnSync('npm', ['run', 'build'], { cwd: process.cwd(), encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('node', ['scripts/pack.mjs', out, '--profile', 'lean'], { cwd: process.cwd(), encoding: 'utf8' }).status).toBe(0);
    mkdirSync(packed, { recursive: true });
    expect(spawnSync('unzip', ['-q', '-o', join(out, readdirSync(out)[0] as string), '-d', packed], { encoding: 'utf8' }).status).toBe(0);
  };

  it('ships exactly one agent definition, and it is the lean executor asking for an inherited model', () => {
    build();
    expect(readdirSync(join(packed, 'agents'))).toEqual(['executor.md']);
    const definition = readFileSync(join(packed, 'agents', 'executor.md'), 'utf8');
    expect(definition).toContain('model: inherit');
    expect(definition).toContain('disallowedTools: Agent');
    expect(definition).toContain('handoff_unavailable');
  });

  it('installs a hook command that runs the lean entrypoint', () => {
    build();
    const hooks = JSON.parse(readFileSync(join(packed, 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>> };
    expect(Object.keys(hooks.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'UserPromptSubmit']);
    for (const [event, matchers] of Object.entries(hooks.hooks)) {
      for (const m of matchers) {
        for (const h of m.hooks) {
          expect(h.command).toContain('dist/hook.js');
          expect(h.command).toContain('--lean');
          expect(h.timeout).toBeLessThanOrEqual(5);
        }
        if (event !== 'UserPromptSubmit') expect(m.matcher).toBe('^Agent$');
      }
    }
  });

  /** A packed hook run as the host runs it: a real child process, from another directory, over a path with spaces. */
  const runPacked = (env: Env, event: unknown): { stdout: string; stderr: string; status: number | null } => {
    build();
    const spaced = join(tmp, 'a path with spaces');
    if (!existsSync(spaced)) {
      mkdirSync(spaced, { recursive: true });
      spawnSync('cp', ['-R', packed + '/.', spaced], { encoding: 'utf8' });
    }
    const res = spawnSync('node', [join(spaced, 'dist', 'hook.js'), '--lean'], {
      cwd: tmpdir(),
      input: JSON.stringify(event),
      encoding: 'utf8',
      env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv,
    });
    return { stdout: res.stdout, stderr: res.stderr, status: res.status };
  };

  it('emits the recommendation from the packed entrypoint and applies the packet to the owned call', () => {
    const env = makeEnv({ PATH: process.env['PATH'] as string });
    const path = writeTranscript(baseEntries());
    // No fetch double reaches a child process, so the selection call fails and the turn stays native -- which is
    // itself the contract: the installed hook exits 0 and prints nothing that could disturb the session.
    const offline = runPacked(env, promptEvent(path));
    expect(offline.status).toBe(0);
    expect(offline.stdout.trim()).toBe('');

    // With a pending packet written by the in-process run, the packed PreToolUse is what actually patches the call.
    const inProcess = makeEnv({ JEV_GATE_STATE_DIR: env['JEV_GATE_STATE_DIR'] as string });
    // A new request identity: the packed offline attempt above already recorded its own native decision for p1.
    return run(inProcess, promptEvent(path, { prompt_id: 'p2' }), fakeJev()).then((rec) => {
      const dispatched = runPacked(env, agentEvent(markerOf(rec), { transcript_path: path }));
      expect(dispatched.status).toBe(0);
      const out = JSON.parse(dispatched.stdout) as { hookSpecificOutput: { updatedInput: Record<string, unknown> } };
      expect(String(out.hookSpecificOutput.updatedInput['prompt'])).toContain(REQUEST);
      expect(String(out.hookSpecificOutput.updatedInput['prompt'])).toContain(CONSTRAINT);
    });
  });

  it('the packed entrypoint with off or no key does no optional I/O and prints nothing', () => {
    for (const over of [{ JEV_GATE_MODE: 'off' }, { TYPESAFE_API_KEY: undefined }]) {
      const res = runPacked(makeEnv({ PATH: process.env['PATH'] as string, ...over }), promptEvent(writeTranscript(baseEntries())));
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('');
    }
  });
});

describe('lean — the no-Jev comparison arm (JGL-05 recent_packet)', () => {
  const recentEnv = (over: Env = {}): Env => makeEnv({ JEV_GATE_BENCH_RECENT: '1', TYPESAFE_API_KEY: undefined, ...over });

  it('recommends with no key and no request at all', async () => {
    const fetchImpl = fakeJev();
    const r = await run(recentEnv(), promptEvent(writeTranscript(baseEntries())), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.kind).toBe('guidance');
    expect(markerOf(r)).toMatch(/^jev-lean-/);
  });

  it('is selected only by its own variable: lean without it and without a key does nothing', async () => {
    const fetchImpl = fakeJev();
    const r = await run(makeEnv({ TYPESAFE_API_KEY: undefined }), promptEvent(writeTranscript(baseEntries())), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.code).toBe('key_missing');
    expect(r.stdout).toBeNull();
  });

  it('carries the same mandatory layer as the treatment and does not have to omit anything', async () => {
    const env = recentEnv();
    const path = writeTranscript(baseEntries());
    const rec = await run(env, promptEvent(path));
    const dispatch = await run(env, agentEvent(markerOf(rec), { transcript_path: path }));
    const prompt = String(updatedInput(dispatch)['prompt']);
    expect(prompt).toContain(REQUEST);
    expect(prompt).toContain(CONSTRAINT);
    // Everything fits here, so retaining all of it is valid; the arm is not degraded to manufacture a difference.
    expect(prompt).toContain('docs/unrelated.md');
    expect(context(rec)).toContain('0 earlier interaction groups');
  });

  it('fills the budget by recency instead of overflowing, and keeps the mandatory layer', async () => {
    const big = (n: number): string => `body ${n} ` + 'q'.repeat(20 * 1024);
    const env = recentEnv();
    const path = writeTranscript([human('u1', CONSTRAINT), ...interaction(1, 'old.ts', big(1)), ...interaction(2, 'mid.ts', big(2)), ...interaction(3, 'new.ts', big(3))]);
    const rec = await run(env, promptEvent(path));
    expect(rec.kind).toBe('guidance');
    const dispatch = await run(env, agentEvent(markerOf(rec), { transcript_path: path }));
    const prompt = String(updatedInput(dispatch)['prompt']);
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(prompt).toContain(CONSTRAINT);
    expect(prompt).toContain('new.ts');
    expect(prompt).not.toContain('old.ts');
  });

  it('stays native when even the mandatory layer does not fit the shared budget', async () => {
    const env = recentEnv();
    const r = await run(env, promptEvent(writeTranscript([human('u1', 'x'.repeat(70 * 1024)), ...interaction(1, 'a.ts', 'y')])));
    expect(r.kind).toBe('skip');
    expect(r.code).toBe('mandatory_overflow');
  });
});

describe('lean — state sharing with the legacy job file', () => {
  it('does not disturb a legacy generation it did not create', async () => {
    const env = makeEnv();
    updateJob(env, 's-legacy', (prev) => ({
      version: 5,
      session_id: 's-legacy',
      updated_at: '',
      current: { prompt_id: 'old', request: 'x', created_at: '', shape: 'orchestrated', phase: 'planned', planner_tier: null, planner_model: null, plan: null, active: {}, receipts: [], denials: 0, attempts: { planner: 0, replans: 0, tasks: {} }, outcome: null },
      history: prev?.history ?? [],
    }));
    const before = JSON.stringify(readJob(env, 's-legacy'));
    await run(env, promptEvent(writeTranscript(baseEntries())), fakeJev());
    expect(JSON.stringify(readJob(env, 's-legacy'))).toBe(before);
  });
});
