// Every goal this machine has armed, and how the checker judged it. The bracket in a Stop hook feedback line
// carries the goal text verbatim, so the recorded sessions are the ground truth for whether a goal ever terminates.
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ROOT = '/Users/isaac/.claude/projects';
const files = [];
for (const d of readdirSync(ROOT)) {
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { if (statSync(join(ROOT, d, f)).size > 5_000_000) files.push([d, join(ROOT, d, f)]); } catch {} }
}
const goals = new Map();  // goal text -> {firings, projects, met}
for (const [project, p] of files) {
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('Stop hook feedback') && !line.includes('Goal check-in')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      let c = e.message?.content;
      if (Array.isArray(c)) c = c.filter((b) => b?.type === 'text').map((b) => b.text).join('');
      if (typeof c !== 'string') continue;
      const m = /^Stop hook feedback:\s*\n?\[([\s\S]*?)\]:/.exec(c) || /Goal check-in: «([\s\S]*?)»/.exec(c);
      if (!m) continue;
      const g = m[1].trim();
      const e2 = goals.get(g) ?? { firings: 0, projects: new Set(), met: 0 };
      e2.firings += 1; e2.projects.add(project);
      if (/条件.*met|conditions? (are |is )?(now )?(satisfied|met)|goal (is )?met/i.test(c)) e2.met += 1;
      goals.set(g, e2);
    }
  } catch {}
}
const rows = [...goals.entries()].map(([text, v]) => ({ text, firings: v.firings, met: v.met, projects: [...v.projects].length }))
  .sort((a, b) => b.firings - a.firings);
writeFileSync('/tmp/goals.json', JSON.stringify(rows, null, 2));
console.log(`distinct goals recorded: ${rows.length}, total firings: ${rows.reduce((s, r) => s + r.firings, 0)}\n`);
for (const r of rows.slice(0, 10)) {
  console.log(`  firings=${String(r.firings).padStart(4)} met=${r.met}  ${JSON.stringify(r.text.slice(0, 95))}`);
}
