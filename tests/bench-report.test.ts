import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildReport, compare, plannedCells, renderMarkdown, summarizeArm, toRowView } from '../src/bench/report.js';
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
