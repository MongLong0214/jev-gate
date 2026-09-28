// Three inputs to the same question. A is what ships. B adds the number. C adds the number and the one property of
// the options that makes the number mean something -- a worker starts in its own session and does not inherit this one.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callJev } from '/Users/isaac/projects/jev-gate/dist/jev.js';
import { buildAdmissionRequest, decideAdmission, EXECUTION_QUESTION, AVAILABLE_EXECUTION } from '/Users/isaac/projects/jev-gate/dist/admission.js';
import { DEFAULT_CONFIG } from '/Users/isaac/projects/jev-gate/dist/config.js';

const apiKey = readFileSync(join(homedir(), '.config/jev-gate/typesafe.key'), 'utf8').trim();
const rows = JSON.parse(readFileSync('/tmp/prompts-depth.json', 'utf8'));

const EXECUTION_WITH_COST = {
  direct: 'One native standard-tier conversation. It continues in this session, so every later turn re-reads the context below plus whatever this work adds to it.',
  orchestrated: 'Strong read-only planning, then outcome workers dispatched by a coordinator. Each worker runs in its own session starting from an empty context and returns a short result, so the work does not accumulate in this one.',
};

const ARMS = {
  A_bare: (p) => buildAdmissionRequest(p.text, DEFAULT_CONFIG),
  B_number: (p) => ({ model: DEFAULT_CONFIG.jevModel, state: { request: p.text, context_tokens: p.context_tokens, available_execution: AVAILABLE_EXECUTION }, questions: { execution: EXECUTION_QUESTION } }),
  C_number_and_cost: (p) => ({ model: DEFAULT_CONFIG.jevModel, state: { request: p.text, context_tokens: p.context_tokens, available_execution: EXECUTION_WITH_COST }, questions: { execution: EXECUTION_QUESTION } }),
};

const out = [];
for (const p of rows) {
  const r = { project: p.project, len: p.text.length, context_tokens: p.context_tokens };
  for (const [name, build] of Object.entries(ARMS)) {
    const res = await callJev(build(p), { apiKey, deadlineMs: 20000 });
    if (!res.ok) { r[name] = { error: res.code }; continue; }
    const a = res.response.answers['execution'];
    const d = decideAdmission(res.response.answers, DEFAULT_CONFIG.admissionConfidenceFloor);
    r[name] = { choice: a?.choice ?? null, confidence: a?.confidence ?? null, shape: d.shape, decided: d.decided, in: res.response.usage.input_tokens, ms: res.durationMs };
  }
  out.push(r);
}
writeFileSync('/tmp/gatea-depth.json', JSON.stringify(out, null, 2));
const ok = out.filter((x) => Object.keys(ARMS).every((a) => !x[a]?.error));
for (const arm of Object.keys(ARMS)) {
  const t = {}; for (const x of ok) { const k = String(x[arm].choice); t[k] = (t[k] ?? 0) + 1; }
  const adm = ok.filter((x) => x[arm].decided && x[arm].shape === 'orchestrated').length;
  const conf = ok.filter((x) => x[arm].choice === 'orchestrated').map((x) => x[arm].confidence).sort((a, b) => b - a);
  console.log(`\n${arm}`);
  console.log(`  choices          :`, t);
  console.log(`  ADMITTED orch    : ${adm}/${ok.length}  (${(100 * adm / ok.length).toFixed(1)}%)`);
  console.log(`  orch confidences : ${conf.slice(0, 8).map((c) => c?.toFixed(2)).join(', ') || '(none)'}`);
  console.log(`  mean input tok   : ${Math.round(ok.reduce((s, x) => s + (x[arm].in ?? 0), 0) / ok.length)}, ${Math.round(ok.reduce((s, x) => s + (x[arm].ms ?? 0), 0) / ok.length)}ms`);
}
