import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, validateConfig } from '../src/config.js';
import {
  blockQuestion,
  blockQuestionKey,
  buildSelectionRequest,
  decideSelection,
  MIN_REDUCTION_RATIO,
  OMIT_CONFIDENCE_FLOOR,
  SCOPE_QUESTION,
  SHARED_INSTRUCTIONS,
  type ContextIntentBody,
  type ContextResultBody,
} from '../src/context/select.js';
import { callJev, JEV_ENDPOINT, MAX_RESPONSE_BYTES } from '../src/jev.js';
import { openTraceDir } from '../src/trace.js';
import type { SearchBlock, SelectionContext } from '../src/types.js';
import { BLOCK_RELATIONS, SELECTION_SCOPES } from '../src/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-context-select-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const KEY = 'ts-secret-key-123';
const deps = { apiKey: KEY, deadlineMs: 500 };

const block = (i: number, over: Partial<SearchBlock> = {}): SearchBlock => ({
  id: `b${i}`,
  sourcePath: `src/f${i}.ts`,
  startLine: i * 10,
  endLine: i * 10 + 4,
  text: `src/f${i}.ts:${String(i * 10)}:const value = ${i}; ${'y'.repeat(200)}`,
  protected: false,
  ...over,
});

const context = (blocks: SearchBlock[]): SelectionContext => ({
  userRequests: ['find where the keyword filter drops a match'],
  searchInput: { pattern: 'value', output_mode: 'content', '-n': true },
  blocks,
});

const answer = <K extends string>(keys: readonly K[], winner: K, confidence: number, probabilities?: Record<string, number>): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: probabilities ?? Object.fromEntries(keys.map((k) => [k, k === winner ? 0.94 : 0.03])),
  confidence,
});

const selectable = (confidence = 0.95): Record<string, unknown> => answer(SELECTION_SCOPES, 'selectable', confidence);
const omit = (confidence = 0.95): Record<string, unknown> => answer(BLOCK_RELATIONS, 'omit', confidence);
const keep = (confidence = 0.95): Record<string, unknown> => answer(BLOCK_RELATIONS, 'keep', confidence);

describe('context mode', () => {
  it('is a mode value on the unchanged version 5 config', () => {
    const file = validateConfig({ version: 5, mode: 'context' });
    expect(file).toMatchObject({ ok: true, config: { version: 5, mode: 'context', jevModel: DEFAULT_CONFIG.jevModel, requestDeadlineMs: DEFAULT_CONFIG.requestDeadlineMs } });
    expect(loadConfig({ JEV_GATE_MODE: 'context' })).toMatchObject({ ok: true, config: { mode: 'context' } });
    expect(loadConfig({ JEV_GATE_MODE: 'off' })).toMatchObject({ ok: true, config: { mode: 'off' } });
    expect(loadConfig({ JEV_GATE_MODE: 'ctx' })).toMatchObject({ ok: false });
    // The deployed V5 shape still loads untouched, and the default stays off.
    expect(validateConfig({ version: 5, mode: 'auto' })).toMatchObject({ ok: true, config: { mode: 'auto' } });
    expect(DEFAULT_CONFIG.mode).toBe('off');
  });
});

describe('buildSelectionRequest', () => {
  const blocks = [block(0), block(1, { sourcePath: 'CLAUDE.md', protected: true }), block(2, { sourcePath: 'src/we:ird.ts' })];
  const request = buildSelectionRequest(context(blocks), DEFAULT_CONFIG);

  it('sends one state with every block and asks scope plus one question per unprotected block', () => {
    expect(request.model).toBe(DEFAULT_CONFIG.jevModel);
    expect(request.state.blocks).toEqual(blocks);
    expect(Object.keys(request.questions)).toEqual(['scope', blockQuestionKey(0), blockQuestionKey(2)]);
    expect(request.questions['scope']).toBe(SCOPE_QUESTION);
    expect(Object.keys(request.questions)).not.toContain(blockQuestionKey(1));
  });

  it('names the concrete block index and its real path in the instructions, not in the question id', () => {
    const q = request.questions[blockQuestionKey(2)];
    expect(q?.instructions).toContain('`blocks[2]`');
    expect(q?.instructions).toContain('`src/we:ird.ts`');
    expect(q?.instructions).toContain(SHARED_INSTRUCTIONS);
    expect(Object.keys(q?.criteria ?? {})).toEqual([...BLOCK_RELATIONS]);
    expect(Object.keys(SCOPE_QUESTION.criteria)).toEqual([...SELECTION_SCOPES]);
    expect(SCOPE_QUESTION.instructions).toContain('keep all');
    expect(blockQuestion(7, 'a/b.ts').instructions).toContain('`blocks[7]` (sourcePath `a/b.ts`)');
  });

  it('carries no environment, transcript or repository content beyond the requests, the arguments and the blocks', () => {
    expect(Object.keys(request.state).sort()).toEqual(['blocks', 'searchInput', 'userRequests']);
    expect(JSON.stringify(request)).not.toContain(KEY);
  });
});

describe('decideSelection', () => {
  const blocks = [block(0), block(1), block(2), block(3), block(4)];

  it('omits only a valid, unique omit at or above the floor under a valid, unique selectable scope', () => {
    const decision = decideSelection({ scope: selectable(), [blockQuestionKey(1)]: omit(), [blockQuestionKey(3)]: omit(OMIT_CONFIDENCE_FLOOR) }, blocks);
    expect(decision.omit).toBe(true);
    expect(decision.reason).toBeNull();
    expect(decision.omittedIds).toEqual(['b1', 'b3']);
    expect(decision.kept.map((b) => b.id)).toEqual(['b0', 'b2', 'b4']);
    expect(OMIT_CONFIDENCE_FLOOR).toBe(0.9);
  });

  it.each([
    ['a missing answer', {}],
    ['a malformed answer', { type: 'choice', choice: 'omit' }],
    ['probabilities that do not sum to one', answer(BLOCK_RELATIONS, 'omit', 0.99, { keep: 0.1, omit: 0.5, uncertain: 0.1 })],
    ['an unknown choice', answer(BLOCK_RELATIONS, 'drop' as 'omit', 0.99)],
    ['a confidence below the floor', omit(OMIT_CONFIDENCE_FLOOR - 0.01)],
    ['a tie', answer(BLOCK_RELATIONS, 'omit', 0.99, { keep: 0.45, omit: 0.45, uncertain: 0.1 })],
    ['keep', keep()],
    ['uncertain', answer(BLOCK_RELATIONS, 'uncertain', 0.99)],
  ])('keeps the block on %s', (_name, blockAnswer) => {
    const answers = { scope: selectable(), [blockQuestionKey(1)]: blockAnswer, [blockQuestionKey(3)]: omit() };
    const decision = decideSelection(answers, blocks);
    expect(decision.kept.map((b) => b.id)).toContain('b1');
    expect(decision.omittedIds).toEqual(['b3']);
  });

  it.each([
    ['a malformed scope', { scope: { type: 'choice', choice: 'selectable' } }, 'scope_invalid'],
    ['an absent scope', {}, 'scope_invalid'],
    ['a tied scope', { scope: answer(SELECTION_SCOPES, 'selectable', 0.99, { selectable: 0.45, keep_all: 0.45, uncertain: 0.1 }) }, 'scope_tie'],
    ['keep_all', { scope: answer(SELECTION_SCOPES, 'keep_all', 0.99) }, 'scope_keep_all'],
    ['an uncertain scope', { scope: answer(SELECTION_SCOPES, 'uncertain', 0.99) }, 'scope_uncertain'],
    ['a scope below the floor', { scope: selectable(OMIT_CONFIDENCE_FLOOR - 0.01) }, 'scope_low_confidence'],
  ])('keeps every block on %s, whatever the per-block answers say', (_name, scopeAnswers, reason) => {
    const answers = { ...scopeAnswers, [blockQuestionKey(0)]: omit(), [blockQuestionKey(1)]: omit(), [blockQuestionKey(2)]: omit() };
    const decision = decideSelection(answers, blocks);
    expect(decision).toMatchObject({ omit: false, reason, omittedIds: [] });
    expect(decision.kept).toEqual(blocks);
  });

  it('never omits a protected block, even when an answer is keyed at its index', () => {
    const withProtected = [block(0, { sourcePath: 'CLAUDE.md', protected: true }), block(1), block(2)];
    const decision = decideSelection({ scope: selectable(), [blockQuestionKey(0)]: omit(), [blockQuestionKey(1)]: omit() }, withProtected);
    expect(decision.kept.map((b) => b.sourcePath)).toEqual(['CLAUDE.md', 'src/f2.ts']);
    expect(decision.omittedIds).toEqual(['b1']);
  });

  it('passes the original through rather than inventing an empty or barely shorter result', () => {
    const answers = Object.fromEntries(blocks.map((_b, i) => [blockQuestionKey(i), omit()]));
    expect(decideSelection({ scope: selectable(), ...answers }, blocks)).toMatchObject({ omit: false, reason: 'nothing_omitted', kept: blocks });
    expect(decideSelection({ scope: selectable() }, blocks)).toMatchObject({ omit: false, reason: 'nothing_omitted' });
    const many = Array.from({ length: 40 }, (_v, i) => block(i));
    const barely = decideSelection({ scope: selectable(), [blockQuestionKey(0)]: omit() }, many);
    expect(barely).toMatchObject({ omit: false, reason: 'not_materially_smaller' });
    expect(MIN_REDUCTION_RATIO).toBe(0.1);
  });
});

describe('the selection request over the existing client', () => {
  const request = buildSelectionRequest(context([block(0), block(1), block(2)]), DEFAULT_CONFIG);
  const fetchOnce = (impl: (url: string, init: RequestInit) => Promise<Response>): { fn: typeof fetch; calls: () => number } => {
    const fn = vi.fn(impl);
    return { fn: fn as unknown as typeof fetch, calls: () => fn.mock.calls.length };
  };

  it('sends exactly one POST with the key only in the header and redirects refused', async () => {
    const f = fetchOnce(async (url, init) => {
      expect(url).toBe(JEV_ENDPOINT);
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${KEY}`);
      expect(String(init.body)).not.toContain(KEY);
      return new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 41, output_tokens: 0 }, answers: { scope: selectable(), [blockQuestionKey(1)]: omit() } }), { status: 200 });
    });
    const outcome = await callJev(request, { ...deps, fetchImpl: f.fn });
    expect(f.calls()).toBe(1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const decision = decideSelection(outcome.response.answers, request.state.blocks);
    expect(decision.omittedIds).toEqual(['b1']);
  });

  it.each([
    [
      'a timeout',
      'timeout',
      (_u: string, init: RequestInit): Promise<Response> => new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    ],
    ['a 429', 'http_429', async (): Promise<Response> => new Response('{}', { status: 429 })],
    ['a 529', 'http_529', async (): Promise<Response> => new Response('{}', { status: 529 })],
    ['a refused redirect', 'network', async (): Promise<Response> => Promise.reject(new Error('unexpected redirect'))],
    ['an oversized body', 'response_too_large', async (): Promise<Response> => new Response('z'.repeat(MAX_RESPONSE_BYTES + 1), { status: 200 })],
    ['an unreadable body', 'response_invalid', async (): Promise<Response> => new Response('{not json', { status: 200 })],
  ])('makes exactly one attempt on %s and keeps every block', async (_name, code, impl) => {
    const f = fetchOnce(impl as (url: string, init: RequestInit) => Promise<Response>);
    const outcome = await callJev(request, { ...deps, deadlineMs: 20, fetchImpl: f.fn });
    expect(f.calls()).toBe(1);
    expect(outcome).toMatchObject({ ok: false, code });
    // Nothing to decide from: the caller keeps the original result and the cost of the attempt stays unknown, not zero.
    expect(decideSelection({}, request.state.blocks)).toMatchObject({ omit: false, reason: 'scope_invalid', kept: request.state.blocks });
  });

  it('preserves a reported usage even when the answers are rejected', async () => {
    const f = fetchOnce(async () => new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 77 }, answers: { scope: { type: 'choice', choice: 'selectable' } } }), { status: 200 }));
    const outcome = await callJev(request, { ...deps, fetchImpl: f.fn });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.usage).toEqual({ input_tokens: 77, output_tokens: null });
    expect(decideSelection(outcome.response.answers, request.state.blocks)).toMatchObject({ omit: false, reason: 'scope_invalid' });
  });

  it('never dispatches a request larger than the client bound', async () => {
    const huge = buildSelectionRequest(context(Array.from({ length: 400 }, (_v, i) => block(i, { text: 'q'.repeat(400) }))), DEFAULT_CONFIG);
    const f = fetchOnce(async () => new Response('{}', { status: 200 }));
    expect(await callJev(huge, { ...deps, fetchImpl: f.fn })).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(f.calls()).toBe(0);
  });
});

describe('context trace records', () => {
  it('writes the intent and result pair with a shared request_id and hashes instead of text', () => {
    const dir = join(tmp, 'trace');
    const opened = openTraceDir(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const intent: ContextIntentBody = {
      session_id: 'session-1',
      prompt_id: 'p1',
      tool_use_id: 'toolu_1',
      request_id: 'req-1',
      purpose_revision: 'a'.repeat(64),
      original_digest: 'b'.repeat(64),
      candidate_blocks: 3,
      protected_blocks: 1,
      before_bytes: 9000,
      request_bytes: 4000,
      jev_model: DEFAULT_CONFIG.jevModel,
    };
    const result: ContextResultBody = {
      ...intent,
      attempted: true,
      http: { status: 200, code: null, duration_ms: 120 },
      jev: { model: 'jev-1.13.0', usage: { input_tokens: 41, output_tokens: 0 }, response_bytes: 800 },
      kept_blocks: 2,
      omitted_blocks: 1,
      after_bytes: 5000,
      archive_ok: true,
      decision: 'omitted',
      preserve_reason: null,
      replacement_emitted: true,
    };
    expect(opened.writer.write('context_intent', intent).ok).toBe(true);
    expect(opened.writer.write('context_result', result).ok).toBe(true);
    const files = readdirSync(dir).sort();
    // The filename is `<phase>-<uuid>.json`, and both phase names contain an underscore, not a hyphen.
    expect(files.map((f) => f.split('-')[0])).toEqual(['context_intent', 'context_result']);
    const bodies = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    expect(bodies.every((b) => b['request_id'] === 'req-1' && b['version'] === 5)).toBe(true);
    expect(bodies.map((b) => b['phase']).sort()).toEqual(['context_intent', 'context_result']);
    // The stored record carries sizes, counts and digests; the search text and the user's requests are not in it.
    const text = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    expect(text).not.toContain('const value');
    expect(text).not.toContain('keyword filter');
    expect(text).toContain('"replacement_emitted": true');
    expect(text).not.toContain('host_applied');
  });
});
