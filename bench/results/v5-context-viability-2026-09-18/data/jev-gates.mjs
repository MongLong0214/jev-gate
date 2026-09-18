// Runs real eligible Grep results through the shipped path: parseGrepResponse -> buildSelectionRequest -> callJev
// -> decideSelection. Measures which gate stops a selection and what the saving would have been if it had not.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callJev } from '/Users/isaac/projects/jev-gate/dist/jev.js';
import { parseGrepResponse, contentBytesOf } from '/Users/isaac/projects/jev-gate/dist/context/blocks.js';
import { buildSelectionRequest, decideSelection, OMIT_CONFIDENCE_FLOOR } from '/Users/isaac/projects/jev-gate/dist/context/select.js';
import { DEFAULT_CONFIG } from '/Users/isaac/projects/jev-gate/dist/config.js';

const apiKey = readFileSync(join(homedir(), '.config/jev-gate/typesafe.key'), 'utf8').trim();
const REPO_ROOT = '/Users/isaac/projects';

// One plausible question per sample — what somebody searching that identifier would actually be after.
const ASK = {
  sha256: 'where is the record digest computed, and could two different records collide?',
  blocks: 'how does the search filter decide which blocks to keep?',
  marker: 'what do the probe markers mean and where are they generated?',
  literal: 'where do we handle literal string matching?',
  locate: 'how does locate resolve a path when the repository is a worktree?',
  repoWith: 'how do the tests build a repository fixture?',
  sighting: 'how is a sighting recorded and what fields does it carry?',
  projected: 'how is the projected score computed from the raw signals?',
  classified: 'what determines how a session gets classified?',
  population: 'where does the population baseline come from?',
};

const rows = JSON.parse(readFileSync('/tmp/window.json', 'utf8')).filter((r) => r.verdict === 'ELIGIBLE');
const out = [];
for (const r of rows) {
  const cwd = join(REPO_ROOT, r.repo);
  const raw = execFileSync('rg', ['-n', '--no-heading', '--color=never', '--', r.pattern, '.'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const content = raw.replace(/\n$/, '').split('\n').slice(0, 250).join('\n');
  const toolInput = { pattern: r.pattern, output_mode: 'content', '-n': true };
  const toolResponse = { mode: 'content', numFiles: 0, filenames: [], content, numLines: content.split('\n').length, totalLines: content.split('\n').length };

  const parsed = parseGrepResponse(toolInput, toolResponse);
  if (!parsed.ok) { out.push({ ...r, stopped_at: `parse:${parsed.reason}` }); continue; }

  const request = buildSelectionRequest({ requests: [ASK[r.pattern] ?? `what does ${r.pattern} do?`], searchInput: toolInput, blocks: parsed.blocks }, DEFAULT_CONFIG);
  const t0 = performance.now();
  const res = await callJev(request, { apiKey, deadlineMs: 20000 });
  const wall = Math.round(performance.now() - t0);
  if (!res.ok) { out.push({ ...r, stopped_at: `http:${res.code}`, wall_ms: wall }); continue; }

  const decision = decideSelection(res.response.answers, parsed.blocks);
  const before = contentBytesOf(parsed.blocks);
  const after = contentBytesOf(decision.kept);
  const scope = res.response.answers['scope'];
  // What the block answers alone would have omitted, ignoring the scope gate.
  let blockOmits = 0;
  parsed.blocks.forEach((b, i) => {
    const a = res.response.answers[`block_${i}`];
    if (a && a.choice === 'omit' && a.confidence >= OMIT_CONFIDENCE_FLOOR) blockOmits += 1;
  });
  out.push({
    repo: r.repo, pattern: r.pattern, bytes: r.bytes, blocks: parsed.blocks.length,
    wall_ms: wall, jev_in: res.response.usage.input_tokens, jev_out: res.response.usage.output_tokens,
    request_bytes: res.requestBytes,
    scope_choice: scope?.choice ?? null, scope_conf: scope?.confidence ?? null,
    block_omits_at_floor: blockOmits,
    decision_omit: decision.omit, reason: decision.reason,
    before, after, saved_bytes: before - after,
  });
}
writeFileSync('/tmp/jev-gates.json', JSON.stringify(out, null, 2));
console.log(`${'repo/pattern'.padEnd(34)}${'blk'.padStart(4)}${'ms'.padStart(6)}${'jev_in'.padStart(8)}${'scope'.padStart(12)}${'conf'.padStart(6)}${'omits'.padStart(7)}  outcome`);
for (const o of out) {
  const tag = `${o.repo}/${o.pattern}`.slice(0, 33);
  console.log(`${tag.padEnd(34)}${String(o.blocks ?? '-').padStart(4)}${String(o.wall_ms ?? '-').padStart(6)}${String(o.jev_in ?? '-').padStart(8)}${String(o.scope_choice ?? '-').padStart(12)}${String(o.scope_conf ?? '-').padStart(6)}${String(o.block_omits_at_floor ?? '-').padStart(7)}  ${o.decision_omit ? `OMIT saved=${o.saved_bytes}B` : (o.reason ?? o.stopped_at)}`);
}
