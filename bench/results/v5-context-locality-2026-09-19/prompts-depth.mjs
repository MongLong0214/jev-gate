// Real prompts paired with the context the session was actually carrying when each was typed. That number is what
// decides which execution shape is cheaper, and it is the one thing Gate A is not shown.
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ROOT = '/Users/isaac/.claude/projects';
const MACHINE = /^(Stop hook feedback:|Another Claude session sent a message:|\[Artifact comment|<)|^@"/;
const files = [];
for (const d of readdirSync(ROOT)) {
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { if (statSync(join(ROOT, d, f)).size > 20_000_000) files.push([d, join(ROOT, d, f)]); } catch {} }
}
const rows = [];
for (const [project, p] of files) {
  let lastCtx = 0;
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"type":"user"') && !line.includes('"usage"')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.isSidechain) continue;
      const m = e.message;
      const u = m && typeof m === 'object' ? m.usage : null;
      if (u) { lastCtx = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0); continue; }
      if (e.type !== 'user') continue;
      let t = m?.content;
      if (Array.isArray(t)) t = t.filter((b) => b?.type === 'text').map((b) => b.text).join('');
      if (typeof t !== 'string') continue;
      t = t.trim();
      if (t.length < 15 || t.length > 4000 || MACHINE.test(t) || lastCtx === 0) continue;
      rows.push({ project, text: t, context_tokens: lastCtx });
    }
  } catch {}
}
const seen = new Set(); const picked = [];
for (let i = 0; i < rows.length && picked.length < 120; i += Math.max(1, Math.floor(rows.length / 120))) {
  const x = rows[i]; const k = x.text.slice(0, 80);
  if (seen.has(k)) continue; seen.add(k); picked.push(x);
}
writeFileSync('/tmp/prompts-depth.json', JSON.stringify(picked, null, 2));
const c = picked.map((x) => x.context_tokens).sort((a, b) => a - b);
console.log(`prompts with a real context reading: ${rows.length}, sampled ${picked.length}`);
console.log(`context at prompt time: p10 ${c[Math.floor(c.length*0.1)].toLocaleString()}  median ${c[Math.floor(c.length/2)].toLocaleString()}  p90 ${c[Math.floor(c.length*0.9)].toLocaleString()}`);
console.log(`above the 45K crossing point: ${picked.filter((x) => x.context_tokens > 45000).length}/${picked.length}`);
