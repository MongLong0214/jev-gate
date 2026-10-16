// How often the Evidence 25k-estimated-token / 128 KiB request cap trims a page, on this repository: 80 goals built from
// its own exported identifiers and 10 sentences, run through the real service with a fake Jev that records each request.
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const { build } = createRequire(import.meta.url)('esbuild');

const R = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const bundle = join(mkdtempSync(join(tmpdir(), 'ev-cap-')), 'b.mjs');
await build({ stdin: { contents: "export { createEvidenceService } from './src/evidence/service.ts'; export { loadConfig } from './src/evidence/source.ts'; export { EVIDENCE_MODEL, LIMITS } from './src/evidence/types.ts'; export { estimateTokens } from './src/outbound-text.ts';", resolveDir: R, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning' });
const { createEvidenceService, loadConfig, EVIDENCE_MODEL, LIMITS, estimateTokens } = await import(pathToFileURL(bundle).href);
const cfgPath = join(mkdtempSync(join(tmpdir(), 'ev-cfg-')), 'evidence.json');
writeFileSync(cfgPath, JSON.stringify({ projectRoot: R, allowedRoots: ['.'], remote: true }));
const loaded = await loadConfig({ JEV_EVIDENCE_CONFIG: cfgPath });
if (!loaded.ok) throw new Error(loaded.detail);

const names = [...new Set(execSync(`grep -rhoE "export (const|function|interface|type) [A-Za-z0-9_]+" ${R}/src ${R}/mods --include=*.ts | awk '{print $3}'`, { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter((n) => n.length > 5))];
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pickN = (n) => Array.from({ length: n }, () => names[Math.floor(rnd() * names.length)]);
const goals = [...pickN(80).map((n) => `where is ${n} used and what does it decide`), 'how does the Router decide a model', 'where are request size limits enforced', 'how does Compact choose which tool results to keep', 'what happens when Jev returns an invalid answer', 'where is the trace retention enforced', 'how are API keys kept out of requests', 'where does Gate A read the prompt', 'how is the dashboard price computed', 'which code maps HTTP status to an error code', 'how does the Codex launcher forward requests'];

const requests = [];
const fetchImpl = async (_url, init) => {
  const body = JSON.parse(String(init.body));
  const text = String(init.body);
  requests.push({ bytes: Buffer.byteLength(text), est: estimateTokens(text), candidates: body.state.candidates.length });
  const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'choice', choice: 'relevant', confidence: 0.9, probabilities: { relevant: 0.9, unrelated: 0.05, needs_context: 0.05 } }]));
  return new Response(JSON.stringify({ model: EVIDENCE_MODEL, answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
};
const svc = createEvidenceService(loaded.config, { apiKey: 'k', fetchImpl });
let calls = 0, budget = 0, asked = 0, unjudged = 0, pageCandidates = 0, noCandidates = 0;
const codes = {};
for (const goal of goals) {
  const reply = (await svc.run({ goal, limit: LIMITS.maxPage }, new AbortController().signal)).result;
  calls++;
  for (const c of reply.reasonCodes ?? []) codes[c] = (codes[c] ?? 0) + 1;
  if ((reply.reasonCodes ?? []).includes('remote_budget')) budget++;
  if (reply.items?.length) { asked++; pageCandidates += reply.coverage?.pageCandidates ?? 0; unjudged += reply.coverage?.unjudgedOnPage ?? 0; } else noCandidates++;
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
console.log(JSON.stringify({ goals: calls, pagesWithCandidates: asked, noCandidate: noCandidates, jevRequests: requests.length, callsTrimmedByRequestCap: budget, pageCandidates, unjudgedOnPage: unjudged, reasonCodes: codes,
  requestBytes: { p50: q(requests.map((r) => r.bytes), .5), p90: q(requests.map((r) => r.bytes), .9), max: Math.max(...requests.map((r) => r.bytes)) },
  estTokens: { p50: q(requests.map((r) => r.est), .5), p90: q(requests.map((r) => r.est), .9), max: Math.max(...requests.map((r) => r.est)), cap: LIMITS.requestTokens } }, null, 1));
