// Measure the sawtooth empirically: the floor compaction drops to, and how fast context grows per turn.
// Also measure what a compaction costs, since after one the whole prompt has to be written to cache again.
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ROOT = '/Users/isaac/.claude/projects';
const files = [];
for (const d of readdirSync(ROOT)) {
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { if (statSync(join(ROOT, d, f)).size > 20_000_000) files.push(join(ROOT, d, f)); } catch {} }
}
const floors = [], peaks = [], deltas = [], cycles = [], createAtDrop = [];
for (const p of files) {
  const ctx = [], create = [];
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('usage')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const u = e.message?.usage; if (!u) continue;
      ctx.push((u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0));
      create.push(u.cache_creation_input_tokens ?? 0);
    }
  } catch {}
  let last = 0;
  for (let i = 1; i < ctx.length; i += 1) {
    const d = ctx[i] - ctx[i - 1];
    if (d < -100000) {                      // a compaction
      peaks.push(ctx[i - 1]); floors.push(ctx[i]); cycles.push(i - last); last = i;
      createAtDrop.push(create[i] ?? 0);
    } else if (d > 0 && d < 100000) deltas.push(d);
  }
}
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
console.log(`transcripts over 20 MB: ${files.length}, compactions observed: ${peaks.length}\n`);
console.log(`peak before compaction : median ${q(peaks,0.5).toLocaleString()}  p10 ${q(peaks,0.1).toLocaleString()}  p90 ${q(peaks,0.9).toLocaleString()}`);
console.log(`floor after compaction : median ${q(floors,0.5).toLocaleString()}  p10 ${q(floors,0.1).toLocaleString()}  p90 ${q(floors,0.9).toLocaleString()}`);
console.log(`cache WRITE on the turn after a compaction: median ${q(createAtDrop,0.5).toLocaleString()}`);
console.log(`turns per cycle        : median ${q(cycles,0.5)}  mean ${Math.round(mean(cycles))}`);
console.log(`context added per turn : median ${q(deltas,0.5).toLocaleString()}  mean ${Math.round(mean(deltas)).toLocaleString()}  p90 ${q(deltas,0.9).toLocaleString()}`);
