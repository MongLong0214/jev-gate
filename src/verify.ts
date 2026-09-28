import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CheckVerification } from './types.js';

/**
 * Owner review of real use, 2026-09-28: a worker grades its own work. `deterministicVerdict` checks that every required
 * check was *reported* pass, and nothing checked that it *ran* and passed. The worker's own transcript records every
 * Bash call it made and whether the host saw it fail, so a check reported as passing can be compared with its last
 * observed run.
 *
 * What this can and cannot see, stated so nobody reads more into it: a failed run is one the host marked
 * `is_error: true` (a non-zero exit, a timeout, an interrupt), a passed run one it marked `is_error: false`, and a result
 * with no mark is unknown, never a pass. A command piped into `tail` exits with `tail`'s status and reads as a pass
 * here too. A check is found only where one shell segment of a run starts with the check's command, so a check the
 * worker ran some other way is not found.
 *
 * What refuses: a check whose last run failed, and, when the whole transcript was read, a check reported as passing
 * with no passing run of its command at all -- a pass the transcript does not show is the self-grade this exists to
 * catch. A cut or missing transcript cannot show absence, and an edit after the last run does not show the check
 * failing, so those are recorded and refuse nothing.
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
  status: 'passed' | 'failed' | 'unknown';
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
        if (block['name'] === 'Bash' && typeof input['command'] === 'string') pending.set(block['id'], { command: input['command'], status: 'unknown', at });
        else if (typeof block['name'] === 'string' && WRITE_TOOLS.has(block['name'])) lastWrite = at;
      } else if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        const run = pending.get(block['tool_use_id']);
        if (!run) continue;
        pending.delete(block['tool_use_id']);
        const mark = block['is_error'];
        runs.push({ ...run, status: mark === true ? 'failed' : mark === false ? 'passed' : 'unknown' });
      }
    }
  }
  // Results arrive in completion order; parallel calls finish out of order, and "last" means the last one called.
  runs.sort((a, b) => a.at - b.at);
  return { runs, lastWrite, truncated };
};

const normalize = (command: string): string => command.replace(/\s+/g, ' ').trim();

/** Leading `NAME=value` assignments, which run the same command with a different environment. */
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

/**
 * Whether `run` ran `wanted`: some segment between `&&`, `||`, `;`, `|` or a newline starts with it, after any leading
 * environment assignments, and ends there or continues with its arguments. `echo npm test` does not run `npm test`;
 * `cd pkg && npm test -- --run` does. Quoting is not parsed, so a separator inside quotes still splits.
 */
export const runsCommand = (run: string, wanted: string): boolean =>
  run
    .split(/&&|\|\||;|\||\n/)
    .map((segment) => normalize(segment).replace(ENV_PREFIX, ''))
    .some((segment) => segment === wanted || segment.startsWith(`${wanted} `));

/**
 * `claims` pairs each check reported as passing with the command that check runs: the planned check's declared
 * command on a planned task, or the reported `check_id` itself on the single shape, which is asked to name the exact
 * command it ran. `id` is what the result lists carry, so it must be safe to store: a planned check's id, or an
 * opaque position on the single shape, never the command. A claim with no command is not judged.
 */
export const verifyChecks = (observation: WorkerObservation | null, claims: readonly { id: string; command: string | null }[]): CheckVerification => {
  if (observation === null) return { transcript: 'unavailable', contradicted: [], unobserved: [], stale: [] };
  const out: CheckVerification = { transcript: observation.truncated ? 'truncated' : 'read', contradicted: [], unobserved: [], stale: [] };
  for (const claim of claims) {
    if (claim.command === null) continue;
    const wanted = normalize(claim.command);
    if (wanted.length < 3) continue;
    const last = [...observation.runs].reverse().find((r) => runsCommand(r.command, wanted));
    if (!last || last.status === 'unknown') out.unobserved.push(claim.id);
    else if (last.status === 'failed') out.contradicted.push(claim.id);
    else if (observation.lastWrite !== null && observation.lastWrite > last.at) out.stale.push(claim.id);
  }
  return out;
};

/** Why the transcript refuses an `accept`, or null when it does not. See the module note for what refuses. */
export const refusalReason = (v: CheckVerification): string | null => {
  if (v.contradicted.length > 0) return `check ${v.contradicted.join(', ')} was reported pass, but its last run in the worker's own transcript failed`;
  if (v.transcript === 'read' && v.unobserved.length > 0)
    return `check ${v.unobserved.join(', ')} was reported pass, but the worker's own transcript shows no passing run of its command`;
  return null;
};
