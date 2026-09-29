// Calibration and validation of Gate A's cost model against real prompts, as pre-registered in
// bench/results/v5-gate-a-cost-2026-09-28/PREREGISTRATION.md. The request, the vetoes and the saving come from dist/,
// so the decisions here are the hook's. The rows file holds real prompt text and is never committed: this script
// writes scores, turns, depths and costs only.
//
// Usage: node scripts/gate-a-cost-replay.mjs --rows <rows-all.json> --out <summary.json> [--raw <answers.json>] [--reuse]
// --reuse reads the answers --raw already holds instead of asking Jev again: its answers are not deterministic, so a
// second pass would be a different sample of answers, not the same run.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { callJev } = await import(join(ROOT, 'dist/jev.js'));
const admission = await import(join(ROOT, 'dist/admission.js'));
const { DEFAULT_CONFIG } = await import(join(ROOT, 'dist/config.js'));

const args = { rows: null, out: null, raw: null, reuse: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--rows') args.rows = process.argv[++i];
  else if (a === '--out') args.out = process.argv[++i];
  else if (a === '--raw') args.raw = process.argv[++i];
  else if (a === '--reuse') args.reuse = true;
  else throw new Error(`unknown argument ${a}`);
}
if (!args.rows || !args.out) throw new Error('usage: node scripts/gate-a-cost-replay.mjs --rows <json> --out <json> [--raw <json>]');

const STRATA = [[0, 1], [2, 4], [5, 12], [13, 35], [36, Infinity]];
const PER_STRATUM = 20;
const MIN_BIN = 3;
const PLACEHOLDER = [0, 2, 7, 18, 60];
const model = admission.delegationModel(DEFAULT_CONFIG);

// mulberry32, seeded: the sample is fixed by the pre-registration, not by the run.
const rng = (() => {
  let t = 20260928;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
})();
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const rows = JSON.parse(readFileSync(resolve(args.rows), 'utf8'));
const sample = [];
for (const [lo, hi] of STRATA) {
  shuffle(rows.filter((r) => r.turns >= lo && r.turns <= hi)).slice(0, PER_STRATUM).forEach((r, i) => sample.push({ ...r, half: i % 2 === 0 ? 'cal' : 'val' }));
}

const answered = args.reuse ? JSON.parse(readFileSync(resolve(args.raw), 'utf8')) : [];
const failed = [];
const ask = async (row) => {
  const apiKey = readFileSync(join(homedir(), '.config/jev-gate/typesafe.key'), 'utf8').trim();
  const r = await callJev(admission.buildAtomicAdmissionRequest(row.text, DEFAULT_CONFIG), { apiKey, deadlineMs: 25_000 });
  if (!r.ok) return failed.push({ half: row.half, code: r.code });
  const a = r.response.answers;
  answered.push({
    half: row.half,
    depth: row.depth,
    turns: row.turns,
    calls: row.calls,
    cache_read: row.cache_read,
    len: row.text.length,
    answers: a,
    tool_calls: a.tool_calls?.score ?? null,
    size: a.size?.score ?? null,
    external_tools: a.external_tools?.noul ?? null,
    forbids_delegation: a.forbids_delegation?.noul ?? null,
    parallel_outcomes: a.parallel_outcomes?.noul ?? null,
  });
};
// Four at a time: the Jev budget is per call, and the order of answers does not matter.
if (!args.reuse) for (let i = 0; i < sample.length; i += 4) await Promise.all(sample.slice(i, i + 4).map(ask));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const rank = (xs) => {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
};
const spearman = (xs, ys) => {
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / rx.length;
  const my = ry.reduce((a, b) => a + b, 0) / ry.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
};

const scored = answered.filter((x) => typeof x.tool_calls === 'number');
const cal = scored.filter((x) => x.half === 'cal');
const val = scored.filter((x) => x.half === 'val');
const bins = PLACEHOLDER.map((_, k) => {
  const inBin = cal.filter((x) => Math.round(x.tool_calls) === k);
  return { bin: k, n: inBin.length, median_turns: median(inBin.map((x) => x.turns)) };
});
let running = 0;
const calibrated = bins.map((b, k) => (running = Math.max(running, b.n >= MIN_BIN ? b.median_turns : PLACEHOLDER[k])));

const oracle = (x) => x.cache_read - model.coordinatorTurns * x.depth - x.turns * model.workerTokensPerCall;
// The map under test replaces the shipped constant for this computation only, through the same exported pieces.
const turnsFor = (score) => {
  const lo = Math.floor(score);
  const hi = Math.min(lo + 1, calibrated.length - 1);
  return calibrated[lo] + (calibrated[hi] - calibrated[lo]) * (score - lo);
};
const decide = (x, vetoExternalTools = true) => {
  // Preserve the historical pre-registration policy in this replay, independently of the current runtime policy.
  if (vetoExternalTools && (x.external_tools ?? 0) >= 0.6) return { admit: false, reason: 'admission_external_tools' };
  const d = admission.decideAdmissionAtomic(x.answers, x.depth, 0, model);
  if (d.reason === 'admission_forbids_delegation' || d.reason === 'admission_invalid') return { admit: false, reason: d.reason };
  const saving = admission.delegationSaving(turnsFor(x.tool_calls), x.depth, model);
  return { admit: saving > 0, reason: saving > 0 ? null : 'admission_not_worth' };
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const validate = (vetoExternalTools) => {
  const judged = val.map((x) => ({ ...x, ...decide(x, vetoExternalTools), oracle: oracle(x) }));
  const admitted = judged.filter((x) => x.admit);
  const positive = judged.filter((x) => x.oracle > 0);
  const byReason = {};
  for (const x of judged) byReason[x.reason ?? 'admitted'] = (byReason[x.reason ?? 'admitted'] ?? 0) + 1;
  return {
    judged,
    result: {
      prompts: judged.length,
      by_reason: byReason,
      admitted: admitted.length,
      oracle_positive: positive.length,
      precision: admitted.length ? admitted.filter((x) => x.oracle > 0).length / admitted.length : null,
      recall: positive.length ? positive.filter((x) => x.admit).length / positive.length : null,
      net_oracle_saving_admitted: sum(admitted.map((x) => x.oracle)),
      net_oracle_saving_admit_all: sum(judged.map((x) => x.oracle)),
      net_oracle_saving_best_possible: sum(positive.map((x) => x.oracle)),
      native_cost_total: sum(judged.map((x) => x.cache_read)),
    },
  };
};
const pre = validate(true);
// Historical comparison without the old veto, now also the runtime policy. Keep both outputs for result provenance.
const shipped = validate(false);
const judged = pre.judged;
const byReason = pre.result.by_reason;

const summary = {
  preregistration: 'bench/results/v5-gate-a-cost-2026-09-28/PREREGISTRATION.md',
  model,
  jev_model: DEFAULT_CONFIG.jevModel,
  sampled: sample.length,
  answered: answered.length,
  failed: failed.map((f) => f.code),
  spearman_score_vs_turns: { all: spearman(scored.map((x) => x.tool_calls), scored.map((x) => x.turns)), cal: spearman(cal.map((x) => x.tool_calls), cal.map((x) => x.turns)), val: spearman(val.map((x) => x.tool_calls), val.map((x) => x.turns)) },
  calibration: { bins, placeholder: PLACEHOLDER, calibrated },
  validation: pre.result,
  validation_without_external_tools_veto_not_preregistered: shipped.result,
  shape: {
    external_tools_true: scored.filter((x) => (x.external_tools ?? 0) >= 0.6).length,
    forbids_delegation_true: scored.filter((x) => (x.forbids_delegation ?? 0) >= 0.6).length,
    auto_hierarchy: scored.filter((x) => admission.shapeRecommendation(x.answers).admitted_shape === 'hierarchy').length,
  },
  rows: judged.map(({ answers, ...x }) => x),
  cal_rows: cal.map(({ answers, ...x }) => x),
};
mkdirSync(dirname(resolve(args.out)), { recursive: true });
writeFileSync(resolve(args.out), `${JSON.stringify(summary, null, 2)}\n`);
if (args.raw) writeFileSync(resolve(args.raw), JSON.stringify(answered, null, 2));
const v = summary.validation;
const w = summary.validation_without_external_tools_veto_not_preregistered;
console.log(`answered ${answered.length}/${sample.length}; spearman ${JSON.stringify(summary.spearman_score_vs_turns)}`);
console.log(`bins ${JSON.stringify(bins)} -> calibrated ${JSON.stringify(calibrated)}`);
console.log(`validation: admitted ${v.admitted}/${v.prompts}, precision ${v.precision?.toFixed(2)}, recall ${v.recall?.toFixed(2)}`);
console.log(`net oracle saving: admitted ${v.net_oracle_saving_admitted}, admit-all ${v.net_oracle_saving_admit_all}, best ${v.net_oracle_saving_best_possible}; native ${v.native_cost_total}`);
console.log(`by reason ${JSON.stringify(byReason)}; shape ${JSON.stringify(summary.shape)}`);
console.log(`without the external_tools veto (not pre-registered): admitted ${w.admitted}/${w.prompts}, precision ${w.precision?.toFixed(2)}, recall ${w.recall?.toFixed(2)}, net ${w.net_oracle_saving_admitted}`);
