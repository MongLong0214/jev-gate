import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Arm, CellRecord, Plan } from './run.js';
import { addUsage, familyTokens, money, safeSum, totalTokens, type ModelUsage } from './usage.js';

/**
 * Plan-first reporting (#16). Rows come from plan.json; artifacts are joined to them. Missing files stay missing,
 * unknown costs stay null with known subtotals beside them, and every comparison names the cohort it used.
 * Reads saved data only: no model, checker, setup or regrade work happens here.
 */
export type RowStatus = 'missing_record' | 'not_started' | 'intent_only' | 'started_no_result' | 'completed' | 'timed_out' | 'cancelled';

export interface RowView {
  job: string;
  group: string;
  repetition: number;
  arm: string;
  status: RowStatus;
  not_started_reason: string | null;
  quality: 'pass' | 'fail' | 'unknown' | null;
  grade_reason: string | null;
  elapsed_ms: number | null;
  claude_cost_usd: number | null;
  jev_cost_usd: number | null;
  total_cost_usd: number | null;
  model_usage: ModelUsage | null;
  usage_status: string | null;
  fable_tokens: number | null;
  init_model: string | null;
  root_model_consistent: boolean | null;
  plugin_state_ok: boolean | null;
  agent_calls: number;
  owned_calls: number;
  pinned: number;
  eligible_attempted: number;
  patched: number;
  preserved: number;
  skipped: Record<string, number>;
  preserve_reasons: Record<string, number>;
  attempt_unknown: number;
  missing_pre_records: number;
  hint_delivered: number;
  target_model_mismatches: number;
  record_conflicts: number;
  api_retries: number;
}

export interface ArmSummary {
  arm: string;
  planned: number;
  by_status: Record<RowStatus, number>;
  pass: number;
  fail: number;
  unknown: number;
  model_usage: ModelUsage | null;
  usage_complete: boolean;
  tokens_total: number | null;
  fable_tokens: number | null;
  claude_cost_usd: number | null;
  claude_cost_known_subtotal: number;
  claude_cost_unknown_rows: number;
  jev_cost_usd: number | null;
  jev_cost_known_subtotal: number;
  jev_cost_unknown_rows: number;
  total_cost_usd: number | null;
  cost_per_pass_usd: number | null;
  runtime_total_ms: number | null;
  runtime_known_subtotal_ms: number;
  completed_pass_latency_mean_ms: number | null;
  completed_pass_count: number;
  gate: { agent_calls: number; owned_calls: number; pinned: number; eligible_attempted: number; patched: number; preserved: number; preserve_reasons: Record<string, number>; skipped: Record<string, number>; attempt_unknown: number; missing_pre_records: number; hint_delivered: number; target_model_mismatches: number };
  validity_problems: string[];
}

export interface Comparison {
  treatment: string;
  control: string;
  intended_rows: number;
  cohort: 'planned';
  pass_treatment: number;
  pass_control: number;
  absolute_success_difference: number | null;
  relative_cost_reduction: number | null;
  relative_runtime_reduction: number | null;
  cost_known: boolean;
  runtime_known: boolean;
  validity: 'ok' | 'invalid_configuration' | 'insufficient';
  validity_reasons: string[];
  complete_case_diagnostic: { included: string[]; excluded: Array<{ row: string; reason: string }>; relative_cost_reduction: number | null; relative_runtime_reduction: number | null; pass_treatment: number; pass_control: number } | null;
}

export interface Report {
  schema: 4;
  run: string;
  generated_at: string;
  plan_schema: number | null;
  planned_rows: number;
  independent_units: { jobs: number; groups: number };
  arms: ArmSummary[];
  comparisons: Comparison[];
  rows: RowView[];
  notes: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

interface PlannedCell {
  job: string;
  group: string;
  repetition: number;
  arm: string;
  file: string;
}

/** Builds the planned (job, arm, repetition) grid from plan.json; supports the V3 plan shape for historical runs. */
export const plannedCells = (runDir: string, plan: unknown): { cells: PlannedCell[]; schema: number | null } => {
  if (!isRecord(plan)) return { cells: [], schema: null };
  if (plan['schema'] === 4 && Array.isArray(plan['rows'])) {
    const cells: PlannedCell[] = [];
    for (const row of plan['rows'] as Plan['rows']) for (const arm of row.arms) cells.push({ job: row.job, group: row.group, repetition: row.repetition, arm, file: join(runDir, 'cells', row.job, arm, String(row.repetition), 'cell.json') });
    return { cells, schema: 4 };
  }
  if (Array.isArray(plan['order'])) {
    const cases = Array.isArray(plan['cases']) ? (plan['cases'] as Array<Record<string, unknown>>) : [];
    const cells: PlannedCell[] = [];
    for (const row of plan['order'] as Array<{ case: string; arms: string[] }>) {
      const group = String(cases.find((c) => c['id'] === row.case)?.['group'] ?? 'unknown');
      for (const arm of row.arms) cells.push({ job: row.case, group, repetition: 1, arm, file: join(runDir, 'cells', row.case, arm, 'cell.json') });
    }
    return { cells, schema: typeof plan['version'] === 'number' ? (plan['version'] as number) : null };
  }
  return { cells: [], schema: null };
};

const readCell = (file: string): Record<string, unknown> | null => {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const rowStatus = (c: Record<string, unknown> | null): RowStatus => {
  if (!c) return 'missing_record';
  if (c['cancelled'] === true) return 'cancelled';
  if (c['timed_out'] === true) return 'timed_out';
  const dispatch = isRecord(c['dispatch']) ? c['dispatch'] : null;
  if (c['started'] !== true) return dispatch && dispatch['intent_at'] && !dispatch['spawn_observed_at'] ? 'intent_only' : 'not_started';
  const result = isRecord(c['result']) ? c['result'] : null;
  if (!result || result['usage_status'] === 'no_result' || (result['subtype'] === null && result['model_usage'] === null)) return 'started_no_result';
  return 'completed';
};

const usageOf = (c: Record<string, unknown>): { usage: ModelUsage | null; status: string | null } => {
  const result = isRecord(c['result']) ? c['result'] : null;
  if (!result) return { usage: null, status: null };
  const mu = result['model_usage'];
  const status = typeof result['usage_status'] === 'string' ? (result['usage_status'] as string) : mu ? 'ok' : 'absent';
  return { usage: isRecord(mu) ? (mu as ModelUsage) : null, status };
};

export const toRowView = (p: PlannedCell, c: Record<string, unknown> | null): RowView => {
  const status = rowStatus(c);
  const grade = c && isRecord(c['grade']) ? c['grade'] : null;
  const gate = c && isRecord(c['gate']) ? c['gate'] : {};
  const { usage, status: usageStatus } = c ? usageOf(c) : { usage: null, status: null };
  const result = c && isRecord(c['result']) ? c['result'] : null;
  const claude = result ? money(result['total_cost_usd']) : null;
  const jev = money(gate['jev_cost_usd']);
  const init = c && isRecord(c['init']) ? c['init'] : null;
  const pluginExpected = c ? c['plugin_expected'] : null;
  const rec = (v: unknown): Record<string, number> => (isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'number')) as Record<string, number> : {});
  const agentCalls = c && Array.isArray(c['agent_calls']) ? (c['agent_calls'] as Array<Record<string, unknown>>) : [];
  return {
    job: p.job,
    group: p.group,
    repetition: p.repetition,
    arm: p.arm,
    status,
    not_started_reason: c && typeof c['not_started_reason'] === 'string' ? (c['not_started_reason'] as string) : null,
    quality: grade && (grade['quality'] === 'pass' || grade['quality'] === 'fail' || grade['quality'] === 'unknown') ? (grade['quality'] as 'pass' | 'fail' | 'unknown') : status === 'missing_record' ? null : 'unknown',
    grade_reason: grade && typeof grade['reason'] === 'string' ? (grade['reason'] as string) : null,
    elapsed_ms: c ? money(c['elapsed_ms']) : null,
    claude_cost_usd: claude,
    jev_cost_usd: jev,
    total_cost_usd: claude !== null && jev !== null ? claude + jev : null,
    model_usage: usage,
    usage_status: usageStatus,
    fable_tokens: usage ? familyTokens(usage, 'fable') : null,
    init_model: init && typeof init['model'] === 'string' ? (init['model'] as string) : null,
    root_model_consistent: c && typeof c['root_model_consistent'] === 'boolean' ? (c['root_model_consistent'] as boolean) : null,
    plugin_state_ok: init && typeof init['jev_gate_loaded'] === 'boolean' && typeof pluginExpected === 'boolean' ? init['jev_gate_loaded'] === pluginExpected : null,
    agent_calls: agentCalls.length,
    owned_calls: typeof gate['owned_calls'] === 'number' ? (gate['owned_calls'] as number) : 0,
    pinned: typeof gate['pinned'] === 'number' ? (gate['pinned'] as number) : 0,
    eligible_attempted: typeof gate['eligible_attempted'] === 'number' ? (gate['eligible_attempted'] as number) : 0,
    patched: typeof gate['patched'] === 'number' ? (gate['patched'] as number) : 0,
    preserved: typeof gate['preserved'] === 'number' ? (gate['preserved'] as number) : 0,
    skipped: rec(gate['skipped']),
    preserve_reasons: rec(gate['preserve_reasons']),
    attempt_unknown: typeof gate['attempt_unknown'] === 'number' ? (gate['attempt_unknown'] as number) : 0,
    missing_pre_records: typeof gate['missing_pre_records'] === 'number' ? (gate['missing_pre_records'] as number) : 0,
    hint_delivered: typeof gate['hint_delivered'] === 'number' ? (gate['hint_delivered'] as number) : 0,
    target_model_mismatches: typeof gate['target_model_mismatches'] === 'number' ? (gate['target_model_mismatches'] as number) : 0,
    record_conflicts: sum(agentCalls.map((a) => (typeof a['record_conflicts'] === 'number' ? (a['record_conflicts'] as number) : 0))),
    api_retries: c && typeof c['api_retries'] === 'number' ? (c['api_retries'] as number) : 0,
  };
};

const addCounts = (into: Record<string, number>, more: Record<string, number>): void => {
  for (const [k, v] of Object.entries(more)) into[k] = (into[k] ?? 0) + v;
};

export const summarizeArm = (arm: string, rows: RowView[]): ArmSummary => {
  const mine = rows.filter((r) => r.arm === arm);
  const by_status: Record<RowStatus, number> = { missing_record: 0, not_started: 0, intent_only: 0, started_no_result: 0, completed: 0, timed_out: 0, cancelled: 0 };
  for (const r of mine) by_status[r.status]++;
  // Spend can exist for every row that was at least dispatched; a row that was confirmed not started is known zero.
  const spendRows = mine.filter((r) => r.status !== 'not_started');
  let usage: ModelUsage | null = {};
  let usageComplete = true;
  for (const r of spendRows) {
    if (r.model_usage && usage) usage = addUsage(usage, r.model_usage);
    else usageComplete = false;
    if (!usage) usageComplete = false;
  }
  const claudeKnown = spendRows.filter((r) => r.claude_cost_usd !== null);
  const jevKnown = spendRows.filter((r) => r.jev_cost_usd !== null);
  const claudeCost = spendRows.length === claudeKnown.length ? sum(claudeKnown.map((r) => r.claude_cost_usd!)) : null;
  const jevCost = spendRows.length === jevKnown.length ? sum(jevKnown.map((r) => r.jev_cost_usd!)) : null;
  const total = claudeCost !== null && jevCost !== null ? claudeCost + jevCost : null;
  const pass = mine.filter((r) => r.quality === 'pass').length;
  const runtimeKnown = spendRows.filter((r) => r.elapsed_ms !== null);
  const completedPass = mine.filter((r) => r.status === 'completed' && r.quality === 'pass' && r.elapsed_ms !== null);
  const gate = { agent_calls: 0, owned_calls: 0, pinned: 0, eligible_attempted: 0, patched: 0, preserved: 0, preserve_reasons: {} as Record<string, number>, skipped: {} as Record<string, number>, attempt_unknown: 0, missing_pre_records: 0, hint_delivered: 0, target_model_mismatches: 0 };
  const problems: string[] = [];
  for (const r of mine) {
    gate.agent_calls += r.agent_calls;
    gate.owned_calls += r.owned_calls;
    gate.pinned += r.pinned;
    gate.eligible_attempted += r.eligible_attempted;
    gate.patched += r.patched;
    gate.preserved += r.preserved;
    gate.attempt_unknown += r.attempt_unknown;
    gate.missing_pre_records += r.missing_pre_records;
    gate.hint_delivered += r.hint_delivered;
    gate.target_model_mismatches += r.target_model_mismatches;
    addCounts(gate.preserve_reasons, r.preserve_reasons);
    addCounts(gate.skipped, r.skipped);
    if (r.root_model_consistent === false) problems.push(`${r.job} r${r.repetition}: root model ${r.init_model ?? 'unknown'} does not match the requested alias`);
    if (r.plugin_state_ok === false) problems.push(`${r.job} r${r.repetition}: plugin presence differs from the plan`);
    if (r.record_conflicts > 0) problems.push(`${r.job} r${r.repetition}: ${r.record_conflicts} conflicting hook record(s)`);
  }
  const usageOk = usageComplete && usage !== null && spendRows.length > 0;
  return {
    arm,
    planned: mine.length,
    by_status,
    pass,
    fail: mine.filter((r) => r.quality === 'fail').length,
    unknown: mine.filter((r) => r.quality === 'unknown' || r.quality === null).length,
    model_usage: usageOk ? usage : null,
    usage_complete: usageOk,
    tokens_total: usageOk && usage ? safeSum(Object.values(usage).map(totalTokens)) : null,
    fable_tokens: usageOk && usage ? familyTokens(usage, 'fable') : null,
    claude_cost_usd: claudeCost,
    claude_cost_known_subtotal: sum(claudeKnown.map((r) => r.claude_cost_usd!)),
    claude_cost_unknown_rows: spendRows.length - claudeKnown.length,
    jev_cost_usd: jevCost,
    jev_cost_known_subtotal: sum(jevKnown.map((r) => r.jev_cost_usd!)),
    jev_cost_unknown_rows: spendRows.length - jevKnown.length,
    total_cost_usd: total,
    cost_per_pass_usd: total !== null && pass > 0 ? total / pass : null,
    runtime_total_ms: spendRows.length === runtimeKnown.length ? sum(runtimeKnown.map((r) => r.elapsed_ms!)) : null,
    runtime_known_subtotal_ms: sum(runtimeKnown.map((r) => r.elapsed_ms!)),
    completed_pass_latency_mean_ms: completedPass.length ? sum(completedPass.map((r) => r.elapsed_ms!)) / completedPass.length : null,
    completed_pass_count: completedPass.length,
    gate,
    validity_problems: problems,
  };
};

const ratio = (treatment: number | null, control: number | null): number | null => (treatment === null || control === null || control === 0 ? null : 1 - treatment / control);

export const compare = (rows: RowView[], treatment: string, control: string): Comparison => {
  const key = (r: RowView): string => `${r.job}#${r.repetition}`;
  const t = new Map(rows.filter((r) => r.arm === treatment).map((r) => [key(r), r]));
  const c = new Map(rows.filter((r) => r.arm === control).map((r) => [key(r), r]));
  const intended = [...t.keys()].filter((k) => c.has(k)).sort();
  const reasons: string[] = [];
  const pairs = intended.map((k) => [t.get(k)!, c.get(k)!] as const);
  for (const [a, b] of pairs) {
    for (const r of [a, b]) {
      if (r.root_model_consistent === false) reasons.push(`${r.arm} ${key(r)}: root model mismatch`);
      if (r.plugin_state_ok === false) reasons.push(`${r.arm} ${key(r)}: plugin presence mismatch`);
    }
  }
  const costKnown = pairs.every(([a, b]) => a.total_cost_usd !== null && b.total_cost_usd !== null);
  const runtimeKnown = pairs.every(([a, b]) => a.elapsed_ms !== null && b.elapsed_ms !== null);
  const passT = pairs.filter(([a]) => a.quality === 'pass').length;
  const passC = pairs.filter(([, b]) => b.quality === 'pass').length;
  const complete = pairs.filter(([a, b]) => a.status === 'completed' && b.status === 'completed' && a.total_cost_usd !== null && b.total_cost_usd !== null && a.elapsed_ms !== null && b.elapsed_ms !== null);
  const excluded = pairs.filter((p) => !complete.includes(p)).map(([a, b]) => ({ row: key(a), reason: `${a.arm}:${a.status}${a.total_cost_usd === null ? '/cost unknown' : ''}, ${b.arm}:${b.status}${b.total_cost_usd === null ? '/cost unknown' : ''}` }));
  return {
    treatment,
    control,
    intended_rows: intended.length,
    cohort: 'planned',
    pass_treatment: passT,
    pass_control: passC,
    absolute_success_difference: intended.length ? passT / intended.length - passC / intended.length : null,
    relative_cost_reduction: costKnown && pairs.length ? ratio(sum(pairs.map(([a]) => a.total_cost_usd!)), sum(pairs.map(([, b]) => b.total_cost_usd!))) : null,
    relative_runtime_reduction: runtimeKnown && pairs.length ? ratio(sum(pairs.map(([a]) => a.elapsed_ms!)), sum(pairs.map(([, b]) => b.elapsed_ms!))) : null,
    cost_known: costKnown,
    runtime_known: runtimeKnown,
    validity: intended.length === 0 ? 'insufficient' : reasons.length ? 'invalid_configuration' : 'ok',
    validity_reasons: reasons,
    complete_case_diagnostic: intended.length
      ? {
          included: complete.map(([a]) => key(a)),
          excluded,
          relative_cost_reduction: complete.length ? ratio(sum(complete.map(([a]) => a.total_cost_usd!)), sum(complete.map(([, b]) => b.total_cost_usd!))) : null,
          relative_runtime_reduction: complete.length ? ratio(sum(complete.map(([a]) => a.elapsed_ms!)), sum(complete.map(([, b]) => b.elapsed_ms!))) : null,
          pass_treatment: complete.filter(([a]) => a.quality === 'pass').length,
          pass_control: complete.filter(([, b]) => b.quality === 'pass').length,
        }
      : null,
  };
};

const COMPARISONS: Array<[string, string]> = [['jev_hierarchy', 'native_hierarchy'], ['jev_hierarchy', 'fixed_hierarchy'], ['jev_hierarchy', 'sonnet_native'], ['jev_hierarchy', 'frontier_native'], ['native_hierarchy', 'sonnet_native'], ['sonnet_gated', 'sonnet_native'], ['sonnet_gated', 'frontier_raw']];

export const buildReport = (runDir: string): Report => {
  const planPath = join(runDir, 'plan.json');
  const plan = existsSync(planPath) ? (JSON.parse(readFileSync(planPath, 'utf8')) as unknown) : null;
  const { cells, schema } = plannedCells(runDir, plan);
  const rows = cells.map((p) => toRowView(p, readCell(p.file)));
  const arms = [...new Set(rows.map((r) => r.arm))];
  const armSummaries = arms.map((a) => summarizeArm(a, rows));
  const comparisons = COMPARISONS.filter(([t, c]) => arms.includes(t) && arms.includes(c)).map(([t, c]) => compare(rows, t, c));
  const notes = [
    'Rows come from plan.json. missing_record means the planned cell has no saved file; it is not "not started" and never cost zero.',
    'Claude total_cost_usd is an API-equivalent estimate (whole tree incl. children), not subscription billing or quota; Jev cost is list price × input tokens, null when any attempt has unknown usage.',
    'Totals are over the planned cohort including failures and timeouts; a null total means some consumption is unknown and the known subtotal is shown beside it.',
    'The complete-case diagnostic is labeled and lists exclusions; it never replaces the planned-cohort headline. Per-row percentages are not averaged.',
    'A timeout duration is not time-to-success; completed_pass_latency is reported separately with its count.',
    'Whole jobs are the unit; repetitions and child tasks of one job are clustered observations. Same pass counts are not evidence of equivalence.',
    'Historical V3 runs lack V4 gate fields; those stay unknown rather than being inferred.',
  ];
  return {
    schema: 4,
    run: runDir,
    generated_at: new Date().toISOString(),
    plan_schema: schema,
    planned_rows: rows.length,
    independent_units: { jobs: new Set(rows.map((r) => r.job)).size, groups: new Set(rows.map((r) => r.group)).size },
    arms: armSummaries,
    comparisons,
    rows,
    notes,
  };
};

const fmt = (v: number | null, digits = 2): string => (v === null ? 'null' : v.toFixed(digits));
const pct = (v: number | null): string => (v === null ? 'null' : `${(v * 100).toFixed(1)}%`);
const counts = (r: Record<string, number>): string => Object.entries(r).map(([k, v]) => `${k}:${v}`).join(' ') || '-';

export const renderMarkdown = (r: Report): string => {
  const L: string[] = [`# jev-gate bench report (schema 4)`, '', `run: ${r.run}`, `generated: ${r.generated_at}`, `plan schema: ${String(r.plan_schema)} · planned rows: ${r.planned_rows} · independent units: ${r.independent_units.jobs} jobs / ${r.independent_units.groups} groups`, ''];
  L.push('## arms (planned cohort)', '', '| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of r.arms) {
    const cc = (v: number | null, sub: number, unk: number, d: number): string => (v === null ? `null (known ${sub.toFixed(d)}, ${unk} unknown)` : v.toFixed(d));
    L.push(`| ${a.arm} | ${a.planned} | ${a.by_status.completed} | ${a.by_status.timed_out} | ${a.by_status.cancelled} | ${a.by_status.not_started + a.by_status.intent_only} | ${a.by_status.missing_record} | ${a.pass} | ${a.fail} | ${a.unknown} | ${a.fable_tokens ?? 'null'} | ${a.tokens_total ?? 'null'} | ${cc(a.claude_cost_usd, a.claude_cost_known_subtotal, a.claude_cost_unknown_rows, 4)} | ${cc(a.jev_cost_usd, a.jev_cost_known_subtotal, a.jev_cost_unknown_rows, 6)} | ${fmt(a.total_cost_usd, 4)} | ${fmt(a.cost_per_pass_usd, 4)} | ${a.runtime_total_ms === null ? `null (known ${(a.runtime_known_subtotal_ms / 1000).toFixed(1)})` : (a.runtime_total_ms / 1000).toFixed(1)} | ${a.completed_pass_latency_mean_ms === null ? 'null' : (a.completed_pass_latency_mean_ms / 1000).toFixed(1)} (${a.completed_pass_count}) | ${a.usage_complete} |`);
  }
  L.push('', '## gate activity per arm', '', '| arm | Agent calls | owned | pinned | eligible attempted | patched | preserved (reasons) | skipped (codes) | attempt unknown | missing pre records | hint delivered | target/actual mismatches | validity problems |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of r.arms) L.push(`| ${a.arm} | ${a.gate.agent_calls} | ${a.gate.owned_calls} | ${a.gate.pinned} | ${a.gate.eligible_attempted} | ${a.gate.patched} | ${a.gate.preserved} (${counts(a.gate.preserve_reasons)}) | ${counts(a.gate.skipped)} | ${a.gate.attempt_unknown} | ${a.gate.missing_pre_records} | ${a.gate.hint_delivered} | ${a.gate.target_model_mismatches} | ${a.validity_problems.length ? a.validity_problems.join('; ') : '-'} |`);
  L.push('', '## comparisons (planned cohort; intended common rows)', '', '| treatment vs control | rows | pass T/C | Δ success | cost reduction | runtime reduction | validity | complete-case diagnostic |', '|---|---|---|---|---|---|---|---|');
  for (const c of r.comparisons) {
    const d = c.complete_case_diagnostic;
    L.push(`| ${c.treatment} vs ${c.control} | ${c.intended_rows} | ${c.pass_treatment}/${c.pass_control} | ${c.absolute_success_difference === null ? 'null' : (c.absolute_success_difference * 100).toFixed(1) + ' pts'} | ${c.cost_known ? pct(c.relative_cost_reduction) : 'null (unknown spend)'} | ${c.runtime_known ? pct(c.relative_runtime_reduction) : 'null (unknown runtime)'} | ${c.validity}${c.validity_reasons.length ? ` (${c.validity_reasons.join('; ')})` : ''} | ${d ? `${d.included.length}/${c.intended_rows} rows: cost ${pct(d.relative_cost_reduction)}, runtime ${pct(d.relative_runtime_reduction)}, pass ${d.pass_treatment}/${d.pass_control}${d.excluded.length ? `; excluded ${d.excluded.map((e) => `${e.row} (${e.reason})`).join(', ')}` : ''}` : '-'} |`);
  }
  L.push('', '## per-model tokens', '');
  for (const a of r.arms) L.push(`- ${a.arm}: ${a.model_usage ? Object.entries(a.model_usage).map(([m, e]) => `${m} in=${e.inputTokens} out=${e.outputTokens} cacheRead=${e.cacheReadInputTokens} cacheCreate=${e.cacheCreationInputTokens}`).join('; ') : 'incomplete'}`);
  L.push('', '## rows', '', '| job | rep | arm | status | quality | reason | elapsed s | Claude $ | Jev $ | Fable tokens | init model | Agent calls (owned/pinned) | attempted/patched/preserved | hint | mismatches |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of r.rows) L.push(`| ${x.job} | ${x.repetition} | ${x.arm} | ${x.status}${x.not_started_reason ? ` (${x.not_started_reason})` : ''} | ${x.quality ?? '-'} | ${x.grade_reason ?? '-'} | ${x.elapsed_ms === null ? 'null' : (x.elapsed_ms / 1000).toFixed(1)} | ${fmt(x.claude_cost_usd, 4)} | ${fmt(x.jev_cost_usd, 6)} | ${x.fable_tokens ?? 'null'} | ${x.init_model ?? 'null'} | ${x.agent_calls} (${x.owned_calls}/${x.pinned}) | ${x.eligible_attempted}/${x.patched}/${x.preserved} | ${x.hint_delivered} | ${x.target_model_mismatches} |`);
  L.push('', '## notes', '', ...r.notes.map((n) => `- ${n}`), '');
  return L.join('\n');
};

/** Writes a new report revision under <run>/reports/ and returns its paths; earlier revisions are never overwritten. */
export const writeReport = (runDir: string, report: Report): { json: string; md: string } => {
  const dir = join(runDir, 'reports');
  mkdirSync(dir, { recursive: true });
  let n = 1;
  while (existsSync(join(dir, `report-${n}.json`))) n++;
  const json = join(dir, `report-${n}.json`);
  const md = join(dir, `report-${n}.md`);
  writeFileSync(json, JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(md, renderMarkdown(report), 'utf8');
  return { json, md };
};

export const main = (argv: string[]): number => {
  const i = argv.indexOf('--run');
  const runDir = i >= 0 ? argv[i + 1] : undefined;
  if (!runDir) {
    process.stderr.write('usage: report.js --run <run dir>\n');
    return 1;
  }
  const abs = resolve(runDir);
  const report = buildReport(abs);
  const paths = writeReport(abs, report);
  process.stdout.write(renderMarkdown(report));
  process.stderr.write(`wrote ${paths.md} and ${paths.json}\n`);
  return 0;
};

const isMainModule = (): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMainModule()) process.exitCode = main(process.argv.slice(2));

