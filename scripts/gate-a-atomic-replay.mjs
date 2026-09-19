// Offline replay of the SHIPPED atomic Gate A against real prompts with the context depth each was typed at.
// Nothing here re-implements the decision: it imports decideAdmissionAtomic and buildAtomicAdmissionRequest from
// dist/, so the number this prints is the number the hook would have produced. No repository mutation, no retries,
// and no threshold is tuned after a result is seen.
//
// Usage: node scripts/gate-a-atomic-replay.mjs --prompts <json> [--floor 300000] [--out <json>]
// The prompts file is [{ text, context_tokens, project }], as produced by
// bench/results/v5-context-locality-2026-09-19/prompts-depth.mjs. It contains real prompt text, so it is never
// committed and never published: this script writes decisions, lengths and depths only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const { callJev } = await import(join(ROOT, 'dist/jev.js'));
const { buildAtomicAdmissionRequest, decideAdmissionAtomic } = await import(join(ROOT, 'dist/admission.js'));
const { DEFAULT_CONFIG } = await import(join(ROOT, 'dist/config.js'));

const args = { prompts: null, floor: DEFAULT_CONFIG.delegationDepthFloor, out: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--prompts') args.prompts = process.argv[++i];
  else if (a === '--floor') args.floor = Number(process.argv[++i]);
  else if (a === '--out') args.out = process.argv[++i];
  else throw new Error(`unknown argument ${a}`);
}
if (!args.prompts) throw new Error('usage: node scripts/gate-a-atomic-replay.mjs --prompts <json> [--floor N] [--out <json>]');
if (!Number.isInteger(args.floor) || args.floor < 0) throw new Error('--floor must be a non-negative integer');

const apiKey = readFileSync(join(homedir(), '.config/jev-gate/typesafe.key'), 'utf8').trim();
const rows = JSON.parse(readFileSync(resolve(args.prompts), 'utf8'));
const config = { ...DEFAULT_CONFIG, delegationDepthFloor: args.floor };

const out = [];
for (const row of rows) {
  const t0 = performance.now();
  const r = await callJev(buildAtomicAdmissionRequest(row.text, config), { apiKey, deadlineMs: 25_000 });
  const ms = Math.round(performance.now() - t0);
  if (!r.ok) {
    out.push({ project: row.project ?? null, len: row.text.length, context_tokens: row.context_tokens, shape: null, reason: `call_${r.code}`, ms });
    continue;
  }
  const a = r.response.answers;
  const d = decideAdmissionAtomic(a, row.context_tokens ?? null, args.floor);
  out.push({
    project: row.project ?? null,
    len: row.text.length,
    context_tokens: row.context_tokens,
    shape: d.shape,
    reason: d.reason,
    ms,
    // The facts themselves are numbers, never prompt text, so they are safe to publish alongside the decision.
    facts: {
      forbids_delegation: a.forbids_delegation?.noul ?? null,
      answer_only: a.answer_only?.noul ?? null,
      missing_reference: a.missing_reference?.noul ?? null,
      size: a.size?.score ?? null,
      size_confidence: a.size?.confidence ?? null,
    },
    tokens: r.response.usage?.input_tokens ?? null,
  });
}

const admitted = out.filter((x) => x.shape === 'orchestrated');
const by = {};
for (const x of out) by[x.reason ?? 'admitted'] = (by[x.reason ?? 'admitted'] ?? 0) + 1;
const summary = {
  floor: args.floor,
  prompts: out.length,
  admitted: admitted.length,
  by_reason: by,
  median_ms: out.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(out.length / 2)] ?? null,
  rows: out,
};
if (args.out) {
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(resolve(args.out), JSON.stringify(summary, null, 2));
}
console.log(`floor ${args.floor.toLocaleString()}  admitted ${admitted.length}/${out.length}`);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(30)}${v}`);
