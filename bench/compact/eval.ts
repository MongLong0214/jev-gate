/**
 * Offline check of mods/compact against the host's own compactions: at each real auto compaction in the local
 * transcripts, build the digest from the messages before it and ask how many of the referents (paths, SHAs, #N,
 * identifiers) that the next 12 assistant turns used in tool inputs survive, next to the host's summary and kept
 * messages. Usage: node bench/compact/eval.ts <outDir> [points] [budget...]
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { assemble, buildDigest, type DigestMessage, type DigestToolUse } from '../../mods/compact/hooks/digest.ts';

type Rec = Record<string, any>;
const ROOT = join(homedir(), '.claude', 'projects');
const WEEK = 7 * 86400e3;
const [outDir = '.', pointsArg = '40', ...budgetArgs] = process.argv.slice(2);
const N = Number(pointsArg);
const BUDGETS = budgetArgs.length ? budgetArgs.map(Number) : [30000, 40000, 50000];

const REF = /(?:~|\/)?(?:[\w.@-]+\/)+[\w.@-]+|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|#\d{2,5}\b|\b[a-z]+[A-Z]\w{3,}\b|\b[a-z]+_[a-z0-9_]{4,}\b/g;
const refs = (s: string): Set<string> => new Set([...s.matchAll(REF)].map((m) => m[0]).filter((x) => x.length >= 6));

const blocks = (r: Rec): Rec[] => {
  const c = r.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c.filter((b) => b && typeof b === 'object') : [];
};
const resultText = (b: Rec): string => {
  const x = b.content;
  if (Array.isArray(x)) return x.map((y: Rec) => y?.text ?? '').join(' ');
  return String(x ?? '');
};

/** Transcript records → the engine's message rows, near enough: one assistant row per API message id. */
const toMessages = (recs: Rec[]): DigestMessage[] => {
  const out: Array<{ role: 'user' | 'assistant'; text: string; toolUses: Array<DigestToolUse & { text?: string }>; toolResults?: Array<{ text: string; tool_use_id?: string }> }> = [];
  const byUse = new Map<string, { text?: string }>();
  let lastId: string | undefined;
  for (const r of recs) {
    if (r.type === 'assistant') {
      const id = r.message?.id;
      let m = out[out.length - 1];
      if (!(m && m.role === 'assistant' && id && id === lastId)) {
        m = { role: 'assistant', text: '', toolUses: [] };
        out.push(m);
      }
      lastId = id;
      for (const b of blocks(r)) {
        if (b.type === 'text' && b.text) m.text += (m.text ? '\n' : '') + b.text;
        if (b.type === 'tool_use') {
          const u = { tool_use_id: b.id, tool: b.name, input: b.input ?? {} };
          m.toolUses.push(u);
          byUse.set(b.id, u);
        }
      }
    } else if (r.type === 'user') {
      lastId = undefined;
      const bs = blocks(r);
      const results = bs.filter((b) => b.type === 'tool_result');
      for (const b of results) {
        const u = byUse.get(b.tool_use_id);
        if (u) u.text = resultText(b);
      }
      out.push({ role: 'user', text: bs.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), toolUses: [], toolResults: results.map((b) => ({ text: resultText(b), tool_use_id: b.tool_use_id })) });
    }
  }
  return out;
};

const render = (ms: readonly DigestMessage[]): string =>
  ms.map((m) => [m.text, ...m.toolUses.map((u) => `${u.tool} ${JSON.stringify(u.input)}`), ...(m.toolResults ?? []).map((r) => r.text)].join('\n')).join('\n');

const isSummaryRec = (r: Rec): boolean => r.isCompactSummary === true || blocks(r).some((b) => (b.text ?? '').trimStart().startsWith('This session is being continued'));

/**
 * What the engine held at the boundary `hi`: the records since the preceding boundary `lo`, with the messages that
 * boundary preserved from before it placed after its summary, as the host keeps them.
 */
const heldAt = (recs: Rec[], lo: number, hi: number): Rec[] => {
  const seg = recs.slice(lo, hi).filter((r) => r.subtype !== 'compact_boundary');
  if (recs[lo]?.subtype !== 'compact_boundary') return seg;
  const kept = new Set<string>(recs[lo].compactMetadata?.preservedMessages?.uuids ?? []);
  const inSeg = new Set(seg.map((r) => r.uuid));
  const preserved = recs.slice(0, lo).filter((r) => kept.has(r.uuid) && !inSeg.has(r.uuid));
  const at = seg.findIndex(isSummaryRec);
  return [...seg.slice(0, at + 1), ...preserved, ...seg.slice(at + 1)];
};

const load = (f: string): Rec[] =>
  readFileSync(f, 'utf8').split('\n').flatMap((l) => {
    try {
      return l ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });

const files: string[] = [];
for (const p of readdirSync(ROOT)) {
  if (p.startsWith('-private-tmp') || p.includes('jev-gate-runs')) continue;
  const dir = join(ROOT, p);
  if (!statSync(dir).isDirectory()) continue;
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (n.endsWith('.jsonl')) files.push(f);
    const sub = join(dir, n, 'subagents');
    if (existsSync(sub)) for (const s of readdirSync(sub)) if (s.endsWith('.jsonl')) files.push(join(sub, s));
  }
}

const points: Array<[string, number, number]> = [];
for (const f of files.filter((f) => Date.now() - statSync(f).mtimeMs < WEEK).sort()) {
  const raw = readFileSync(f, 'utf8');
  if (!raw.includes('"compact_boundary"')) continue;
  const recs = load(f);
  let prev = 0;
  // Every boundary starts what the engine holds next; only the auto ones are points.
  recs.forEach((r, i) => {
    if (r.subtype !== 'compact_boundary') return;
    if (r.compactMetadata?.trigger === 'auto') points.push([f, prev, i]);
    prev = i;
  });
}
// A fixed shuffle, so reruns and budget sweeps see the same points.
let seed = 20260927;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
for (let i = points.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [points[i], points[j]] = [points[j]!, points[i]!];
}

const rows: Rec[] = [];
for (const [f, lo, hi] of points) {
  if (rows.length >= N) break;
  const recs = load(f);
  const before = toMessages(heldAt(recs, lo, hi));
  const keep = new Set<string>(recs[hi].compactMetadata?.preservedMessages?.uuids ?? []);
  const post: string[] = recs.filter((r) => keep.has(r.uuid)).flatMap((r) => blocks(r).map((b) => b.text ?? (b.type === 'tool_result' ? resultText(b) : b.type === 'tool_use' ? `${b.name} ${JSON.stringify(b.input)}` : '')));
  for (const r of recs.slice(hi + 1, hi + 6)) {
    const s = blocks(r).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    if (s.trimStart().startsWith('This session is being continued')) {
      post.unshift(s);
      break;
    }
  }
  const hostText = post.join('\n');
  // What the host attaches after its own compaction (re-read files, file references), up to the next turn.
  const attached: string[] = [];
  for (const r of recs.slice(hi + 1)) {
    if (r.type === 'assistant') break;
    if (r.type === 'attachment' && ['file', 'compact_file_reference'].includes(r.attachment?.type)) attached.push(JSON.stringify(r.attachment));
  }
  const hostAttached = hostText + '\n' + attached.join('\n');
  const used = new Set<string>();
  let turns = 0;
  for (const r of recs.slice(hi + 1)) {
    if (r.type !== 'assistant') continue;
    for (const b of blocks(r)) if (b.type === 'tool_use') for (const x of refs(JSON.stringify(b.input ?? {}))) used.add(x);
    if (++turns >= 12) break;
  }
  const pre = refs(render(before));
  const want = [...used].filter((x) => pre.has(x));
  if (want.length < 5 || hostText.length < 2000) continue;
  const recall = (s: string) => Math.round((1000 * want.filter((x) => s.includes(x)).length) / want.length) / 1000;
  const row: Rec = { file: basename(f).slice(0, 12), kind: f.includes('/subagents/') ? 'sub' : 'main', want: want.length, hostChars: hostText.length, hostAChars: hostAttached.length, host: recall(hostText), hostA: recall(hostAttached), attachChars: attached.join('').length };
  for (const b of BUDGETS) {
    const d = buildDigest(before, { budgetChars: b });
    row[`d${b / 1000}k`] = d.ok ? recall(render(assemble(before, d.result))) : null;
    row[`d${b / 1000}k_chars`] = d.ok ? d.result.digestChars + d.result.tailChars : d.reason;
  }
  rows.push(row);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'digest-eval.json'), JSON.stringify(rows, null, 1));
const mean = (k: string) => {
  const v = rows.map((r) => r[k]).filter((x) => typeof x === 'number');
  return `${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)} (n ${v.length})`;
};
console.log(`points ${rows.length} (main ${rows.filter((r) => r.kind === 'main').length}); host mean chars ${Math.round(rows.reduce((a, r) => a + r.hostChars, 0) / rows.length)}, with attachments ${Math.round(rows.reduce((a, r) => a + r.hostAChars, 0) / rows.length)}`);
console.log(`host recall ${mean('host')}; with its attachments ${mean('hostA')} (mean attachment chars ${Math.round(rows.reduce((a, r) => a + r.attachChars, 0) / rows.length)})`);
for (const b of BUDGETS) {
  const k = `d${b / 1000}k`;
  const ge = rows.filter((r) => typeof r[k] === 'number' && r[k] >= r.hostA).length;
  const fell = rows.filter((r) => r[k] === null).map((r) => r[`${k}_chars`]);
  const chars = rows.map((r) => r[`${k}_chars`]).filter((x) => typeof x === 'number');
  console.log(`${k} recall ${mean(k)}  >=hostA ${ge}  fallback ${fell.length} ${JSON.stringify(fell)}  mean chars ${Math.round(chars.reduce((a: number, b: number) => a + b, 0) / chars.length)}`);
}

// Chained: in sessions with several auto compactions, each digest is built over the previous digest, its kept tail
// and the messages since (without the host's summary), as the engine would hold them had the module been active.
const chain: Rec[] = [];
const byFile = new Map<string, Array<[number, number]>>();
for (const [f, prev, hi] of points) byFile.set(f, [...(byFile.get(f) ?? []), [prev, hi]]);
for (const [f, spans] of [...byFile].filter(([, h]) => h.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
  const recs = load(f);
  const bounds = [...spans].sort((a, b) => a[1] - b[1]);
  let held: DigestMessage[] = [];
  let lo = 0;
  bounds.forEach(([prev, hi], k) => {
    const fresh = recs.slice(lo, hi).filter((r) => r.subtype !== 'compact_boundary' && !r.isCompactSummary);
    // A manual compaction in between replaced what the engine held, so the replay starts again from it.
    const between = recs.slice(lo, hi).flatMap((r, j) => (r.subtype === 'compact_boundary' ? [lo + j] : [])).at(-1);
    const before = k === 0 ? toMessages(heldAt(recs, prev, hi)) : between !== undefined ? toMessages(heldAt(recs, between, hi)) : [...held, ...toMessages(fresh)];
    lo = hi + 1;
    const d = buildDigest(before, { budgetChars: BUDGETS[1] ?? 40000 });
    held = d.ok ? assemble(before, d.result) : before;
    if (k === 0) return;
    const used = new Set<string>();
    let turns = 0;
    for (const r of recs.slice(hi + 1)) {
      if (r.type !== 'assistant') continue;
      for (const b of blocks(r)) if (b.type === 'tool_use') for (const x of refs(JSON.stringify(b.input ?? {}))) used.add(x);
      if (++turns >= 12) break;
    }
    // Referents the whole session had seen by then, so both sides are asked about the same set.
    const seen = refs(recs.slice(0, hi).flatMap((r) => blocks(r).map((b) => (b.type === 'tool_use' ? JSON.stringify(b.input) : b.type === 'tool_result' ? resultText(b) : (b.text ?? '')))).join('\n'));
    const want = [...used].filter((x) => seen.has(x));
    if (want.length < 5) return;
    const keep = new Set<string>(recs[hi].compactMetadata?.preservedMessages?.uuids ?? []);
    const host = recs.filter((r) => keep.has(r.uuid)).flatMap((r) => blocks(r).map((b) => b.text ?? (b.type === 'tool_result' ? resultText(b) : JSON.stringify(b.input ?? ''))));
    for (const r of recs.slice(hi + 1)) {
      if (r.type === 'assistant') break;
      if (r.isCompactSummary || blocks(r).some((b) => (b.text ?? '').startsWith('This session is being continued'))) host.push(blocks(r).map((b) => b.text ?? '').join(' '));
      if (r.type === 'attachment' && ['file', 'compact_file_reference'].includes(r.attachment?.type)) host.push(JSON.stringify(r.attachment));
    }
    const recall = (s: string) => want.filter((x) => s.includes(x)).length / want.length;
    chain.push({ file: basename(f).slice(0, 12), k, want: want.length, hostA: recall(host.join('\n')), digest: d.ok ? recall(render(held)) : null, heldChars: d.ok ? render(held).length : null });
  });
}
writeFileSync(join(outDir, 'digest-chain.json'), JSON.stringify(chain, null, 1));
const cm = (k: string) => {
  const v = chain.map((r) => r[k]).filter((x) => typeof x === 'number');
  return (v.reduce((a, b) => a + b, 0) / v.length).toFixed(3);
};
console.log(`chained: ${chain.length} later compactions in ${new Set(chain.map((r) => r.file)).size} sessions; host+attachments ${cm('hostA')} digest ${cm('digest')} (>= host ${chain.filter((r) => r.digest >= r.hostA).length}); by depth:`);
for (const k of [1, 2, 4, 8, 16, 32]) {
  const rs = chain.filter((r) => r.k >= k && r.k < k * 2);
  if (rs.length) console.log(`  k ${k}-${k * 2 - 1}: n ${rs.length} host ${(rs.reduce((a, r) => a + r.hostA, 0) / rs.length).toFixed(3)} digest ${(rs.reduce((a, r) => a + (r.digest ?? 0), 0) / rs.length).toFixed(3)}`);
}
