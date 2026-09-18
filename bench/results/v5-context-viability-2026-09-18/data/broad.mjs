// Broad patterns: the searches where most hits are plausibly irrelevant, which is the premise the filter needs.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const MIN_BYTES = 8 * 1024, MAX_CHARS = 20_000, HEAD = 250;
const repos = ['jev-gate', 'commitlore', 'logic-pro-mcp', 'agent-operator-score'];
const patterns = ['error', 'config', 'result', 'session', 'path', 'write', 'timeout', 'record', 'status', 'index', 'parse', 'token', 'cache', 'hook', 'test'];
const rows = [];
for (const repo of repos) {
  for (const pattern of patterns) {
    let raw;
    try { raw = execFileSync('rg', ['-n', '--no-heading', '--color=never', '--', pattern, '.'], { cwd: `/Users/isaac/projects/${repo}`, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { if (e.status !== 1) continue; raw = ''; }
    if (!raw) continue;
    const all = raw.replace(/\n$/, '').split('\n');
    const truncated = all.length > HEAD;
    const content = all.slice(0, HEAD).join('\n');
    const bytes = Buffer.byteLength(content, 'utf8');
    const verdict = truncated ? 'truncated_250' : bytes < MIN_BYTES ? 'below_floor' : content.length > MAX_CHARS ? 'above_cap' : 'ELIGIBLE';
    rows.push({ repo, pattern, total_lines: all.length, truncated, bytes, chars: content.length, verdict });
  }
}
writeFileSync('/tmp/broad.json', JSON.stringify(rows, null, 2));
const t = {}; for (const r of rows) t[r.verdict] = (t[r.verdict] ?? 0) + 1;
console.log(`broad samples: ${rows.length}`);
for (const [k, v] of Object.entries(t).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)}${String(v).padStart(4)}  ${(100 * v / rows.length).toFixed(1)}%`);
console.log('\neligible:'); for (const r of rows.filter((x) => x.verdict === 'ELIGIBLE')) console.log(`  ${r.repo}/${r.pattern} lines=${r.total_lines} bytes=${r.bytes}`);
