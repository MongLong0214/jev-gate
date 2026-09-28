// Offline census of every adopted plan this project has on disk, and of what A23 would and would not ask about it.
// Nothing here re-implements the gate: it imports interpretationClauses and proposedInterfaces from dist/, so the
// clause counts printed are the ones the shipped code would build. It sends no request, spends nothing, and mutates
// no repository.
//
// Each cell is admitted only when its request text is recovered from that run's OWN frozen inputs and its sha256
// matches the cell's recorded request_sha256. A cell whose request cannot be verified is reported as unverified and
// excluded from the counts rather than joined on the case id alone: a case id is reused across runs and manifests
// change, so the id is not evidence that the bytes are the same.
//
// Usage: node scripts/plan-corpus.mjs [--runs ~/jev-gate-runs] [--out <json>]
// Raw run folders stay outside the repository. This writes counts, verdicts and classifications only, never plan or
// request text.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const { interpretationClauses, proposedInterfaces, MAX_INTERPRETATION_CLAUSES } = await import(join(ROOT, 'dist/interpretation.js'));

const args = { runs: join(homedir(), 'jev-gate-runs'), out: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--runs') args.runs = resolve(process.argv[++i]);
  else if (a === '--out') args.out = resolve(process.argv[++i]);
  else { console.error(`unknown argument: ${a}`); process.exit(2); }
}

const walk = (dir, depth = 0) => {
  if (depth > 8 || !existsSync(dir)) return [];
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p, depth + 1));
    else if (e.isFile() && e.name.endsWith('.json')) out.push(p);
  }
  return out;
};

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The request bytes that produced this plan, taken from the run's own frozen inputs and checked against the cell. */
const verifiedRequest = (runDir, job, sha) => {
  const inputs = join(runDir, 'inputs', 'bench');
  if (!existsSync(inputs)) return null;
  for (const f of readdirSync(inputs).filter((n) => n.startsWith('cases') && n.endsWith('.json'))) {
    const d = readJson(join(inputs, f));
    const cases = Array.isArray(d) ? d : (d?.cases ?? []);
    for (const c of cases) {
      if (c?.id === job && typeof c.request === 'string' && sha256(c.request) === sha) return c.request;
    }
  }
  return null;
};

const rows = [];
const unverified = [];
for (const f of walk(args.runs)) {
  if (!/\/state\/jev-gate\/jobs\/[0-9a-f]+\.json$/.test(f)) continue;
  const state = readJson(f);
  const plan = state?.current?.plan;
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) continue;

  const cellDir = f.split('/state/')[0];
  const runDir = cellDir.split('/cells/')[0];
  const cell = readJson(join(cellDir, 'cell.json'));
  if (!cell) continue;

  const request = verifiedRequest(runDir, cell.job, cell.request_sha256);
  const id = { run: runDir.slice(args.runs.length + 1), job: cell.job, arm: cell.arm, rep: cell.repetition };
  if (request === null) { unverified.push({ ...id, reason: 'request bytes not recovered from this run\'s frozen inputs' }); continue; }

  // What A23 builds today, from the shipped code.
  const clauses = interpretationClauses(plan.constraints ?? []);
  const proposed = proposedInterfaces(plan.tasks);

  const interfaces = proposed.reduce((n, p) => n + p.interfaces.length, 0);
  const dataShapes = plan.tasks.reduce((n, t) => n + (t.spec?.data_shapes?.length ?? 0), 0);
  const invariants = plan.tasks.reduce((n, t) => n + (t.spec?.invariants?.length ?? 0), 0);

  rows.push({
    ...id,
    grade: cell.grade?.quality ?? null,
    grade_reason: cell.grade?.reason ?? null,
    request_verified: true,
    tasks: plan.tasks.length,
    chain_depth: plan.chain_depth ?? null,
    constraints: (plan.constraints ?? []).length,
    // A23 asks exactly one question per clause, and clauses are constraints capped at MAX_INTERPRETATION_CLAUSES.
    clauses_asked: clauses.length,
    clauses_unasked: Math.max(0, (plan.constraints ?? []).length - clauses.length),
    // Sent to the gate as `proposed` but never the subject of a question.
    spec_interfaces_sent_unasked: interfaces,
    // Not sent to the gate at all.
    spec_data_shapes_absent: dataShapes,
    spec_invariants_absent: invariants,
  });
}

rows.sort((a, b) => (a.run + a.job + a.arm + a.rep).localeCompare(b.run + b.job + b.arm + b.rep));

const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
const summary = {
  generated_at: new Date().toISOString(),
  runs_root: args.runs,
  max_interpretation_clauses: MAX_INTERPRETATION_CLAUSES,
  cells_with_plan: rows.length + unverified.length,
  cells_request_verified: rows.length,
  cells_unverified: unverified.length,
  grade: { pass: rows.filter((r) => r.grade === 'pass').length, fail: rows.filter((r) => r.grade === 'fail').length, other: rows.filter((r) => r.grade !== 'pass' && r.grade !== 'fail').length },
  plan_clause_coverage: {
    constraints_total: sum('constraints'),
    clauses_asked_total: sum('clauses_asked'),
    clauses_unasked_total: sum('clauses_unasked'),
    spec_interfaces_sent_unasked_total: sum('spec_interfaces_sent_unasked'),
    spec_data_shapes_absent_total: sum('spec_data_shapes_absent'),
    spec_invariants_absent_total: sum('spec_invariants_absent'),
  },
};

const out = { summary, cells: rows, unverified };
if (args.out) { mkdirSync(dirname(args.out), { recursive: true }); writeFileSync(args.out, JSON.stringify(out, null, 2)); }

const c = summary.plan_clause_coverage;
const questioned = c.clauses_asked_total;
const unquestioned = c.spec_interfaces_sent_unasked_total + c.spec_data_shapes_absent_total + c.spec_invariants_absent_total + c.clauses_unasked_total;
console.log(`cells with an adopted plan: ${summary.cells_with_plan} (request-verified ${summary.cells_request_verified}, unverified ${summary.cells_unverified})`);
console.log(`checker grade: pass ${summary.grade.pass}, fail ${summary.grade.fail}, other ${summary.grade.other}`);
console.log(`A23 asks about ${questioned} clauses; ${unquestioned} other plan assertions are never the subject of a question`);
console.log(`  constraints asked          ${c.clauses_asked_total}`);
console.log(`  constraints over the cap   ${c.clauses_unasked_total}`);
console.log(`  spec.interfaces   sent, unasked   ${c.spec_interfaces_sent_unasked_total}`);
console.log(`  spec.data_shapes  not sent at all ${c.spec_data_shapes_absent_total}`);
console.log(`  spec.invariants   not sent at all ${c.spec_invariants_absent_total}`);
if (args.out) console.log(`wrote ${args.out}`);
