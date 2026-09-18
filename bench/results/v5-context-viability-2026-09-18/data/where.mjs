// Where does a session's context actually go? Total tool_result bytes by tool, over ordinary sessions.
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ROOT = '/Users/isaac/.claude/projects';
const BENCH = /(v8run|sweep|judge|blind|review-|rounds-|calibration|packets|canary|probe)/;
const files = [];
for (const d of readdirSync(ROOT)) {
  if (BENCH.test(d)) continue;
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { if (statSync(join(ROOT, d, f)).size > 2048) files.push(join(ROOT, d, f)); } catch {} }
}
const byTool = new Map();
const add = (n, bytes) => { const e = byTool.get(n) ?? { calls: 0, bytes: 0, big: 0 }; e.calls += 1; e.bytes += bytes; if (bytes > 8192) e.big += 1; byTool.set(n, e); };
let assistantText = 0, sessions = 0;
for (const p of files) {
  const pending = new Map();
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('tool_use') && !line.includes('tool_result') && !line.includes('"text"')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const c = e?.message?.content; if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type === 'tool_use') pending.set(b.id, b.name);
        else if (b?.type === 'tool_result' && pending.has(b.tool_use_id)) {
          const name = pending.get(b.tool_use_id); pending.delete(b.tool_use_id);
          let t = b.content;
          if (Array.isArray(t)) t = t.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('');
          if (typeof t === 'string') add(name, Buffer.byteLength(t, 'utf8'));
        } else if (b?.type === 'text' && e.type === 'assistant') assistantText += Buffer.byteLength(b.text ?? '', 'utf8');
      }
    }
  } catch {}
  sessions += 1;
}
const rows = [...byTool.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
const total = rows.reduce((s, [, v]) => s + v.bytes, 0);
writeFileSync('/tmp/where.json', JSON.stringify({ sessions, total, assistantText, rows }, null, 2));
console.log(`ordinary sessions ${sessions} — total tool_result ${(total/1e6).toFixed(1)} MB, assistant prose ${(assistantText/1e6).toFixed(1)} MB\n`);
console.log(`${'tool'.padEnd(18)}${'calls'.padStart(8)}${'MB'.padStart(9)}${'share'.padStart(8)}${'mean B'.padStart(9)}${'>8KiB'.padStart(8)}`);
for (const [n, v] of rows.slice(0, 10)) {
  console.log(`${String(n).padEnd(18)}${String(v.calls).padStart(8)}${(v.bytes/1e6).toFixed(1).padStart(9)}${(100*v.bytes/total).toFixed(1).padStart(7)}%${String(Math.round(v.bytes/v.calls)).padStart(9)}${String(v.big).padStart(8)}`);
}
