import type { DeterministicVerdict, PlannedTask, Receipt, WorkerCheckResult, WorkerReply, WorkerReceiptReply } from './types.js';
import { TIERS } from './types.js';

// Explicit projection also strips free text from older receipts before coordinator replay.
export const workerReceiptReply = (reply: WorkerReceiptReply): WorkerReceiptReply => ({
  status: reply.status,
  checks: reply.checks.map((check, i) => ({ check_id: `#${i + 1}`, result: check.result })),
});

export const MAX_REPLY_BYTES = 64 * 1024;
export const MAX_COMPOSED_BYTES = 64 * 1024;
export const MAX_FIELD_BYTES = 8 * 1024;
/** A17: the user's own request, carried to the worker verbatim. */
export const REQUEST_HEADER = '[Jev Gate user request]';
export const REQUEST_OMITTED =
  'The request was not carried: it did not fit the size bound. Ask the coordinator for it rather than reading the brief as a complete statement of what was asked.';

/** A19: the request is the whole task of a single-executor dispatch. */
export const REQUEST_ONLY_NOTE =
  "The block above is the user's own request for this job, carried verbatim. It is the task. Implement what it asks, run the checks it implies, and report separately anything you could not do. Give each check's check_id as the exact command you ran: the hook compares every reported pass with that command's last run in your own transcript. If you change files, report at least one check you ran; a change with no passing check is not accepted.";

export const composeSingleWorkerPrompt = (coordinatorBrief: string, request: string | 'omitted' | null, required = false, sameAdmittedSource = false): string =>
  [coordinatorBrief, ...(request === null ? [] : ['', REQUEST_HEADER, sameAdmittedSource && request === coordinatorBrief ? 'The coordinator brief above is the admitted user request, carried verbatim.' : request === 'omitted' && !required ? REQUEST_OMITTED : request, REQUEST_ONLY_NOTE])].join('\n');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Parse errors travel to the coordinator as context, so they describe the shape of an unexpected value and never
 * echo it: a child's output is untrusted text.
 */
const describeValue = (v: unknown): string => {
  if (v === undefined) return 'absent';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (typeof v === 'string') return `a string of ${bytes(v)} bytes`;
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Takes the content of a single ```json fence when there is exactly one, otherwise the last top-level JSON object.
 * One forward scan tracks string state, so trailing prose and braces inside strings do not confuse the span.
 */
export const extractJson = (text: string): string | null => {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (fences.length === 1 && fences[0]?.[1] !== undefined) return fences[0][1];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) last = text.slice(start, i + 1);
      }
    }
  }
  return last;
};

const strField = (v: unknown, name: string): ParseResult<string> => {
  if (typeof v !== 'string') return { ok: false, error: `${name} must be a string` };
  if (bytes(v) > MAX_FIELD_BYTES) return { ok: false, error: `${name} exceeds ${MAX_FIELD_BYTES} bytes` };
  return { ok: true, value: v };
};

const strArray = (v: unknown, name: string): ParseResult<string[]> => {
  if (!Array.isArray(v)) return { ok: false, error: `${name} must be an array of strings` };
  for (const item of v) {
    const s = strField(item, `${name}[]`);
    if (!s.ok) return s;
  }
  return { ok: true, value: v as string[] };
};

/**
 * A18: a hyphen or underscore joins a token rather than splitting it, so "deep-copy" is one word and does not name the
 * deep tier -- which is what the original rule ("a whole token matches", so "deepen the cache" is not the deep tier)
 * always said, and not what splitting on every non-alphanumeric run did. Configured model ids are hyphenated, so
 * preserving the join is also what lets one of them match as a single token.
 */
const normalizeToken = (t: string): string => t.toLowerCase().replace(/^[-_]+|[-_]+$/g, '');
const routingTargets = (modelIds: readonly string[]): Set<string> =>
  new Set([...TIERS, ...modelIds].map((w) => normalizeToken(w)).filter((w) => w.length > 0));

/** #33/A18: what the tier gate reads in place of a routing target in the task text. */
export const ROUTING_TARGET_MARK = '[tier name removed]';

/**
 * #33/A18: task text does not get to ask for a route -- the word is removed from what the gate reads, so it cannot be
 * read as a request. It is removed rather than rejected because the words are ordinary engineering English.
 */
export const redactRoutingTargets = (value: string, modelIds: readonly string[]): string => {
  const targets = routingTargets(modelIds);
  return value.replace(/[A-Za-z0-9_-]+/g, (token) => (targets.has(normalizeToken(token)) ? ROUTING_TARGET_MARK : token));
};

/**
 * #33/A18: the task text the tier gate reads, with routing targets removed. It is a copy made for the gate, so a
 * redaction can never change what gets built. Paths and ids are left alone -- `src/fast-path.ts` is a file, not a
 * request. The user's own prompt reaches the gate unredacted.
 */
export const redactTaskRoutingTargets = (task: PlannedTask, modelIds: readonly string[]): PlannedTask => {
  const r = (v: string): string => redactRoutingTargets(v, modelIds);
  return {
    ...task,
    outcome: r(task.outcome),
    context: r(task.context),
    constraints: task.constraints.map(r),
    replan_if: task.replan_if.map(r),
    checks: task.checks.map((c) => ({ ...c, description: r(c.description), command: c.command === null ? null : r(c.command) })),
  };
};

/**
 * A19: the worker names its own checks because there is no contract to take ids from, so a check id is any non-empty
 * bounded string. Measured on 2026-09-19: a strict id grammar discarded one worker's 86.6 seconds and 43 tool calls
 * because an id it chose contained a space.
 */
export const parseWorkerReply = (text: string): ParseResult<WorkerReply> => {
  if (bytes(text) > MAX_REPLY_BYTES) return { ok: false, error: `reply exceeds ${MAX_REPLY_BYTES} bytes` };
  const json = extractJson(text);
  if (json === null) return { ok: false, error: 'no JSON object found in the reply' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'the final JSON object does not parse' };
  }
  if (!isRecord(parsed)) return { ok: false, error: 'the final JSON value is not an object' };
  const status = parsed['status'];
  // #289: `replan` asked the removed planner for a new plan; it now reads like any other status this parser does not know.
  if (status !== 'done' && status !== 'blocked') return { ok: false, error: `status must be done|blocked (got ${describeValue(status)})` };
  const summary = strField(parsed['summary'] ?? '', 'summary');
  if (!summary.ok) return summary;
  const changed = strArray(parsed['changed_files'] ?? [], 'changed_files');
  if (!changed.ok) return changed;
  const interfaces = strArray(parsed['interfaces'] ?? [], 'interfaces');
  if (!interfaces.ok) return interfaces;
  const blockers = strArray(parsed['blockers'] ?? [], 'blockers');
  if (!blockers.ok) return blockers;
  const rawChecks = parsed['checks'] ?? [];
  if (!Array.isArray(rawChecks)) return { ok: false, error: 'checks must be an array' };
  const checks: WorkerCheckResult[] = [];
  for (const [i, raw] of rawChecks.entries()) {
    const name = `check #${i + 1}`;
    if (!isRecord(raw)) return { ok: false, error: `${name}: result must be an object with check_id and result` };
    const id = raw['check_id'];
    if (typeof id !== 'string') return { ok: false, error: `${name}: check_id must be a string` };
    // Keep the command verbatim for in-memory matching; diagnostics and persisted receipts use its position.
    if (id.length === 0 || bytes(id) > MAX_FIELD_BYTES) return { ok: false, error: `${name}: check_id must be a non-empty string of at most ${MAX_FIELD_BYTES} bytes` };
    const result = raw['result'];
    if (result !== 'pass' && result !== 'fail' && result !== 'not_run') return { ok: false, error: `${name}: result must be pass|fail|not_run` };
    const note = strField(raw['note'] ?? '', `${name}: note`);
    if (!note.ok) return note;
    checks.push({ check_id: id, result, note: note.value });
  }
  return {
    ok: true,
    value: { status, summary: summary.value, changed_files: changed.value, interfaces: interfaces.value, checks, blockers: blockers.value },
  };
};

/** A17/#33 item 4: the shape of Gate B's `prior_attempt` field. Nothing fills it since the planner was removed (#289). */
export interface PriorAttemptSummary {
  attempt: number;
  verdict: Receipt['verdict'];
  verdict_reason: string | null;
  status: WorkerReply['status'] | null;
  summary: string;
  blockers: string[];
  failed_checks: string[];
  /** T9: a reported failure is not an observed one. The host either named the model that ran, or it did not. */
  observed_model_confirmed: boolean;
  provenance: Receipt['provenance'];
}

export interface DeterministicResult {
  verdict: DeterministicVerdict;
  reason: string | null;
}

/** A19: the task id a single-executor receipt is filed under. There is no plan, so nothing else can name this work. */
export const SINGLE_TASK_ID = 'single';

/**
 * A19: a dispatch carries no contract, so requirement coverage cannot be checked against a planner checklist. Every
 * reported check must pass exactly once; changed files require checks. The hook verifies actual runs (src/verify.ts).
 */
export const reportedSingleVerdict = (reply: WorkerReply): DeterministicResult => {
  if (reply.status !== 'done') return { verdict: 'incomplete', reason: `worker reported status ${reply.status}` };
  if (reply.blockers.length > 0) return { verdict: 'incomplete', reason: 'worker reported blockers with status done' };
  const ids = reply.checks.map(c => c.check_id);
  if (new Set(ids).size !== ids.length) return { verdict: 'incomplete', reason: 'worker_check_duplicate' };
  if (reply.checks.some(c => c.result === 'fail')) return { verdict: 'incomplete', reason: 'worker_check_failed' };
  if (reply.checks.some(c => c.result === 'not_run')) return { verdict: 'incomplete', reason: 'worker_check_not_run' };
  if (reply.changed_files.length > 0 && reply.checks.length === 0) return { verdict: 'incomplete', reason: 'worker_checks_missing' };
  return { verdict: 'accept', reason: null };
};
