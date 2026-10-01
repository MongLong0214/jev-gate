import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { looksSecret } from './lean-source.js';

/**
 * #115: the last few things the user typed, read from the host transcript for one purpose -- when Gate A answers
 * `needs_context` on a short follow-up ("e2e 해봐"), the earlier turns are the context, and one re-ask with them is
 * what lets a long task that arrived as a follow-up sentence ever be delegated. Owner decision 2026-09-30: sending
 * these prior user turns to TypeSafe is allowed.
 *
 * Bounded like `depth.ts`: one tail read, never the whole file. Only records the user typed count (`type: "user"`,
 * text content, not sidechain, not meta, not a host-rendered command); a turn that looks like a secret is dropped,
 * not redacted, so no partial credential leaves the machine.
 */
export const RECENT_PROMPTS_MAX = 3;
export const RECENT_PROMPT_MAX_CHARS = 2000;
const TAIL_BYTES = 2 * 1024 * 1024;
const COMMAND_RECORD = /^<(?:command-name|command-message|bash-input|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/;
const INTERRUPTION = /^\[Request interrupted by user/;

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

const readTail = (path: string): string | null => {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd); if (!stat.isFile()) return null;
    const size = stat.size;
    const len = Math.min(size, TAIL_BYTES);
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

/**
 * Up to `max` earlier user prompts, oldest first, excluding `current` (the host may already have appended it).
 * Empty when the transcript is missing, unreadable, or holds nothing the user typed.
 */
export const readRecentPrompts = (path: string | null | undefined, current: string, max = RECENT_PROMPTS_MAX): string[] => {
  if (typeof path !== 'string' || path.length === 0) return [];
  const tail = readTail(path);
  if (tail === null) return [];
  const found: string[] = [];
  for (const line of tail.split('\n')) {
    if (line.length === 0 || !line.includes('"user"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry['type'] !== 'user' || entry['isSidechain'] === true || entry['isMeta'] === true) continue;
    const message = entry['message'];
    if (!isRecord(message)) continue;
    const text = textOnly(message['content']);
    if (text === null) continue;
    const trimmed = text.trim();
    if (trimmed.length === 0 || COMMAND_RECORD.test(trimmed) || INTERRUPTION.test(trimmed)) continue;
    found.push(trimmed);
  }
  if (found.length > 0 && found[found.length - 1] === current.trim()) found.pop();
  return found
    .filter((t) => !looksSecret(t))
    .slice(-max)
    .map((t) => (t.length > RECENT_PROMPT_MAX_CHARS ? `${t.slice(0, RECENT_PROMPT_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, '')} […]` : t));
};

/** The request text Gate A is re-asked with: earlier turns as data, the current request last and marked as such. */
export const withRecentPrompts = (prompt: string, recent: readonly string[]): string =>
  ['Earlier requests from this session, oldest first (context only; the current request is what is being classified):', ...recent.map((t, i) => `${i + 1}. ${t}`), '', 'Current request:', prompt].join('\n');
