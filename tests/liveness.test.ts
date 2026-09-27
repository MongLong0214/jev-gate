import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Env } from '../src/config.js';
import { appendLiveness, LIVENESS_MAX_BYTES, LIVENESS_WINDOW, livenessPath, readLiveness } from '../src/liveness.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-liveness-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const env = (): Env => ({ JEV_GATE_STATE_DIR: join(tmp, `s${(seq += 1)}`) }) as Env;

describe('readLiveness / appendLiveness', () => {
  it('reads nothing before anything has been written', () => {
    expect(readLiveness(env())).toBeNull();
  });

  it('writes an atomic 0700 dir and 0600 file at <stateRoot>/jev-gate/liveness.json, readable back', () => {
    const e = env();
    appendLiveness(e, { at: '2026-09-27T00:00:00.000Z', attempted: true, reason: null });
    const path = livenessPath(e);
    expect(readFileSync(path, 'utf8')).toContain('2026-09-27T00:00:00.000Z');
    // 0600/0700: masked because the umask can clear group/other bits further, never add them back.
    expect(statSync(path).mode & 0o777).toBe(statSync(path).mode & 0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(statSync(join(path, '..')).mode & 0o700);
    expect(readLiveness(e)).toEqual({ version: 1, recent: [{ at: '2026-09-27T00:00:00.000Z', attempted: true, reason: null }] });
  });

  it('caps the ring at LIVENESS_WINDOW, dropping the oldest and keeping arrival order', () => {
    const e = env();
    for (let i = 0; i < LIVENESS_WINDOW + 5; i++) appendLiveness(e, { at: `t${i}`, attempted: i % 2 === 0, reason: i % 2 === 0 ? null : 'depth_below_floor' });
    const state = readLiveness(e);
    expect(state?.recent).toHaveLength(LIVENESS_WINDOW);
    expect(state?.recent[0]?.at).toBe('t5');
    expect(state?.recent.at(-1)?.at).toBe(`t${LIVENESS_WINDOW + 4}`);
  });

  it('two appends in sequence both land -- no lock, but no clobber for a non-concurrent caller either', () => {
    const e = env();
    appendLiveness(e, { at: 'a', attempted: false, reason: 'key_missing' });
    appendLiveness(e, { at: 'b', attempted: true, reason: null });
    expect(readLiveness(e)?.recent).toEqual([
      { at: 'a', attempted: false, reason: 'key_missing' },
      { at: 'b', attempted: true, reason: null },
    ]);
  });

  it('a missing file, corrupt JSON, wrong version or non-array recent all read as no history, not an error', () => {
    const cases: Array<[string, string]> = [
      ['not json', '{not json'],
      ['a JSON array', '[1,2,3]'],
      ['wrong version', JSON.stringify({ version: 2, recent: [] })],
      ['recent not an array', JSON.stringify({ version: 1, recent: 'nope' })],
      ['a JSON string', JSON.stringify('nope')],
    ];
    for (const [, body] of cases) {
      const e = env();
      const path = livenessPath(e);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, body);
      expect(readLiveness(e)).toBeNull();
    }
  });

  it('filters out malformed entries but keeps the well-formed ones alongside them', () => {
    const e = env();
    const path = livenessPath(e);
    mkdirSync(join(path, '..'), { recursive: true });
    const recent = [
      { at: 'ok1', attempted: true, reason: null },
      { at: 'bad-attempted', attempted: 'yes', reason: null },
      { attempted: true, reason: null }, // missing at
      { at: 'bad-reason', attempted: false, reason: 5 },
      { at: 'ok2', attempted: false, reason: 'depth_unknown' },
    ];
    writeFileSync(path, JSON.stringify({ version: 1, recent }));
    expect(readLiveness(e)?.recent).toEqual([
      { at: 'ok1', attempted: true, reason: null },
      { at: 'ok2', attempted: false, reason: 'depth_unknown' },
    ]);
  });

  it('a file over the byte cap reads as no history', () => {
    const e = env();
    const path = livenessPath(e);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, recent: [{ at: 'x'.repeat(LIVENESS_MAX_BYTES + 1), attempted: true, reason: null }] }));
    expect(readLiveness(e)).toBeNull();
  });

  it('never follows a symlink at the liveness path, for either read or write', () => {
    const e = env();
    const path = livenessPath(e);
    const real = join(tmp, 'symlink-target.json');
    writeFileSync(real, JSON.stringify({ version: 1, recent: [{ at: 'sneaky', attempted: true, reason: null }] }));
    mkdirSync(join(path, '..'), { recursive: true });
    symlinkSync(real, path);
    expect(readLiveness(e)).toBeNull();
    appendLiveness(e, { at: 'new', attempted: false, reason: 'key_missing' });
    // The symlink is left exactly as it was -- appendLiveness refused to write through it.
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ version: 1, recent: [{ at: 'sneaky', attempted: true, reason: null }] });
  });

  it('never throws when the state directory cannot be created', () => {
    const e = env();
    const blocked = livenessPath(e);
    mkdirSync(join(blocked, '..', '..'), { recursive: true });
    // A plain file sits where the jev-gate/ directory would need to go, so mkdirSync(..., {recursive:true}) fails.
    writeFileSync(join(blocked, '..'), '');
    expect(() => appendLiveness(e, { at: 'x', attempted: true, reason: null })).not.toThrow();
    expect(readLiveness(e)).toBeNull();
  });

  it('permission-denied on the state file is read as no history, not an error', () => {
    const e = env();
    appendLiveness(e, { at: 'a', attempted: true, reason: null });
    const path = livenessPath(e);
    chmodSync(path, 0o000);
    try {
      expect(readLiveness(e)).toBeNull();
    } finally {
      chmodSync(path, 0o600);
    }
  });
});
