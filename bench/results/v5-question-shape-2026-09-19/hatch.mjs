// Two claims from the field write-up, against the shipped question and the same 61 real prompts:
//   (a) option order changes answers;
//   (b) "can you answer?" options are unreliable and the decision belongs in code, on confidence.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callJev, validateChoice, topChoices } from '/Users/isaac/projects/jev-gate/dist/jev.js';
import { EXECUTION_QUESTION, AVAILABLE_EXECUTION } from '/Users/isaac/projects/jev-gate/dist/admission.js';
import { DEFAULT_CONFIG } from '/Users/isaac/projects/jev-gate/dist/config.js';

const apiKey = readFileSync(join(homedir(), '.config/jev-gate/typesafe.key'), 'utf8').trim();
const rows = JSON.parse(readFileSync('/tmp/prompts-depth.json', 'utf8'));
const C = EXECUTION_QUESTION.criteria;
const pick = (keys) => Object.fromEntries(keys.map((k) => [k, C[k]]));

const ARMS = {
  shipped:  { type: 'choice', instructions: EXECUTION_QUESTION.instructions, criteria: pick(['direct', 'orchestrated', 'needs_context', 'abstain']) },
  reversed: { type: 'choice', instructions: EXECUTION_QUESTION.instructions, criteria: pick(['abstain', 'needs_context', 'orchestrated', 'direct']) },
  swapped:  { type: 'choice', instructions: EXECUTION_QUESTION.instructions, criteria: pick(['orchestrated', 'direct', 'abstain', 'needs_context']) },
  // Every option is something code can act on. No "I cannot tell" -- that is what the confidence is for.
  no_hatch: { type: 'choice', instructions: EXECUTION_QUESTION.instructions, criteria: pick(['direct', 'orchestrated']) },
};
const KEYS = { shipped: ['direct','orchestrated','needs_context','abstain'], reversed: ['direct','orchestrated','needs_context','abstain'],
               swapped: ['direct','orchestrated','needs_context','abstain'], no_hatch: ['direct','orchestrated'] };

const out = [];
for (const p of rows) {
  const r = { len: p.text.length, context_tokens: p.context_tokens };
  for (const [name, q] of Object.entries(ARMS)) {
    const res = await callJev({ model: DEFAULT_CONFIG.jevModel, state: { request: p.text, available_execution: AVAILABLE_EXECUTION }, questions: { execution: q } }, { apiKey, deadlineMs: 20000 });
    if (!res.ok) { r[name] = { error: res.code }; continue; }
    const a = validateChoice(res.response.answers['execution'], KEYS[name]);
    r[name] = { choice: a?.choice ?? null, confidence: a?.confidence ?? null, unique: a ? topChoices(a).length === 1 : false };
  }
  out.push(r);
}
writeFileSync('/tmp/hatch.json', JSON.stringify(out, null, 2));
const ok = out.filter((x) => Object.keys(ARMS).every((a) => !x[a]?.error));
const tally = (arm) => { const t = {}; for (const x of ok) { const k = String(x[arm].choice); t[k] = (t[k] ?? 0) + 1; } return t; };
for (const a of Object.keys(ARMS)) {
  const adm = ok.filter((x) => x[a].choice === 'orchestrated' && x[a].unique && (x[a].confidence ?? 0) >= 0.8).length;
  console.log(`${a.padEnd(10)}`, tally(a), ` admitted@0.8=${adm}/${ok.length}`);
}
console.log();
for (const a of ['reversed', 'swapped']) {
  const diff = ok.filter((x) => x[a].choice !== x.shipped.choice).length;
  console.log(`order effect  shipped vs ${a.padEnd(9)}: ${diff}/${ok.length} answers changed (${(100*diff/ok.length).toFixed(0)}%)`);
}
const nc = ok.filter((x) => x.shipped.choice === 'needs_context' || x.shipped.choice === 'abstain');
const moved = {}; for (const x of nc) { const k = String(x.no_hatch.choice); moved[k] = (moved[k] ?? 0) + 1; }
console.log(`\nthe ${nc.length} that took an escape hatch, once it is removed:`, moved);
const ncConf = nc.map((x) => x.no_hatch.confidence).filter((c) => c !== null).sort((a,b)=>b-a);
console.log(`  their confidence without the hatch: max ${ncConf[0]?.toFixed(2)} median ${ncConf[Math.floor(ncConf.length/2)]?.toFixed(2)}`);
