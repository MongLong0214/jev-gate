import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isHostNoticeRow, isWorkerNoticeRow } from './recent-prompts.js';
import { subagentTranscriptPath } from './verify.js';
import type { BackgroundTaskBrief, HookInput } from './types.js';
import { parseDispatchMarker } from './claude-dispatch.js';
import { looksSecret } from './outbound-text.js';
import { carriesWorkerReport } from './plan.js';

export { dispatchMarker } from './claude-dispatch.js';

/** #281: why a prompt was or was not taken as a native notice. Gate A records it, so notice inflow can be counted. */
export type NoticeBasis = 'not_notice' | 'source' | 'transcript_row' | 'task_stop' | 'launch_receipt' | 'unproven';

/** Suppress host-authored notice turns; this never establishes worker termination. */
export const taskNoticeVerdict = (input: HookInput): { notice: boolean; basis: NoticeBasis; launched?: true; delivered?: true } => {
  const human = (basis: NoticeBasis) => ({ notice: false, basis });
  if (!input.session_id || !input.prompt_id || !input.transcript_path || !/^\s*<task-notification>/.test(input.prompt ?? '')) return human('not_notice');
  if (input.source !== undefined && input.source !== 'system') return human('source');
  // The documented author field is available before transcript flush. Require the whole machine envelope.
  if (input.source === 'system' && /^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/.test(input.prompt ?? '')) return { notice: true, basis: 'source' };
  // Older payloads lack source: only the host's own notice row, under this prompt's identity, can establish it.
  // #281 review: before that row is flushed nothing names the author. On 2.1.304 a person's input queued mid-turn gets
  // the running turn's prompt ID and the same enqueue record as a notice, and idle input of either author a fresh ID
  // (fake-API probe, Monitor/Bash/Agent). Such a prompt is `launched` at most: exactly one envelope naming a launch receipt
  // of this session. The hook takes that claim once under its lock (noticeClaim); anything else is a person's, for Gate A.
  let fd: number | undefined;
  try {
    fd = openSync(input.transcript_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd); if (!st.isFile()) return human('unproven');
    // #281: a launch receipt sat up to 6.1 MiB before its notice (p90 2.3 MiB, 2026-10-17..20); 8 MiB parses in ~17 ms.
    const offset = Math.max(0, st.size - 8 * 1024 * 1024), buffer = Buffer.alloc(st.size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    const rows = buffer.toString().split('\n').flatMap(line => { if (!line.includes('"user"')) return []; try { const row: unknown = JSON.parse(line); return row && typeof row === 'object' && !Array.isArray(row) ? [row as Record<string, unknown>] : []; } catch { return []; } });
    const textOf = (row: Record<string, unknown>): string | null => {
      const content = (row['message'] as { content?: unknown } | undefined)?.content;
      return typeof content === 'string' ? content : Array.isArray(content) && content.every(c => c?.type === 'text' && typeof c.text === 'string') ? content.map(c => c.text).join('\n') : null;
    };
    if (rows.some(row => isHostNoticeRow(row) && row['sessionId'] === input.session_id && (row['promptId'] === input.prompt_id || row['uuid'] === input.prompt_id) && textOf(row) === input.prompt)) return { notice: true, basis: 'transcript_row' };
    // The receipt is the host's tool_result row for the launching call: Agent `agentId`, background Bash `backgroundTaskId`,
    // Monitor `taskId`. A Monitor event names no call, so only a Monitor receipt can launch it.
    const envelope = noticeEnvelope(input.prompt ?? ''), claim = noticeClaim(input.prompt ?? '');
    // A launch whose notice row is written was delivered: a copy after it is a person's, even once the state forgot the claim.
    const delivered = rows.some(row => { const text = isHostNoticeRow(row) && row['sessionId'] === input.session_id ? textOf(row) : null; return text !== null && noticeClaim(text) === claim; });
    if (delivered) return { ...human('unproven'), delivered: true };
    const launched = envelope !== null && rows.some(row => {
      const result = row['toolUseResult'] as Record<string, unknown> | undefined;
      const content = (row['message'] as { content?: unknown } | undefined)?.content;
      return row['type'] === 'user' && row['sessionId'] === input.session_id && row['isSidechain'] !== true && !!result && typeof result === 'object' &&
        (envelope.tool === null ? result['taskId'] === envelope.task : [result['agentId'], result['backgroundTaskId'], result['taskId']].includes(envelope.task)) &&
        Array.isArray(content) && content.some(c => c?.type === 'tool_result' && (envelope.tool === null || c.tool_use_id === envelope.tool));
    });
    return launched ? { notice: false, basis: 'unproven', launched: true } : human('unproven');
  } catch { return human('unproven'); }
  finally { if (fd !== undefined) closeSync(fd); }
};
export const isNativeTaskNotification = (input: HookInput): boolean => taskNoticeVerdict(input).notice;

/** #281: the one task-notification a whole prompt is: a terminal notice names its task, launching call and status, a Monitor event only its task. */
const noticeEnvelope = (prompt: string): { task: string; tool: string | null; status: string | null } | null => {
  // An Agent's <result> is its own text: the envelope is what lies outside it.
  const outside = prompt.replace(/<result>[\s\S]*?<\/result>/g, '');
  if (!/^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/.test(prompt) || outside.split('<task-notification>').length !== 2) return null;
  const fields = (name: string): string[] => [...outside.matchAll(new RegExp(`<${name}>([^<>]*)</${name}>`, 'g'))].map(m => m[1]!);
  const [task, tool, status] = [fields('task-id'), fields('tool-use-id'), fields('status')];
  return task.length === 1 && tool.length <= 1 && status.length === tool.length ? { task: task[0]!, tool: tool[0] ?? null, status: status[0] ?? null } : null;
};

/**
 * #281: what taking a notice before its row uses up: one terminal notice of a launch, or one distinct Monitor event.
 * #416: the status is part of a launch's claim. One launch can end more than once (a worker woken after its completion
 * notice and then stopped gets a killed notice for the same task and call), and that later notice is the host's too.
 */
export const noticeClaim = (prompt: string): string | null => {
  const envelope = noticeEnvelope(prompt);
  return envelope && (envelope.tool === null ? `${envelope.task} ${createHash('sha256').update(prompt).digest('hex')}` : `${envelope.task} ${envelope.tool} ${envelope.status}`);
};

/**
 * #281: the host's killed notice for an execution a native TaskStop just ended. Its hook runs before its row, so
 * taskNoticeVerdict cannot prove it; the recorded stop can. Exactly one task, its launching tool call, status killed.
 */
export const isStopNotice = (prompt: string, stop: { agent_id: string; tool_use_id: string }): boolean => {
  const envelope = noticeEnvelope(prompt);
  return envelope?.task === stop.agent_id && envelope.tool === stop.tool_use_id && envelope.status === 'killed';
};

/** #416: the host's own bounds for a background task id and its kind and status words. */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TASK_WORD_RE = /^[A-Za-z0-9_ -]{1,40}$/;
const taskWord = (value: unknown): string => typeof value === 'string' && TASK_WORD_RE.test(value) ? value : 'unknown';
/** #416: how many of a worker's own tasks one pause records. */
export const MAX_BACKGROUND_TASKS = 32;
const DESCRIPTION_MAX = 120;

/** #416/#417: one display line of a task description, or null. Never a command line, and nothing the secret screen flags. */
const briefDescription = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const line = value.replace(/\s+/g, ' ').trim();
  if (!line || looksSecret(line)) return null;
  return line.length > DESCRIPTION_MAX ? `${line.slice(0, DESCRIPTION_MAX - 1)}…` : line;
};

/**
 * #416: Stop/SubagentStop `background_tasks` as recorded: id, kind, status and a one-line description. The host already
 * cuts a description to 1000 characters; this keeps 120 and drops `command`, which can carry anything a shell line can.
 * Null when the field is absent or is not the host's array, which is not the same as an empty one.
 *
 * Every entry with a task id is kept: the list is the whole session's, so whose task an entry is gets decided from all
 * of it, and a kind or status this record does not keep becomes `unknown` without dropping the task. The bound on what
 * is stored is applied by `backgroundWait`, after ownership.
 */
export const backgroundTaskBriefs = (raw: unknown): BackgroundTaskBrief[] | null => {
  if (!Array.isArray(raw)) return null;
  const out: BackgroundTaskBrief[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const task = item as Record<string, unknown>;
    if (typeof task['id'] !== 'string' || !TASK_ID_RE.test(task['id'])) continue;
    out.push({ id: task['id'], type: taskWord(task['type']), status: taskWord(task['status']), description: briefDescription(task['description']) });
  }
  return out;
};

/**
 * #416: the background work this worker launched, read from its own transcript: the host's receipt for each launch is
 * the tool result naming the task (`backgroundTaskId` for a shell command it ran in, or the host moved to, the
 * background; `taskId` for a Monitor). `ended` holds the shell tasks the transcript shows ending: a completion notice
 * delivered to the worker, a TaskStop it ran, or a receipt saying the task ends with the worker's final response.
 * Null when the transcript cannot be read as this worker's.
 */
export const workerBackgroundLaunches = (input: HookInput): { shells: Set<string>; monitors: Set<string>; ended: Set<string> } | null => {
  if (!input.session_id || !input.agent_id || !input.transcript_path) return null;
  const expected = subagentTranscriptPath(input.transcript_path, input.session_id, input.agent_id);
  if (!expected || input.agent_transcript_path && resolve(expected) !== resolve(input.agent_transcript_path)) return null;
  let fd: number | undefined;
  try {
    for (const path of [dirname(expected), dirname(dirname(expected))]) if (lstatSync(path).isSymbolicLink()) return null;
    fd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd); if (!st.isFile()) return null;
    // A launch can sit anywhere in the worker's run. 32 MiB is past any observed worker transcript; a cheap substring
    // test skips every row that cannot be a receipt or a notice before it is parsed.
    const start = Math.max(0, st.size - 32 * 1024 * 1024), buffer = Buffer.alloc(st.size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const shells = new Set<string>(), monitors = new Set<string>(), ended = new Set<string>();
    for (const line of buffer.toString().split('\n')) {
      if (!line.includes('"user"') || !(line.includes('askId') || line.includes('task_id') || line.includes('task-notification'))) continue;
      let row: Record<string, unknown>;
      try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue; row = parsed as Record<string, unknown>; } catch { continue; }
      if (row['type'] !== 'user' || row['sessionId'] !== input.session_id || row['agentId'] !== input.agent_id) continue;
      const result = row['toolUseResult'];
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const r = result as Record<string, unknown>;
        if (typeof r['backgroundTaskId'] === 'string' && TASK_ID_RE.test(r['backgroundTaskId'])) {
          shells.add(r['backgroundTaskId']);
          if (r['backgroundEndsWithFinalResponse'] === true) ended.add(r['backgroundTaskId']);
        } else if (typeof r['taskId'] === 'string' && TASK_ID_RE.test(r['taskId'])) monitors.add(r['taskId']);
        if (typeof r['task_id'] === 'string' && typeof r['message'] === 'string' && r['message'].startsWith(`Successfully stopped task: ${r['task_id']} (`)) ended.add(r['task_id']);
        continue;
      }
      if (!isWorkerNoticeRow(row)) continue;
      const content = (row['message'] as { content?: unknown } | undefined)?.content;
      const body = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => String(c.text ?? '')).join('\n') : '';
      for (const notice of body.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const id = /<task-id>([^<>]*)<\/task-id>/.exec(notice[1]!)?.[1];
        if (id && /<status>(?:completed|failed|killed|stopped)<\/status>/.test(notice[1]!)) ended.add(id);
      }
    }
    return { shells, monitors, ended };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
};

/**
 * #416: a worker that ends its turn while background work it launched is still running is paused, not finished: the
 * host parks it and wakes it when that work ends. A final message that carries the worker's report is its answer
 * whatever it left running, so only a turn without one can be a pause; braces in a progress message are not a report.
 *
 * `background_tasks` lists the whole session's in-flight work without owners, so only the tasks this worker's own
 * transcript launched count; the worker's own entry and every other worker's or the root's tasks never do. A host that
 * sends no `background_tasks` leaves the transcript: a shell task it launched with no recorded end. A Monitor there
 * has no end the transcript always shows, so it never holds a worker on that evidence alone.
 */
export const backgroundWait = (input: HookInput, finalText: string): { tasks: BackgroundTaskBrief[]; basis: 'host_tasks' | 'transcript' } | null => {
  if (carriesWorkerReport(finalText)) return null;
  const launches = workerBackgroundLaunches(input);
  if (!launches) return null;
  if (input.background_tasks) {
    const tasks = input.background_tasks.filter(t => t.id !== input.agent_id && (launches.shells.has(t.id) || launches.monitors.has(t.id))).slice(0, MAX_BACKGROUND_TASKS);
    return tasks.length ? { tasks, basis: 'host_tasks' } : null;
  }
  const pending = [...launches.shells].filter(id => !launches.ended.has(id)).slice(0, MAX_BACKGROUND_TASKS);
  return pending.length ? { tasks: pending.map(id => ({ id, type: 'shell', status: 'running', description: null })), basis: 'transcript' } : null;
};

/** Native terminal evidence, never a launch receipt or a string taken from a newer root prompt. */
export const claudeTerminal = (input: HookInput, nativeNotification = false): { token: string | null; text: string; model: string | null; completed: boolean; at: string | null } | null => {
  if (!input.session_id || !input.agent_id || !input.transcript_path || !nativeNotification && !input.agent_transcript_path) return null;
  const expected = subagentTranscriptPath(input.transcript_path, input.session_id, input.agent_id);
  if (!expected || input.agent_transcript_path && resolve(expected) !== resolve(input.agent_transcript_path)) return null;
  let fd: number | undefined;
  try {
    for (const path of [dirname(expected), dirname(dirname(expected))]) if (lstatSync(path).isSymbolicLink()) return null;
    fd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd); if (!st.isFile()) return null;
    // Only the opening dispatch identity and the final assistant message are needed. No full transcript export.
    const head = Buffer.alloc(Math.min(st.size, 128 * 1024)); readSync(fd, head, 0, head.length, 0);
    const start = Math.max(0, st.size - 768 * 1024);
    const tail = Buffer.alloc(st.size - start); readSync(fd, tail, 0, tail.length, start);
    const rows = (text: string) => text.split('\n').flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
    const first = rows(head.toString()).find(r => r['type'] === 'user');
    const content = (first?.['message'] as { content?: unknown } | undefined)?.content;
    const token = parseDispatchMarker(typeof content === 'string' ? content : JSON.stringify(content ?? ''));
    const last = rows(tail.toString()).filter(r => r['type'] === 'assistant').at(-1);
    const message = last?.['message'] as { content?: Array<{ type: string; text?: string }>; stop_reason?: string; model?: string } | undefined;
    if (!last || last['agentId'] !== input.agent_id || last['sessionId'] !== input.session_id || !Array.isArray(message?.content)) return null;
    const text = message.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    if (!nativeNotification && (typeof input.last_assistant_message !== 'string' || text !== input.last_assistant_message)) return null;
    let notification: 'completed' | 'failed' | null = null;
    if (nativeNotification) {
      // A user's copied XML is never terminal evidence. Share the notice classifier's host-row predicate,
      // exact session and agent, and a notification after the final child row.
      const rootFd = openSync(input.transcript_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const root = fstatSync(rootFd); if (!root.isFile()) return null;
        const offset = Math.max(0, root.size - 1024 * 1024), buffer = Buffer.alloc(root.size - offset);
        readSync(rootFd, buffer, 0, buffer.length, offset);
        for (const row of rows(buffer.toString()).reverse()) {
          if (!isHostNoticeRow(row) || row['sessionId'] !== input.session_id) continue;
          const content = (row['message'] as { content?: unknown } | undefined)?.content;
          const body = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n') : '';
          if (!body.startsWith('<task-notification>') || !body.includes(`<task-id>${input.agent_id}</task-id>`)) continue;
          const status = /<status>(completed|failed|killed)<\/status>/.exec(body)?.[1];
          if (!status || typeof row['timestamp'] !== 'string' || typeof last['timestamp'] !== 'string' || !Number.isFinite(Date.parse(row['timestamp'])) || !Number.isFinite(Date.parse(last['timestamp'])) || Date.parse(row['timestamp']) < Date.parse(last['timestamp'])) return null;
          notification = status === 'completed' ? 'completed' : 'failed'; break;
        }
      } finally { closeSync(rootFd); }
      if (!notification || !text || message.content.some(c => c.type === 'tool_use')) return null;
    }
    // The host may flush the text before it flushes the completed message row.
    // An absent stop reason is pending evidence, not a failed execution.
    if (message.stop_reason == null && last['isApiErrorMessage'] !== true && !notification) return null;
    return { token, text,
      model: typeof message.model === 'string' ? message.model : null,
      at: typeof last['timestamp'] === 'string' && Number.isFinite(Date.parse(last['timestamp'])) ? last['timestamp'] : null,
      completed: last['isApiErrorMessage'] !== true && (notification ? notification === 'completed' : message.stop_reason === 'end_turn') };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
};
