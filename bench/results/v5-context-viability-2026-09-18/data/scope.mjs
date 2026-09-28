// Does the scope question respond to intent at all? Same search content, user requests at opposite extremes.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callJev } from '/Users/isaac/projects/jev-gate/dist/jev.js';
import { parseGrepResponse, contentBytesOf } from '/Users/isaac/projects/jev-gate/dist/context/blocks.js';
import { SHARED_INSTRUCTIONS, BLOCK_CRITERIA, SCOPE_QUESTION, blockQuestionKey, OMIT_CONFIDENCE_FLOOR } from '/Users/isaac/projects/jev-gate/dist/context/select.js';
const leanRequest = (ctx) => { const questions = { scope: SCOPE_QUESTION }; ctx.blocks.forEach((b, i) => { if (!b.protected) questions[blockQuestionKey(i)] = { type: 'choice', instructions: ['Question:', `Does \`blocks[${i}]\` (sourcePath \`${b.sourcePath}\`), including its surrounding information in this state, need to`, 'remain visible for this task? Classify only this named block.'].join('\n'), criteria: BLOCK_CRITERIA }; }); return { model: DEFAULT_CONFIG.jevModel, state: ctx, questions }; };
import { DEFAULT_CONFIG } from '/Users/isaac/projects/jev-gate/dist/config.js';

const apiKey = readFileSync(join(homedir(), '.config/jev-gate/typesafe.key'), 'utf8').trim();
const ASKS = [
  ['exhaustive', 'I need the complete list of every place that sets a timeout — I am auditing all of them and cannot miss one.'],
  ['selective ', 'I am debugging one specific hang in the Jev HTTP client. Which of these is the deadline that applies there?'],
  ['neutral   ', 'why does the Jev request time out at three seconds, and where is that deadline set?'],
];
const raw = execFileSync('rg', ['-n', '--no-heading', '--color=never', '--', 'timeout', '.'], { cwd: '/Users/isaac/projects/jev-gate', encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const content = raw.replace(/\n$/, '').split('\n').slice(0, 250).join('\n');
const ti = { pattern: 'timeout', output_mode: 'content', '-n': true };
const parsed = parseGrepResponse(ti, { mode: 'content', numFiles: 0, filenames: [], content, numLines: content.split('\n').length, totalLines: content.split('\n').length });
if (!parsed.ok) { console.log('parse failed', parsed.reason); process.exit(1); }
const before = contentBytesOf(parsed.blocks);
console.log(`blocks=${parsed.blocks.length} content=${before}B\n`);
const rows = [];
for (const [label, ask] of ASKS) {
  for (const attempt of [1, 2]) {
    const req = leanRequest({ requests: [ask], searchInput: ti, blocks: parsed.blocks });
    const res = await callJev(req, { apiKey, deadlineMs: 25000 });
    if (!res.ok) { console.log(`${label} #${attempt}: ERROR ${res.code} req=${(res.requestBytes/1024).toFixed(1)}KiB`); rows.push({ label, attempt, error: res.code }); continue; }
    const a = res.response.answers;
    const s = a['scope'];
    const omitIdx = parsed.blocks.map((_b, i) => i).filter((i) => { const x = a[blockQuestionKey(i)]; return x && x.choice === 'omit' && x.confidence >= OMIT_CONFIDENCE_FLOOR; });
    const kept = parsed.blocks.filter((_b, i) => !omitIdx.includes(i));
    const after = contentBytesOf(kept);
    console.log(`${label} #${attempt}: scope=${s?.choice}/${s?.confidence}  probs=${JSON.stringify(s?.probabilities)}  omit>=.9=${omitIdx.length}/${parsed.blocks.length}  would_save=${before - after}B (${(100*(before-after)/before).toFixed(0)}%)`);
    rows.push({ label: label.trim(), attempt, scope: s?.choice, conf: s?.confidence, probs: s?.probabilities, omits: omitIdx.length, blocks: parsed.blocks.length, before, after, saved: before - after });
  }
}
writeFileSync('/tmp/scope.json', JSON.stringify(rows, null, 2));
