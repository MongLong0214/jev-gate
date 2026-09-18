// Where the tokens actually go, per session and in aggregate, over ordinary (non-benchmark) sessions.
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
const T = { input: 0, cache_create: 0, cache_read: 0, output: 0, thinking: 0 };
let sessions = 0, turns = 0, firstCreate = 0, sessionsWithUsage = 0;
for (const p of files) {
  let seen = false, first = true, localCreate = 0;
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('usage')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const u = e?.message?.usage; if (!u) continue;
      seen = true; turns += 1;
      T.input += u.input_tokens ?? 0;
      T.cache_create += u.cache_creation_input_tokens ?? 0;
      T.cache_read += u.cache_read_input_tokens ?? 0;
      T.output += u.output_tokens ?? 0;
      T.thinking += u.output_tokens_details?.thinking_tokens ?? 0;
      if (first) { localCreate = u.cache_creation_input_tokens ?? 0; first = false; }
    }
  } catch {}
  sessions += 1;
  if (seen) { sessionsWithUsage += 1; firstCreate += localCreate; }
}
writeFileSync('/tmp/cost.json', JSON.stringify({ sessions, sessionsWithUsage, turns, ...T, firstCreate }, null, 2));
const M = (x) => (x / 1e6).toFixed(1) + 'M';
const billed = T.input + T.cache_create + T.cache_read;
console.log(`ordinary sessions ${sessions} (${sessionsWithUsage} with usage), assistant turns ${turns}\n`);
console.log(`input (uncached)      ${M(T.input).padStart(8)}  ${(100*T.input/billed).toFixed(1)}%`);
console.log(`cache CREATION        ${M(T.cache_create).padStart(8)}  ${(100*T.cache_create/billed).toFixed(1)}%   <- written once per session, billed above base rate`);
console.log(`cache read            ${M(T.cache_read).padStart(8)}  ${(100*T.cache_read/billed).toFixed(1)}%   <- billed at a tenth`);
console.log(`output                ${M(T.output).padStart(8)}  (thinking ${M(T.thinking)})`);
console.log(`\nfirst-turn cache creation across sessions: ${M(firstCreate)}  = ${(100*firstCreate/T.cache_create).toFixed(0)}% of all cache creation`);
console.log(`per session: ${Math.round(firstCreate / sessionsWithUsage)} tokens written before any work happens`);
console.log(`\nfor comparison, ALL search output ever produced: 25.5 MB ~= 6.4M tokens`);
