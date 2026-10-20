/**
 * Live check of Compact's Jev dependency selection (mods/compact/hooks/selection.ts) on labelled conversations built
 * from this repository's own files: each scenario is one task and six old tool results (excerpts read from the working
 * tree at run time), labelled required / related / unrelated by one person against the selector's own rubric. Only
 * `required` changes what Compact keeps, so the headline number is what the selector would keep (its `priorities`)
 * against the `required` labels, over every planned candidate: a batch the selector refuses keeps nothing, and a
 * candidate with no answer counts as not kept. The model's own four-way answers (including those of a refused batch)
 * are printed next to it as a separate reading, with the confidence of the chosen label. No secrets or user data: the
 * excerpts are source files.
 *
 * Usage: TYPESAFE_API_KEY=... node bench/compact/selection-eval.ts [--model jev-1.13.0] [--repeats 3] [--out file.json]
 * `--model` asks another Jev version through the same code: the request model is rewritten on the way out and the reply
 * model on the way back, because the client refuses any model but its own.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DigestMessage, DigestResult } from '../../mods/compact/hooks/digest.ts';
import { createCompactSelector } from '../../mods/compact/hooks/selection.ts';
import { JEV_MODEL, type Transport } from '../../mods/router/hooks/client.ts';

type Label = 'required' | 'related' | 'unrelated';
interface Spec { file: string; anchor: string; lines: number; label: Label }
interface Scenario { id: string; task: string; candidates: Spec[] }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SCENARIOS: Scenario[] = [
  {
    id: 'status-code',
    task: 'Add a distinct http_503 code to callJev: a 503 from the provider must map to it instead of http_other, and it must be a valid HttpCode.',
    candidates: [
      { file: 'scripts/pack.mjs', anchor: 'const ROUTER_SHARED', lines: 2, label: 'unrelated' },
      { file: 'src/jev.ts', anchor: 'const statusToCode', lines: 14, label: 'required' },
      { file: 'mods/router/hooks/client.ts', anchor: 'const reasonForStatus', lines: 12, label: 'related' },
      { file: 'src/types.ts', anchor: 'export type HttpCode', lines: 16, label: 'required' },
      { file: 'src/dashboard-page.ts', anchor: 'const PRICES', lines: 2, label: 'unrelated' },
      { file: 'tests/jev.test.ts', anchor: 'maps status', lines: 6, label: 'related' },
    ],
  },
  {
    id: 'evidence-token-cap',
    task: 'Raise the Evidence selector per-request token cap from 25,000 to 30,000 estimated tokens.',
    candidates: [
      { file: 'src/config.ts', anchor: 'export const MIGRATION_SAMPLE', lines: 12, label: 'unrelated' },
      { file: 'src/evidence/types.ts', anchor: 'requestBytes: 128', lines: 3, label: 'required' },
      { file: 'src/jev.ts', anchor: 'export const MAX_REQUEST_BYTES', lines: 3, label: 'related' },
      { file: 'src/evidence/selector.ts', anchor: 'const overCap', lines: 4, label: 'required' },
      { file: 'src/allocation.ts', anchor: 'export const ROUTE_QUESTION', lines: 10, label: 'unrelated' },
      { file: 'mods/router/hooks/client.ts', anchor: 'export const MAX_REQUEST_TOKENS', lines: 1, label: 'related' },
    ],
  },
  {
    id: 'compact-trim-order',
    task: 'Make the Compact selector drop the oldest candidates instead of the newest when the candidate request is over the cap.',
    candidates: [
      { file: 'src/trace.ts', anchor: 'export const TRACE_RETENTION_MS', lines: 1, label: 'unrelated' },
      { file: 'mods/compact/hooks/selection.ts', anchor: '// Reserve the same exact serialized', lines: 7, label: 'required' },
      { file: 'src/dashboard-page.ts', anchor: 'const PRICES', lines: 2, label: 'unrelated' },
      { file: 'mods/compact/hooks/selection.ts', anchor: '// The digest drops the oldest results', lines: 2, label: 'related' },
      { file: 'mods/router/hooks/client.ts', anchor: 'export const MAX_REQUEST_BYTES', lines: 1, label: 'related' },
      { file: 'src/allocation.ts', anchor: 'export const ROUTE_QUESTION', lines: 6, label: 'unrelated' },
    ],
  },
  {
    id: 'trace-retention',
    task: 'Change the trace retention from 3 days to 5 days.',
    candidates: [
      { file: 'src/jev.ts', anchor: 'const statusToCode', lines: 10, label: 'unrelated' },
      { file: 'src/job.ts', anchor: 'export const RETENTION_MS', lines: 1, label: 'related' },
      { file: 'src/allocation.ts', anchor: 'export const ROUTE_QUESTION', lines: 6, label: 'unrelated' },
      { file: 'src/trace.ts', anchor: 'export const TRACE_RETENTION_MS', lines: 1, label: 'required' },
      { file: 'scripts/pack.mjs', anchor: 'const ROUTER_SHARED', lines: 2, label: 'unrelated' },
      { file: 'src/config.ts', anchor: 'export const MIGRATION_SAMPLE', lines: 12, label: 'unrelated' },
    ],
  },
  {
    id: 'sample-config',
    task: 'Change the sample config that doctor prints so mode is auto instead of off.',
    candidates: [
      { file: 'src/config.ts', anchor: 'export const MIGRATION_SAMPLE', lines: 12, label: 'required' },
      { file: 'src/trace.ts', anchor: 'export const TRACE_RETENTION_MS', lines: 1, label: 'unrelated' },
      { file: 'src/jev.ts', anchor: 'const statusToCode', lines: 10, label: 'unrelated' },
      { file: 'src/config.ts', anchor: "mode: 'off',", lines: 1, label: 'related' },
      { file: 'src/dashboard-page.ts', anchor: 'const PRICES', lines: 2, label: 'unrelated' },
      { file: 'scripts/pack.mjs', anchor: 'const ROUTER_SHARED', lines: 2, label: 'unrelated' },
    ],
  },
  {
    id: 'evidence-page-size',
    task: 'Raise the Evidence default page size from 8 to 12 candidates.',
    candidates: [
      { file: 'src/allocation.ts', anchor: 'export const ROUTE_QUESTION', lines: 6, label: 'unrelated' },
      { file: 'src/evidence/selector.ts', anchor: 'for (let i = 0; i < sendable.length', lines: 4, label: 'related' },
      { file: 'src/evidence/types.ts', anchor: 'windowLines: 40', lines: 8, label: 'required' },
      { file: 'src/job.ts', anchor: 'export const RETENTION_MS', lines: 1, label: 'unrelated' },
      { file: 'src/jev.ts', anchor: 'const statusToCode', lines: 10, label: 'unrelated' },
      { file: 'src/evidence/types.ts', anchor: 'export const RELEVANT_FLOOR', lines: 2, label: 'related' },
    ],
  },
  {
    id: 'price-entry',
    task: 'Add a price entry for a new model jev-1.15.0 at 0.05 dollars per million input tokens to the table the dashboard cost estimate reads.',
    candidates: [
      { file: 'src/dashboard-page.ts', anchor: 'const PRICES', lines: 1, label: 'related' },
      { file: 'src/trace.ts', anchor: 'export const TRACE_RETENTION_MS', lines: 1, label: 'unrelated' },
      { file: 'src/bench/usage.ts', anchor: 'export const JEV_PRICING', lines: 5, label: 'required' },
      { file: 'src/evidence/types.ts', anchor: 'windowLines: 40', lines: 8, label: 'unrelated' },
      { file: 'src/bench/usage.ts', anchor: 'export const estimateJevCostUsd', lines: 6, label: 'related' },
      { file: 'scripts/pack.mjs', anchor: 'const ROUTER_SHARED', lines: 2, label: 'unrelated' },
    ],
  },
  {
    id: 'no-dependency',
    task: 'Raise the Evidence result byte cap from 64 KiB to 128 KiB.',
    candidates: [
      { file: 'src/jev.ts', anchor: 'const statusToCode', lines: 10, label: 'unrelated' },
      { file: 'src/evidence/types.ts', anchor: 'requestBytes: 128', lines: 2, label: 'related' },
      { file: 'src/config.ts', anchor: 'export const MIGRATION_SAMPLE', lines: 12, label: 'unrelated' },
      { file: 'mods/router/hooks/client.ts', anchor: 'export const MAX_RESPONSE_BYTES', lines: 1, label: 'related' },
      { file: 'src/trace.ts', anchor: 'export const TRACE_RETENTION_MS', lines: 1, label: 'unrelated' },
      { file: 'src/allocation.ts', anchor: 'export const ROUTE_QUESTION', lines: 6, label: 'unrelated' },
    ],
  },
];

const excerpt = (s: Spec): string => {
  const lines = readFileSync(join(ROOT, s.file), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.includes(s.anchor));
  if (at < 0) throw new Error(`anchor not found in ${s.file}: ${s.anchor}`);
  return lines.slice(at, at + s.lines).join('\n');
};

const conversation = (sc: Scenario): DigestMessage[] => {
  const messages: DigestMessage[] = [{ role: 'user', text: sc.task, toolUses: [] }];
  sc.candidates.forEach((c, i) => {
    const text = excerpt(c);
    messages.push({ role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: `call${i}`, tool: 'Read', input: { file_path: c.file }, text, outcome: 'success' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `call${i}`, text }] });
  });
  messages.push({ role: 'assistant', text: 'Continue the requested work.', toolUses: [] });
  return messages;
};

const quantile = (xs: number[], q: number): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) * q)] ?? null : null;
};

const args = process.argv.slice(2);
const flag = (name: string, fallback: string | null): string | null => (args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback);
const model = flag('--model', null) ?? JEV_MODEL;
const repeats = Number(flag('--repeats', '3'));
const out = flag('--out', null);
const key = process.env['TYPESAFE_API_KEY'];
if (!key) {
  process.stderr.write('selection-eval: TYPESAFE_API_KEY is not set.\n');
  process.exit(2);
}
if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a positive integer');

interface Row { rep: number; scenario: string; id: string; label: Label; kept: boolean; choice: string | null; confidence: number | null; request_ms: number; offered: number; sent: number; reason: string }
const rows: Row[] = [];
const requests: Array<{ rep: number; scenario: string; reason: string; ms: number; input_tokens: number | null; raw?: unknown }> = [];

for (let rep = 1; rep <= repeats; rep++) {
  for (const sc of SCENARIOS) {
    const messages = conversation(sc);
    let reply: { answers: Record<string, { choice?: string; confidence?: number }> | null; ms: number; inputTokens: number | null } = { answers: null, ms: 0, inputTokens: null };
    const transport: Transport = {
      fetch: async (url, init) => {
        const started = Date.now();
        const res = await fetch(url, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), model }) });
        const text = await res.text();
        let rewritten = text;
        try {
          const body = JSON.parse(text);
          reply = { answers: body.answers ?? null, ms: Date.now() - started, inputTokens: typeof body.usage?.input_tokens === 'number' ? body.usage.input_tokens : null };
          if (body.model === model) rewritten = JSON.stringify({ ...body, model: JEV_MODEL });
        } catch { /* a non-JSON body goes to the client as it came */ }
        return { status: res.status, text: rewritten };
      },
      sleep: (ms, signal) => new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      }),
    };
    // Everything before the last message is "old": the digest is empty so every successful result competes.
    const baseline: DigestResult = { digest: '', start: messages.length - 1, digestChars: 0, tailChars: 0, tailMessages: 1, headMessages: messages.length - 1 };
    const selection = await createCompactSelector(10_000)(messages, baseline, key, transport);
    // The raw answers of a reply the selector refused are kept, so a refusal can be read rather than guessed at.
    requests.push({ rep, scenario: sc.id, reason: selection.reason, ms: reply.ms, input_tokens: reply.inputTokens, ...(selection.reason === 'invalid_answers' ? { raw: reply.answers } : {}) });
    sc.candidates.forEach((c, i) => {
      const id = `m${1 + 2 * i}t0`;
      const a = reply.answers?.[id];
      const kept = selection.priorities.some((p) => p.message === 1 + 2 * i && p.tool === 0);
      rows.push({ rep, scenario: sc.id, id, label: c.label, kept, choice: typeof a?.choice === 'string' ? a.choice : null, confidence: typeof a?.confidence === 'number' ? a.confidence : null, request_ms: reply.ms, offered: selection.candidates, sent: selection.sent ? 1 : 0, reason: selection.reason });
    });
  }
}

const answered = rows.filter((r) => r.choice !== null);
const policy = { tp: 0, fp: 0, fn: 0, tn: 0 };
for (const r of rows) {
  if (r.kept && r.label === 'required') policy.tp++;
  else if (r.kept) policy.fp++;
  else if (r.label === 'required') policy.fn++;
  else policy.tn++;
}
const refused = requests.filter((r) => r.reason === 'invalid_answers').length;
const exact = answered.filter((r) => r.choice === r.label).length;
const rawBinary = answered.filter((r) => (r.choice === 'required') === (r.label === 'required')).length;
const confOf = (rs: Row[]): number | null => (rs.length ? Number((rs.reduce((s, r) => s + (r.confidence ?? 0), 0) / rs.length).toFixed(3)) : null);
const ms = requests.map((r) => r.ms).filter((x) => x > 0);
const knownTokens = requests.reduce((s, r) => s + (r.input_tokens ?? 0), 0);
const unknownTokens = requests.filter((r) => r.input_tokens === null).length;

process.stdout.write(`model ${model}, ${repeats} repeat(s), ${requests.length} requests (${refused} refused by the selector as invalid_answers), ${rows.length} planned candidates (${answered.length} with an answer in the reply)\n`);
process.stdout.write(`policy (kept against required, all planned candidates) ${policy.tp + policy.tn}/${rows.length} (${((100 * (policy.tp + policy.tn)) / Math.max(1, rows.length)).toFixed(1)}%): tp ${policy.tp}, fp ${policy.fp}, fn ${policy.fn}, tn ${policy.tn}\n`);
process.stdout.write(`raw answers, required-vs-not ${rawBinary}/${answered.length} (${((100 * rawBinary) / Math.max(1, answered.length)).toFixed(1)}%), including answers of a refused batch\n`);
process.stdout.write(`raw answers, four-way exact ${exact}/${answered.length} (${((100 * exact) / Math.max(1, answered.length)).toFixed(1)}%)\n`);
const table: Record<string, Record<string, number>> = {};
for (const r of answered) {
  const row = (table[r.label] ??= {});
  row[r.choice as string] = (row[r.choice as string] ?? 0) + 1;
}
console.table(table);
process.stdout.write(`mean confidence of the chosen label: correct ${confOf(answered.filter((r) => r.choice === r.label))}, wrong ${confOf(answered.filter((r) => r.choice !== r.label))}\n`);
process.stdout.write(`request latency p50 ${quantile(ms, 0.5)} ms, p90 ${quantile(ms, 0.9)} ms; input tokens ${unknownTokens ? `at least ${knownTokens} (${unknownTokens} request(s) without a usage reading)` : knownTokens}\n`);
const reasons: Record<string, number> = {};
for (const r of requests) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
process.stdout.write(`selector reasons ${JSON.stringify(reasons)}\n`);

if (out) writeFileSync(out, JSON.stringify({ version: 1, generated_at: new Date().toISOString(), model, repeats, rows, requests }, null, 2) + '\n', 'utf8');
