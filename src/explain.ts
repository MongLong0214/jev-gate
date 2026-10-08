import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { sameModel } from './claude-models.js';
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
    const identity = key(r), model = sub(r, 'allocation')?.['selected_model'];
    if (r['phase'] === 'pre_result' && identity && typeof model === 'string') models.set(identity, model);
  }
  return records.map(r => {
    const identity = key(r), model = identity ? models.get(identity) : undefined;
    if (!model) return r;
    const planner = sub(r, 'planner_model');
    if (planner) {
      const observed = str(planner['observed']);
      const agreement = !observed ? 'unverified' : (r['host'] === 'codex' ? model === observed : sameModel(model, observed)) ? 'match' : 'mismatch';
      return { ...r, planner_model: { ...planner, requested: model, agreement } };
    }
    return r['phase'] === 'post' || r['phase'] === 'failure' || r['phase'] === 'background_launch' ? { ...r, requested_model: model } : r;
  });
};

export type TraceCache = Map<string, { signature: string; record: Rec }>;
const signature = (stat: Stats): string => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
/** Inodes can be reused immediately after a directory is deleted (observed on Linux CI). */
export const traceDirectoryIdentity = (stat: Stats): string => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

const traceName = (name: string): boolean => name.endsWith('.json') && !name.startsWith('.');
const sortedRecords = (records: Rec[]): Rec[] => records.sort((a, b) => (str(a['written_at']) ?? '').localeCompare(str(b['written_at']) ?? ''));

const readTraceFile = (path: string, cache?: TraceCache, existingStat?: Stats): Rec | null => {
  let fd: number | undefined;
  try {
    if (cache) {
      const stat = existingStat ?? lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000) { cache.delete(path); return null; }
      const previous = cache.get(path);
      if (previous?.signature === signature(stat)) return previous.record;
      cache.delete(path);
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 512_000) return null;
    const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!isRecord(parsed)) return null;
    cache?.set(path, { signature: signature(stat), record: parsed });
    return parsed;
  } catch { cache?.delete(path); return null; }
  finally { if (fd !== undefined) closeSync(fd); }
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
    if (record) records.push(record); else unreadable++;
  }
  return { records: sortedRecords(records), unreadable };
};

/** Watch notifications name changed files; a bounded full reconciliation recovers lost events.
 * Directory identity is checked on every read so replaced or symlinked roots cannot expose stale data. */
export class TraceDirectoryReader {
  private cache: TraceCache = new Map();
  private dirs = new Map<string, { identity: string; scanned: number; values: Map<string, Rec | null>; dirty: Set<string>; full: boolean; result: TraceRead }>();
  constructor(private reconciliationMs = 30_000) {}
  invalidate(dir: string, name?: string): void {
    const state = this.dirs.get(join(dir, '.'));
    if (!state) return;
    if (!name || name.includes('/') || name.includes('\\')) state.full = true;
    else if (traceName(name)) state.dirty.add(name);
  }
  read(dir: string, now = Date.now()): TraceRead {
    const key = join(dir, '.');
    let identity: string;
    try {
      const stat = lstatSync(key);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a directory');
      identity = traceDirectoryIdentity(stat);
    } catch {
      this.dirs.delete(key);
      for (const path of this.cache.keys()) if (dirname(path) === key) this.cache.delete(path);
      return { records: [], unreadable: 0 };
    }
    let state = this.dirs.get(key);
    if (!state || state.identity !== identity) {
      state = { identity, scanned: 0, values: new Map(), dirty: new Set(), full: true, result: { records: [], unreadable: 0 } };
      this.dirs.set(key, state);
    }
    if (state.full || now - state.scanned >= this.reconciliationMs) {
      let names: string[];
      try { names = readdirSync(key).filter(traceName).sort(); }
      catch { this.dirs.delete(key); return { records: [], unreadable: 0 }; }
      const present = new Set(names);
      for (const name of state.values.keys()) if (!present.has(name)) { state.values.delete(name); this.cache.delete(join(key, name)); }
      for (const name of names) state.dirty.add(name);
      state.scanned = now; state.full = false;
    }
    if (state.dirty.size) {
      for (const name of state.dirty) {
        const path = join(key, name);
        // A removed name is not an unreadable file. A broken symlink is.
        let stat: Stats;
        try { stat = lstatSync(path); } catch { state.values.delete(name); this.cache.delete(path); continue; }
        state.values.set(name, readTraceFile(path, this.cache, stat));
      }
      state.dirty.clear();
      const values = [...state.values].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => r);
      state.result = { records: sortedRecords(values.filter((r): r is Rec => r !== null)), unreadable: values.filter(r => r === null).length };
    } else if (!state.values.size) state.result = { records: [], unreadable: 0 };
    // A full reconciliation can delete the last record without leaving a dirty name.
    if (state.result.records.length + state.result.unreadable !== state.values.size) {
      const values = [...state.values.values()];
      state.result = { records: sortedRecords(values.filter((r): r is Rec => r !== null)), unreadable: values.filter(r => r === null).length };
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
  const role = str(r['role']) ?? 'worker';
  const who = role === 'planner' ? 'planner' : `task ${str(r['task_id']) ?? '?'}`;
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
   * comparison would call every patch a disagreement. The requested id appearing inside the resolved one is the same
   * test the hook applies to the planner; anything else is reported as the two strings rather than as a verdict.
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

/**
 * The model the host resolved for a dispatch. A worker's result carries it verbatim from the tool response; a
 * planner's arrives in the plan record instead, because that is the phase its reply is parsed in.
 */
const ranOn = (result: Rec | null): string | null => {
  if (result === null) return null;
  if (str(result['phase']) === 'plan') {
    const pm = sub(result, 'planner_model');
    return pm ? str(pm['observed']) : null;
  }
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

const planLine = (r: Rec): string => {
  const status = str(r['status']) ?? '?';
  const outcome = str(r['outcome']);
  const rev = num(r['rev']);
  const tasks = num(r['tasks']);
  // The hook already settled this comparison when it wrote the record, so its own word is reported rather than redone.
  const pm = sub(r, 'planner_model');
  const agreement = pm ? str(pm['agreement']) : null;
  const observed = pm ? str(pm['observed']) : null;
  const requested = pm ? str(pm['requested']) : null;
  const model =
    observed === null
      ? ''
      : agreement === 'match'
        ? `  planner ran on ${observed}`
        : `  planner ran on ${observed}, asked for ${requested ?? 'an unrecorded model'} (${agreement ?? 'no agreement recorded'})`;
  const failed = r['replan_failed'] === true ? '  replan failed' : '';
  return `plan     ${status}${outcome ? ` → ${outcome}` : ''}${rev === null ? '' : ` rev ${rev}`}${tasks === null ? '' : `, ${tasks} task(s)`}${model}${failed}${interpretationLine(r)}`;
};

/**
 * A23: only the verdicts a reader would act on are named. `supported` is the expected answer for every clause a
 * planner derived honestly, so printing it would bury the one clause that disagrees under eleven that do not.
 */
const interpretationLine = (r: Rec): string => {
  const i = sub(r, 'interpretation');
  if (i === null || !Array.isArray(i['clauses'])) return '';
  const clauses = i['clauses'].filter(isRecord);
  const named = (verdict: string): string[] => clauses.filter((c) => c['verdict'] === verdict).map((c) => str(c['id']) ?? '?');
  const contradicted = named('contradicted');
  const omitted = named('omitted');
  const unasked = num(i['unasked']) ?? 0;
  const parts = [
    contradicted.length ? `${contradicted.length} clause(s) read as contradicting the request (${contradicted.join(', ')})` : '',
    omitted.length ? `${omitted.length} the request does not mention (${omitted.join(', ')})` : '',
    unasked > 0 ? `${unasked} not asked about` : '',
  ].filter(Boolean);
  // A plan with nothing to report still says the comparison happened, so a silent line is not read as no call.
  return parts.length === 0 ? '\n  plan checked against the request: nothing flagged' : `\n  plan checked against the request: ${parts.join('; ')}`;
};

/**
 * JGL-04 diagnostics. Missing source and empty source are different answers; an emitted marker and an actual owned
 * dispatch are different facts; and a worker that reported completion is not a task anyone checked.
 */
const leanSelectionLine = (r: Rec): string => {
  const d = sub(r, 'decision');
  const src = sub(r, 'source');
  const groups = sub(r, 'groups');
  const action = d ? (str(d['action']) ?? '?') : '?';
  const reason = d ? str(d['reason']) : null;
  const policy = str(r['policy']) ?? 'jev';
  const coverage = src ? str(src['coverage']) : null;
  const unassessed = src ? num(src['unassessed']) : null;
  const bytes = src ? num(src['bytes_read']) : null;
  const b = (k: string): string => {
    const v = groups ? num(groups[k]) : null;
    return v === null ? '' : ` (${thousands(v)} B)`;
  };
  const counts = groups
    ? `  ${num(groups['mandatory']) ?? '?'} mandatory${b('mandatory_bytes')}, ${num(groups['optional_asked']) ?? '?'} optional${b('optional_bytes')}`
    : d
      ? `  ${num(d['retained']) ?? '?'} retained, ${num(d['omitted']) ?? '?'} omitted`
      : '';
  // L7: each reason a group went unassessed is shown apart; a local cap is not a judgment about the group.
  const excluded = src ? sub(src, 'excluded') : null;
  const why = [
    ['window', excluded ? num(excluded['window']) : null],
    ['possible secret', excluded ? num(excluded['secret']) : null],
    ['unattributed', excluded ? num(excluded['unattributed']) : null],
    ['over the request bound', src ? num(src['unasked']) : null],
  ]
    .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
    .map(([label, n]) => `${label} ${n}`);
  const src_text =
    src === null
      ? '  source not recorded'
      : `  source ${coverage ?? 'unknown'}${unassessed ? `, ${unassessed} unassessed${why.length > 0 ? ` (${why.join(', ')})` : ''}` : ''}${bytes === null ? '' : `, ${thousands(bytes)} bytes read`}`;
  const usage = sub(r, 'jev');
  const u = usage ? sub(usage, 'usage') : null;
  const spent = r['attempted'] === true ? `  jev usage ${u ? `${num(u['input_tokens']) ?? '?'} in / ${num(u['output_tokens']) ?? '?'} out` : 'unknown (not zero)'}` : '';
  return `lean     ${action} (${policy})${counts}${src_text}  ${jevCall(r)}${spent}${because(reason)}`;
};

const leanDispatchLine = (r: Rec): string => {
  const reason = str(r['reason']);
  // An emitted marker is not a dispatch, and a recommendation nobody acted on is an outcome worth reading.
  if (reason === 'packet_proposed') {
    const pb = num(r['packet_bytes']);
    return `packet   proposed  ${num(r['retained_groups']) ?? '?'} retained, ${num(r['omitted_groups']) ?? '?'} omitted${pb === null ? '' : `, ${thousands(pb)} B`}  — emitted to the root, not yet dispatched`;
  }
  if (reason === 'recommendation_not_taken') return `packet   not taken  the root made no owned executor call for that request`;
  if (r['applied'] !== true) return `dispatch executor  denied: ${reason ?? 'no reason recorded'}${because(str(r['detail']))}`;
  const bytes = num(r['composed_bytes']);
  return `dispatch executor  packet applied  ${num(r['retained_groups']) ?? '?'} retained, ${num(r['omitted_groups']) ?? '?'} omitted${bytes === null ? '' : `, ${thousands(bytes)} prompt bytes`}`;
};

const leanPostLine = (r: Rec): string => {
  const model = str(r['observed_model']);
  const status = str(r['status']) ?? 'no status recorded';
  // L5: an owned executor whose stop the host did not establish keeps its reservation, and says so.
  const ownership = r['released'] === true ? '' : r['release_unconfirmed'] === true ? '  (ownership kept: the host did not establish that the child stopped)' : '  (no matching reservation released)';
  const failure = str(r['failure']);
  return `result   executor ${failure === null ? status : `failed (${failure})`}${model ? `  ran ${model}` : '  (no model in the result)'}${ownership}  — the worker's own report, not an external check`;
};

const lineFor = (r: Rec, posts: Map<string, Rec>): string | null => {
  switch (str(r['phase'])) {
    case 'lean_result':
      return leanSelectionLine(r);
    case 'lean_dispatch':
      return leanDispatchLine(r);
    case 'lean_post':
      return leanPostLine(r);
    case 'admission_result':
      return admissionLine(r);
    case 'pre_result':
      return dispatchLine(r, posts.get(str(r['tool_use_id']) ?? '') ?? null);
    case 'post':
      return resultLine(r);
    case 'plan':
      return planLine(r);
    case 'failure': {
      const ms = num(r['duration_ms']);
      const subagent = str(r['subagent_type']);
      return `failure  ${str(r['error_first_line']) ?? 'no message recorded'}${ms === null ? '' : `  after ${ms}ms`}${subagent ? `  (${subagent})` : ''}${requestedResolved(r)}`;
    }
    case 'stop':
      return `stop     ${str(r['outcome']) ?? 'no outcome recorded'}`;
    case 'background_stalled':
      return `background stalled: no active worker; policy delivered, Gate A resumes after this turn (${str(r['reason']) ?? 'unknown'})`;
    case 'guard': {
      if (r['allow'] !== false) return null;
      const denials = num(r['denials']);
      return `denied   ${str(r['tool_name']) ?? 'tool'}${denials === null ? '' : `  (${denials} so far this generation)`}${r['stopped'] === true ? '  job stopped' : ''}`;
    }
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
      if ((phase !== 'post' && phase !== 'plan') || r['matched'] === false) continue;
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
