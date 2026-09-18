// A/B on Gate A's INPUT, not on its criterion. Same prompts, same question, same floor: one arm sends the request
// alone as the plugin does today, the other adds the preceding assistant turn as `prior_turn` in the state.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callJev } from '/Users/isaac/projects/jev-gate/dist/jev.js';
import { buildAdmissionRequest, decideAdmission, EXECUTION_QUESTION, AVAILABLE_EXECUTION } from '/Users/isaac/projects/jev-gate/dist/admission.js';
import { DEFAULT_CONFIG } from '/Users/isaac/projects/jev-gate/dist/config.js';

const apiKey = readFileSync(join(homedir(), '.config/jev-gate/typesafe.key'), 'utf8').trim();
const rows = JSON.parse(readFileSync('/tmp/prompts-ctx.json', 'utf8'));
const withPrior = (p) => ({
  model: DEFAULT_CONFIG.jevModel,
  state: { request: p.text, prior_turn: p.prior, available_execution: AVAILABLE_EXECUTION },
  questions: { execution: EXECUTION_QUESTION },
});

const out = [];
for (const p of rows) {
  const r = {};
  for (const [arm, req] of [['bare', buildAdmissionRequest(p.text, DEFAULT_CONFIG)], ['with_prior', withPrior(p)]]) {
    const res = await callJev(req, { apiKey, deadlineMs: 20000 });
    if (!res.ok) { r[arm] = { error: res.code }; continue; }
    const a = res.response.answers['execution'];
    const d = decideAdmission(res.response.answers, DEFAULT_CONFIG.admissionConfidenceFloor);
    r[arm] = { choice: a?.choice ?? null, confidence: a?.confidence ?? null, shape: d.shape, decided: d.decided, reason: d.reason,
               in: res.response.usage.input_tokens, ms: res.durationMs };
  }
  out.push({ project: p.project, len: p.text.length, prior_len: p.prior.length, ...r });
}
writeFileSync('/tmp/gatea-ctx.json', JSON.stringify(out, null, 2));
const ok = out.filter((x) => !x.bare.error && !x.with_prior.error);
const tally = (arm, f) => { const m = {}; for (const x of ok) { const k = String(f(x[arm])); m[k] = (m[k] ?? 0) + 1; } return m; };
for (const arm of ['bare', 'with_prior']) {
  const adm = ok.filter((x) => x[arm].shape === 'orchestrated' && x[arm].decided).length;
  const conf = ok.filter((x) => x[arm].choice === 'orchestrated').map((x) => x[arm].confidence).sort((a, b) => b - a);
  console.log(`\n${arm}:`);
  console.log(`  choices        :`, tally(arm, (v) => v.choice));
  console.log(`  admitted orch  : ${adm}/${ok.length}`);
  console.log(`  needs_context  : ${ok.filter((x) => x[arm].choice === 'needs_context').length}`);
  console.log(`  orch confidence: ${conf.slice(0, 6).map((c) => c?.toFixed(2)).join(', ') || '(none)'}`);
  console.log(`  mean input tok : ${Math.round(ok.reduce((s, x) => s + (x[arm].in ?? 0), 0) / ok.length)}, mean ${Math.round(ok.reduce((s, x) => s + (x[arm].ms ?? 0), 0) / ok.length)}ms`);
}
