import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { openTraceDir, pruneTraceDir } from '../src/trace.js';
import { setRecording } from '../src/recording.js';
import { rowOf, type CellResult } from '../src/bench/ab.js';

// Out of file descriptors: every open fails, as in a host that ran out of them mid-cell.
const exhausted = vi.hoisted(() => ({ on: false, markers: false, write: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (exhausted.on) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    return fs.openSync(...args);
  }, mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
    if (exhausted.markers) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return fs.mkdirSync(...args);
  }, writeSync: (...args: unknown[]) => {
    if (exhausted.write) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    return Reflect.apply(fs.writeSync, fs, args);
  } };
});

const tmp = mkdtempSync(join(tmpdir(), 'jev-trace-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('openTraceDir', () => {
  it('creates a private directory and writes private, atomic, randomly named phase files with join keys inside', () => {
    const dir = join(tmp, 'a', 'b');
    const opened = openTraceDir(dir, { HOME: tmp });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    const r1 = opened.writer.write('admission_intent', { session_id: 's', tool_use_id: 't', caller: { agent_id: null, agent_type: null } });
    const r2 = opened.writer.write('pre_result', { session_id: 's', tool_use_id: 't', caller: { agent_id: null, agent_type: null } });
    expect(r1.ok && r2.ok).toBe(true);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(files.every((f) => /^(admission_intent|pre_result)-[0-9a-f-]{36}\.json$/.test(f))).toBe(true);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    for (const f of files) {
      if (process.platform !== 'win32') expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
      const body = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
      expect(body).toMatchObject({ version: 5, session_id: 's', tool_use_id: 't' });
      expect(typeof body['invocation_id']).toBe('string');
      expect(f).toContain(String(body['invocation_id']));
    }
    opened.writer.finish?.({ session_id: 's' });
    const receipt = readdirSync(dir).find(name => name.startsWith('recording_complete-'))!;
    expect(JSON.parse(readFileSync(join(dir, receipt), 'utf8'))).toMatchObject({ complete: true, attempted: 2, written: 2 });
  });

  it('refuses a symlinked trace directory', () => {
    const real = join(tmp, 'real');
    const link = join(tmp, 'link');
    openTraceDir(real);
    symlinkSync(real, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(openTraceDir(link)).toMatchObject({ ok: false, error: 'trace directory is a symlink' });
  });

  it('marks a record lost before its file exists, so a reader that needs every record sees the loss', () => {
    const dir = join(tmp, 'emfile');
    const opened = openTraceDir(dir, { HOME: tmp });
    if (!opened.ok) throw new Error(opened.error);
    exhausted.on = true;
    try { expect(opened.writer.write('admission_intent', { session_id: 's' })).toEqual({ ok: false, error: 'EMFILE' }); }
    finally { exhausted.on = false; }
    const [marker, ...rest] = readdirSync(dir);
    expect(rest).toEqual([]);
    expect(marker).toMatch(/^\.admission_intent-[0-9a-f-]{36}\.failed$/);
    expect(statSync(join(dir, marker!)).isDirectory()).toBe(true);
    const cell = { cond: 'B', sid: 's', trace_complete: true, recording_version: 1, prime: {}, harness: {} } as CellResult;
    expect(rowOf(cell, null, null, dir)).toMatchObject({ jev_requests: 0, jev_cost: null });
    // A record that was written says its recorder marks such losses.
    expect(opened.writer.write('admission_result', { session_id: 's' }).ok).toBe(true);
    const record = readdirSync(dir).find(name => name.endsWith('.json'))!;
    expect(JSON.parse(readFileSync(join(dir, record), 'utf8'))).toMatchObject({ loss_marker: true });
    opened.writer.finish?.({ session_id: 's' });
    const receipt = readdirSync(dir).find(name => name.startsWith('recording_complete-'))!;
    expect(JSON.parse(readFileSync(join(dir, receipt), 'utf8'))).toMatchObject({ complete: false, attempted: 2, written: 1 });
  });

  it('retains settings-read, append and marker failures after I/O recovers', () => {
    for (const kind of ['settings', 'write', 'both']) {
      const dir = join(tmp, kind), env = { HOME: join(tmp, `home-${kind}`) };
      if (kind === 'settings') setRecording(env, true);
      const opened = openTraceDir(dir, env);
      if (!opened.ok) throw new Error(opened.error);
      exhausted.on = kind !== 'write'; exhausted.write = kind === 'write'; exhausted.markers = kind === 'both';
      try { expect(opened.writer.write('admission_intent', { session_id: 's' }).ok).toBe(false); }
      finally { exhausted.on = false; exhausted.write = false; exhausted.markers = false; }
      if (kind === 'both') expect(readdirSync(dir)).toEqual([]);
      opened.writer.finish?.({ session_id: 's' });
      const name = readdirSync(dir).find(file => file.startsWith('recording_complete-'))!;
      expect(JSON.parse(readFileSync(join(dir, name), 'utf8'))).toMatchObject({ complete: false, attempted: 1, written: 0 });
    }
    exhausted.markers = true;
    try { expect(openTraceDir(join(tmp, 'init'), { HOME: tmp })).toMatchObject({ ok: false, error: 'EACCES' }); }
    finally { exhausted.markers = false; }
  });

  it('reports write failures instead of throwing', () => {
    const opened = openTraceDir(join(tmp, 'w'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    rmSync(join(tmp, 'w'), { recursive: true, force: true });
    expect(opened.writer.write('post', {})).toMatchObject({ ok: false });
  });
});

describe('pruneTraceDir', () => {
  const DAY = 86_400_000;
  const now = Date.parse('2026-10-13T00:00:00Z');
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const file = (dir: string, name: string, ageDays: number): string => {
    const path = join(dir, name);
    writeFileSync(path, '{}');
    const at = (now - ageDays * DAY) / 1000;
    utimesSync(path, at, at);
    return path;
  };

  it('deletes only its own records older than 48 hours and leaves everything else, including symlink targets', async () => {
    const dir = join(tmp, 'prune'); mkdirSync(dir);
    const outside = join(tmp, 'prune-outside'); mkdirSync(outside);
    const target = file(outside, `post-${uuid}.json`, 30);
    file(dir, `mod_router-${uuid}.json`, 2 + 1 / DAY);
    file(dir, `.pre_intent-${uuid}.tmp`, 2 + 1 / DAY);
    file(dir, `connection_failed-${'a'.repeat(32)}.seen`, 2 + 1 / DAY);
    file(dir, `connection_failed-${'b'.repeat(32)}.seen`, 2);
    file(dir, `codex_event-${uuid.replace('0f', '1f')}.json`, 2);
    file(dir, 'notes.json', 30);
    file(dir, `post-${uuid}.json.bak`, 30);
    mkdirSync(join(dir, 'sub'));
    const nested = file(join(dir, 'sub'), `post-${uuid}.json`, 30);
    mkdirSync(join(dir, `stop-${uuid}.json`));
    symlinkSync(target, join(dir, `failure-${uuid}.json`));

    expect(await pruneTraceDir(dir, now)).toBe(3);
    expect(readdirSync(dir).sort()).toEqual(['.retention', `codex_event-${uuid.replace('0f', '1f')}.json`, `connection_failed-${'b'.repeat(32)}.seen`, `failure-${uuid}.json`, `post-${uuid}.json.bak`, 'notes.json', `stop-${uuid}.json`, 'sub'].sort());
    expect(lstatSync(join(dir, `failure-${uuid}.json`)).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{}');
    expect(readFileSync(nested, 'utf8')).toBe('{}');
  });

  it('deletes old loss markers, the writer\'s empty directory and the Mods\' file', async () => {
    const dir = join(tmp, 'prune-markers'); mkdirSync(dir);
    const at = (now - (2 * DAY + 1)) / 1000;
    mkdirSync(join(dir, `.pre_intent-${uuid}.failed`)); utimesSync(join(dir, `.pre_intent-${uuid}.failed`), at, at);
    file(dir, `.mod_router-${uuid}.failed`, 2 + 1 / DAY);
    file(dir, `.mod_compact-${uuid}.failed`, 1);
    expect(await pruneTraceDir(dir, now)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([`.mod_compact-${uuid}.failed`, '.retention']);
  });

  it('runs at most once a day per directory', async () => {
    const dir = join(tmp, 'prune-throttle'); mkdirSync(dir);
    expect(await pruneTraceDir(dir, now)).toBe(0);
    file(dir, `post-${uuid}.json`, 20);
    expect(await pruneTraceDir(dir, now + DAY / 2)).toBe(0);
    expect(readdirSync(dir)).toContain(`post-${uuid}.json`);
    expect(await pruneTraceDir(dir, now + DAY + 1)).toBe(1);
  });

  it('never follows a symlinked directory or stamp, and swallows failures', async () => {
    const real = join(tmp, 'prune-real'); mkdirSync(real);
    const old = file(real, `post-${uuid}.json`, 30);
    symlinkSync(real, join(tmp, 'prune-link'));
    expect(await pruneTraceDir(join(tmp, 'prune-link'), now)).toBe(0);
    symlinkSync(join(tmp, 'elsewhere'), join(real, '.retention'));
    expect(await pruneTraceDir(real, now)).toBe(0);
    expect(readFileSync(old, 'utf8')).toBe('{}');
    expect(await pruneTraceDir(join(tmp, 'missing'), now)).toBe(0);
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const locked = join(tmp, 'prune-locked'); mkdirSync(locked);
    file(locked, `post-${uuid}.json`, 30);
    chmodSync(locked, 0o500);
    try { await expect(pruneTraceDir(locked, now)).resolves.toBe(0); } finally { chmodSync(locked, 0o700); }
  });
});
