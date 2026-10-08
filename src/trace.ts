import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, closeSync, writeSync, renameSync, fsyncSync } from 'node:fs';
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
  | 'mod_output'
  | 'codex_router_intent'
  | 'codex_router_result'
  | 'codex_router_skipped'
  | 'codex_model_request'
  | 'codex_model_failure'
  | 'codex_router_response'
  | 'codex_route_applied'
  | 'codex_compact'
  | 'codex_event'
  | 'codex_output'
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
  | 'interpretation_result'
  /** JGL: the lean selection pair, the local decision that needed no call, and the owned dispatch and its result. */
  | 'lean_intent'
  | 'lean_result'
  | 'lean_dispatch'
  | 'lean_post'
  /** The evidence MCP server records only bounded metadata; source text and goals stay out. */
  | 'evidence_start'
  | 'evidence_jev_intent'
  | 'evidence_jev_result'
  | 'evidence_cache'
  | 'evidence_result';


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
