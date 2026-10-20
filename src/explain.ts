import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Reads a `JEV_GATE_TRACE_DIR` and says what the gate did, in the order it did it.
 *
 * The records already carry every decision; what was missing was a way to read them without opening benchmark JSON.
 * This module only joins and renders. It computes nothing the hook did not record, and where a record is absent it
 * says so rather than filling the step in from a neighbouring one -- the same rule the bench ingest follows.
 */

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sub = (r: Rec, k: string): Rec | null => (isRecord(r[k]) ? (r[k] as Rec) : null);

const thousands = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const short = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

export interface TraceRead {
  records: Rec[];
  /** Files in the directory that did not parse as a JSON object. Reported rather than dropped silently. */
  unreadable: number;
}

/** Historical Gate B records can contain a legacy tier and a different final host allocation.
 * Join only the exact host/session/tool identity; never infer the model the host actually used. */
export const allocatedTraceRecords = (records: Rec[]): Rec[] => {
  const key = (r: Rec): string | null => typeof r['session_id'] === 'string' && typeof r['tool_use_id'] === 'string'
    ? JSON.stringify([r['host'] ?? 'claude', r['session_id'], r['tool_use_id']]) : null;
  const models = new Map<string, string>();
  for (const r of records) {
    if (r['phase'] !== 'pre_result') continue;
    const identity = key(r), model = sub(r, 'allocation')?.['selected_model'];
    if (identity && typeof model === 'string') models.set(identity, model);
  }
  // Without an allocation every record stays as it is; a long native turn has none.
  if (!models.size) return records;
  return records.map(r => {
    const identity = key(r), model = identity ? models.get(identity) : undefined;
    if (!model) return r;
    return r['phase'] === 'post' || r['phase'] === 'failure' || r['phase'] === 'background_launch' ? { ...r, requested_model: model } : r;
  });
};

export type TraceCache = Map<string, { signature: string; record: Rec }>;
const signature = (stat: Stats): string => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
/** Inodes can be reused immediately after a directory is deleted (observed on Linux CI). */
export const traceDirectoryIdentity = (stat: Stats): string => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

const traceName = (name: string): boolean => name.endsWith('.json') && !name.startsWith('.');
const sortedRecords = (records: Rec[]): Rec[] => records.sort((a, b) => (str(a['written_at']) ?? '').localeCompare(str(b['written_at']) ?? ''));

/** The cached record when the file is unchanged, null when it cannot be a trace, undefined when it must be read. */
const cachedTrace = (key: string, cache: TraceCache, stat: Stats): Rec | null | undefined => {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000) { cache.delete(key); return null; }
  const previous = cache.get(key);
  if (previous?.signature === signature(stat)) return previous.record;
  cache.delete(key);
  return undefined;
};

/** Undefined when the file was removed after it was listed (retention, #231): a removed name is not an unreadable file. */
const gone = (err: unknown): undefined | null => (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;

/** `key` names the file in `cache`: its path, or its name in a cache of one directory. */
const readTraceFile = (path: string, cache?: TraceCache, existingStat?: Stats, key = path): Rec | null | undefined => {
  let fd: number | undefined;
  try {
    if (cache) {
      const cached = cachedTrace(key, cache, existingStat ?? lstatSync(path));
      if (cached !== undefined) return cached;
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 512_000) return null;
    const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!isRecord(parsed)) return null;
    cache?.set(key, { signature: signature(stat), record: parsed });
    return parsed;
  } catch (err) { cache?.delete(key); return gone(err); }
  finally { if (fd !== undefined) closeSync(fd); }
};

/** The same checks as readTraceFile with asynchronous I/O, so many small files can be read concurrently. */
const readTraceFileAsync = async (path: string, cache: TraceCache, stat: Stats, key: string): Promise<Rec | null | undefined> => {
  const cached = cachedTrace(key, cache, stat);
  if (cached !== undefined) return cached;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 512_000) return null;
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!isRecord(parsed)) return null;
    cache.set(key, { signature: signature(opened), record: parsed });
    return parsed;
  } catch (err) { cache.delete(key); return gone(err); }
  finally { await handle?.close().catch(() => undefined); }
};

export const readTraceRecords = (dir: string, cache?: TraceCache): TraceRead => {
  const directory = join(dir, '.');
  let names: string[];
  try { names = readdirSync(dir); }
  catch {
    if (cache) for (const path of cache.keys()) if (dirname(path) === directory) cache.delete(path);
    return { records: [], unreadable: 0 };
  }
  if (cache) {
    const present = new Set(names.map(name => join(dir, name)));
    for (const path of cache.keys()) if (dirname(path) === directory && !present.has(path)) cache.delete(path);
  }
  const records: Rec[] = [];
  let unreadable = 0;
  for (const name of names.sort()) {
    if (!traceName(name)) continue;
    const record = readTraceFile(join(dir, name), cache);
    if (record) records.push(record); else if (record === null) unreadable++;
  }
  return { records: sortedRecords(records), unreadable };
};

const NO_RECORDS: TraceRead = { records: [], unreadable: 0 };
/** Watch notifications name changed files; a bounded full reconciliation recovers lost events.
 * Directory identity is checked on every read so replaced or symlinked roots cannot expose stale data. */
/** `cache` is keyed by file name: the full paths of a long history would take more memory than its file signatures. */
type DirectoryState = { identity: string; modified: number; scanned: number; values: Map<string, Rec | null>; cache: TraceCache; dirty: Set<string>; full: boolean; stale: boolean; result: TraceRead; appended: string[]; replaced: boolean };
export class TraceDirectoryReader {
  private dirs = new Map<string, DirectoryState>();
  constructor(private reconciliationMs = 30_000) {}
  invalidate(dir: string, name?: string): void {
    const state = this.dirs.get(join(dir, '.'));
    if (!state) return;
    if (!name || name.includes('/') || name.includes('\\')) state.full = true;
    else if (traceName(name)) state.dirty.add(name);
  }
  /** The current state of a directory, after its identity and a due reconciliation; null when it is not readable. */
  private open(key: string, now: number): DirectoryState | null {
    let identity: string, modified: number;
    try {
      const stat = lstatSync(key);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a directory');
      identity = traceDirectoryIdentity(stat);
      modified = stat.mtimeMs;
    } catch {
      this.forget(key);
      return null;
    }
    let state = this.dirs.get(key);
    if (!state || state.identity !== identity) {
      if (state) this.forget(key);
      state = { identity, modified, scanned: 0, values: new Map(), cache: new Map(), dirty: new Set(), full: true, stale: true, result: { records: [], unreadable: 0 }, appended: [], replaced: false };
      this.dirs.set(key, state);
    }
    // A named watch notification already supplies the changed path. Avoid enumerating the entire history for it;
    // an unnotified directory change or the periodic reconciliation still discovers missed names.
    if (state.full || state.modified !== modified && !state.dirty.size || now - state.scanned >= this.reconciliationMs) {
      let names: string[];
      try { names = readdirSync(key).filter(traceName); }
      catch { this.forget(key); return null; }
      const present = new Set(names);
      for (const name of state.values.keys()) if (!present.has(name)) { state.values.delete(name); state.cache.delete(name); state.stale = true; state.replaced = true; }
      // Records are written once under new names (trace.ts), so a periodic pass reads only names it has no record for;
      // an explicit full invalidation reads every file again.
      for (const name of names) if (state.full || !state.values.get(name)) state.dirty.add(name);
      state.scanned = now; state.full = false;
    }
    state.modified = modified;
    return state;
  }
  private forget(key: string): void { this.dirs.delete(key); }
  private store(state: DirectoryState, name: string, value: Rec | null | undefined): void {
    // undefined: the name was removed. A removed name is not an unreadable file. A broken symlink is.
    if (value === undefined) { if (state.values.delete(name)) { state.stale = true; state.replaced = true; } state.cache.delete(name); return; }
    if (!state.values.has(name)) { state.stale = true; state.appended.push(name); }
    else if (state.values.get(name) !== value) { state.stale = true; state.replaced = true; }
    state.values.set(name, value);
  }
  /** Reads pending files with concurrent I/O, leaving read() only the names that changed meanwhile. */
  async prepare(dir: string, now = Date.now()): Promise<void> {
    const key = join(dir, '.');
    for (let pass = 0; pass < 3; pass++) {
      const state = this.open(key, now);
      if (!state || !state.dirty.size) return;
      const names = [...state.dirty]; state.dirty.clear();
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(64, names.length) }, async () => {
        while (next < names.length) {
          const name = names[next++]!, path = join(key, name);
          let stat: Stats;
          try { stat = await lstat(path); } catch { this.store(state, name, undefined); continue; }
          this.store(state, name, await readTraceFileAsync(path, state.cache, stat, name));
        }
      }));
      if (this.dirs.get(key) !== state) return;
    }
  }
  read(dir: string, now = Date.now()): TraceRead {
    const key = join(dir, '.');
    const state = this.open(key, now);
    // One shared empty result: an unchanged unreadable directory reads as the same result, as an unchanged one does.
    if (!state) return NO_RECORDS;
    for (const name of state.dirty) {
      const path = join(key, name);
      let stat: Stats;
      try { stat = lstatSync(path); } catch { this.store(state, name, undefined); continue; }
      this.store(state, name, readTraceFile(path, state.cache, stat, name));
    }
    state.dirty.clear();
    // Rebuild only when a value changed; an unchanged reconciliation keeps the sorted result.
    if (state.stale || state.result.records.length + state.result.unreadable !== state.values.size) {
      // New files all newer than the sorted history extend it, as a full sort would; anything else sorts again.
      const added = [...state.appended].sort((a, b) => a.localeCompare(b)).map(name => state.values.get(name) ?? null);
      const records = sortedRecords(added.filter((r): r is Rec => r !== null)), last = state.result.records.at(-1);
      if (!state.replaced && state.result.records.length + state.result.unreadable + added.length === state.values.size
        && (!last || !records[0] || (str(records[0]['written_at']) ?? '').localeCompare(str(last['written_at']) ?? '') > 0)) {
        state.result = { records: state.result.records.concat(records), unreadable: state.result.unreadable + added.length - records.length };
      } else {
        const values = [...state.values].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => r);
        state.result = { records: sortedRecords(values.filter((r): r is Rec => r !== null)), unreadable: values.filter(r => r === null).length };
      }
      state.stale = false; state.appended = []; state.replaced = false;
    }
    return state.result;
  }
}

const jevCall = (r: Rec): string => {
  const http = sub(r, 'http');
  if (r['known_not_sent'] === true) return 'not asked';
  if (!http) return 'no result recorded';
  const status = num(http['status']);
  const ms = num(http['duration_ms']);
  const code = str(http['code']);
  return `jev ${status === null ? 'no status' : `http ${status}`}${ms === null ? '' : ` ${ms}ms`}${code ? ` ${code}` : ''}`;
};

const confidenceOf = (r: Rec, question: string): number | null => {
  const answers = sub(r, 'answers');
  const a = answers ? sub(answers, question) : null;
  return a ? num(a['confidence']) : null;
};

const because = (reason: string | null): string => (reason === null ? '' : `  reason: ${reason}`);

const admissionLine = (r: Rec): string => {
  const d = sub(r, 'decision');
  const shape = d ? (str(d['shape']) ?? '?') : '?';
  const reason = d ? str(d['reason']) : null;
  const tokens = num(r['context_tokens']);
  const floor = num(r['depth_floor']);
  const conf = confidenceOf(r, 'execution');
  const depth = tokens === null ? 'context unread' : `context ${thousands(tokens)} tokens`;
  const floorText = floor === null ? '' : ` (floor ${thousands(floor)})`;
  const forced = r['forced'] === true ? '  forced arm' : '';
  const confText = conf === null ? '' : `  confidence ${conf}`;
  // Since 0.4.0 the atomic gate prices the turn: the root turns it read off and the saving that price came to.
  const est = sub(r, 'estimate');
  const turns = est ? num(est['turns']) : null;
  const saving = est ? num(est['saving_tokens']) : null;
  const priced = turns === null || saving === null ? '' : `  priced ${turns} turns, saving ${thousands(saving)} tokens`;
  return `gate A   ${shape}${confText}  ${depth}${floorText}${priced}  ${jevCall(r)}${forced}${because(reason)}`;
};

const dispatchLine = (r: Rec, post: Rec | null): string => {
  const d = sub(r, 'decision');
  const who = `task ${str(r['task_id']) ?? '?'}`;
  const attempt = num(r['attempt']);
  const called = str(r['called_tier']) ?? str(r['default_tier']) ?? '?';
  const action = d ? (str(d['action']) ?? '?') : '?';
  const tier = d ? (str(d['tier']) ?? '?') : '?';
  const reason = d ? str(d['reason']) : null;
  /**
   * `model` is what the hook asked for. A record written before the field existed has none, and the map it would be
   * read back through may since have changed, so the tier is named alone rather than guessed into a model.
   */
  const allocation = sub(r, 'allocation');
  const model = str(allocation?.['selected_model']) ?? (d ? str(d['model']) : null);
  const edit = allocation ? sub(allocation, 'effort_edit') : null;
  const target = allocation ? `selected ${model ?? '?'} / ${edit?.['kind'] === 'set' ? str(edit['value']) ?? '?' : edit?.['kind'] === 'omit' ? 'effort omitted' : 'effort kept'} (execution observed separately)`
    : action === 'preserve' ? `preserve ${tier} (the model the coordinator called)` : `${action} ${tier}${model ? ` (${model})` : ' (model not recorded)'}`;
  /**
   * Asked and ran are separate facts, and the alias the config names is not the id the host reports, so a bare string
   * comparison would call every patch a disagreement. The requested id appearing inside the resolved one is a
   * match; anything else is reported as the two strings rather than as a verdict.
   */
  const observed = ranOn(post);
  const ran =
    observed === null
      ? post === null
        ? '  (no result recorded)'
        : '  (result recorded, no model in it)'
      : model !== null && !observed.toLowerCase().includes(model.toLowerCase())
        ? `  → ran ${observed}, which is not the ${model} it asked for`
        : `  → ran ${observed}`;
  return `dispatch ${who}${attempt === null ? '' : ` attempt ${attempt}`}  called ${called} → ${target}  ${jevCall(r)}${because(reason)}${ran}`;
};

/** The model the host resolved for a dispatch, carried verbatim from the worker's tool response. */
const ranOn = (result: Rec | null): string | null => {
  if (result === null) return null;
  const tr = sub(result, 'tool_response');
  return tr ? str(tr['resolvedModel']) : null;
};

/**
 * #48 P0-2: `requested_model`/`resolved_model` exist only on the records this issue added -- a native call with no
 * job state, an unmatched dispatch, and a PostToolUseFailure -- so a record from before this change simply has
 * neither field, and this renders as absent rather than as "unrecorded" standing in for a zero-byte model name.
 */
const requestedResolved = (r: Rec): string => {
  const requested = str(r['requested_model']);
  const resolved = str(r['resolved_model']);
  return requested === null && resolved === null ? '' : `  ${requested ?? 'unrecorded'} → ${resolved ?? 'unrecorded'}`;
};

/** One named list from a check verification, left out when it is empty. */
const checkList = (v: Rec, key: string): string => {
  const ids = Array.isArray(v[key]) ? (v[key] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return ids.length === 0 ? '' : `, ${key} ${ids.join(' ')}`;
};

const resultLine = (r: Rec): string => {
  if (r['matched'] === false) {
    const subagent = str(r['subagent_type']);
    const noJob = r['job_state'] === 'absent' ? '  no job state for this session' : '';
    return `result   unmatched dispatch${subagent ? ` (${subagent})` : ''}${r['orphaned'] === true ? ' (belonged to a replaced generation)' : ''}${noJob}${requestedResolved(r)}`;
  }
  const attempt = num(r['attempt']);
  const verdict = str(r['verdict']) ?? 'no verdict';
  const reason = str(r['verdict_reason']);
  const tr = sub(r, 'tool_response');
  const ms = tr ? num(tr['totalDurationMs']) : null;
  const tools = tr ? num(tr['totalToolUseCount']) : null;
  const work = [ms === null ? null : `${Math.round(ms / 1000)}s`, tools === null ? null : `${tools} tool calls`].filter((x) => x !== null).join(', ');
  const v = sub(r, 'verification');
  const verified = v ? `  transcript ${str(v['transcript']) ?? '?'}${checkList(v, 'contradicted')}${checkList(v, 'unobserved')}${checkList(v, 'stale')}` : '';
  return `result   task ${str(r['task_id']) ?? '?'}${attempt === null ? '' : ` attempt ${attempt}`}  worker-reported ${verdict}${work ? `  (${work})` : ''}${verified}${because(reason)}`;
};

const lineFor = (r: Rec, posts: Map<string, Rec>): string | null => {
  switch (str(r['phase'])) {
    case 'admission_result':
      return admissionLine(r);
    case 'pre_result':
      return dispatchLine(r, posts.get(str(r['tool_use_id']) ?? '') ?? null);
    case 'post':
      return resultLine(r);
    case 'failure': {
      const ms = num(r['duration_ms']);
      const subagent = str(r['subagent_type']);
      return `failure  ${str(r['error_first_line']) ?? 'no message recorded'}${ms === null ? '' : `  after ${ms}ms`}${subagent ? `  (${subagent})` : ''}${requestedResolved(r)}`;
    }
    case 'stop':
      return `stop     ${str(r['outcome']) ?? 'no outcome recorded'}`;
    case 'background_stalled':
      return `background stalled: no active worker; policy delivered, Gate A resumes after this turn (${str(r['reason']) ?? 'unknown'})`;
    case 'background_policy_delivery':
      return `background policy delivered: no active worker; next human prompt resumes Gate A (${str(r['reason']) ?? 'unknown'})`;
    default:
      // Intent records pair with a result that is rendered instead, so they are not lines of their own.
      return null;
  }
};

/** What the trace cannot answer. Printed every time, because the gaps are the part a reader would otherwise invent. */
export const EXPLAIN_CAVEATS: readonly string[] = [
  'A verdict is what the worker reported about its own work. The gate does not re-run the checks; since 0.4.0 it compares each reported pass with that command\'s run in the worker\'s transcript, and refuses a pass whose last run failed, whose passing run it cannot see, or that started before the last observed edit. It still sees only how the host marked each run, not an edit made inside Bash or by another process.',
  'A model after "ran" is the one the host reported resolving. A dispatch with no result record has no observed model, and what was asked for is never read back as what was got.',
  'Records exist only for turns taken while JEV_GATE_TRACE_DIR was set. A missing phase means nothing was recorded, not that nothing happened.',
];

export const explainRecords = (read: TraceRead): string[] => {
  const out: string[] = [];
  if (read.records.length === 0) {
    out.push('no trace records found');
    if (read.unreadable > 0) out.push(`${read.unreadable} file(s) in the directory did not parse`);
    return out;
  }
  const bySession = new Map<string, Rec[]>();
  for (const r of allocatedTraceRecords(read.records)) {
    const key = str(r['session_id']) ?? '(no session id)';
    const list = bySession.get(key);
    if (list) list.push(r);
    else bySession.set(key, [r]);
  }
  for (const [session, records] of bySession) {
    const mode = str(records[0]?.['mode'] ?? null);
    out.push(`session ${short(session)}${mode ? ` (mode ${mode})` : ''}`);
    // A post record is joined to its dispatch on the tool_use_id both carry. Nothing else joins them, so a dispatch
    // whose result was never written stays unanswered rather than borrowing another's.
    const posts = new Map<string, Rec>();
    for (const r of records) {
      const phase = str(r['phase']);
      if (phase !== 'post' || r['matched'] === false) continue;
      const id = str(r['tool_use_id']);
      if (id !== null) posts.set(id, r);
    }
    /**
     * Every phase of a turn carries the same `prompt_id`, so turns are separated on it rather than on where a gate A
     * record happens to fall in write order. That matters for a record that arrives late: a result belonging to a
     * replaced generation keeps its own turn instead of being read as part of the one that is open.
     */
    const turns = new Map<string, Rec[]>();
    for (const r of records) {
      const key = str(r['prompt_id']) ?? '(no prompt id)';
      const list = turns.get(key);
      if (list) list.push(r);
      else turns.set(key, [r]);
    }
    let firstTurn = true;
    for (const turn of turns.values()) {
      const lines = turn.map((r) => lineFor(r, posts)).filter((l): l is string => l !== null);
      if (lines.length === 0) continue;
      if (!firstTurn) out.push('');
      firstTurn = false;
      for (const line of lines) out.push(`  ${line}`);
    }
    out.push('');
  }
  if (read.unreadable > 0) out.push(`${read.unreadable} file(s) in the directory did not parse`);
  for (const c of EXPLAIN_CAVEATS) out.push(`note: ${c}`);
  return out;
};

export const explainDir = (dir: string): string[] => explainRecords(readTraceRecords(dir));
