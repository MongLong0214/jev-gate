import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { humanInputText, isHostNoticeRow } from './recent-prompts.js';
import { subagentTranscriptPath } from './verify.js';
import type { HookInput } from './types.js';

export const dispatchMarker = (token: string): string => `\n\n[JEV_DISPATCH token=${token}]`;

/** #281: why a prompt was or was not taken as a native notice. Gate A records it, so notice inflow can be counted. */
export type NoticeBasis = 'not_notice' | 'source' | 'transcript_row' | 'host_queue' | 'unproven';

/** Suppress host-authored notice turns; this never establishes worker termination. */
export const taskNoticeVerdict = (input: HookInput): { notice: boolean; basis: NoticeBasis } => {
  const human = (basis: NoticeBasis) => ({ notice: false, basis });
  if (!input.session_id || !input.prompt_id || !input.transcript_path || !/^\s*<task-notification>/.test(input.prompt ?? '')) return human('not_notice');
  if (input.source !== undefined && input.source !== 'system') return human('source');
  // The documented author field is available before transcript flush. Require the whole machine envelope.
  if (input.source === 'system' && /^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/.test(input.prompt ?? '')) return { notice: true, basis: 'source' };
  // Older payloads lack source: only exact identity plus native transcript provenance can establish it.
  let fd: number | undefined;
  try {
    fd = openSync(input.transcript_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd); if (!st.isFile()) return human('unproven');
    // #281: a launch receipt sat up to 6.1 MiB before its notice (p90 2.3 MiB, 2026-10-17..20); 8 MiB parses in ~17 ms.
    const offset = Math.max(0, st.size - 8 * 1024 * 1024), buffer = Buffer.alloc(st.size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    // Every row read below is a user or queue row; the rest of a long session is skipped before parsing.
    const rows = buffer.toString().split('\n').flatMap(line => { if (!line.includes('"user"') && !line.includes('"queue-operation"')) return []; try { const row: unknown = JSON.parse(line); return row && typeof row === 'object' && !Array.isArray(row) ? [row as Record<string, unknown>] : []; } catch { return []; } });
    const textOf = (row: Record<string, unknown>): string | null => {
      const content = (row['message'] as { content?: unknown } | undefined)?.content;
      return typeof content === 'string' ? content : Array.isArray(content) && content.every(c => c?.type === 'text' && typeof c.text === 'string') ? content.map(c => c.text).join('\n') : null;
    };
    if (rows.some(row => isHostNoticeRow(row) && row['sessionId'] === input.session_id && (row['promptId'] === input.prompt_id || row['uuid'] === input.prompt_id) && textOf(row) === input.prompt)) return { notice: true, basis: 'transcript_row' };
    // The host runs the notice hook before flushing its user row, and 2.1.30x payloads omit source (#281: all 237
    // notices that reached Gate A on 2026-10-17..20). The notice may reuse the running turn's ID or carry a fresh one.
    // Authenticate the host queue after the last human turn AND the launch receipt of the task it reports on, never XML alone.
    if (!/^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/.test(input.prompt ?? '')) return human('unproven');
    const fields = (name: string): string[] => [...(input.prompt ?? '').matchAll(new RegExp(`<${name}>([^<>]+)</${name}>`, 'g'))].map(m => m[1]!);
    // Agent and background Bash notices name the launching tool call and output file; Monitor events name only the task.
    const tasks = fields('task-id'), tools = fields('tool-use-id'), outputs = fields('output-file');
    if (tasks.length !== 1 || tools.length > 1 || outputs.length > 1 || ![...tasks, ...tools].every(id => /^[\w-]{1,160}$/.test(id))) return human('unproven');
    // Its own row is flushed only after this hook, so a row that already carries the text is a copy of a delivered notice.
    if (rows.some(row => row['type'] === 'user' && row['sessionId'] === input.session_id && textOf(row) === input.prompt)) return human('unproven');
    // A long autonomous turn can push the last human turn out of the tail; the queue record is then after it by construction.
    const humanIndex = rows.findLastIndex(row => row['sessionId'] === input.session_id && humanInputText(row) !== null);
    const queuedIndex = rows.findLastIndex(row => row['type'] === 'queue-operation' && row['operation'] === 'enqueue' && row['sessionId'] === input.session_id && row['content'] === input.prompt);
    const at = (row: Record<string, unknown> | undefined): number => typeof row?.['timestamp'] === 'string' ? Date.parse(row['timestamp']) : NaN;
    if (queuedIndex <= humanIndex || !Number.isFinite(at(rows[queuedIndex])) || humanIndex >= 0 && !(at(rows[humanIndex]) <= at(rows[queuedIndex]))) return human('unproven');
    const receiptIndex = rows.slice(0, queuedIndex).findLastIndex(row => {
      const result = row['toolUseResult'] as Record<string, unknown> | undefined;
      const content = (row['message'] as { content?: unknown } | undefined)?.content;
      return row['type'] === 'user' && row['sessionId'] === input.session_id && row['isSidechain'] !== true && !!result && [result['agentId'], result['backgroundTaskId'], result['taskId']].includes(tasks[0]) &&
        (result['outputFile'] === undefined || result['outputFile'] === outputs[0]) && Array.isArray(content) && content.some(c => c?.type === 'tool_result' && (tools.length === 0 || c.tool_use_id === tools[0]));
    });
    // A person who spoke after the launch may have queued this text: their own prompt carries a fresh ID, while the
    // host reuses that person's turn ID for a notice it delivers in it. 74 of 244 real notices (2026-10-17..20) still
    // reach Gate A this way; without the ID, 128 would.
    if (receiptIndex < 0 || humanIndex > receiptIndex && rows[humanIndex]!['promptId'] !== input.prompt_id) return human('unproven');
    return { notice: true, basis: 'host_queue' };
  } catch { return human('unproven'); }
  finally { if (fd !== undefined) closeSync(fd); }
};
export const isNativeTaskNotification = (input: HookInput): boolean => taskNoticeVerdict(input).notice;

/** Native terminal evidence, never a launch receipt or a string taken from a newer root prompt. */
export const claudeTerminal = (input: HookInput, nativeNotification = false): { token: string | null; text: string; model: string | null; completed: boolean } | null => {
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
    const tokens = (typeof content === 'string' ? content : JSON.stringify(content ?? '')).match(/\[JEV_DISPATCH token=([a-f0-9-]{36})\]/g) ?? [];
    const last = rows(tail.toString()).filter(r => r['type'] === 'assistant').at(-1);
    const message = last?.['message'] as { content?: Array<{ type: string; text?: string }>; stop_reason?: string; model?: string } | undefined;
    if (!last || last['agentId'] !== input.agent_id || last['sessionId'] !== input.session_id || !Array.isArray(message?.content)) return null;
    const text = message.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    if (!nativeNotification && (typeof input.last_assistant_message !== 'string' || text !== input.last_assistant_message)) return null;
    let notification: 'completed' | 'failed' | null = null;
    if (nativeNotification) {
      // A user's copied XML is never terminal evidence. Require the native host's origin metadata,
      // exact session and agent, and a notification after the final child row.
      const rootFd = openSync(input.transcript_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const root = fstatSync(rootFd); if (!root.isFile()) return null;
        const offset = Math.max(0, root.size - 1024 * 1024), buffer = Buffer.alloc(root.size - offset);
        readSync(rootFd, buffer, 0, buffer.length, offset);
        for (const row of rows(buffer.toString()).reverse()) {
          const origin = row['origin'] as { kind?: unknown; producer?: unknown } | undefined;
          if (row['type'] !== 'user' || row['sessionId'] !== input.session_id || row['promptSource'] !== 'system' || row['turnOrigin'] !== 'task_notification' || origin?.kind !== 'task-notification' || origin.producer !== 'session-task') continue;
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
    return { token: tokens.length === 1 ? /token=([a-f0-9-]{36})/.exec(tokens[0]!)![1]! : null, text,
      model: typeof message.model === 'string' ? message.model : null,
      completed: last['isApiErrorMessage'] !== true && (notification ? notification === 'completed' : message.stop_reason === 'end_turn') };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
};
