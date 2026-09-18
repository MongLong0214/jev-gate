import { createHash } from 'node:crypto';

import type { DeterministicVerdict, Plan, PlannedCheck, PlannedTask, PlannerReply, Receipt, WorkerCheckResult, WorkerReply } from './types.js';

/** A12: bounds are bytes, not task counts. A plan may have as many tasks as fits. */
export const MAX_REPLY_BYTES = 64 * 1024;
export const MAX_COMPOSED_BYTES = 64 * 1024;
export const MAX_FIELD_BYTES = 8 * 1024;
/** Bounded on purpose: ids appear in deny reasons and coordinator context, so they must stay short and inert. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const TASK_MARKER_RE = /^\[JEV_TASK rev=(\d{1,9}) id=([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?: attempt=(\d{1,3}))?\]/;
export const CONTRACT_HEADER = '[Jev Gate task contract]';

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

const parseChecks = (v: unknown, taskId: string): ParseResult<PlannedCheck[]> => {
  if (!Array.isArray(v)) return { ok: false, error: `task ${taskId}: checks must be an array` };
  const out: PlannedCheck[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!isRecord(raw)) return { ok: false, error: `task ${taskId}: each check must be an object with id, description, required` };
    const id = raw['id'];
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: `task ${taskId}: check id must match ${ID_RE.source}` };
    if (seen.has(id)) return { ok: false, error: `task ${taskId}: duplicate check id ${id}` };
    seen.add(id);
    const description = strField(raw['description'], `task ${taskId}: check ${id} description`);
    if (!description.ok) return description;
    if (typeof raw['required'] !== 'boolean') return { ok: false, error: `task ${taskId}: check ${id} required must be a boolean` };
    const commandRaw = raw['command'];
    if (commandRaw !== undefined && commandRaw !== null) {
      const command = strField(commandRaw, `task ${taskId}: check ${id} command`);
      if (!command.ok) return command;
    }
    out.push({ id, description: description.value, required: raw['required'], command: typeof commandRaw === 'string' ? commandRaw : null });
  }
  return { ok: true, value: out };
};

/** A3: the scheduling-relevant contract only; context and replan_if do not invalidate an existing receipt. */
export const contractHash = (task: Omit<PlannedTask, 'contract_hash'>): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        outcome: task.outcome,
        depends_on: [...task.depends_on].sort(),
        constraints: task.constraints,
        deliverables: [...task.deliverables].sort(),
        checks: task.checks.map((c) => ({ id: c.id, description: c.description, required: c.required, command: c.command })),
      }),
      'utf8',
    )
    .digest('hex');

const parseTasks = (raw: unknown): ParseResult<Array<Omit<PlannedTask, 'contract_hash'>>> => {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'tasks must be a non-empty array' };
  const tasks: Array<Omit<PlannedTask, 'contract_hash'>> = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) return { ok: false, error: 'each task must be an object' };
    const id = item['id'];
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: `task id must match ${ID_RE.source}` };
    if (ids.has(id)) return { ok: false, error: `duplicate task id ${id}` };
    ids.add(id);
    const outcome = strField(item['outcome'], `task ${id}: outcome`);
    if (!outcome.ok) return outcome;
    const context = strField(item['context'] ?? '', `task ${id}: context`);
    if (!context.ok) return context;
    const depends = strArray(item['depends_on'] ?? [], `task ${id}: depends_on`);
    if (!depends.ok) return depends;
    const constraints = strArray(item['constraints'] ?? [], `task ${id}: constraints`);
    if (!constraints.ok) return constraints;
    const deliverables = strArray(item['deliverables'] ?? [], `task ${id}: deliverables`);
    if (!deliverables.ok) return deliverables;
    const replanIf = strArray(item['replan_if'] ?? [], `task ${id}: replan_if`);
    if (!replanIf.ok) return replanIf;
    const checks = parseChecks(item['checks'] ?? [], id);
    if (!checks.ok) return checks;
    // A1: acceptance is decided by required checks, so a task without one could never be verified.
    if (!checks.value.some((c) => c.required)) return { ok: false, error: `task ${id}: at least one check must be marked required` };
    tasks.push({
      id,
      outcome: outcome.value,
      depends_on: depends.value,
      context: context.value,
      constraints: constraints.value,
      deliverables: deliverables.value,
      checks: checks.value,
      replan_if: replanIf.value,
    });
  }
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) return { ok: false, error: `task ${task.id} depends on an id that is not in this plan` };
      if (dep === task.id) return { ok: false, error: `task ${task.id} depends on itself` };
    }
  }
  const state = new Map<string, number>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return false;
    if (s === 2) return true;
    state.set(id, 1);
    for (const dep of byId.get(id)?.depends_on ?? []) if (!visit(dep)) return false;
    state.set(id, 2);
    return true;
  };
  for (const task of tasks) if (!visit(task.id)) return { ok: false, error: `dependency cycle involving task ${task.id}` };
  return { ok: true, value: tasks };
};

/** Structural validation only (D8): no repair, no defaulting of a missing status, no second model call. */
export const parsePlannerReply = (text: string): ParseResult<PlannerReply> => {
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
  if (status === 'ready') {
    const goal = strField(parsed['goal'] ?? '', 'goal');
    if (!goal.ok) return goal;
    const assumptions = strArray(parsed['assumptions'] ?? [], 'assumptions');
    if (!assumptions.ok) return assumptions;
    const constraints = strArray(parsed['constraints'] ?? [], 'constraints');
    if (!constraints.ok) return constraints;
    const tasks = parseTasks(parsed['tasks']);
    if (!tasks.ok) return tasks;
    return { ok: true, value: { status: 'ready', goal: goal.value, assumptions: assumptions.value, constraints: constraints.value, tasks: tasks.value } };
  }
  if (status === 'needs_context') {
    const questions = strArray(parsed['questions'] ?? [], 'questions');
    if (!questions.ok) return questions;
    const findings = strArray(parsed['findings'] ?? [], 'findings');
    if (!findings.ok) return findings;
    return { ok: true, value: { status: 'needs_context', questions: questions.value, findings: findings.value } };
  }
  if (status === 'blocked') {
    const reason = strField(parsed['reason'] ?? '', 'reason');
    if (!reason.ok) return reason;
    const findings = strArray(parsed['findings'] ?? [], 'findings');
    if (!findings.ok) return findings;
    return { ok: true, value: { status: 'blocked', reason: reason.value, findings: findings.value } };
  }
  return { ok: false, error: `status must be ready|needs_context|blocked (got ${describeValue(status)})` };
};

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
  if (status !== 'done' && status !== 'blocked' && status !== 'replan') return { ok: false, error: `status must be done|blocked|replan (got ${describeValue(status)})` };
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
  for (const raw of rawChecks) {
    if (!isRecord(raw)) return { ok: false, error: 'each check result must be an object with check_id and result' };
    const id = raw['check_id'];
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: `check_id must match ${ID_RE.source}` };
    const result = raw['result'];
    if (result !== 'pass' && result !== 'fail' && result !== 'not_run') return { ok: false, error: `check ${id}: result must be pass|fail|not_run` };
    const note = strField(raw['note'] ?? '', `check ${id}: note`);
    if (!note.ok) return note;
    checks.push({ check_id: id, result, note: note.value });
  }
  return {
    ok: true,
    value: { status, summary: summary.value, changed_files: changed.value, interfaces: interfaces.value, checks, blockers: blockers.value },
  };
};

export interface TaskMarker {
  rev: number;
  id: string;
  attempt: number | null;
}

/** D9/A4: the coordinator's first line names the contract; attempt=<n> is an explicit rework of an already dispatched task. */
export const parseTaskMarker = (prompt: string): TaskMarker | null => {
  const first = prompt.split('\n', 1)[0] ?? '';
  const m = TASK_MARKER_RE.exec(first.trim());
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const rev = Number.parseInt(m[1], 10);
  const attempt = m[3] === undefined ? null : Number.parseInt(m[3], 10);
  if (!Number.isFinite(rev) || (attempt !== null && (!Number.isFinite(attempt) || attempt < 1))) return null;
  return { rev, id: m[2], attempt };
};

export interface PredecessorSummary {
  task_id: string;
  summary: string;
  interfaces: string[];
}

/** A12: the coordinator sends the marker and its own brief; this appends the one canonical block, keeping the prompt an exact prefix. */
export const composeTaskPrompt = (originalPrompt: string, task: PlannedTask, globalConstraints: string[], predecessors: PredecessorSummary[]): string =>
  [
    originalPrompt,
    '',
    CONTRACT_HEADER,
    JSON.stringify(task, null, 2),
    `Global constraints: ${JSON.stringify(globalConstraints)}`,
    `Predecessor results (worker_reported): ${JSON.stringify(predecessors)}`,
  ].join('\n');

export const acceptedReceipt = (receipts: Receipt[], task: PlannedTask): Receipt | null =>
  receipts.find((r) => r.task_id === task.id && r.contract_hash === task.contract_hash && r.verdict === 'accept') ?? null;

/** Ready = not already accepted for this contract and every dependency accepted for its current contract. */
export const readyTaskIds = (plan: Plan | null, receipts: Receipt[]): string[] => {
  if (!plan) return [];
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  return plan.tasks
    .filter((task) => {
      if (acceptedReceipt(receipts, task)) return false;
      return task.depends_on.every((dep) => {
        const depTask = byId.get(dep);
        return depTask !== undefined && acceptedReceipt(receipts, depTask) !== null;
      });
    })
    .map((t) => t.id);
};

export interface DeterministicResult {
  verdict: DeterministicVerdict;
  reason: string | null;
}

/**
 * A1: acceptance is code-owned. done, no blockers, and every required check reported pass exactly once.
 * Anything else is incomplete and dependents stay locked; Gate C can add a hint but never promotes this.
 */
export const deterministicVerdict = (task: PlannedTask, reply: WorkerReply): DeterministicResult => {
  if (reply.status !== 'done') return { verdict: 'incomplete', reason: `worker reported status ${reply.status}` };
  if (reply.blockers.length > 0) return { verdict: 'incomplete', reason: 'worker reported blockers with status done' };
  const known = new Set(task.checks.map((c) => c.id));
  const seen = new Map<string, WorkerCheckResult[]>();
  for (const result of reply.checks) {
    if (!known.has(result.check_id)) return { verdict: 'incomplete', reason: `unknown check id ${result.check_id}` };
    seen.set(result.check_id, [...(seen.get(result.check_id) ?? []), result]);
  }
  for (const check of task.checks) {
    if (!check.required) continue;
    const reported = seen.get(check.id) ?? [];
    if (reported.length === 0) return { verdict: 'incomplete', reason: `required check ${check.id} was not reported` };
    if (reported.length > 1) return { verdict: 'incomplete', reason: `required check ${check.id} was reported ${reported.length} times` };
    const only = reported[0] as WorkerCheckResult;
    if (only.result !== 'pass') return { verdict: 'incomplete', reason: `required check ${check.id} reported ${only.result}` };
  }
  return { verdict: 'accept', reason: null };
};
