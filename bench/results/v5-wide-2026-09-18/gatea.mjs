// Replay real prompts through Gate A exactly as the hook builds it, and record what it would have decided.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callJev } from '/Users/isaac/projects/jev-gate/dist/jev.js';
import { buildAdmissionRequest, decideAdmission } from '/Users/isaac/projects/jev-gate/dist/admission.js';
import { DEFAULT_CONFIG } from '/Users/isaac/projects/jev-gate/dist/config.js';

const apiKey = readFileSync(join(homedir(), '.config/jev-gate/typesafe.key'), 'utf8').trim();
const prompts = JSON.parse(readFileSync('/tmp/prompts-typed.json', 'utf8'));
const out = [];
let inTok = 0, outTok = 0, ms = 0;
for (const [i, p] of prompts.entries()) {
  const res = await callJev(buildAdmissionRequest(p.text, DEFAULT_CONFIG), { apiKey, deadlineMs: 20000 });
  if (!res.ok) { out.push({ ...p, error: res.code }); continue; }
  inTok += res.response.usage.input_tokens ?? 0;
  outTok += res.response.usage.output_tokens ?? 0;
  ms += res.durationMs;
  const a = res.response.answers['execution'];
  const d = decideAdmission(res.response.answers, DEFAULT_CONFIG.admissionConfidenceFloor);
  out.push({ project: p.project, len: p.text.length, head: p.text.slice(0, 70),
             choice: a?.choice ?? null, confidence: a?.confidence ?? null,
             shape: d.shape, decided: d.decided, reason: d.reason });
  if ((i + 1) % 50 === 0) process.stderr.write(`  ${i + 1}/${prompts.length}\n`);
}
writeFileSync('/tmp/gatea-typed.json', JSON.stringify(out, null, 2));
const ok = out.filter((x) => !x.error);
const tally = (f) => { const m = {}; for (const x of ok) { const k = String(f(x)); m[k] = (m[k] ?? 0) + 1; } return m; };
console.log(`replayed ${ok.length} real prompts (${out.length - ok.length} errors)`);
console.log(`Jev raw choice        :`, tally((x) => x.choice));
console.log(`after the 0.8 floor   :`, tally((x) => (x.decided ? x.shape : `fallback:${x.reason}`)));
const orch = ok.filter((x) => x.shape === 'orchestrated');
console.log(`\nwould have orchestrated: ${orch.length}/${ok.length} = ${(100 * orch.length / ok.length).toFixed(1)}%`);
for (const x of orch.slice(0, 6)) console.log(`  ${x.confidence}  ${JSON.stringify(x.head)}`);
const conf = ok.filter((x) => x.choice === 'orchestrated').map((x) => x.confidence).sort((a, b) => b - a);
console.log(`\nJev said orchestrated ${conf.length} times; confidences: ${conf.slice(0, 10).join(', ')}`);
console.log(`Jev tokens: ${inTok} in / ${outTok} out, total ${(ms / 1000).toFixed(1)}s, mean ${Math.round(ms / ok.length)}ms per gate`);
