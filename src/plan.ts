import { createHash } from 'node:crypto';

import type { DeterministicVerdict, Plan, PlannedCheck, PlannedTask, PlannerReply, Receipt, TaskSpec, TaskUncertainty, WorkerCheckResult, WorkerReply } from './types.js';
import { TIERS } from './types.js';

/** A12: bounds are bytes, not task counts. A plan may have as many tasks as fits. */
export const MAX_REPLY_BYTES = 64 * 1024;
export const MAX_COMPOSED_BYTES = 64 * 1024;
export const MAX_FIELD_BYTES = 8 * 1024;
/** #33: routing evidence is a short list of facts, not a report; a planner with more than this is not being specific. */
export const MAX_UNCERTAINTY_ENTRIES = 8;
/** A17: a specification names the interfaces of one task; beyond this the task is too large, not better specified. */
export const MAX_SPEC_ENTRIES = 8;
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

/** Non-alphanumeric runs collapse to spaces so a whole token matches: "deepen the cache" does not name the deep tier. */
const tokenized = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/**
 * #33: routing evidence is read by the tier gate, so a planner naming a tier or a configured model in it would be
 * asking for a route rather than reporting a fact. The planner does not get to ask.
 */
const namesRoutingTarget = (value: string, modelIds: readonly string[]): string | null => {
  const haystack = tokenized(value);
  for (const word of [...TIERS, ...modelIds]) {
    const needle = tokenized(word);
    if (needle !== ' ' && haystack.includes(needle)) return word;
  }
  return null;
};

const inertEvidence = (value: string, name: string, modelIds: readonly string[]): ParseResult<string> => {
  const named = namesRoutingTarget(value, modelIds);
  if (named !== null) return { ok: false, error: `${name} names ${named}; report what is unresolved, not which model or tier should run it` };
  return { ok: true, value };
};

/** A path field is structural: a repository path has no whitespace, so prose cannot hide in one. */
export const MAX_PATH_CHARS = 256;

const pathArray = (v: unknown, name: string): ParseResult<string[]> => {
  const list = strArray(v, name);
  if (!list.ok) return list;
  for (const item of list.value) {
    if (item.length === 0 || item.length > MAX_PATH_CHARS || /\s/.test(item)) {
      return { ok: false, error: `${name} must be a repository path: no whitespace, 1 to ${MAX_PATH_CHARS} characters` };
    }
  }
  return list;
};

const proseField = (v: unknown, name: string, modelIds: readonly string[]): ParseResult<string> => {
  const field = strField(v, name);
  if (!field.ok) return field;
  return inertEvidence(field.value, name, modelIds);
};

const proseArray = (v: unknown, name: string, modelIds: readonly string[]): ParseResult<string[]> => {
  const list = strArray(v, name);
  if (!list.ok) return list;
  for (const item of list.value) {
    const inert = inertEvidence(item, name, modelIds);
    if (!inert.ok) return inert;
  }
  return list;
};

const evidenceArray = (v: unknown, name: string, modelIds: readonly string[]): ParseResult<string[]> => {
  const list = strArray(v, name);
  if (!list.ok) return list;
  if (list.value.length > MAX_UNCERTAINTY_ENTRIES) return { ok: false, error: `${name} exceeds ${MAX_UNCERTAINTY_ENTRIES} entries` };
  for (const item of list.value) {
    const inert = inertEvidence(item, name, modelIds);
    if (!inert.ok) return inert;
  }
  return list;
};

const parseUncertainty = (v: unknown, taskId: string, modelIds: readonly string[]): ParseResult<TaskUncertainty> => {
  if (!isRecord(v)) return { ok: false, error: `task ${taskId}: uncertainty must be an object with unresolved, interacts_with and prior_failure` };
  const unresolved = evidenceArray(v['unresolved'] ?? [], `task ${taskId}: uncertainty.unresolved`, modelIds);
  if (!unresolved.ok) return unresolved;
  const interacts = evidenceArray(v['interacts_with'] ?? [], `task ${taskId}: uncertainty.interacts_with`, modelIds);
  if (!interacts.ok) return interacts;
  const rawFailure = v['prior_failure'] ?? null;
  if (rawFailure === null) return { ok: true, value: { unresolved: unresolved.value, interacts_with: interacts.value, prior_failure: null } };
  const failure = strField(rawFailure, `task ${taskId}: uncertainty.prior_failure`);
  if (!failure.ok) return failure;
  const inert = inertEvidence(failure.value, `task ${taskId}: uncertainty.prior_failure`, modelIds);
  if (!inert.ok) return inert;
  return { ok: true, value: { unresolved: unresolved.value, interacts_with: interacts.value, prior_failure: inert.value } };
};

/** A17: a spec states signatures and invariants, never a code block; the worker reads the repository for the body. */
const specArray = (v: unknown, name: string, modelIds: readonly string[]): ParseResult<string[]> => {
  const list = strArray(v, name);
  if (!list.ok) return list;
  if (list.value.length > MAX_SPEC_ENTRIES) return { ok: false, error: `${name} exceeds ${MAX_SPEC_ENTRIES} entries` };
  for (const item of list.value) {
    if (item.includes('```')) return { ok: false, error: `${name} contains a code block; state the signature or invariant, not an implementation` };
    const inert = inertEvidence(item, name, modelIds);
    if (!inert.ok) return inert;
  }
  return list;
};

const parseSpec = (v: unknown, taskId: string, modelIds: readonly string[]): ParseResult<TaskSpec> => {
  if (!isRecord(v)) return { ok: false, error: `task ${taskId}: spec must be an object with interfaces, data_shapes, invariants and files` };
  const interfaces = specArray(v['interfaces'] ?? [], `task ${taskId}: spec.interfaces`, modelIds);
  if (!interfaces.ok) return interfaces;
  const shapes = specArray(v['data_shapes'] ?? [], `task ${taskId}: spec.data_shapes`, modelIds);
  if (!shapes.ok) return shapes;
  const invariants = specArray(v['invariants'] ?? [], `task ${taskId}: spec.invariants`, modelIds);
  if (!invariants.ok) return invariants;
  // Paths carry no prose, so they are shape-checked instead of name-filtered: src/fast-path.ts is a file, not a request.
  const files = pathArray(v['files'] ?? [], `task ${taskId}: spec.files`);
  if (!files.ok) return files;
  if (files.value.length > MAX_SPEC_ENTRIES) return { ok: false, error: `task ${taskId}: spec.files exceeds ${MAX_SPEC_ENTRIES} entries` };
  return { ok: true, value: { interfaces: interfaces.value, data_shapes: shapes.value, invariants: invariants.value, files: files.value } };
};

const parseChecks = (v: unknown, taskId: string, modelIds: readonly string[]): ParseResult<PlannedCheck[]> => {
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
    const descriptionInert = inertEvidence(description.value, `task ${taskId}: check ${id} description`, modelIds);
    if (!descriptionInert.ok) return descriptionInert;
    if (typeof raw['required'] !== 'boolean') return { ok: false, error: `task ${taskId}: check ${id} required must be a boolean` };
    const commandRaw = raw['command'];
    if (commandRaw !== undefined && commandRaw !== null) {
      const command = strField(commandRaw, `task ${taskId}: check ${id} command`);
      if (!command.ok) return command;
      const commandInert = inertEvidence(command.value, `task ${taskId}: check ${id} command`, modelIds);
      if (!commandInert.ok) return commandInert;
    }
    out.push({ id, description: description.value, required: raw['required'], command: typeof commandRaw === 'string' ? commandRaw : null });
  }
  return { ok: true, value: out };
};

/**
 * A3: the scheduling-relevant contract of one task. Optional planner fields join it only when the planner supplied
 * them, so an omitted field does not read as a value.
 *
 * T3: this identity is deliberately narrow, and the fix for the reuse defect is not to widen it. A receipt is never
 * reused for readiness across a plan revision (see `handlePlannerResult`), so the hash only has to tell two tasks of
 * one revision apart. The trade-off is that an accepted task is redone after any replan.
 */
export const contractHash = (task: Omit<PlannedTask, 'contract_hash'>): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        outcome: task.outcome,
        depends_on: [...task.depends_on].sort(),
        constraints: task.constraints,
        deliverables: [...task.deliverables].sort(),
        checks: task.checks.map((c) => ({ id: c.id, description: c.description, required: c.required, command: c.command })),
        spec: task.spec,
        uncertainty: task.uncertainty,
        fully_specified: task.fully_specified,
      }),
      'utf8',
    )
    .digest('hex');

const parseTasks = (raw: unknown, modelIds: readonly string[]): ParseResult<Array<Omit<PlannedTask, 'contract_hash'>>> => {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'tasks must be a non-empty array' };
  const tasks: Array<Omit<PlannedTask, 'contract_hash'>> = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) return { ok: false, error: 'each task must be an object' };
    const id = item['id'];
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: `task id must match ${ID_RE.source}` };
    if (ids.has(id)) return { ok: false, error: `duplicate task id ${id}` };
    ids.add(id);
    // Every planner string below reaches Gate B as state, so the tier/model filter covers all of them, not only the
    // evidence fields: a tier named in `context` would otherwise be read by the router it is addressed to.
    const outcome = proseField(item['outcome'], `task ${id}: outcome`, modelIds);
    if (!outcome.ok) return outcome;
    const context = proseField(item['context'] ?? '', `task ${id}: context`, modelIds);
    if (!context.ok) return context;
    const depends = strArray(item['depends_on'] ?? [], `task ${id}: depends_on`);
    if (!depends.ok) return depends;
    const constraints = proseArray(item['constraints'] ?? [], `task ${id}: constraints`, modelIds);
    if (!constraints.ok) return constraints;
    const deliverables = pathArray(item['deliverables'] ?? [], `task ${id}: deliverables`);
    if (!deliverables.ok) return deliverables;
    const replanIf = proseArray(item['replan_if'] ?? [], `task ${id}: replan_if`, modelIds);
    if (!replanIf.ok) return replanIf;
    const checks = parseChecks(item['checks'] ?? [], id, modelIds);
    if (!checks.ok) return checks;
    // A1: acceptance is decided by required checks, so a task without one could never be verified.
    if (!checks.value.some((c) => c.required)) return { ok: false, error: `task ${id}: at least one check must be marked required` };
    // Document §7: none of the three is required. An absent field is unknown, not "mechanical", so a plan that omits
    // them is valid; a plan that supplies them is still held to the same shape and inertness rules.
    const rawSpec = item['spec'];
    let spec: TaskSpec | undefined;
    if (rawSpec !== undefined && rawSpec !== null) {
      const parsedSpec = parseSpec(rawSpec, id, modelIds);
      if (!parsedSpec.ok) return parsedSpec;
      spec = parsedSpec.value;
    }
    const rawUncertainty = item['uncertainty'];
    let uncertainty: TaskUncertainty | undefined;
    if (rawUncertainty !== undefined && rawUncertainty !== null) {
      const parsedUncertainty = parseUncertainty(rawUncertainty, id, modelIds);
      if (!parsedUncertainty.ok) return parsedUncertainty;
      uncertainty = parsedUncertainty.value;
    }
    const rawFullySpecified = item['fully_specified'];
    let fullySpecified: boolean | undefined;
    if (rawFullySpecified !== undefined && rawFullySpecified !== null) {
      if (typeof rawFullySpecified !== 'boolean') return { ok: false, error: `task ${id}: fully_specified must be a boolean when it is supplied` };
      fullySpecified = rawFullySpecified;
    }
    if (fullySpecified === true && (uncertainty?.unresolved.length ?? 0) > 0) {
      return { ok: false, error: `task ${id}: fully_specified is true but uncertainty.unresolved is not empty` };
    }
    if (fullySpecified === true && (spec?.interfaces.length ?? 0) === 0) {
      return { ok: false, error: `task ${id}: fully_specified is true but spec.interfaces is empty; a specified task names the interfaces it produces or consumes` };
    }
    tasks.push({
      id,
      outcome: outcome.value,
      depends_on: depends.value,
      context: context.value,
      constraints: constraints.value,
      deliverables: deliverables.value,
      checks: checks.value,
      replan_if: replanIf.value,
      ...(spec === undefined ? {} : { spec }),
      ...(uncertainty === undefined ? {} : { uncertainty }),
      ...(fullySpecified === undefined ? {} : { fully_specified: fullySpecified }),
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

/**
 * A17: the longest dependency path in the plan, which is the floor on wall-clock however many workers run.
 * The graph is already known acyclic here, so one memoised walk is enough.
 */
export const chainDepth = (tasks: Array<Pick<PlannedTask, 'id' | 'depends_on'>>): number => {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const walk = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    depth.set(id, 1);
    const deps = byId.get(id)?.depends_on ?? [];
    const value = deps.length === 0 ? 1 : 1 + Math.max(...deps.map(walk));
    depth.set(id, value);
    return value;
  };
  return tasks.length === 0 ? 0 : Math.max(...tasks.map((t) => walk(t.id)));
};

/** Structural validation only (D8): no repair, no defaulting of a missing status, no second model call. */
export const parsePlannerReply = (text: string, modelIds: readonly string[] = []): ParseResult<PlannerReply> => {
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
    const goal = proseField(parsed['goal'] ?? '', 'goal', modelIds);
    if (!goal.ok) return goal;
    const assumptions = proseArray(parsed['assumptions'] ?? [], 'assumptions', modelIds);
    if (!assumptions.ok) return assumptions;
    const constraints = proseArray(parsed['constraints'] ?? [], 'constraints', modelIds);
    if (!constraints.ok) return constraints;
    const tasks = parseTasks(parsed['tasks'], modelIds);
    if (!tasks.ok) return tasks;
    // A17: the graph is the fact and `chainDepth` computes it; the planner's own number is recorded as a claim, so a
    // planner that miscounts does not lose an otherwise valid plan.
    const claimed = parsed['chain_depth'];
    if (claimed !== undefined && (typeof claimed !== 'number' || !Number.isInteger(claimed) || claimed < 0)) {
      return { ok: false, error: 'chain_depth must be a non-negative integer' };
    }
    return {
      ok: true,
      value: {
        status: 'ready',
        goal: goal.value,
        assumptions: assumptions.value,
        constraints: constraints.value,
        tasks: tasks.value,
        chain_depth_claimed: typeof claimed === 'number' ? claimed : null,
      },
    };
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

/**
 * A17/#33 item 4: a task's own failed attempt, so a rework is judged on what went wrong rather than on the same text.
 * Without it `observed_reasoning_failure` is unreachable even after a real failure.
 */
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

/** T10: the worker copies check ids from the contract, so the contract states exactly which ids it must report. */
export const requiredCheckIds = (task: PlannedTask): string[] => task.checks.filter((c) => c.required).map((c) => c.id);

/** A12: the coordinator sends the marker and its own brief; this appends the one canonical block, keeping the prompt an exact prefix. */
export const composeTaskPrompt = (
  originalPrompt: string,
  task: PlannedTask,
  globalConstraints: string[],
  predecessors: PredecessorSummary[],
  /** T9: `omitted` when a real prior attempt did not fit the byte bound; the gap is stated, never passed off as absent. */
  priorAttempt: PriorAttemptSummary | 'omitted' | null = null,
): string =>
  [
    originalPrompt,
    '',
    CONTRACT_HEADER,
    JSON.stringify(task, null, 2),
    `Global constraints: ${JSON.stringify(globalConstraints)}`,
    // T10: the generic `c1` of the reply template is an example; these are the ids this task is accepted on.
    `Required check ids (report each of these exactly once, using these ids): ${JSON.stringify(requiredCheckIds(task))}`,
    `Predecessor results (worker_reported): ${JSON.stringify(predecessors)}`,
    ...(priorAttempt === null
      ? []
      : priorAttempt === 'omitted'
        ? ['Previous attempt of this task: omitted because it did not fit the size bound; ask the coordinator for it.']
        : [`Previous attempt of this task (worker_reported): ${JSON.stringify(priorAttempt)}`]),
  ].join('\n');

/**
 * T9: the latest receipt of this task that did not end accepted, restricted to the contract now in force. A receipt
 * without a reply is a transport failure, not a reasoning failure, and must not make one reachable.
 */
export const priorAttemptSummary = (receipts: Receipt[], task: PlannedTask): PriorAttemptSummary | null => {
  const failed = receipts.filter((r) => r.task_id === task.id && r.contract_hash === task.contract_hash && r.verdict !== 'accept' && r.reply !== null);
  const last = failed[failed.length - 1];
  if (!last) return null;
  return {
    attempt: last.attempt,
    verdict: last.verdict,
    verdict_reason: last.verdict_reason,
    status: last.reply?.status ?? null,
    summary: last.reply?.summary ?? '',
    blockers: last.reply?.blockers ?? [],
    failed_checks: (last.reply?.checks ?? []).filter((c) => c.result !== 'pass').map((c) => c.check_id),
    observed_model_confirmed: last.observed_model !== null,
    provenance: last.provenance,
  };
};

/**
 * T1: the attempt that decides completion now is the last receipt recorded for this contract, not any accept in the
 * array. A rework that failed, or one still running, therefore covers the success it replaced.
 */
export const currentReceipt = (receipts: Receipt[], task: PlannedTask): Receipt | null => {
  const matching = receipts.filter((r) => r.task_id === task.id && r.contract_hash === task.contract_hash);
  return matching[matching.length - 1] ?? null;
};

export const acceptedReceipt = (receipts: Receipt[], task: PlannedTask): Receipt | null => {
  const current = currentReceipt(receipts, task);
  return current !== null && current.verdict === 'accept' ? current : null;
};

/**
 * Ready = not accepted for this contract, not running, and every dependency accepted and not running.
 * T1: a dependency whose rework is in flight has no settled result yet, so a dependent is not ready even though the
 * receipt of its earlier attempt still says accept.
 */
export const readyTaskIds = (plan: Plan | null, receipts: Receipt[], active: ReadonlySet<string> = new Set()): string[] => {
  if (!plan) return [];
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  return plan.tasks
    .filter((task) => {
      if (active.has(task.id) || acceptedReceipt(receipts, task)) return false;
      return task.depends_on.every((dep) => {
        const depTask = byId.get(dep);
        return depTask !== undefined && !active.has(dep) && acceptedReceipt(receipts, depTask) !== null;
      });
    })
    .map((t) => t.id);
};

/** T5: a repository path with no whitespace that resolves outside the root, or to nothing, is not a distinct file. */
export const OUT_OF_ROOT = '<unresolved>';

/**
 * T5: deliverables are compared as normalized repository-relative paths, so `src/t1.ts` and `src/./t1.ts` are one file.
 * Anything that is absolute, escapes the root or resolves to nothing collapses to one sentinel, so unknown scope
 * collides with itself and with every other unknown: an ambiguous declaration is treated as shared, never as disjoint.
 * The limit is real and not hidden: a declared path is a claim by the planner, not write isolation. Case-insensitive
 * filesystems, hard links and symlinks are not resolved here.
 */
export const normalizeDeliverable = (path: string): string => {
  const trimmed = path.trim().replace(/\\/g, '/');
  if (trimmed.length === 0 || trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed) || trimmed.startsWith('~')) return OUT_OF_ROOT;
  const parts: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return OUT_OF_ROOT;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? OUT_OF_ROOT : parts.join('/');
};

/** T5: the normalized paths a task would write that a set of other normalized paths already claims. */
export const deliverableOverlap = (deliverables: string[], claimed: ReadonlySet<string>): string[] =>
  deliverables.filter((d) => claimed.has(normalizeDeliverable(d)));

export interface DeterministicResult {
  verdict: DeterministicVerdict;
  reason: string | null;
}

/**
 * A1: acceptance is code-owned. done, no blockers, and every required check reported pass exactly once.
 * Anything else is incomplete and dependents stay locked. A17: Gate C may demote this accept to rework or
 * replan, but it is never asked about anything it could promote.
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

/**
 * T11: Gate C no longer runs, so a verdict past plain incompleteness comes from the worker's own report. `replan` is
 * the status the worker itself returned; `rework` is a required check it says it ran and observed fail. Neither can
 * promote anything: both are reached only after the deterministic judgement already refused to accept.
 */
export const reportedRecovery = (task: PlannedTask, reply: WorkerReply): 'rework' | 'replan' | null => {
  if (reply.status === 'replan') return 'replan';
  const required = new Set(requiredCheckIds(task));
  return reply.checks.some((c) => c.result === 'fail' && required.has(c.check_id)) ? 'rework' : null;
};
