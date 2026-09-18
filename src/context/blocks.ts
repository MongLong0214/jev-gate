import { basename } from 'node:path';

import { MAX_PATH_CHARS } from '../plan.js';
import type { ContextCode, SearchBlock } from '../types.js';

/**
 * THE HOST ADAPTER BOUNDARY — UNCONFIRMED SHAPE (§3).
 *
 * Everything this feature assumes about the host's Grep result lives in this file and nowhere else. The local probe
 * still has to confirm, against the installed CLI, that:
 *   1. `tool_response` for a content-mode Grep is a JSON object (not a bare string) and that `CONTENT_KEY`,
 *      `FILENAMES_KEY`, `NUM_FILES_KEY` and `NUM_LINES_KEY` are the actual key names carrying the joined match text,
 *      the file list and the two counts;
 *   2. what those counts mean (matches, lines or files) and whether `filenames` is populated in content mode at all;
 *   3. how a natively truncated or paginated result is marked (`TRUNCATION_MARKS` and the input keys in
 *      `TRUNCATION_INPUT_KEYS` are the current guesses);
 *   4. whether `updatedToolOutput` has to carry every key the native object had, which is why `meta.original` is kept
 *      and a replacement is spread over it instead of being constructed from scratch;
 *   5. how a failed, interrupted or permission-denied Grep is reported (`FAILURE_KEYS`).
 *
 * Until the probe lands, anything that does not match this placeholder exactly returns `ok: false` and the caller
 * passes the original result through. A wrong guess therefore costs application opportunity, never a rewritten result.
 */
export const CONTENT_KEY = 'content';
export const FILENAMES_KEY = 'filenames';
export const NUM_FILES_KEY = 'numFiles';
export const NUM_LINES_KEY = 'numLines';
export const MODE_KEY = 'mode';
const FAILURE_KEYS = ['error', 'is_error', 'interrupted', 'timedOut', 'permissionDenied'] as const;
const TRUNCATION_MARKS = ['results truncated', 'results are truncated', '[truncated]', 'showing first', 'output limit'] as const;
const TRUNCATION_RESPONSE_KEYS = ['truncated', 'hasMore', 'nextOffset'] as const;
/** A host-side limit or page offset means the native result is already partial, so §6 excludes it from selection. */
const TRUNCATION_INPUT_KEYS = ['head_limit', 'offset'] as const;

/** §6: the Grep arguments the state may carry. Nothing else from the tool input is forwarded. */
export const GREP_INPUT_KEYS = ['pattern', 'path', 'glob', 'type', 'output_mode', 'multiline', '-i', '-n', '-A', '-B', '-C'] as const;

/**
 * §6: a temporary development threshold, not a claim that 8 KiB of search output recovers the call's cost. Below it the
 * original passes through with no provider call at all.
 */
export const MIN_CONTENT_BYTES = 8 * 1024;

/**
 * Instruction files: their content constrains the session, so they are kept unconditionally and never asked about. The
 * list is deliberately short and conservative; a path it does not know is judged like any other block.
 */
export const PROTECTED_BASENAMES: readonly string[] = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.local.md', 'GEMINI.md', '.cursorrules', '.windsurfrules'];
export const PROTECTED_PATH_SEGMENTS: readonly string[] = ['.claude', '.cursor'];

export type GrepParseFailure = Extract<
  ContextCode,
  'context_response_failed' | 'context_response_unparsed' | 'context_response_short' | 'context_response_truncated' | 'context_meta_inconsistent' | 'context_no_candidates'
>;

export interface GrepMeta {
  /** The response exactly as received. A replacement is spread over it so unknown keys survive untouched. */
  original: Record<string, unknown>;
  filenames: string[];
  numFiles: number | null;
  /** Non-null only when the received value matched this file's own line count, so it can be regenerated consistently. */
  numLines: number | null;
  contentBytes: number;
  lineCount: number;
  /** The whitelisted search arguments, ready to send as `SelectionContext.searchInput`. */
  searchInput: Record<string, unknown>;
}

export type ParseGrepResult = { ok: true; blocks: SearchBlock[]; meta: GrepMeta } | { ok: false; reason: GrepParseFailure };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Trailing CR is part of the original bytes and is preserved in the block text; it is only stripped for analysis. */
const analysed = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

/** Lines as the host sent them, with a single trailing newline not counted as an empty last line. */
const splitContent = (content: string): string[] => {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

export const isProtectedPath = (sourcePath: string): boolean => {
  const name = basename(sourcePath).toLowerCase();
  if (PROTECTED_BASENAMES.some((p) => p.toLowerCase() === name)) return true;
  return sourcePath.split(/[/\\]/).some((seg) => PROTECTED_PATH_SEGMENTS.includes(seg));
};

const plausiblePath = (p: string): boolean => p.length > 0 && p.length <= MAX_PATH_CHARS && ![...p].some((c) => c.charCodeAt(0) < 0x20);

interface SplitLine {
  sourcePath: string;
  line: number | null;
}

/**
 * Splits one result line into its path and line number. A naive split on the first colon is wrong twice over: a path may
 * contain a colon and matched text certainly may. Two disambiguations are used, in order:
 *   1. the response's own file list, when it has one: the longest listed path that prefixes the line wins, which is exact;
 *   2. otherwise the earliest `<sep><digits><sep>` run, taking whichever of `:` (match line) and `-` (context line)
 *      starts earlier, so `a.ts-40-x{k:12:v}` splits on the dash and `a.ts:40:x-9-y` splits on the colon.
 * Rule 2 still cannot separate a path that literally contains `:<digits>:` from a match; such a result is rare, and the
 * whole-result checks in `parseGrepResponse` (every path listed, line numbers ordered) are what keep it from being rewritten.
 */
const splitLine = (raw: string, known: readonly string[]): SplitLine | null => {
  const text = analysed(raw);
  if (known.length > 0) {
    let best: string | null = null;
    for (const p of known) {
      const sep = text.charAt(p.length);
      if ((sep === ':' || sep === '-') && text.startsWith(p) && (best === null || p.length > best.length)) best = p;
    }
    if (best !== null) {
      const sep = text.charAt(best.length);
      const rest = text.slice(best.length + 1);
      const m = new RegExp(`^(\\d{1,9})\\${sep}`).exec(rest);
      return { sourcePath: best, line: m?.[1] === undefined ? null : Number.parseInt(m[1], 10) };
    }
    return null;
  }
  const colon = /^(.*?):(\d{1,9}):/.exec(text);
  const dash = /^(.*?)-(\d{1,9})-/.exec(text);
  let pick: RegExpExecArray | null = colon;
  if (colon === null) pick = dash;
  else if (dash !== null && (dash[1] as string).length < (colon[1] as string).length) pick = dash;
  if (pick === null) return null;
  const sourcePath = pick[1] as string;
  if (!plausiblePath(sourcePath)) return null;
  return { sourcePath, line: Number.parseInt(pick[2] as string, 10) };
};

interface Draft {
  sourcePath: string;
  lines: string[];
  startLine: number | null;
  endLine: number | null;
}

export const sanitizeGrepInput = (toolInput: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (!isRecord(toolInput)) return out;
  for (const key of GREP_INPUT_KEYS) if (Object.prototype.hasOwnProperty.call(toolInput, key)) out[key] = toolInput[key];
  return out;
};

/**
 * Builds the complete search groups of one content-mode Grep result. Original order, original bytes and original line
 * positions are preserved; only byte-identical occurrences of the same path and range are dropped. Anything that cannot
 * be read unambiguously — a failed result, a truncated one, a count whose meaning cannot be reproduced, a line that does
 * not split — returns `ok: false`, and the caller passes the original result through.
 *
 * The caller is still responsible for the facts this function cannot see: the hook's own `error`/`is_interrupt` fields,
 * the tool name, and whether a usable purpose is connected.
 */
export const parseGrepResponse = (toolInput: unknown, toolResponse: unknown): ParseGrepResult => {
  if (!isRecord(toolResponse)) return { ok: false, reason: 'context_response_unparsed' };
  if (FAILURE_KEYS.some((k) => toolResponse[k] !== undefined && toolResponse[k] !== false && toolResponse[k] !== '')) return { ok: false, reason: 'context_response_failed' };
  const status = toolResponse['status'];
  if (typeof status === 'string' && status !== 'completed' && status !== 'success') return { ok: false, reason: 'context_response_failed' };

  const mode = toolResponse[MODE_KEY];
  const requestedMode = isRecord(toolInput) ? toolInput['output_mode'] : undefined;
  // §6: only the content output is in scope. A count or files-only result is excluded, never re-run as content.
  if (requestedMode !== 'content' || (mode !== undefined && mode !== 'content')) return { ok: false, reason: 'context_response_unparsed' };
  if (TRUNCATION_INPUT_KEYS.some((k) => isRecord(toolInput) && toolInput[k] !== undefined)) return { ok: false, reason: 'context_response_truncated' };
  if (TRUNCATION_RESPONSE_KEYS.some((k) => toolResponse[k] !== undefined && toolResponse[k] !== false)) return { ok: false, reason: 'context_response_truncated' };

  const content = toolResponse[CONTENT_KEY];
  if (typeof content !== 'string' || content.length === 0) return { ok: false, reason: 'context_response_unparsed' };
  const lower = content.toLowerCase();
  if (TRUNCATION_MARKS.some((m) => lower.includes(m))) return { ok: false, reason: 'context_response_truncated' };
  const contentBytes = bytes(content);
  if (contentBytes < MIN_CONTENT_BYTES) return { ok: false, reason: 'context_response_short' };

  const rawFilenames = toolResponse[FILENAMES_KEY];
  if (rawFilenames !== undefined && !Array.isArray(rawFilenames)) return { ok: false, reason: 'context_meta_inconsistent' };
  const filenames = Array.isArray(rawFilenames) ? rawFilenames : [];
  if (filenames.some((f) => typeof f !== 'string' || !plausiblePath(f))) return { ok: false, reason: 'context_meta_inconsistent' };
  const known = filenames as string[];
  const numFilesRaw = toolResponse[NUM_FILES_KEY];
  if (numFilesRaw !== undefined && (typeof numFilesRaw !== 'number' || !Number.isInteger(numFilesRaw) || numFilesRaw < 0)) return { ok: false, reason: 'context_meta_inconsistent' };
  // The count has to agree with the list it is supposed to count, or its meaning is unknown and nothing may be rewritten.
  if (typeof numFilesRaw === 'number' && known.length > 0 && numFilesRaw !== known.length) return { ok: false, reason: 'context_meta_inconsistent' };

  const lines = splitContent(content);
  const numLinesRaw = toolResponse[NUM_LINES_KEY];
  if (numLinesRaw !== undefined && (typeof numLinesRaw !== 'number' || !Number.isInteger(numLinesRaw) || numLinesRaw !== lines.length)) {
    return { ok: false, reason: 'context_meta_inconsistent' };
  }

  // The host's own hunk separator is the most reliable statement about which lines belong together; when it is absent,
  // only consecutive line numbers in the same file are connected.
  const hasSeparators = lines.some((l) => analysed(l) === '--');
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (const raw of lines) {
    if (analysed(raw) === '--') {
      current = null;
      continue;
    }
    const split = splitLine(raw, known);
    if (split === null) return { ok: false, reason: 'context_response_unparsed' };
    const connected =
      current !== null &&
      current.sourcePath === split.sourcePath &&
      (hasSeparators || (split.line === null && current.endLine === null) || (split.line !== null && current.endLine !== null && split.line === current.endLine + 1));
    if (connected && current !== null) {
      current.lines.push(raw);
      if (split.line !== null) current.endLine = split.line;
    } else {
      current = { sourcePath: split.sourcePath, lines: [raw], startLine: split.line, endLine: split.line };
      drafts.push(current);
    }
  }
  if (drafts.length === 0) return { ok: false, reason: 'context_response_unparsed' };

  // Only a byte-identical occurrence of the same path and the same range is a duplicate. Equal text at a different
  // location stays its own block, and the first occurrence keeps its original position.
  const seen = new Set<string>();
  const blocks: SearchBlock[] = [];
  for (const d of drafts) {
    const text = d.lines.join('\n');
    // A tuple encoding, so no separator character can appear inside a path or a matched line and forge a duplicate.
    const key = JSON.stringify([d.sourcePath, d.startLine, d.endLine, text]);
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({ id: `b${blocks.length}`, sourcePath: d.sourcePath, startLine: d.startLine, endLine: d.endLine, text, protected: isProtectedPath(d.sourcePath) });
  }
  if (blocks.every((b) => b.protected)) return { ok: false, reason: 'context_no_candidates' };

  return {
    ok: true,
    blocks,
    meta: {
      original: toolResponse,
      filenames: known,
      numFiles: typeof numFilesRaw === 'number' ? numFilesRaw : null,
      numLines: typeof numLinesRaw === 'number' ? numLinesRaw : null,
      contentBytes,
      lineCount: lines.length,
      searchInput: sanitizeGrepInput(toolInput),
    },
  };
};

/**
 * The other half of the adapter: the selected blocks rendered back into the shape the host sent. Unknown keys are carried
 * over untouched, and a count is regenerated only where `parseGrepResponse` verified what it counts. The selected text is
 * the original bytes; characters, paths and line positions are never rewritten.
 */
export const renderGrepResponse = (meta: GrepMeta, kept: readonly SearchBlock[]): Record<string, unknown> => {
  const content = kept.map((b) => b.text).join('\n');
  const out: Record<string, unknown> = { ...meta.original, [CONTENT_KEY]: content };
  if (meta.numLines !== null) out[NUM_LINES_KEY] = splitContent(content).length;
  if (meta.filenames.length > 0) {
    const paths = [...new Set(kept.map((b) => b.sourcePath))];
    out[FILENAMES_KEY] = paths;
    if (meta.numFiles !== null) out[NUM_FILES_KEY] = paths.length;
  }
  return out;
};

export const contentBytesOf = (blocks: readonly SearchBlock[]): number => bytes(blocks.map((b) => b.text).join('\n'));
