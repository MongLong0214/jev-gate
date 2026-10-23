import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';

import { delegationModel, handoffBreakEven, handoffModel, HANDOFF_ROOT_REQUESTS } from '../src/admission.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { readTurnProgress } from '../src/depth.js';
import { runHook, type HookResult } from '../src/hook.js';
import { newGeneration, readJob, updateJob } from '../src/job.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-handoff-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Env = Record<string, string | undefined>;
const DEPTH = 200_000;

let seq = 0;
const write = (lines: unknown[]): string => {
  const p = join(tmp, `t-${(seq += 1)}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
};
const prompt = (promptId: string, content: string, over: Record<string, unknown> = {}) => ({ type: 'user', promptId, message: { role: 'user', content }, ...over });
const result = (promptId: string) => ({ type: 'user', promptId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
const request = (id: string, tool = 'Bash', tokens = DEPTH) => ({
  type: 'assistant',
  message: { id, role: 'assistant', content: [{ type: 'tool_use', id: `tu-${id}`, name: tool, input: {} }], usage: { cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, input_tokens: 0 } },
});
/** A previous turn, then `n` requests of turn `p2` each followed by its tool result, the last one still running. */
const turn = (n: number, text = 'Refactor the store and update every caller.', extra: unknown[] = []): string => {
  const rows: unknown[] = [prompt('p1', 'earlier'), request('old-1'), result('p1'), { type: 'assistant', message: { id: 'old-2', role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, prompt('p2', text), ...extra];
  for (let i = 1; i <= n; i++) rows.push(request(`m${i}`), ...(i < n ? [result('p2')] : []));
  return write(rows);
};

describe('readTurnProgress', () => {
  it('counts the turn’s distinct requests, not the previous turn’s closing reply or a parallel call twice', () => {
    const p = write([prompt('p1', 'earlier'), request('old-1'), result('p1'), { type: 'assistant', message: { id: 'old-2', content: [{ type: 'text', text: 'bye' }] } },
      prompt('p2', 'go'), request('a'), request('a'), result('p2'), result('p2'), request('b'), result('p2'), request('c')]);
    expect(readTurnProgress(p, 'p2')).toMatchObject({ ok: true, requests: 3, delegated: false, prompt: 'go', depth: DEPTH });
  });

  it('sees an Agent call made earlier in this turn, and not one made in the previous turn', () => {
    expect(readTurnProgress(write([prompt('p2', 'go'), request('a', 'Agent'), result('p2'), request('b')]), 'p2')).toMatchObject({ ok: true, delegated: true });
    expect(readTurnProgress(write([prompt('p1', 'x'), request('a', 'Agent'), result('p1'), prompt('p2', 'go'), request('b')]), 'p2')).toMatchObject({ ok: true, requests: 1, delegated: false });
  });

  it('reads past a meta row inside the turn to the person’s row', () => {
    const p = write([prompt('p1', 'x'), prompt('p2', 'go'), request('a'), result('p2'), prompt('p2', 'skill text', { isMeta: true }), request('b'), result('p2'), request('c')]);
    expect(readTurnProgress(p, 'p2')).toMatchObject({ ok: true, requests: 3, prompt: 'go' });
  });

  it('ends a turn started by a scheduled fire at the previous turn’s rows', () => {
    const p = write([prompt('p1', 'x'), request('old'), result('p1'), { type: 'assistant', message: { id: 'old-2', content: [{ type: 'text', text: 'bye' }] } },
      prompt('p2', 'run the stats', { isMeta: true, promptSource: 'system' }), request('a'), result('p2'), request('b')]);
    expect(readTurnProgress(p, 'p2')).toMatchObject({ ok: true, requests: 2, prompt: 'run the stats' });
  });

  it('is unknown when the turn’s start cannot be reached or nothing carries usage', () => {
    expect(readTurnProgress(write([request('a'), result('p2'), request('b')]), 'p2')).toMatchObject({ ok: false });
    expect(readTurnProgress(write([prompt('p2', 'go')]), 'p2')).toMatchObject({ ok: false });
    expect(readTurnProgress(join(tmp, 'missing.jsonl'), 'p2')).toMatchObject({ ok: false });
  });
});

describe('handoffBreakEven', () => {
  it('is the first request count the shipped saving prices above zero, and none at or below the worker’s own context', () => {
    const model = handoffModel(DEFAULT_CONFIG);
    // A handoff's coordinator cost replaces a whole delegated turn's; the worker's per-request context is unchanged.
    expect(model).toEqual({ ...delegationModel(DEFAULT_CONFIG), coordinatorTurns: HANDOFF_ROOT_REQUESTS });
    expect(handoffBreakEven(DEPTH, model)).toBe(8);
    expect(handoffBreakEven(400_000, model)).toBe(7);
    expect(handoffBreakEven(40_000, model)).toBeNull();
  });
});

describe('PreToolUse handoff offer (#356)', () => {
  const cfg = join(tmp, 'auto.json');
  writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', delegationDepthFloor: null }));
  const makeEnv = (over: Env = {}): Env => ({
    JEV_GATE_CONFIG: cfg, TYPESAFE_API_KEY: 'k', HOME: join(tmp, 'home'), JEV_GATE_MODE: 'auto', JEV_GATE_STATE_DIR: mkdtempSync(join(tmp, 'state-')),
    CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', ...over,
  });
  const direct = (env: Env, promptId = 'p2', shape: 'direct' | 'orchestrated' = 'direct'): Env => {
    expect(updateJob(env, 's1', (prev) => newGeneration(prev, 's1', promptId, shape).state).ok).toBe(true);
    return env;
  };
  const pre = (env: Env, transcript: string, over: Record<string, unknown> = {}): Promise<HookResult> =>
    runHook({ env, stdin: Readable.from([JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', prompt_id: 'p2', tool_name: 'Bash', tool_use_id: 'tu', tool_input: { command: 'ls' }, transcript_path: transcript, ...over })]) });
  const context = (r: HookResult): Record<string, unknown> => (r.stdout === null ? {} : JSON.parse(r.stdout).hookSpecificOutput);

  it('offers the handoff once, at the break-even request count, as context that lets the tool run', async () => {
    const env = direct(makeEnv());
    expect(await pre(env, turn(7))).toMatchObject({ kind: 'skip', stdout: null });
    const offered = await pre(env, turn(8));
    expect(offered.kind).toBe('context');
    expect(context(offered)).toEqual({ hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('[Jev Gate handoff] Observed in this turn: 8 model requests at about 200K') });
    expect(context(offered)['additionalContext']).toContain('cheaper when about 8 or more steps of work remain');
    const state = readJob(env, 's1');
    expect(state.ok && state.value?.current.handoff_offered).toBe(true);
    expect(await pre(env, turn(20))).toMatchObject({ kind: 'skip', stdout: null });
  });

  it('is not offered to a delegating turn, a request that forbids delegation, a child, a Gate job, another turn or outside auto', async () => {
    const long = turn(30);
    expect((await pre(direct(makeEnv()), turn(30, 'go', [request('x', 'Agent'), result('p2')]))).stdout).toBeNull();
    expect((await pre(direct(makeEnv()), turn(30, 'Fix it yourself, do not delegate.'))).stdout).toBeNull();
    expect((await pre(direct(makeEnv()), long, { agent_id: 'child' })).stdout).toBeNull();
    expect((await pre(direct(makeEnv(), 'p2', 'orchestrated'), long)).stdout).toBeNull();
    expect((await pre(direct(makeEnv(), 'p1'), long)).stdout).toBeNull();
    expect((await pre(makeEnv(), long)).stdout).toBeNull();
    expect((await pre(direct(makeEnv({ JEV_GATE_MODE: 'native' })), long)).stdout).toBeNull();
    expect((await pre(direct(makeEnv()), long, { prompt_id: undefined })).stdout).toBeNull();
    expect((await pre(direct(makeEnv()), write([prompt('p2', 'go'), request('a', 'Bash', 30_000)]))).stdout).toBeNull();
  });
});
