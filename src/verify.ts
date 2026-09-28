import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CheckVerification } from './types.js';

/**
 * Owner review of real use, 2026-09-28: a worker grades its own work. `deterministicVerdict` checks that every required
 * check was *reported* pass, and nothing checked that it *ran* and passed. The worker's own transcript records every
 * Bash call it made and whether the host saw it fail, so a check reported as passing can be compared with its last
 * observed run.
 *
 * What this can and cannot see, stated so nobody reads more into it: a failed run is one the host marked `is_error`
 * (a non-zero exit, a timeout, an interrupt). A command piped into `tail` exits with `tail`'s status and reads as a
 * pass here too, and a check the worker ran some other way than its declared command is not found at all. So a
 * contradiction is evidence and refuses the task; an unobserved or stale check is recorded and refuses nothing.
 */

/** The tail the reader keeps: the runs that decide are the latest ones, and the hook has a 5 s budget. */
export const VERIFY_MAX_BYTES = 8 * 1024 * 1024;

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Host layout (Claude Code 2.1.283): `<project dir>/<session id>/subagents/agent-<agentId>.jsonl`. */
export const subagentTranscriptPath = (parentTranscript: string, sessionId: string, agentId: string): string | null => {
  if (!AGENT_ID_RE.test(agentId) || !SESSION_ID_RE.test(sessionId)) return null;
  return join(dirname(parentTranscript), sessionId, 'subagents', `agent-${agentId}.jsonl`);
};

export interface ObservedRun {
  command: string;
  failed: boolean;
  /** Position among the transcript's tool calls, so a run can be ordered against a later edit. */
  at: number;
}

export interface WorkerObservation {
  runs: ObservedRun[];
  /** Position of the last Edit/Write call, or null when the worker wrote nothing through those tools. */
  lastWrite: number | null;
  truncated: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads the transcript's last VERIFY_MAX_BYTES; null when there is no file to read. Never throws. */
export const readWorkerObservation = (path: string, maxBytes = VERIFY_MAX_BYTES): WorkerObservation | null => {
  let fd: number | null = null;
  let text: string;
  let truncated = false;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    truncated = size > maxBytes;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    text = buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const pending = new Map<string, ObservedRun>();
  const runs: ObservedRun[] = [];
  let lastWrite: number | null = null;
  let at = 0;
  const lines = text.split('\n');
  // A cut tail starts mid-line; that first fragment is not a record.
  for (const line of truncated ? lines.slice(1) : lines) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const content = isRecord(rec) && isRecord(rec['message']) ? rec['message']['content'] : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
        at += 1;
        const input = isRecord(block['input']) ? block['input'] : {};
        if (block['name'] === 'Bash' && typeof input['command'] === 'string') pending.set(block['id'], { command: input['command'], failed: false, at });
        else if (typeof block['name'] === 'string' && WRITE_TOOLS.has(block['name'])) lastWrite = at;
      } else if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        const run = pending.get(block['tool_use_id']);
        if (!run) continue;
        pending.delete(block['tool_use_id']);
        runs.push({ ...run, failed: block['is_error'] === true });
      }
    }
  }
  return { runs, lastWrite, truncated };
};

const normalize = (command: string): string => command.replace(/\s+/g, ' ').trim();

/**
 * `claims` pairs each check reported as passing with the command that check runs: the planned check's declared
 * command on a planned task, or the reported `check_id` itself on the single shape, which is asked to name the exact
 * command it ran. A claim with no command is not judged.
 */
export const verifyChecks = (observation: WorkerObservation | null, claims: readonly { id: string; command: string | null }[]): CheckVerification => {
  if (observation === null) return { transcript: 'unavailable', contradicted: [], unobserved: [], stale: [] };
  const out: CheckVerification = { transcript: observation.truncated ? 'truncated' : 'read', contradicted: [], unobserved: [], stale: [] };
  for (const claim of claims) {
    if (claim.command === null) continue;
    const wanted = normalize(claim.command);
    if (wanted.length < 3) continue;
    const last = [...observation.runs].reverse().find((r) => normalize(r.command).includes(wanted));
    if (!last) out.unobserved.push(claim.id);
    else if (last.failed) out.contradicted.push(claim.id);
    else if (observation.lastWrite !== null && observation.lastWrite > last.at) out.stale.push(claim.id);
  }
  return out;
};
