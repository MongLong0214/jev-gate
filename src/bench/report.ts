import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GateV5, JevPhaseUsage, Plan, WorkerTierRecord } from './run.js';
import { addUsage, familyCosts, familyTokens, money, safeSum, totalTokens, type ModelUsage } from './usage.js';

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
  /** A16: the cell says whether its arm was planned as a diagnostic; the report never guesses from the arm name. */
  diagnostic: boolean;
  /** Null for a V3/V4 cell: schema-5 observation is unknown there, never zero. */
  v5: GateV5 | null;
}

export interface ArmSummary {
  arm: string;
  diagnostic: boolean;
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
  /** API-equivalent Claude cost split by observed model family; empty when the arm's usage is incomplete. */
  claude_cost_by_family: Record<string, number | null>;
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
  gate_v5: GateV5Summary;
  validity_problems: string[];
}

/** Schema-5 observation aggregated over an arm's rows. `rows_observed` says how many rows carried it at all. */
export interface GateV5Summary {
  rows_observed: number;
  admission: Record<string, number>;
  guard_denials: number;
  continue_false: number;
  planner_requested: number;
  planner_completed: number;
  planner_tier_proposed: Record<string, number>;
  planner_model_observed: Record<string, number>;
  plan_status: Record<string, number>;
  worker_calls: Record<string, WorkerTierRecord>;
  receipts: { accept: number; incomplete: number; invalid: number; unknown: number };
  advisory: { accept: number; rework: number; replan: number; abstain: number; none: number };
  parallel: { reservation_overlap_max: number; observed_overlap_max: number };
  jev_requests: { admission: JevPhaseUsage; allocation: JevPhaseUsage; result: JevPhaseUsage };
  outcomes: Record<string, number>;
  orphan_records: number;
  decision_mismatch: number;
}

/** The declared criteria (PRD §5, ADR A9/A15). `none` is a descriptive row that carries no pass/fail claim. */
export type CriterionKind = 'product_target' | 'incremental_not_worse' | 'strictly_better' | 'pass_not_below' | 'none';
export type CriterionVerdict = 'met' | 'not_met' | 'not_comparable';

export interface Comparison {
  treatment: string;
  control: string;
  criterion: CriterionKind;
  verdict: CriterionVerdict;
  verdict_reason: string;
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
  schema: 5;
  run: string;
  generated_at: string;
  plan_schema: number | null;
  planned_rows: number;
  independent_units: { jobs: number; groups: number };
  arms: ArmSummary[];
  per_job: Array<{ job: string; arms: ArmSummary[] }>;
  comparisons: Comparison[];
  conclusion: { category: string; reason: string };
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
  if ((plan['schema'] === 4 || plan['schema'] === 5) && Array.isArray(plan['rows'])) {
    const cells: PlannedCell[] = [];
    for (const row of plan['rows'] as Plan['rows']) for (const arm of row.arms) cells.push({ job: row.job, group: row.group, repetition: row.repetition, arm, file: join(runDir, 'cells', row.job, arm, String(row.repetition), 'cell.json') });
    return { cells, schema: plan['schema'] as number };
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
    diagnostic: c !== null && c['diagnostic'] === true,
    v5: gateV5Of(gate),
  };
};

const addCounts = (into: Record<string, number>, more: Record<string, number>): void => {
  for (const [k, v] of Object.entries(more)) into[k] = (into[k] ?? 0) + v;
};

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const counters = (v: unknown, keys: readonly string[]): Record<string, number> => {
  const src = isRecord(v) ? v : {};
  return Object.fromEntries(keys.map((k) => [k, int(src[k])]));
};
const jevPhase = (v: unknown): JevPhaseUsage => {
  const src = isRecord(v) ? v : {};
  return { attempts: int(src['attempts']), tokens: money(src['tokens']), tokens_known: int(src['tokens_known']), cost_usd: money(src['cost_usd']) };
};

const RECEIPT_KEYS = ['accept', 'incomplete', 'invalid', 'unknown'] as const;
const ADVISORY_KEYS = ['accept', 'rework', 'replan', 'abstain', 'none'] as const;

/** Reads the schema-5 gate block defensively; a V3/V4 cell returns null so its observation stays unknown, not zero. */
export const gateV5Of = (gate: Record<string, unknown>): GateV5 | null => {
  if (!isRecord(gate['admission']) || !isRecord(gate['jev_requests'])) return null;
  const admission = gate['admission'];
  const planner = isRecord(gate['planner_calls']) ? gate['planner_calls'] : {};
  const parallel = isRecord(gate['parallel']) ? gate['parallel'] : {};
  const jev = gate['jev_requests'];
  const workers: Record<string, WorkerTierRecord> = {};
  if (isRecord(gate['worker_calls'])) {
    for (const [tier, raw] of Object.entries(gate['worker_calls'])) {
      const w = isRecord(raw) ? raw : {};
      const dist = (v: unknown): Record<string, number> => (isRecord(v) ? (Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'number')) as Record<string, number>) : {});
      workers[tier] = { calls: int(w['calls']), proposed: dist(w['proposed']), observed_model: dist(w['observed_model']), root_effort: dist(w['root_effort']), patched: int(w['patched']), preserved: int(w['preserved']), pinned: int(w['pinned']) };
    }
  }
  return {
    admission: {
      attempted: admission['attempted'] === true,
      known_not_sent: admission['known_not_sent'] === true,
      forced: admission['forced'] === true,
      decided: typeof admission['decided'] === 'boolean' ? admission['decided'] : null,
      choice: text(admission['choice']),
      confidence: money(admission['confidence']),
      decision: text(admission['decision']),
      reason: text(admission['reason']),
    },
    guard_denials: int(gate['guard_denials']),
    continue_false: int(gate['continue_false']),
    planner_calls: { requested: int(planner['requested']), completed: int(planner['completed']), tier_proposed: text(planner['tier_proposed']), model_observed: text(planner['model_observed']), plan_status: text(planner['plan_status']), rev: money(planner['rev']) },
    worker_calls: workers,
    receipts: counters(gate['receipts'], RECEIPT_KEYS) as GateV5['receipts'],
    advisory: counters(gate['advisory'], ADVISORY_KEYS) as GateV5['advisory'],
    parallel: { reservation_overlap_max: int(parallel['reservation_overlap_max']), observed_overlap_max: int(parallel['observed_overlap_max']) },
    jev_requests: { admission: jevPhase(jev['admission']), allocation: jevPhase(jev['allocation']), result: jevPhase(jev['result']) },
    outcome: text(gate['outcome']),
    orphan_records: int(gate['orphan_records']),
    decision_mismatch: int(gate['decision_mismatch']),
  };
};

/**
 * The label an admission record contributes: a forced generation (A16) is named `forced:<shape>` so it is never read as
 * a Jev answer; otherwise the applied decision, falling back to Jev's raw choice when no decision was recorded.
 */
export const admissionLabel = (a: GateV5['admission']): string =>
  a.forced ? `forced:${a.decision ?? 'orchestrated'}` : (a.decision ?? (a.choice === null ? 'unknown' : `choice:${a.choice}`));

const emptyGateV5Summary = (): GateV5Summary => ({
  rows_observed: 0,
  admission: {},
  guard_denials: 0,
  continue_false: 0,
  planner_requested: 0,
  planner_completed: 0,
  planner_tier_proposed: {},
  planner_model_observed: {},
  plan_status: {},
  worker_calls: {},
  receipts: { accept: 0, incomplete: 0, invalid: 0, unknown: 0 },
  advisory: { accept: 0, rework: 0, replan: 0, abstain: 0, none: 0 },
  parallel: { reservation_overlap_max: 0, observed_overlap_max: 0 },
  jev_requests: { admission: { attempts: 0, tokens: 0, tokens_known: 0, cost_usd: 0 }, allocation: { attempts: 0, tokens: 0, tokens_known: 0, cost_usd: 0 }, result: { attempts: 0, tokens: 0, tokens_known: 0, cost_usd: 0 } },
  outcomes: {},
  orphan_records: 0,
  decision_mismatch: 0,
});

const addJevPhase = (into: JevPhaseUsage, more: JevPhaseUsage): void => {
  into.attempts += more.attempts;
  into.tokens_known += more.tokens_known;
  into.tokens = into.tokens === null || more.tokens === null ? null : into.tokens + more.tokens;
  into.cost_usd = into.cost_usd === null || more.cost_usd === null ? null : into.cost_usd + more.cost_usd;
};

export const summarizeGateV5 = (rows: RowView[]): GateV5Summary => {
  const out = emptyGateV5Summary();
  for (const r of rows) {
    const v = r.v5;
    if (!v) continue;
    out.rows_observed++;
    if (v.admission.attempted || v.admission.known_not_sent) addCounts(out.admission, { [admissionLabel(v.admission)]: 1 });
    out.guard_denials += v.guard_denials;
    out.continue_false += v.continue_false;
    out.planner_requested += v.planner_calls.requested;
    out.planner_completed += v.planner_calls.completed;
    if (v.planner_calls.tier_proposed) addCounts(out.planner_tier_proposed, { [v.planner_calls.tier_proposed]: 1 });
    if (v.planner_calls.model_observed) addCounts(out.planner_model_observed, { [v.planner_calls.model_observed]: 1 });
    if (v.planner_calls.plan_status) addCounts(out.plan_status, { [v.planner_calls.plan_status]: 1 });
    for (const [tier, w] of Object.entries(v.worker_calls)) {
      const into = out.worker_calls[tier] ?? { calls: 0, proposed: {}, observed_model: {}, root_effort: {}, patched: 0, preserved: 0, pinned: 0 };
      out.worker_calls[tier] = into;
      into.calls += w.calls;
      into.patched += w.patched;
      into.preserved += w.preserved;
      into.pinned += w.pinned;
      addCounts(into.proposed, w.proposed);
      addCounts(into.observed_model, w.observed_model);
      addCounts(into.root_effort, w.root_effort);
    }
    for (const k of RECEIPT_KEYS) out.receipts[k] += v.receipts[k];
    for (const k of ADVISORY_KEYS) out.advisory[k] += v.advisory[k];
    out.parallel.reservation_overlap_max = Math.max(out.parallel.reservation_overlap_max, v.parallel.reservation_overlap_max);
    out.parallel.observed_overlap_max = Math.max(out.parallel.observed_overlap_max, v.parallel.observed_overlap_max);
    addJevPhase(out.jev_requests.admission, v.jev_requests.admission);
    addJevPhase(out.jev_requests.allocation, v.jev_requests.allocation);
    addJevPhase(out.jev_requests.result, v.jev_requests.result);
    if (v.outcome) addCounts(out.outcomes, { [v.outcome]: 1 });
    out.orphan_records += v.orphan_records;
    out.decision_mismatch += v.decision_mismatch;
  }
  return out;
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
    diagnostic: mine.some((r) => r.diagnostic),
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
    claude_cost_by_family: usageOk && usage ? familyCosts(usage) : {},
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
    gate_v5: summarizeGateV5(mine),
    validity_problems: problems,
  };
};

const ratio = (treatment: number | null, control: number | null): number | null => (treatment === null || control === null || control === 0 ? null : 1 - treatment / control);

/** ADR A15: the recorded conclusion when jev_hierarchy does not beat the matched frontier coordinator. */
export const FRONTIER_PREFERRED = 'a frontier coordinator is the preferred policy on this tested pilot workload';

type Judged = Omit<Comparison, 'criterion' | 'verdict' | 'verdict_reason'>;

/**
 * Declared criteria only. Different pass counts are a trade-off, never a win: the row keeps both arms' numbers and the
 * verdict says why it is not comparable. Zero passes in both arms can never satisfy any criterion.
 */
export const judge = (kind: CriterionKind, c: Judged): { verdict: CriterionVerdict; reason: string } => {
  const cost = c.relative_cost_reduction;
  const time = c.relative_runtime_reduction;
  const at = `cost ${pct(cost)}, time ${pct(time)}`;
  if (kind === 'none') return { verdict: 'not_comparable', reason: 'descriptive row: no declared criterion' };
  if (c.intended_rows === 0) return { verdict: 'not_comparable', reason: 'no planned row runs in both arms' };
  if (c.validity !== 'ok') return { verdict: 'not_comparable', reason: `configuration invalid: ${c.validity_reasons.join('; ')}` };
  if (c.pass_treatment === 0 && c.pass_control === 0) return { verdict: 'not_comparable', reason: 'zero checker passes in both arms' };
  if (kind === 'pass_not_below') {
    return c.pass_treatment >= c.pass_control
      ? { verdict: 'met', reason: `pass ${c.pass_treatment} is not below ${c.pass_control}` }
      : { verdict: 'not_met', reason: `pass ${c.pass_treatment} is below ${c.pass_control}` };
  }
  if (c.pass_treatment !== c.pass_control) {
    return { verdict: 'not_comparable', reason: `pass counts differ (${c.pass_treatment} vs ${c.pass_control}); reported as a trade-off at ${at}` };
  }
  if (!c.cost_known || !c.runtime_known || cost === null || time === null) {
    return { verdict: 'not_comparable', reason: `equal pass ${c.pass_treatment} but ${c.cost_known && cost !== null ? 'runtime' : 'spend'} is unknown for at least one row` };
  }
  if (kind === 'product_target') {
    return cost >= 0.5 && time >= 0.3
      ? { verdict: 'met', reason: `at equal pass ${c.pass_treatment}: ${at} (minimums 50% and 30%)` }
      : { verdict: 'not_met', reason: `at equal pass ${c.pass_treatment}: ${at} misses the 50%/30% minimums` };
  }
  if (kind === 'incremental_not_worse') {
    return cost >= 0 && time >= 0
      ? { verdict: 'met', reason: `at equal pass ${c.pass_treatment}: not worse on either axis (${at})` }
      : { verdict: 'not_met', reason: `at equal pass ${c.pass_treatment}: worse on ${cost < 0 ? 'cost' : ''}${cost < 0 && time < 0 ? ' and ' : ''}${time < 0 ? 'time' : ''} (${at}); the gain is attributable to orchestration, not to Jev` };
  }
  return cost > 0 && time > 0
    ? { verdict: 'met', reason: `at equal pass ${c.pass_treatment}: lower on both axes (${at})` }
    : { verdict: 'not_met', reason: `at equal pass ${c.pass_treatment}: ${at} is not lower on both axes; ${FRONTIER_PREFERRED}` };
};

export const compare = (rows: RowView[], treatment: string, control: string, criterion: CriterionKind = 'none'): Comparison => {
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
  const judged: Judged = {
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
  const verdict = judge(criterion, judged);
  return { ...judged, criterion, verdict: verdict.verdict, verdict_reason: verdict.reason };
};

const COMPARISONS: Array<[string, string, CriterionKind]> = [
  ['jev_hierarchy', 'frontier_native', 'product_target'],
  ['jev_hierarchy', 'orchestrated_control', 'incremental_not_worse'],
  ['jev_hierarchy', 'frontier_orchestrated', 'strictly_better'],
  ['jev_hierarchy', 'sonnet_native', 'pass_not_below'],
  ['jev_forced_orchestration', 'orchestrated_control', 'incremental_not_worse'],
  ['jev_forced_orchestration', 'frontier_orchestrated', 'strictly_better'],
  ['jev_forced_orchestration', 'jev_hierarchy', 'none'],
  ['jev_hierarchy', 'native_hierarchy', 'none'],
  ['jev_hierarchy', 'fixed_hierarchy', 'none'],
  ['native_hierarchy', 'sonnet_native', 'none'],
  ['sonnet_gated', 'sonnet_native', 'none'],
  ['sonnet_gated', 'frontier_raw', 'none'],
];

/** The PRD conclusion categories (ADR A13), chosen in order: the first one the observation supports is the answer. */
export const CONCLUSION_CATEGORIES = [
  'insufficient observation',
  'no admission exposure',
  'no allocation exposure',
  'no added value over matched orchestration',
  'lower cost with quality loss',
  'lower cost with slower completion',
  'repeated whole-job improvement in the tested workload',
  'mechanism only',
] as const;

export const concludeRun = (arms: ArmSummary[], comparisons: Comparison[]): { category: string; reason: string } => {
  const jev = arms.find((a) => a.arm === 'jev_hierarchy');
  const by = (control: string): Comparison | undefined => comparisons.find((c) => c.treatment === 'jev_hierarchy' && c.control === control);
  const diagnostic = arms.find((a) => a.arm === 'jev_forced_orchestration');
  const diagnosticHint = diagnostic && diagnostic.gate_v5.rows_observed > 0 ? '; the diagnostic arm jev_forced_orchestration carries the Gate B/C observation for this run' : '';
  if (!jev || jev.by_status.completed === 0) return { category: 'insufficient observation', reason: 'no completed jev_hierarchy session in this run' };
  if (jev.gate_v5.rows_observed === 0) return { category: 'insufficient observation', reason: 'no schema-5 hook records were ingested for jev_hierarchy' };
  const orchestrated = Object.entries(jev.gate_v5.admission).some(([label, n]) => n > 0 && label.includes('orchestrated'));
  if (!orchestrated) return { category: 'no admission exposure', reason: `Gate A never admitted a prompt as orchestrated${diagnosticHint}` };
  if (jev.gate.eligible_attempted === 0) return { category: 'no allocation exposure', reason: `no owned call reached Gate B with an attempted request${diagnosticHint}` };
  const matched = by('frontier_orchestrated');
  const target = by('frontier_native');
  const incremental = by('orchestrated_control');
  if (matched?.verdict === 'not_met') return { category: 'no added value over matched orchestration', reason: `${matched.verdict_reason}` };
  if (target?.verdict === 'met' && incremental?.verdict === 'met' && matched?.verdict === 'met') {
    return { category: 'repeated whole-job improvement in the tested workload', reason: `${target.verdict_reason}; matched orchestration also beaten` };
  }
  const cheaper = target !== undefined && target.relative_cost_reduction !== null && target.relative_cost_reduction > 0;
  if (cheaper && target !== undefined && target.pass_treatment < target.pass_control) {
    return { category: 'lower cost with quality loss', reason: `${pct(target.relative_cost_reduction)} cheaper than ${target.control} but ${target.pass_treatment} passes against ${target.pass_control}` };
  }
  if (cheaper && target !== undefined && target.relative_runtime_reduction !== null && target.relative_runtime_reduction < 0) {
    return { category: 'lower cost with slower completion', reason: `${pct(target.relative_cost_reduction)} cheaper and ${pct(target.relative_runtime_reduction)} on time against ${target.control}` };
  }
  return { category: 'mechanism only', reason: 'the gates ran and were recorded, but no declared criterion was met on this cohort' };
};

export const buildReport = (runDir: string): Report => {
  const planPath = join(runDir, 'plan.json');
  const plan = existsSync(planPath) ? (JSON.parse(readFileSync(planPath, 'utf8')) as unknown) : null;
  const { cells, schema } = plannedCells(runDir, plan);
  const rows = cells.map((p) => toRowView(p, readCell(p.file)));
  const arms = [...new Set(rows.map((r) => r.arm))];
  const armSummaries = arms.map((a) => summarizeArm(a, rows));
  const jobs = [...new Set(rows.map((r) => r.job))];
  const perJob = jobs.map((job) => {
    const jobRows = rows.filter((r) => r.job === job);
    return { job, arms: [...new Set(jobRows.map((r) => r.arm))].map((a) => summarizeArm(a, jobRows)) };
  });
  const comparisons = COMPARISONS.filter(([t, c]) => arms.includes(t) && arms.includes(c)).map(([t, c, kind]) => compare(rows, t, c, kind));
  const notes = [
    'Rows come from plan.json. missing_record means the planned cell has no saved file; it is not "not started" and never cost zero.',
    'Claude total_cost_usd is an API-equivalent estimate (whole tree incl. children), not subscription billing or quota; Jev cost is list price × input tokens, null when any attempt has unknown usage.',
    'Totals are over the planned cohort including failures and timeouts; a null total means some consumption is unknown and the known subtotal is shown beside it.',
    'The complete-case diagnostic is labeled and lists exclusions; it never replaces the planned-cohort headline. Per-row percentages are not averaged.',
    'A timeout duration is not time-to-success; completed_pass_latency is reported separately with its count.',
    'Whole jobs are the unit; repetitions and child tasks of one job are clustered observations. Same pass counts are not evidence of equivalence.',
    'Historical V3/V4 runs lack schema-5 gate fields; those stay unknown rather than being inferred, and the retired fixed_hierarchy arm is still read.',
    'A verdict is met only against a declared criterion at equal checker pass; different pass counts are printed as a trade-off row and zero passes in both arms never yield met.',
    'Effort is recorded where the host exposed it (root effort at PostToolUse) and is otherwise unknown; it is never inferred from agent frontmatter.',
    'Reservation overlap needs the dispatch record a Jev call writes, so arms without Gate B report observed overlap only (post timestamp minus tool_response.totalDurationMs).',
    'A recorded Gate B decision is authoritative; decision mismatch counts the calls whose observed model family contradicts it, as a cross-check rather than a correction.',
    'An arm marked diagnostic (A16: jev_forced_orchestration, which skips Gate A and still calls Gate B and C) answers a mechanism question; it carries no product claim and the conclusion category is read from jev_hierarchy.',
  ];
  return {
    schema: 5,
    run: runDir,
    generated_at: new Date().toISOString(),
    plan_schema: schema,
    planned_rows: rows.length,
    independent_units: { jobs: new Set(rows.map((r) => r.job)).size, groups: new Set(rows.map((r) => r.group)).size },
    arms: armSummaries,
    per_job: perJob,
    comparisons,
    conclusion: concludeRun(armSummaries, comparisons),
    rows,
    notes,
  };
};

const fmt = (v: number | null, digits = 2): string => (v === null ? 'null' : v.toFixed(digits));
const pct = (v: number | null): string => (v === null ? 'null' : `${(v * 100).toFixed(1)}%`);
const counts = (r: Record<string, number>): string => Object.entries(r).map(([k, v]) => `${k}:${v}`).join(' ') || '-';

const armRow = (a: ArmSummary, label: string): string => {
  const cc = (v: number | null, sub: number, unk: number, d: number): string => (v === null ? `null (known ${sub.toFixed(d)}, ${unk} unknown)` : v.toFixed(d));
  return `| ${label} | ${a.planned} | ${a.by_status.completed} | ${a.by_status.timed_out} | ${a.by_status.cancelled} | ${a.by_status.not_started + a.by_status.intent_only} | ${a.by_status.missing_record} | ${a.pass} | ${a.fail} | ${a.unknown} | ${a.fable_tokens ?? 'null'} | ${a.tokens_total ?? 'null'} | ${cc(a.claude_cost_usd, a.claude_cost_known_subtotal, a.claude_cost_unknown_rows, 4)} | ${cc(a.jev_cost_usd, a.jev_cost_known_subtotal, a.jev_cost_unknown_rows, 6)} | ${fmt(a.total_cost_usd, 4)} | ${fmt(a.cost_per_pass_usd, 4)} | ${a.runtime_total_ms === null ? `null (known ${(a.runtime_known_subtotal_ms / 1000).toFixed(1)})` : (a.runtime_total_ms / 1000).toFixed(1)} | ${a.completed_pass_latency_mean_ms === null ? 'null' : (a.completed_pass_latency_mean_ms / 1000).toFixed(1)} (${a.completed_pass_count}) | ${a.usage_complete} |`;
};

const ARM_HEADER = ['| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];

const tierCounts = (w: Record<string, WorkerTierRecord>): string =>
  Object.entries(w)
    .map(([tier, t]) => `${tier}:${t.calls}(patched ${t.patched}, preserved ${t.preserved}, pinned ${t.pinned})`)
    .join(' ') || '-';

const V5_HEADER = ['| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];

const v5Table = (arms: ArmSummary[]): string[] => [
  ...V5_HEADER,
  ...arms.map((a) => {
    const v = a.gate_v5;
    return `| ${a.arm} | ${v.rows_observed} | ${counts(v.admission)} | ${v.guard_denials} (${v.continue_false}) | ${v.planner_requested}/${v.planner_completed} | ${counts(v.planner_tier_proposed)} | ${counts(v.planner_model_observed)} | ${counts(v.plan_status)} | ${tierCounts(v.worker_calls)} | ${counts(v.receipts)} | ${counts(v.advisory)} | ${v.parallel.reservation_overlap_max}/${v.parallel.observed_overlap_max} | ${counts(v.outcomes)} | ${v.orphan_records} | ${v.decision_mismatch} |`;
  }),
];

export const renderMarkdown = (r: Report): string => {
  const L: string[] = [`# jev-gate bench report (schema 5)`, '', `run: ${r.run}`, `generated: ${r.generated_at}`, `plan schema: ${String(r.plan_schema)} · planned rows: ${r.planned_rows} · independent units: ${r.independent_units.jobs} jobs / ${r.independent_units.groups} groups`, '', `**conclusion: ${r.conclusion.category}** — ${r.conclusion.reason}`, ''];
  L.push('## arms (planned cohort)', '', ...ARM_HEADER);
  for (const a of r.arms) L.push(armRow(a, a.diagnostic ? `${a.arm} (diagnostic)` : a.arm));
  for (const job of r.per_job) {
    L.push('', `## job ${job.job}`, '', ...ARM_HEADER);
    for (const a of job.arms) L.push(armRow(a, a.diagnostic ? `${a.arm} (diagnostic)` : a.arm));
    L.push('', `### V5 gates — ${job.job}`, '', ...v5Table(job.arms));
  }
  L.push('', '## gate activity per arm', '', '| arm | Agent calls | owned | pinned | eligible attempted | patched | preserved (reasons) | skipped (codes) | attempt unknown | missing pre records | hint delivered | target/actual mismatches | validity problems |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of r.arms) L.push(`| ${a.arm} | ${a.gate.agent_calls} | ${a.gate.owned_calls} | ${a.gate.pinned} | ${a.gate.eligible_attempted} | ${a.gate.patched} | ${a.gate.preserved} (${counts(a.gate.preserve_reasons)}) | ${counts(a.gate.skipped)} | ${a.gate.attempt_unknown} | ${a.gate.missing_pre_records} | ${a.gate.hint_delivered} | ${a.gate.target_model_mismatches} | ${a.validity_problems.length ? a.validity_problems.join('; ') : '-'} |`);
  L.push('', '## V5 gates per arm (observed)', '', ...v5Table(r.arms));
  L.push('', '## Jev requests per arm (attempts / input tokens / est $ at the dated price)', '', '| arm | admission | allocation | result |', '|---|---|---|---|');
  for (const a of r.arms) {
    const j = (p: JevPhaseUsage): string => `${p.attempts} / ${p.tokens === null ? `null (known ${p.tokens_known})` : p.tokens} / ${fmt(p.cost_usd, 6)}`;
    L.push(`| ${a.arm} | ${j(a.gate_v5.jev_requests.admission)} | ${j(a.gate_v5.jev_requests.allocation)} | ${j(a.gate_v5.jev_requests.result)} |`);
  }
  L.push('', '## worker tier distribution (observed models and root effort)', '');
  for (const a of r.arms) {
    for (const [tier, w] of Object.entries(a.gate_v5.worker_calls)) L.push(`- ${a.arm} ${tier}: calls ${w.calls}, proposed ${counts(w.proposed)}, observed ${counts(w.observed_model)}, root effort ${counts(w.root_effort)}`);
  }
  L.push('', '## comparisons (planned cohort; intended common rows)', '', '| treatment vs control | criterion | verdict | reason | rows | pass T/C | Δ success | cost reduction | runtime reduction | validity | complete-case diagnostic |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of r.comparisons) {
    const d = c.complete_case_diagnostic;
    L.push(`| ${c.treatment} vs ${c.control} | ${c.criterion} | ${c.verdict} | ${c.verdict_reason} | ${c.intended_rows} | ${c.pass_treatment}/${c.pass_control} | ${c.absolute_success_difference === null ? 'null' : (c.absolute_success_difference * 100).toFixed(1) + ' pts'} | ${c.cost_known ? pct(c.relative_cost_reduction) : 'null (unknown spend)'} | ${c.runtime_known ? pct(c.relative_runtime_reduction) : 'null (unknown runtime)'} | ${c.validity}${c.validity_reasons.length ? ` (${c.validity_reasons.join('; ')})` : ''} | ${d ? `${d.included.length}/${c.intended_rows} rows: cost ${pct(d.relative_cost_reduction)}, runtime ${pct(d.relative_runtime_reduction)}, pass ${d.pass_treatment}/${d.pass_control}${d.excluded.length ? `; excluded ${d.excluded.map((e) => `${e.row} (${e.reason})`).join(', ')}` : ''}` : '-'} |`);
  }
  L.push('', '## cost by model family (API-equivalent) and Jev cost', '');
  for (const a of r.arms) {
    const families = Object.entries(a.claude_cost_by_family).map(([f, v]) => `${f} ${fmt(v, 4)}`).join(', ') || (a.usage_complete ? 'none' : 'incomplete usage');
    L.push(`- ${a.arm}: ${families} · Jev ${fmt(a.jev_cost_usd, 6)} · total ${fmt(a.total_cost_usd, 4)}`);
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

