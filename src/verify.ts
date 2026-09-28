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
 * here too. A check is found only where a run contains the check's own shell segments in order and nothing around them
 * can decide the exit status in their place (`runsCommand`), so a check the worker ran some other way is not found.
 * A run is also matched with its unquoted arguments under its own working directory made relative (`relativeTo`): the
 * host tells workers to write absolute paths, and in that directory the two name the same file. An unquoted pattern
 * argument that looks like such a path is read the same way, the known gap.
 *
 * What refuses: a check whose last run failed, and a check reported as passing whose passing run the gate cannot see --
 * none in a transcript read whole, none in the tail of a cut one, no transcript at all, or no command to look for. A pass the gate cannot see
 * is the self-grade this exists to catch, so it is not accepted on the worker's word; the reason says which of the
 * three it was. The cost: on a host whose transcript layout moved, every task with a reported pass comes back
 * incomplete, visibly (`transcript: unavailable`). An edit after the last passing run does not show the check failing,
 * so that is recorded and refuses nothing.
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
  /** The same run with its absolute paths under the run's working directory made relative (`relativeTo`), when any. */
  relative?: string;
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

/**
 * A run that may resolve a relative path from another directory: a `cd`, `pushd` or `popd` anywhere (quoted too, as in
 * `eval 'cd sub'`), or an option that moves a tool's base (`git -C`, `--cwd`, `--prefix`, `--root`, ...).
 */
const CHANGES_DIR = /(?:^|[\s;&|(`'"])(?:cd|pushd|popd)(?=[\s;&|)`'"]|$)|\s(?:-C|--chdir|--cwd|--prefix|--dir|--directory|--root)(?=[\s=]|$)/;
/** A segment's command word, with a leading `!` and `NAME=value` assignments; an executable's path is never rewritten. */
const COMMAND_WORD = /^\s*(?:!\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\S*/;

/**
 * The run with each unquoted argument `<cwd>/x` (or `=<cwd>/x`) read as `x`, or undefined when that changes nothing or
 * cannot be trusted. Left alone: another directory sharing the prefix (`<cwd>2/x`), a quoted argument (it may be a
 * pattern: `! grep -q '<cwd>/a' f` passing says nothing of `'a'`), a command word, a cwd of `/`, and every run that
 * changes directory.
 */
const relativeTo = (command: string, cwd: unknown): string | undefined => {
  const dir = typeof cwd === 'string' ? cwd.replace(/\/+$/, '') : '';
  if (!dir.startsWith('/') || CHANGES_DIR.test(command)) return undefined;
  const abs = new RegExp(`([\\s=])${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'g');
  const out = command
    .split(/(&&|\|\||;|\||\n)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const head = COMMAND_WORD.exec(part)![0];
      return head + part.slice(head.length).replace(abs, '$1');
    })
    .join('');
  return out === command ? undefined : out;
};

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
    const cwd = isRecord(rec) ? rec['cwd'] : undefined;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
        at += 1;
        const input = isRecord(block['input']) ? block['input'] : {};
        if (block['name'] === 'Bash' && typeof input['command'] === 'string') {
          const relative = relativeTo(input['command'], cwd);
          pending.set(block['id'], { command: input['command'], ...(relative === undefined ? {} : { relative }), status: 'unknown', at });
        } else if (typeof block['name'] === 'string' && WRITE_TOOLS.has(block['name'])) lastWrite = at;
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

/** A command line as its shell segments, at even indexes, and the separators between them; a newline separates as `;` does. */
const segments = (command: string): string[] => command.split(/(&&|\|\||;|\||\n)/).map((part, i) => (i % 2 === 1 ? (part === '\n' ? ';' : part) : normalize(part)));

/**
 * One segment of a run against one of the check: the same, or, for the check's last segment, the same followed by
 * arguments. Environment assignments the check sets must be the ones the run set; those it leaves open are ignored.
 */
const sameSegment = (have: string, want: string, last: boolean): boolean => {
  const run = ENV_PREFIX.test(want) ? have : have.replace(ENV_PREFIX, '');
  return run === want || (last && run.startsWith(`${want} `) && !/\s&$/.test(run));
};

/**
 * Whether `run` ran `wanted` in a way whose exit status is the check's own: the segments of `wanted`, split at `&&`,
 * `||`, `;`, `|` or a newline, appear in `run` in order with the same separators, only the last may carry more
 * arguments, and nothing around them can hide their result. So the match may not follow `||` (`true || npm test`
 * never runs it) and may be followed only by `&&` or a pipe: `npm test || true` and `npm test; echo done` succeed
 * whatever the tests did. A pipe is let through and is the known gap -- a pipeline exits with its last command's
 * status. `echo npm test` does not run `npm test`; `cd pkg && npm test -- --run` does, and so does an exact run of a
 * compound check such as `npm run typecheck && npm test`. Quoting is not parsed, so a separator inside quotes still
 * splits, on both sides alike.
 */
export const runsCommand = (run: string, wanted: string): boolean => {
  const have = segments(run);
  const want = segments(wanted);
  for (let i = 0; i + want.length <= have.length; i += 2) {
    const before = have[i - 1];
    const after = have[i + want.length];
    if (before === '||' || (after !== undefined && after !== '&&' && after !== '|')) continue;
    if (want.every((w, j) => (j % 2 === 1 ? have[i + j] === w : sameSegment(have[i + j]!, w, j === want.length - 1)))) return true;
  }
  return false;
};

/**
 * `claims` pairs each required check reported as passing with the command that check runs: the planned check's
 * declared command on a planned task, or the reported `check_id` itself on the single shape, which is asked to name
 * the exact command it ran. `id` is what the result lists carry, so it must be safe to store: a planned check's id, or
 * an opaque position on the single shape, never the command. A claim with no command has nothing a run could show, so
 * it is unobserved like one whose run is missing.
 */
export const verifyChecks = (observation: WorkerObservation | null, claims: readonly { id: string; command: string | null }[]): CheckVerification => {
  if (observation === null) return { transcript: 'unavailable', contradicted: [], unobserved: claims.map((c) => c.id), stale: [] };
  const out: CheckVerification = { transcript: observation.truncated ? 'truncated' : 'read', contradicted: [], unobserved: [], stale: [] };
  for (const { id, command } of claims) {
    const last = command === null || normalize(command) === '' ? undefined : [...observation.runs].reverse().find((r) => runsCommand(r.command, command) || (r.relative !== undefined && runsCommand(r.relative, command)));
    if (!last || last.status === 'unknown') out.unobserved.push(id);
    else if (last.status === 'failed') out.contradicted.push(id);
    else if (observation.lastWrite !== null && observation.lastWrite > last.at) out.stale.push(id);
  }
  return out;
};

/** Why the transcript refuses an `accept`, or null when it does not. See the module note for what refuses. */
export const refusalReason = (v: CheckVerification): string | null => {
  if (v.contradicted.length > 0) return `check ${v.contradicted.join(', ')} was reported pass, but its last run in the worker's own transcript failed`;
  if (v.unobserved.length === 0) return null;
  const which = `check ${v.unobserved.join(', ')} was reported pass`;
  if (v.transcript === 'read') return `${which}, but the worker's own transcript shows no passing run of its command`;
  if (v.transcript === 'truncated')
    return `${which}, but the last ${VERIFY_MAX_BYTES / (1024 * 1024)} MiB of the worker's transcript shows no passing run of its command, so the pass is unconfirmed`;
  return `${which}, but the worker's transcript could not be read, so the pass is unconfirmed`;
};
