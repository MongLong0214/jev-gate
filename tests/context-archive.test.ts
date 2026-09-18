import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { Env } from '../src/config.js';
import { archiveDir, ARCHIVE_SUBDIR, archiveName, archiveSearchResult } from '../src/context/archive.js';

/**
 * §8: the recovery snapshot has to exist before any replacement is proposed, because the omitted original is only
 * recoverable through it. Every failure here therefore has to end in "no omission" — the caller keeps the original —
 * rather than in a replacement whose original is gone.
 */
const tmp = mkdtempSync(join(tmpdir(), 'jev-context-archive-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const freshEnv = (): Env => ({ JEV_GATE_STATE_DIR: mkdtempSync(join(tmp, 'state-')) });
const OWNER = { sessionId: 'session-1', promptId: 'p1', toolUseId: 'toolu_1' };
const CONTENT = 'src/a.ts:1:hit\nsrc/a.ts:2:hit again';

describe('archiveSearchResult', () => {
  it('writes the call bytes verbatim under a private directory, behind a header naming the digest', () => {
    const env = freshEnv();
    const result = archiveSearchResult(env, OWNER, CONTENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = readFileSync(result.file, 'utf8');
    expect(text.startsWith('jev-gate original search result\n')).toBe(true);
    expect(text).toContain(`digest sha256:${result.digest}`);
    expect(text).toContain(`bytes ${Buffer.byteLength(CONTENT, 'utf8')}`);
    // Everything after the `--` separator line is the original, byte for byte, so a Read recovers exactly it.
    expect(text.slice(text.indexOf('\n--\n') + 4)).toBe(CONTENT);

    expect(statSync(result.file).mode & 0o777).toBe(0o600);
    expect(statSync(archiveDir(env)).mode & 0o777).toBe(0o700);
    expect(archiveDir(env).endsWith(join('jev-gate', ARCHIVE_SUBDIR))).toBe(true);
  });

  it('preserves non-ASCII text and CRLF endings without rewriting a byte', () => {
    const env = freshEnv();
    const content = 'src/ko.ts:1:한글 매치\r\nsrc/ko.ts:2:두 번째\r\n';
    const result = archiveSearchResult(env, OWNER, content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = readFileSync(result.file, 'utf8');
    expect(text.slice(text.indexOf('\n--\n') + 4)).toBe(content);
  });

  it('names the file from the owner and the digest only, so no prompt text or identifier is readable from it', () => {
    const name = archiveName(OWNER, 'a'.repeat(64));
    expect(name).toMatch(/^[0-9a-f]{64}\.txt$/);
    expect(archiveName(OWNER, 'a'.repeat(64))).toBe(name);
    expect(archiveName({ ...OWNER, toolUseId: 'toolu_2' }, 'a'.repeat(64))).not.toBe(name);
    expect(archiveName(OWNER, 'b'.repeat(64))).not.toBe(name);
  });

  it('accepts a re-archive of the same call and content instead of overwriting the snapshot', () => {
    const env = freshEnv();
    const first = archiveSearchResult(env, OWNER, CONTENT);
    const second = archiveSearchResult(env, OWNER, CONTENT);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.file).toBe(first.file);
    expect(readdirSync(archiveDir(env))).toHaveLength(1);
  });

  it('refuses a name already taken by something that is not that snapshot', () => {
    const env = freshEnv();
    const dir = archiveDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The name this exact call would claim, taken from a real archive of the same owner and content elsewhere.
    const elsewhere = archiveSearchResult(freshEnv(), OWNER, CONTENT);
    expect(elsewhere.ok).toBe(true);
    if (!elsewhere.ok) return;
    const taken = join(dir, archiveName(OWNER, elsewhere.digest));
    expect(taken.endsWith(basename(elsewhere.file))).toBe(true);
    writeFileSync(taken, 'not the snapshot', { mode: 0o600 });
    expect(archiveSearchResult(env, OWNER, CONTENT)).toEqual({ ok: false, code: 'archive_write_failed' });
  });

  it('refuses a symlinked archive directory rather than following it', () => {
    const env = freshEnv();
    const dir = archiveDir(env);
    mkdirSync(join(dir, '..'), { recursive: true, mode: 0o700 });
    symlinkSync(mkdtempSync(join(tmp, 'elsewhere-')), dir);
    expect(archiveSearchResult(env, OWNER, CONTENT)).toEqual({ ok: false, code: 'archive_dir_failed' });
  });

  it('stops at the directory cap instead of deleting a snapshot something still refers to', () => {
    const env = freshEnv();
    const existing = archiveSearchResult(env, OWNER, CONTENT);
    expect(existing.ok).toBe(true);
    if (!existing.ok) return;

    const before = readdirSync(archiveDir(env));
    const capped = archiveSearchResult(env, { ...OWNER, toolUseId: 'toolu_2' }, 'a different result entirely', 1);
    expect(capped).toEqual({ ok: false, code: 'archive_cap_reached' });
    // Nothing was written and nothing was reclaimed: the cap bounds growth, it does not evict.
    expect(readdirSync(archiveDir(env))).toEqual(before);
    expect(readFileSync(existing.file, 'utf8')).toContain(CONTENT);
  });

  it('gives two different calls their own snapshots even when the content is identical', () => {
    const env = freshEnv();
    const a = archiveSearchResult(env, OWNER, CONTENT);
    const b = archiveSearchResult(env, { ...OWNER, toolUseId: 'toolu_2' }, CONTENT);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.file).not.toBe(b.file);
    expect(readdirSync(archiveDir(env))).toHaveLength(2);
  });
});
