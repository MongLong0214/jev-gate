// The other half of the goal: does a larger context make a turn slower? Timestamps are on every message.
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ROOT = '/Users/isaac/.claude/projects';
const all = [];
for (const d of readdirSync(ROOT)) {
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { if (statSync(join(ROOT, d, f)).size > 10_000_000) all.push(join(ROOT, d, f)); } catch {} }
}
// Bucket assistant turns by the prompt size they carried, and record how long the turn took.
const buckets = new Map();
const put = (ctx, ms, out) => {
  const k = ctx < 100e3 ? '  <100K' : ctx < 200e3 ? ' 100-200K' : ctx < 400e3 ? ' 200-400K' : ctx < 600e3 ? ' 400-600K' : ctx < 800e3 ? ' 600-800K' : '  800K-1M';
  const e = buckets.get(k) ?? { n: 0, ms: 0, out: 0, msList: [] };
  e.n += 1; e.ms += ms; e.out += out; if (e.msList.length < 20000) e.msList.push(ms);
  buckets.set(k, e);
};
for (const p of all) {
  let prevTs = null;
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('timestamp')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const ts = e.timestamp ? Date.parse(e.timestamp) : null;
      const u = e.message?.usage;
      if (e.type === 'user' && ts) { prevTs = ts; continue; }
      if (e.type === 'assistant' && u && ts && prevTs) {
        const ms = ts - prevTs;
        const ctx = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0);
        // Ignore gaps that are obviously the human being away, not the model working.
        if (ms > 0 && ms < 600000) put(ctx, ms, u.output_tokens ?? 0);
        prevTs = ts;
      }
    }
  } catch {}
}
const order = ['  <100K', ' 100-200K', ' 200-400K', ' 400-600K', ' 600-800K', '  800K-1M'];
console.log(`transcripts over 10 MB: ${all.length}\n`);
console.log(`${'context carried'.padEnd(12)}${'turns'.padStart(9)}${'median s'.padStart(11)}${'mean s'.padStart(9)}${'p90 s'.padStart(9)}${'out tok'.padStart(9)}`);
const out = {};
for (const k of order) {
  const e = buckets.get(k); if (!e) continue;
  const s = e.msList.slice().sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)] / 1000, p90 = s[Math.floor(s.length * 0.9)] / 1000;
  out[k.trim()] = { turns: e.n, median_s: +med.toFixed(1), mean_s: +(e.ms / e.n / 1000).toFixed(1), p90_s: +p90.toFixed(1), mean_out: Math.round(e.out / e.n) };
  console.log(`${k.padEnd(12)}${String(e.n).padStart(9)}${med.toFixed(1).padStart(11)}${(e.ms/e.n/1000).toFixed(1).padStart(9)}${p90.toFixed(1).padStart(9)}${String(Math.round(e.out/e.n)).padStart(9)}`);
}
writeFileSync('/tmp/latency.json', JSON.stringify(out, null, 2));
