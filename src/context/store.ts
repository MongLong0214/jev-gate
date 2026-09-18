import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { Env } from '../config.js';
import { stateRoot } from '../job.js';

/**
 * The private-file primitives the two context stores share: directory 0700, file 0600, no symlink following. They live
 * under the same state root as the V5 job files but in their own subdirectories, so nothing here reads or writes job state.
 */
export const contextDir = (env: Env, sub: string): string => join(stateRoot(env), 'jev-gate', sub);

const isSymlink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

export const ensurePrivateDir = (dir: string): { ok: true } | { ok: false; error: string } => {
  try {
    if (isSymlink(dir)) return { ok: false, error: 'symlink' };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (isSymlink(dir) || !lstatSync(dir).isDirectory()) return { ok: false, error: 'not_a_directory' };
  } catch (err) {
    return { ok: false, error: (err as NodeJS.ErrnoException).code ?? 'mkdir_failed' };
  }
  return { ok: true };
};

/** tmp + rename, so a reader never sees a half-written record. A symlinked target is refused rather than followed. */
export const writeAtomicPrivate = (file: string, body: string): { ok: true } | { ok: false; error: string } => {
  if (isSymlink(file)) return { ok: false, error: 'symlink' };
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
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; a leftover temp file is never read as a record.
    }
    return { ok: false, error: (err as NodeJS.ErrnoException).code ?? 'write_failed' };
  }
  return { ok: true };
};

/** `wx` refuses an existing path, including a symlink, so an archive can never overwrite or be redirected. */
export const createExclusivePrivate = (file: string, body: string): { ok: true } | { ok: false; error: string } => {
  try {
    const fd = openSync(file, 'wx', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    return { ok: false, error: (err as NodeJS.ErrnoException).code ?? 'write_failed' };
  }
  return { ok: true };
};

/**
 * Sum of the regular files directly in `dir`. A concurrent writer can push the real total slightly past a cap checked
 * with this, so the cap it serves is a resource bound, not an exact quota.
 */
export const dirFileBytes = (dir: string): number => {
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) total += st.size;
    } catch {
      // A file that disappeared between the listing and the stat contributes nothing.
    }
  }
  return total;
};
