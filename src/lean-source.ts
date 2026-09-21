import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import type { SkipCode } from './types.js';

/**
 * JGL-03: the effective root history, as the installed host actually records it.
 *
 * Host records this reads (Claude Code 2.1.x transcripts, verified against real files on 2026-09-21):
 *  - `{type:"user", message.content:<string>}`                     -- human text.
 *  - `{type:"user", isCompactSummary:true, message.content:<str>}` -- the compact summary, a fallible summary.
 *  - `{type:"user", message.content:[{type:"tool_result",...}]}`   -- a TOOL RESULT in a user envelope. Not human text.
 *  - `{type:"assistant", message.content:[{type:"text"|"tool_use"|"thinking"}]}` -- action and explanation.
 *  - `{type:"system", subtype:"compact_boundary", compactMetadata.preservedSegment:{headUuid,anchorUuid,tailUuid}}`
 *
 * The active source after a compaction is the host's own preserved segment: records from `headUuid` onwards, which
 * is where the retained pre-compact suffix begins, through the summary anchor and everything appended since. It is
 * NOT every physical line after a guessed marker -- `headUuid` sat 8 lines BEFORE the boundary in the file this was
 * written against, because partial compaction keeps earlier records.
 *
 * Unknown is never empty. A missing file, an unresolvable lineage or a history larger than the read bound all return
 * a reason, and the caller stays native.
 */

/** Bounded twice, like src/depth.ts: a hook that blocks is worse than a hook that does not know the history. */
export const SOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const SOURCE_MAX_MS = 400;
/** Enumerate this many of the newest complete optional groups; older ones are counted, never called irrelevant. */
export const MAX_OPTIONAL_GROUPS = 24;

export type GroupOrigin = 'human' | 'compact_summary' | 'assistant_tool';

export interface LeanGroup {
  /** Local deterministic identity. Never a host id: Jev returns these and they index only this request's array. */
  id: string;
  origin: GroupOrigin;
  /** The complete original visible unit, exact. Attribution is added outside it, never inside. */
  text: string;
  /** Actual host record references (uuids) this group was built from. */
  sourceRefs: string[];
  mandatory: boolean;
}

export interface LeanSource {
  /** The exact current user text, carried once. Taken from the hook event, never re-derived from the transcript. */
  request: string;
  groups: LeanGroup[];
  /** Compaction lineage. Changes when the host compacts, which invalidates a pending packet. */
  epoch: string;
  /** sha256 over the observed records BEFORE the current request. Ordinary appends for this request do not move it. */
  prefixDigest: string;
  /** A human turn after the current request: a new instruction, which invalidates a pending packet. */
  newerHumanText: boolean;
  coverage: 'complete' | 'partial';
  /** Complete optional groups that exist in the active source but were not enumerated or were withheld. */
  unassessed: number;
  bytesRead: number;
  durationMs: number;
}

export type LeanSourceOutcome =
  | { ok: true; source: LeanSource }
  | { ok: false; reason: Extract<SkipCode, 'source_unavailable' | 'source_lineage_unknown' | 'source_bounded'>; bytesRead: number; durationMs: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Best-effort local screening of conventional credential shapes, applied to the ORIGINAL string before any JSON
 * escaping. This is a guard against the obvious, not a privacy guarantee and not universal detection: private
 * non-secret source still leaves the machine when lean is explicitly enabled.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // A quoted value, or a long unbroken token. `password = readPassword();` is a call, not a credential.
  /\b(?:authorization|api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*(?:["'][^"'\s]{12,}["']|[A-Za-z0-9_\-./+=]{16,})/i,
];

export const looksSecret = (text: string): boolean => SECRET_PATTERNS.some((re) => re.test(text));

/**
 * Exact references a human turn makes to something the conversation already contains: a backticked or quoted span,
 * or a path/filename. Code only, no model: this finds the literal strings a request names, and nothing else.
 */
const REFERENCE_PATTERNS: readonly RegExp[] = [
  /`([^`\n]{3,200})`/g,
  /"([^"\n]{3,200})"/g,
  /'([^'\n]{3,200})'/g,
  /\u2018([^\u2019\n]{3,200})\u2019/g,
  /\u201c([^\u201d\n]{3,200})\u201d/g,
  // A path or a filename: at least one dot-extension, optionally with directories.
  /\b([\w@.~-]*(?:\/[\w@.~-]+)*\/?[\w@~-]+\.[A-Za-z][\w]{0,9})\b/g,
];

export const referencesIn = (text: string): string[] => {
  const out = new Set<string>();
  for (const re of REFERENCE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const token = (m[1] ?? '').trim();
      if (token.length >= 3) out.add(token);
    }
  }
  return [...out];
};

/**
 * A reference resolves only when it appears verbatim in EXACTLY ONE candidate group. Two matches is an ambiguous
 * reference, not two answers, and zero is a dangling one -- neither is guessed at here. A dangling essential
 * referent is caught downstream by handoff_scope, which sees only the request and the mandatory layer.
 */
export const resolveReferences = (texts: readonly string[], candidates: readonly LeanGroup[]): Set<string> => {
  const resolved = new Set<string>();
  const tokens = new Set(texts.flatMap((t) => referencesIn(t)));
  for (const token of tokens) {
    const hits = candidates.filter((g) => g.text.includes(token));
    if (hits.length === 1 && hits[0]) resolved.add(hits[0].id);
  }
  return resolved;
};

interface Entry {
  raw: Record<string, unknown>;
  uuid: string | null;
}

/** Read the tail of the transcript under both bounds. `complete` says the whole file was read, not just its end. */
const readTail = (path: string, now: () => number, started: number): { text: string; bytes: number; complete: boolean } | null => {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, SOURCE_MAX_BYTES);
    if (now() - started >= SOURCE_MAX_MS) return null;
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, size - len + read);
      if (n <= 0) break;
      read += n;
      if (now() - started >= SOURCE_MAX_MS) return null;
    }
    return { text: buf.subarray(0, read).toString('utf8'), bytes: read, complete: len === size };
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* a descriptor that cannot be closed does not change the reading */
    }
  }
};

const parseEntries = (text: string, complete: boolean): Entry[] => {
  const lines = text.split('\n');
  // A tail read starts mid-line; that fragment is not a record.
  if (!complete && lines.length > 0) lines.shift();
  const out: Entry[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated final line is the normal case in a transcript being appended to.
      continue;
    }
    if (!isRecord(parsed)) continue;
    out.push({ raw: parsed, uuid: typeof parsed['uuid'] === 'string' ? parsed['uuid'] : null });
  }
  return out;
};

type Visible =
  | { kind: 'human'; text: string; uuid: string | null }
  | { kind: 'compact_summary'; text: string; uuid: string | null }
  | { kind: 'assistant'; text: string; uuid: string | null }
  | { kind: 'tool_result'; text: string; uuid: string | null };

const blockText = (block: Record<string, unknown>): string | null => {
  const type = block['type'];
  if (type === 'text' && typeof block['text'] === 'string') return block['text'];
  if (type === 'tool_use') {
    const name = typeof block['name'] === 'string' ? block['name'] : 'tool';
    // Arguments are the action: exact paths, edit anchors and code blocks live here and are never abbreviated.
    let args = '';
    try {
      args = JSON.stringify(block['input'] ?? null);
    } catch {
      args = 'null';
    }
    return `[tool_use ${name}] ${args}`;
  }
  if (type === 'tool_result') {
    const content = block['content'];
    const body =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(isRecord)
              .map((c) => (typeof c['text'] === 'string' ? c['text'] : ''))
              .join('\n')
          : '';
    // The failure qualifier travels with the result; a success line is never separated from the error beside it.
    return `[tool_result${block['is_error'] === true ? ' status=error' : ''}] ${body}`;
  }
  // `thinking` is hidden reasoning and unknown media is not text evidence; neither becomes source.
  return null;
};

/** One host record to at most one visible unit. Bookkeeping records (attachment, mode, atis-latch, ...) yield none. */
const visibleOf = (e: Entry): Visible | null => {
  const r = e.raw;
  if (r['isSidechain'] === true || r['isMeta'] === true) return null;
  const type = r['type'];
  const message = r['message'];
  if (type === 'user') {
    if (!isRecord(message)) return null;
    const content = message['content'];
    if (typeof content === 'string') {
      if (content.length === 0) return null;
      return r['isCompactSummary'] === true
        ? { kind: 'compact_summary', text: content, uuid: e.uuid }
        : { kind: 'human', text: content, uuid: e.uuid };
    }
    if (!Array.isArray(content)) return null;
    const blocks = content.filter(isRecord);
    // A tool_result arrives inside a user-type event. It is an observation, never a human instruction (ADR D4).
    const hasToolResult = blocks.some((b) => b['type'] === 'tool_result');
    const text = blocks.map(blockText).filter((t): t is string => t !== null).join('\n');
    if (text.length === 0) return null;
    return hasToolResult ? { kind: 'tool_result', text, uuid: e.uuid } : { kind: 'human', text, uuid: e.uuid };
  }
  if (type === 'assistant') {
    if (!isRecord(message) || !Array.isArray(message['content'])) return null;
    const text = message['content'].filter(isRecord).map(blockText).filter((t): t is string => t !== null).join('\n');
    return text.length === 0 ? null : { kind: 'assistant', text, uuid: e.uuid };
  }
  return null;
};

/**
 * The host's own lineage. Returns the index the active source starts at, or null when a boundary exists whose
 * preserved segment cannot be resolved -- an unknown boundary is native, never a heuristic reconstruction.
 */
const activeStart = (entries: Entry[]): { start: number; epoch: string } | null => {
  let boundary = -1;
  let boundaries = 0;
  for (let i = 0; i < entries.length; i++) {
    const r = entries[i]?.raw;
    if (r && r['type'] === 'system' && r['subtype'] === 'compact_boundary') {
      boundary = i;
      boundaries += 1;
    }
  }
  if (boundary === -1) return { start: 0, epoch: 'uncompacted' };
  const meta = entries[boundary]?.raw['compactMetadata'];
  const segment = isRecord(meta) ? meta['preservedSegment'] : null;
  if (!isRecord(segment)) return null;
  const headUuid = segment['headUuid'];
  const anchorUuid = segment['anchorUuid'];
  if (typeof headUuid !== 'string' || typeof anchorUuid !== 'string') return null;
  const head = entries.findIndex((e) => e.uuid === headUuid);
  const anchor = entries.findIndex((e) => e.uuid === anchorUuid);
  // The summary anchor must be in hand: without it the mandatory layer cannot be established.
  if (head === -1 || anchor === -1) return null;
  return { start: Math.min(head, anchor), epoch: `${boundaries}:${anchorUuid}` };
};

export interface LeanSourceDeps {
  now?: () => number;
}

/**
 * Build the effective source for one request. `request` is the hook's own prompt field: the current user text enters
 * the packet exactly once from here, and any transcript copy of it is dropped rather than carried a second time.
 */
export const readLeanSource = (path: string | null | undefined, request: string, deps: LeanSourceDeps = {}): LeanSourceOutcome => {
  const now = deps.now ?? Date.now;
  const started = now();
  const fail = (reason: 'source_unavailable' | 'source_lineage_unknown' | 'source_bounded', bytesRead = 0): LeanSourceOutcome => ({
    ok: false,
    reason,
    bytesRead,
    durationMs: now() - started,
  });
  if (typeof path !== 'string' || path.length === 0) return fail('source_unavailable');
  const tail = readTail(path, now, started);
  if (tail === null) return fail('source_unavailable');

  const entries = parseEntries(tail.text, tail.complete);
  const lineage = activeStart(entries);
  if (lineage === null) return fail('source_lineage_unknown', tail.bytes);
  // A partial read that found no compaction cannot establish the mandatory layer: earlier human turns are out of view.
  if (!tail.complete && lineage.epoch === 'uncompacted') return fail('source_bounded', tail.bytes);

  const active = entries.slice(lineage.start);
  const visible: Visible[] = [];
  for (const e of active) {
    const v = visibleOf(e);
    if (v !== null) visible.push(v);
  }

  // The current request is the boundary of the observed prefix. Everything after it is this turn's own appends,
  // which must not invalidate the packet; a human turn after it is a new instruction, which must.
  let requestIdx = visible.length;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i]?.kind === 'human' && visible[i]?.text === request) {
      requestIdx = i;
      break;
    }
  }
  const newerHumanText = visible.slice(requestIdx + 1).some((v) => v.kind === 'human');
  const prefix = visible.slice(0, requestIdx);
  const prefixDigest = sha256(prefix.map((v) => `${v.kind}\u0000${v.uuid ?? ''}\u0000${sha256(v.text)}`).join('\n'));

  // Group: one assistant action with the results and qualification that belong to it. Breaking at the next assistant
  // turn keeps an action, its result and its failure note in one unit, which is what Jev classifies as a whole.
  // Grouped in one chronological sequence: a constraint stated after an observation must still read after it.
  const sequence: LeanGroup[] = [];
  let open: { texts: string[]; refs: string[] } | null = null;
  const closeOpen = (): void => {
    if (open === null) return;
    sequence.push({ id: '', origin: 'assistant_tool', text: open.texts.join('\n'), sourceRefs: open.refs, mandatory: false });
    open = null;
  };
  for (const v of prefix) {
    if (v.kind === 'assistant') {
      closeOpen();
      open = { texts: [v.text], refs: v.uuid ? [v.uuid] : [] };
      continue;
    }
    if (v.kind === 'tool_result') {
      // An unmatched result stays with the action it followed rather than being spliced into an event of its own.
      if (open === null) open = { texts: [], refs: [] };
      open.texts.push(v.text);
      if (v.uuid) open.refs.push(v.uuid);
      continue;
    }
    closeOpen();
    sequence.push({ id: '', origin: v.kind, text: v.text, sourceRefs: v.uuid ? [v.uuid] : [], mandatory: true });
  }
  closeOpen();

  // Only identical event identity collapses. Identical text observed at a different record is a different observation.
  const seenRefs = new Set<string>();
  const deduped = sequence.filter((g) => {
    if (g.mandatory) return true;
    const key = g.sourceRefs.join(',');
    if (key.length === 0) return true;
    if (seenRefs.has(key)) return false;
    seenRefs.add(key);
    return true;
  });

  // Withheld and unenumerated groups are counted, never reclassified as irrelevant.
  let unassessed = 0;
  const safe = deduped.filter((g) => {
    if (g.mandatory || !looksSecret(g.text)) return true;
    unassessed += 1;
    return false;
  });
  const optionalCount = safe.filter((g) => !g.mandatory).length;
  const keepFrom = Math.max(0, optionalCount - MAX_OPTIONAL_GROUPS);
  let seenOptional = 0;
  const enumerated = safe.filter((g) => {
    if (g.mandatory) return true;
    return seenOptional++ >= keepFrom;
  });
  unassessed += keepFrom;

  let mandatorySeq = 0;
  let optionalSeq = 0;
  const identified: LeanGroup[] = enumerated.map((g) => ({ ...g, id: g.mandatory ? `m${++mandatorySeq}` : `g${++optionalSeq}` }));

  /**
   * An exact reference in the request or in an active human turn -- a backticked span, a quoted string, a path --
   * that resolves to exactly one candidate makes that whole group mandatory. It cannot then be omitted, and
   * `handoff_scope` may rely on it. An ambiguous or dangling reference promotes nothing.
   */
  const humanTexts = [request, ...identified.filter((g) => g.origin === 'human').map((g) => g.text)];
  const referenced = resolveReferences(humanTexts, identified.filter((g) => !g.mandatory));
  const groups: LeanGroup[] = identified.map((g) => (referenced.has(g.id) ? { ...g, mandatory: true } : g));

  return {
    ok: true,
    source: {
      request,
      groups,
      epoch: lineage.epoch,
      prefixDigest,
      newerHumanText,
      coverage: tail.complete && unassessed === 0 ? 'complete' : 'partial',
      unassessed,
      bytesRead: tail.bytes,
      durationMs: now() - started,
    },
  };
};

export const mandatoryGroups = (s: LeanSource): LeanGroup[] => s.groups.filter((g) => g.mandatory);
export const optionalGroups = (s: LeanSource): LeanGroup[] => s.groups.filter((g) => !g.mandatory);
