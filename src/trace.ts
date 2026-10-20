import { randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync, writeSync, renameSync, rmdirSync, fsyncSync, futimesSync } from 'node:fs';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env } from './config.js';
import { recordingStatus } from './recording.js';

/**
 * Local metadata recorder, enabled by default with a live owner switch. Writes one private file per phase with
 * random names, atomically (tmp + rename).
 * Records carry their own join keys (session_id, caller, tool_use_id); filenames are never identities.
 * Refuses a symlinked trace directory. Never receives keys, headers or environment dumps: callers whitelist fields.
 * Stored traces from earlier revisions also carry `result_intent`, `result_result`, `scope_intent`, `scope_result`,
 * the withdrawn search filter's `context_intent`/`context_result` and the removed Codex Compact's `codex_compact`;
 * nothing writes those any more, and readers of historical directories still have to handle them.
 */
export type TracePhase =
  | 'mod_router'
  | 'mod_compact'
  | 'recording_complete'
  | 'codex_router_intent'
  | 'codex_router_result'
  | 'codex_router_skipped'
  | 'codex_model_request'
  | 'codex_model_failure'
  | 'codex_router_response'
  | 'codex_route_applied'
  | 'codex_event'
  | 'admission_intent'
  | 'admission_result'
  | 'dispatch'
  | 'pre_intent'
  | 'pre_result'
  | 'post'
  | 'failure'
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
  finish?(body: Record<string, unknown>): void;
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
  const recordingId = randomUUID();
  let attempted = 0, written = 0, failed = false;
  const writer: TraceWriter = {
    write(phase, body) {
      const id = randomUUID();
      const receipt = phase === 'recording_complete';
      if (!receipt) attempted++;
      const marker = join(dir, `.${phase}-${id}.failed`);
      // A record lost while recording is on leaves `.<phase>-<uuid>.failed` beside the records, so a reader that needs
      // every record (src/bench/ab.ts) sees the loss. A directory needs no file descriptor, so it outlasts EMFILE.
      const lost = (error: string): { ok: false; error: string } => {
        failed = true;
        try { mkdirSync(marker, { mode: 0o700 }); } catch { /* A missing completion receipt also leaves the run unproven. */ }
        return { ok: false, error };
      };
      const status = recordingStatus(env);
      if (!status.enabled) {
        failed = true;
        return status.error ? lost(status.error) : { ok: false, error: 'recording_disabled' };
      }
      const finalPath = join(dir, `${phase}-${id}.json`);
      const tmpPath = join(dir, `.${phase}-${id}.tmp`);
      try {
        // Establish the incomplete write before opening a file, including when the process has no descriptors left.
        mkdirSync(marker, { mode: 0o700 });
        const fd = openSync(tmpPath, 'wx', 0o600);
        try {
          const data = Buffer.from(JSON.stringify({ ...body, invocation_id: id, recording_id: recordingId, phase, version: 5, loss_marker: true, written_at: new Date().toISOString() }, null, 2));
          for (let offset = 0; offset < data.length;) {
            const count = writeSync(fd, data, offset, data.length - offset);
            if (count <= 0) throw new Error('short_write');
            offset += count;
          }
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmpPath, finalPath);
        rmdirSync(marker);
        if (!receipt) written++;
        return { ok: true, file: finalPath };
      } catch (err) {
        return lost((err as NodeJS.ErrnoException).code ?? 'write_failed');
      }
    },
    finish(body) {
      writer.write('recording_complete', { ...body, complete: !failed && attempted === written, attempted, written });
    },
  };
  return { ok: true, writer };
};

const DAY_MS = 86_400_000;
export const TRACE_RETENTION_MS = 2 * DAY_MS;
/** Only names this writer and the mods produce: `<phase>-<uuid>.json`, an abandoned `.<phase>-<uuid>.tmp`, a loss marker `.<phase>-<uuid>.failed` and the Codex hook's
 * once-per-session connection failure marker `connection_failed-<hash>.seen` (#287), which goes with its row. */
const OWN_TRACE = /^(?:[a-z][a-z_]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json|\.[a-z][a-z_]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:tmp|failed)|connection_failed-[0-9a-f]{32}\.seen)$/;

/**
 * Deletes this tool's trace files older than 48 hours, directly in `dir`. At most once a day per directory across
 * processes: the `.retention` stamp's mtime is the last run. Records are written once, so mtime is their write time;
 * the file names carry no time. Symlinks, other names and subdirectories other than an empty loss marker are never
 * touched. Never throws.
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
        if (now - stat.mtimeMs <= TRACE_RETENTION_MS) continue;
        // This writer's loss marker is an empty directory; the Mods' is a file.
        if (stat.isFile()) { await unlink(path); removed++; }
        else if (stat.isDirectory() && name.endsWith('.failed')) { await rmdir(path); removed++; }
      } catch { /* Removed meanwhile, or not ours to remove. */ }
    }
  } catch { /* Retention is housekeeping; it never fails its caller. */ }
  return removed;
};
