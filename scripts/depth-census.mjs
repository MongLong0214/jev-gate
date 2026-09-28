/** $0 census: across every transcript on this machine, how deep does a turn actually get? */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';

const files = execFileSync('find', [process.env.HOME + '/.claude/projects', '-name', '*.jsonl'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\n').filter(Boolean);

const RE = {
  side: /"isSidechain":true/,
  usage: /"usage"/,
  cr: /"cache_read_input_tokens":(\d+)/,
  cc: /"cache_creation_input_tokens":(\d+)/,
  it: /"input_tokens":(\d+)/,
};
const FLOOR = 300000;
let turns = 0, atFloor = 0, sessions = 0, sessionsAtFloor = 0, peakAll = 0, peakFile = '';
const compactions = [];
const bands = { '<100K': 0, '100-200K': 0, '200-250K': 0, '250-300K': 0, '>=300K': 0 };

for (const f of files) {
  let peak = 0, prev = 0, hit = false, any = false;
  try {
    for await (const line of createInterface({ input: createReadStream(f), crlfDelay: Infinity })) {
      if (!RE.usage.test(line) || RE.side.test(line)) continue;
      const t = (+(RE.cr.exec(line)?.[1] ?? 0)) + (+(RE.cc.exec(line)?.[1] ?? 0)) + (+(RE.it.exec(line)?.[1] ?? 0));
      if (!t) continue;
      any = true; turns++;
      if (t < 100000) bands['<100K']++; else if (t < 200000) bands['100-200K']++;
      else if (t < 250000) bands['200-250K']++; else if (t < 300000) bands['250-300K']++;
      else { bands['>=300K']++; atFloor++; hit = true; }
      // a drop to under half from a deep turn is the compaction signature
      if (prev > 150000 && t < prev * 0.5) compactions.push(prev);
      prev = t;
      if (t > peak) peak = t;
    }
  } catch { continue; }
  if (any) sessions++;
  if (hit) sessionsAtFloor++;
  if (peak > peakAll) { peakAll = peak; peakFile = f; }
}
compactions.sort((a, b) => a - b);
const q = (p) => compactions.length ? compactions[Math.floor((compactions.length - 1) * p)] : null;
console.log(JSON.stringify({
  files: files.length, sessions_with_usage: sessions, turns,
  turns_at_or_above_300K: atFloor, sessions_at_or_above_300K: sessionsAtFloor,
  peak_turn_anywhere: peakAll, peak_file: peakFile.split('/').slice(-2).join('/'),
  bands,
  compaction_events: compactions.length,
  compaction_height: { min: compactions[0] ?? null, p50: q(0.5), p90: q(0.9), max: compactions[compactions.length - 1] ?? null },
}, null, 1));
