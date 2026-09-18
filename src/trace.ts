import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, closeSync, writeSync, renameSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Opt-in local recorder (#14 §2). Writes one private file per phase with random names, atomically (tmp + rename).
 * Records carry their own join keys (session_id, caller, tool_use_id); filenames are never identities.
 * Refuses a symlinked trace directory. Never receives keys, headers or environment dumps: callers whitelist fields.
 */
export type TracePhase = 'prompt' | 'pre_intent' | 'pre_result' | 'post' | 'failure';

export interface TraceRecordBase {
  version: 4;
  phase: TracePhase;
  invocation_id: string;
  written_at: string;
  session_id: string | null;
  caller: { agent_id: string | null; agent_type: string | null };
  tool_use_id: string | null;
}

export interface TraceWriter {
  write(phase: TracePhase, body: Record<string, unknown>): { ok: true; file: string } | { ok: false; error: string };
}

const isSymlink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

export const openTraceDir = (dir: string): { ok: true; writer: TraceWriter } | { ok: false; error: string } => {
  try {
    if (isSymlink(dir)) return { ok: false, error: 'trace directory is a symlink' };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (isSymlink(dir) || !lstatSync(dir).isDirectory()) return { ok: false, error: 'trace path is not a directory' };
  } catch (err) {
    return { ok: false, error: (err as NodeJS.ErrnoException).code ?? 'mkdir_failed' };
  }
  const writer: TraceWriter = {
    write(phase, body) {
      const id = randomUUID();
      const finalPath = join(dir, `${phase}-${id}.json`);
      const tmpPath = join(dir, `.${phase}-${id}.tmp`);
      try {
        const fd = openSync(tmpPath, 'wx', 0o600);
        try {
          writeSync(fd, JSON.stringify({ ...body, invocation_id: id, phase, version: 4, written_at: new Date().toISOString() }, null, 2));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmpPath, finalPath);
        return { ok: true, file: finalPath };
      } catch (err) {
        return { ok: false, error: (err as NodeJS.ErrnoException).code ?? 'write_failed' };
      }
    },
  };
  return { ok: true, writer };
};
