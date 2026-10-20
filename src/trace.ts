import { randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync, writeSync, renameSync, fsyncSync, futimesSync } from 'node:fs';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env } from './config.js';
import { recordingStatus } from './recording.js';

/**
 * Local metadata recorder, enabled by default with a live owner switch. Writes one private file per phase with
 * random names, atomically (tmp + rename).
 * Records carry their own join keys (session_id, caller, tool_use_id); filenames are never identities.
 * Refuses a symlinked trace directory. Never receives keys, headers or environment dumps: callers whitelist fields.
 * Stored traces from earlier revisions also carry `result_intent`, `result_result`, `scope_intent`, `scope_result`
 * and the withdrawn search filter's `context_intent`/`context_result`; nothing writes those any more, and readers of
 * historical directories still have to handle them.
 */
export type TracePhase =
  | 'mod_router'
  | 'mod_compact'
  | 'codex_router_intent'
  | 'codex_router_result'
  | 'codex_router_skipped'
  | 'codex_model_request'
  | 'codex_model_failure'
  | 'codex_router_response'
  | 'codex_route_applied'
  | 'codex_compact'
  | 'codex_event'
  | 'admission_intent'
  | 'admission_result'
  | 'guard'
  | 'dispatch'
  | 'pre_intent'
  | 'pre_result'
  | 'post'
  | 'failure'
  | 'plan'
  | 'stop'
  | 'background_dispatch'
  | 'background_launch'
  | 'background_terminal'
  | 'background_stalled'
  | 'background_policy_delivery'
  | 'background_conversation'
  | 'dispatch_denied'
  | 'worktree_start'
  | 'worktree_result'
  /** A23: the plan-interpretation pair, joined by a shared `request_id` like every other gate call. */
  | 'interpretation_intent'
  | 'interpretation_result';


/**
 * Every record carries `version`, `phase`, `request_id` where a gate call pairs an intent with a result,
 * `invocation_id`, `written_at`, and the join keys `session_id`, `prompt_id`, `caller` and `tool_use_id`.
 * Readers parse the raw object, so the shape lives here as documentation rather than as a type nothing checks.
 */
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

export const openTraceDir = (dir: string, env: Env = process.env): { ok: true; writer: TraceWriter } | { ok: false; error: string } => {
  try {
    if (isSymlink(dir)) return { ok: false, error: 'trace directory is a symlink' };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (isSymlink(dir) || !lstatSync(dir).isDirectory()) return { ok: false, error: 'trace path is not a directory' };
  } catch (err) {
    return { ok: false, error: (err as NodeJS.ErrnoException).code ?? 'mkdir_failed' };
  }
  const writer: TraceWriter = {
    write(phase, body) {
      if (!recordingStatus(env).enabled) return { ok: false, error: 'recording_disabled' };
      const id = randomUUID();
      const finalPath = join(dir, `${phase}-${id}.json`);
      const tmpPath = join(dir, `.${phase}-${id}.tmp`);
      try {
        const fd = openSync(tmpPath, 'wx', 0o600);
        try {
          writeSync(fd, JSON.stringify({ ...body, invocation_id: id, phase, version: 5, written_at: new Date().toISOString() }, null, 2));
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

const DAY_MS = 86_400_000;
export const TRACE_RETENTION_MS = 3 * DAY_MS;
/** Only names this writer and the mods produce: `<phase>-<uuid>.json` and an abandoned `.<phase>-<uuid>.tmp`. */
const OWN_TRACE = /^(?:[a-z][a-z_]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json|\.[a-z][a-z_]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp)$/;

/**
 * Deletes this tool's trace files older than 3 days, directly in `dir`. At most once a day per directory across
 * processes: the `.retention` stamp's mtime is the last run. Records are written once, so mtime is their write time;
 * the file names carry no time. Symlinks, subdirectories and other names are never touched. Never throws.
 */
export const pruneTraceDir = async (dir: string, now = Date.now()): Promise<number> => {
  let removed = 0;
  try {
    const root = await lstat(dir);
    if (!root.isDirectory() || root.isSymbolicLink()) return 0;
    const stamp = join(dir, '.retention');
    try {
      const last = await lstat(stamp);
      if (!last.isFile() || now - last.mtimeMs < DAY_MS) return 0;
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 0; }
    // Claim the day before the slow part, so a concurrent start skips instead of repeating it.
    const fd = openSync(stamp, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { futimesSync(fd, now / 1000, now / 1000); } finally { closeSync(fd); }
    for (const name of await readdir(dir)) {
      if (!OWN_TRACE.test(name)) continue;
      const path = join(dir, name);
      try {
        const stat = await lstat(path);
        if (stat.isFile() && now - stat.mtimeMs > TRACE_RETENTION_MS) { await unlink(path); removed++; }
      } catch { /* Removed meanwhile, or not ours to remove. */ }
    }
  } catch { /* Retention is housekeeping; it never fails its caller. */ }
  return removed;
};
