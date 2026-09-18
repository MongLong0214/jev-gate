// Controlled: the same request sent twice measures Jev's own variance; full vs lean is only meaningful against it.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callJev } from '/Users/isaac/projects/jev-gate/dist/jev.js';
import { parseGrepResponse } from '/Users/isaac/projects/jev-gate/dist/context/blocks.js';
import { SHARED_INSTRUCTIONS, BLOCK_CRITERIA, SCOPE_QUESTION, blockQuestionKey, OMIT_CONFIDENCE_FLOOR } from '/Users/isaac/projects/jev-gate/dist/context/select.js';
import { DEFAULT_CONFIG } from '/Users/isaac/projects/jev-gate/dist/config.js';

const apiKey = readFileSync(join(homedir(), '.config/jev-gate/typesafe.key'), 'utf8').trim();
const CASES = [
  { repo: 'logic-pro-mcp', pattern: 'hook', ask: 'how are hooks registered and dispatched?' },
  { repo: 'agent-operator-score', pattern: 'classified', ask: 'what determines how a session gets classified?' },
];
const head = (i, p) => [`Question:`, `Does \`blocks[${i}]\` (sourcePath \`${p}\`), including its surrounding information in this state, need to`, 'remain visible for this task? Classify only this named block.'];
const full = (i, p) => ({ type: 'choice', instructions: [SHARED_INSTRUCTIONS, '', ...head(i, p)].join('\n'), criteria: BLOCK_CRITERIA });
const lean = (i, p) => ({ type: 'choice', instructions: head(i, p).join('\n'), criteria: BLOCK_CRITERIA });

const run = async (ctx, mk) => {
  const questions = { scope: SCOPE_QUESTION };
  ctx.blocks.forEach((b, i) => { if (!b.protected) questions[blockQuestionKey(i)] = mk(i, b.sourcePath); });
  const t0 = performance.now();
  const res = await callJev({ model: DEFAULT_CONFIG.jevModel, state: ctx, questions }, { apiKey, deadlineMs: 25000 });
  if (!res.ok) return { error: res.code, requestBytes: res.requestBytes };
  const a = res.response.answers;
  return {
    wall_ms: Math.round(performance.now() - t0), requestBytes: res.requestBytes, jev_in: res.response.usage.input_tokens,
    scope_conf: a['scope']?.confidence, scope: a['scope']?.choice,
    choices: ctx.blocks.map((_b, i) => a[blockQuestionKey(i)]?.choice ?? null),
    confs: ctx.blocks.map((_b, i) => a[blockQuestionKey(i)]?.confidence ?? null),
    omitAtFloor: ctx.blocks.filter((_b, i) => { const x = a[blockQuestionKey(i)]; return x && x.choice === 'omit' && x.confidence >= OMIT_CONFIDENCE_FLOOR; }).length,
  };
};
const agree = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) s += 1; return `${s}/${a.length} (${(100 * s / a.length).toFixed(0)}%)`; };

const out = [];
for (const c of CASES) {
  const raw = execFileSync('rg', ['-n', '--no-heading', '--color=never', '--', c.pattern, '.'], { cwd: `/Users/isaac/projects/${c.repo}`, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  const content = raw.replace(/\n$/, '').split('\n').slice(0, 250).join('\n');
  const ti = { pattern: c.pattern, output_mode: 'content', '-n': true };
  const parsed = parseGrepResponse(ti, { mode: 'content', numFiles: 0, filenames: [], content, numLines: content.split('\n').length, totalLines: content.split('\n').length });
  if (!parsed.ok) continue;
  const ctx = { requests: [c.ask], searchInput: ti, blocks: parsed.blocks };
  const f1 = await run(ctx, full), f2 = await run(ctx, full), l1 = await run(ctx, lean), l2 = await run(ctx, lean);
  const tag = `${c.repo}/${c.pattern}`;
  console.log(`\n== ${tag}  blocks=${parsed.blocks.length} ==`);
  for (const [n, r] of [['full#1', f1], ['full#2', f2], ['lean#1', l1], ['lean#2', l2]]) {
    if (r.error) { console.log(`  ${n}: ERROR ${r.error} req=${(r.requestBytes/1024).toFixed(1)}KiB`); continue; }
    console.log(`  ${n}: req=${(r.requestBytes/1024).toFixed(1)}KiB jev_in=${r.jev_in} ${r.wall_ms}ms scope=${r.scope}/${r.scope_conf} omit>=.9=${r.omitAtFloor}`);
  }
  if (!f1.error && !f2.error) console.log(`  NOISE   full#1 vs full#2: ${agree(f1.choices, f2.choices)}`);
  if (!l1.error && !l2.error) console.log(`  NOISE   lean#1 vs lean#2: ${agree(l1.choices, l2.choices)}`);
  if (!f1.error && !l1.error) console.log(`  VARIANT full#1 vs lean#1: ${agree(f1.choices, l1.choices)}`);
  out.push({ tag, blocks: parsed.blocks.length, f1, f2, l1, l2 });
}
writeFileSync('/tmp/ab2.json', JSON.stringify(out, null, 2));
