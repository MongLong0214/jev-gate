import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { subagentTranscriptPath } from './verify.js';
import type { HookInput } from './types.js';

export const dispatchMarker = (token: string): string => `\n\n[JEV_DISPATCH token=${token}]`;

/** Suppress host-authored notice turns; this never establishes worker termination. */
export const isNativeTaskNotification = (input: HookInput): boolean => {
  if (input.source !== undefined && input.source !== 'system' || !input.session_id || !input.prompt_id || !input.transcript_path || !/^\s*<task-notification>/.test(input.prompt ?? '')) return false;
  // The documented author field is available before transcript flush. Require the whole machine envelope.
  if (input.source === 'system' && /^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/.test(input.prompt ?? '')) return true;
  // Older payloads lack source: only exact identity plus native transcript provenance can establish it.
  let fd: number | undefined;
  try {
    fd = openSync(input.transcript_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd); if (!st.isFile()) return false;
    const offset = Math.max(0, st.size - 1024 * 1024), buffer = Buffer.alloc(st.size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.toString().split('\n').some(line => {
      try {
        const row = JSON.parse(line) as Record<string, unknown>, origin = row['origin'] as { kind?: unknown; producer?: unknown } | undefined;
        if (row['type'] !== 'user' || row['sessionId'] !== input.session_id || row['promptSource'] !== 'system' || row['turnOrigin'] !== 'task_notification' || origin?.kind !== 'task-notification' || origin.producer !== 'session-task' || row['promptId'] !== input.prompt_id && row['uuid'] !== input.prompt_id) return false;
        const content = (row['message'] as { content?: unknown } | undefined)?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) && content.every(c => c?.type === 'text' && typeof c.text === 'string') ? content.map(c => c.text).join('\n') : null;
        return text === input.prompt;
      } catch { return false; }
    });
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
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
