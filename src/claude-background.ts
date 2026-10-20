import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isHostNoticeRow } from './recent-prompts.js';
import { subagentTranscriptPath } from './verify.js';
import type { HookInput } from './types.js';

export const dispatchMarker = (token: string): string => `\n\n[JEV_DISPATCH token=${token}]`;

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

/** #281: what taking a notice before its row uses up: a launch's one terminal notice, or one distinct Monitor event. */
export const noticeClaim = (prompt: string): string | null => {
  const envelope = noticeEnvelope(prompt);
  return envelope && `${envelope.task} ${envelope.tool ?? createHash('sha256').update(prompt).digest('hex')}`;
};

/**
 * #281: the host's killed notice for an execution a native TaskStop just ended. Its hook runs before its row, so
 * taskNoticeVerdict cannot prove it; the recorded stop can. Exactly one task, its launching tool call, status killed.
 */
export const isStopNotice = (prompt: string, stop: { agent_id: string; tool_use_id: string }): boolean => {
  const envelope = noticeEnvelope(prompt);
  return envelope?.task === stop.agent_id && envelope.tool === stop.tool_use_id && envelope.status === 'killed';
};

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
