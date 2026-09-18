// Same prompts, but keep the assistant turn immediately before each one. That is the cheapest possible answer to
// "what was this a continuation of", and it is the thing Gate A deliberately does not receive.
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
  let lastAssistant = '';
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.isSidechain) continue;
      let t = e.message?.content;
      if (Array.isArray(t)) t = t.filter((b) => b?.type === 'text').map((b) => b.text).join('');
      if (typeof t !== 'string') continue;
      t = t.trim();
      if (e.type === 'assistant') { if (t) lastAssistant = t; continue; }
      if (e.type !== 'user') continue;
      if (t.length < 15 || t.length > 4000 || MACHINE.test(t)) continue;
      rows.push({ project, text: t, prior: lastAssistant.slice(-700) });
    }
  } catch {}
}
const seen = new Set(); const picked = [];
for (let i = 0; i < rows.length && picked.length < 150; i += Math.max(1, Math.floor(rows.length / 150))) {
  const x = rows[i]; const k = x.text.slice(0, 80);
  if (seen.has(k)) continue; seen.add(k); picked.push(x);
}
writeFileSync('/tmp/prompts-ctx.json', JSON.stringify(picked, null, 2));
console.log(`typed prompts: ${rows.length}, sampled: ${picked.length}, with prior text: ${picked.filter((x) => x.prior.length > 0).length}`);
