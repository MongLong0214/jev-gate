// What would the bill have been if a session rotated once its prompt passed a cap, paying a fresh prefix each time?
// Token cost only. Rotation also costs work that is not modelled here -- the new session has to re-establish what it needs.
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ROOT = '/Users/isaac/.claude/projects';
const all = [];
for (const d of readdirSync(ROOT)) {
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { if (statSync(join(ROOT, d, f)).size > 2048) all.push(join(ROOT, d, f)); } catch {} }
}
const sessions = [];
for (const p of all) {
  const ctx = [];
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('usage')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const u = e.message?.usage; if (!u) continue;
      ctx.push((u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0));
    }
  } catch {}
  if (ctx.length > 1) sessions.push(ctx);
}
// Billing weights against base input: cache read 0.1x, one-hour cache write 2x.
const W_READ = 0.1, W_WRITE = 2.0;
const actual = () => {
  let read = 0, write = 0;
  for (const ctx of sessions) { write += ctx[0]; for (let i = 1; i < ctx.length; i += 1) { read += ctx[i - 1]; write += Math.max(0, ctx[i] - ctx[i - 1]); } }
  return { read, write, weighted: read * W_READ + write * W_WRITE };
};
const simulate = (cap) => {
  let read = 0, write = 0, rotations = 0;
  for (const ctx of sessions) {
    const prefix = ctx[0];
    let cur = prefix; write += prefix;
    for (let i = 1; i < ctx.length; i += 1) {
      const delta = Math.max(0, ctx[i] - ctx[i - 1]);
      if (cur + delta > cap) { rotations += 1; write += prefix; cur = prefix; }   // fresh session pays its prefix again
      read += cur;                                                                // this turn re-reads what is there
      cur += delta; write += delta;
    }
  }
  return { read, write, rotations, weighted: read * W_READ + write * W_WRITE };
};
const a = actual();
const F = (x) => (x / 1e9).toFixed(1) + 'B';
console.log(`sessions ${sessions.length}\n`);
console.log(`ACTUAL      read ${F(a.read).padStart(7)}  write ${F(a.write).padStart(7)}  weighted ${F(a.weighted).padStart(7)}`);
console.log(`\n${'cap'.padStart(9)}${'read'.padStart(9)}${'write'.padStart(9)}${'weighted'.padStart(10)}${'saving'.padStart(9)}${'rotations'.padStart(11)}`);
const rows = [];
for (const cap of [1000000, 500000, 300000, 200000, 150000, 100000, 75000]) {
  const s = simulate(cap);
  rows.push({ cap, ...s, saving: 1 - s.weighted / a.weighted });
  console.log(`${(cap/1000 + 'K').padStart(9)}${F(s.read).padStart(9)}${F(s.write).padStart(9)}${F(s.weighted).padStart(10)}${(100*(1 - s.weighted/a.weighted)).toFixed(1).padStart(8)}%${String(s.rotations).padStart(11)}`);
}
writeFileSync('/tmp/counterfactual.json', JSON.stringify({ actual: a, rows }, null, 2));
