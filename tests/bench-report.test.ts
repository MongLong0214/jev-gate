import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildReport, compare, FRONTIER_PREFERRED, gateV5Of, plannedCells, renderMarkdown, summarizeArm, toRowView } from '../src/bench/report.js';
import { parseModelUsage, safeSum, tokenCount, familyTokens } from '../src/bench/usage.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-report-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const usage = (model: string, tokens: number, cost: number): Record<string, unknown> => ({ [model]: { inputTokens: tokens, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost } });
const cell = (job: string, arm: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 4, job, group: 'g', arm, repetition: 1, root_model_requested: arm.startsWith('frontier') ? 'fable' : 'sonnet', plugin_expected: arm.includes('hierarchy'), mode: arm === 'jev_hierarchy' ? 'auto' : arm.includes('hierarchy') ? 'native' : null,
  dispatch: { intent_at: 't', spawn_observed_at: 't', pid: 1 }, started: true, not_started_reason: null, elapsed_ms: 1000, timed_out: false, cancelled: false,
  init: { model: arm.startsWith('frontier') ? 'claude-fable-5-1' : 'claude-sonnet-5', plugins: arm.includes('hierarchy') ? ['jev-gate'] : [], jev_gate_loaded: arm.includes('hierarchy') },
  root_model_consistent: true, agent_calls: [], api_retries: 0,
  result: { subtype: 'success', is_error: false, duration_ms: 900, num_turns: 3, total_cost_usd: 10, model_usage: usage('claude-sonnet-5', 1000, 10), usage_status: 'ok', permission_denials: 0 },
  gate: { owned_calls: 0, pinned: 0, eligible_attempted: 0, patched: 0, preserved: 0, preserve_reasons: {}, skipped: {}, attempt_unknown: 0, missing_pre_records: 0, jev_cost_usd: 0, hint_delivered: 0, target_model_mismatches: 0 },
  grade: { quality: 'pass', reason: null }, ...over,
});
const writeRun = (name: string, rows: Array<{ job: string; arms: string[] }>, cells: Array<Record<string, unknown>>): string => {
  const run = join(tmp, name);
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'plan.json'), JSON.stringify({ schema: 4, rows: rows.map((r) => ({ job: r.job, group: 'g', repetition: 1, arms: r.arms })), planned_cells: rows.reduce((n, r) => n + r.arms.length, 0) }));
  for (const c of cells) {
    const dir = join(run, 'cells', String(c['job']), String(c['arm']), '1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cell.json'), JSON.stringify(c));
  }
  return run;
};

describe('plan-first rows', () => {
  it('planned 2, result 1: the missing job stays planned as missing_record, never not-started or cost zero', () => {
    const run = writeRun('missing', [{ job: 'A', arms: ['jev_hierarchy'] }, { job: 'B', arms: ['jev_hierarchy'] }], [cell('A', 'jev_hierarchy')]);
    const r = buildReport(run);
    expect(r.planned_rows).toBe(2);
    const arm = r.arms[0]!;
    expect(arm.planned).toBe(2);
    expect(arm.by_status.missing_record).toBe(1);
    expect(arm.by_status.completed).toBe(1);
    expect(arm.total_cost_usd).toBeNull();
    expect(arm.claude_cost_known_subtotal).toBe(10);
    expect(arm.claude_cost_unknown_rows).toBe(1);
    expect(r.rows.find((x) => x.job === 'B')?.status).toBe('missing_record');
    expect(renderMarkdown(r)).toContain('null (known 10.0000, 1 unknown)');
  });

  it('a confirmed not-started cell is known zero spend; intent-only is unknown', () => {
    const run = writeRun('ns', [{ job: 'A', arms: ['sonnet_native'] }, { job: 'B', arms: ['sonnet_native'] }, { job: 'C', arms: ['sonnet_native'] }], [
      cell('A', 'sonnet_native'),
      cell('B', 'sonnet_native', { started: false, not_started_reason: 'setup_failed', dispatch: { intent_at: null, spawn_observed_at: null, pid: null }, result: null, elapsed_ms: null, init: null, grade: null }),
      cell('C', 'sonnet_native', { started: false, dispatch: { intent_at: 't', spawn_observed_at: null, pid: null }, result: null, elapsed_ms: null, init: null, grade: null }),
    ]);
    const arm = buildReport(run).arms[0]!;
    expect(arm.by_status).toMatchObject({ completed: 1, not_started: 1, intent_only: 1 });
    expect(arm.total_cost_usd).toBeNull();
    expect(arm.claude_cost_unknown_rows).toBe(1);
  });
});

describe('survivor bias and totals', () => {
  it('regression: 10→5 completed plus 10→100 timed out is a 425% increase, not 50% savings', () => {
    const cells = [
      cell('A', 'native_hierarchy', { result: { subtype: 'success', total_cost_usd: 10, model_usage: usage('claude-sonnet-5', 1, 10), usage_status: 'ok' } }),
      cell('A', 'jev_hierarchy', { result: { subtype: 'success', total_cost_usd: 5, model_usage: usage('claude-sonnet-5', 1, 5), usage_status: 'ok' } }),
      cell('B', 'native_hierarchy', { result: { subtype: 'success', total_cost_usd: 10, model_usage: usage('claude-sonnet-5', 1, 10), usage_status: 'ok' } }),
      cell('B', 'jev_hierarchy', { timed_out: true, elapsed_ms: 900_000, grade: { quality: 'unknown', reason: 'timed out' }, result: { subtype: 'error_max_turns', total_cost_usd: 100, model_usage: usage('claude-sonnet-5', 1, 100), usage_status: 'ok' } }),
    ];
    const run = writeRun('survivor', [{ job: 'A', arms: ['native_hierarchy', 'jev_hierarchy'] }, { job: 'B', arms: ['native_hierarchy', 'jev_hierarchy'] }], cells);
    const r = buildReport(run);
    const cmp = r.comparisons.find((c) => c.treatment === 'jev_hierarchy' && c.control === 'native_hierarchy')!;
    expect(cmp.cost_known).toBe(true);
    expect(cmp.relative_cost_reduction).toBeCloseTo(1 - 105 / 20, 10);
    expect(cmp.intended_rows).toBe(2);
    expect(cmp.complete_case_diagnostic?.included).toEqual(['A#1']);
    expect(cmp.complete_case_diagnostic?.relative_cost_reduction).toBeCloseTo(0.5, 10);
    expect(cmp.complete_case_diagnostic?.excluded[0]?.row).toBe('B#1');
    const jev = r.arms.find((a) => a.arm === 'jev_hierarchy')!;
    expect(jev.total_cost_usd).toBe(105);
    expect(jev.by_status.timed_out).toBe(1);
    expect(jev.completed_pass_count).toBe(1);
    expect(jev.runtime_total_ms).toBe(901_000);
  });

  it('unknown consumption anywhere makes the whole-run total and comparison null while known subtotals remain', () => {
    const cells = [cell('A', 'native_hierarchy'), cell('A', 'jev_hierarchy', { result: { subtype: 'success', total_cost_usd: null, model_usage: null, usage_status: 'absent' } })];
    const r = buildReport(writeRun('unknown', [{ job: 'A', arms: ['native_hierarchy', 'jev_hierarchy'] }], cells));
    const cmp = r.comparisons[0]!;
    expect(cmp.cost_known).toBe(false);
    expect(cmp.relative_cost_reduction).toBeNull();
    expect(r.arms.find((a) => a.arm === 'jev_hierarchy')?.total_cost_usd).toBeNull();
    expect(renderMarkdown(r)).toContain('null (unknown spend)');
  });

  it('missing Jev usage on an auto arm (missing pre record) makes Jev cost unknown; zero eligible calls is known zero', () => {
    const cells = [
      cell('A', 'jev_hierarchy', { gate: { owned_calls: 1, eligible_attempted: 0, missing_pre_records: 1, jev_cost_usd: null, pinned: 0, patched: 0, preserved: 0, preserve_reasons: {}, skipped: {}, attempt_unknown: 0, hint_delivered: 0, target_model_mismatches: 0 } }),
      cell('B', 'jev_hierarchy'),
    ];
    const r = buildReport(writeRun('jev', [{ job: 'A', arms: ['jev_hierarchy'] }, { job: 'B', arms: ['jev_hierarchy'] }], cells));
    const arm = r.arms[0]!;
    expect(arm.jev_cost_usd).toBeNull();
    expect(arm.jev_cost_unknown_rows).toBe(1);
    expect(arm.gate.missing_pre_records).toBe(1);
    expect(r.rows.find((x) => x.job === 'B')?.jev_cost_usd).toBe(0);
  });

  it('all failures: cost per pass is null and pass differences stay zero, no invented percentage', () => {
    const cells = [cell('A', 'native_hierarchy', { grade: { quality: 'fail', reason: 'x' } }), cell('A', 'jev_hierarchy', { grade: { quality: 'fail', reason: 'y' } })];
    const r = buildReport(writeRun('fails', [{ job: 'A', arms: ['native_hierarchy', 'jev_hierarchy'] }], cells));
    expect(r.arms.every((a) => a.cost_per_pass_usd === null && a.pass === 0)).toBe(true);
    expect(r.comparisons[0]?.absolute_success_difference).toBe(0);
  });
});

describe('experimental validity', () => {
  it('a contaminated baseline or wrong root model marks the comparison invalid but keeps costs', () => {
    const cells = [
      cell('A', 'sonnet_native', { init: { model: 'claude-sonnet-5', plugins: ['jev-gate'], jev_gate_loaded: true } }),
      cell('A', 'jev_hierarchy'),
      cell('A', 'frontier_native', { init: { model: 'claude-sonnet-5', plugins: [], jev_gate_loaded: false }, root_model_consistent: false }),
    ];
    const r = buildReport(writeRun('valid', [{ job: 'A', arms: ['sonnet_native', 'jev_hierarchy', 'frontier_native'] }], cells));
    const vsSonnet = r.comparisons.find((c) => c.control === 'sonnet_native')!;
    expect(vsSonnet.validity).toBe('invalid_configuration');
    expect(vsSonnet.validity_reasons.join(' ')).toMatch(/plugin presence/);
    const vsFrontier = r.comparisons.find((c) => c.control === 'frontier_native')!;
    expect(vsFrontier.validity_reasons.join(' ')).toMatch(/root model/);
    expect(vsFrontier.relative_cost_reduction).not.toBeNull();
    expect(r.arms.find((a) => a.arm === 'sonnet_native')?.validity_problems.length).toBe(1);
  });

  it('target/actual model mismatches and record conflicts surface per arm', () => {
    const c = cell('A', 'jev_hierarchy', { agent_calls: [{ tool_use_id: 't', record_conflicts: 2 }], gate: { owned_calls: 1, pinned: 0, eligible_attempted: 1, patched: 1, preserved: 0, preserve_reasons: {}, skipped: {}, attempt_unknown: 0, missing_pre_records: 0, jev_cost_usd: 0.0001, hint_delivered: 1, target_model_mismatches: 1 } });
    const r = buildReport(writeRun('mismatch', [{ job: 'A', arms: ['jev_hierarchy'] }], [c]));
    expect(r.arms[0]?.gate.target_model_mismatches).toBe(1);
    expect(r.arms[0]?.validity_problems.join(' ')).toMatch(/conflicting hook record/);
  });
});

describe('numeric validation and historical compatibility', () => {
  it('rejects malformed tokens and overflowing sums; unknown model identity is not Fable zero', () => {
    expect(tokenCount(-1)).toBeNull();
    expect(tokenCount(1.5)).toBeNull();
    expect(tokenCount('5')).toBeNull();
    expect(tokenCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(safeSum([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
    expect(parseModelUsage({ modelUsage: { m: { inputTokens: '1', outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } })).toMatchObject({ ok: false, reason: 'malformed' });
    expect(parseModelUsage({ modelUsage: {} }, true)).toMatchObject({ ok: false, reason: 'empty_after_inference' });
    expect(parseModelUsage({ modelUsage: {} }, false)).toMatchObject({ ok: true });
    expect(familyTokens({ 'mystery-model': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: null } }, 'fable')).toBeNull();
    expect(familyTokens({ 'claude-sonnet-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: null } }, 'fable')).toBe(0);
  });

  it('reads the historical V3 run-1 through the V3 plan shape and leaves V4 gate fields unknown', () => {
    const run = join(__dirname, '..', 'bench', 'results', 'run-1-2026-09-17');
    const plan = JSON.parse(require('node:fs').readFileSync(join(run, 'plan.summary.json'), 'utf8')) as unknown;
    const { cells, schema } = plannedCells(run, plan);
    expect(schema).toBe(3);
    expect(cells).toHaveLength(16);
    const view = toRowView(cells[0]!, null);
    expect(view.status).toBe('missing_record');
    expect(view.eligible_attempted).toBe(0);
    expect(summarizeArm(cells[0]!.arm, [view]).total_cost_usd).toBeNull();
    expect(existsSync(join(run, 'report.checker-v1.md'))).toBe(true);
  });

  it('compare handles an unrelated missing arm without discarding a usable pair', () => {
    const rows = [cell('A', 'native_hierarchy'), cell('A', 'jev_hierarchy')].map((c, i) => toRowView({ job: 'A', group: 'g', repetition: 1, arm: String(c['arm']), file: '' }, c));
    const cmp = compare(rows, 'jev_hierarchy', 'native_hierarchy');
    expect(cmp.intended_rows).toBe(1);
    expect(compare(rows, 'jev_hierarchy', 'fixed_hierarchy').validity).toBe('insufficient');
  });
});

// ---------------------------------------------------------------- schema 5

const V4_GATE = { owned_calls: 0, pinned: 0, eligible_attempted: 0, patched: 0, preserved: 0, preserve_reasons: {}, skipped: {}, attempt_unknown: 0, missing_pre_records: 0, jev_cost_usd: 0, hint_delivered: 0, target_model_mismatches: 0 };
const jevPhase = (attempts: number, tokens: number | null): Record<string, unknown> => ({ attempts, tokens, tokens_known: tokens ?? 0, cost_usd: tokens === null ? null : (tokens * 0.042) / 1_000_000 });
const gate5 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...V4_GATE,
  eligible_attempted: 3,
  admission: { attempted: true, known_not_sent: false, forced: false, decided: true, choice: 'orchestrated', confidence: 0.91, decision: 'orchestrated', reason: null },
  guard_denials: 2,
  continue_false: 0,
  planner_calls: { requested: 1, completed: 1, tier_proposed: 'deep', model_observed: 'claude-opus-5', plan_status: 'ready', rev: 1 },
  worker_calls: { fast: { calls: 2, proposed: { fast: 2 }, observed_model: { 'claude-haiku-5': 2 }, root_effort: { unknown: 2 }, patched: 0, preserved: 2, pinned: 0 }, deep: { calls: 1, proposed: { deep: 1 }, observed_model: { 'claude-opus-5': 1 }, root_effort: { high: 1 }, patched: 1, preserved: 0, pinned: 0 } },
  receipts: { accept: 2, incomplete: 1, invalid: 0, unknown: 0 },
  advisory: { accept: 0, rework: 1, replan: 0, abstain: 0, none: 2 },
  parallel: { reservation_overlap_max: 3, observed_overlap_max: 2 },
  jev_requests: { admission: jevPhase(1, 300), allocation: jevPhase(3, 1200), result: jevPhase(1, 200) },
  outcome: 'completed',
  orphan_records: 1,
  decision_mismatch: 0,
  ...over,
});
const priced = (job: string, arm: string, cost: number, ms: number, quality: 'pass' | 'fail', gate?: Record<string, unknown>): Record<string, unknown> =>
  cell(job, arm, {
    elapsed_ms: ms,
    result: { subtype: 'success', is_error: false, duration_ms: ms, num_turns: 3, total_cost_usd: cost, model_usage: usage('claude-sonnet-5', 1000, cost), usage_status: 'ok', permission_denials: 0 },
    grade: { quality, reason: null },
    ...(gate ? { gate } : {}),
  });
const ARMS5 = ['jev_hierarchy', 'frontier_native', 'orchestrated_control', 'frontier_orchestrated', 'sonnet_native'];

describe('schema 5 observation', () => {
  it('aggregates the gate blocks numerically and leaves a V4 cell unknown rather than zero', () => {
    const run = writeRun('v5-gates', [{ job: 'A', arms: ['jev_hierarchy'] }, { job: 'B', arms: ['jev_hierarchy'] }], [
      cell('A', 'jev_hierarchy', { gate: gate5() }),
      cell('B', 'jev_hierarchy', { gate: gate5({ guard_denials: 1, parallel: { reservation_overlap_max: 1, observed_overlap_max: 5 }, outcome: 'incomplete', jev_requests: { admission: jevPhase(1, 100), allocation: jevPhase(2, null), result: jevPhase(0, 0) } }) }),
    ]);
    const arm = buildReport(run).arms[0]!;
    const v = arm.gate_v5;
    expect(v.rows_observed).toBe(2);
    expect(v.admission).toEqual({ orchestrated: 2 });
    expect(v.guard_denials).toBe(3);
    expect(v.planner_requested).toBe(2);
    expect(v.planner_tier_proposed).toEqual({ deep: 2 });
    expect(v.plan_status).toEqual({ ready: 2 });
    expect(v.worker_calls['fast']).toMatchObject({ calls: 4, preserved: 4, patched: 0 });
    expect(v.worker_calls['deep']).toMatchObject({ calls: 2, patched: 2, root_effort: { high: 2 } });
    expect(v.receipts).toEqual({ accept: 4, incomplete: 2, invalid: 0, unknown: 0 });
    expect(v.advisory.rework).toBe(2);
    // The maximum concurrency observed anywhere in the arm, not a sum.
    expect(v.parallel).toEqual({ reservation_overlap_max: 3, observed_overlap_max: 5 });
    expect(v.jev_requests.admission).toMatchObject({ attempts: 2, tokens: 400 });
    expect(v.jev_requests.allocation.tokens).toBeNull();
    expect(v.jev_requests.allocation.tokens_known).toBe(1200);
    expect(v.outcomes).toEqual({ completed: 1, incomplete: 1 });
    expect(v.orphan_records).toBe(2);

    const v4 = buildReport(writeRun('v4-only', [{ job: 'A', arms: ['jev_hierarchy'] }], [cell('A', 'jev_hierarchy')]));
    expect(v4.rows[0]!.v5).toBeNull();
    expect(v4.arms[0]!.gate_v5.rows_observed).toBe(0);
    expect(v4.conclusion.category).toBe('insufficient observation');
    expect(gateV5Of({ owned_calls: 1 })).toBeNull();
  });

  it('records the raw Jev choice when the hook did not record an applied decision', () => {
    const run = writeRun('v5-choice', [{ job: 'A', arms: ['jev_hierarchy'] }], [
      cell('A', 'jev_hierarchy', { gate: gate5({ admission: { attempted: true, known_not_sent: false, forced: false, decided: false, choice: 'orchestrated', confidence: 0.9, decision: null, reason: null } }) }),
    ]);
    expect(buildReport(run).arms[0]!.gate_v5.admission).toEqual({ 'choice:orchestrated': 1 });
  });
});

describe('declared criteria', () => {
  const run5 = (name: string, cells: Record<string, Record<string, unknown>>): ReturnType<typeof buildReport> =>
    buildReport(writeRun(name, [{ job: 'A', arms: ARMS5 }], Object.values(cells)));
  const verdicts = (r: ReturnType<typeof buildReport>): Record<string, { verdict: string; reason: string }> =>
    Object.fromEntries(r.comparisons.filter((c) => c.criterion !== 'none').map((c) => [c.control, { verdict: c.verdict, reason: c.verdict_reason }]));

  it('meets the product target, the incremental requirement and the matched comparator together', () => {
    const r = run5('criteria-met', {
      jev: priced('A', 'jev_hierarchy', 4, 600, 'pass', gate5()),
      frontier: priced('A', 'frontier_native', 10, 1000, 'pass'),
      control: priced('A', 'orchestrated_control', 4, 600, 'pass'),
      fo: priced('A', 'frontier_orchestrated', 5, 700, 'pass'),
      sonnet: priced('A', 'sonnet_native', 3, 500, 'fail'),
    });
    const v = verdicts(r);
    expect(v['frontier_native']).toMatchObject({ verdict: 'met' });
    expect(v['frontier_native']!.reason).toMatch(/60\.0%/);
    expect(v['orchestrated_control']!.verdict).toBe('met');
    expect(v['frontier_orchestrated']!.verdict).toBe('met');
    expect(v['sonnet_native']!.verdict).toBe('met');
    expect(r.conclusion.category).toBe('repeated whole-job improvement in the tested workload');
    const primary = r.comparisons.find((c) => c.criterion === 'product_target')!;
    expect(primary.relative_cost_reduction).toBeCloseTo(0.6, 10);
    expect(primary.relative_runtime_reduction).toBeCloseTo(0.4, 10);
  });

  it('misses the minimums, is worse than matched orchestration, and records the frontier-coordinator conclusion', () => {
    const r = run5('criteria-missed', {
      jev: priced('A', 'jev_hierarchy', 8, 950, 'pass', gate5()),
      frontier: priced('A', 'frontier_native', 10, 1000, 'pass'),
      control: priced('A', 'orchestrated_control', 6, 800, 'pass'),
      fo: priced('A', 'frontier_orchestrated', 5, 700, 'pass'),
      sonnet: priced('A', 'sonnet_native', 3, 500, 'pass'),
    });
    const v = verdicts(r);
    expect(v['frontier_native']).toMatchObject({ verdict: 'not_met' });
    expect(v['frontier_native']!.reason).toMatch(/misses the 50%\/30% minimums/);
    expect(v['orchestrated_control']!.verdict).toBe('not_met');
    expect(v['orchestrated_control']!.reason).toMatch(/attributable to orchestration/);
    expect(v['frontier_orchestrated']!.verdict).toBe('not_met');
    expect(v['frontier_orchestrated']!.reason).toContain(FRONTIER_PREFERRED);
    expect(v['sonnet_native']!.verdict).toBe('met');
    expect(r.conclusion.category).toBe('no added value over matched orchestration');
    expect(r.conclusion.reason).toContain(FRONTIER_PREFERRED);
  });

  it('different pass counts are a trade-off row, not a win: verdict not_comparable with both arms’ numbers kept', () => {
    const r = run5('criteria-tradeoff', {
      jev: priced('A', 'jev_hierarchy', 2, 400, 'fail', gate5()),
      frontier: priced('A', 'frontier_native', 10, 1000, 'pass'),
      control: priced('A', 'orchestrated_control', 4, 600, 'pass'),
      fo: priced('A', 'frontier_orchestrated', 5, 700, 'pass'),
      sonnet: priced('A', 'sonnet_native', 3, 500, 'pass'),
    });
    const target = r.comparisons.find((c) => c.criterion === 'product_target')!;
    expect(target.verdict).toBe('not_comparable');
    expect(target.verdict_reason).toMatch(/pass counts differ \(0 vs 1\)/);
    expect(target.relative_cost_reduction).toBeCloseTo(0.8, 10);
    expect(target.relative_runtime_reduction).toBeCloseTo(0.6, 10);
    expect(r.comparisons.find((c) => c.criterion === 'pass_not_below')!.verdict).toBe('not_met');
    expect(r.conclusion.category).toBe('lower cost with quality loss');
    expect(renderMarkdown(r)).toMatch(/not_comparable/);
  });

  it('zero passes in both arms never yields met, and an unknown cost is not comparable either', () => {
    const zero = run5('criteria-zero', {
      jev: priced('A', 'jev_hierarchy', 2, 400, 'fail', gate5()),
      frontier: priced('A', 'frontier_native', 10, 1000, 'fail'),
      control: priced('A', 'orchestrated_control', 4, 600, 'fail'),
      fo: priced('A', 'frontier_orchestrated', 5, 700, 'fail'),
      sonnet: priced('A', 'sonnet_native', 3, 500, 'fail'),
    });
    for (const c of zero.comparisons.filter((x) => x.criterion !== 'none')) {
      expect(c.verdict, c.control).toBe('not_comparable');
      expect(c.verdict_reason).toMatch(/zero checker passes/);
    }
    expect(zero.conclusion.category).toBe('mechanism only');

    const unknown = run5('criteria-unknown', {
      jev: cell('A', 'jev_hierarchy', { gate: gate5(), grade: { quality: 'pass', reason: null }, result: { subtype: 'success', total_cost_usd: null, model_usage: null, usage_status: 'absent' } }),
      frontier: priced('A', 'frontier_native', 10, 1000, 'pass'),
      control: priced('A', 'orchestrated_control', 4, 600, 'pass'),
      fo: priced('A', 'frontier_orchestrated', 5, 700, 'pass'),
      sonnet: priced('A', 'sonnet_native', 3, 500, 'pass'),
    });
    const target = unknown.comparisons.find((c) => c.criterion === 'product_target')!;
    expect(target.verdict).toBe('not_comparable');
    expect(target.verdict_reason).toMatch(/spend is unknown/);
  });

  it('names the exposure that is missing before judging any cost criterion', () => {
    const noAdmission = run5('conclusion-admission', {
      jev: priced('A', 'jev_hierarchy', 4, 600, 'pass', gate5({ admission: { attempted: true, known_not_sent: false, choice: 'direct', confidence: 0.9, decision: 'direct', reason: null } })),
      frontier: priced('A', 'frontier_native', 10, 1000, 'pass'),
      control: priced('A', 'orchestrated_control', 4, 600, 'pass'),
      fo: priced('A', 'frontier_orchestrated', 5, 700, 'pass'),
      sonnet: priced('A', 'sonnet_native', 3, 500, 'pass'),
    });
    expect(noAdmission.conclusion.category).toBe('no admission exposure');
    const noAllocation = run5('conclusion-allocation', {
      jev: priced('A', 'jev_hierarchy', 4, 600, 'pass', gate5({ eligible_attempted: 0 })),
      frontier: priced('A', 'frontier_native', 10, 1000, 'pass'),
      control: priced('A', 'orchestrated_control', 4, 600, 'pass'),
      fo: priced('A', 'frontier_orchestrated', 5, 700, 'pass'),
      sonnet: priced('A', 'sonnet_native', 3, 500, 'pass'),
    });
    expect(noAllocation.conclusion.category).toBe('no allocation exposure');
  });

  it('keeps reading a retired-arm run from V4 and states no declared criterion for it', () => {
    const r = buildReport(writeRun('retired', [{ job: 'A', arms: ['jev_hierarchy', 'fixed_hierarchy'] }], [cell('A', 'jev_hierarchy'), cell('A', 'fixed_hierarchy')]));
    const row = r.comparisons.find((c) => c.control === 'fixed_hierarchy')!;
    expect(row.criterion).toBe('none');
    expect(row.verdict).toBe('not_comparable');
    expect(row.intended_rows).toBe(1);
    expect(compare(r.rows, 'jev_hierarchy', 'fixed_hierarchy', 'product_target').verdict).toBe('not_met');
  });
});

describe('diagnostic arm (A16)', () => {
  it('judges the diagnostic rows on their own numbers and keeps the conclusion on the product arm', () => {
    const run = writeRun('a16', [{ job: 'A', arms: [...ARMS5, 'jev_forced_orchestration'] }], [
      // Gate A put this workload below the admission floor, so the product arm ran direct and never reached Gate B.
      priced('A', 'jev_hierarchy', 9, 900, 'pass', gate5({ admission: { attempted: true, known_not_sent: false, forced: false, decided: true, choice: 'direct', confidence: 0.61, decision: 'direct', reason: null }, eligible_attempted: 0, worker_calls: {}, planner_calls: { requested: 0, completed: 0, tier_proposed: null, model_observed: null, plan_status: null, rev: null } })),
      { ...priced('A', 'jev_forced_orchestration', 4, 600, 'pass', gate5({ admission: { attempted: false, known_not_sent: true, forced: true, decided: null, choice: null, confidence: null, decision: 'orchestrated', reason: 'admission_forced' }, jev_requests: { admission: jevPhase(0, 0), allocation: jevPhase(3, 1200), result: jevPhase(1, 200) } })), diagnostic: true },
      priced('A', 'orchestrated_control', 4, 600, 'pass'),
      priced('A', 'frontier_orchestrated', 5, 700, 'pass'),
      priced('A', 'frontier_native', 10, 1000, 'pass'),
      priced('A', 'sonnet_native', 3, 500, 'pass'),
    ]);
    const r = buildReport(run);
    const byPair = Object.fromEntries(r.comparisons.map((c) => [`${c.treatment}->${c.control}`, c]));
    expect(byPair['jev_forced_orchestration->orchestrated_control']).toMatchObject({ criterion: 'incremental_not_worse', verdict: 'met' });
    expect(byPair['jev_forced_orchestration->frontier_orchestrated']).toMatchObject({ criterion: 'strictly_better', verdict: 'met' });
    expect(byPair['jev_forced_orchestration->jev_hierarchy']!.criterion).toBe('none');
    // The diagnostic arm beats the matched control, but the product arm never exercised admission: that is the verdict.
    expect(r.conclusion.category).toBe('no admission exposure');
    expect(r.conclusion.reason).toMatch(/diagnostic arm jev_forced_orchestration/);
    const byArm = Object.fromEntries(r.arms.map((a) => [a.arm, a]));
    expect(byArm['jev_forced_orchestration']!.diagnostic).toBe(true);
    expect(byArm['jev_forced_orchestration']!.gate_v5.admission).toEqual({ 'forced:orchestrated': 1 });
    expect(byArm['jev_forced_orchestration']!.gate_v5.jev_requests.admission.attempts).toBe(0);
    expect(byArm['jev_hierarchy']!.diagnostic).toBe(false);
    expect(renderMarkdown(r)).toContain('jev_forced_orchestration (diagnostic)');
  });
});
