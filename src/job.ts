import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { Env } from './config.js';
import type { ExecutionShape, JobGeneration, JobState, OwnedRole, Reservation, StateCode, Tier } from './types.js';

/** D7/A7: one private JSON file per session, never a database; bounds are enforced, never truncated. */
export const STATE_MAX_BYTES = 1024 * 1024;
export const LOCK_DEADLINE_MS = 300;
export const LOCK_POLL_MS = 10;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ACTIVE_GRACE_MS = 24 * 60 * 60 * 1000;
export const MAX_TASK_ATTEMPTS = 2;
export const MAX_HISTORY = 8;
/** A new execution or terminal policy must be delivered before the idle generation can close. */
export const pendingBackgroundPolicy = (gen: JobGeneration): JobGeneration => {
  const { background_delivery: _delivered, ...rest } = gen;
  if (Object.keys(gen.active).length > 0) delete rest.background_idle_since;
  return rest;
};
/**
 * A17: the request is stored whole or not at all. A prompt past this bound is recorded as absent, because a worker
 * that reads half a specification as if it were the whole one is worse off than one told the text did not fit.
 */
export const REQUEST_MAX_BYTES = 64 * 1024;

export type JobResult<T> = { ok: true; value: T } | { ok: false; code: StateCode };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Prototype-safe lookup for every id-keyed map. A task id or tool_use_id of `constructor` or `toString` must read as
 * absent, not as an inherited function: JSON.parse rebuilds these maps with the normal prototype, so the guard is the fix.
 */
export const own = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

const emptyMap = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

export const stateRoot = (env: Env): string => {
  const explicit = env['JEV_GATE_STATE_DIR'];
  if (explicit && explicit.length > 0) return explicit;
  const xdg = env['XDG_STATE_HOME'];
  if (xdg && xdg.length > 0) return xdg;
  const home = env['HOME'] && env['HOME'].length > 0 ? env['HOME'] : homedir();
  return join(home, '.local', 'state');
};

export const jobsDir = (env: Env): string => join(stateRoot(env), 'jev-gate', 'jobs');
const jobFileName = (sessionId: string): string => `${createHash('sha256').update(sessionId, 'utf8').digest('hex')}.json`;
export const jobPath = (env: Env, sessionId: string): string => join(jobsDir(env), jobFileName(sessionId));

const isSymlink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A7: a lock is stale only when its recorded owner process is gone; a slow writer is waited for, never robbed. */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const acquireLock = (file: string, deadlineMs: number): { ok: true; lock: string } | { ok: false; code: StateCode } => {
  const lock = `${file}.lock`;
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        const fd = openSync(join(lock, 'owner'), 'w', 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
      } catch {
        // An unwritable owner file only costs staleness detection; the lock itself is held.
      }
      return { ok: true, lock };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, code: 'state_write_failed' };
      let owner: number | null = null;
      try {
        owner = Number.parseInt(readFileSync(join(lock, 'owner'), 'utf8').trim(), 10);
      } catch {
        owner = null;
      }
      if (owner !== null && Number.isFinite(owner) && owner > 0 && !pidAlive(owner)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= until) return { ok: false, code: 'state_locked' };
      sleepSync(LOCK_POLL_MS);
    }
  }
};

const releaseLock = (lock: string): void => rmSync(lock, { recursive: true, force: true });

const parseState = (text: string, sessionId: string): JobState | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed['version'] !== 5 || parsed['session_id'] !== sessionId || !isRecord(parsed['current'])) return null;
  const current = parsed['current'] as unknown as JobGeneration;
  if (!isRecord(current['active']) || !Array.isArray(current['receipts'])) return null;
  const history = Array.isArray(parsed['history']) ? (parsed['history'] as JobGeneration[]) : [];
  return {
    version: 5,
    session_id: sessionId,
    updated_at: typeof parsed['updated_at'] === 'string' ? parsed['updated_at'] : '',
    current,
    history,
  };
};

const readRaw = (file: string, sessionId: string): JobResult<JobState | null> => {
  if (isSymlink(file)) return { ok: false, code: 'state_symlink' };
  let text: string;
  try {
    const st = statSync(file);
    if (st.size > STATE_MAX_BYTES) return { ok: false, code: 'state_too_large' };
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, value: null };
    return { ok: false, code: 'state_corrupt' };
  }
  const parsed = parseState(text, sessionId);
  return parsed === null ? { ok: false, code: 'state_corrupt' } : { ok: true, value: parsed };
};

const writeAtomic = (file: string, state: JobState): JobResult<JobState> => {
  const body = JSON.stringify({ ...state, updated_at: new Date().toISOString() });
  if (Buffer.byteLength(body, 'utf8') > STATE_MAX_BYTES) return { ok: false, code: 'state_too_large' };
  if (isSymlink(file)) return { ok: false, code: 'state_symlink' };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file is best-effort cleanup; a leftover never becomes state.
    }
    return { ok: false, code: 'state_write_failed' };
  }
  return { ok: true, value: JSON.parse(body) as JobState };
};

export const readJob = (env: Env, sessionId: string): JobResult<JobState | null> => readRaw(jobPath(env, sessionId), sessionId);

/**
 * Read-modify-write under the lock; the lock is never held across an HTTP call. A null return leaves the file untouched.
 * An unreadable file reaches `fn` as null, so an orchestration turn can recover it, unless `refuseUnreadable` is set.
 * Refusing it for every writer was rejected: a new prompt's generation is what recovers a corrupt state.
 */
export const updateJob = (
  env: Env,
  sessionId: string,
  fn: (prev: JobState | null) => JobState | null,
  opts: { refuseUnreadable?: boolean } = {},
): JobResult<JobState | null> => {
  const dir = jobsDir(env);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, code: 'state_write_failed' };
  }
  const file = jobPath(env, sessionId);
  const locked = acquireLock(file, LOCK_DEADLINE_MS);
  if (!locked.ok) return { ok: false, code: locked.code };
  try {
    const prev = readRaw(file, sessionId);
    if (!prev.ok && opts.refuseUnreadable) return { ok: false, code: prev.code };
    const next = fn(prev.ok ? prev.value : null);
    if (next === null) return prev.ok ? { ok: true, value: prev.value } : { ok: false, code: prev.code };
    return writeAtomic(file, next);
  } finally {
    releaseLock(locked.lock);
  }
};

export const emptyGeneration = (promptId: string | null, shape: ExecutionShape, now = new Date()): JobGeneration => ({
  prompt_id: promptId,
  generation_id: randomUUID(),
  request: null,
  created_at: now.toISOString(),
  shape,
  active: emptyMap(),
  receipts: [],
  attempts: { tasks: emptyMap() },
  outcome: null,
});

export interface GenerationChange {
  state: JobState;
  /** A2: a previous generation that was still working when the new prompt arrived. */
  superseded: boolean;
}

/** A2: a new prompt supersedes the turn. The old generation becomes history with outcome superseded and orphaned actives. */
export const newGeneration = (prev: JobState | null, sessionId: string, promptId: string | null, shape: ExecutionShape, now = new Date()): GenerationChange => {
  const current = emptyGeneration(promptId, shape, now);
  if (!prev) return { state: { version: 5, session_id: sessionId, updated_at: now.toISOString(), current, history: [] }, superseded: false };
  const old = prev.current;
  // #281: history eviction must not make a consumed pre-flush notice eligible again. Carry the bounded session claims
  // forward; once full the notice classifier refuses new unproven claims rather than dropping old ones.
  const claims = [...new Set([old, ...prev.history].flatMap(gen => gen.notices_taken ?? []))];
  if (claims.length) current.notices_taken = claims.slice(0, 256);
  const unfinished = old.outcome === null && Object.keys(old.active).length > 0;
  const retired: JobGeneration = {
    ...old,
    outcome: old.outcome ?? 'superseded',
    active: Object.fromEntries(Object.entries(old.active).map(([id, r]) => [id, { ...r, orphaned: true as const }])),
  };
  return {
    state: { version: 5, session_id: sessionId, updated_at: now.toISOString(), current, history: retainHistory([retired, ...prev.history]) },
    superseded: unfinished,
  };
};

/** #284: a prompt ID can be registered again as a new generation, so only the pair names the one a result belongs to. */
export const sameGeneration = (a: JobGeneration, b: JobGeneration): boolean => a.prompt_id === b.prompt_id && a.generation_id === b.generation_id;

/** Unsettled native executions are never evicted to satisfy a history count; the existing byte cap still applies. */
export const retainHistory = (history: JobGeneration[]): JobGeneration[] => {
  let ordinary = 0;
  return history.filter(g => Object.values(g.active).some(r => r.codex_execution || r.background_execution) || ordinary++ < MAX_HISTORY);
};

/** Existing job files own conflict protection, including after adapter/connection close. */
export const codexExecutions = (env: Env): Reservation[] => {
  const result: Reservation[] = [];
  let files: string[];
  try { files = readdirSync(jobsDir(env)); } catch { return result; }
  for (const file of files.filter(f => f.endsWith('.json'))) {
    try {
      const path = join(jobsDir(env), file);
      if (isSymlink(path) || statSync(path).size > STATE_MAX_BYTES) continue;
      const id = (JSON.parse(readFileSync(path, 'utf8')) as JobState).session_id;
      if (jobFileName(id) !== file) continue;
      const state = readRaw(path, id);
      if (state.ok && state.value) for (const g of [state.value.current, ...state.value.history]) result.push(...Object.values(g.active).filter(r => r.codex_execution));
    } catch { /* An unreadable file cannot provide a fabricated execution identity. */ }
  }
  return result;
};

/** #239: a worker runs inside its app-server, so once that process is gone nothing can still write for it. A reused pid only keeps protection longer. */
export const hostExited = (r: Reservation): boolean => r.codex_execution?.host_pid !== undefined && !pidAlive(r.codex_execution.host_pid);

export interface ReservationInput {
  role: OwnedRole;
  taskId: string | null;
  /** A4/T1: the contract hash the dispatch is made under; `''` where there is no contract. */
  contractHash: string | null;
  rev: number | null;
  tier: Tier | null;
  attempt: number;
  deliverables: string[];
}

export const reserve = (gen: JobGeneration, toolUseId: string, input: ReservationInput, now = new Date()): JobGeneration => ({
  ...gen,
  active: Object.assign(emptyMap<Reservation>(), gen.active, {
    [toolUseId]: {
      role: input.role,
      task_id: input.taskId,
      contract_hash: input.contractHash,
      rev: input.rev,
      tier: input.tier,
      attempt: input.attempt,
      deliverables: input.deliverables,
      started_at: now.toISOString(),
    },
  }),
});

export const release = (gen: JobGeneration, toolUseId: string): JobGeneration => {
  const active = Object.assign(emptyMap<Reservation>(), gen.active);
  delete active[toolUseId];
  return { ...gen, active, ...(gen.background_job && own(gen.active, toolUseId) && Object.keys(active).length === 0 ? { background_idle_since: new Date().toISOString() } : {}) };
};

export const activeWorkers = (gen: JobGeneration): Reservation[] => Object.values(gen.active).filter((r) => r.role === 'worker');

/** A7: the per-job task bound. Beyond it dispatch is denied with a terminal explanation instead of looping. */
export const boundExhausted = (gen: JobGeneration, taskId: string): boolean => {
  // At most one evidence-format-only single dispatch is free. The attempt number stays monotonic so receipts
  // remain unambiguous, while the paid attempt cap still bounds the job.
  const waiver = gen.execution === 'single' && gen.receipts.some((r) => r.task_id === taskId && r.evidence_format_only === true) ? 1 : 0;
  return (own(gen.attempts.tasks, taskId) ?? 0) >= MAX_TASK_ATTEMPTS + waiver;
};

export const countAttempt = (gen: JobGeneration, taskId: string): JobGeneration => {
  const tasks = Object.assign(emptyMap<number>(), gen.attempts.tasks, { [taskId]: (own(gen.attempts.tasks, taskId) ?? 0) + 1 });
  return { ...gen, attempts: { ...gen.attempts, tasks } };
};

/**
 * Whether a state file may be aged out: older than retention, readable, and no active younger than 24 h. A file that
 * cannot be read is never a candidate, and "read" is `readRaw` itself for the session the file is named after, not a
 * copy of its checks. Two reviews in a row found a check the copy had missed, the structure and then the size.
 */
const agedOut = (file: string, now: number): boolean => {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || st.size > STATE_MAX_BYTES || now - st.mtimeMs <= RETENTION_MS) return false;
    const claimed = (JSON.parse(readFileSync(file, 'utf8')) as { session_id?: unknown } | null)?.session_id;
    if (typeof claimed !== 'string' || jobFileName(claimed) !== basename(file)) return false;
    const read = readRaw(file, claimed);
    if (!read.ok || read.value === null) return false;
    const state = read.value;
    if ([state.current, ...state.history].some(g => Object.values(g.active).some(r => r.codex_execution && !hostExited(r) || r.background_execution))) return false;
    return !Object.values(state.current.active).some((r) => now - Date.parse(r.started_at) < ACTIVE_GRACE_MS);
  } catch {
    return false;
  }
};

/**
 * Opportunistic retention. The unlocked look only rules files out; a file is removed only under its own lock and after
 * a second look, because a writer may have atomically replaced it in between. A held lock means the session is in
 * use, and the file is left for a later pass.
 */
export const cleanupJobs = (env: Env, now = Date.now()): number => {
  const dir = jobsDir(env);
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    if (!agedOut(file, now)) continue;
    const locked = acquireLock(file, 0);
    if (!locked.ok) continue;
    try {
      if (agedOut(file, now)) {
        unlinkSync(file);
        removed += 1;
      }
    } catch {
      // A file that cannot be removed is left alone; cleanup is opportunistic, never required.
    } finally {
      releaseLock(locked.lock);
    }
  }
  return removed;
};
