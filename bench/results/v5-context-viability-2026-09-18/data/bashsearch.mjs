// The searches this machine actually runs go through Bash. Measure their results against the same window,
// and note which of them emit `path:line:text`, the shape the existing block parser already reads.
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ROOT = '/Users/isaac/.claude/projects';
const BENCH = /(v8run|sweep|judge|blind|review-|rounds-|calibration|packets|canary|probe)/;
const MIN_BYTES = 8 * 1024, MAX_CHARS = 20_000;
const SEARCH = /(^|[|;&(]\s*)(rg|grep|egrep|fgrep)\b/;
const NUMBERED = /-[A-Za-z]*n/;

const files = [];
for (const d of readdirSync(ROOT)) {
  if (BENCH.test(d)) continue;
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { if (statSync(join(ROOT, d, f)).size > 2048) files.push(join(ROOT, d, f)); } catch {} }
}
const rows = [];
for (const p of files) {
  const pending = new Map();
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('tool_use') && !line.includes('tool_result')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const c = e?.message?.content; if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type === 'tool_use' && b.name === 'Bash') {
          const cmd = String(b.input?.command ?? '');
          if (SEARCH.test(cmd)) pending.set(b.id, cmd);
        } else if (b?.type === 'tool_result' && pending.has(b.tool_use_id)) {
          const cmd = pending.get(b.tool_use_id); pending.delete(b.tool_use_id);
          let t = b.content;
          if (Array.isArray(t)) t = t.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('');
          if (typeof t !== 'string' || t.length === 0) continue;
          const capped = t.includes('<persisted-output>');
          const bytes = Buffer.byteLength(t, 'utf8');
          rows.push({
            bytes, chars: t.length, lines: t.split('\n').length, capped,
            numbered: NUMBERED.test(cmd.split(/\s+/).filter((w) => w.startsWith('-')).join(' ')) || / -n\b/.test(cmd),
            is_error: b.is_error === true,
          });
        }
      }
    }
  } catch {}
}
const verdict = (r) => (r.is_error ? 'error' : r.capped ? 'above_cap' : r.bytes < MIN_BYTES ? 'below_floor' : r.chars > MAX_CHARS ? 'above_cap' : 'IN_WINDOW');
for (const r of rows) r.verdict = verdict(r);
writeFileSync('/tmp/bashsearch.json', JSON.stringify(rows));
const t = {}; for (const r of rows) t[r.verdict] = (t[r.verdict] ?? 0) + 1;
console.log(`Bash search results paired: ${rows.length}`);
for (const [k, v] of Object.entries(t).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)}${String(v).padStart(7)}  ${(100 * v / rows.length).toFixed(1)}%`);
const inw = rows.filter((r) => r.verdict === 'IN_WINDOW');
const s = rows.map((r) => r.bytes).sort((a, b) => a - b);
console.log(`\nall sizes: median=${s[Math.floor(s.length/2)]}B p90=${s[Math.floor(s.length*0.9)]}B p99=${s[Math.floor(s.length*0.99)]}B`);
console.log(`in-window: ${inw.length}, of which numbered (path:line:text parseable) = ${inw.filter((r) => r.numbered).length}`);
