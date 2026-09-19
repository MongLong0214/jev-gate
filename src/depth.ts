import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * How deep the main session already is when a prompt arrives.
 *
 * Decision 1 of DECISION-depth-gate-2026-09-19: this number is read from the host's own transcript, never asked of
 * Jev. It is a fact the hook can compute, and the one input that decides whether delegation is cheaper than doing the
 * work in place -- forced orchestration measured +182 % at 55K and -57 % at 406K.
 *
 * The definition is the one the 61-prompt replay used (`bench/results/v5-context-locality-2026-09-19/prompts-depth.mjs`):
 * the last non-sidechain transcript entry carrying `message.usage`, summed as
 * `cache_read_input_tokens + cache_creation_input_tokens + input_tokens`. Sidechain lines are subagent turns and
 * describe a different context than the one this prompt lands in, so they are skipped. Nothing here filters on
 * `type: "assistant"`; the replay did not either, and usage is written by assistant entries in practice.
 */

/** The read is bounded twice: a hook that blocks is worse than a hook that does not know the depth. */
export const DEPTH_MAX_BYTES = 8 * 1024 * 1024;
export const DEPTH_MAX_MS = 200;
const CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

export type DepthReading =
  | { ok: true; tokens: number; bytesRead: number; durationMs: number }
  | { ok: false; reason: 'depth_unknown'; bytesRead: number; durationMs: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const USAGE_MARKER = Buffer.from('"usage"');

/** One transcript line: the usage total, or null when the line has none, is a sidechain turn, or does not parse. */
const readUsageLine = (line: Buffer): number | null => {
  if (line.length === 0 || line.indexOf(USAGE_MARKER) === -1) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch {
    // A truncated final line is the normal case at the end of a transcript being appended to, not an error.
    return null;
  }
  if (!isRecord(entry) || entry['isSidechain'] === true) return null;
  const message = entry['message'];
  if (!isRecord(message)) return null;
  const usage = message['usage'];
  if (!isRecord(usage)) return null;
  let total = 0;
  let seen = false;
  for (const key of ['cache_read_input_tokens', 'cache_creation_input_tokens', 'input_tokens'] as const) {
    const v = usage[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    total += v;
    seen = true;
  }
  return seen ? total : null;
};

/**
 * Scan the complete lines held in `tail` from the end backwards. `from` is the first index known to start a line:
 * bytes before it are the front half of a line whose start has not been read yet.
 */
const scanBackwards = (tail: Buffer, from: number): number | null => {
  let end = tail.length;
  for (let i = tail.length - 1; i >= from - 1; i--) {
    if (i !== from - 1 && tail[i] !== NEWLINE) continue;
    const start = i + 1;
    if (start < end) {
      const tokens = readUsageLine(tail.subarray(start, end));
      if (tokens !== null) return tokens;
    }
    end = i;
  }
  return null;
};

/**
 * Read the transcript backwards from its end until a usage line is found or a bound is hit. Transcripts of the sessions
 * this is aimed at run to hundreds of megabytes, so the file is never read whole and never parsed line by line from the
 * front. Unknown is a real answer: the caller treats it as "do not orchestrate", which is the behaviour without this
 * file at all.
 */
export const readSessionDepth = (path: string | null | undefined, now: () => number = Date.now): DepthReading => {
  const started = now();
  const unknown = (bytesRead: number): DepthReading => ({ ok: false, reason: 'depth_unknown', bytesRead, durationMs: now() - started });
  if (typeof path !== 'string' || path.length === 0) return unknown(0);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return unknown(0);
  }
  let bytesRead = 0;
  try {
    let pos = fstatSync(fd).size;
    let tail = Buffer.alloc(0);
    while (pos > 0) {
      if (bytesRead >= DEPTH_MAX_BYTES || now() - started >= DEPTH_MAX_MS) return unknown(bytesRead);
      const len = Math.min(CHUNK_BYTES, pos, DEPTH_MAX_BYTES - bytesRead);
      const chunk = Buffer.allocUnsafe(len);
      const n = readSync(fd, chunk, 0, len, pos - len);
      if (n <= 0) return unknown(bytesRead);
      pos -= n;
      bytesRead += n;
      // Concatenated as bytes, not text: a chunk boundary inside a multi-byte character would decode to replacement
      // characters if each chunk were turned into a string on its own.
      tail = Buffer.concat([chunk.subarray(0, n), tail]);
      const firstNewline = tail.indexOf(NEWLINE);
      // With no newline in hand yet, every byte held is the tail of one line whose start is further back.
      if (firstNewline === -1 && pos > 0) continue;
      const tokens = scanBackwards(tail, pos === 0 ? 0 : firstNewline + 1);
      if (tokens !== null) return { ok: true, tokens, bytesRead, durationMs: now() - started };
      if (pos === 0) return unknown(bytesRead);
      // Keep only the partial line; the lines after it have been scanned and cannot become interesting later.
      tail = tail.subarray(0, firstNewline);
    }
    return unknown(bytesRead);
  } catch {
    return unknown(bytesRead);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* a descriptor that cannot be closed does not change the reading */
    }
  }
};
