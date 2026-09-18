// Real user prompts from the main sessions. Gate A's whole input is the prompt text, so these can be replayed
// against it exactly as the hook would have sent them.
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ROOT = '/Users/isaac/.claude/projects';
const files = [];
for (const d of readdirSync(ROOT)) {
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { if (statSync(join(ROOT, d, f)).size > 20_000_000) files.push([d, join(ROOT, d, f)]); } catch {} }
}
const prompts = [];
for (const [project, p] of files) {
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"type":"user"')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'user' || e.isSidechain) continue;
      let t = e.message?.content;
      if (Array.isArray(t)) t = t.filter((b) => b?.type === 'text').map((b) => b.text).join('');
      if (typeof t !== 'string') continue;
      t = t.trim();
      // Only genuine typed requests: no tool results, no slash commands, no system reminders.
      if (t.length < 15 || t.length > 4000) continue;
      if (t.startsWith('/') || t.startsWith('<') || t.includes('<system-reminder>') || t.includes('tool_use_id')) continue;
      prompts.push({ project, text: t });
    }
  } catch {}
}
// Spread across sessions rather than taking one session's run of prompts.
const seen = new Set(); const picked = [];
for (let i = 0; i < prompts.length && picked.length < 400; i += Math.max(1, Math.floor(prompts.length / 400))) {
  const x = prompts[i]; const k = x.text.slice(0, 80);
  if (seen.has(k)) continue; seen.add(k); picked.push(x);
}
writeFileSync('/tmp/prompts.json', JSON.stringify(picked, null, 2));
console.log(`typed prompts found: ${prompts.length}, sampled: ${picked.length}`);
console.log('length: median', picked.map((p)=>p.text.length).sort((a,b)=>a-b)[Math.floor(picked.length/2)]);
for (const p of picked.slice(0, 3)) console.log('  e.g.', JSON.stringify(p.text.slice(0, 90)));
