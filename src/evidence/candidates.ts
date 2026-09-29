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
  /** The candidate bound stopped enumeration before the rest of the files were checked. */
  capped: boolean;
  /** Locate's unique lexical terms exceed the cap. No file text was scanned. */
  overflow: boolean;
  /** The request budget or the caller's signal stopped the scan. Null when the scan finished or never started. */
  stopped: 'deadline' | 'cancelled' | null;
  /** Files scanned to completion. A file left mid-way is not counted, and this is not a timestamp. */
  scannedFiles: number;
  /**
   * Peak sizes while collecting. `hits` is the current file only (the count is not kept across files); `windows` and
   * `scored` are the capped set, never the whole repository.
   */
  peaks: { hits: number; windows: number; scored: number };
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
 * The lexical terms of a locate search and their weights: a caller's queryTerm whole (3), a word of the lexical source
 * (2), a part of a compound identifier (1). Explicit `queryTerms` are the whole lexical source — the goal is not folded
 * back in, or the term cap could be bypassed. With no queryTerms the goal is the source, as before. This one small
 * function is the whole ranking policy.
 */
export const searchTerms = (goal: string, queryTerms: readonly string[]): Map<string, number> => {
  const terms = new Map<string, number>();
  const add = (t: string, w: number): void => {
    if (meaningful(t) && (terms.get(t) ?? 0) < w) terms.set(t, w);
  };
  const hinted = queryTerms.length > 0;
  if (hinted) for (const q of queryTerms) add(q.trim().toLowerCase(), 3);
  for (const source of hinted ? queryTerms : [goal]) {
    for (const [word] of source.matchAll(WORD)) {
      add(word.toLowerCase(), 2);
      for (const p of splitIdentifier(word)) add(p, 1);
    }
  }
  return terms;
};

/** Fixed input-error text. Narrowing roots does not change this cap, so it is not mentioned. */
export const LEXICAL_TERM_DETAIL = `this search has more than ${LIMITS.lexicalTerms} lexical terms; provide short queryTerms or narrow the question`;

export interface CandidateQuery {
  mode: EvidenceMode;
  goal: string;
  queryTerms: readonly string[];
  exactSymbols: readonly string[];
}

export interface LexicalPlan {
  /** Null for audit and exact lookups, which do not use goal words. */
  terms: Map<string, number> | null;
  overflow: boolean;
}

/** Term extraction only. Over the cap the map is not a search plan: callers must not keep the first 128. */
export const planLexical = (query: CandidateQuery): LexicalPlan => {
  if (query.mode === 'audit' || query.exactSymbols.length > 0) return { terms: null, overflow: false };
  const terms = searchTerms(query.goal, query.queryTerms);
  return { terms, overflow: terms.size > LIMITS.lexicalTerms };
};

/** Clock, cancel, and the event-loop turn shared by every candidate loop. Tests replace `yield`; nothing here is an MCP argument. */
export interface CandidateBudget {
  now: () => number;
  /** Absolute time on `now`. The request's existing search budget, never a fresh per-stage deadline. */
  until: number;
  signal: AbortSignal;
  yield: () => Promise<void>;
}

/** One turn of the event loop. A resolved promise would run as a microtask and starve timers and cancellation. */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** Steps between event-loop turns. A cooperative slice so a timer can run, not a measured optimum. */
const CHECKPOINT_UNITS = 256;

interface Run {
  budget: CandidateBudget;
  units: number;
  stopped: CandidateSet['stopped'];
  peaks: CandidateSet['peaks'];
}

const checkpoint = async (run: Run): Promise<boolean> => {
  run.units = 0;
  if (run.budget.signal.aborted) {
    run.stopped = 'cancelled';
    return false;
  }
  if (run.budget.now() >= run.budget.until) {
    run.stopped = 'deadline';
    return false;
  }
  await run.budget.yield();
  if (run.budget.signal.aborted) {
    run.stopped = 'cancelled';
    return false;
  }
  if (run.budget.now() >= run.budget.until) {
    run.stopped = 'deadline';
    return false;
  }
  return true;
};

/**
 * `true` is boolean, not a resolved promise, so the common path does not enqueue a microtask. The caller awaits only
 * the checkpoint.
 */
const tick = (run: Run): boolean | Promise<boolean> => {
  if (run.stopped !== null) return false;
  run.units += 1;
  if (run.units < CHECKPOINT_UNITS) return true;
  return checkpoint(run);
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

type Hit = boolean | 'stop';

/** One hit's window, or null when the line itself is too long to return. `covered` is the last line already emitted. */
const placeWindow = (w: Windowing, h: number, covered: number, span: number, lead: number): { start: number; end: number } | null => {
  if (w.bytes[h - 1]! > LIMITS.windowBytes) return null;
  const n = lineCount(w);
  let start = Math.max(1, covered + 1, h - lead);
  let end = Math.min(n, start + span - 1);
  while (rangeBytes(w, start, end) > LIMITS.windowBytes) {
    if (end > h) end--;
    else start++;
  }
  return { start, end };
};

interface Collected {
  c: Candidate;
  score: number;
}

/**
 * The deterministic candidate order every page is cut from. The 1,024 cap is applied while collecting, in file and
 * line order; locate then score-sorts only that bounded set, so a capped page is not the repository's global top.
 * audit: every window, in path order. exact: windows around literal, case-sensitive occurrences. locate: windows
 * around term hits, ranked by the weight of the distinct terms they hold (and their path holds), ties in path and
 * line order. Short queries with no queryTerms keep that scoring.
 */
export const buildCandidates = async (files: readonly SourceFile[], query: CandidateQuery, budget: CandidateBudget): Promise<CandidateSet> => {
  const set = blank();
  const lexical = planLexical(query);
  if (lexical.overflow) {
    set.overflow = true;
    return set;
  }
  const run: Run = { budget, units: 0, stopped: null, peaks: set.peaks };
  const collected: Collected[] = [];
  const rank = query.mode === 'locate' && query.exactSymbols.length === 0;
  const take = (c: Candidate, score: number): boolean => {
    if (collected.length >= LIMITS.candidates) {
      set.capped = true;
      return false;
    }
    collected.push({ c, score });
    run.peaks.windows = collected.length;
    if (rank) run.peaks.scored = collected.length;
    return true;
  };
  const finish = (scannedFiles: number): CandidateSet => {
    set.stopped = run.stopped;
    set.scannedFiles = scannedFiles;
    // Stable: equal scores keep file and line order. Cancelled output is discarded by the service.
    if (rank && run.stopped !== 'cancelled') collected.sort((a, b) => b.score - a.score);
    set.candidates = collected.map((s) => s.c);
    return set;
  };
  const cancelled = (): boolean => {
    if (!budget.signal.aborted) return false;
    run.stopped = 'cancelled';
    return true;
  };

  if (query.mode === 'audit') {
    let scanned = 0;
    for (const f of files) {
      if (cancelled()) return finish(scanned);
      if (!(await windowsAll(run, windowing(f), set, (c) => take(c, 0)))) return finish(scanned);
      scanned++;
    }
    return finish(scanned);
  }

  if (query.exactSymbols.length > 0) {
    let scanned = 0;
    for (const f of files) {
      if (cancelled()) return finish(scanned);
      const matched = await windowsAround(run, windowing(f), (line) => query.exactSymbols.some((s) => line.includes(s)), set, (c) => take(c, 0), LIMITS.exactWindowLines, 3, false);
      if (!matched) return finish(scanned);
      scanned++;
    }
    return finish(scanned);
  }

  const terms = [...(lexical.terms ?? [])];
  if (terms.length === 0) {
    set.scannedFiles = files.length;
    return set;
  }
  let scanned = 0;
  for (const f of files) {
    if (cancelled()) return finish(scanned);
    const pathScore = terms.reduce((n, [t]) => n + (f.path.toLowerCase().includes(t) ? 1 : 0), 0);
    const matched = await windowsAround(
      run,
      windowing(f),
      (line) => termHit(run, line, terms),
      set,
      (c) => {
        const text = c.text.toLowerCase();
        let score = pathScore;
        for (const [t, weight] of terms) if (text.includes(t)) score += weight;
        return take(c, score);
      },
      LIMITS.windowLines,
      8,
      pathScore > 0,
    );
    if (!matched) return finish(scanned);
    scanned++;
  }
  return finish(scanned);
};

const blank = (): CandidateSet => ({
  candidates: [],
  longLines: [],
  capped: false,
  overflow: false,
  stopped: null,
  scannedFiles: 0,
  peaks: { hits: 0, windows: 0, scored: 0 },
});

/** Every line in reading order, in consecutive windows. Stops at the cap or the budget instead of buffering the file. */
const windowsAll = async (run: Run, w: Windowing, set: CandidateSet, take: (c: Candidate) => boolean): Promise<boolean> => {
  const n = lineCount(w);
  let start = 1;
  while (start <= n) {
    const gate = tick(run);
    if (gate !== true && !(await gate)) return false;
    if (w.bytes[start - 1]! > LIMITS.windowBytes) {
      set.longLines.push({ path: w.file.path, line: start });
      start++;
      continue;
    }
    let end = Math.min(n, start + LIMITS.windowLines - 1);
    while (rangeBytes(w, start, end) > LIMITS.windowBytes) end--;
    if (!take(candidate(w, start, end))) return false;
    for (let i = start + 1; i <= end; i++) {
      const more = tick(run);
      if (more !== true && !(await more)) return false;
    }
    start = end + 1;
  }
  return true;
};

/**
 * Windows around hits: each opens `lead` lines before its first uncovered hit and runs to at most `span` lines and
 * 8 KiB, shrinking from the side away from the hit. Windows never overlap. A hit line too long for any window is
 * reported, not cut. `pathOnly` keeps the old rule that a path naming a term is a candidate when the text never is.
 */
const windowsAround = async (
  run: Run,
  w: Windowing,
  isHit: (line: string) => Hit | Promise<Hit>,
  set: CandidateSet,
  take: (c: Candidate) => boolean,
  span: number,
  lead: number,
  pathOnly: boolean,
): Promise<boolean> => {
  let covered = 0;
  let hits = 0;
  const n = lineCount(w);
  const offer = (h: number): boolean => {
    if (h <= covered) return true;
    const placed = placeWindow(w, h, covered, span, lead);
    if (!placed) {
      set.longLines.push({ path: w.file.path, line: h });
      covered = h;
      return true;
    }
    covered = placed.end;
    return take(candidate(w, placed.start, placed.end));
  };
  for (let i = 1; i <= n; i++) {
    const gate = tick(run);
    if (gate !== true && !(await gate)) return false;
    const raw = isHit(sliceLines(w.file.text, w.starts, i, i));
    const hit = typeof raw === 'object' ? await raw : raw;
    if (hit === 'stop') return false;
    if (!hit) continue;
    hits++;
    if (hits > run.peaks.hits) run.peaks.hits = hits;
    if (!offer(i)) return false;
  }
  if (pathOnly && hits === 0 && n > 0 && !offer(1)) return false;
  return run.stopped === null && !set.capped;
};

/** Term comparisons are the heavy inner loop. A promise is returned only when this line actually yields. */
const termHit = (run: Run, line: string, terms: readonly (readonly [string, number])[]): Hit | Promise<Hit> => {
  const lower = line.toLowerCase();
  const from = (start: number): Hit | Promise<Hit> => {
    for (let k = start; k < terms.length; k++) {
      const gate = tick(run);
      if (gate !== true) return Promise.resolve(gate).then((ok) => (ok ? from(k) : 'stop'));
      if (lower.includes(terms[k]![0])) return true;
    }
    return false;
  };
  return from(0);
};

export interface SnapshotInput {
  projectRoot: string;
  scope: readonly string[];
  excludeGlobs: readonly string[];
  query: CandidateQuery;
  constraints: readonly string[];
  inventoryComplete: boolean;
  /** Anything that bounded what was read: a cap, a skipped file, the deadline. Not a timestamp. */
  incomplete: readonly string[];
  /** How many read files the candidate scan finished. A time stop changes this, not a clock value. */
  scannedFiles: number;
  files: ReadonlyArray<{ path: string; sha256: string }>;
  candidates: readonly Candidate[];
}

/**
 * What a continuation must reproduce exactly. Page size and position are views of the same set, so they are left out.
 * The same inputs and the same stop produce the same id; a deadline instant is not part of it.
 */
export const snapshotId = (s: SnapshotInput): string =>
  sha256Hex(
    JSON.stringify([
      'jev-evidence-candidates-2',
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
      s.scannedFiles,
      s.files.map((f) => [f.path, f.sha256]),
      s.candidates.map((c) => [c.path, c.startLine, c.endLine]),
    ]),
  );
