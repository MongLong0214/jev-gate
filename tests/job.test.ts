import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ACTIVE_GRACE_MS,
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
  it.each([
    { label: 'J1 literal interpolation marker', canary: "password='s3cure${literal}'" },
    { label: 'cookie', canary: 'sessionid=canary123' },
    { label: 'JSON', canary: '{"password":"canary-pw-123","api_key":"canary-key-456"}' },
    { label: 'I1 prefixed JSON password', canary: '{"DB_PASSWORD":"review-only-password"}' },
  ])('C4/F1: projects legacy current/history receipts and rebuilds raw background context on read and rewrite ($label)', ({ canary }) => {
    const env = freshEnv(), original = seed(env);
    const receipt = { task_id: 'single', contract_hash: '', rev: 0, attempt: 1, tool_use_id: 'call', provenance: 'worker_reported',
      reply: { status: 'blocked', summary: 'Legacy functional result', changed_files: ['src/legacy.ts'], interfaces: ['legacy(): void'], blockers: ['Needs integration', canary],
        checks: [1, 2, 3].map(i => ({ check_id: `echo ${i} ${canary}`, result: 'pass', note: canary })) }, verdict: 'invalid', verdict_reason: `check echo ${canary}: result malformed`,
      verification: { transcript: 'read', contradicted: [`echo 1 ${canary}`], unobserved: [`legacy ${canary}`, `other ${canary}`], stale: [] }, observed_model: null, root_effort: null, recorded_at: '', advisory: canary };
    const gen = { ...original.current, receipts: [receipt], background_job: true, background_context: `raw failure ${canary}`, legacy_report: canary,
      active: { legacy: { role: 'worker', task_id: 'single', contract_hash: '', rev: 0, tier: 'standard', attempt: 1, deliverables: [], started_at: '', legacy_result: canary } } };
    writeFileSync(jobPath(env, 's1'), JSON.stringify({ ...original, current: gen, history: [gen] }));
    const read = readJob(env, 's1');
    expect(JSON.stringify(read)).not.toContain(canary); expect(JSON.stringify(read)).toContain('Legacy functional result');
    expect(read.ok && read.value?.current.background_context).toContain('confirmed command pass 0');
    const rewritten = updateJob(env, 's1', prev => prev);
    expect(rewritten.ok).toBe(true);
    for (const value of [JSON.stringify(read), readFileSync(jobPath(env, 's1'), 'utf8')]) {
      for (const sentinel of [canary, 'canary-pw-123', 'canary-key-456', 'review-only-password']) expect(value).not.toContain(sentinel);
    }
    expect(JSON.stringify(read)).toContain('#1');
  });

  it('creates a private directory and file and writes atomically', () => {
    const env = freshEnv();
    const state = seed(env);
    expect(state.current).toMatchObject({ prompt_id: 'p1', shape: 'orchestrated', outcome: null });
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
    const oversized = updateJob(env3, 's1', (prev) => ({ ...(prev ?? big), current: { ...(prev ?? big).current, request: 'z'.repeat(STATE_MAX_BYTES + 1) } }));
    expect(oversized).toEqual({ ok: false, code: 'state_too_large' });
    expect(readJob(env3, 's1')).toMatchObject({ ok: true, value: { current: { request: null } } });
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
    expect(updateJob(env, 's1', (prev) => (prev ? { ...prev, current: { ...prev.current, request: 'lock recovered' } } : null))).toMatchObject({ ok: true, value: { current: { request: 'lock recovered' } } });
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
  it('refuses when asked to, and otherwise replaces it with the new state', () => {
    const env = freshEnv();
    mkdirSync(jobsDir(env), { recursive: true });
    writeFileSync(jobPath(env, 's1'), '{"version":5,');
    const fresh = (prev: JobState | null): JobState => newGeneration(prev, 's1', 'p1', 'direct').state;
    expect(updateJob(env, 's1', fresh, { refuseUnreadable: true })).toEqual({ ok: false, code: 'state_corrupt' });
    expect(readFileSync(jobPath(env, 's1'), 'utf8')).toBe('{"version":5,');
    expect(updateJob(env, 's1', fresh)).toMatchObject({ ok: true, value: { current: { prompt_id: 'p1' } } });
    updateJob(env, 's1', (prev) => (prev ? newGeneration(prev, 's1', 'p2', 'direct').state : null));
    const later = readJob(env, 's1');
    expect(later.ok && later.value?.current.prompt_id).toBe('p2');
  });
});

describe('newGeneration', () => {
  it('supersedes an unfinished generation, keeps it as history and orphans its actives', () => {
    const first = newGeneration(null, 's1', 'p1', 'orchestrated').state;
    first.current = reserve(first.current, 'toolu_1', { role: 'worker', taskId: 't1', contractHash: 'h-t1', rev: 1, tier: 'standard', attempt: 1, deliverables: ['a.ts'] });
    const second = newGeneration(first, 's1', 'p2', 'direct');
    expect(second.superseded).toBe(true);
    expect(second.state.current).toMatchObject({ prompt_id: 'p2', shape: 'direct', receipts: [] });
    expect(second.state.history[0]).toMatchObject({ prompt_id: 'p1', outcome: 'superseded' });
    expect(second.state.history[0]?.active['toolu_1']).toMatchObject({ task_id: 't1', orphaned: true });
    const third = newGeneration(second.state, 's1', 'p3', 'direct');
    expect(third.superseded).toBe(false);
    expect(third.state.history).toHaveLength(2);
  });
});

describe('reservations and bounds', () => {
  it('tracks active workers and releases them one at a time', () => {
    let gen = emptyGeneration('p1', 'orchestrated');
    gen = reserve(gen, 'toolu_1', { role: 'worker', taskId: 'single', contractHash: '', rev: null, tier: 'standard', attempt: 1, deliverables: [] });
    gen = reserve(gen, 'toolu_2', { role: 'worker', taskId: null, contractHash: null, rev: null, tier: 'fast', attempt: 1, deliverables: [] });
    expect(activeWorkers(gen)).toHaveLength(2);
    expect(Object.keys(release(gen, 'toolu_2').active)).toEqual(['toolu_1']);
    expect(activeWorkers(release(release(gen, 'toolu_1'), 'toolu_2'))).toEqual([]);
  });

  it('treats a prototype id as absent instead of resolving it through Object.prototype', () => {
    let gen = emptyGeneration('p1', 'orchestrated');
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(boundExhausted(gen, id), id).toBe(false);
      expect(own(gen.attempts.tasks, id), id).toBeUndefined();
      expect(own(gen.active, id), id).toBeUndefined();
    }
    gen = countAttempt(countAttempt(gen, 'constructor'), 'constructor');
    expect(boundExhausted(gen, 'constructor')).toBe(true);
    expect(boundExhausted(gen, 'toString')).toBe(false);
    const roundTripped = JSON.parse(JSON.stringify(gen)) as typeof gen;
    expect(boundExhausted(roundTripped, 'constructor')).toBe(true);
    expect(boundExhausted(roundTripped, 'toString')).toBe(false);
  });

  it('exhausts after two attempts per task', () => {
    let gen = emptyGeneration('p1', 'orchestrated');
    gen = countAttempt(gen, 't1');
    expect(boundExhausted(gen, 't1')).toBe(false);
    gen = countAttempt(gen, 't1');
    expect(boundExhausted(gen, 't1')).toBe(true);
    expect(boundExhausted(gen, 't2')).toBe(false);
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

  it('removes a file only under its own lock, and never one readJob would refuse', () => {
    const env = freshEnv();
    const now = Date.now();
    seed(env, 'in-use');
    writeFileSync(jobPath(env, 'unreadable'), '{"version":5,');
    // Valid JSON that readJob still refuses: no active map, or another session's state under this session's name.
    writeFileSync(jobPath(env, 'no-active'), JSON.stringify({ version: 5, session_id: 'no-active', current: {} }));
    seed(env, 'donor');
    writeFileSync(jobPath(env, 'misnamed'), readFileSync(jobPath(env, 'donor'), 'utf8'));
    // Valid state over the size bound: readJob refuses it as state_too_large, so cleanup keeps it.
    seed(env, 'oversize');
    const padded = { ...JSON.parse(readFileSync(jobPath(env, 'oversize'), 'utf8')), pad: 'x'.repeat(STATE_MAX_BYTES) };
    writeFileSync(jobPath(env, 'oversize'), JSON.stringify(padded));
    expect(readJob(env, 'no-active').ok).toBe(false);
    expect(readJob(env, 'misnamed').ok).toBe(false);
    expect(readJob(env, 'oversize')).toEqual({ ok: false, code: 'state_too_large' });
    // A live holder: no owner file, so the lock is not stale and cleanup does not wait for it.
    mkdirSync(`${jobPath(env, 'in-use')}.lock`);
    const past = (now - RETENTION_MS - 60_000) / 1000;
    const kept = ['in-use', 'unreadable', 'no-active', 'misnamed', 'oversize'];
    for (const id of kept) utimesSync(jobPath(env, id), past, past);
    expect(cleanupJobs(env, now)).toBe(0);
    for (const id of kept) expect(existsSync(jobPath(env, id))).toBe(true);
    rmSync(`${jobPath(env, 'in-use')}.lock`, { recursive: true });
    expect(cleanupJobs(env, now)).toBe(1);
    expect(existsSync(jobPath(env, 'in-use'))).toBe(false);
    expect(existsSync(`${jobPath(env, 'in-use')}.lock`)).toBe(false);
  });

  it('reads and ages out a state file written with the withdrawn Lean fields like any other (#217)', () => {
    const env = freshEnv();
    const now = Date.now();
    seed(env, 'old');
    const old = JSON.parse(readFileSync(jobPath(env, 'old'), 'utf8'));
    writeFileSync(jobPath(env, 'old'), JSON.stringify({ ...old, lean_seen: ['p1'], lean_seen_lost: true, current: { ...old.current, lean: null } }));
    expect(readJob(env, 'old')).toMatchObject({ ok: true, value: { session_id: 'old' } });
    const past = (now - RETENTION_MS - 60_000) / 1000;
    utimesSync(jobPath(env, 'old'), past, past);
    expect(cleanupJobs(env, now)).toBe(1);
    expect(existsSync(jobPath(env, 'old'))).toBe(false);
  });
});
