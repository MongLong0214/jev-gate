// Free measurement: emulate the host's Grep (ripgrep, -n, no heading, head_limit 250) over real repositories
// with identifiers taken from those repositories, and score each result against the adapter's eligible window.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const MIN_BYTES = 8 * 1024;
const MAX_CHARS = 20_000;
const HEAD_LIMIT = 250;

const repos = process.argv.slice(2);
const rg = (args, cwd) => {
  try {
    return execFileSync('rg', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return e.status === 1 ? '' : null; // 1 = no matches
  }
};

// Patterns are identifiers the repository itself defines, so the sample is what someone would actually search for.
const patternsFor = (cwd) => {
  const out = rg(['-o', '--no-filename', '-N', '-t', 'ts', '-t', 'js', '-t', 'py',
                  '(?<=\\b(?:function|const|class|def|interface|type|export const)\\s)[A-Za-z_][A-Za-z0-9_]{5,}', '-P', '.'], cwd);
  if (out === null) return [];
  const freq = new Map();
  for (const w of out.split('\n')) if (w) freq.set(w, (freq.get(w) ?? 0) + 1);
  // Spread across the frequency range instead of taking only the most common, which would bias toward huge results.
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  const picks = [];
  const step = Math.max(1, Math.floor(sorted.length / 60));
  for (let i = 0; i < sorted.length && picks.length < 60; i += step) picks.push(sorted[i]);
  return picks;
};

const rows = [];
for (const cwd of repos) {
  for (const pattern of patternsFor(cwd)) {
    const raw = rg(['-n', '--no-heading', '--color=never', '--', pattern, '.'], cwd);
    if (raw === null || raw === '') continue;
    const allLines = raw.replace(/\n$/, '').split('\n');
    const truncated = allLines.length > HEAD_LIMIT;
    const lines = allLines.slice(0, HEAD_LIMIT);
    const content = lines.join('\n');
    rows.push({
      repo: cwd.split('/').filter(Boolean).pop(), pattern,
      total_lines: allLines.length, num_lines: lines.length, truncated,
      bytes: Buffer.byteLength(content, 'utf8'), chars: content.length,
    });
  }
}

const verdict = (r) => {
  if (r.truncated) return 'truncated_250';
  if (r.bytes < MIN_BYTES) return 'below_floor';
  if (r.chars > MAX_CHARS) return 'above_cap';
  return 'ELIGIBLE';
};
for (const r of rows) r.verdict = verdict(r);
writeFileSync('/tmp/window.json', JSON.stringify(rows, null, 2));

const tally = {};
for (const r of rows) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
console.log(`samples: ${rows.length}`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${String(v).padStart(4)}  ${(100 * v / rows.length).toFixed(1)}%`);
}
const el = rows.filter((r) => r.verdict === 'ELIGIBLE');
if (el.length) {
  const b = el.map((r) => r.bytes).sort((x, y) => x - y);
  console.log(`\neligible bytes: min=${b[0]} median=${b[Math.floor(b.length / 2)]} max=${b[b.length - 1]}`);
}
