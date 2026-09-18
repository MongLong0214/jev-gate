// Offline Gate A calibration (#29 "Gate A calibration", #24). Calls Jev once per labeled prompt in an admission-set,
// no repository mutation, no retries. Run before any live V5 session; record the result, do not tune thresholds after.
// Usage: node scripts/gate-a-calibration.mjs [--set bench/v5/admission-set.json] [--out <json path>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const DEADLINE_MS = 4000;
// Matches JEV_PRICING['jev-1.13.0'] in src/bench/usage.ts; kept as a local literal, this script does not import bench/.
const USD_PER_INPUT_MTOK = 0.042;
const LABELS = ['direct', 'orchestrated', 'needs_context', 'abstain'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const parseArgs = (argv) => {
  const args = { set: 'bench/v5/admission-set.json', out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--set') args.set = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
};

/** Dynamic import so a missing module or export produces one clear message instead of a bare ESM resolution error. */
const loadModule = async (relPath, names) => {
  const abs = join(ROOT, relPath);
  let mod;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (err) {
    throw new Error(`cannot import ${relPath}: ${err.message} (run "npm run build" first, or the module does not exist yet)`);
  }
  for (const name of names) {
    if (!(name in mod)) throw new Error(`${relPath} does not export "${name}" (module API still in progress)`);
  }
  return mod;
};

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const loadAdmissionSet = (setPath) => {
  const abs = resolve(ROOT, setPath);
  const raw = readFileSync(abs, 'utf8');
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) throw new Error(`${abs} must be an object with an "items" array`);
  const seen = new Set();
  for (const item of parsed.items) {
    if (!isRecord(item) || typeof item.id !== 'string' || !ID_RE.test(item.id)) throw new Error(`invalid or missing id: ${JSON.stringify(item?.id)}`);
    if (seen.has(item.id)) throw new Error(`duplicate id: ${item.id}`);
    seen.add(item.id);
    if (typeof item.label !== 'string' || typeof item.group !== 'string' || typeof item.prompt !== 'string') throw new Error(`item ${item.id} missing label/group/prompt`);
  }
  return { abs, doc: parsed };
};

const todayIso = () => new Date().toISOString().slice(0, 10);

const printConfusion = (rows) => {
  const table = {};
  for (const label of LABELS) table[label] = { direct: 0, orchestrated: 0, needs_context: 0, abstain: 0, invalid: 0 };
  for (const r of rows) {
    const row = table[r.label] ?? (table[r.label] = { direct: 0, orchestrated: 0, needs_context: 0, abstain: 0, invalid: 0 });
    const col = r.choice && LABELS.includes(r.choice) ? r.choice : 'invalid';
    row[col] = (row[col] ?? 0) + 1;
  }
  process.stdout.write('\n== confusion (rows: label, cols: raw choice) ==\n');
  console.table(Object.fromEntries(Object.entries(table).map(([label, cols]) => [label, cols])));
};

const printAccuracy = (rows) => {
  const groups = [...new Set(rows.map((r) => r.group))];
  const out = {};
  for (const g of groups) {
    const mine = rows.filter((r) => r.group === g);
    const correct = mine.filter((r) => r.choice === r.label).length;
    const fallback = mine.filter((r) => r.decided_shape === 'direct_default').length;
    out[g] = { n: mine.length, raw_accuracy: mine.length ? +(correct / mine.length).toFixed(2) : null, direct_default: fallback };
  }
  process.stdout.write('\n== per-group accuracy (choice === label; direct_default tracked separately) ==\n');
  console.table(out);
};

const printConfidenceHistogram = (rows) => {
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, count: 0 }));
  let nullCount = 0;
  for (const r of rows) {
    if (typeof r.confidence !== 'number') {
      nullCount++;
      continue;
    }
    const idx = Math.min(9, Math.floor(r.confidence * 10));
    bins[idx].count++;
  }
  process.stdout.write('\n== confidence histogram (0.1 bins) ==\n');
  console.table([...bins.map((b) => ({ bin: `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`, count: b.count })), { bin: 'null', count: nullCount }]);
};

const main = async () => {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    process.stderr.write('gate-a-calibration: TYPESAFE_API_KEY is not set. Export it before running this script.\n');
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  const admissionMod = await loadModule('dist/admission.js', ['buildAdmissionRequest', 'decideAdmission', 'EXECUTION_QUESTION']);
  const jevMod = await loadModule('dist/jev.js', ['callJev']);
  const configMod = await loadModule('dist/config.js', ['DEFAULT_CONFIG']);
  const { buildAdmissionRequest, decideAdmission, EXECUTION_QUESTION } = admissionMod;
  const { callJev } = jevMod;
  const { DEFAULT_CONFIG } = configMod;
  const floor = typeof DEFAULT_CONFIG.admissionConfidenceFloor === 'number' ? DEFAULT_CONFIG.admissionConfidenceFloor : DEFAULT_CONFIG.routeConfidenceFloor;

  const { abs: setPath, doc } = loadAdmissionSet(args.set);
  const items = doc.items;
  const skipped = items.filter((i) => i.prompt.startsWith('PLACEHOLDER_')).map((i) => i.id);
  const runnable = items.filter((i) => !i.prompt.startsWith('PLACEHOLDER_'));

  const results = [];
  for (const item of runnable) {
    const request = buildAdmissionRequest(item.prompt, DEFAULT_CONFIG);
    const outcome = await callJev(request, { apiKey, deadlineMs: DEADLINE_MS });
    const row = { id: item.id, label: item.label, group: item.group, choice: null, confidence: null, probabilities: null, decided_shape: null, reason: null, http_code: null, duration_ms: outcome.durationMs ?? null, usage: null };
    if (outcome.ok) {
      row.usage = outcome.response.usage ?? null;
      row.http_code = outcome.status ?? 200;
      const decision = decideAdmission(outcome.response.answers, floor);
      row.decided_shape = decision.shape ?? null;
      row.reason = decision.reason ?? null;
      if (decision.answer) {
        row.choice = decision.answer.choice ?? null;
        row.confidence = decision.answer.confidence ?? null;
        row.probabilities = decision.answer.probabilities ?? null;
      }
    } else {
      row.http_code = outcome.status ?? null;
      row.reason = outcome.code ?? 'unknown';
      row.decided_shape = 'direct_default';
    }
    results.push(row);
    process.stdout.write(`${item.id}: choice=${row.choice ?? '-'} decided=${row.decided_shape ?? '-'} reason=${row.reason ?? '-'} http=${row.http_code ?? '-'} ${row.duration_ms ?? '-'}ms\n`);
  }

  printConfusion(results);
  printAccuracy(results);
  printConfidenceHistogram(results);

  const totalInputTokens = results.reduce((sum, r) => (typeof r.usage?.input_tokens === 'number' ? sum + r.usage.input_tokens : sum), 0);
  const costUsd = (totalInputTokens / 1_000_000) * USD_PER_INPUT_MTOK;
  process.stdout.write(`\ntotal Jev input tokens: ${totalInputTokens}\nestimated cost: $${costUsd.toFixed(6)} (at $${USD_PER_INPUT_MTOK}/M input tokens)\n`);
  if (skipped.length) process.stdout.write(`skipped (placeholder prompts, not called): ${skipped.join(', ')}\n`);

  const outPath = args.out ? resolve(ROOT, args.out) : join(ROOT, 'bench', 'results', `gate-a-calibration-${todayIso()}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  const output = {
    version: 5,
    generated_at: new Date().toISOString(),
    set_path: setPath,
    question: EXECUTION_QUESTION,
    deadline_ms: DEADLINE_MS,
    admission_confidence_floor: floor,
    usd_per_input_mtok: USD_PER_INPUT_MTOK,
    total_input_tokens: totalInputTokens,
    estimated_cost_usd: costUsd,
    skipped,
    results,
  };
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  process.stderr.write(`wrote ${outPath}\n`);
};

main().catch((err) => {
  process.stderr.write(`gate-a-calibration failed: ${err.message}\n`);
  process.exit(1);
});
