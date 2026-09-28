import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { armSpecs, emptyCell, ingestRouterLog, ingestTraces, observeEvent, type Arm, type CellRecord } from '../src/bench/run.js';
import { leanOf, renderMarkdown, summarizeArm, summarizeLean, toRowView, type Report, type RowView } from '../src/bench/report.js';
import type { ConfigV5 } from '../src/types.js';

// R08-R10: the observation and accounting defects (document sections T6 and T7), driven through the real
// `src/bench/run.ts` module over recorded trace directories. Nothing is re-implemented here.

const tmp = mkdtempSync(join(tmpdir(), 'jev-ingest-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const MODELS: ConfigV5['models'] = { fast: 'haiku', standard: 'sonnet', deep: 'opus', frontier: 'fable' };
const iso = (ms: number): string => new Date(Date.UTC(2026, 8, 18) + ms).toISOString();
const traceDir = (name: string, records: Array<Record<string, unknown>>): string => {
  const dir = join(tmp, 'traces', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  records.forEach((r, i) => {
    const { _file, ...rest } = r;
    const file = typeof _file === 'string' ? _file : `rec-${String(i).padStart(3, '0')}`;
    writeFileSync(join(dir, `${file}.json`), JSON.stringify({ version: 5, session_id: 's', prompt_id: 'p', ...rest }));
  });
  return dir;
};
const cellFor = (arm: Arm): CellRecord =>
  emptyCell({ id: 'mini', group: 'g', fixtureDir: '', request: 'r', prime: [], setup: [], evaluationSetup: [], checkFile: '', checkFileRel: '' }, armSpecs('fable')[arm], 1);
/** A started session whose host init and final usage were both observed, so only the gate records are in question. */
const ranCleanly = (cell: CellRecord): CellRecord => {
  cell.started = true;
  observeEvent(cell, { type: 'system', subtype: 'init', model: 'claude-sonnet-5', plugins: [{ name: 'jev-gate' }], agents: [], permissionMode: 'default' });
  observeEvent(cell, {
    type: 'result', subtype: 'success', is_error: false, duration_ms: 10, num_turns: 2, total_cost_usd: 0.02,
    modelUsage: { 'claude-sonnet-5': { inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.02 } }, permission_denials: [],
  });
  return cell;
};
const jevOk = (tokens: number): Record<string, unknown> => ({ http: { status: 200, code: null, duration_ms: 10, request_bytes: 100 }, jev: { model: 'jev-1.13.0', usage: { input_tokens: tokens, output_tokens: 2 }, response_bytes: 50 } });
/** One Gate B call: the intent, the decision that came back, and the child the host actually resolved. */
const workerCall = (id: string, calledTier: string, decision: Record<string, unknown> | null, observed: string | null): Array<Record<string, unknown>> => [
  { phase: 'pre_intent', request_id: `q-${id}`, tool_use_id: id, role: 'worker', called_tier: calledTier, request_bytes: 100, written_at: iso(1) },
  { phase: 'pre_result', request_id: `q-${id}`, tool_use_id: id, role: 'worker', called_tier: calledTier, attempted: true, ...jevOk(10), decision, written_at: iso(2) },
  { phase: 'post', tool_use_id: id, task_id: id, verdict: 'accept', tool_response: { status: 'completed', ...(observed === null ? {} : { resolvedModel: observed }), totalDurationMs: 5 }, written_at: iso(3) },
];

describe('R08: the model the final policy required against the model observed', () => {
  it('reads the final patch/preserve/pin policy, not "did either differ from the original"', () => {
    const cell = ranCleanly(cellFor('jev_hierarchy'));
    // The pinned call is compared the same way: the pin is the model the final policy required.
    observeEvent(cell, {
      type: 'assistant', parent_tool_use_id: null,
      message: { model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'tool_use', id: 'pinned', name: 'Agent', input: { subagent_type: 'jev-gate:worker', model: 'haiku', prompt: 'x' } }] },
    });
    const dir = traceDir('r08', [
      // original sonnet -> policy fast/haiku -> executed opus: both values differ from the original, and it is a mismatch.
      ...workerCall('opus_ran', 'standard', { action: 'patch', tier: 'fast', reason: null }, 'claude-opus-5'),
      ...workerCall('opus_ran_2', 'standard', { action: 'patch', tier: 'fast', reason: null }, 'claude-opus-5'),
      ...workerCall('haiku_ran', 'standard', { action: 'patch', tier: 'fast', reason: null }, 'claude-haiku-4-5-20251001'),
      ...workerCall('preserved', 'standard', { action: 'preserve', tier: 'standard', reason: 'route_low_confidence' }, 'claude-opus-5'),
      ...workerCall('same_model', 'standard', { action: 'patch', tier: 'standard', reason: null }, 'claude-sonnet-4-5'),
      ...workerCall('unknown_alias', 'standard', { action: 'patch', tier: 'exotic', reason: null }, 'claude-sonnet-4-5'),
      { phase: 'post', tool_use_id: 'pinned', verdict: 'accept', tool_response: { status: 'completed', resolvedModel: 'claude-opus-5', totalDurationMs: 5 }, written_at: iso(4) },
    ]);
    ingestTraces(cell, dir, MODELS);
    const byId = Object.fromEntries(cell.agent_calls.map((c) => [c.tool_use_id, c]));
    expect(byId['opus_ran']).toMatchObject({ target_model: 'haiku', target_model_match: 'mismatch', target_model_changed: true, observed_model: 'claude-opus-5' });
    expect(byId['haiku_ran']).toMatchObject({ target_model: 'haiku', target_model_match: 'match', target_model_changed: true });
    expect(byId['preserved']).toMatchObject({ target_model: 'sonnet', target_model_match: 'mismatch', target_model_changed: false });
    expect(byId['same_model']).toMatchObject({ target_model: 'sonnet', target_model_match: 'match', target_model_changed: false });
    // An alias the supported normalization does not know is unknown: neither a match nor a mismatch.
    expect(byId['unknown_alias']).toMatchObject({ target_model: null, target_model_match: 'unknown', target_model_changed: null });
    expect(byId['pinned']).toMatchObject({ target_model: 'haiku', target_model_match: 'mismatch' });
    expect(cell.agent_calls.filter((c) => c.target_model_match === 'mismatch').map((c) => c.tool_use_id).sort()).toEqual(['opus_ran', 'opus_ran_2', 'pinned', 'preserved']);
    expect(cell.gate.target_model_matches).toBe(2);
    expect(cell.gate.target_model_mismatches).toBe(4);
    expect(cell.gate.target_model_unknown).toBe(1);
    // The recorded-decision cross-check follows the same comparison: the two patched-to-haiku-ran-on-opus calls count,
    // the unknown alias does not, and "did either differ from the original" would have scored these the other way.
    expect(cell.gate.decision_mismatch).toBe(3);
  });

  it('never fills a missing step from another: no decision record and no observed model stay unknown', () => {
    const cell = ranCleanly(cellFor('jev_hierarchy'));
    const dir = traceDir('r08-unknown', [
      ...workerCall('no_model', 'standard', { action: 'patch', tier: 'deep', reason: null }, null),
      { phase: 'post', tool_use_id: 'no_record', verdict: 'accept', tool_response: { status: 'completed', resolvedModel: 'claude-opus-5', totalDurationMs: 5 }, written_at: iso(3) },
      // Gate B was asked but its answer was never recorded: whether the hook patched is the missing step itself.
      { phase: 'pre_intent', request_id: 'q-open', tool_use_id: 'gate_open', role: 'worker', called_tier: 'standard', request_bytes: 10, written_at: iso(1) },
      { phase: 'post', tool_use_id: 'gate_open', verdict: 'accept', tool_response: { status: 'completed', resolvedModel: 'claude-sonnet-4-5', totalDurationMs: 5 }, written_at: iso(3) },
    ]);
    ingestTraces(cell, dir, MODELS);
    const byId = Object.fromEntries(cell.agent_calls.map((c) => [c.tool_use_id, c]));
    expect(byId['no_model']).toMatchObject({ target_model: 'opus', target_model_match: 'unknown' });
    expect(byId['no_record']).toMatchObject({ target_model: null, target_model_match: 'unknown' });
    // The observed child does match the profile, but nothing recorded says the profile is what the policy required.
    expect(byId['gate_open']).toMatchObject({ target_model: null, target_model_match: 'unknown', observed_model: 'claude-sonnet-4-5' });
    expect(cell.gate.decision_mismatch).toBe(0);
    expect(cell.gate.target_model_unknown).toBe(3);
  });
});

describe('R09: a missing trace is unknown, not zero', () => {
  it('an auto cell with host init and final usage but no admission and no Agent traces is not free', () => {
    const cell = ranCleanly(cellFor('jev_hierarchy'));
    ingestTraces(cell, traceDir('r09-empty', []), MODELS);
    expect(cell.gate.jev_input_tokens).toBeNull();
    expect(cell.gate.jev_cost_usd).toBeNull();
    expect(cell.gate.jev_requests.admission).toMatchObject({ attempts: 0, tokens: null, cost_usd: null });
    expect(cell.gate.attempt_unknown).toBe(1);
    // The same absence in a native arm stays a proven zero: that arm sends nothing by construction.
    const native = ranCleanly(cellFor('native_hierarchy'));
    ingestTraces(native, traceDir('r09-native', []), MODELS);
    expect(native.gate.jev_input_tokens).toBe(0);
  });

  it('a recorded forced-admission bypass gives Gate A zero while the other gates are counted from their own records', () => {
    const cell = ranCleanly(cellFor('jev_forced_orchestration'));
    const dir = traceDir('r09-forced', [
      { phase: 'admission_result', attempted: false, known_not_sent: true, forced: true, decision: 'orchestrated', reason: 'admission_forced', skip_code: 'admission_forced', written_at: iso(0) },
      ...workerCall('w1', 'standard', { action: 'patch', tier: 'deep', reason: null }, 'claude-opus-5'),
    ]);
    ingestTraces(cell, dir, MODELS);
    expect(cell.gate.admission).toMatchObject({ attempted: false, known_not_sent: true, forced: true });
    expect(cell.gate.jev_requests.admission).toMatchObject({ attempts: 0, tokens: 0, cost_usd: 0 });
    expect(cell.gate.jev_requests.allocation).toMatchObject({ attempts: 1, tokens: 10 });
    expect(cell.gate.attempt_unknown).toBe(0);
    expect(cell.gate.jev_input_tokens).toBe(10);
  });
});

describe('R10: several admissions and late traces join to the right request', () => {
  const admissionPair = (req: string, choiceValue: string, tokens: number, ms: number, withResult = true): Array<Record<string, unknown>> => [
    { phase: 'admission_intent', request_id: req, prompt_len: 10, request_bytes: 100, written_at: iso(ms) },
    ...(withResult
      ? [{
          _file: `z-${req}`, phase: 'admission_result', request_id: req, attempted: true, ...jevOk(tokens),
          answers: { execution: { type: 'choice', choice: choiceValue, confidence: 0.9 } },
          decision: { shape: choiceValue, decided: true, reason: null }, written_at: iso(ms + 1),
        }]
      : []),
  ];

  it('does not merge two admissions when one of them only has an intent', () => {
    const cell = ranCleanly(cellFor('jev_hierarchy'));
    ingestTraces(cell, traceDir('r10-two', [...admissionPair('a', 'orchestrated', 300, 0), ...admissionPair('b', 'direct', 0, 100, false)]), MODELS);
    expect(cell.gate.jev_requests.admission).toMatchObject({ attempts: 1, tokens: null, tokens_known: 300 });
    expect(cell.gate.attempt_unknown).toBe(1);
    expect(cell.gate.jev_input_tokens).toBeNull();
  });

  it('counts keyless legacy admissions by cardinality instead of collapsing them onto one tool_use_id', () => {
    const cell = ranCleanly(cellFor('jev_hierarchy'));
    const legacy = (ms: number, phase: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ phase, tool_use_id: null, written_at: iso(ms), ...extra });
    ingestTraces(
      cell,
      traceDir('r10-legacy', [
        legacy(0, 'admission_intent'),
        legacy(10, 'admission_intent'),
        legacy(20, 'admission_result', { attempted: true, ...jevOk(300), decision: { shape: 'orchestrated', decided: true } }),
      ]),
      MODELS,
    );
    expect(cell.gate.attempt_unknown).toBe(1);
    expect(cell.gate.jev_requests.admission).toMatchObject({ attempts: 1, tokens: null, tokens_known: 300 });
  });

  it('resolves the last admission and the last Stop by event time, not by filename order', () => {
    const cell = ranCleanly(cellFor('jev_hierarchy'));
    // Sorted by filename the "direct" record comes last; by event time the "orchestrated" one does.
    const dir = traceDir('r10-order', [
      { _file: 'aaa', phase: 'admission_intent', request_id: 'late', request_bytes: 10, written_at: iso(500) },
      { _file: 'aab', phase: 'admission_result', request_id: 'late', attempted: true, ...jevOk(10), answers: { execution: { type: 'choice', choice: 'orchestrated', confidence: 0.9 } }, decision: { shape: 'orchestrated', decided: true, reason: null }, written_at: iso(900) },
      { _file: 'zzy', phase: 'admission_intent', request_id: 'early', request_bytes: 10, written_at: iso(0) },
      { _file: 'zzz', phase: 'admission_result', request_id: 'early', attempted: true, ...jevOk(10), answers: { execution: { type: 'choice', choice: 'direct', confidence: 0.9 } }, decision: { shape: 'direct', decided: true, reason: null }, written_at: iso(100) },
      { _file: 'stop-b', phase: 'stop', outcome: 'completed', written_at: iso(1000) },
      { _file: 'stop-a', phase: 'stop', outcome: 'incomplete', written_at: iso(200) },
    ]);
    ingestTraces(cell, dir, MODELS);
    expect(cell.gate.admission).toMatchObject({ decision: 'orchestrated', choice: 'orchestrated', decided: true });
    expect(cell.gate.outcome).toBe('completed');
    expect(cell.gate.attempt_unknown).toBe(0);
  });

  it('leaves an unresolvable order unknown instead of picking one', () => {
    const cell = ranCleanly(cellFor('jev_hierarchy'));
    const tie = (choiceValue: string): Record<string, unknown> => ({
      phase: 'admission_result', request_id: `t-${choiceValue}`, attempted: true, ...jevOk(10),
      answers: { execution: { type: 'choice', choice: choiceValue, confidence: 0.9 } }, decision: { shape: choiceValue, decided: true, reason: null }, written_at: iso(42),
    });
    ingestTraces(cell, traceDir('r10-tie', [
      { phase: 'admission_intent', request_id: 't-direct', request_bytes: 10, written_at: iso(0) },
      { phase: 'admission_intent', request_id: 't-orchestrated', request_bytes: 10, written_at: iso(0) },
      tie('direct'), tie('orchestrated'),
      { phase: 'stop', outcome: 'completed', written_at: iso(50) },
      { phase: 'stop', outcome: 'incomplete', written_at: iso(50) },
    ]), MODELS);
    expect(cell.gate.admission).toMatchObject({ attempted: true, decided: null, choice: null, decision: null, reason: 'ambiguous_record_order' });
    expect(cell.gate.outcome).toBeNull();
    // The consumption of both attempts is still counted; only which one decided the prompt is unresolved.
    expect(cell.gate.jev_requests.admission).toMatchObject({ attempts: 2, tokens: 20 });
  });

  it('keeps request-only records, trace-only calls and the known usage of a failed request', () => {
    const cell = ranCleanly(cellFor('jev_hierarchy'));
    const dir = traceDir('r10-survive', [
      { phase: 'admission_intent', request_id: 'a', request_bytes: 10, written_at: iso(0) },
      { phase: 'admission_result', request_id: 'a', attempted: true, http: { status: 500, code: 'http_error', duration_ms: 9, request_bytes: 10 }, jev: { model: 'jev-1.13.0', usage: { input_tokens: 40, output_tokens: 0 }, response_bytes: 0 }, decision: { shape: 'direct', decided: false, reason: 'http_error' }, written_at: iso(1) },
      // A paid allocation whose Agent call never reached the stream, plus an intent that never got its result.
      { phase: 'pre_result', request_id: 'b', tool_use_id: 'trace_only', role: 'worker', called_tier: 'standard', attempted: true, ...jevOk(25), decision: { action: 'patch', tier: 'standard', reason: null }, written_at: iso(2) },
      { phase: 'pre_intent', request_id: 'c', tool_use_id: 'no_result', role: 'worker', called_tier: 'fast', request_bytes: 10, written_at: iso(3) },
    ]);
    ingestTraces(cell, dir, MODELS);
    expect(cell.gate.jev_requests.admission).toMatchObject({ attempts: 1, tokens: 40 });
    expect(cell.gate.jev_requests.allocation).toMatchObject({ attempts: 1, tokens: null, tokens_known: 25 });
    expect(cell.agent_calls.map((c) => c.tool_use_id).sort()).toEqual(['no_result', 'trace_only']);
    expect(cell.gate.attempt_unknown).toBe(1);
    expect(cell.gate.jev_input_tokens).toBeNull();
    expect(cell.gate.jev_input_tokens_known).toBe(65);
  });
});


describe('primed cases: the depth the job prompt actually arrived at', () => {
  const usageMsg = (ctx: number, parent: string | null = null): Record<string, unknown> => ({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { model: 'claude-sonnet-5', role: 'assistant', content: [], usage: { cache_read_input_tokens: ctx - 1000, cache_creation_input_tokens: 600, input_tokens: 400 } },
  });
  const prompt = (text: string): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content: text } });

  /** A cell whose case declared one priming prompt: the job prompt is then the second echo. */
  const primedCell = (arm: Arm, primes = 1): CellRecord => {
    const cell = cellFor(arm);
    cell.prime_sha256 = Array.from({ length: primes }, (_, i) => `sha-${i}`);
    return cell;
  };

  it('records the context standing when the job prompt was submitted, not the deepest the session ever got', () => {
    const cell = primedCell('jev_hierarchy');
    observeEvent(cell, prompt('read the reference files'));
    observeEvent(cell, usageMsg(60_000));
    observeEvent(cell, usageMsg(406_000));
    observeEvent(cell, prompt('now fix the twelve validators'));
    observeEvent(cell, usageMsg(520_000));
    expect(cell.context_at_job_prompt).toBe(406_000);
  });

  it('ignores a subagent’s usage and a tool result, which are not this session’s context or its prompts', () => {
    const cell = primedCell('jev_hierarchy');
    observeEvent(cell, prompt('prime'));
    observeEvent(cell, usageMsg(300_000));
    observeEvent(cell, usageMsg(900_000, 'toolu_worker'));
    observeEvent(cell, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_worker' }] } });
    observeEvent(cell, prompt('job'));
    expect(cell.context_at_job_prompt).toBe(300_000);
  });

  it('counts the job prompt as the one after every priming prompt, however many there are', () => {
    const cell = primedCell('jev_hierarchy', 2);
    observeEvent(cell, prompt('read the reference files'));
    observeEvent(cell, usageMsg(390_000));
    observeEvent(cell, prompt('confirm you are ready'));
    observeEvent(cell, usageMsg(406_000));
    observeEvent(cell, prompt('now fix the twelve validators'));
    observeEvent(cell, usageMsg(520_000));
    // The confirming turn exists to give the host time to flush the priming turn's usage line to the transcript.
    expect(cell.context_at_job_prompt).toBe(406_000);
  });

  it('leaves the depth null for an unprimed run, where the only prompt is the job itself', () => {
    const cell = cellFor('sonnet_native');
    observeEvent(cell, prompt('fix the twelve validators'));
    observeEvent(cell, usageMsg(55_000));
    expect(cell.context_at_job_prompt).toBeNull();
  });

  it('keeps every turn’s cumulative total, because each result reports the session total and not that turn’s cost', () => {
    const cell = cellFor('sonnet_native');
    const result = (total: number): Record<string, unknown> => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, total_cost_usd: total, modelUsage: {}, permission_denials: [] });
    observeEvent(cell, result(1.25));
    observeEvent(cell, result(4.5));
    expect(cell.turn_totals_usd).toEqual([1.25, 4.5]);
    // The last one is the session total, which is what cell.result carries; the job's own cost is the difference.
    expect(cell.result?.total_cost_usd).toBe(4.5);
  });
});

// 2026-09-20: the dollar figure alone could not be trusted -- the 13-note ladder rung reversed sign in dollars while
// the stream showed the arms doing the same work. The runner now records the same turn boundaries in tokens.
describe('turn_totals_stream (2026-09-20 metric defect)', () => {
  const usageMsg = (u: Record<string, number>): Record<string, unknown> => ({ type: 'assistant', message: { usage: u } });
  const result = (cost: number): Record<string, unknown> => ({ type: 'result', subtype: 'success', total_cost_usd: cost, num_turns: 1 });

  it('accumulates every message carrying usage and snapshots cumulatively at each result', () => {
    const cell = emptyCell({ id: 'job', group: 'g', fixtureDir: '', request: 'r', prime: [], setup: [], evaluationSetup: [], checkFile: '', checkFileRel: '' }, armSpecs('fable')['sonnet_native'], 1);
    observeEvent(cell, usageMsg({ cache_read_input_tokens: 100, cache_creation_input_tokens: 10, input_tokens: 1, output_tokens: 5 }));
    observeEvent(cell, result(1));
    observeEvent(cell, usageMsg({ cache_read_input_tokens: 400, output_tokens: 20 }));
    observeEvent(cell, result(3));

    expect(cell.turn_totals_stream).toHaveLength(2);
    expect(cell.turn_totals_stream[0]).toMatchObject({ cache_read: 100, cache_creation: 10, input: 1, output: 5, messages: 1, duplicates: 0, incomplete: 0 });
    // Cumulative, like turn_totals_usd, so a job turn is the same subtraction in both units.
    const [priming, job] = cell.turn_totals_stream;
    // The second message omits two counters. They are still added as zero -- changing the sum would change a
    // published unit after its results were seen -- but the omission is counted, so the run says what it is.
    expect(job).toMatchObject({ cache_read: 500, cache_creation: 10, input: 1, output: 25, messages: 2, duplicates: 0, incomplete: 1 });
    expect((job?.cache_read ?? 0) - (priming?.cache_read ?? 0)).toBe(400);
  });

  /**
   * The sum is reported stream usage, not verified provider computation. Two things could make it neither: a message
   * whose usage the host emits twice, and a counter that is absent and is added as zero. Until a run says both are
   * zero, nothing quoted from it can claim to be de-duplicated -- so the run counts them and the sums do not move.
   */
  it('counts a repeated message id and an unreadable counter without changing the totals', () => {
    const cell = emptyCell({ id: 'job', group: 'g', fixtureDir: '', request: 'r', prime: [], setup: [], evaluationSetup: [], checkFile: '', checkFileRel: '' }, armSpecs('fable')['sonnet_native'], 1);
    const withId = (id: string, u: Record<string, number>): Record<string, unknown> => ({ type: 'assistant', message: { id, usage: u } });
    const full = { cache_read_input_tokens: 10, cache_creation_input_tokens: 2, input_tokens: 1, output_tokens: 3 };
    observeEvent(cell, withId('msg_1', full));
    observeEvent(cell, withId('msg_1', full));
    observeEvent(cell, withId('msg_2', { cache_read_input_tokens: 10, cache_creation_input_tokens: 2, input_tokens: 1, output_tokens: 'nine' } as unknown as Record<string, number>));
    observeEvent(cell, result(1));
    const [turn] = cell.turn_totals_stream;
    expect(turn).toMatchObject({ messages: 3, duplicates: 1, incomplete: 1 });
    // The repeat is still in the sum: this observes the risk, it does not silently correct the unit.
    expect(turn?.cache_read).toBe(30);
    expect(turn?.output).toBe(6);
    // JGL-05 keeps the de-duplicated view beside it rather than replacing the published one.
    expect(turn?.deduped_messages).toBe(2);
    expect(turn?.deduped_cache_read).toBe(20);
    expect(turn?.deduped_output).toBe(3);
  });

  it('scopes message identity by agent, so a root message and a child message are two reports', () => {
    const cell = emptyCell({ id: 'job', group: 'g', fixtureDir: '', request: 'r', prime: [], setup: [], evaluationSetup: [], checkFile: '', checkFileRel: '' }, armSpecs('fable')['jev_lean'], 1);
    const u = { cache_read_input_tokens: 10, cache_creation_input_tokens: 0, input_tokens: 1, output_tokens: 2 };
    observeEvent(cell, { type: 'assistant', message: { id: 'msg_1', usage: u } });
    observeEvent(cell, { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { id: 'msg_1', usage: u } });
    observeEvent(cell, result(1));
    const [turn] = cell.turn_totals_stream;
    // Same id, different scope: neither is a repeat of the other, so the de-duplicated view keeps both.
    expect(turn).toMatchObject({ messages: 2, duplicates: 0, deduped_messages: 2, deduped_cache_read: 20 });
  });

  it('treats a fractional or unrepresentable counter as unknown rather than as a value', () => {
    const cell = emptyCell({ id: 'job', group: 'g', fixtureDir: '', request: 'r', prime: [], setup: [], evaluationSetup: [], checkFile: '', checkFileRel: '' }, armSpecs('fable')['jev_lean'], 1);
    observeEvent(cell, usageMsg({ cache_read_input_tokens: 10.5, output_tokens: Number.MAX_SAFE_INTEGER + 2 }));
    observeEvent(cell, result(1));
    expect(cell.turn_totals_stream[0]).toMatchObject({ cache_read: 0, output: 0, messages: 1, incomplete: 1 });
  });

  it('counts subagent messages as work and ignores messages with no usable usage', () => {
    const cell = emptyCell({ id: 'job', group: 'g', fixtureDir: '', request: 'r', prime: [], setup: [], evaluationSetup: [], checkFile: '', checkFileRel: '' }, armSpecs('fable')['jev_single'], 1);
    observeEvent(cell, { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { usage: { cache_read_input_tokens: 70, output_tokens: 3 } } });
    observeEvent(cell, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } });
    observeEvent(cell, usageMsg({ cache_read_input_tokens: -5, output_tokens: 2 }));
    observeEvent(cell, result(1));

    const [only] = cell.turn_totals_stream;
    expect(only?.messages).toBe(2);
    expect(only?.cache_read).toBe(70);
    expect(only?.output).toBe(5);
  });
});

describe('L6: every charged producer reaches the final report, once', () => {
  // Chosen so the lean call prices at 0.125 USD to within a rounding of the list price.
  const LEAN_TOKENS = 2_976_190;
  const leanIntent = (id: string): Record<string, unknown> => ({ phase: 'lean_intent', request_id: id, request_bytes: 100, written_at: iso(1) });
  const leanResult = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    phase: 'lean_result', request_id: id, attempted: true, ...jevOk(LEAN_TOKENS), decision: { action: 'handoff' }, written_at: iso(2), ...over,
  });
  const leanCell = (records: Array<Record<string, unknown>>, name: string, claudeUsd = 2): CellRecord => {
    const cell = cellFor('jev_lean');
    cell.started = true;
    observeEvent(cell, { type: 'system', subtype: 'init', model: 'claude-sonnet-5', plugins: [{ name: 'jev-gate' }], agents: [], permissionMode: 'default' });
    observeEvent(cell, {
      type: 'result', subtype: 'success', is_error: false, duration_ms: 10, num_turns: 1, total_cost_usd: claudeUsd,
      modelUsage: { 'claude-sonnet-5': { inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: claudeUsd } }, permission_denials: [],
    });
    ingestTraces(cell, traceDir(name, records), MODELS);
    return cell;
  };
  const planned = { job: 'mini', group: 'g', repetition: 1, arm: 'jev_lean', file: '' };
  const rowOf = (cell: CellRecord): RowView => toRowView(planned, JSON.parse(JSON.stringify(cell)) as Record<string, unknown>);

  it('reports Claude 2 + legacy gate 0 + Lean Jev 0.125 as 2.125, not 2', () => {
    const cell = leanCell([leanIntent('q1'), leanResult('q1')], 'l6-total');
    expect(cell.gate.jev_cost_usd).toBe(0);
    expect(cell.lean.jev_cost_usd).toBeCloseTo(0.125, 6);
    const row = rowOf(cell);
    expect(row.jev_cost_by_producer.legacy).toBe(0);
    expect(row.jev_cost_by_producer.lean).toBeCloseTo(0.125, 6);
    expect(row.total_cost_usd).toBeCloseTo(2.125, 6);
    const arm = summarizeArm('jev_lean', [row]);
    expect(arm.jev_cost_usd).toBeCloseTo(0.125, 6);
    expect(arm.total_cost_usd).toBeCloseTo(2.125, 6);
  });

  it('keeps a lean call the legacy producer stays zero for, even when the run timed out', () => {
    const cell = leanCell([leanIntent('q1'), leanResult('q1')], 'l6-timeout');
    cell.timed_out = true;
    ingestTraces(cell, join(tmp, 'traces', 'l6-timeout'), MODELS);
    expect(cell.gate.jev_cost_usd).toBe(0);
  });

  it('separates responses, the known token subtotal and the complete total', () => {
    const cell = leanCell([leanIntent('q1'), leanResult('q1'), leanIntent('q2'), leanResult('q2', { jev: { model: 'jev-1.13.0', usage: { input_tokens: 40, output_tokens: 1 } } })], 'l6-split');
    expect(cell.lean).toMatchObject({ jev_attempts: 2, jev_responses_known: 2, jev_input_tokens_known: LEAN_TOKENS + 40, jev_input_tokens: LEAN_TOKENS + 40, jev_attempt_unknown: 0 });
  });

  it('an intent with no result may have been billed: complete totals unknown, the known part kept beside them', () => {
    const cell = leanCell([leanIntent('q1'), leanResult('q1'), leanIntent('q2')], 'l6-orphan');
    expect(cell.lean).toMatchObject({ jev_attempts: 1, jev_attempt_unknown: 1, jev_input_tokens: null, jev_cost_usd: null, jev_input_tokens_known: LEAN_TOKENS });
    expect(cell.lean.jev_cost_known_subtotal).toBeCloseTo(0.125, 6);
    const row = rowOf(cell);
    expect(row.jev_cost_usd).toBeNull();
    expect(row.total_cost_usd).toBeNull();
    expect(row.jev_cost_known_subtotal).toBeCloseTo(0.125, 6);
    expect(summarizeArm('jev_lean', [row]).jev_cost_known_subtotal).toBeCloseTo(0.125, 6);
  });

  it('keeps the known legacy spend in the row subtotal when the legacy total is incomplete', () => {
    const cell = JSON.parse(JSON.stringify(leanCell([leanIntent('q1'), leanResult('q1')], 'l6-legacy-known'))) as Record<string, unknown>;
    cell['gate'] = { ...(cell['gate'] as Record<string, unknown>), jev_cost_usd: null, jev_input_tokens: null, jev_input_tokens_known: LEAN_TOKENS, jev_model: 'jev-1.13.0' };
    const row = toRowView(planned, cell);
    expect(row.jev_cost_usd).toBeNull();
    expect(row.jev_cost_by_producer.legacy).toBeNull();
    expect(row.jev_cost_known_subtotal).toBeCloseTo(0.25, 6);
  });

  it('counts a result with no intent of its own, and collapses a repeated record of one request', () => {
    const cell = leanCell([leanResult('q1'), leanResult('q1'), leanIntent('q2'), leanIntent('q2'), leanResult('q2')], 'l6-dup');
    expect(cell.lean).toMatchObject({ jev_attempts: 2, jev_attempt_unknown: 0, duplicate_records: 2, jev_input_tokens: 2 * LEAN_TOKENS });
  });

  it('never pairs records without a request identity by count: each is unknown and outside the known subtotal', () => {
    const keyless = (r: Record<string, unknown>): Record<string, unknown> => {
      const { request_id: _drop, ...rest } = r;
      return rest;
    };
    // One lost result and one repeated result: paired by count, these two intents and two results would balance.
    const cell = leanCell([leanIntent('q1'), leanResult('q1'), keyless(leanIntent('x')), keyless(leanIntent('y')), keyless(leanResult('y')), keyless(leanResult('y'))], 'l6-keyless');
    expect(cell.lean).toMatchObject({ jev_attempts: 1, jev_attempt_unknown: 4, jev_input_tokens: null, jev_cost_usd: null, jev_input_tokens_known: LEAN_TOKENS });
    expect(cell.lean.jev_cost_known_subtotal).toBeCloseTo(0.125, 6);
  });

  it('a confirmed local no-send is zero, and a timeout without usage keeps the total unknown', () => {
    const noSend = leanCell([leanResult('q1', { attempted: false, known_not_sent: true, skip_code: 'deadline_exhausted', jev: undefined, http: undefined })], 'l6-nosend');
    expect(noSend.lean).toMatchObject({ jev_attempts: 0, jev_input_tokens: 0, jev_cost_usd: 0 });
    const timeout = leanCell([leanIntent('q1'), leanResult('q1', { http: { status: null, code: 'timeout' }, jev: null })], 'l6-timeout-call');
    expect(timeout.lean).toMatchObject({ jev_attempts: 1, jev_responses_known: 0, jev_input_tokens: null, jev_cost_usd: null });
  });

  it('prices known input without a free output count, and leaves an unpriced model unknown', () => {
    const noOutput = leanCell([leanIntent('q1'), leanResult('q1', { jev: { model: 'jev-1.13.0', usage: { input_tokens: LEAN_TOKENS } } })], 'l6-no-output');
    expect(noOutput.lean.jev_cost_usd).toBeCloseTo(0.125, 6);
    const unpriced = leanCell([leanIntent('q1'), leanResult('q1', { jev: { model: 'jev-9.9.9', usage: { input_tokens: 10, output_tokens: 1 } } })], 'l6-unpriced');
    expect(unpriced.lean).toMatchObject({ jev_input_tokens: 10, jev_cost_usd: null, jev_cost_known_subtotal: 0 });
  });

  it('an unreadable record could be any producer’s call, so neither total is complete', () => {
    const dir = traceDir('l6-corrupt', [leanIntent('q1'), leanResult('q1')]);
    writeFileSync(join(dir, 'broken.json'), '{"version":5,"phase":"lean_int');
    const cell = cellFor('jev_lean');
    cell.started = true;
    observeEvent(cell, { type: 'system', subtype: 'init', model: 'claude-sonnet-5', plugins: [{ name: 'jev-gate' }], agents: [], permissionMode: 'default' });
    ingestTraces(cell, dir, MODELS);
    expect(cell.lean.jev_cost_usd).toBeNull();
    expect(cell.gate.jev_cost_usd).toBeNull();
  });

  it('reads a lean block from before this accounting as a relabelled subtotal with no complete total', () => {
    const old = { selections: 1, jev_attempts: 2, jev_input_tokens: 500, jev_input_tokens_known: 2, jev_cost_usd: 0.000021 };
    const l = leanOf(old);
    expect(l).toMatchObject({ accounting: 1, jev_responses_known: 2, jev_input_tokens_known: 500, jev_input_tokens: null, jev_cost_usd: null, jev_cost_known_subtotal: 0.000021 });
    expect(summarizeLean([{ lean: l } as RowView]).rows_uncorrected).toBe(1);
  });

  it('a lean-mode row with no lean block at all is an unobserved producer, not a free one', () => {
    const cell = JSON.parse(JSON.stringify(leanCell([], 'l6-absent'))) as Record<string, unknown>;
    delete cell['lean'];
    expect(toRowView(planned, cell).jev_cost_usd).toBeNull();
    const native = JSON.parse(JSON.stringify(ranCleanly(cellFor('sonnet_native')))) as Record<string, unknown>;
    delete native['lean'];
    ingestTraces(cellFor('sonnet_native'), join(tmp, 'traces', 'none'), MODELS);
    expect(toRowView({ ...planned, arm: 'sonnet_native' }, native).jev_cost_by_producer.lean).toBe(0);
  });
});

describe('L6: a repeated stream message keeps its last complete cumulative usage', () => {
  const withId = (id: string, u: Record<string, unknown>): Record<string, unknown> => ({ type: 'assistant', message: { id, usage: u } });
  const u = (output: unknown): Record<string, unknown> => ({ cache_read_input_tokens: 10, cache_creation_input_tokens: 2, input_tokens: 1, output_tokens: output });
  const turn = (events: Array<Record<string, unknown>>): Record<string, number> => {
    const cell = cellFor('sonnet_native');
    for (const e of events) observeEvent(cell, e);
    observeEvent(cell, { type: 'result', subtype: 'success', total_cost_usd: 1, num_turns: 1 });
    return cell.turn_totals_stream[0] as unknown as Record<string, number>;
  };

  it('replaces a partial observation by the later cumulative one, rather than freezing the first or adding both', () => {
    const t = turn([withId('msg_1', u(3)), withId('msg_1', u(40))]);
    expect(t).toMatchObject({ deduped_messages: 1, deduped_output: 40, deduped_cache_read: 10, deduped_incompatible: 0 });
    // The published sum is not changed retroactively.
    expect(t['output']).toBe(43);
  });

  it('does not let an unreadable later observation replace a complete one', () => {
    expect(turn([withId('msg_1', u(40)), withId('msg_1', u('forty'))])).toMatchObject({ deduped_output: 40, incomplete: 1 });
  });

  it('marks a repeat whose counters went down as incompatible and keeps the view it had', () => {
    expect(turn([withId('msg_1', u(40)), withId('msg_1', u(3))])).toMatchObject({ deduped_output: 40, deduped_incompatible: 1 });
  });
});

describe('#45: Router producer ingestion (jev-router debug log)', () => {
  let n45 = 0;
  // The host ends every debug line with a newline; `truncated` leaves the last one unterminated, as a session cut
  // short mid-write does.
  const routerLog = (name: string, lines: string[], truncated = false): string => {
    const file = join(tmp, 'router-logs', `${name}.log`);
    mkdirSync(join(tmp, 'router-logs'), { recursive: true });
    writeFileSync(file, lines.join('\n') + (truncated ? '' : '\n'));
    return file;
  };

  it('parses root/spawn/skip lines, tolerates other debug noise, and counts a truncated last line instead of dropping it', () => {
    const cell = cellFor('router');
    const log = routerLog('mixed', [
      'plain host debug output that is not a Router line at all',
      'jev-router {"event":"router","root_effort":true,"root_model":false,"spawn_model":true,"key":"k1"}',
      'jev-router {"event":"root","turn":"t1","skipped":"host_version_mismatch"}',
      'jev-router {"event":"root","turn":"t2","patch":{"effort":"high"},"sent":true,"usage":{"input_tokens":120}}',
      'jev-router {"event":"root_result","turn":"t2","index":0,"applied":{"effort":"high"},"observed":"claude-sonnet-5","usage":{"inputTokens":1000,"outputTokens":20}}',
      'jev-router {"event":"root_stop","turn":"t4","reason":"model_mismatch"}',
      'jev-router {"event":"spawn","tool_use_id":"tu1","patch":{"model":"haiku"},"sent":true,"usage":{"input_tokens":80}}',
      // #45: the host's own `model_mismatch` reason code on spawn_result, never inferred from requested vs observed.
      'jev-router {"event":"spawn_result","tool_use_id":"tu1","requested":"haiku","observed":"opus","reason":"model_mismatch","agent_id":"a1"}',
      'jev-router {"event":"spawn","tool_use_id":"tu2","skipped":"low_confidence"}',
      'jev-router {"event":"spawn","tool_use_id":"tu3","patch":{"model":"opus"},"sent":true}',
      // A late reply, joined by identity (scope:id) to the still-unfilled "tu3" attempt above, never by count.
      'jev-router {"event":"late","scope":"spawn","tool_use_id":"tu3","usage":{"input_tokens":55}}',
      'jev-router {this line has the prefix but is not valid JSON',
      // Deliberately truncated: real content that fails to parse, at the very end of the file with no closing brace.
      'jev-router {"event":"root","turn":"t5","sent":true,"usage":{"in',
    ], true);
    ingestRouterLog(cell, log);
    const r = cell.router;
    expect(r.diagnostic).toEqual({ root_effort: true, root_model: false, spawn_model: true, key: 'k1' });
    expect(r.root_skip_reasons).toEqual({ host_version_mismatch: 1 });
    expect(r.root_assessed).toBe(1);
    expect(r.root_proposed).toBe(1);
    expect(r.root_applied).toHaveLength(1);
    expect(r.root_applied[0]).toMatchObject({ turn: 't2', applied: { effort: 'high' }, observed_model: 'claude-sonnet-5' });
    expect(r.root_observed).toBe(1);
    expect(r.root_stop_reasons).toEqual({ model_mismatch: 1 });
    expect(r.root_model_mismatches).toBe(1);
    expect(r.spawn_assessed).toBe(2);
    expect(r.spawn_proposed).toBe(2);
    expect(r.spawn_skip_reasons).toEqual({ low_confidence: 1 });
    expect(r.spawn_applied).toHaveLength(1);
    expect(r.spawn_applied[0]).toMatchObject({ tool_use_id: 'tu1', requested: 'haiku', observed: 'opus', model_mismatch: true, denied: false });
    expect(r.spawn_observed).toBe(1);
    expect(r.spawn_denied).toBe(0);
    expect(r.spawn_model_mismatches).toBe(1);
    expect(r.late_events).toBe(1);
    // Two malformed `jev-router `-prefixed lines: the mid-file non-JSON one and the truncated tail. Neither is dropped
    // silently, and the plain noise line above (no prefix at all) contributes to neither count.
    expect(r.unparsable_lines).toBe(2);
    // Jev attempts: root t2 (120), spawn tu1 (80), spawn tu3 (55 via the late join) -- all three resolved, so the
    // total is complete, priced at the dated list price, never conflated with root_result's routed-Claude usage.
    expect(r.jev_attempts).toBe(3);
    expect(r.jev_responses_known).toBe(3);
    // A Router line that did not parse may have been a sent call, so the total is unknown; the known part is kept.
    expect(r.jev_input_tokens_known).toBe(255);
    expect(r.jev_input_tokens).toBeNull();
    expect(r.jev_cost_usd).toBeNull();
    expect(r.jev_cost_known_subtotal).toBeCloseTo((255 / 1_000_000) * 0.042, 10);
  });

  it('PR #49: reads the redaction-safe usage keys (input/output/cache_read/cache_creation), never the old _tokens names, for pricing and for the routed call’s own per-step usage', () => {
    const cell = cellFor('router');
    const log = routerLog('new-keys', [
      'jev-router {"event":"root","turn":"t1","patch":{"effort":"high"},"sent":true,"usage":{"input":100,"output":5,"cache_read":0,"cache_creation":0}}',
      'jev-router {"event":"root_result","turn":"t1","index":0,"applied":{"effort":"high"},"observed":"claude-sonnet-5","usage":{"input":900,"output":30,"cache_read":10,"cache_creation":0}}',
      'jev-router {"event":"spawn","tool_use_id":"tuA","patch":{"model":"haiku"},"sent":true,"usage":{"input":40,"output":2,"cache_read":0,"cache_creation":0}}',
    ]);
    ingestRouterLog(cell, log);
    const r = cell.router;
    expect(r.unparsable_lines).toBe(0);
    // root_result's usage is passed through raw for observation only, under whatever keys the log carries -- #49's
    // short names here, never renamed back or reinterpreted by this ingestion.
    expect(r.root_applied[0]).toMatchObject({ usage: { input: 900, output: 30, cache_read: 10, cache_creation: 0 } });
    expect(r.jev_attempts).toBe(2);
    expect(r.jev_responses_known).toBe(2);
    expect(r.jev_input_tokens).toBe(140);
    expect(r.jev_cost_usd).toBeCloseTo((140 / 1_000_000) * 0.042, 10);
  });

  it('PR #49: a line with a bare, unquoted [REDACTED] usage value -- the host’s own token redaction -- fails to parse and is counted unparsable, never read as a sent attempt or as zero usage', () => {
    const cell = cellFor('router');
    const log = routerLog('redacted', [
      // This is exactly what the host's debug log produces for an old-format line: a bare, unquoted token, which is
      // not valid JSON at all (JSON.parse throws on the bare `REDACTED`), unlike every other line in this suite.
      'jev-router {"event":"spawn","tool_use_id":"tuR","patch":{"model":"haiku"},"sent":true,"usage":{"input_tokens":[REDACTED],"output_tokens":[REDACTED]}}',
      'jev-router {"event":"root","turn":"t9","patch":{"effort":"high"},"sent":true,"usage":{"input":77}}',
    ]);
    ingestRouterLog(cell, log);
    const r = cell.router;
    expect(r.unparsable_lines).toBe(1);
    // The redacted line's whole record failed to parse, so it never became a "sent" attempt at all -- not a zero, not
    // an entry. Only the one valid line after it counts.
    expect(r.spawn_assessed).toBe(0);
    expect(r.jev_attempts).toBe(1);
    expect(r.jev_input_tokens_known).toBe(77);
    expect(r.jev_input_tokens).toBeNull();
  });

  it('a sent attempt whose usage never comes back leaves the Router total unknown, not zero', () => {
    const cell = cellFor('router');
    const log = routerLog('unresolved', ['jev-router {"event":"spawn","tool_use_id":"tuX","patch":{"model":"haiku"},"sent":true}']);
    ingestRouterLog(cell, log);
    expect(cell.router).toMatchObject({ jev_attempts: 1, jev_responses_known: 0, jev_input_tokens: null, jev_cost_usd: null, jev_cost_known_subtotal: 0 });
  });

  it('a Router arm with no debug log has an unknown Jev cost, not zero; an arm without the Router stays at zero', () => {
    const missing = join(tmp, 'router-logs', 'does-not-exist.log');
    const cell = cellFor('router');
    ingestRouterLog(cell, missing);
    expect(cell.router).toMatchObject({ log: 'missing', jev_attempts: 0, jev_input_tokens: null, jev_cost_usd: null, jev_cost_known_subtotal: 0 });
    for (const arm of ['router_native', 'router_fixed', 'native_auto'] as const) {
      const other = cellFor(arm);
      ingestRouterLog(other, missing);
      expect(other.router).toMatchObject({ jev_attempts: 0, jev_input_tokens: 0, jev_cost_usd: 0 });
    }
  });

  it('an unterminated last line is a cut-short write and leaves the cost unknown, even when it is too short to carry the prefix', () => {
    for (const [name, tail] of [['cut-prefix', 'jev-ro'], ['cut-noise', 'plain host debug out']] as const) {
      const cell = cellFor('router');
      ingestRouterLog(cell, routerLog(name, ['plain host debug output', tail], true));
      expect(cell.router).toMatchObject({ log: 'read', unparsable_lines: 1, jev_attempts: 0, jev_input_tokens: null, jev_cost_usd: null, jev_cost_known_subtotal: 0 });
    }
    const whole = cellFor('router');
    ingestRouterLog(whole, routerLog('whole-noise', ['plain host debug output', 'jev-ro']));
    // Terminated, the same short line is ordinary host output: a complete log with no Router request is a known zero.
    expect(whole.router).toMatchObject({ unparsable_lines: 0, jev_input_tokens: 0, jev_cost_usd: 0 });
  });

  it('a Router session ended by the timeout or a cancel has an unknown Jev cost, whatever its log shows', () => {
    const logPath = join(tmp, 'router-logs', 'clean.log');
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `jev-router ${JSON.stringify({ event: 'root', turn: 't1', sent: true, patch: {}, usage: { input: 40 } })}\n`);
    const clean = cellFor('router');
    ingestRouterLog(clean, logPath);
    expect(clean.router).toMatchObject({ log: 'read', jev_input_tokens: 40 });
    for (const end of ['timed_out', 'cancelled'] as const) {
      const cell = cellFor('router');
      cell[end] = true;
      ingestRouterLog(cell, logPath);
      expect(cell.router).toMatchObject({ jev_input_tokens_known: 40, jev_input_tokens: null, jev_cost_usd: null });
      expect(cell.router.jev_cost_known_subtotal).toBeGreaterThan(0);
    }
  });

  describe('#45: producer accounting -- legacy + Lean + Router summed once, disjoint', () => {
    const planned = { job: 'mini', group: 'g', repetition: 1, arm: 'router', file: '' };
    const routerRow = (cell: CellRecord, arm: Arm = 'router'): RowView => toRowView({ ...planned, arm }, JSON.parse(JSON.stringify(cell)) as Record<string, unknown>);
    const ranRouterCell = (claudeUsd = 2, arm: Arm = 'router'): CellRecord => {
      const cell = cellFor(arm);
      cell.started = true;
      observeEvent(cell, { type: 'system', subtype: 'init', model: 'claude-sonnet-5', plugins: [], agents: [], permissionMode: 'default' });
      observeEvent(cell, {
        type: 'result', subtype: 'success', is_error: false, duration_ms: 10, num_turns: 1, total_cost_usd: claudeUsd,
        modelUsage: { 'claude-sonnet-5': { inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: claudeUsd } }, permission_denials: [],
      });
      // Neither router nor sonnet_native ever calls the legacy Gate through the plugin, so an empty trace directory
      // resolves the legacy gate producer to a known, proven zero -- exactly the R09 "native arm" reading above.
      ingestTraces(cell, traceDir(`router-legacy-${n45++}`, []), MODELS);
      return cell;
    };

    it('Router cost known: Claude 2 + legacy gate 0 + Router Jev (known) sums to a complete total', () => {
      const cell = ranRouterCell(2);
      ingestRouterLog(cell, routerLog('sum-known', ['jev-router {"event":"spawn","tool_use_id":"tuS","patch":{"model":"opus"},"sent":true,"usage":{"input_tokens":1000}}']));
      const expectedRouterCost = (1000 / 1_000_000) * 0.042;
      const row = routerRow(cell);
      expect(row.jev_cost_by_producer).toMatchObject({ legacy: 0, lean: 0 });
      expect(row.jev_cost_by_producer.router).toBeCloseTo(expectedRouterCost, 10);
      expect(row.jev_cost_usd).toBeCloseTo(expectedRouterCost, 10);
      expect(row.total_cost_usd).toBeCloseTo(2 + expectedRouterCost, 10);
      const arm = summarizeArm('router', [row]);
      expect(arm.jev_cost_usd).toBeCloseTo(expectedRouterCost, 10);
      expect(arm.total_cost_usd).toBeCloseTo(2 + expectedRouterCost, 10);
    });

    it('Router enabled but unobserved: the row and the arm total go null, never zero', () => {
      const cell = ranRouterCell(2);
      ingestRouterLog(cell, routerLog('sum-unobserved', ['jev-router {"event":"spawn","tool_use_id":"tuU","patch":{"model":"haiku"},"sent":true}']));
      const row = routerRow(cell);
      expect(row.jev_cost_by_producer.router).toBeNull();
      expect(row.jev_cost_usd).toBeNull();
      expect(row.total_cost_usd).toBeNull();
      // The reason lives in the Router block itself, the same way an unresolved Lean intent carries its own reason.
      expect(row.router).toMatchObject({ jev_attempts: 1, jev_responses_known: 0 });
      expect(summarizeArm('router', [row]).total_cost_usd).toBeNull();
    });

    it('known-disabled Router on a non-router arm contributes zero, not unknown', () => {
      // No ingestRouterLog call at all: this arm never turns the Router on (router_expected is false from armSpecs).
      const cell = ranRouterCell(2, 'sonnet_native');
      const row = routerRow(cell, 'sonnet_native');
      expect(row.jev_cost_by_producer.router).toBe(0);
      expect(row.total_cost_usd).toBeCloseTo(2, 10);
    });

    it('a Router row the runner never ingested (its block still at the initial zeros) is unobserved, not free', () => {
      const row = routerRow(ranRouterCell(2));
      expect(row.router).toMatchObject({ log: null, jev_cost_usd: 0 });
      expect(row.jev_cost_by_producer.router).toBeNull();
      expect(row.total_cost_usd).toBeNull();
      const arm = summarizeArm('router', [row]);
      expect(arm.router).toMatchObject({ rows_cost_unknown: 1, jev_cost_usd: null, jev_input_tokens: null });
      expect(arm.total_cost_usd).toBeNull();
    });

    it('a router-expected row with no router block at all (pre-#45 cell) is unobserved, not free', () => {
      const raw = JSON.parse(JSON.stringify(ranRouterCell(2))) as Record<string, unknown>;
      delete raw['router'];
      const row = toRowView({ ...planned, arm: 'router' }, raw);
      expect(row.jev_cost_by_producer.router).toBeNull();
      expect(row.jev_cost_usd).toBeNull();
    });
  });

  it('renders a Router arm with requested/observed models, opportunity counts and no savings headline', () => {
    const cell = cellFor('router');
    cell.started = true;
    observeEvent(cell, { type: 'system', subtype: 'init', model: 'claude-sonnet-5', plugins: [], agents: [], permissionMode: 'default' });
    observeEvent(cell, {
      type: 'result', subtype: 'success', is_error: false, duration_ms: 10, num_turns: 1, total_cost_usd: 1,
      modelUsage: { 'claude-sonnet-5': { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1 } }, permission_denials: [],
    });
    ingestRouterLog(cell, routerLog('render', [
      'jev-router {"event":"spawn","tool_use_id":"tuR","patch":{"model":"opus"},"sent":true,"usage":{"input_tokens":50}}',
      'jev-router {"event":"spawn_result","tool_use_id":"tuR","requested":"opus","observed":"sonnet","reason":"model_mismatch","agent_id":"a1"}',
    ]));
    const row = toRowView({ job: 'mini', group: 'g', repetition: 1, arm: 'router', file: '' }, JSON.parse(JSON.stringify(cell)) as Record<string, unknown>);
    const arm = summarizeArm('router', [row]);
    const report: Report = {
      schema: 5, accounting: 2, run: 'test-run', generated_at: new Date().toISOString(), plan_schema: 5, planned_rows: 1,
      independent_units: { jobs: 1, groups: 1 }, arms: [arm], per_job: [{ job: 'mini', arms: [arm] }], comparisons: [],
      conclusion: { category: 'exploratory router reading', reason: 'test' }, rows: [row], notes: [],
    };
    const md = renderMarkdown(report);
    expect(md).toContain('Router decisions and Jev usage');
    expect(md).toContain('no savings headline');
    expect(md).toContain('opus');
    expect(md).toContain('sonnet');
  });

  it('renders the Router table for a sole Router cell whose log is missing, with its cost as unknown', () => {
    const cell = cellFor('router');
    cell.started = true;
    ingestRouterLog(cell, join(tmp, 'router-logs', 'never-written.log'));
    const row = toRowView({ job: 'mini', group: 'g', repetition: 1, arm: 'router', file: '' }, JSON.parse(JSON.stringify(cell)) as Record<string, unknown>);
    const arm = summarizeArm('router', [row]);
    expect(arm.router).toMatchObject({ jev_attempts: 0, rows_cost_unknown: 1, jev_cost_usd: null });
    const report: Report = {
      schema: 5, accounting: 2, run: 'test-run', generated_at: new Date().toISOString(), plan_schema: 5, planned_rows: 1,
      independent_units: { jobs: 1, groups: 1 }, arms: [arm], per_job: [{ job: 'mini', arms: [arm] }], comparisons: [],
      conclusion: { category: 'exploratory router reading', reason: 'test' }, rows: [row], notes: [],
    };
    const md = renderMarkdown(report);
    expect(md).toContain('Router decisions and Jev usage');
    const routerRowLine = md.split('\n').find((l) => l.startsWith('| router | 0/0/0/0'));
    expect(routerRowLine).toBeDefined();
    expect(routerRowLine).toContain('| null (0.000000) |');
  });
});
