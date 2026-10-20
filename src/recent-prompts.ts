import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { looksSecret } from './outbound-text.js';

/**
 * Recent human input shared by Compact and Router. Gate A classifies only the current request.
 *
 * Bounded like `depth.ts`: one tail read, never the whole file. Only records the user typed count (`humanInputText`);
 * a turn that looks like a secret is dropped, not redacted, so no partial credential leaves the machine.
 */
export const RECENT_PROMPTS_MAX = 3;
export const RECENT_PROMPT_MAX_CHARS = 2000;
const TAIL_BYTES = 2 * 1024 * 1024;
const COMMAND_RECORD = /^<(?:command-name|command-message|bash-input|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/;
const INTERRUPTION = /^\[Request interrupted by user/;

/** Transcript `promptSource` values a person authors; the hook's `source` vocabulary (`user`) is not the transcript's. */
const HUMAN_SOURCES = new Set(['typed', 'queued', 'suggestion_accepted', 'sdk']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const textOnly = (content: unknown): string | null => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (!isRecord(b) || b['type'] !== 'text' || typeof b['text'] !== 'string') return null;
    parts.push(b['text']);
  }
  return parts.join('\n');
};

/**
 * #281: the one test for "the host wrote this task notification row", shared by Gate A's notice check and the human
 * test below. 2.1.26-2.1.30 rows all carry these two fields; `turnOrigin` and `origin.producer` are missing on 84 of 727.
 */
export const isHostNoticeRow = (row: unknown): boolean =>
  isRecord(row) && row['type'] === 'user' && row['promptSource'] === 'system' && isRecord(row['origin']) && row['origin']['kind'] === 'task-notification';

/**
 * #281: the one test for "a person typed this transcript row", shared by Gate A's notice detection and Compact's
 * current task. Host-authored turns say so in the row: a task notification or a scheduled fire
 * (`promptSource: "system"`, a non-human `origin`), a compact summary, meta and sidechain rows. Queued commands the host
 * delivers mid-turn are `attachment` and `queue-operation` rows, never `type: "user"`. The text is never read for this.
 */
export const humanInputText = (row: unknown): string | null => {
  if (!isRecord(row) || isHostNoticeRow(row) || row['type'] !== 'user' || row['isSidechain'] === true || row['isMeta'] === true || row['isCompactSummary'] === true) return null;
  if (row['promptSource'] !== undefined && !HUMAN_SOURCES.has(String(row['promptSource']))) return null;
  if (row['origin'] !== undefined && (!isRecord(row['origin']) || row['origin']['kind'] !== 'human')) return null;
  const message = row['message'];
  const text = isRecord(message) ? textOnly(message['content'])?.trim() : null;
  return !text || COMMAND_RECORD.test(text) || INTERRUPTION.test(text) ? null : text;
};

export const readTail = (path: string, bytes = TAIL_BYTES): string | null => {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd); if (!stat.isFile()) return null;
    const size = stat.size;
    const len = Math.min(size, bytes);
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, size - len);
    const text = buf.subarray(0, n).toString('utf8');
    // The first line of a mid-file tail is a fragment; drop it.
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* nothing to recover */
    }
  }
};

const promptTexts = (text: string): string[] => {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0 || !line.includes('"user"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = humanInputText(entry);
    if (text !== null) found.push(text);
  }
  return found;
};

/**
 * Compact needs the latest human task even when tool output has filled the tail. Read backwards in 2 MiB chunks
 * until a usable prompt is found or the file starts. Keep a split JSONL row as bytes until it is complete, including
 * a split UTF-8 character. Only that row can exceed a chunk; no whole-transcript read or non-human fallback.
 */
export const readCurrentTaskPrompts = (path: string | null | undefined): string[] => {
  if (typeof path !== 'string' || path.length === 0) return [];
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return []; }
  try {
    const stat = fstatSync(fd); if (!stat.isFile()) return [];
    let end = stat.size;
    let fragment: Buffer = Buffer.alloc(0);
    while (end > 0) {
      const len = Math.min(end, TAIL_BYTES);
      const buf = Buffer.allocUnsafe(len);
      end -= len;
      if (readSync(fd, buf, 0, len, end) !== len) return [];
      const joined = fragment.length ? Buffer.concat([buf, fragment]) : buf;
      const newline = joined.indexOf(10);
      if (end > 0 && newline < 0) { fragment = joined; continue; }
      const start = end === 0 ? 0 : newline + 1;
      const found = selectRecentPrompts(promptTexts(joined.subarray(start).toString('utf8')));
      if (found.length) return found;
      fragment = joined.subarray(0, start);
    }
    return [];
  } catch { return []; } finally {
    try { closeSync(fd); } catch { /* nothing to recover */ }
  }
};

/** Native adapters provide only observed human requests; the same bounds and secret filtering apply. */
export const selectRecentPrompts = (requests: readonly string[], max = RECENT_PROMPTS_MAX): string[] => requests
  .filter(t => t.trim().length > 0 && !looksSecret(t) && !COMMAND_RECORD.test(t.trim()) && !INTERRUPTION.test(t.trim()))
  .slice(-max)
  .map(t => t.length > RECENT_PROMPT_MAX_CHARS ? `${t.slice(0, RECENT_PROMPT_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, '')} […]` : t);
