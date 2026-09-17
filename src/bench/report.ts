import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Arm, CellRecord } from './run.js';
import { addUsage, isFableModel, totalTokens, type ModelUsage } from './usage.js';

const ARM_ORDER: Arm[] = ['frontier_raw', 'frontier_enriched', 'sonnet_native', 'sonnet_gated'];

export interface ArmSummary {
  arm: Arm;
  planned: number;
  started: number;
  pass: number;
  fail: number;
  unknown: number;
  timed_out: number;
  usage_complete: boolean;
  model_usage: ModelUsage;
  fable_tokens: number | null;
  total_tokens: number | null;
  claude_cost_usd: number | null;
  jev_cost_usd: number | null;
  jev_cost_unknown_cells: number;
  total_cost_usd: number | null;
  cost_per_pass_usd: number | null;
  elapsed_mean_ms: number | null;
  gate_ms_mean: number | null;
  fallback_cells: number;
  match: number;
  mismatch: number;
  api_retries: number;
  root_model_inconsistent: number;
}

export interface Report {
  version: 3;
  run: string;
  generated_at: string;
  arms: ArmSummary[];
  complete_case_set: string[];
  deltas_vs_frontier_raw: { fable_volume_change: number | null; total_cost_change: number | null; elapsed_change: number | null };
  deltas_vs_sonnet_native: { fable_volume_change: number | null; total_cost_change: number | null; elapsed_change: number | null };
  cells: Array<Pick<CellRecord, 'case' | 'arm' | 'started' | 'elapsed_ms' | 'timed_out' | 'exit_code'> & { quality: string; fable_tokens: number | null; total_cost_usd: number | null; jev_cost_usd: number | null; recommended: string | null; actual_agents: string; match: string; fallback: number; init_model: string | null; plugins: string }>;
  notes: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const readCells = (runDir: string): CellRecord[] => {
  const cellsDir = join(runDir, 'cells');
  if (!existsSync(cellsDir)) return [];
  const out: CellRecord[] = [];
  for (const cs of readdirSync(cellsDir)) {
    for (const arm of readdirSync(join(cellsDir, cs))) {
      const p = join(cellsDir, cs, arm, 'cell.json');
      if (existsSync(p)) out.push(JSON.parse(readFileSync(p, 'utf8')) as CellRecord);
    }
  }
  return out;
};

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]): number | null => (xs.length ? sum(xs) / xs.length : null);
const fableTokens = (usage: ModelUsage | null): number | null =>
  usage === null ? null : sum(Object.entries(usage).filter(([m]) => isFableModel(m)).map(([, e]) => totalTokens(e)));
const cellClaudeCost = (c: CellRecord): number | null => c.result?.total_cost_usd ?? null;
const cellTotalCost = (c: CellRecord): number | null => {
  const claude = cellClaudeCost(c);
  if (claude === null || c.gate.jev_cost_usd === null) return null;
  return claude + c.gate.jev_cost_usd;
};

export const summarizeArm = (arm: Arm, cells: CellRecord[]): ArmSummary => {
  const mine = cells.filter((c) => c.arm === arm);
  const started = mine.filter((c) => c.started);
  const usage: ModelUsage = {};
  let usageComplete = started.length > 0;
  for (const c of started) {
    if (c.result?.model_usage) addUsage(usage, c.result.model_usage);
    else usageComplete = false;
  }
  const costs = started.map(cellClaudeCost);
  const jevCosts = started.map((c) => c.gate.jev_cost_usd);
  const claudeCost = costs.every((x) => x !== null) && started.length ? sum(costs as number[]) : null;
  const jevKnown = jevCosts.filter((x): x is number => x !== null);
  const jevCost = jevKnown.length === started.length && started.length ? sum(jevKnown) : null;
  const totalCost = claudeCost !== null && jevCost !== null ? claudeCost + jevCost : null;
  const pass = started.filter((c) => c.grade?.quality === 'pass').length;
  const gateMs = started.map((c) => c.gate.gate_ms_total).filter((x): x is number => x !== null);
  return {
    arm,
    planned: mine.length,
    started: started.length,
    pass,
    fail: started.filter((c) => c.grade?.quality === 'fail').length,
    unknown: started.filter((c) => !c.grade || c.grade.quality === 'unknown').length,
    timed_out: started.filter((c) => c.timed_out).length,
    usage_complete: usageComplete,
    model_usage: usage,
    fable_tokens: usageComplete ? fableTokens(usage) : null,
    total_tokens: usageComplete ? sum(Object.values(usage).map(totalTokens)) : null,
    claude_cost_usd: claudeCost,
    jev_cost_usd: jevCost,
    jev_cost_unknown_cells: started.length - jevKnown.length,
    total_cost_usd: totalCost,
    cost_per_pass_usd: totalCost !== null && pass > 0 ? totalCost / pass : null,
    elapsed_mean_ms: mean(started.map((c) => c.elapsed_ms).filter((x): x is number => x !== null)),
    gate_ms_mean: mean(gateMs),
    fallback_cells: started.filter((c) => c.gate.fallback_count > 0).length,
    match: started.filter((c) => c.gate.match === 'match').length,
    mismatch: started.filter((c) => c.gate.match === 'mismatch').length,
    api_retries: sum(started.map((c) => c.api_retries)),
    root_model_inconsistent: started.filter((c) => c.root_model_consistent === false).length,
  };
};

const completeCaseSet = (cells: CellRecord[]): string[] => {
  const ids = [...new Set(cells.map((c) => c.case))].sort();
  return ids.filter((id) =>
    ARM_ORDER.every((arm) => {
      const c = cells.find((x) => x.case === id && x.arm === arm);
      return c && c.started && c.result && c.result.model_usage && c.grade && !c.timed_out && !c.cancelled && cellTotalCost(c) !== null;
    }),
  );
};

const ratio = (num: number | null, den: number | null): number | null => (num === null || den === null || den === 0 ? null : 1 - num / den);

const deltas = (cells: CellRecord[], complete: string[], baseline: Arm): Report['deltas_vs_frontier_raw'] => {
  const pick = (arm: Arm): CellRecord[] => complete.map((id) => cells.find((c) => c.case === id && c.arm === arm)!);
  if (complete.length === 0) return { fable_volume_change: null, total_cost_change: null, elapsed_change: null };
  const gated = pick('sonnet_gated');
  const base = pick(baseline);
  const fable = (xs: CellRecord[]): number => sum(xs.map((c) => fableTokens(c.result!.model_usage) ?? 0));
  const cost = (xs: CellRecord[]): number => sum(xs.map((c) => cellTotalCost(c)!));
  const elapsed = (xs: CellRecord[]): number | null => mean(xs.map((c) => c.elapsed_ms!));
  return {
    fable_volume_change: ratio(fable(gated), fable(base)),
    total_cost_change: ratio(cost(gated), cost(base)),
    elapsed_change: ratio(elapsed(gated), elapsed(base)),
  };
};

export const buildReport = (runDir: string): Report => {
  const cells = readCells(runDir);
  const complete = completeCaseSet(cells);
  const notes = [
    'Claude total_cost_usd is an API-equivalent estimate, not subscription billing or quota; Jev cost is list price × input tokens, null when unknown.',
    'Deltas use only the complete case set (all four arms started, finished without timeout, with whole-tree modelUsage and known Jev cost). Per-case savings are not averaged.',
    'A Fable-free arm that fails its behavior check is not a saving; pass/fail/unknown are reported next to every cost figure.',
    'Recommendation/actual match is observed from the hook trace and the Agent tool calls in the stream; mismatches and fallbacks are product results and stay in every total.',
  ];
  const plan = existsSync(join(runDir, 'plan.json')) ? (JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8')) as unknown) : null;
  if (isRecord(plan) && isRecord(plan['preflight']) && Array.isArray(plan['preflight']['env_conflicts']) && plan['preflight']['env_conflicts'].length) {
    notes.push(`env conflicts recorded at preflight: ${(plan['preflight']['env_conflicts'] as string[]).join(', ')}`);
  }
  return {
    version: 3,
    run: runDir,
    generated_at: new Date().toISOString(),
    arms: ARM_ORDER.map((arm) => summarizeArm(arm, cells)),
    complete_case_set: complete,
    deltas_vs_frontier_raw: deltas(cells, complete, 'frontier_raw'),
    deltas_vs_sonnet_native: deltas(cells, complete, 'sonnet_native'),
    cells: cells
      .sort((a, b) => a.case.localeCompare(b.case) || ARM_ORDER.indexOf(a.arm) - ARM_ORDER.indexOf(b.arm))
      .map((c) => ({
        case: c.case,
        arm: c.arm,
        started: c.started,
        elapsed_ms: c.elapsed_ms,
        timed_out: c.timed_out,
        exit_code: c.exit_code,
        quality: c.started ? c.grade?.quality ?? 'unknown' : `not started (${c.not_started_reason ?? 'unknown'})`,
        fable_tokens: fableTokens(c.result?.model_usage ?? null),
        total_cost_usd: cellTotalCost(c),
        jev_cost_usd: c.gate.jev_cost_usd,
        recommended: c.gate.recommended_execution ? `${c.gate.recommended_execution}${c.gate.recommended_agent ? `→${c.gate.recommended_agent}` : ''}` : null,
        actual_agents: c.gate.actual_agents.join(',') || '-',
        match: c.gate.match,
        fallback: c.gate.fallback_count,
        init_model: c.init?.model ?? null,
        plugins: c.init?.plugins.join(',') || '-',
      })),
    notes,
  };
};

const fmt = (v: number | null, digits = 2): string => (v === null ? 'null' : v.toFixed(digits));
const pct = (v: number | null): string => (v === null ? 'null' : `${(v * 100).toFixed(1)}%`);

export const renderMarkdown = (r: Report): string => {
  const lines: string[] = [`# jev-gate bench report`, '', `run: ${r.run}`, `generated: ${r.generated_at}`, ''];
  lines.push('| arm | planned | started | pass | fail | unknown | timed out | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | mean elapsed s | mean gate ms | fallback cells | match/mismatch | usage complete |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of r.arms) {
    lines.push(
      `| ${a.arm} | ${a.planned} | ${a.started} | ${a.pass} | ${a.fail} | ${a.unknown} | ${a.timed_out} | ${a.fable_tokens ?? 'null'} | ${a.total_tokens ?? 'null'} | ${fmt(a.claude_cost_usd, 4)} | ${fmt(a.jev_cost_usd, 6)} | ${fmt(a.total_cost_usd, 4)} | ${fmt(a.cost_per_pass_usd, 4)} | ${a.elapsed_mean_ms === null ? 'null' : (a.elapsed_mean_ms / 1000).toFixed(1)} | ${fmt(a.gate_ms_mean, 0)} | ${a.fallback_cells} | ${a.match}/${a.mismatch} | ${a.usage_complete} |`,
    );
  }
  lines.push('', `complete case set (${r.complete_case_set.length}): ${r.complete_case_set.join(', ') || 'none'}`, '');
  lines.push('| comparison | Fable volume change | total est. cost change | elapsed change |', '|---|---|---|---|');
  lines.push(`| sonnet_gated vs frontier_raw | ${pct(r.deltas_vs_frontier_raw.fable_volume_change)} | ${pct(r.deltas_vs_frontier_raw.total_cost_change)} | ${pct(r.deltas_vs_frontier_raw.elapsed_change)} |`);
  lines.push(`| sonnet_gated vs sonnet_native | ${pct(r.deltas_vs_sonnet_native.fable_volume_change)} | ${pct(r.deltas_vs_sonnet_native.total_cost_change)} | ${pct(r.deltas_vs_sonnet_native.elapsed_change)} |`);
  lines.push('', '## per-model tokens', '');
  for (const a of r.arms) {
    const models = Object.entries(a.model_usage);
    lines.push(`- ${a.arm}: ${models.length ? models.map(([m, e]) => `${m} in=${e.inputTokens} out=${e.outputTokens} cacheRead=${e.cacheReadInputTokens} cacheCreate=${e.cacheCreationInputTokens}`).join('; ') : 'none observed'}`);
  }
  lines.push('', '## cells', '', '| case | arm | quality | elapsed s | exit | Fable tokens | total est $ | Jev est $ | recommended | actual agents | match | fallback | init model | plugins |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of r.cells) {
    lines.push(`| ${c.case} | ${c.arm} | ${c.quality} | ${c.elapsed_ms === null ? 'null' : (c.elapsed_ms / 1000).toFixed(1)} | ${String(c.exit_code)} | ${c.fable_tokens ?? 'null'} | ${fmt(c.total_cost_usd, 4)} | ${fmt(c.jev_cost_usd, 6)} | ${c.recommended ?? '-'} | ${c.actual_agents} | ${c.match} | ${c.fallback} | ${c.init_model ?? 'null'} | ${c.plugins} |`);
  }
  lines.push('', '## notes', '', ...r.notes.map((n) => `- ${n}`), '');
  return lines.join('\n');
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
  const md = renderMarkdown(report);
  writeFileSync(join(abs, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(join(abs, 'report.md'), md, 'utf8');
  process.stdout.write(md);
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
