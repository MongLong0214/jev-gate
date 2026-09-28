// Is the 516,711 tokens a turn a big static prefix, or accumulated conversation? And is the bill concentrated
// in long sessions or spread evenly? Both change what a fix would have to be.
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
  const ctx = [];       // cache_read + cache_create per turn = what the prompt carried that turn
  let create = 0, read = 0, out = 0;
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('usage')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const u = e.message?.usage; if (!u) continue;
      const prompt = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0);
      ctx.push(prompt);
      create += u.cache_creation_input_tokens ?? 0;
      read += u.cache_read_input_tokens ?? 0;
      out += u.output_tokens ?? 0;
    }
  } catch {}
  if (ctx.length) sessions.push({ project: p.split('/').slice(-2)[0], turns: ctx.length, first: ctx[0], max: Math.max(...ctx), read, create, out, ctx });
}
sessions.sort((a, b) => b.read - a.read);
const totalRead = sessions.reduce((s, x) => s + x.read, 0);

console.log(`sessions with usage: ${sessions.length}, total cache_read ${(totalRead/1e9).toFixed(1)}B\n`);
console.log(`STATIC PREFIX (turn 1 prompt size):`);
const firsts = sessions.map((s) => s.first).sort((a, b) => a - b);
console.log(`  median ${firsts[Math.floor(firsts.length/2)].toLocaleString()}  p90 ${firsts[Math.floor(firsts.length*0.9)].toLocaleString()}  max ${firsts[firsts.length-1].toLocaleString()} tokens\n`);

console.log(`CONCENTRATION — share of all cache_read by session rank:`);
let acc = 0;
for (const n of [1, 3, 10, 25, 50, 100]) {
  acc = sessions.slice(0, n).reduce((s, x) => s + x.read, 0);
  console.log(`  top ${String(n).padStart(3)} sessions: ${(100*acc/totalRead).toFixed(1).padStart(5)}%  (${sessions.slice(0,n).reduce((s,x)=>s+x.turns,0).toLocaleString()} turns)`);
}
console.log(`\nTOP SESSIONS:`);
console.log(`  ${'project'.padEnd(34)}${'turns'.padStart(8)}${'turn1'.padStart(10)}${'max ctx'.padStart(10)}${'cache_read'.padStart(12)}${'share'.padStart(8)}`);
for (const s of sessions.slice(0, 8)) {
  console.log(`  ${s.project.slice(0,33).padEnd(34)}${String(s.turns).padStart(8)}${s.first.toLocaleString().padStart(10)}${s.max.toLocaleString().padStart(10)}${(s.read/1e9).toFixed(1).padStart(11)}B${(100*s.read/totalRead).toFixed(1).padStart(7)}%`);
}
// Where in a session does the money go?
let earlyRead = 0, lateRead = 0;
for (const s of sessions) for (let i = 0; i < s.ctx.length; i += 1) { if (i < 500) earlyRead += s.ctx[i]; else lateRead += s.ctx[i]; }
console.log(`\nPROMPT TOKENS BY TURN POSITION: first 500 turns ${(earlyRead/1e9).toFixed(1)}B (${(100*earlyRead/(earlyRead+lateRead)).toFixed(1)}%), turn 501+ ${(lateRead/1e9).toFixed(1)}B (${(100*lateRead/(earlyRead+lateRead)).toFixed(1)}%)`);
writeFileSync('/tmp/growth.json', JSON.stringify(sessions.slice(0, 30).map(({ ctx, ...r }) => ({ ...r, ctxSample: ctx.filter((_, i) => i % 50 === 0) })), null, 2));
