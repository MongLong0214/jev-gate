// #48 P0-2: rewrites the `model:`/`effort:` frontmatter lines of the six owned `agents/*.md` files from the built
// `OWNED_AGENT_PROFILES` table (src/agents.ts) and `DEFAULT_CONFIG.models` (src/config.ts) -- the same table doctor's
// `checkModelAuthority` reads -- so the packaged frontmatter and that table cannot quietly drift apart.
// Every other frontmatter field and the whole body are left byte-for-byte untouched. `executor.md` (lean's one
// untiered agent, `model: inherit`) is not in the table and is never touched here.
// Usage: node scripts/gen-agents.mjs [--check]   (requires `npm run build` first: it reads dist/, not src/)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes('--check');

const distAgents = join(root, 'dist', 'agents.js');
const distConfig = join(root, 'dist', 'config.js');
if (!existsSync(distAgents) || !existsSync(distConfig)) {
  process.stderr.write('gen-agents: dist/agents.js or dist/config.js is missing -- run npm run build first\n');
  process.exit(1);
}
const { OWNED_AGENT_PROFILES } = await import(`${distAgents}?t=${Date.now()}`);
const { DEFAULT_CONFIG } = await import(`${distConfig}?t=${Date.now()}`);

let drift = false;
let failed = false;

for (const profile of OWNED_AGENT_PROFILES) {
  const path = join(root, 'agents', profile.file);
  if (!existsSync(path)) {
    process.stderr.write(`gen-agents: ${profile.file} does not exist\n`);
    failed = true;
    continue;
  }
  const text = readFileSync(path, 'utf8');
  const end = text.startsWith('---\n') ? text.indexOf('\n---', 4) : -1;
  if (end < 0) {
    process.stderr.write(`gen-agents: ${profile.file} has no parseable frontmatter\n`);
    failed = true;
    continue;
  }
  const model = DEFAULT_CONFIG.models[profile.tier];
  const effort = profile.effort;
  const head = text.slice(0, end);
  const tail = text.slice(end);

  let nextHead = /^model:.*$/m.test(head) ? head.replace(/^model:.*$/m, `model: ${model}`) : `${head}\nmodel: ${model}`;
  if (effort === null) {
    nextHead = nextHead.replace(/\neffort:.*$/m, '');
  } else if (/^effort:.*$/m.test(nextHead)) {
    nextHead = nextHead.replace(/^effort:.*$/m, `effort: ${effort}`);
  } else {
    // No existing effort line: insert one right after model, so field order stays the same as every hand-written file.
    nextHead = nextHead.replace(/^(model:.*)$/m, `$1\neffort: ${effort}`);
  }

  const next = nextHead + tail;
  if (next === text) continue;
  drift = true;
  if (check) {
    process.stdout.write(`gen-agents --check: ${profile.file} drifts from the table (model: ${model}, effort: ${effort ?? 'inherited'})\n`);
  } else {
    writeFileSync(path, next);
    process.stdout.write(`gen-agents: wrote ${profile.file}\n`);
  }
}

if (failed) process.exit(1);
if (check && drift) process.exit(1);
if (!check && !drift) process.stdout.write('gen-agents: already up to date\n');
