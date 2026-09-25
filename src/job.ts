import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Env } from './config.js';
import type { ExecutionShape, JobGeneration, JobState, OwnedRole, Reservation, StateCode, Tier } from './types.js';

/** D7/A7: one private JSON file per session, never a database; bounds are enforced, never truncated. */
export const STATE_MAX_BYTES = 1024 * 1024;
export const LOCK_DEADLINE_MS = 300;
export const LOCK_POLL_MS = 10;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ACTIVE_GRACE_MS = 24 * 60 * 60 * 1000;
export const MAX_PLANNER_ATTEMPTS = 2;
export const MAX_REPLANS = 2;
export const MAX_TASK_ATTEMPTS = 2;
export const MAX_HISTORY = 8;
export const LEAN_SEEN_MAX = 32;
/** Every rewrite of the state keeps the lean identities it read; only a lean registration adds to them. */
export const leanSeenOf = (prev: JobState | null | undefined): Pick<JobState, 'lean_seen'> => (prev?.lean_seen ? { lean_seen: prev.lean_seen } : {});
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
export const jobPath = (env: Env, sessionId: string): string => join(jobsDir(env), `${createHash('sha256').update(sessionId, 'utf8').digest('hex')}.json`);

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
  const seen = parsed['lean_seen'];
  const leanSeen = Array.isArray(seen) ? seen.filter((p): p is string => typeof p === 'string').slice(0, LEAN_SEEN_MAX) : null;
  return {
    version: 5,
    session_id: sessionId,
    updated_at: typeof parsed['updated_at'] === 'string' ? parsed['updated_at'] : '',
    current,
    history,
    ...(leanSeen ? { lean_seen: leanSeen } : {}),
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

/** Read-modify-write under the lock; the lock is never held across an HTTP call. A null return leaves the file untouched. */
export const updateJob = (env: Env, sessionId: string, fn: (prev: JobState | null) => JobState | null): JobResult<JobState | null> => {
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
    const next = fn(prev.ok ? prev.value : null);
    if (next === null) return prev.ok ? { ok: true, value: prev.value } : { ok: false, code: prev.code };
    return writeAtomic(file, next);
  } finally {
    releaseLock(locked.lock);
  }
};

export const emptyGeneration = (promptId: string | null, shape: ExecutionShape, now = new Date()): JobGeneration => ({
  prompt_id: promptId,
  request: null,
  created_at: now.toISOString(),
  shape,
  phase: 'admitted',
  planner_tier: null,
  planner_model: null,
  plan: null,
  active: emptyMap(),
  receipts: [],
  denials: 0,
  attempts: { planner: 0, replans: 0, tasks: emptyMap() },
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
  const unfinished = old.outcome === null && (Object.keys(old.active).length > 0 || old.phase === 'planning' || old.phase === 'planned');
  const retired: JobGeneration = {
    ...old,
    outcome: old.outcome ?? 'superseded',
    active: Object.fromEntries(Object.entries(old.active).map(([id, r]) => [id, { ...r, orphaned: true as const }])),
  };
  return {
    state: { version: 5, session_id: sessionId, updated_at: now.toISOString(), current, history: [retired, ...prev.history].slice(0, MAX_HISTORY), ...leanSeenOf(prev) },
    superseded: unfinished,
  };
};

export interface ReservationInput {
  role: OwnedRole;
  taskId: string | null;
  /** A4/T1: the contract hash the dispatch is made under; `null` for a planner, `''` where there is no contract. */
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
  return { ...gen, active };
};

export const activeWorkers = (gen: JobGeneration): Reservation[] => Object.values(gen.active).filter((r) => r.role === 'worker');

/**
 * T1/T2: the tasks a writer is running right now. Deleting a reservation is not observing a termination, so this is
 * the only thing that says a task is in flight; a task in it has no settled result, whatever its last receipt says.
 */
export const activeTaskIds = (gen: JobGeneration): Set<string> =>
  new Set(activeWorkers(gen).flatMap((r) => (r.task_id === null ? [] : [r.task_id])));

export const activePlanners = (gen: JobGeneration): Reservation[] => Object.values(gen.active).filter((r) => r.role === 'planner');

export const activeDeliverables = (gen: JobGeneration, exceptTaskId: string | null): string[] =>
  activeWorkers(gen)
    .filter((r) => r.task_id !== exceptTaskId)
    .flatMap((r) => r.deliverables);

export type BoundKind = 'planner' | 'replan' | 'task';

/** A7: per-job bounds. Beyond them dispatch is denied with a terminal explanation instead of looping. */
export const boundExhausted = (gen: JobGeneration, kind: BoundKind, taskId: string | null): boolean => {
  if (kind === 'planner') return gen.attempts.planner >= MAX_PLANNER_ATTEMPTS;
  if (kind === 'replan') return gen.attempts.replans >= MAX_REPLANS;
  return (own(gen.attempts.tasks, taskId ?? '') ?? 0) >= MAX_TASK_ATTEMPTS;
};

export const countAttempt = (gen: JobGeneration, kind: BoundKind, taskId: string | null): JobGeneration => {
  if (kind === 'planner') return { ...gen, attempts: { ...gen.attempts, planner: gen.attempts.planner + 1 } };
  if (kind === 'replan') return { ...gen, attempts: { ...gen.attempts, replans: gen.attempts.replans + 1 } };
  const id = taskId ?? '';
  const tasks = Object.assign(emptyMap<number>(), gen.attempts.tasks, { [id]: (own(gen.attempts.tasks, id) ?? 0) + 1 });
  return { ...gen, attempts: { ...gen.attempts, tasks } };
};

/** Opportunistic retention: never removes a file whose actives are younger than 24 h, even past the 7-day cutoff. */
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
    try {
      const st = lstatSync(file);
      if (st.isSymbolicLink() || now - st.mtimeMs <= RETENTION_MS) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const current = isRecord(parsed) && isRecord(parsed['current']) ? (parsed['current'] as unknown as JobGeneration) : null;
      const freshActive = Object.values(current?.active ?? {}).some((r) => now - Date.parse(r.started_at) < ACTIVE_GRACE_MS);
      if (freshActive) continue;
      unlinkSync(file);
      removed += 1;
    } catch {
      try {
        unlinkSync(file);
        removed += 1;
      } catch {
        // A file that cannot be read or removed is left alone; cleanup is opportunistic, never required.
      }
    }
  }
  return removed;
};
