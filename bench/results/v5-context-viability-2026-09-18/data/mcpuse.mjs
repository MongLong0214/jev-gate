// Which MCP servers and skills ever actually get used? Anything never used is pure prefix weight.
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const ROOT = '/Users/isaac/.claude/projects';
const files = [];
for (const d of readdirSync(ROOT)) {
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { if (statSync(join(ROOT, d, f)).size > 2048) files.push(join(ROOT, d, f)); } catch {} }
}
const mcp = new Map(), agents = new Map(), skills = new Map();
for (const p of files) {
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('tool_use')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const c = e.message?.content; if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type !== 'tool_use') continue;
        const n = String(b.name ?? '');
        if (n.startsWith('mcp__')) {
          const server = n.split('__')[1] ?? '?';
          mcp.set(server, (mcp.get(server) ?? 0) + 1);
        } else if (n === 'Agent') {
          const t = b.input?.subagent_type ?? '(default)';
          agents.set(t, (agents.get(t) ?? 0) + 1);
        } else if (n === 'Skill') {
          const s = b.input?.skill ?? '?';
          skills.set(s, (skills.get(s) ?? 0) + 1);
        }
      }
    }
  } catch {}
}
const show = (m, label) => {
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n${label} (${rows.length} distinct, ${rows.reduce((s,[,v])=>s+v,0)} calls)`);
  for (const [n, v] of rows) console.log(`  ${String(n).padEnd(34)}${String(v).padStart(7)}`);
};
show(mcp, 'MCP SERVERS USED');
show(agents, 'SUBAGENT TYPES USED');
show(skills, 'SKILLS INVOKED');
writeFileSync('/tmp/mcpuse.json', JSON.stringify({ mcp: [...mcp], agents: [...agents], skills: [...skills] }, null, 2));
