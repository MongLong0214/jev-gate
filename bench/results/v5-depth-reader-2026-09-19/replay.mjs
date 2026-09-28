/**
 * Step 1 proof (a) and (c) of DECISION-depth-gate-2026-09-19: the shipped reader, run over the same recorded sessions
 * the 61-prompt replay used, must reproduce that replay's number and must do it inside the hook's budget.
 *
 * Two comparisons, because the hook only ever reads at EOF but the claim is about any prompt position:
 *   EOF     -- forward scan to the end of the file  vs  readSessionDepth(file). Every large transcript.
 *   prompt  -- forward scan up to a real user prompt vs readSessionDepth(prefix copy at that prompt's offset).
 * Nothing here prints prompt text: positions, byte counts and token totals only.
 */
import { createReadStream, copyFileSync, openSync, readdirSync, readSync, closeSync, statSync, truncateSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionDepth, DEPTH_MAX_BYTES, DEPTH_MAX_MS } from '../../../dist/depth.js';

const ROOT = '/Users/isaac/.claude/projects';
const MACHINE = /^(Stop hook feedback:|Another Claude session sent a message:|\[Artifact comment|<)|^@"/;
const files = [];
for (const d of readdirSync(ROOT)) {
  let es; try { es = readdirSync(join(ROOT, d)); } catch { continue; }
  for (const f of es) if (f.endsWith('.jsonl')) { try { const p = join(ROOT, d, f); if (statSync(p).size > 20_000_000) files.push(p); } catch {} }
}

const tmp = mkdtempSync(join(tmpdir(), 'depth-replay-'));
const rows = [];
const promptRows = [];
for (const p of files) {
  const size = statSync(p).size;
  let lastCtx = 0;
  let offset = 0;           // bytes consumed, including the newline of the line just read
  const promptOffsets = []; // byte offset just before each real user prompt line
  const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const start = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1;
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
    promptOffsets.push([start, lastCtx]);
  }
  const t0 = process.hrtime.bigint();
  const read = readSessionDepth(p);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  rows.push({ size_mb: +(size / 1e6).toFixed(1), forward_tokens: lastCtx, reader_tokens: read.ok ? read.tokens : null, reader_ok: read.ok, match: read.ok ? read.tokens === lastCtx : lastCtx === 0, bytes_read: read.bytesRead, ms: +ms.toFixed(1) });

  // Four prompt positions per file, spread across the session, replayed against a prefix copy.
  const picks = [];
  for (let i = 1; i <= 4 && promptOffsets.length; i += 1) picks.push(promptOffsets[Math.floor((promptOffsets.length - 1) * (i / 5))]);
  for (const [at, expected] of picks) {
    const c = join(tmp, 'prefix.jsonl');
    copyFileSync(p, c);
    truncateSync(c, at);
    const r = readSessionDepth(c);
    promptRows.push({ at, expected, got: r.ok ? r.tokens : null, match: r.ok && r.tokens === expected });
  }
}
rmSync(tmp, { recursive: true, force: true });

const out = {
  caps: { bytes: DEPTH_MAX_BYTES, ms: DEPTH_MAX_MS },
  transcripts: rows.length,
  eof_matches: rows.filter((r) => r.match).length,
  prompt_positions: promptRows.length,
  prompt_matches: promptRows.filter((r) => r.match).length,
  slowest_ms: Math.max(...rows.map((r) => r.ms)),
  largest_mb: Math.max(...rows.map((r) => r.size_mb)),
  unknown_at_eof: rows.filter((r) => !r.reader_ok).length,
  rows,
  prompt_rows: promptRows,
};
writeFileSync(new URL('./reader-replay.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`transcripts ${out.transcripts} (largest ${out.largest_mb} MB)  EOF match ${out.eof_matches}/${out.transcripts}  prompt-position match ${out.prompt_matches}/${out.prompt_positions}  unknown ${out.unknown_at_eof}  slowest ${out.slowest_ms} ms`);
