import { sha256Hex } from './source.js';
import { LIMITS, type EvidenceMode } from './types.js';

/** A file as read: its whole text and the hash of its bytes. */
export interface SourceFile {
  path: string;
  text: string;
  sha256: string;
}

/** A window of whole lines; `text` is the exact slice of the file, line endings and any BOM included. */
export interface Candidate {
  path: string;
  startLine: number;
  endLine: number;
  fileSha256: string;
  text: string;
}

export interface CandidateSet {
  candidates: Candidate[];
  /** Lines that alone exceed a window: named, never returned in part. */
  longLines: Array<{ path: string; line: number }>;
  /** The candidate bound stopped enumeration. */
  capped: boolean;
}

/** Offsets of each line's first character, plus the end: line i (1-based) is text.slice(starts[i-1], starts[i]). */
export const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  if (starts[starts.length - 1] !== text.length) starts.push(text.length);
  return starts;
};

export const sliceLines = (text: string, starts: readonly number[], start: number, end: number): string => text.slice(starts[start - 1], starts[end]);

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'what', 'where', 'when', 'which', 'how', 'why', 'does',
  'not', 'are', 'was', 'were', 'has', 'have', 'its', 'can', 'will', 'should', 'would', 'there', 'their', 'then',
  'than', 'about', 'code', 'file', 'files', 'find', 'show', 'use', 'used', 'using',
]);
const WORD = /[\p{L}\p{N}_$]+/gu;
/** `parseHTTPRequest_body` → parse, http, request, body. */
const splitIdentifier = (w: string): string[] =>
  w
    .split(/_+|\$+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u)
    .map((p) => p.toLowerCase())
    .filter(Boolean);
const meaningful = (t: string): boolean => (/^[\x00-\x7f]*$/.test(t) ? t.length >= 3 : t.length >= 2) && !STOPWORDS.has(t);

/**
 * The lexical terms of a locate search and their weights: a caller's queryTerm whole (3), a word of the goal or of a
 * queryTerm (2), a part of a compound identifier (1). This one small function is the whole ranking policy.
 */
export const searchTerms = (goal: string, queryTerms: readonly string[]): Map<string, number> => {
  const terms = new Map<string, number>();
  const add = (t: string, w: number): void => {
    if (meaningful(t) && (terms.get(t) ?? 0) < w) terms.set(t, w);
  };
  for (const q of queryTerms) add(q.trim().toLowerCase(), 3);
  for (const source of [goal, ...queryTerms]) {
    for (const [word] of source.matchAll(WORD)) {
      add(word.toLowerCase(), 2);
      for (const p of splitIdentifier(word)) add(p, 1);
    }
  }
  return terms;
};

/** Byte length of each line, for the window bound; `lineBytes[i]` is line i+1. */
const lineByteLengths = (text: string, starts: readonly number[]): number[] =>
  starts.slice(1).map((end, i) => Buffer.byteLength(text.slice(starts[i], end), 'utf8'));

interface Windowing {
  file: SourceFile;
  starts: number[];
  bytes: number[];
}
const windowing = (file: SourceFile): Windowing => {
  const starts = lineStarts(file.text);
  return { file, starts, bytes: lineByteLengths(file.text, starts) };
};
const lineCount = (w: Windowing): number => w.starts.length - 1;
const rangeBytes = (w: Windowing, start: number, end: number): number => {
  let n = 0;
  for (let i = start; i <= end; i++) n += w.bytes[i - 1]!;
  return n;
};
const candidate = (w: Windowing, start: number, end: number): Candidate => ({
  path: w.file.path,
  startLine: start,
  endLine: end,
  fileSha256: w.file.sha256,
  text: sliceLines(w.file.text, w.starts, start, end),
});

/**
 * Windows around hit lines: each opens `lead` lines before its first uncovered hit and runs to at most `span` lines
 * and 8 KiB, shrinking from the side away from the hit. Windows never overlap. A hit line too long for any window is
 * reported, not cut.
 */
const windowsAround = (w: Windowing, hits: readonly number[], set: CandidateSet, span: number = LIMITS.windowLines, lead = 8): Candidate[] => {
  const out: Candidate[] = [];
  let covered = 0;
  const n = lineCount(w);
  for (const h of hits) {
    if (h <= covered) continue;
    if (w.bytes[h - 1]! > LIMITS.windowBytes) {
      set.longLines.push({ path: w.file.path, line: h });
      covered = h;
      continue;
    }
    let start = Math.max(1, covered + 1, h - lead);
    let end = Math.min(n, start + span - 1);
    while (rangeBytes(w, start, end) > LIMITS.windowBytes) {
      if (end > h) end--;
      else start++;
    }
    out.push(candidate(w, start, end));
    covered = end;
  }
  return out;
};

/** Every line in reading order, in consecutive windows: nothing is left out for not matching the query. */
const windowsAll = (w: Windowing, set: CandidateSet): Candidate[] => {
  const out: Candidate[] = [];
  const n = lineCount(w);
  let start = 1;
  while (start <= n) {
    if (w.bytes[start - 1]! > LIMITS.windowBytes) {
      set.longLines.push({ path: w.file.path, line: start });
      start++;
      continue;
    }
    let end = Math.min(n, start + LIMITS.windowLines - 1);
    while (rangeBytes(w, start, end) > LIMITS.windowBytes) end--;
    out.push(candidate(w, start, end));
    start = end + 1;
  }
  return out;
};

const hitLines = (w: Windowing, matches: (line: string) => boolean): number[] => {
  const hits: number[] = [];
  for (let i = 1; i <= lineCount(w); i++) if (matches(sliceLines(w.file.text, w.starts, i, i))) hits.push(i);
  return hits;
};

export interface CandidateQuery {
  mode: EvidenceMode;
  goal: string;
  queryTerms: readonly string[];
  exactSymbols: readonly string[];
}

/**
 * The deterministic candidate order every page is cut from. audit: every window of every file in path order.
 * exact: windows around literal, case-sensitive occurrences, in path order. locate: windows around term hits,
 * ranked by the weight of the distinct terms they hold (and their path holds), ties in path and line order.
 */
export const buildCandidates = (files: readonly SourceFile[], query: CandidateQuery): CandidateSet => {
  const set: CandidateSet = { candidates: [], longLines: [], capped: false };
  const push = (cs: Candidate[]): void => {
    for (const c of cs) {
      if (set.candidates.length >= LIMITS.candidates) {
        set.capped = true;
        return;
      }
      set.candidates.push(c);
    }
  };
  if (query.mode === 'audit') {
    for (const f of files) {
      push(windowsAll(windowing(f), set));
      if (set.capped) break;
    }
    return set;
  }
  if (query.exactSymbols.length > 0) {
    for (const f of files) {
      const w = windowing(f);
      push(windowsAround(w, hitLines(w, (line) => query.exactSymbols.some((s) => line.includes(s))), set, LIMITS.exactWindowLines, 3));
      if (set.capped) break;
    }
    return set;
  }
  const terms = [...searchTerms(query.goal, query.queryTerms)];
  if (terms.length === 0) return set;
  const scored: Array<{ c: Candidate; score: number }> = [];
  for (const f of files) {
    const w = windowing(f);
    const lower = f.path.toLowerCase();
    const pathScore = terms.reduce((n, [t]) => n + (lower.includes(t) ? 1 : 0), 0);
    const hit = (line: string): boolean => {
      const l = line.toLowerCase();
      return terms.some(([t]) => l.includes(t));
    };
    for (const c of windowsAround(w, hitLines(w, hit), set)) {
      const text = c.text.toLowerCase();
      scored.push({ c, score: pathScore + terms.reduce((n, [t, weight]) => n + (text.includes(t) ? weight : 0), 0) });
    }
  }
  // Stable: files arrive in byte order and windows in line order, so equal scores keep that order.
  scored.sort((a, b) => b.score - a.score);
  push(scored.map((s) => s.c));
  return set;
};

export interface SnapshotInput {
  projectRoot: string;
  scope: readonly string[];
  excludeGlobs: readonly string[];
  query: CandidateQuery;
  constraints: readonly string[];
  inventoryComplete: boolean;
  /** Anything that bounded what was read: a cap, a skipped file, the deadline. */
  incomplete: readonly string[];
  files: ReadonlyArray<{ path: string; sha256: string }>;
  candidates: readonly Candidate[];
}

/** What a continuation must reproduce exactly. Page size and position are views of the same set, so they are left out. */
export const snapshotId = (s: SnapshotInput): string =>
  sha256Hex(
    JSON.stringify([
      'jev-evidence-candidates-1',
      s.projectRoot,
      s.scope,
      s.excludeGlobs,
      s.query.mode,
      s.query.goal,
      s.constraints,
      s.query.queryTerms,
      s.query.exactSymbols,
      s.inventoryComplete,
      s.incomplete,
      s.files.map((f) => [f.path, f.sha256]),
      s.candidates.map((c) => [c.path, c.startLine, c.endLine]),
    ]),
  );
