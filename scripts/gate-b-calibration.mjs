// Offline Gate B calibration: asks Jev once per labelled worker task (atomic shape, the shipped default, and the
// composite five-way shape) and per labelled planning request, and prints each decision against its label. No
// repository mutation, no retries; labels are one person's against the shipped rubric, not graded from outcomes.
// Usage: node scripts/gate-b-calibration.mjs [--set bench/v5/gate-b-set.json] [--out <json path>] [--model <id>] [--repeats 3]
// `--model` overrides config.jevModel for the run, so two Jev versions can be compared with the same code.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEADLINE_MS = 10000;
const CONCURRENCY = 4;

const parseArgs = (argv) => {
  const args = { set: 'bench/v5/gate-b-set.json', out: null, model: null, repeats: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--set') args.set = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--repeats') args.repeats = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.repeats) || args.repeats < 1) throw new Error('--repeats must be a positive integer');
  return args;
};

const load = async (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) * q)] : null;
};

const pool = async (jobs, limit) => {
  const out = new Array(jobs.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      out[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, lane));
  return out;
};

const main = async () => {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    process.stderr.write('gate-b-calibration: TYPESAFE_API_KEY is not set. Export it before running this script.\n');
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  const alloc = await load('dist/allocation.js');
  const { callJev } = await load('dist/jev.js');
  const { DEFAULT_CONFIG } = await load('dist/config.js');
  const config = { ...DEFAULT_CONFIG, ...(args.model ? { jevModel: args.model } : {}) };
  const floor = config.routeConfidenceFloor;
  const set = JSON.parse(readFileSync(resolve(ROOT, args.set), 'utf8'));

  const task = (it) => {
    const base = {
      id: 't1', outcome: it.outcome, depends_on: [], context: it.context, constraints: it.constraints, deliverables: it.deliverables,
      checks: it.checks.map((c) => ({ ...c, required: true })), replan_if: [],
    };
    return { ...base, contract_hash: '' };
  };
  const prior = (p) => (p ? { attempt: p.attempt, verdict: p.verdict, verdict_reason: p.verdict_reason, status: p.status, summary: p.summary, blockers: p.blockers, failed_checks: p.failed_checks, observed_model_confirmed: true, provenance: 'host_observed' } : null);

  const jobs = [];
  for (let rep = 1; rep <= args.repeats; rep++) {
    for (const it of set.worker) {
      for (const shape of ['atomic', 'composite']) {
        jobs.push(async () => {
          const t = task(it);
          const brief = `Complete task t1 of the approved plan. The contract below is authoritative.`;
          const build = shape === 'atomic' ? alloc.buildAtomicWorkerRouteRequest : alloc.buildWorkerRouteRequest;
          const request = build(t, [], [], brief, it.called, config, prior(it.prior_attempt), it.request);
          const o = await callJev(request, { apiKey, deadlineMs: DEADLINE_MS });
          const row = { rep, kind: 'worker', shape, id: it.id, group: it.group, label: it.label, called: it.called, decided: it.called, action: 'preserve', reason: o.ok ? null : o.code, confidence: null, input_tokens: o.ok ? o.response.usage.input_tokens : (o.usage?.input_tokens ?? null), duration_ms: o.durationMs };
          if (o.ok) {
            const d = shape === 'atomic' ? alloc.decideWorkerRouteAtomic(o.response.answers, it.called) : alloc.decideWorkerRoute(o.response.answers, floor, it.called);
            row.decided = d.tier; row.action = d.action; row.reason = d.reason; row.confidence = d.route ? d.route.confidence : null;
          }
          return row;
        });
      }
    }
  }
  const rows = await pool(jobs, CONCURRENCY);

  process.stdout.write(`model ${config.jevModel}, ${args.repeats} repeat(s), ${rows.length} calls\n`);
  for (const shape of ['atomic', 'composite']) {
    const mine = rows.filter((r) => r.shape === shape);
    const table = {};
    for (const r of mine) {
      const row = (table[r.label] ??= {});
      row[r.decided] = (row[r.decided] ?? 0) + 1;
    }
    const correct = mine.filter((r) => r.decided === r.label).length;
    const fallback = mine.filter((r) => r.reason !== null).length;
    process.stdout.write(`\n== ${shape}: decided tier by label (agreement ${correct}/${mine.length}, with a preserve/fallback reason ${fallback}) ==\n`);
    console.table(table);
    const groups = [...new Set(mine.map((r) => r.group))];
    console.table(Object.fromEntries(groups.map((g) => { const m = mine.filter((r) => r.group === g); return [g, { n: m.length, agree: m.filter((r) => r.decided === r.label).length }]; })));
    const ms = mine.map((r) => r.duration_ms).filter((x) => typeof x === 'number');
    const unknown = mine.filter((r) => r.input_tokens === null).length;
    process.stdout.write(`latency p50 ${quantile(ms, 0.5)} ms, p90 ${quantile(ms, 0.9)} ms; input tokens ${unknown ? `at least ${mine.reduce((s, r) => s + (r.input_tokens ?? 0), 0)} (${unknown} call(s) without a usage reading)` : mine.reduce((s, r) => s + r.input_tokens, 0)}\n`);
  }

  const outPath = args.out ? resolve(ROOT, args.out) : join(ROOT, 'bench', 'results', `gate-b-calibration-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ version: 1, generated_at: new Date().toISOString(), model: config.jevModel, set_path: resolve(ROOT, args.set), repeats: args.repeats, rows }, null, 2) + '\n', 'utf8');
  process.stderr.write(`wrote ${outPath}\n`);
};

main().catch((err) => {
  process.stderr.write(`gate-b-calibration failed: ${err.message}\n`);
  process.exit(1);
});
