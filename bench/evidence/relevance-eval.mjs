// Live check of the Evidence relevance judgement (src/evidence/selector.ts selectPage) on labelled pages built from
// this repository's own files: each scenario is one goal and a page of source windows read from the working tree at run
// time, labelled relevant / unrelated / needs_context by one person against the selector's own rubric, before any run.
// The product acts on the answer only at the floors (relevant >= 0.8 is ordered first, unrelated >= 0.9 is folded), so
// those two outcomes are counted separately from the plain three-way agreement. No secrets or user data.
// Usage: TYPESAFE_API_KEY=... node bench/evidence/relevance-eval.mjs [--model jev-1.13.0] [--repeats 3] [--out <json path>]
// `--model` asks another Jev version through the same code: the request model is rewritten on the way out and the reply
// model on the way back, because the selector refuses any model but its own.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// [file, anchor line, window lines, label]
const SCENARIOS = [
  {
    id: 'status-to-code',
    goal: 'Where does the Jev client turn an HTTP status into an error code?',
    page: [
      ['src/allocation.ts', 'export const ROUTE_QUESTION', 12, 'unrelated'],
      ['src/jev.ts', 'const statusToCode', 14, 'relevant'],
      ['src/types.ts', 'export type HttpCode', 16, 'unrelated'],
      ['scripts/pack.mjs', 'const ROUTER_SHARED', 6, 'unrelated'],
      ['mods/router/hooks/client.ts', 'const reasonForStatus', 12, 'relevant'],
      ['src/config.ts', 'export const MIGRATION_SAMPLE', 12, 'unrelated'],
      ['tests/jev.test.ts', 'maps status', 6, 'relevant'],
      ['src/trace.ts', 'export const TRACE_RETENTION_MS', 3, 'unrelated'],
    ],
  },
  {
    id: 'trace-retention',
    goal: 'How long does the trace writer keep trace records?',
    page: [
      ['src/job.ts', 'export const RETENTION_MS', 3, 'unrelated'],
      ['src/jev.ts', 'const statusToCode', 10, 'unrelated'],
      ['src/trace.ts', 'export const TRACE_RETENTION_MS', 3, 'relevant'],
      ['src/evidence/types.ts', 'cacheEntries: 128', 3, 'unrelated'],
      ['src/allocation.ts', 'export const ROUTE_QUESTION', 8, 'unrelated'],
      ['src/bench/usage.ts', 'export const JEV_PRICING', 4, 'unrelated'],
    ],
  },
  {
    id: 'evidence-request-cap',
    goal: 'Which requests does the Evidence selector refuse to send because they are too large?',
    page: [
      ['src/evidence/selector.ts', 'const overCap', 4, 'relevant'],
      ['mods/router/hooks/client.ts', 'export const MAX_REQUEST_TOKENS', 3, 'unrelated'],
      ['src/evidence/selector.ts', 'while (members.length', 6, 'relevant'],
      ['mods/compact/hooks/selection.ts', '// Reserve the same exact serialized', 7, 'unrelated'],
      ['src/evidence/types.ts', 'requestBytes: 128', 3, 'relevant'],
      ['src/config.ts', 'export const MIGRATION_SAMPLE', 10, 'unrelated'],
      ['src/evidence/types.ts', 'windowLines: 40', 8, 'unrelated'],
      ['src/dashboard-page.ts', 'const PRICES', 2, 'unrelated'],
    ],
  },
  {
    id: 'partial-answers-cached',
    goal: 'Does the Evidence selector cache a batch when only some of its answers are valid?',
    page: [
      ['src/evidence/selector.ts', 'const valid: Record', 6, 'needs_context'],
      ['src/evidence/selector.ts', 'apply(b.members, valid)', 3, 'relevant'],
      ['src/jev.ts', 'const statusToCode', 10, 'unrelated'],
      ['src/evidence/cache.ts', 'Completed, fully valid', 4, 'relevant'],
      ['src/trace.ts', 'export const TRACE_RETENTION_MS', 3, 'unrelated'],
      ['src/allocation.ts', 'export const ROUTE_QUESTION', 8, 'unrelated'],
    ],
  },
  {
    id: 'router-model-check',
    goal: 'How does the Router client decide that a reply came from the wrong model?',
    page: [
      ['src/evidence/selector.ts', 'outcome.response.model !== EVIDENCE_MODEL', 1, 'unrelated'],
      ['mods/router/hooks/client.ts', "body['model'] !== JEV_MODEL", 1, 'relevant'],
      ['src/jev.ts', 'const statusToCode', 10, 'unrelated'],
      ['src/job.ts', 'export const RETENTION_MS', 3, 'unrelated'],
      ['scripts/pack.mjs', 'const ROUTER_SHARED', 4, 'unrelated'],
    ],
  },
  {
    id: 'unclear-goal',
    goal: 'What about the limit?',
    page: [
      ['src/evidence/types.ts', 'requestBytes: 128', 3, 'needs_context'],
      ['src/trace.ts', 'export const TRACE_RETENTION_MS', 3, 'needs_context'],
      ['mods/router/hooks/client.ts', 'export const MAX_REQUEST_TOKENS', 3, 'needs_context'],
      ['src/job.ts', 'export const RETENTION_MS', 3, 'needs_context'],
    ],
  },
];

const parseArgs = (argv) => {
  const args = { model: null, repeats: 3, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--repeats') args.repeats = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.repeats) || args.repeats < 1) throw new Error('--repeats must be a positive integer');
  return args;
};

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) * q)] : null;
};

const windowOf = ([file, anchor, lines], index) => {
  const all = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const at = all.findIndex((l) => l.includes(anchor));
  if (at < 0) throw new Error(`anchor not found in ${file}: ${anchor}`);
  return { path: file, startLine: at + 1, endLine: at + lines, fileSha256: String(index).padStart(64, '0'), text: all.slice(at, at + lines).join('\n') + '\n' };
};

const main = async () => {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    process.stderr.write('relevance-eval: TYPESAFE_API_KEY is not set.\n');
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  // src/evidence imports with .js specifiers, so it is bundled the way scripts/build-evidence.mjs bundles the server.
  const bundle = join(tmpdir(), `jev-evidence-eval-${process.pid}.mjs`);
  await build({
    stdin: { contents: "export { selectPage } from './src/evidence/selector.ts'; export { createJudgementCache } from './src/evidence/cache.ts'; export { EVIDENCE_MODEL, LIMITS, RELEVANT_FLOOR, UNRELATED_FLOOR } from './src/evidence/types.ts';", resolveDir: ROOT, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
  });
  const { selectPage, createJudgementCache, EVIDENCE_MODEL, LIMITS, RELEVANT_FLOOR, UNRELATED_FLOOR } = await import(pathToFileURL(bundle).href);
  const model = args.model ?? EVIDENCE_MODEL;

  const fetchImpl = async (url, init) => {
    const res = await fetch(url, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), model }) });
    const text = await res.text();
    let body = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed.model === model) body = JSON.stringify({ ...parsed, model: EVIDENCE_MODEL });
    } catch { /* a non-JSON body goes to the selector as it came */ }
    return new Response(body, { status: res.status });
  };

  const rows = [];
  const requests = [];
  for (let rep = 1; rep <= args.repeats; rep++) {
    for (const sc of SCENARIOS) {
      const page = sc.page.map(windowOf);
      const events = [];
      // A fresh cache per call: a cache hit would skip the very request this measures.
      const selection = await selectPage(sc.goal, [], page, 'bench', Date.now() + LIMITS.deadlineMs, new AbortController().signal, {
        apiKey, cache: createJudgementCache(), http: { active: 0 }, fetchImpl, now: Date.now, observeRemote: (e) => events.push(e),
      });
      const result = events.find((e) => e.phase === 'result');
      requests.push({ rep, scenario: sc.id, reasons: selection.reasons, duration_ms: result?.duration_ms ?? null, status: result?.status ?? null, code: result?.code ?? null, input_tokens: result?.usage?.input_tokens ?? null });
      sc.page.forEach(([file, anchor, , label], i) => {
        const a = selection.answers.get(i);
        rows.push({ rep, scenario: sc.id, file, anchor, label, choice: a?.choice ?? null, confidence: a?.confidence ?? null, p_choice: a ? a.probabilities[a.choice] : null });
      });
    }
  }

  const judged = rows.filter((r) => r.choice !== null);
  const exact = judged.filter((r) => r.choice === r.label).length;
  const promoted = (r) => r.choice === 'relevant' && r.p_choice >= RELEVANT_FLOOR;
  const folded = (r) => r.choice === 'unrelated' && r.p_choice >= UNRELATED_FLOOR;
  const mean = (xs) => (xs.length ? Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(3)) : null);
  process.stdout.write(`model ${model}, ${args.repeats} repeat(s), ${requests.length} calls, ${rows.length} candidates (${judged.length} judged, ${rows.length - judged.length} unjudged)\n`);
  process.stdout.write(`three-way exact ${exact}/${judged.length} (${((100 * exact) / Math.max(1, judged.length)).toFixed(1)}%)\n`);
  const table = {};
  for (const r of rows) {
    const row = (table[r.label] ??= {});
    const k = r.choice ?? 'unjudged';
    row[k] = (row[k] ?? 0) + 1;
  }
  console.table(table);
  const rel = rows.filter((r) => r.label === 'relevant');
  const unr = rows.filter((r) => r.label === 'unrelated');
  process.stdout.write(`relevant labelled: ordered first at the floor ${rel.filter(promoted).length}/${rel.length}, folded ${rel.filter(folded).length} (this hides evidence)\n`);
  process.stdout.write(`unrelated labelled: folded at the floor ${unr.filter(folded).length}/${unr.length}, ordered first ${unr.filter(promoted).length}\n`);
  process.stdout.write(`mean confidence of the chosen label: correct ${mean(judged.filter((r) => r.choice === r.label).map((r) => r.confidence))}, wrong ${mean(judged.filter((r) => r.choice !== r.label).map((r) => r.confidence))}\n`);
  const ms = requests.map((r) => r.duration_ms).filter((x) => typeof x === 'number');
  process.stdout.write(`request latency p50 ${quantile(ms, 0.5)} ms, p90 ${quantile(ms, 0.9)} ms; input tokens ${requests.some((r) => r.input_tokens === null) ? `at least ${requests.reduce((s, r) => s + (r.input_tokens ?? 0), 0)} (${requests.filter((r) => r.input_tokens === null).length} request(s) without a usage reading)` : requests.reduce((s, r) => s + r.input_tokens, 0)}\n`);
  const reasons = {};
  for (const r of requests) for (const x of r.reasons.length ? r.reasons : ['none']) reasons[x] = (reasons[x] ?? 0) + 1;
  process.stdout.write(`selector reasons ${JSON.stringify(reasons)}\n`);

  if (args.out) writeFileSync(resolve(ROOT, args.out), JSON.stringify({ version: 1, generated_at: new Date().toISOString(), model, repeats: args.repeats, rows, requests }, null, 2) + '\n', 'utf8');
};

main().catch((err) => {
  process.stderr.write(`relevance-eval failed: ${err.message}\n`);
  process.exit(1);
});
