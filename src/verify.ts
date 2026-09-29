import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CheckVerification } from './types.js';

/**
 * Owner review of real use, 2026-09-28: a worker grades its own work. `deterministicVerdict` checks that every required
 * check was *reported* pass, and nothing checked that it *ran* and passed. The worker's own transcript records every
 * Bash call it made and whether the host saw it fail, so a check reported as passing can be compared with what ran.
 *
 * Identity and success are separate. The default is the whole command, byte for byte. Simple commands (and a pure
 * `&&` list of them) also match with quote-aware tokens, so spaces between tokens do not matter; quotes, escapes,
 * newlines, and `|` `&&` `;` are not rewritten and are not executed. `runsCommand` is true for that whole command
 * or for a pure `&&` list that contains it. A true result is pass evidence only when the run passed. The same whole
 * command's observed failure is a contradiction. A failure or unknown result of a larger `&&` list is not: the
 * transcript does not say which segment failed or was skipped, and it does not revive an older pass. A pipe, an
 * `||` list, a following command, or a different argument is not evidence. `false | cat` passing is not `false` passing.
 *
 * The only path rewrite is a confirmed file operand of a simple `grep` (optional `!`, no-argument short flags, one
 * pattern, then file operands) under the run's observed cwd: `<cwd>/tests/a.ts` and `tests/a.ts` name that operand.
 * The executable, a quoted argument, the pattern, a sibling such as `<cwd>2/...`, and an unknown flag are left as
 * written. A relative path is compared as text, which does not prove a different directory would name the same file.
 *
 * One event index orders a Bash call and an Edit/Write/MultiEdit/NotebookEdit: the check's index is when it started,
 * and a write counts until its result is observed. A pass whose start is not after that write is stale — aged success,
 * not an observed failure. A write with no result leaves the pass unconfirmed. What refuses an accept: the same whole
 * command's last run failed; a reported pass with no passing run in the transcript (including one still pending); a
 * stale pass. This does not see an edit made inside Bash, by an external editor, or by another process, and it does
 * not judge whether the declared check was the right one.
 *
 * The cost: on a host whose transcript layout moved, every task with a reported pass comes back incomplete, visibly
 * (`transcript: unavailable`).
 */

/** The tail the reader keeps: the runs that decide are the latest ones, and the hook has a 5 s budget. */
export const VERIFY_MAX_BYTES = 8 * 1024 * 1024;

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Short grep flags that take no argument. `-e`, `-f`, `-A` and any other form are not rewritten. */
const GREP_NO_ARG = new Set('EFGHILPRVZabchilnoqrsvwxz');
/** A segment before the check that changes what a later command runs in. `cd` is matched as a word, not only as argv0. */
const SHELL_STATE = new Set([
  '.',
  'alias',
  'cd',
  'declare',
  'enable',
  'eval',
  'exec',
  'export',
  'hash',
  'local',
  'popd',
  'pushd',
  'readonly',
  'set',
  'shopt',
  'source',
  'trap',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unset',
]);
const STALE_REASON = '마지막 관측 변경 이후의 검사 결과 필요';

/** Host layout (Claude Code 2.1.283): `<project dir>/<session id>/subagents/agent-<agentId>.jsonl`. */
export const subagentTranscriptPath = (parentTranscript: string, sessionId: string, agentId: string): string | null => {
  if (!AGENT_ID_RE.test(agentId) || !SESSION_ID_RE.test(sessionId)) return null;
  return join(dirname(parentTranscript), sessionId, 'subagents', `agent-${agentId}.jsonl`);
};

export interface ObservedRun {
  command: string;
  /** The same run with a simple grep's absolute file operand under the run's cwd made relative, when that changes it. */
  relative?: string;
  status: 'passed' | 'failed' | 'unknown';
  /** Index of the Bash tool_use. Write completions use the same counter, not a second clock. */
  at: number;
}

export interface WorkerObservation {
  runs: ObservedRun[];
  /**
   * Latest observed Edit/Write completion on the same index as `ObservedRun.at`, or that write's start when its
   * result was not observed. Null when the worker wrote nothing through those tools.
   */
  lastWrite: number | null;
  /** A Write/Edit was seen whose result was not. Its start index is not a time before the check. */
  openWrite?: true;
  truncated: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Tok {
  text: string;
  start: number;
  end: number;
  quoted: boolean;
}

type Scanned = { kind: 'unsupported' } | { kind: 'simple' | 'and'; segments: Tok[][] };

/**
 * Quote-aware tokens of a simple command or a pure `&&` list. `|`, `||`, `;`, `&`, redirects, substitutions, and a
 * newline that starts another command are unsupported: the caller then keeps only a byte-identical command.
 */
const scan = (command: string): Scanned => {
  const segments: Tok[][] = [];
  let tokens: Tok[] = [];
  let start: number | null = null;
  let quoted = false;
  let quote: "'" | '"' | null = null;
  let mode: 'simple' | 'and' = 'simple';
  const n = command.length;
  let i = 0;

  const flushToken = (at: number): void => {
    if (start === null) return;
    tokens.push({ text: command.slice(start, at), start, end: at, quoted });
    start = null;
    quoted = false;
  };
  const flushSeg = (at: number): boolean => {
    flushToken(at);
    if (tokens.length === 0) return false;
    segments.push(tokens);
    tokens = [];
    return true;
  };

  while (i < n) {
    const c = command[i]!;
    if (quote !== null) {
      if (start === null) start = i;
      if (quote === "'") {
        if (c === "'") quote = null;
        i += 1;
        continue;
      }
      if (c === '\\') {
        if (i + 1 >= n) return { kind: 'unsupported' };
        i += 2;
        continue;
      }
      if (c === '"') quote = null;
      i += 1;
      continue;
    }
    if (c === '\\') {
      if (start === null) start = i;
      if (i + 1 >= n) return { kind: 'unsupported' };
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      if (start === null) start = i;
      quote = c;
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      flushToken(i);
      i += 1;
      continue;
    }
    if (c === '\n' || c === '\r') {
      flushToken(i);
      let j = i;
      while (j < n && (command[j] === '\n' || command[j] === '\r' || command[j] === ' ' || command[j] === '\t')) j += 1;
      if (j >= n) break;
      // A newline after `&&` is a gap between segments. A newline after a word starts another command.
      if (tokens.length === 0) {
        i = j;
        continue;
      }
      return { kind: 'unsupported' };
    }
    if (c === '&' && command[i + 1] === '&') {
      if (!flushSeg(i)) return { kind: 'unsupported' };
      mode = 'and';
      i += 2;
      continue;
    }
    if (c === '&' || c === '|' || c === ';' || c === '<' || c === '>' || c === '(' || c === ')' || c === '`' || c === '$') return { kind: 'unsupported' };
    if (start === null) start = i;
    i += 1;
  }
  if (quote !== null) return { kind: 'unsupported' };
  if (!flushSeg(n)) return { kind: 'unsupported' };
  if (mode === 'simple' && segments.length !== 1) return { kind: 'unsupported' };
  if (mode === 'and' && segments.length < 2) return { kind: 'unsupported' };
  return { kind: mode, segments };
};

const sameTokens = (a: readonly Tok[], b: readonly Tok[]): boolean => a.length === b.length && a.every((t, i) => t.text === b[i]!.text);

const commandWord = (tokens: readonly Tok[]): string | null => {
  let i = tokens[0]?.text === '!' ? 1 : 0;
  while (i < tokens.length && tokens[i]!.quoted === false && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!.text)) i += 1;
  return tokens[i]?.text ?? null;
};

/** True when this segment can change the shell a later segment runs in. The check's own segment is not passed here. */
const affectsFollowing = (tokens: readonly Tok[]): boolean => {
  if (tokens.some((t) => t.quoted === false && (t.text === 'cd' || t.text === 'pushd' || t.text === 'popd'))) return true;
  const word = commandWord(tokens);
  return word === null || SHELL_STATE.has(word);
};

const containsCommand = (have: readonly Tok[][], want: readonly Tok[][]): boolean => {
  if (want.length === 0 || want.length > have.length) return false;
  for (let i = 0; i + want.length <= have.length; i += 1) {
    if (!want.every((w, j) => sameTokens(w, have[i + j]!))) continue;
    if (have.slice(0, i).some(affectsFollowing)) continue;
    return true;
  }
  return false;
};

type MatchKind = 'exact' | 'success_only' | 'none';

/**
 * `exact`: the same whole command (bytes, or the same simple / pure-`&&` tokens). Its exit is the check's exit.
 * `success_only`: a pure `&&` list that contains that command and does not `cd` into it first. Overall success means
 * the command succeeded; overall failure does not say that it failed. `none`: not evidence.
 */
const commandMatch = (run: string, wanted: string): MatchKind => {
  if (run === wanted) return 'exact';
  const have = scan(run);
  const want = scan(wanted);
  if (have.kind === 'unsupported' || want.kind === 'unsupported') return 'none';
  if (have.kind === want.kind && have.segments.length === want.segments.length && have.segments.every((seg, i) => sameTokens(seg, want.segments[i]!))) return 'exact';
  if (want.segments.length < have.segments.length && containsCommand(have.segments, want.segments)) return 'success_only';
  return 'none';
};

/**
 * Whether `run` is evidence that `wanted` ran: the same whole command, or a pure `&&` list that contains it.
 * A true answer says nothing about a failed run. Callers that need the difference use the match kind internally.
 */
export const runsCommand = (run: string, wanted: string): boolean => commandMatch(run, wanted) !== 'none';

/** File operands of a simple grep, or null when this segment is not one. An ambiguous flag yields no operands. */
const grepFiles = (tokens: readonly Tok[]): Tok[] | null => {
  let i = 0;
  if (tokens[i]?.text === '!') i += 1;
  while (i < tokens.length && tokens[i]!.quoted === false && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!.text)) i += 1;
  if (tokens[i]?.text !== 'grep') return null;
  i += 1;
  const files: Tok[] = [];
  let sawPattern = false;
  let optionsDone = false;
  for (; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (!optionsDone && t.quoted === false && t.text === '--') {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && t.quoted === false && t.text.startsWith('-') && t.text !== '-') {
      const letters = t.text.slice(1);
      if (t.text.startsWith('--') || letters.length === 0 || [...letters].some((ch) => !GREP_NO_ARG.has(ch))) return [];
      continue;
    }
    if (!sawPattern) {
      sawPattern = true;
      continue;
    }
    files.push(t);
  }
  return files;
};

const relativeOperand = (token: Tok, cwd: string): string | null => {
  if (token.quoted) return null;
  const prefix = `${cwd}/`;
  if (!token.text.startsWith(prefix)) return null;
  const rel = token.text.slice(prefix.length);
  if (rel.length === 0 || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  if (/[*?$`]/.test(rel)) return null;
  return rel;
};

/**
 * The command with each confirmed grep file operand `<cwd>/x` written as `x`, or undefined when nothing changes.
 * Quoted text, the pattern, the executable, and a path that merely shares the cwd prefix are not touched.
 */
const relativize = (command: string, cwd: unknown): string | undefined => {
  const dir = typeof cwd === 'string' ? cwd.replace(/\/+$/, '') : '';
  if (!dir.startsWith('/')) return undefined;
  const scanned = scan(command);
  if (scanned.kind === 'unsupported') return undefined;
  const edits: { start: number; end: number; rel: string }[] = [];
  for (const seg of scanned.segments) {
    const files = grepFiles(seg);
    if (files === null) continue;
    for (const file of files) {
      const rel = relativeOperand(file, dir);
      if (rel !== null) edits.push({ start: file.start, end: file.end, rel });
    }
  }
  if (edits.length === 0) return undefined;
  edits.sort((a, b) => b.start - a.start);
  let out = command;
  for (const edit of edits) out = `${out.slice(0, edit.start)}${edit.rel}${out.slice(edit.end)}`;
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
  const writes = new Map<string, { start: number; end: number | null }>();
  const runs: ObservedRun[] = [];
  let seq = 0;
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
        seq += 1;
        const input = isRecord(block['input']) ? block['input'] : {};
        if (block['name'] === 'Bash' && typeof input['command'] === 'string') {
          const relative = relativize(input['command'], cwd);
          pending.set(block['id'], { command: input['command'], ...(relative === undefined ? {} : { relative }), status: 'unknown', at: seq });
        } else if (typeof block['name'] === 'string' && WRITE_TOOLS.has(block['name'])) writes.set(block['id'], { start: seq, end: null });
      } else if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        seq += 1;
        const write = writes.get(block['tool_use_id']);
        if (write !== undefined && write.end === null) write.end = seq;
        const run = pending.get(block['tool_use_id']);
        if (!run) continue;
        pending.delete(block['tool_use_id']);
        const mark = block['is_error'];
        runs.push({ ...run, status: mark === true ? 'failed' : mark === false ? 'passed' : 'unknown' });
      }
    }
  }
  // A call with no result yet is unknown. Dropping it would let an older pass stand in for it.
  for (const run of pending.values()) runs.push(run);
  runs.sort((a, b) => a.at - b.at);
  let lastWrite: number | null = null;
  let openWrite = false;
  for (const write of writes.values()) {
    if (write.end === null) openWrite = true;
    const mark = write.end ?? write.start;
    if (lastWrite === null || mark > lastWrite) lastWrite = mark;
  }
  return { runs, lastWrite, truncated, ...(openWrite ? { openWrite: true as const } : {}) };
};

const bestMatch = (run: ObservedRun, command: string): MatchKind => {
  const kind = commandMatch(run.command, command);
  if (run.relative === undefined) return kind;
  const rel = commandMatch(run.relative, command);
  if (rel === 'exact' || (rel === 'success_only' && kind === 'none')) return rel;
  return kind;
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
  // A missing write result is not a time before the check: call order and result order are one index.
  const aged = (at: number): boolean => observation.openWrite === true || (observation.lastWrite !== null && observation.lastWrite > at);
  for (const { id, command } of claims) {
    if (command === null || command.trim() === '') {
      out.unobserved.push(id);
      continue;
    }
    const matches: { run: ObservedRun; kind: 'exact' | 'success_only' }[] = [];
    for (const run of observation.runs) {
      const kind = bestMatch(run, command);
      if (kind !== 'none') matches.push({ run, kind });
    }
    // Call order, not the order the results happened to arrive in.
    matches.sort((a, b) => a.run.at - b.run.at);
    const last = matches[matches.length - 1];
    if (last === undefined) {
      out.unobserved.push(id);
      continue;
    }
    if (last.kind === 'exact' && last.run.status === 'failed') out.contradicted.push(id);
    else if (last.run.status !== 'passed') out.unobserved.push(id);
    else if (aged(last.run.at)) out.stale.push(id);
  }
  return out;
};

/** Why the transcript refuses an `accept`, or null when it does not. Failure, then a missing run, then a stale pass. */
export const refusalReason = (v: CheckVerification): string | null => {
  if (v.contradicted.length > 0) return `check ${v.contradicted.join(', ')} was reported pass, but its last run in the worker's own transcript failed`;
  if (v.unobserved.length > 0) {
    const which = `check ${v.unobserved.join(', ')} was reported pass`;
    if (v.transcript === 'read') return `${which}, but the worker's own transcript shows no passing run of its command`;
    if (v.transcript === 'truncated')
      return `${which}, but the last ${VERIFY_MAX_BYTES / (1024 * 1024)} MiB of the worker's transcript shows no passing run of its command, so the pass is unconfirmed`;
    return `${which}, but the worker's transcript could not be read, so the pass is unconfirmed`;
  }
  if (v.stale.length > 0) return `check ${v.stale.join(', ')}: ${STALE_REASON}`;
  return null;
};
