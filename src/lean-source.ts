import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';

import type { SkipCode } from './types.js';

/**
 * JGL-03: the effective root history, as the installed host actually records it.
 *
 * Host facts this relies on (Claude Code 2.1.27x–2.1.28x transcripts, read from 89 real files and from the installed
 * binary on 2026-09-25; each is a fact about that host, not a guarantee about the next one):
 *  - Records form a tree through `parentUuid`. The conversation is the chain from the newest user/assistant record
 *    back to a record with a null parent. Records off that chain are an abandoned branch (a rewind), except two
 *    kinds the host puts back itself: another record of the same assistant response (`message.id`), and a tool
 *    result whose `tool_use_id` names a call in the chain. Parallel calls produce exactly those.
 *  - A compaction writes `system/compact_boundary` with `compactMetadata.preservedMessages {anchorUuid, uuids}`
 *    (or a `preservedSegment {headUuid, anchorUuid, tailUuid}` walked tail to head). The host relinks: the first
 *    preserved record hangs off the summary anchor, each preserved record off the one before it, anything that hung
 *    off the anchor moves to the last preserved record, and every record before the last boundary that is not
 *    preserved is deleted. This file does the same, and declines where the host would have had to give up.
 *  - A human turn is a user record with `origin.kind === "human"` (or `promptSource === "sdk"` in `-p` sessions),
 *    or a `queued_command` attachment whose `origin.kind` is `human`: text typed while a turn was running arrives
 *    that way, with no user record of its own. Tool results, task notifications, peer messages and `isMeta` records
 *    also arrive in user envelopes and are none of them the user's words.
 *  - Every record of a turn that has a prompt identity carries it as `promptId`, the same value hooks receive as
 *    `prompt_id`. Assistant records and attachments carry none.
 *
 * Unknown is never empty. A record form this file has not seen, a complete record that does not decode, a lineage
 * it cannot resolve, and a history larger than the read bound all return a reason, and the caller stays native.
 */

/** Bounded twice, like src/depth.ts: a hook that blocks is worse than a hook that does not know the history. */
export const SOURCE_MAX_BYTES = 8 * 1024 * 1024;
/** One deadline for the whole local pass -- open, read, decode, parse, relink, group -- not only the read loop. */
export const SOURCE_MAX_MS = 400;
/** Enumerate this many of the newest complete optional groups; older ones are counted, never called irrelevant. */
export const MAX_OPTIONAL_GROUPS = 24;

/**
 * `observation` is anything visible to the model that neither the user nor this conversation's assistant wrote: a
 * host or hook message, a peer agent's message, a notification with no call in view, local command output.
 */
export type GroupOrigin = 'human' | 'compact_summary' | 'assistant_tool' | 'observation';

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

/** What was in view and not carried, kept apart because each is a different fact (L7). None of it is a judgment. */
export interface SourceExclusions {
  /** Optional groups withheld whole because they look like they carry a credential. */
  secret: number;
  /** Optional groups older than the newest MAX_OPTIONAL_GROUPS. */
  window: number;
  /** Tool results and notifications whose call is not in the active source, so they cannot be attributed. */
  unattributed: number;
}

export interface LeanSource {
  /** The exact current user text, carried once. Taken from the hook event, never re-derived from the transcript. */
  request: string;
  groups: LeanGroup[];
  /** Compaction lineage. Changes when the host compacts, which invalidates a pending packet. */
  epoch: string;
  /** sha256 over the observed units BEFORE the current request. Ordinary appends for this request do not move it. */
  prefixDigest: string;
  /** A human turn after the current request: a new instruction, which invalidates a pending packet. */
  newerHumanText: boolean;
  /** Whether the current request's own record was found, by prompt identity, in the active source. */
  requestRecorded: boolean;
  coverage: 'complete' | 'partial';
  /** Sum of `excluded`: complete optional groups in view that were not enumerated. */
  unassessed: number;
  excluded: SourceExclusions;
  /** Host context records in the active source that are not conversation and are not carried (reminders, hooks...). */
  hostContext: number;
  /** User/assistant records on an abandoned branch: present in the file, absent from the conversation. */
  abandoned: number;
  bytesRead: number;
  durationMs: number;
}

export type LeanSourceReason = Extract<
  SkipCode,
  | 'source_unavailable'
  | 'source_lineage_unknown'
  | 'source_bounded'
  | 'source_corrupt'
  | 'source_incomplete'
  | 'source_unsupported'
  | 'source_identity_mismatch'
>;

export type LeanSourceOutcome =
  | { ok: true; source: LeanSource }
  | { ok: false; reason: LeanSourceReason; detail: string; bytesRead: number; durationMs: number };

/**
 * The request this source is read for. `phase: "dispatch"` is the PreToolUse re-read: by then the host has written
 * the request's own record, and a source that does not contain it is not the conversation the packet was built for.
 */
export interface LeanSourceBinding {
  request: string;
  promptId: string;
  sessionId: string;
  phase: 'prompt' | 'dispatch';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Best-effort local screening of conventional credential shapes, applied to the ORIGINAL string before any JSON
 * escaping. This is a guard against the obvious, not a privacy guarantee and not universal detection: private
 * non-secret source still leaves the machine when lean is explicitly enabled.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // A quoted value, or a long unbroken token. `password = readPassword();` is a call, not a credential.
  /\b(?:authorization|api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*(?:["'`][^"'`\s]{12,}["'`]|[A-Za-z0-9_\-./+=]{16,})/i,
  // `Authorization: Bearer <value>` in any header syntax -- `: `, `=`, an object key, a subscript assignment, a call
  // argument -- so up to eight punctuation characters sit between the word and the scheme. Any literal value counts,
  // however short (`Basic dTpw` is a whole credential), including one reached through a constant template expression
  // (`${'dTpw'}`) or a literal concatenation (`'Basic ' + 'dTpw'`). A name or a placeholder does not (`$TOKEN`,
  // `${token}`, `'Bearer ' + token`, `<token>`, `{{token}}`, `%TOKEN%`): none starts with a token character or a quote.
  // Prose that puts a word there ("Authorization: Bearer header") is screened too. One line break may sit in that
  // punctuation, because a call's arguments are often wrapped (`headers.set("Authorization",\n  "Basic dTpw")`), and
  // whitespace does not count toward the eight: indentation and column alignment run far wider, so each gap has its
  // own bound of 64. Whitespace and punctuation are disjoint classes, so the repetition cannot backtrack. `[ \t]` was
  // rejected for the gaps: the class it replaces matched a no-break space, and `Authorization:\u00a0Basic` must screen.
  /\bauthorization\b(?:[^\S\n]{0,64}[^\w\s]){0,8}[^\S\n]{0,64}(?:\n(?:[^\S\n]{0,64}[^\w\s]){0,8}[^\S\n]{0,64})?(?:bearer|basic|token)\s+(?:["'`]\s*\+\s*["'`]|\$\{\s*["'`])?[A-Za-z0-9_\-.~+/]+/i,
  // A Basic credential encoded at run time from a literal `user:password`; a template with a `${...}` in it is names.
  /\b(?:btoa|Buffer\.from)\(\s*["'`][^"'`\n:${]{0,256}:[^"'`\n${]{1,256}["'`]/,
  // A password in a URL's userinfo (`postgres://user:secret@host`), percent-encoded or not (`%40secret`). A
  // placeholder is a name: `${PASS}`, `<pass>`, `{pass}`, `%PASS%`, and a `%` that starts no escape (`%s`, `%(pw)s`).
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/?#@:"'`]{1,64}:(?![$<{]|%(?![0-9A-Fa-f]{2})|%[A-Za-z_]\w*%@)[^\s/?#@"'`]{1,128}@/i,
  // A bearer token outside a header line, whatever its prefix. The digit keeps "bearer" in prose from matching.
  /\b[Bb]earer\s+(?=[A-Za-z0-9_\-.~+/]*\d)[A-Za-z0-9_\-.~+/]{16,}/,
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
  /‘([^’\n]{3,200})’/g,
  /“([^”\n]{3,200})”/g,
];

/** A path or a filename: at least one dot-extension, optionally with directories. */
const PATH_REFERENCE = /\b([\w@.~-]*(?:\/[\w@.~-]+)*\/?[\w@~-]+\.[A-Za-z][\w]{0,9})\b/g;
/** Every character PATH_REFERENCE can match, so none of its matches crosses anything outside one of these runs. */
const PATH_RUN = /[\w@.~/-]+/g;
/**
 * PATH_REFERENCE backtracks quadratically over one long run of word characters, and a pasted log line or minified
 * source is such a run: 70 KiB of it took 2.5 s against the 400 ms source bound. Searching run by run finds the same
 * matches; a run longer than this is not a path anyone names in a request, and is not searched.
 */
const PATH_RUN_MAX = 512;

/**
 * Matches and runs between two reads of the caller's clock. The clock is also read before every pass, so the longest
 * unread stretch is one linear pass over one text: 16 ms at SOURCE_MAX_BYTES (8 MiB with no match, 2026-09-25).
 */
const CLOCK_EVERY = 16;

export const referencesIn = (text: string, tick?: () => void): string[] => {
  const out = new Set<string>();
  let units = 0;
  const unit = (): void => {
    if (tick && ++units % CLOCK_EVERY === 0) tick();
  };
  const add = (m: RegExpMatchArray): void => {
    const token = (m[1] ?? '').trim();
    if (token.length >= 3) out.add(token);
  };
  for (const re of REFERENCE_PATTERNS) {
    tick?.();
    for (const m of text.matchAll(re)) {
      unit();
      add(m);
    }
  }
  tick?.();
  for (const [run] of text.matchAll(PATH_RUN)) {
    unit();
    if (run.length <= PATH_RUN_MAX && run.includes('.')) {
      // The one scan that can be quadratic in its run, so the clock is read before every one.
      tick?.();
      for (const m of run.matchAll(PATH_REFERENCE)) add(m);
    }
  }
  return [...out];
};

/**
 * A reference resolves only when it appears verbatim in EXACTLY ONE candidate. Two matches is an ambiguous
 * reference, not two answers, and zero is a dangling one -- neither is guessed at here. A dangling essential
 * referent is caught downstream by handoff_scope, which sees only the request and the mandatory layer.
 *
 * The candidates must be the whole inventory in view, before any group is withheld or cut by the window (L4): a
 * reference resolved against what survived eviction can look unique when it was not, or miss what it named.
 */
export const resolveReferences = <G extends { text: string }>(
  texts: readonly string[],
  candidates: readonly G[],
  /**
   * The caller's bound has to reach every unit of work in here: it is called before each text is read, every
   * CLOCK_EVERY matches or runs within it, before each path run is matched and before each candidate is searched.
   */
  tick?: () => void,
): Set<G> => {
  const resolved = new Set<G>();
  const tokens = new Set<string>();
  for (const t of texts) {
    tick?.();
    for (const r of referencesIn(t, tick)) tokens.add(r);
  }
  for (const token of tokens) {
    let hit: G | null = null;
    let hits = 0;
    for (const g of candidates) {
      tick?.();
      if (!g.text.includes(token)) continue;
      hit = g;
      if (++hits > 1) break;
    }
    if (hits === 1 && hit) resolved.add(hit);
  }
  return resolved;
};

// ------------------------------------------------------------------------------------------------ reading

interface SourceFailure {
  reason: LeanSourceReason;
  detail: string;
}
const FAILURE = Symbol('lean-source-failure');
type FailureError = Error & { [FAILURE]: SourceFailure };
/** Every local decline leaves through here, so a deep check cannot forget to return its reason. */
const fail = (reason: LeanSourceReason, detail: string): never => {
  throw Object.assign(new Error(detail), { [FAILURE]: { reason, detail } });
};
const failureOf = (e: unknown): SourceFailure | null => (e instanceof Error && FAILURE in e ? (e as FailureError)[FAILURE] : null);

interface Clock {
  now: () => number;
  deadline: number;
}
const checkClock = (clock: Clock): void => {
  if (clock.now() > clock.deadline) fail('source_bounded', 'the local time bound ran out before the source was established');
};

/**
 * Read the tail of the transcript under both bounds. A FIFO or device opened here would block the hook, so the open
 * is non-blocking and anything that is not a regular file is refused before a byte is read.
 */
const readTail = (path: string, clock: Clock): { buf: Buffer; complete: boolean } => {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return fail('source_unavailable', 'the transcript could not be opened');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) fail('source_unavailable', 'the transcript is not a regular file');
    const size = st.size;
    const len = Math.min(size, SOURCE_MAX_BYTES);
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      checkClock(clock);
      const n = readSync(fd, buf, read, len - read, size - len + read);
      if (n <= 0) break;
      read += n;
    }
    return { buf: buf.subarray(0, read), complete: len === size && read === len };
  } catch (e) {
    if (failureOf(e)) throw e;
    return fail('source_unavailable', 'the transcript could not be read');
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* a descriptor that cannot be closed does not change the reading */
    }
  }
};

const DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Complete records only. A tail read starts inside a record, so everything up to the first newline is dropped; an
 * unterminated last line is a record the host is still writing, so it is left out rather than parsed, and reported
 * as `partialTail` so a caller that cannot tell what it held can decline. Anything between those two edges is a
 * complete record, and one that does not decode or parse is corruption, not noise: silently skipping it could
 * delete a user constraint.
 */
const parseRecords = (
  buf: Buffer,
  complete: boolean,
  clock: Clock,
): { records: Record<string, unknown>[]; truncatedHead: boolean; partialTail: boolean } => {
  let start = 0;
  if (!complete) {
    const first = buf.indexOf(0x0a);
    if (first === -1) return { records: [], truncatedHead: true, partialTail: buf.length > 0 };
    start = first + 1;
  }
  const last = buf.lastIndexOf(0x0a);
  const partialTail = buf.length > 0 && buf[buf.length - 1] !== 0x0a;
  if (last < start) return { records: [], truncatedHead: !complete, partialTail };
  let text = '';
  try {
    text = DECODER.decode(buf.subarray(start, last));
  } catch {
    fail('source_corrupt', 'a complete record is not valid UTF-8');
  }
  const records: Record<string, unknown>[] = [];
  let n = 0;
  for (const line of text.split('\n')) {
    if ((n += 1) % 512 === 0) checkClock(clock);
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return fail('source_corrupt', 'a complete record is not valid JSON');
    }
    if (!isRecord(parsed)) return fail('source_corrupt', 'a complete record is not an object');
    records.push(parsed);
  }
  return { records, truncatedHead: !complete, partialTail };
};

// ------------------------------------------------------------------------------------------------ lineage

/** The record types that take part in the conversation tree. Everything else in the file is host bookkeeping. */
const TREE_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);

interface Node {
  uuid: string;
  parent: string | null;
  raw: Record<string, unknown>;
  /** Position in the file, which is write order. */
  index: number;
}

const isBoundary = (r: Record<string, unknown>): boolean => r['type'] === 'system' && r['subtype'] === 'compact_boundary';
const messageId = (r: Record<string, unknown>): string | null => {
  const m = r['message'];
  return isRecord(m) && typeof m['id'] === 'string' ? m['id'] : null;
};
const contentOf = (r: Record<string, unknown>): unknown => (isRecord(r['message']) ? r['message']['content'] : undefined);

const toolUseIds = (r: Record<string, unknown>): string[] => {
  const content = contentOf(r);
  if (r['type'] !== 'assistant' || !Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap((b) => (b['type'] === 'tool_use' && typeof b['id'] === 'string' ? [b['id']] : []));
};
const toolResultIds = (r: Record<string, unknown>): string[] => {
  const content = contentOf(r);
  if (r['type'] !== 'user' || !Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap((b) => (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string' ? [b['tool_use_id']] : []));
};

interface Lineage {
  /** The active conversation, oldest first, including the records the host restores beside the chain. */
  active: Node[];
  epoch: string;
  anchor: string | null;
  abandoned: number;
}

interface Preserved {
  anchor: string;
  uuids: string[];
}

/** The preserved lineage a boundary names: the listed form when present, else the segment walked tail to head. */
const preservedOf = (boundary: Node, nodes: Map<string, Node>, truncatedHead: boolean): Preserved => {
  const meta = boundary.raw['compactMetadata'];
  if (!isRecord(meta)) return fail('source_lineage_unknown', 'the compaction boundary carries no metadata');
  const listed = meta['preservedMessages'];
  if (isRecord(listed)) {
    const uuids = listed['uuids'];
    const anchor = listed['anchorUuid'];
    if (typeof anchor !== 'string' || !Array.isArray(uuids) || !uuids.every((u): u is string => typeof u === 'string')) {
      return fail('source_lineage_unknown', 'the preserved message list is malformed');
    }
    /**
     * The list is taken as the host writes it: neither a parent chain nor write order. Of 97 real lists read on
     * 2026-09-25, 92 were not parent chains and 89 were not in write order, so checking either would decline valid
     * sessions. None repeated an identity; a repeat has no single position to relink, so it is not guessed at.
     */
    if (new Set(uuids).size !== uuids.length) return fail('source_lineage_unknown', 'the preserved message list repeats an identity');
    return { anchor, uuids };
  }
  const segment = meta['preservedSegment'];
  if (!isRecord(segment)) return fail('source_lineage_unknown', 'the compaction boundary names no preserved lineage');
  const { headUuid, anchorUuid, tailUuid } = segment;
  if (typeof headUuid !== 'string' || typeof anchorUuid !== 'string' || typeof tailUuid !== 'string') {
    return fail('source_lineage_unknown', 'the preserved segment is malformed');
  }
  const walked: string[] = [];
  const seen = new Set<string>();
  let cur = nodes.get(tailUuid);
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    walked.push(cur.uuid);
    if (cur.uuid === headUuid) break;
    cur = cur.parent ? nodes.get(cur.parent) : undefined;
  }
  if (walked.at(-1) !== headUuid) return fail(truncatedHead ? 'source_bounded' : 'source_lineage_unknown', 'the preserved segment does not walk from its tail to its head');
  return { anchor: anchorUuid, uuids: walked.reverse() };
};

/**
 * The host's own relink, then its own chain walk. Where the host would log `tengu_relink_walk_broken` and fall back,
 * this declines instead: an unresolved lineage is native, never a heuristic reconstruction.
 */
const resolveLineage = (records: Record<string, unknown>[], sessionId: string, truncatedHead: boolean, clock: Clock): Lineage => {
  const nodes = new Map<string, Node>();
  const serialized = new Map<string, string>();
  records.forEach((raw, index) => {
    if (typeof raw['type'] !== 'string' || !TREE_TYPES.has(raw['type'])) return;
    if (raw['isSidechain'] === true) return;
    const uuid = raw['uuid'];
    if (typeof uuid !== 'string' || uuid.length === 0) return fail('source_corrupt', 'a conversation record has no uuid');
    if (typeof raw['sessionId'] === 'string' && raw['sessionId'] !== sessionId) return fail('source_identity_mismatch', 'a record belongs to a different session');
    const parent = raw['parentUuid'];
    if (parent !== null && parent !== undefined && typeof parent !== 'string') return fail('source_corrupt', 'a record has a malformed parent');
    // Only an identical repeat collapses. The same event identity with different content is not deduplicated away.
    const text = JSON.stringify(raw);
    const seen = serialized.get(uuid);
    if (seen !== undefined) {
      if (seen !== text) fail('source_corrupt', 'one record identity appears with two different contents');
      return;
    }
    serialized.set(uuid, text);
    nodes.set(uuid, { uuid, parent: typeof parent === 'string' ? parent : null, raw, index });
  });
  checkClock(clock);

  // The last boundary in write order decides the lineage; an earlier one is history the host has already deleted.
  let boundary: Node | null = null;
  for (const n of nodes.values()) if (isBoundary(n.raw) && (boundary === null || n.index > boundary.index)) boundary = n;

  let anchor: string | null = null;
  let epoch = 'uncompacted';
  if (boundary !== null) {
    const preserved = preservedOf(boundary, nodes, truncatedHead);
    anchor = preserved.anchor;
    const anchorNode = nodes.get(anchor);
    if (!anchorNode || anchorNode.raw['type'] !== 'user' || anchorNode.raw['isCompactSummary'] !== true) {
      fail(truncatedHead ? 'source_bounded' : 'source_lineage_unknown', 'the compaction summary anchor is not in view');
    }
    const kept = preserved.uuids;
    if (kept.some((u) => !nodes.has(u))) fail(truncatedHead ? 'source_bounded' : 'source_lineage_unknown', 'a preserved record is not in view');

    // Relink exactly as the host does.
    const keep = new Set(kept);
    const lastKept = kept.at(-1);
    if (lastKept !== undefined) {
      let prev = anchor;
      for (const u of kept) {
        const n = nodes.get(u) as Node;
        nodes.set(u, { ...n, parent: prev });
        prev = u;
      }
      for (const [u, n] of nodes) if (n.parent === anchor && u !== kept[0]) nodes.set(u, { ...n, parent: lastKept });
    }
    const dropped = new Set<string>();
    for (const [u, n] of nodes) if (n.index < boundary.index && !keep.has(u)) dropped.add(u);
    for (const u of dropped) nodes.delete(u);
    if (lastKept !== undefined && dropped.size > 0) {
      for (const [u, n] of nodes) {
        if ((n.raw['type'] === 'user' || n.raw['type'] === 'assistant') && n.parent !== null && dropped.has(n.parent)) nodes.set(u, { ...n, parent: lastKept });
      }
    }
    epoch = `compact:${boundary.uuid}:${anchor}`;
  }
  checkClock(clock);

  // The newest user/assistant record is the leaf, as the host picks it; its ancestry is the conversation.
  let leaf: Node | null = null;
  for (const n of nodes.values()) {
    const t = n.raw['type'];
    if ((t === 'user' || t === 'assistant') && (leaf === null || n.index > leaf.index)) leaf = n;
  }
  if (leaf === null) {
    if (truncatedHead) fail('source_bounded', 'no conversation record is in view');
    return { active: [], epoch, anchor, abandoned: 0 };
  }

  const spine: Node[] = [];
  const onSpine = new Set<string>();
  let cur: Node | undefined = leaf;
  while (cur) {
    if (onSpine.has(cur.uuid)) fail('source_lineage_unknown', 'the parent chain has a cycle');
    onSpine.add(cur.uuid);
    spine.push(cur);
    if (cur.parent === null) break;
    const next = nodes.get(cur.parent);
    // A parent outside the window means the history continues beyond what was read.
    if (!next) fail(truncatedHead ? 'source_bounded' : 'source_lineage_unknown', 'the parent chain leaves the records in view');
    cur = next;
  }
  spine.reverse();
  if (boundary !== null && spine[0]?.uuid !== boundary.uuid) fail('source_lineage_unknown', 'the active chain does not start at the last compaction boundary');
  /**
   * Records written after the newest message hang off it until the next message is written: a message typed while
   * the turn ran, a notification, local command output. The live conversation already holds them, and dropping a
   * typed message would drop a user instruction, so the chain continues through them.
   */
  const tail = new Set([leaf.uuid]);
  for (const n of [...nodes.values()].sort((a, b) => a.index - b.index)) {
    if (n.index <= leaf.index || n.raw['type'] === 'user' || n.raw['type'] === 'assistant') continue;
    if (n.parent !== null && tail.has(n.parent)) {
      tail.add(n.uuid);
      onSpine.add(n.uuid);
      spine.push(n);
    }
  }

  // Put back what the host puts back: other records of an assistant response in the chain, and results of its calls.
  const included = new Set(onSpine);
  const spineMessages = new Set(spine.flatMap((n) => (n.raw['type'] === 'assistant' ? [messageId(n.raw)].filter((x): x is string => x !== null) : [])));
  const restored: Node[] = [];
  const offChain = [...nodes.values()].filter((n) => !onSpine.has(n.uuid)).sort((a, b) => a.index - b.index);
  for (const n of offChain) {
    if (n.raw['type'] !== 'assistant') continue;
    const id = messageId(n.raw);
    if (id !== null && spineMessages.has(id) && n.parent !== null && included.has(n.parent)) {
      included.add(n.uuid);
      restored.push(n);
    }
  }
  const calls = new Set([...included].flatMap((u) => toolUseIds((nodes.get(u) as Node).raw)));
  for (const n of offChain) {
    if (n.raw['type'] !== 'user') continue;
    const ids = toolResultIds(n.raw);
    if (ids.length > 0 && ids.every((id) => calls.has(id)) && n.parent !== null && included.has(n.parent)) {
      included.add(n.uuid);
      restored.push(n);
    }
  }
  const abandoned = offChain.filter((n) => !included.has(n.uuid) && (n.raw['type'] === 'user' || n.raw['type'] === 'assistant')).length;

  // Restored records go immediately after their parent, in write order among themselves.
  const after = new Map<string, Node[]>();
  for (const n of restored) {
    const key = n.parent as string;
    const list = after.get(key) ?? [];
    list.push(n);
    after.set(key, list);
  }
  const active: Node[] = [];
  const emit = (n: Node): void => {
    active.push(n);
    for (const child of after.get(n.uuid) ?? []) emit(child);
  };
  for (const n of spine) emit(n);
  checkClock(clock);
  return { active, epoch, anchor, abandoned };
};

// ------------------------------------------------------------------------------------------------ provenance

type Unit =
  | { kind: 'human'; text: string; ref: string; promptId: string | null }
  | { kind: 'compact_summary'; text: string; ref: string; promptId: string | null }
  | { kind: 'step'; message: string; text: string; ref: string; calls: string[]; promptId: null }
  | { kind: 'result'; call: string; text: string; ref: string; promptId: string | null }
  | { kind: 'notification'; call: string | null; text: string; ref: string; promptId: string | null }
  | { kind: 'interruption'; text: string; ref: string; promptId: string | null }
  | { kind: 'observation'; text: string; ref: string; promptId: string | null };

/**
 * Attachments that restate host context rather than conversation: reminders, environment and instruction files the
 * executor's own session loads for itself, hook output for events that already ran, file-change notices whose
 * subject is in the repository, and records the host never sends to the model at all. None of it is carried; all
 * of it is counted. An attachment type not on this list is a form this file has not seen, and is declined.
 */
const HOST_CONTEXT_ATTACHMENTS = new Set([
  'agent_listing_delta',
  'auto_mode',
  'auto_mode_exit',
  'command_permissions',
  'compact_file_reference',
  'credential_org',
  'date',
  'date_change',
  'deferred_tools_delta',
  'deferred_tools_record',
  'edited_text_file',
  'environment',
  'file',
  'goal_status',
  'hook_additional_context',
  'hook_blocking_error',
  'hook_cancelled',
  'hook_success',
  'inlined_image_paths',
  'instructions',
  'invoked_skills',
  'mcp_instructions_delta',
  'model',
  'plan_file_reference',
  'plan_mode',
  'plan_mode_exit',
  'prompt_render_point',
  'prompt_snapshot',
  'remote_session_change',
  'session_context',
  'silent_turn_reminder',
  'skill_listing',
  'task_reminder',
  'task_status',
  'thinking_drop',
  'thinking_stripped',
  'total_tokens_reminder',
]);

const INTERRUPTIONS = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);
/** Host-rendered records of a command the user typed, and of the output it produced. */
const COMMAND_INPUT = /^<(?:command-name|command-message|bash-input)>/;
const COMMAND_OUTPUT = /^<(?:local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/;
const NOTIFICATION_CALL = /<tool-use-id>([^<\s]+)<\/tool-use-id>/;

/** Text-only content, or null when any block is something other than text (an image, a document, ...). */
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

/** What stands in a result body for an image the packet cannot carry. */
const MEDIA_PLACEHOLDER = '[image not carried]';

/** A result body, exact. Media is named, never silently dropped: MEDIA_PLACEHOLDER says the gap is there. */
const resultBody = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  if (!Array.isArray(content)) return fail('source_unsupported', 'a tool result has a content form this file has not seen');
  return content
    .map((c): string => {
      if (!isRecord(c)) return fail('source_unsupported', 'a tool result has a content form this file has not seen');
      if (c['type'] === 'text' && typeof c['text'] === 'string') return c['text'];
      if (c['type'] === 'image') return MEDIA_PLACEHOLDER;
      if (c['type'] === 'tool_reference' && typeof c['tool_name'] === 'string') return `[tool_reference ${c['tool_name']}]`;
      return fail('source_unsupported', 'a tool result has a content block this file has not seen');
    })
    .join('\n');
};

const promptIdOf = (r: Record<string, unknown>): string | null => (typeof r['promptId'] === 'string' ? r['promptId'] : null);
const originKind = (v: unknown): string | null => (isRecord(v) && typeof v['kind'] === 'string' ? v['kind'] : null);

const attachmentUnits = (n: Node, promptId: string | null, counters: { hostContext: number }): Unit[] => {
  const a = n.raw['attachment'];
  const at = isRecord(a) ? a['type'] : undefined;
  if (isRecord(a) && at === 'queued_command') {
    const mode = a['commandMode'];
    const origin = originKind(a['origin']);
    const text = textOnly(a['prompt']);
    if (mode === 'task-notification') {
      if (text === null) return fail('source_unsupported', 'a queued notification is not text');
      return [{ kind: 'notification', call: NOTIFICATION_CALL.exec(text)?.[1] ?? null, text, ref: n.uuid, promptId }];
    }
    if (mode === 'prompt' && origin === 'human' && a['isMeta'] !== true) {
      // Typed while a turn was running. It has no user record of its own and it is the user's instruction.
      if (text === null) return fail('source_unsupported', 'a queued user message carries an image or attachment that is not carried');
      return [{ kind: 'human', text, ref: n.uuid, promptId }];
    }
    if (mode === 'prompt' && origin === 'peer') {
      if (text === null) return fail('source_unsupported', 'a queued peer message is not text');
      return [{ kind: 'observation', text, ref: n.uuid, promptId }];
    }
    return fail('source_unsupported', 'a queued command has a provenance this file has not seen');
  }
  if (typeof at === 'string' && HOST_CONTEXT_ATTACHMENTS.has(at)) {
    counters.hostContext += 1;
    return [];
  }
  return fail('source_unsupported', 'an attachment of a type this file has not seen is in the active source');
};

const assistantUnits = (n: Node): Unit[] => {
  const message = n.raw['message'];
  // A synthetic API error is never sent back to the model.
  if (n.raw['isApiErrorMessage'] === true && isRecord(message) && message['model'] === '<synthetic>') return [];
  const content = contentOf(n.raw);
  if (!Array.isArray(content)) return fail('source_unsupported', 'an assistant record has no content blocks');
  const texts: string[] = [];
  const calls: string[] = [];
  for (const b of content) {
    if (!isRecord(b)) return fail('source_unsupported', 'an assistant block is malformed');
    const bt = b['type'];
    if (bt === 'text' && typeof b['text'] === 'string') {
      texts.push(b['text']);
    } else if (bt === 'tool_use' && typeof b['id'] === 'string') {
      const name = typeof b['name'] === 'string' ? b['name'] : 'tool';
      // Arguments are the action: exact paths, edit anchors and code blocks live here and are never abbreviated.
      texts.push(`[tool_use ${name}] ${JSON.stringify(b['input'] ?? null) ?? 'null'}`);
      calls.push(b['id']);
    } else if (bt !== 'thinking' && bt !== 'redacted_thinking') {
      // Hidden reasoning is not source; anything else is a block this file has not seen.
      return fail('source_unsupported', 'an assistant block of a type this file has not seen is in the active source');
    }
  }
  if (texts.length === 0) return [];
  return [{ kind: 'step', message: messageId(n.raw) ?? `record:${n.uuid}`, text: texts.join('\n'), ref: n.uuid, calls, promptId: null }];
};

const userUnits = (n: Node, promptId: string | null, anchor: string | null): Unit[] => {
  const r = n.raw;
  const ref = n.uuid;
  const content = contentOf(r);

  if (r['isCompactSummary'] === true) {
    const text = textOnly(content);
    if (ref !== anchor || text === null) return fail('source_unsupported', 'a compact summary is not the anchor of the last compaction');
    return [{ kind: 'compact_summary', text, ref, promptId }];
  }

  if (Array.isArray(content) && content.some((b) => isRecord(b) && b['type'] === 'tool_result')) {
    // A tool result is an observation, never a human instruction (ADR D4). Text beside it has no known author.
    if (!content.every((b) => isRecord(b) && b['type'] === 'tool_result')) return fail('source_unsupported', 'a user envelope mixes tool results with other content');
    return content.filter(isRecord).map((block): Unit => {
      const call = block['tool_use_id'];
      if (typeof call !== 'string') return fail('source_corrupt', 'a tool result names no call');
      // The failure qualifier travels with the result; a success line is never separated from the error beside it.
      const text = `[tool_result${block['is_error'] === true ? ' status=error' : ''}] ${resultBody(block['content'])}`;
      return { kind: 'result', call, text, ref, promptId };
    });
  }

  if (r['isMeta'] === true) {
    // Host, hook, skill and scheduled messages: the model saw them; the user did not type them.
    const text = textOnly(content);
    if (text === null) return fail('source_unsupported', 'a host message carries content that is not text');
    return text.length === 0 ? [] : [{ kind: 'observation', text, ref, promptId }];
  }

  const origin = originKind(r['origin']);
  const text = textOnly(content);
  if (origin === 'human' || (origin === null && r['promptSource'] === 'sdk')) {
    // Attachment coverage is unknown: an image the user sent cannot be carried, and dropping it changes the request.
    if (text === null) return fail('source_unsupported', 'a user message carries an image or attachment that is not carried');
    return [{ kind: 'human', text, ref, promptId }];
  }
  if (origin === 'task-notification') {
    if (text === null) return fail('source_unsupported', 'a notification is not text');
    return [{ kind: 'notification', call: NOTIFICATION_CALL.exec(text)?.[1] ?? null, text, ref, promptId }];
  }
  if (origin === 'peer') {
    if (text === null) return fail('source_unsupported', 'a peer message is not text');
    return [{ kind: 'observation', text, ref, promptId }];
  }
  if (origin === null && r['promptSource'] === undefined && text !== null) {
    if (INTERRUPTIONS.has(text)) return [{ kind: 'interruption', text, ref, promptId }];
    if (COMMAND_INPUT.test(text)) return [{ kind: 'human', text, ref, promptId }];
    if (COMMAND_OUTPUT.test(text)) return [{ kind: 'observation', text, ref, promptId }];
  }
  return fail('source_unsupported', 'a user record has a provenance this file has not seen');
};

/** One host record to zero or more visible units. Unknown forms and unknown provenance are declined, not guessed. */
const unitsOf = (n: Node, anchor: string | null, counters: { hostContext: number }): Unit[] => {
  const promptId = promptIdOf(n.raw);
  const type = n.raw['type'];
  if (type === 'system') {
    // The host sends no system record to the model except local command output.
    const content = n.raw['content'];
    if (n.raw['subtype'] === 'local_command' && typeof content === 'string' && content.length > 0) return [{ kind: 'observation', text: content, ref: n.uuid, promptId }];
    return [];
  }
  if (type === 'attachment') return attachmentUnits(n, promptId, counters);
  if (type === 'assistant') return assistantUnits(n);
  return userUnits(n, promptId, anchor);
};

// ------------------------------------------------------------------------------------------------ grouping

interface Draft {
  origin: GroupOrigin;
  texts: string[];
  refs: string[];
  mandatory: boolean;
}

/**
 * Group by real identity: one assistant response with every result and notification that names its calls, and the
 * interruption that cut it short. Adjacency is not identity -- parallel calls interleave their results.
 */
const groupUnits = (prefix: readonly Unit[]): { drafts: Draft[]; unattributed: number } => {
  const drafts: Draft[] = [];
  const byMessage = new Map<string, Draft>();
  const byCall = new Map<string, Draft>();
  const resultText = new Map<string, string>();
  let lastStep: Draft | null = null;
  let unattributed = 0;
  const standalone = (u: Unit): void => {
    drafts.push({ origin: 'observation', texts: [u.text], refs: [u.ref], mandatory: false });
  };
  const attach = (d: Draft, u: Unit): void => {
    d.texts.push(u.text);
    d.refs.push(u.ref);
  };
  for (const u of prefix) {
    if (u.kind === 'human' || u.kind === 'compact_summary') {
      drafts.push({ origin: u.kind, texts: [u.text], refs: [u.ref], mandatory: true });
    } else if (u.kind === 'step') {
      let d = byMessage.get(u.message);
      if (!d) {
        d = { origin: 'assistant_tool', texts: [], refs: [], mandatory: false };
        byMessage.set(u.message, d);
        drafts.push(d);
      }
      attach(d, u);
      for (const c of u.calls) byCall.set(c, d);
      lastStep = d;
    } else if (u.kind === 'result') {
      const prior = resultText.get(u.call);
      if (prior !== undefined) {
        if (prior !== u.text) fail('source_corrupt', 'one call has two different results');
        continue;
      }
      resultText.set(u.call, u.text);
      const d = byCall.get(u.call);
      if (d) attach(d, u);
      else unattributed += 1;
    } else if (u.kind === 'notification') {
      const d = u.call === null ? undefined : byCall.get(u.call);
      if (d) attach(d, u);
      else if (u.call !== null) unattributed += 1;
      else standalone(u);
    } else if (u.kind === 'interruption') {
      if (lastStep) attach(lastStep, u);
      else standalone(u);
    } else {
      standalone(u);
    }
  }
  return { drafts, unattributed };
};

export interface LeanSourceDeps {
  now?: () => number;
}

/**
 * Build the effective source for one request. `binding.request` is the hook's own prompt field: the current user text
 * enters the packet exactly once from here, and its transcript record, found by prompt identity, is the boundary.
 */
export const readLeanSource = (path: string | null | undefined, binding: LeanSourceBinding, deps: LeanSourceDeps = {}): LeanSourceOutcome => {
  const now = deps.now ?? Date.now;
  const started = now();
  const clock: Clock = { now, deadline: started + SOURCE_MAX_MS };
  let bytesRead = 0;
  try {
    if (typeof path !== 'string' || path.length === 0) return fail('source_unavailable', 'no transcript path');
    // The host names a session's transcript after the session. A path that says otherwise is another conversation.
    if (basename(path) !== `${binding.sessionId}.jsonl`) return fail('source_identity_mismatch', 'the transcript is not this session’s');
    const tail = readTail(path, clock);
    bytesRead = tail.buf.length;
    const parsed = parseRecords(tail.buf, tail.complete, clock);
    /**
     * At the prompt nothing of this turn has been written yet except, possibly, the request itself, so a record still
     * being written could be a queued message or a constraint this turn needs; leaving it out would drop it unseen.
     * At dispatch the request's record is in place and the unfinished one is this turn's own later output.
     */
    if (parsed.partialTail && binding.phase === 'prompt') return fail('source_incomplete', 'the transcript ends inside a record still being written');
    const lineage = resolveLineage(parsed.records, binding.sessionId, parsed.truncatedHead, clock);

    const counters = { hostContext: 0 };
    const units: Unit[] = [];
    for (const n of lineage.active) units.push(...unitsOf(n, lineage.anchor, counters));
    checkClock(clock);

    // The request's own record, by identity. Text equality would bind a repeated `continue` to an older turn.
    const boundary = units.findIndex((u) => u.promptId === binding.promptId);
    if (boundary !== -1) {
      const own = units[boundary];
      // A compaction during this turn can drop the request's own record while later records of the turn survive.
      if (own?.kind !== 'human') return fail('source_identity_mismatch', 'the request’s own record is no longer in the active source');
      if (own.text !== binding.request) return fail('source_identity_mismatch', 'the record with this prompt identity is not this request');
    } else if (binding.phase === 'dispatch') {
      return fail('source_identity_mismatch', 'the current request is not recorded in the active source');
    }
    const prefix = boundary === -1 ? units : units.slice(0, boundary);
    const later = boundary === -1 ? [] : units.slice(boundary + 1);
    // A human turn after the request is a new instruction -- including one typed while this turn was running.
    const newerHumanText = later.some((u) => u.kind === 'human');
    const prefixDigest = sha256(prefix.map((u) => `${u.kind}\u0000${u.ref}\u0000${sha256(u.text)}`).join('\n'));

    const { drafts, unattributed } = groupUnits(prefix);
    const sequence = drafts.map((d) => ({ origin: d.origin, text: d.texts.join('\n'), sourceRefs: d.refs, mandatory: d.mandatory }));

    /**
     * An exact reference in the request or in an active human turn -- a backticked span, a quoted string, a path --
     * that resolves to exactly one optional group in the WHOLE inventory makes that group mandatory. It is then
     * neither withheld nor cut by the window: an unsafe one makes the source unsafe, which is native, and never a
     * silently dropped referent.
     */
    const humanTexts = [binding.request, ...sequence.filter((g) => g.origin === 'human').map((g) => g.text)];
    const referenced = resolveReferences(humanTexts, sequence.filter((g) => !g.mandatory), () => checkClock(clock));
    const promoted = sequence.map((g) => (referenced.has(g) ? { ...g, mandatory: true } : g));
    // An optional group may name the gap and still be omitted; required context that is missing its image is not whole.
    if (promoted.some((g) => g.mandatory && g.text.includes(MEDIA_PLACEHOLDER))) {
      return fail('source_unsupported', 'required context carries an image that is not carried');
    }

    // Withheld and unenumerated groups are counted, never reclassified as irrelevant.
    let secret = 0;
    const safe = promoted.filter((g) => {
      if (g.mandatory || !looksSecret(g.text)) return true;
      secret += 1;
      return false;
    });
    const optionalCount = safe.filter((g) => !g.mandatory).length;
    const window = Math.max(0, optionalCount - MAX_OPTIONAL_GROUPS);
    let seenOptional = 0;
    const enumerated = safe.filter((g) => g.mandatory || seenOptional++ >= window);

    let mandatorySeq = 0;
    let optionalSeq = 0;
    const groups: LeanGroup[] = enumerated.map((g) => ({ ...g, id: g.mandatory ? `m${++mandatorySeq}` : `g${++optionalSeq}` }));
    const unassessed = secret + window + unattributed;
    checkClock(clock);

    return {
      ok: true,
      source: {
        request: binding.request,
        groups,
        epoch: lineage.epoch,
        prefixDigest,
        newerHumanText,
        requestRecorded: boundary !== -1,
        coverage: unassessed === 0 ? 'complete' : 'partial',
        unassessed,
        excluded: { secret, window, unattributed },
        hostContext: counters.hostContext,
        abandoned: lineage.abandoned,
        bytesRead,
        durationMs: now() - started,
      },
    };
  } catch (e) {
    const failure = failureOf(e);
    if (failure) return { ok: false, reason: failure.reason, detail: failure.detail, bytesRead, durationMs: now() - started };
    // Anything unexpected is the same fact as an unreadable source: not known, so native.
    return { ok: false, reason: 'source_unavailable', detail: 'the source could not be established', bytesRead, durationMs: now() - started };
  }
};

export const mandatoryGroups = (s: LeanSource): LeanGroup[] => s.groups.filter((g) => g.mandatory);
export const optionalGroups = (s: LeanSource): LeanGroup[] => s.groups.filter((g) => !g.mandatory);
