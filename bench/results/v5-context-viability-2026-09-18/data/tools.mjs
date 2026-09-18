// What tools do this machine's real sessions actually call? The filter hooks ^Grep$, so this is its whole surface.
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ROOT = '/Users/isaac/.claude/projects';
const files = [];
for (const d of readdirSync(ROOT)) {
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { if (statSync(join(ROOT, d, f)).size > 2048) files.push(join(ROOT, d, f)); } catch {} }
}
const names = new Map();
const bashSearch = { rg: 0, grep: 0, find: 0, other: 0 };
let scanned = 0, calls = 0;
for (const file of files) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('tool_use')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const c = e?.message?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type !== 'tool_use') continue;
        calls += 1;
        names.set(b.name, (names.get(b.name) ?? 0) + 1);
        if (b.name === 'Bash') {
          const cmd = String(b.input?.command ?? '');
          if (/\brg\b/.test(cmd)) bashSearch.rg += 1;
          else if (/\bgrep\b/.test(cmd)) bashSearch.grep += 1;
          else if (/\bfind\b/.test(cmd)) bashSearch.find += 1;
          else bashSearch.other += 1;
        }
      }
    }
  } catch {}
  scanned += 1;
  if (scanned % 5000 === 0) process.stderr.write(`  ${scanned}/${files.length}\n`);
}
const sorted = [...names.entries()].sort((a, b) => b[1] - a[1]);
writeFileSync('/tmp/tools.json', JSON.stringify({ scanned, calls, names: sorted, bashSearch }, null, 2));
console.log(`transcripts ${scanned}, tool calls ${calls}`);
for (const [n, v] of sorted.slice(0, 14)) console.log(`  ${String(n).padEnd(26)}${String(v).padStart(7)}  ${(100 * v / calls).toFixed(1)}%`);
console.log(`\nBash commands by search tool: rg=${bashSearch.rg} grep=${bashSearch.grep} find=${bashSearch.find} other=${bashSearch.other}`);
