import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { Env } from './config.js';
import { stateRoot } from './job.js';

/**
 * #48 P2: an always-on, cheap liveness signal for the gate's own output, independent of `JEV_GATE_TRACE_DIR`. Every
 * repository this ships into eventually asks the same question a trace directory answers only when someone thought
 * to turn one on first: is Gate A ever actually firing, or has it been quietly declining every prompt for days.
 *
 * Written the way job.ts writes state -- 0700 dir, 0600 file, tmp+rename, refuse symlinks, size bound -- but with no
 * lock: two hook processes racing on the same file can lose one of their updates, which is acceptable for a rough
 * "is this firing at all" signal and not worth job.ts's own lock (A7) for it.
 */
export const LIVENESS_WINDOW = 50;
export const LIVENESS_MAX_BYTES = 64 * 1024;

export interface LivenessEntry {
  at: string;
  attempted: boolean;
  reason: string | null;
}

export interface LivenessState {
  version: 1;
  recent: LivenessEntry[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isEntry = (v: unknown): v is LivenessEntry =>
  isRecord(v) && typeof v['at'] === 'string' && typeof v['attempted'] === 'boolean' && (v['reason'] === null || typeof v['reason'] === 'string');

const parseLiveness = (text: string): LivenessState | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['recent'])) return null;
  return { version: 1, recent: parsed['recent'].filter(isEntry).slice(-LIVENESS_WINDOW) };
};

const isSymlink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

export const livenessPath = (env: Env): string => join(stateRoot(env), 'jev-gate', 'liveness.json');

/**
 * Read-only, best-effort: a missing, oversized, symlinked or corrupt file reads as no history rather than an error.
 * This is a liveness signal, not durable job state (contrast job.ts's `readJob`), so there is nothing here worth
 * failing a caller over -- a caller that cannot get a liveness read just says nothing, the same as a fresh install.
 */
export const readLiveness = (env: Env): LivenessState | null => {
  const file = livenessPath(env);
  try {
    if (isSymlink(join(stateRoot(env), 'jev-gate')) || isSymlink(file)) return null;
    const st = statSync(file);
    if (!st.isFile() || st.size > LIVENESS_MAX_BYTES) return null;
    return parseLiveness(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Append one entry to the ring, newest last, capped at LIVENESS_WINDOW. Best-effort: any failure here (a read-only
 * filesystem, a full disk, a symlinked path) is swallowed, because a missed liveness entry must never affect the
 * admission decision it is reporting on.
 */
export const appendLiveness = (env: Env, entry: LivenessEntry): void => {
  const dir = join(stateRoot(env), 'jev-gate');
  const file = livenessPath(env);
  // A random name opened with 'wx', rather than a predictable pid name opened with 'w': 'wx' fails on anything
  // already at the path, a planted symlink included, so the write can never follow one out of the directory and
  // truncate its target.
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The directory is checked as well as the file: a `jev-gate` that is itself a symlink would put both the ring and
    // its temp file wherever it points.
    if (isSymlink(dir) || isSymlink(file)) return;
    const prev = readLiveness(env);
    const recent = [...(prev?.recent ?? []), entry].slice(-LIVENESS_WINDOW);
    const body = JSON.stringify({ version: 1, recent });
    if (Buffer.byteLength(body, 'utf8') > LIVENESS_MAX_BYTES) return;
    const fd = openSync(tmp, 'wx', 0o600);
    created = true;
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch {
    // Only a temp file this call created is removed; whatever else sits at the name is not ours to delete.
    if (!created) return;
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file is best-effort cleanup; a leftover never becomes state (mirrors job.ts's writeAtomic).
    }
  }
};
