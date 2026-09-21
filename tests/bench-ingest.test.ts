import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { armSpecs, emptyCell, ingestTraces, observeEvent, type Arm, type CellRecord } from '../src/bench/run.js';
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
