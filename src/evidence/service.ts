import type { ChoiceAnswer } from '../types.js';
import { createJudgementCache, type JudgementCache } from './cache.js';
import { buildCandidates, LEXICAL_TERM_DETAIL, lineStarts, planLexical, sliceLines, snapshotId, yieldToEventLoop, type Candidate, type SourceFile } from './candidates.js';
import { selectPage, type EvidenceRemoteEvent, type Selection } from './selector.js';
import { excluded, exists, globToRegExp, listFiles as listProjectFiles, normalizeRelative, readSource as readProjectFile, within, type ReadOutcome } from './source.js';
import {
  LIMITS,
  MODES,
  RELEVANT_FLOOR,
  UNRELATED_FLOOR,
  type Coverage,
  type EvidenceConfig,
  type EvidenceItem,
  type EvidenceMode,
  type EvidenceResult,
  type Judgement,
  type ReasonCode,
  type SourceRef,
} from './types.js';

interface SearchInput {
  kind: 'search';
  goal: string;
  roots: string[] | null;
  mode: EvidenceMode;
  queryTerms: string[];
  exactSymbols: string[];
  constraints: string[];
  limit: number;
  offset: number;
  expectedSnapshot: string | null;
}
interface SourcesInput {
  kind: 'sources';
  goal: string;
  constraints: string[];
  sources: SourceRef[];
}
export type ParsedRequest = { ok: true; input: SearchInput | SourcesInput } | { ok: false; detail: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const HEX64 = /^[0-9a-f]{64}$/;
const REQUEST_KEYS = new Set(['goal', 'roots', 'mode', 'queryTerms', 'exactSymbols', 'constraints', 'limit', 'offset', 'expectedSnapshot', 'sources']);
const SOURCE_ONLY_KEYS = new Set(['goal', 'constraints', 'sources']);
const SOURCE_REF_KEYS = ['path', 'startLine', 'endLine', 'fileSha256'];
const safeInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/**
 * The input exactly as sent, checked before any default is filled in: a wrong or mixed input is refused whole, never
 * trimmed into something valid. The detail is fixed text naming the field, never a value.
 */
export const parseRequest = (raw: unknown): ParsedRequest => {
  const bad = (detail: string): ParsedRequest => ({ ok: false, detail });
  if (!isRecord(raw)) return bad('the input is not an object');
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > LIMITS.inputBytes) return bad('the input is over 16 KiB');
  const unknown = Object.keys(raw).find((k) => !REQUEST_KEYS.has(k));
  if (unknown !== undefined) return bad(`unknown field ${JSON.stringify(unknown.slice(0, 40))}`);
  const goal = raw['goal'];
  if (typeof goal !== 'string' || goal.trim() === '' || goal.includes('\0')) return bad('goal must be a nonempty string');
  /** Absent is null; present is 1 to 16 nonempty strings (constraints may be empty: it means none). */
  const strings = (key: string, allowEmpty = false): string[] | null | undefined => {
    const v = raw[key];
    if (v === undefined) return null;
    if (!Array.isArray(v) || v.length > LIMITS.arrayItems || (v.length === 0 && !allowEmpty)) return undefined;
    return v.every((s) => typeof s === 'string' && s.trim() !== '' && !s.includes('\0')) ? (v as string[]) : undefined;
  };
  const constraints = strings('constraints', true);
  if (constraints === undefined) return bad('constraints must be up to 16 nonempty strings');

  if (raw['sources'] !== undefined) {
    const mixed = Object.keys(raw).find((k) => !SOURCE_ONLY_KEYS.has(k));
    if (mixed !== undefined) return bad(`sources cannot be combined with ${mixed}`);
    const list = raw['sources'];
    if (!Array.isArray(list) || list.length === 0 || list.length > LIMITS.arrayItems) return bad('sources must be 1 to 16 source references');
    const sources: SourceRef[] = [];
    for (const [i, s] of list.entries()) {
      if (!isRecord(s) || Object.keys(s).length !== SOURCE_REF_KEYS.length || !SOURCE_REF_KEYS.every((k) => k in s)) return bad(`sources[${i}] must have exactly path, startLine, endLine, fileSha256`);
      const path = typeof s['path'] === 'string' ? normalizeRelative(s['path']) : null;
      if (path === null || path === '' || path !== s['path']) return bad(`sources[${i}].path must be a normalized path relative to projectRoot`);
      if (!safeInt(s['startLine'], 1) || !safeInt(s['endLine'], s['startLine'] as number)) return bad(`sources[${i}] must have 1 <= startLine <= endLine`);
      if (typeof s['fileSha256'] !== 'string' || !HEX64.test(s['fileSha256'])) return bad(`sources[${i}].fileSha256 must be 64 lowercase hex digits`);
      if ((s['endLine'] as number) - (s['startLine'] as number) + 1 > LIMITS.windowLines) return bad(`sources[${i}] spans more than ${LIMITS.windowLines} lines; ask for a smaller range or use Read`);
      sources.push({ path, startLine: s['startLine'] as number, endLine: s['endLine'] as number, fileSha256: s['fileSha256'] });
    }
    return { ok: true, input: { kind: 'sources', goal, constraints: constraints ?? [], sources } };
  }

  const modeRaw = raw['mode'];
  if (modeRaw !== undefined && !MODES.includes(modeRaw as EvidenceMode)) return bad('mode must be locate or audit');
  const mode = (modeRaw as EvidenceMode | undefined) ?? 'locate';
  const rootsRaw = strings('roots');
  if (rootsRaw === undefined) return bad('roots must be 1 to 16 relative paths');
  const roots = rootsRaw === null ? null : rootsRaw.map((r) => (r === '.' ? '' : normalizeRelative(r)));
  if (roots !== null && roots.some((r) => r === null)) return bad('roots must be relative paths inside projectRoot');
  const queryTerms = strings('queryTerms');
  if (queryTerms === undefined) return bad('queryTerms must be 1 to 16 nonempty strings');
  const exactSymbols = strings('exactSymbols');
  if (exactSymbols === undefined) return bad('exactSymbols must be 1 to 16 nonempty strings');
  if (exactSymbols !== null && queryTerms !== null) return bad('exactSymbols and queryTerms cannot be combined');
  if (exactSymbols !== null && mode === 'audit') return bad('exactSymbols is for locate only');
  const limit = raw['limit'] ?? LIMITS.defaultPage;
  if (!safeInt(limit, 1, LIMITS.maxPage)) return bad(`limit must be an integer from 1 to ${LIMITS.maxPage}`);
  const offset = raw['offset'] ?? 0;
  if (!safeInt(offset, 0)) return bad('offset must be a nonnegative integer');
  const expected = raw['expectedSnapshot'];
  if (expected !== undefined && (typeof expected !== 'string' || !HEX64.test(expected))) return bad('expectedSnapshot must be 64 lowercase hex digits');
  if (offset > 0 && expected === undefined) return bad('offset > 0 needs the expectedSnapshot of the first page');
  return {
    ok: true,
    input: {
      kind: 'search',
      goal,
      roots: roots as string[] | null,
      mode,
      queryTerms: queryTerms ?? [],
      exactSymbols: exactSymbols ?? [],
      constraints: constraints ?? [],
      limit,
      offset,
      expectedSnapshot: (expected as string | undefined) ?? null,
    },
  };
};

const emptyCoverage = (): Coverage => ({
  inventoryComplete: false,
  filesTotal: null,
  readFiles: 0,
  skippedFiles: 0,
  candidates: 0,
  pageCandidates: 0,
  unjudgedOnPage: 0,
  omittedBodies: 0,
  sourceIncomplete: false,
});

export interface EvidenceReply {
  result: EvidenceResult;
  /** A tool error: invalid input, no access, no config, no inventory, over a bound, busy or cancelled. */
  isError: boolean;
  /** Fixed text naming what to change, only on an error. */
  detail?: string;
}

const refuse = (projectRoot: string | null, reason: ReasonCode, detail?: string, status: EvidenceResult['status'] = 'unavailable'): EvidenceReply => ({
  result: { version: 1, projectRoot, status, backend: 'local', items: [], snapshotId: null, next: null, coverage: emptyCoverage(), reasonCodes: [reason] },
  isError: true,
  ...(detail ? { detail } : {}),
});

/** Remote reasons that mean a page Jev was asked to judge came back only partly judged. */
const REMOTE_SHORTFALL: readonly ReasonCode[] = ['remote_secret', 'remote_budget', 'remote_failed', 'remote_timeout', 'busy'];

interface Draft {
  projectRoot: string;
  items: EvidenceItem[];
  snapshotId: string | null;
  next: EvidenceResult['next'];
  coverage: Coverage;
  reasons: ReasonCode[];
  /** Partial before any body is left out for size. */
  partial: boolean;
}

const resultBytes = (r: EvidenceResult): number => Buffer.byteLength(JSON.stringify(r), 'utf8');
const omitForSize = (item: EvidenceItem): EvidenceItem => {
  const { text: _text, ...rest } = item;
  return { ...rest, textState: 'omitted_budget' };
};

const finish = (draft: Draft, keepBody: readonly boolean[]): EvidenceResult => {
  const items = draft.items.map((it, k) => (it.text !== undefined && !keepBody[k] ? omitForSize(it) : it));
  const cut = draft.items.some((it, k) => it.text !== undefined && !keepBody[k]);
  const reasonCodes = [...new Set<ReasonCode>([...draft.reasons, ...(cut ? (['output_limit'] as const) : [])])];
  const omitted = items.filter((i) => i.text === undefined).length;
  const jev = items.filter((i) => i.origin === 'jev').length;
  return {
    version: 1,
    projectRoot: draft.projectRoot,
    status: draft.partial || omitted > 0 ? 'partial' : 'ok',
    backend: jev === 0 ? 'local' : jev === items.length ? 'jev' : 'mixed',
    items,
    snapshotId: draft.snapshotId,
    next: draft.next,
    coverage: { ...draft.coverage, pageCandidates: items.length, unjudgedOnPage: items.filter((i) => i.judgement === 'unjudged').length, omittedBodies: omitted },
    reasonCodes,
  };
};

/**
 * Metadata for every item first; bodies then join in page order while the whole serialized result stays within
 * 64 KiB. Nothing is byte-sliced: a body either fits whole or is `omitted_budget`. Null when even the metadata does
 * not fit.
 */
const fitResult = (draft: Draft): EvidenceResult | null => {
  const keep = draft.items.map(() => false);
  if (resultBytes(finish(draft, keep)) > LIMITS.resultBytes) return null;
  for (let k = 0; k < keep.length; k++) {
    if (draft.items[k]!.text === undefined) continue;
    keep[k] = true;
    if (resultBytes(finish(draft, keep)) > LIMITS.resultBytes) keep[k] = false;
  }
  return finish(draft, keep);
};

/** relevant first, then the uncertain and unjudged, then the clearly unrelated; local order within each. */
const bucket = (a: ChoiceAnswer<Judgement> | undefined): number => {
  if (a?.choice === 'relevant' && a.probabilities.relevant >= RELEVANT_FLOOR) return 0;
  if (a?.choice === 'unrelated' && a.probabilities.unrelated >= UNRELATED_FLOOR) return 2;
  return 1;
};
const rounded = (p: Record<Judgement, number>): Record<Judgement, number> =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) as Record<Judgement, number>;

export interface EvidenceServiceDeps {
  /** TYPESAFE_API_KEY as the process received it; null when absent. */
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Event-loop turn during candidate generation. Default yields with setImmediate. Not an MCP argument. */
  yield?: () => Promise<void>;
  /** Judgement cache. Default is private to this service. Tests pass one to observe writes. */
  cache?: JudgementCache;
  /** Source I/O. Defaults are the real readers. Tests pass counters; not MCP arguments. */
  listFiles?: typeof listProjectFiles;
  readSource?: typeof readProjectFile;
}

export interface EvidenceService {
  run: (raw: unknown, signal: AbortSignal, observeRemote?: (event: EvidenceRemoteEvent) => void) => Promise<EvidenceReply>;
}

/**
 * The service behind `jev_evidence`. It reads only files the owner's config admits, never writes one, runs no
 * command but a fixed-argument `git ls-files`, and sends source to Jev only when the config says `remote: true`, a
 * key is present and the call is a semantic search. At most two calls run at once; a third is refused as busy.
 */
export const createEvidenceService = (config: EvidenceConfig | null, deps: EvidenceServiceDeps): EvidenceService => {
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? createJudgementCache(now);
  const listFiles = deps.listFiles ?? listProjectFiles;
  const readSource = deps.readSource ?? readProjectFile;
  const http = { active: 0 };
  let active = 0;

  const cancelled = (): EvidenceReply => refuse(config?.projectRoot ?? null, 'cancelled', undefined, 'cancelled');

  const search = async (cfg: EvidenceConfig, input: SearchInput, signal: AbortSignal, observeRemote?: (event: EvidenceRemoteEvent) => void): Promise<EvidenceReply> => {
    const root = cfg.projectRoot;
    const deadline = now() + LIMITS.deadlineMs;
    const semantic = input.exactSymbols.length === 0;
    const remote = semantic && cfg.remote && deps.apiKey !== null;
    const publishBy = deadline - LIMITS.publishReserveMs;
    const readBy = publishBy - (remote ? LIMITS.remoteMs : 0);
    const globs = cfg.excludeGlobs.map(globToRegExp);

    const scope = input.roots ?? cfg.allowedRoots;
    const outside = scope.find((r) => !cfg.allowedRoots.some((a) => within(r, a)) || (r !== '' && excluded(r, globs)));
    if (outside !== undefined) return refuse(root, 'out_of_scope', `${JSON.stringify(outside.slice(0, 200))} is outside the allowed roots or excluded`);

    // Term policy before any scan or HTTP. Audit, exact, and sources do not reach here with an unused goal vocabulary.
    const query = { mode: input.mode, goal: input.goal, queryTerms: input.queryTerms, exactSymbols: input.exactSymbols };
    if (planLexical(query).overflow) return refuse(root, 'invalid_input', LEXICAL_TERM_DETAIL);

    const inventory = await listFiles(root, scope, readBy - now());
    if (signal.aborted) return cancelled();
    if (!inventory) return refuse(root, 'unsupported_inventory', 'git could not list the project files');
    const eligible = inventory.paths.filter((p) => scope.some((s) => within(p, s)) && !excluded(p, globs));

    const reasons: ReasonCode[] = [];
    const reason = (r: ReasonCode): void => {
      if (!reasons.includes(r)) reasons.push(r);
    };
    const incomplete: string[] = [];
    if (!inventory.complete) {
      reason('source_limit');
      incomplete.push('inventory');
    }
    const files: SourceFile[] = [];
    let readBytes = 0;
    let skipped = inventory.unreadable;
    for (const [i, p] of eligible.entries()) {
      if (signal.aborted) return cancelled();
      const stop: ReasonCode | null =
        files.length >= LIMITS.files || readBytes + LIMITS.fileBytes > LIMITS.totalReadBytes - LIMITS.verifyReserveBytes ? 'source_limit' : now() >= readBy ? 'deadline' : null;
      if (stop) {
        reason(stop);
        incomplete.push(`${stop}@${i}`);
        break;
      }
      const r = await readSource(root, p);
      // A read already in flight is allowed to finish; cancellation still starts nothing else.
      if (signal.aborted) return cancelled();
      readBytes += r.bytes;
      if (r.ok) files.push({ path: p, text: r.text, sha256: r.sha256 });
      else {
        skipped++;
        if (r.kind === 'incomplete') {
          reason(r.why === 'too_large' ? 'source_limit' : 'source_unverified');
          incomplete.push(`${r.why}:${p}`);
        }
      }
    }
    if (signal.aborted) return cancelled();

    const set = await buildCandidates(files, query, { now, until: readBy, signal, yield: deps.yield ?? yieldToEventLoop });
    if (set.overflow) return refuse(root, 'invalid_input', LEXICAL_TERM_DETAIL);
    if (set.stopped === 'cancelled' || signal.aborted) return cancelled();
    if (set.longLines.length > 0) {
      reason('line_too_long');
      incomplete.push(...set.longLines.map((l) => `line:${l.path}:${l.line}`));
    }
    // A search-stage stop is partial even when the total deadline still has room to re-verify the page.
    if (set.stopped === 'deadline') {
      reason('deadline');
      incomplete.push(`deadline@candidates:${set.scannedFiles}`);
    }
    if (set.capped) {
      reason('source_limit');
      incomplete.push('candidates');
    }
    const snapshot = snapshotId({
      projectRoot: root,
      scope,
      excludeGlobs: cfg.excludeGlobs,
      query,
      constraints: input.constraints,
      inventoryComplete: inventory.complete,
      incomplete,
      scannedFiles: set.scannedFiles,
      files,
      candidates: set.candidates,
    });
    const coverage: Coverage = {
      ...emptyCoverage(),
      inventoryComplete: inventory.complete,
      filesTotal: inventory.complete ? eligible.length : null,
      readFiles: files.length,
      skippedFiles: skipped,
      candidates: set.candidates.length,
      sourceIncomplete: incomplete.length > 0,
    };
    if (input.expectedSnapshot !== null && input.expectedSnapshot !== snapshot) {
      // The set this continuation was cut from no longer exists; nothing is restarted or spliced.
      return { result: finish({ projectRoot: root, items: [], snapshotId: null, next: null, coverage, reasons: ['source_changed', ...reasons], partial: true }, []), isError: false };
    }
    if (set.candidates.length === 0) reason('no_candidate');
    const page = set.candidates.slice(input.offset, input.offset + input.limit);

    let selection: Selection | null = null;
    // Candidate generation already stopped on the search budget: do not open a Jev call on that partial page.
    const cpuStopped = set.stopped === 'deadline';
    if (semantic && !cfg.remote) reason('remote_disabled');
    else if (semantic && deps.apiKey === null) reason('missing_key');
    else if (remote && page.length > 0 && !cpuStopped && now() < deadline) {
      const scopeKey = JSON.stringify([root, scope, cfg.excludeGlobs, input.mode]);
      selection = await selectPage(input.goal, input.constraints, page, scopeKey, publishBy, signal, { apiKey: deps.apiKey!, cache, http, now, ...(observeRemote ? { observeRemote } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
      if (selection.cancelled || signal.aborted) return cancelled();
      selection.reasons.forEach(reason);
    } else if (remote && page.length > 0 && !cpuStopped) reason('deadline');

    const ordered = page
      .map((c, i) => ({ c, a: selection?.answers.get(i) }))
      .map((x) => ({ ...x, bucket: bucket(x.a) }))
      .sort((x, y) => x.bucket - y.bucket);

    // What is published is read again: a file that changed since it was read is stale, its old judgement dropped.
    const state = new Map<string, 'ok' | 'stale' | 'unverified'>();
    for (const { c } of ordered) {
      if (state.has(c.path)) continue;
      if (signal.aborted) return cancelled();
      if (now() >= deadline || readBytes + LIMITS.fileBytes > LIMITS.totalReadBytes) {
        state.set(c.path, 'unverified');
        continue;
      }
      const r = await readSource(root, c.path);
      if (signal.aborted) return cancelled();
      readBytes += r.bytes;
      state.set(c.path, r.ok && r.sha256 === c.fileSha256 ? 'ok' : 'stale');
    }
    const items = ordered.map(({ c, a, bucket: b }): EvidenceItem => {
      const source = { path: c.path, startLine: c.startLine, endLine: c.endLine, fileSha256: c.fileSha256 };
      const s = state.get(c.path);
      if (s === 'stale') {
        reason('source_changed');
        return { source, textState: 'stale', origin: 'local', judgement: 'unjudged' };
      }
      const judged = a ? ({ origin: 'jev', judgement: a.choice, probabilities: rounded(a.probabilities) } as const) : ({ origin: 'local', judgement: 'unjudged' } as const);
      if (s === 'unverified') {
        reason('source_unverified');
        return { source, textState: 'omitted_budget', ...judged };
      }
      if (input.mode === 'locate' && b === 2) return { source, textState: 'omitted_irrelevant', ...judged };
      return { source, text: c.text, textState: 'included', ...judged };
    });
    const next = input.offset + page.length < set.candidates.length ? { offset: input.offset + page.length, expectedSnapshot: snapshot } : null;
    const partial = coverage.sourceIncomplete || next !== null || reasons.some((r) => REMOTE_SHORTFALL.includes(r) || r === 'source_changed' || r === 'source_unverified');
    const result = fitResult({ projectRoot: root, items, snapshotId: snapshot, next, coverage, reasons, partial });
    return result ? { result, isError: false } : refuse(root, 'output_limit', 'the result metadata does not fit in 64 KiB; use a smaller limit');
  };

  const readSources = async (cfg: EvidenceConfig, input: SourcesInput, signal: AbortSignal): Promise<EvidenceReply> => {
    const root = cfg.projectRoot;
    const deadline = now() + LIMITS.deadlineMs;
    const globs = cfg.excludeGlobs.map(globToRegExp);
    const outside = input.sources.find((s) => !cfg.allowedRoots.some((a) => within(s.path, a)) || excluded(s.path, globs));
    if (outside) return refuse(root, 'out_of_scope', `${JSON.stringify(outside.path.slice(0, 200))} is outside the allowed roots or excluded`);

    // A read-back admits only what a search could have returned: a listed file, not ignored, not inside a submodule.
    const inventory = await listFiles(root, [...new Set(input.sources.map((s) => s.path))], deadline - now());
    if (signal.aborted) return cancelled();
    if (!inventory) return refuse(root, 'unsupported_inventory', 'git could not list the project files');
    const listed = new Set(inventory.paths);

    const reads = new Map<string, ReadOutcome>();
    const reasons: ReasonCode[] = [];
    const reason = (r: ReasonCode): void => {
      if (!reasons.includes(r)) reasons.push(r);
    };
    let readBytes = 0;
    const items: EvidenceItem[] = [];
    for (const [i, s] of input.sources.entries()) {
      if (signal.aborted) return cancelled();
      if (!listed.has(s.path)) {
        reason((await exists(root, s.path)) ? 'out_of_scope' : 'source_missing');
        items.push({ source: s, textState: 'stale', origin: 'local', judgement: 'unjudged' });
        continue;
      }
      let r = reads.get(s.path);
      if (!r) {
        if (now() >= deadline || readBytes + LIMITS.fileBytes > LIMITS.totalReadBytes) {
          reason(now() >= deadline ? 'deadline' : 'source_limit');
          items.push({ source: s, textState: 'omitted_budget', origin: 'local', judgement: 'unjudged' });
          continue;
        }
        r = await readSource(root, s.path);
        if (signal.aborted) return cancelled();
        readBytes += r.bytes;
        reads.set(s.path, r);
      }
      if (!r.ok || r.sha256 !== s.fileSha256) {
        // Never the current text under an old reference: a changed or vanished file is stale, without text.
        reason(!r.ok && r.why === 'missing' ? 'source_missing' : !r.ok ? 'source_unverified' : 'source_changed');
        items.push({ source: s, textState: 'stale', origin: 'local', judgement: 'unjudged' });
        continue;
      }
      const starts = lineStarts(r.text);
      if (s.endLine > starts.length - 1) return refuse(root, 'invalid_input', `sources[${i}] ends past the file's last line`);
      const text = sliceLines(r.text, starts, s.startLine, s.endLine);
      if (Buffer.byteLength(text, 'utf8') > LIMITS.windowBytes) return refuse(root, 'range_too_large', `sources[${i}] is over 8 KiB; ask for a smaller range or use Read`);
      items.push({ source: s, text, textState: 'included', origin: 'local', judgement: 'unjudged' });
    }
    const coverage: Coverage = {
      ...emptyCoverage(),
      readFiles: [...reads.values()].filter((r) => r.ok).length,
      skippedFiles: [...reads.values()].filter((r) => !r.ok).length,
      sourceIncomplete: items.some((i) => i.textState !== 'included'),
    };
    const result = fitResult({ projectRoot: root, items, snapshotId: null, next: null, coverage, reasons, partial: coverage.sourceIncomplete });
    // Folding a read-back for size would hand back the same folded answer on every retry: it is a capacity error.
    if (!result || result.reasonCodes.includes('output_limit')) return refuse(root, 'output_limit', 'these sources do not fit in one 64 KiB result; ask for fewer or smaller ranges, or use Read');
    return { result, isError: false };
  };

  return {
    run: async (raw, signal, observeRemote) => {
      if (!config) return refuse(null, 'unavailable_config', 'the evidence server has no valid config; run the server with --doctor');
      if (signal.aborted) return cancelled();
      const parsed = parseRequest(raw);
      if (!parsed.ok) return refuse(config.projectRoot, 'invalid_input', parsed.detail);
      if (active >= LIMITS.concurrentCalls) return refuse(config.projectRoot, 'busy', 'two evidence calls are already running; retry after one finishes');
      active++;
      try {
        const reply = parsed.input.kind === 'sources' ? await readSources(config, parsed.input, signal) : await search(config, parsed.input, signal, observeRemote);
        // A cancellation seen only after the last read is still a cancellation, never a local success.
        return signal.aborted ? cancelled() : reply;
      } finally {
        active--;
      }
    },
  };
};

export type { Candidate };
