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
  | { ok: true; tokens: number; model: string | null; modelSwitched: boolean; bytesRead: number; durationMs: number }
  | { ok: false; reason: 'depth_unknown'; bytesRead: number; durationMs: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const USAGE_MARKER = Buffer.from('"usage"');
/** How the host records a `/model` command in the transcript: a main-chain user entry naming the command. */
const MODEL_COMMAND_MARKER = Buffer.from('<command-name>/model</command-name>');
/** Only something shaped like a model ID leaves this reading; any other text in that field stays in the transcript. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;

type UsageLine = { tokens: number; model: string | null };

/**
 * One transcript line: the usage total and the model that produced it, or null when the line has no usage, is a
 * sidechain turn, or does not parse. The model rides along because the host's default compaction window is the
 * model's own (`host-window.ts`), and this line is already parsed.
 */
const readUsageLine = (line: Buffer): UsageLine | null => {
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
  const model = message['model'];
  return seen ? { tokens: total, model: typeof model === 'string' && MODEL_ID.test(model) ? model : null } : null;
};

/** A main-chain `/model` command, whether or not it changed anything: after one, the last reply's model is stale. */
const isModelCommand = (line: Buffer): boolean => {
  if (line.indexOf(MODEL_COMMAND_MARKER) === -1) return false;
  try {
    const entry: unknown = JSON.parse(line.toString('utf8'));
    return isRecord(entry) && entry['isSidechain'] !== true && entry['type'] === 'user';
  } catch {
    return false;
  }
};

/**
 * Visit the complete lines held in `tail` from the end backwards until `visit` returns true. `from` is the first index
 * known to start a line: bytes before it are the front half of a line whose start has not been read yet.
 */
const scanBackwards = (tail: Buffer, from: number, visit: (line: Buffer) => boolean): boolean => {
  let end = tail.length;
  for (let i = tail.length - 1; i >= from - 1; i--) {
    if (i !== from - 1 && tail[i] !== NEWLINE) continue;
    const start = i + 1;
    if (start < end && visit(tail.subarray(start, end))) return true;
    end = i;
  }
  return false;
};

/**
 * Feed the transcript's lines to `visit` from its end backwards until it returns true or a bound is hit. Transcripts of
 * the sessions this is aimed at run to hundreds of megabytes, so the file is never read whole and never parsed line by
 * line from the front. `done` false means the reading stopped short, which callers treat as unknown.
 */
const readBackwards = (path: string | null | undefined, now: () => number, visit: (line: Buffer) => boolean): { done: boolean; bytesRead: number; durationMs: number } => {
  const started = now();
  const result = (done: boolean, bytesRead: number) => ({ done, bytesRead, durationMs: now() - started });
  if (typeof path !== 'string' || path.length === 0) return result(false, 0);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return result(false, 0);
  }
  let bytesRead = 0;
  try {
    let pos = fstatSync(fd).size;
    let tail = Buffer.alloc(0);
    while (pos > 0) {
      if (bytesRead >= DEPTH_MAX_BYTES || now() - started >= DEPTH_MAX_MS) return result(false, bytesRead);
      const len = Math.min(CHUNK_BYTES, pos, DEPTH_MAX_BYTES - bytesRead);
      const chunk = Buffer.allocUnsafe(len);
      const n = readSync(fd, chunk, 0, len, pos - len);
      if (n <= 0) return result(false, bytesRead);
      pos -= n;
      bytesRead += n;
      // Concatenated as bytes, not text: a chunk boundary inside a multi-byte character would decode to replacement
      // characters if each chunk were turned into a string on its own.
      tail = Buffer.concat([chunk.subarray(0, n), tail]);
      const firstNewline = tail.indexOf(NEWLINE);
      // With no newline in hand yet, every byte held is the tail of one line whose start is further back.
      if (firstNewline === -1 && pos > 0) continue;
      if (scanBackwards(tail, pos === 0 ? 0 : firstNewline + 1, visit)) return result(true, bytesRead);
      if (pos === 0) return result(false, bytesRead);
      // Keep only the partial line; the lines after it have been scanned and cannot become interesting later.
      tail = tail.subarray(0, firstNewline);
    }
    return result(false, bytesRead);
  } catch {
    return result(false, bytesRead);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* a descriptor that cannot be closed does not change the reading */
    }
  }
};

/**
 * The last main-chain usage line. Unknown is a real answer: the caller treats it as "do not orchestrate", which is the
 * behaviour without this file at all. A `/model` command later in the file than that line makes its model stale.
 */
export const readSessionDepth = (path: string | null | undefined, now: () => number = Date.now): DepthReading => {
  let found: UsageLine | null = null;
  let modelCommand = false;
  const read = readBackwards(path, now, (line) => {
    found = readUsageLine(line);
    if (found !== null) return true;
    if (!modelCommand && isModelCommand(line)) modelCommand = true;
    return false;
  });
  const usage = found as UsageLine | null;
  if (!read.done || usage === null) return { ok: false, reason: 'depth_unknown', bytesRead: read.bytesRead, durationMs: read.durationMs };
  // #48 review: the host writes no model ID for a switch, only a display name, and the next reply is the first line to
  // carry the new ID; until then the model is not known rather than the previous one.
  return { ok: true, tokens: usage.tokens, model: modelCommand ? null : usage.model, modelSwitched: modelCommand, bytesRead: read.bytesRead, durationMs: read.durationMs };
};

export type TurnProgress =
  | { ok: true; requests: number; delegated: boolean; prompt: string | null; depth: number; bytesRead: number; durationMs: number }
  | { ok: false; bytesRead: number; durationMs: number };

const PROMPT_ID_MARKER = Buffer.from('"promptId"');
const ASSISTANT_MARKER = Buffer.from('"type":"assistant"');

/**
 * #356: how far the current turn has gone, read like the depth: the main-chain API requests (distinct assistant message
 * ids) since the user row that started `promptId`, whether one of them already called Agent, that row's text, and the
 * depth. The host stamps the turn's prompt id on the prompt row and on every tool result inside the turn, so a user row
 * with another id is the end of the reading. An assistant row counts only once a row of this turn is found before it
 * in the file, which leaves out the previous turn's closing reply. Stopping short of the turn's start is unknown.
 */
export const readTurnProgress = (path: string | null | undefined, promptId: string, now: () => number = Date.now): TurnProgress => {
  const ids = new Set<string>();
  let pending: string[] = [];
  let pendingAgent = false;
  let delegated = false;
  let depth: number | null = null;
  let prompt: string | null = null;
  const read = readBackwards(path, now, (line) => {
    if (depth === null) depth = readUsageLine(line)?.tokens ?? null;
    // Only user rows carry a prompt id and only assistant rows say so; anything else is not parsed.
    if (line.indexOf(PROMPT_ID_MARKER) === -1 && line.indexOf(ASSISTANT_MARKER) === -1) return false;
    let row: unknown;
    try {
      row = JSON.parse(line.toString('utf8'));
    } catch {
      return false;
    }
    if (!isRecord(row) || row['isSidechain'] === true) return false;
    const message = isRecord(row['message']) ? row['message'] : null;
    const content = message?.['content'];
    if (row['type'] === 'assistant') {
      if (typeof message?.['id'] === 'string') pending.push(message['id']);
      if (Array.isArray(content) && content.some((b) => isRecord(b) && b['type'] === 'tool_use' && b['name'] === 'Agent')) pendingAgent = true;
      return false;
    }
    if (row['type'] !== 'user') return false;
    if (row['promptId'] !== promptId) return true;
    for (const id of pending) ids.add(id);
    delegated ||= pendingAgent;
    pending = [];
    pendingAgent = false;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => isRecord(b) && b['type'] === 'text').map((b) => String(b['text'])).join('\n') : '';
    if (text.trim()) prompt = text;
    // A meta row (a skill's text, a scheduled fire) can sit inside the turn; only a person's row is its first line.
    return !!text.trim() && row['isMeta'] !== true;
  });
  const reached = depth as number | null;
  if (!read.done || reached === null) return { ok: false, bytesRead: read.bytesRead, durationMs: read.durationMs };
  return { ok: true, requests: ids.size, delegated, prompt, depth: reached, bytesRead: read.bytesRead, durationMs: read.durationMs };
};
