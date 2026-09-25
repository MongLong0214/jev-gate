import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ACTIVE_GRACE_MS,
  activeDeliverables,
  activePlanners,
  activeTaskIds,
  activeWorkers,
  boundExhausted,
  cleanupJobs,
  countAttempt,
  emptyGeneration,
  jobPath,
  jobsDir,
  newGeneration,
  own,
  readJob,
  release,
  reserve,
  RETENTION_MS,
  stateRoot,
  STATE_MAX_BYTES,
  updateJob,
} from '../src/job.js';
import type { JobState } from '../src/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-job-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const freshEnv = (): { JEV_GATE_STATE_DIR: string } => ({ JEV_GATE_STATE_DIR: mkdtempSync(join(tmp, 'state-')) });
const seed = (env: { JEV_GATE_STATE_DIR: string }, sessionId = 's1'): JobState => {
  const written = updateJob(env, sessionId, () => newGeneration(null, sessionId, 'p1', 'orchestrated').state);
  if (!written.ok || !written.value) throw new Error('seed failed');
  return written.value;
};

describe('paths', () => {
  it('prefers JEV_GATE_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state, and hashes the session id', () => {
    expect(stateRoot({ JEV_GATE_STATE_DIR: '/a', XDG_STATE_HOME: '/b', HOME: '/c' })).toBe('/a');
    expect(stateRoot({ XDG_STATE_HOME: '/b', HOME: '/c' })).toBe('/b');
    expect(stateRoot({ HOME: '/c' })).toBe(join('/c', '.local', 'state'));
    expect(jobsDir({ HOME: '/c' })).toBe(join('/c', '.local', 'state', 'jev-gate', 'jobs'));
    const p = jobPath({ HOME: '/c' }, 'session-42');
    expect(p).toMatch(/[0-9a-f]{64}\.json$/);
    expect(p).not.toContain('session-42');
  });
});

describe('updateJob', () => {
  it('creates a private directory and file and writes atomically', () => {
    const env = freshEnv();
    const state = seed(env);
    expect(state.current).toMatchObject({ prompt_id: 'p1', shape: 'orchestrated', phase: 'admitted', outcome: null });
    if (process.platform !== 'win32') {
      expect(statSync(jobsDir(env)).mode & 0o777).toBe(0o700);
      expect(statSync(jobPath(env, 's1')).mode & 0o777).toBe(0o600);
    }
    expect(readJob(env, 's1')).toMatchObject({ ok: true, value: { session_id: 's1' } });
    expect(readJob(env, 'other-session')).toEqual({ ok: true, value: null });
  });

  it('refuses a symlinked state file and reports corrupt or oversized state', () => {
    const env = freshEnv();
    mkdirSync(jobsDir(env), { recursive: true });
    const real = join(tmp, 'real-state.json');
    writeFileSync(real, '{}');
    symlinkSync(real, jobPath(env, 's1'));
    expect(readJob(env, 's1')).toEqual({ ok: false, code: 'state_symlink' });
    expect(updateJob(env, 's1', () => newGeneration(null, 's1', 'p1', 'direct').state)).toEqual({ ok: false, code: 'state_symlink' });

    const env2 = freshEnv();
    mkdirSync(jobsDir(env2), { recursive: true });
    writeFileSync(jobPath(env2, 's1'), '{not json');
    expect(readJob(env2, 's1')).toEqual({ ok: false, code: 'state_corrupt' });

    const env3 = freshEnv();
    const big = seed(env3);
    const oversized = updateJob(env3, 's1', (prev) => ({ ...(prev ?? big), current: { ...(prev ?? big).current, plan: { rev: 1, goal: 'z'.repeat(STATE_MAX_BYTES + 1), assumptions: [], constraints: [], tasks: [], chain_depth: 0, chain_depth_claimed: null } } }));
    expect(oversized).toEqual({ ok: false, code: 'state_too_large' });
    expect(readJob(env3, 's1')).toMatchObject({ ok: true, value: { current: { plan: null } } });
  });

  it('waits for a live lock and reports state_locked, but steals a lock whose owner is gone', () => {
    const env = freshEnv();
    seed(env);
    const lock = `${jobPath(env, 's1')}.lock`;
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner'), String(process.pid));
    const started = Date.now();
    expect(updateJob(env, 's1', (prev) => prev)).toEqual({ ok: false, code: 'state_locked' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    writeFileSync(join(lock, 'owner'), '2147483646');
    expect(updateJob(env, 's1', (prev) => (prev ? { ...prev, current: { ...prev.current, denials: 7 } } : null))).toMatchObject({ ok: true, value: { current: { denials: 7 } } });
    expect(existsSync(lock)).toBe(false);
  });

  it('leaves the file untouched when the updater returns null', () => {
    const env = freshEnv();
    seed(env);
    const before = readFileSync(jobPath(env, 's1'), 'utf8');
    expect(updateJob(env, 's1', () => null)).toMatchObject({ ok: true });
    expect(readFileSync(jobPath(env, 's1'), 'utf8')).toBe(before);
  });
});

describe('updateJob over an unreadable file', () => {
  it('refuses when asked to, and otherwise records on the new state that any lean identities were lost', () => {
    const env = freshEnv();
    mkdirSync(jobsDir(env), { recursive: true });
    writeFileSync(jobPath(env, 's1'), '{"version":5,');
    const fresh = (prev: JobState | null): JobState => newGeneration(prev, 's1', 'p1', 'direct').state;
    expect(updateJob(env, 's1', fresh, { refuseUnreadable: true })).toEqual({ ok: false, code: 'state_corrupt' });
    expect(readFileSync(jobPath(env, 's1'), 'utf8')).toBe('{"version":5,');
    const recovered = updateJob(env, 's1', fresh);
    expect(recovered.ok && recovered.value?.lean_seen_lost).toBe(true);
    updateJob(env, 's1', (prev) => (prev ? newGeneration(prev, 's1', 'p2', 'direct').state : null));
    const later = readJob(env, 's1');
    expect(later.ok && later.value?.lean_seen_lost).toBe(true);
    expect(later.ok && later.value?.current.prompt_id).toBe('p2');
  });
});

describe('newGeneration', () => {
  it('supersedes an unfinished generation, keeps it as history and orphans its actives', () => {
    const first = newGeneration(null, 's1', 'p1', 'orchestrated').state;
    first.current = reserve({ ...first.current, phase: 'planned' }, 'toolu_1', { role: 'worker', taskId: 't1', contractHash: 'h-t1', rev: 1, tier: 'standard', attempt: 1, deliverables: ['a.ts'] });
    const second = newGeneration(first, 's1', 'p2', 'direct');
    expect(second.superseded).toBe(true);
    expect(second.state.current).toMatchObject({ prompt_id: 'p2', shape: 'direct', phase: 'admitted', plan: null, receipts: [] });
    expect(second.state.history[0]).toMatchObject({ prompt_id: 'p1', outcome: 'superseded' });
    expect(second.state.history[0]?.active['toolu_1']).toMatchObject({ task_id: 't1', orphaned: true });
    const third = newGeneration(second.state, 's1', 'p3', 'direct');
    expect(third.superseded).toBe(false);
    expect(third.state.history).toHaveLength(2);
  });
});

describe('reservations and bounds', () => {
  it('tracks active workers, planners, task ids and deliverables', () => {
    let gen = emptyGeneration('p1', 'orchestrated');
    gen = reserve(gen, 'toolu_1', { role: 'worker', taskId: 't1', contractHash: 'h-t1', rev: 1, tier: 'standard', attempt: 1, deliverables: ['a.ts'] });
    gen = reserve(gen, 'toolu_2', { role: 'worker', taskId: 't2', contractHash: 'h-t2', rev: 1, tier: 'fast', attempt: 1, deliverables: ['b.ts'] });
    gen = reserve(gen, 'toolu_p', { role: 'planner', taskId: null, contractHash: null, rev: null, tier: null, attempt: 1, deliverables: [] });
    expect(activeWorkers(gen)).toHaveLength(2);
    expect(activePlanners(gen)).toHaveLength(1);
    // T1: a planner holds no task, so it never appears as a task in flight.
    expect([...activeTaskIds(gen)].sort()).toEqual(['t1', 't2']);
    expect(activeDeliverables(gen, 't1')).toEqual(['b.ts']);
    expect(activeDeliverables(gen, null).sort()).toEqual(['a.ts', 'b.ts']);
    expect(Object.keys(release(gen, 'toolu_2').active).sort()).toEqual(['toolu_1', 'toolu_p']);
    // T2: releasing the last reservation removes the record, and nothing else claims the writer stopped.
    expect(activeTaskIds(release(release(gen, 'toolu_1'), 'toolu_2'))).toEqual(new Set());
  });

  it('treats a prototype id as absent instead of resolving it through Object.prototype', () => {
    let gen = emptyGeneration('p1', 'orchestrated');
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(boundExhausted(gen, 'task', id), id).toBe(false);
      expect(own(gen.attempts.tasks, id), id).toBeUndefined();
      expect(own(gen.active, id), id).toBeUndefined();
    }
    gen = countAttempt(countAttempt(gen, 'task', 'constructor'), 'task', 'constructor');
    expect(boundExhausted(gen, 'task', 'constructor')).toBe(true);
    expect(boundExhausted(gen, 'task', 'toString')).toBe(false);
    const roundTripped = JSON.parse(JSON.stringify(gen)) as typeof gen;
    expect(boundExhausted(roundTripped, 'task', 'constructor')).toBe(true);
    expect(boundExhausted(roundTripped, 'task', 'toString')).toBe(false);
  });

  it('exhausts after two planner attempts, two replans and two attempts per task', () => {
    let gen = emptyGeneration('p1', 'orchestrated');
    expect(boundExhausted(gen, 'planner', null)).toBe(false);
    gen = countAttempt(countAttempt(gen, 'planner', null), 'planner', null);
    expect(boundExhausted(gen, 'planner', null)).toBe(true);
    expect(boundExhausted(gen, 'replan', null)).toBe(false);
    gen = countAttempt(countAttempt(gen, 'replan', null), 'replan', null);
    expect(boundExhausted(gen, 'replan', null)).toBe(true);
    gen = countAttempt(gen, 'task', 't1');
    expect(boundExhausted(gen, 'task', 't1')).toBe(false);
    gen = countAttempt(gen, 'task', 't1');
    expect(boundExhausted(gen, 'task', 't1')).toBe(true);
    expect(boundExhausted(gen, 'task', 't2')).toBe(false);
  });
});

describe('cleanupJobs', () => {
  it('removes files past retention but never one with an active entry younger than 24 h', () => {
    const env = freshEnv();
    const now = Date.now();
    seed(env, 'fresh');
    seed(env, 'old');
    const withActive = updateJob(env, 'old-but-busy', (prev) => {
      const state = newGeneration(prev, 'old-but-busy', 'p1', 'orchestrated').state;
      return { ...state, current: reserve(state.current, 'toolu_1', { role: 'worker', taskId: 't1', contractHash: 'h-t1', rev: 1, tier: 'standard', attempt: 1, deliverables: [] }, new Date(now - ACTIVE_GRACE_MS / 2)) };
    });
    expect(withActive.ok).toBe(true);
    const past = (now - RETENTION_MS - 60_000) / 1000;
    utimesSync(jobPath(env, 'old'), past, past);
    utimesSync(jobPath(env, 'old-but-busy'), past, past);
    expect(cleanupJobs(env, now)).toBe(1);
    expect(existsSync(jobPath(env, 'old'))).toBe(false);
    expect(existsSync(jobPath(env, 'old-but-busy'))).toBe(true);
    expect(existsSync(jobPath(env, 'fresh'))).toBe(true);
    expect(cleanupJobs({ JEV_GATE_STATE_DIR: join(tmp, 'never-created') }, now)).toBe(0);
  });

  it('removes a file only under its own lock, and never one it cannot read or that records lost identities', () => {
    const env = freshEnv();
    const now = Date.now();
    seed(env, 'in-use');
    seed(env, 'lost');
    updateJob(env, 'lost', (prev) => (prev ? { ...prev, lean_seen_lost: true } : null));
    writeFileSync(jobPath(env, 'unreadable'), '{"version":5,');
    // A live holder: no owner file, so the lock is not stale and cleanup does not wait for it.
    mkdirSync(`${jobPath(env, 'in-use')}.lock`);
    const past = (now - RETENTION_MS - 60_000) / 1000;
    for (const id of ['in-use', 'lost', 'unreadable']) utimesSync(jobPath(env, id), past, past);
    expect(cleanupJobs(env, now)).toBe(0);
    for (const id of ['in-use', 'lost', 'unreadable']) expect(existsSync(jobPath(env, id))).toBe(true);
    rmSync(`${jobPath(env, 'in-use')}.lock`, { recursive: true });
    expect(cleanupJobs(env, now)).toBe(1);
    expect(existsSync(jobPath(env, 'in-use'))).toBe(false);
    expect(existsSync(`${jobPath(env, 'in-use')}.lock`)).toBe(false);
  });

  it('never ages out a file holding admitted lean identities: a resumed session still recognises an old request', () => {
    const env = freshEnv();
    const now = Date.now();
    seed(env, 'lean-session');
    updateJob(env, 'lean-session', (prev) => (prev ? { ...prev, lean_seen: ['p1'] } : null));
    seed(env, 'plain-session');
    const past = (now - RETENTION_MS - 60_000) / 1000;
    utimesSync(jobPath(env, 'lean-session'), past, past);
    utimesSync(jobPath(env, 'plain-session'), past, past);
    expect(cleanupJobs(env, now)).toBe(1);
    expect(existsSync(jobPath(env, 'plain-session'))).toBe(false);
    const kept = readJob(env, 'lean-session');
    expect(kept.ok && kept.value?.lean_seen).toEqual(['p1']);
  });
});
