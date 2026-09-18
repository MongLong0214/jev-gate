// Segment the same scan: benchmark/subagent runs vs ordinary project sessions, and old vs recent.
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ROOT = '/Users/isaac/.claude/projects';
const BENCH = /(v8run|sweep|judge|blind|review-|rounds-|calibration|packets|canary|probe)/;
const buckets = {};
const note = (k, name) => { (buckets[k] ??= { calls: 0, grep_tool: 0, bash: 0, bash_search: 0, files: new Set() }); };
const files = [];
for (const d of readdirSync(ROOT)) {
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { const st = statSync(join(ROOT, d, f)); if (st.size > 2048) files.push({ d, p: join(ROOT, d, f), mtime: st.mtimeMs }); } catch {} }
}
const CUTOFF = Date.parse('2026-08-01');
for (const { d, p, mtime } of files) {
  const kind = BENCH.test(d) ? 'benchmark' : 'ordinary';
  const age = mtime >= CUTOFF ? 'recent' : 'older';
  const k = `${kind}/${age}`;
  note(k);
  buckets[k].files.add(p);
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('tool_use')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const c = e?.message?.content; if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type !== 'tool_use') continue;
        buckets[k].calls += 1;
        if (b.name === 'Grep') buckets[k].grep_tool += 1;
        if (b.name === 'Bash') {
          buckets[k].bash += 1;
          if (/\b(rg|grep|ag|ack)\b/.test(String(b.input?.command ?? ''))) buckets[k].bash_search += 1;
        }
      }
    }
  } catch {}
}
const out = {};
console.log(`${'segment'.padEnd(22)}${'files'.padStart(7)}${'calls'.padStart(9)}${'Grep tool'.padStart(11)}${'Bash'.padStart(9)}${'Bash search'.padStart(13)}`);
for (const [k, v] of Object.entries(buckets).sort()) {
  out[k] = { files: v.files.size, calls: v.calls, grep_tool: v.grep_tool, bash: v.bash, bash_search: v.bash_search };
  console.log(`${k.padEnd(22)}${String(v.files.size).padStart(7)}${String(v.calls).padStart(9)}${String(v.grep_tool).padStart(11)}${String(v.bash).padStart(9)}${String(v.bash_search).padStart(13)}`);
}
writeFileSync('/tmp/tools-segmented.json', JSON.stringify(out, null, 2));
