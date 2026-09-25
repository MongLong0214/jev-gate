import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Rec = Record<string, unknown>;

export interface CallIds {
  /** The tool_use block id, which a result and a notification name. */
  id: string;
  /** The assistant record carrying the tool_use block. */
  use: string;
  /** The user record carrying the tool_result block. */
  result: string;
}

export interface CallOptions {
  /** One assistant response writes one record per block, all sharing this id. Defaults to a fresh response. */
  messageId?: string;
  isError?: boolean;
  /** A result body other than a plain string: text blocks, an image, a tool_reference. */
  content?: unknown;
}

/**
 * A transcript shaped the way the host writes one, as checked against real sessions: a parentUuid chain, one
 * assistant block per record sharing `message.id`, `promptId` on user records only, `origin` on what a human typed,
 * and the session id on every record. Records the host never writes -- bare `{type, uuid, message}` -- are not what
 * the source adapter reads, so tests build here instead.
 */
export const conversation = (sessionId: string) => {
  const records: Rec[] = [];
  let parent: string | null = null;
  let promptId: string | null = null;
  let seq = 0;
  let messageSeq = 0;
  const nextUuid = (): string => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`;

  type Link = { parent?: string | null | undefined; chain?: boolean | undefined };
  const append = (r: Rec, opts: Link = {}): string => {
    const uuid = typeof r['uuid'] === 'string' ? r['uuid'] : nextUuid();
    records.push({
      parentUuid: opts.parent === undefined ? parent : opts.parent,
      isSidechain: false,
      userType: 'external',
      cwd: '/repo',
      sessionId,
      version: '2.1.0',
      timestamp: new Date(Date.UTC(2026, 8, 25, 0, 0, seq)).toISOString(),
      ...r,
      uuid,
    });
    if (opts.chain !== false) parent = uuid;
    return uuid;
  };

  const assistantRecord = (block: Rec, messageId: string, opts: Link = {}): string =>
    append({ type: 'assistant', message: { id: messageId, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [block], stop_reason: null } }, opts);
  const newMessageId = (): string => `msg_${String((messageSeq += 1)).padStart(4, '0')}`;
  const result = (callId: string, content: unknown, opts: { isError?: boolean | undefined; sourceToolAssistantUUID?: string } & Link = {}): string =>
    append(
      {
        type: 'user',
        promptId,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content, ...(opts.isError ? { is_error: true } : {}) }] },
        toolUseResult: typeof content === 'string' ? content : { content },
        ...(opts.sourceToolAssistantUUID ? { sourceToolAssistantUUID: opts.sourceToolAssistantUUID } : {}),
      },
      { parent: opts.parent, chain: opts.chain },
    );
  const lines = (): string[] => records.map((r) => JSON.stringify(r));

  const api = {
    records,
    sessionId,
    /** The record the next append chains from. */
    get last(): string | null {
      return parent;
    },
    /** Continue from an earlier record, leaving what came after it on an abandoned branch. */
    branchFrom(uuid: string | null): void {
      parent = uuid;
    },
    newMessageId,
    append,

    /** What a human typed: a new turn with its own prompt identity. */
    human(content: string | unknown[], id: string, extra: Rec = {}): string {
      promptId = id;
      return append({ type: 'user', promptId: id, origin: { kind: 'human' }, message: { role: 'user', content }, ...extra });
    },
    say(text: string, messageId = newMessageId(), opts: Link = {}): string {
      return assistantRecord({ type: 'text', text }, messageId, opts);
    },
    think(thinking: string, messageId = newMessageId()): string {
      return assistantRecord({ type: 'thinking', thinking, signature: 'sig' }, messageId);
    },
    /** A tool_use record and its result, the result chained from the call as the host writes it. */
    call(name: string, input: unknown, body: string, opts: CallOptions = {}): CallIds {
      const id = `toolu_${String((seq += 1)).padStart(6, '0')}`;
      const use = assistantRecord({ type: 'tool_use', id, name, input }, opts.messageId ?? newMessageId());
      const resultUuid = result(id, opts.content ?? body, { isError: opts.isError, parent: use, sourceToolAssistantUUID: use });
      return { id, use, result: resultUuid };
    },
    /** A tool_use record alone, for tests that place the result themselves. */
    use(name: string, input: unknown, messageId: string, opts: Link = {}): { id: string; use: string } {
      const id = `toolu_${String((seq += 1)).padStart(6, '0')}`;
      return { id, use: assistantRecord({ type: 'tool_use', id, name, input }, messageId, opts) };
    },
    result,
    interrupt(forToolUse = true): string {
      return append({ type: 'user', promptId, message: { role: 'user', content: [{ type: 'text', text: forToolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]' }] } });
    },
    meta(text: string): string {
      return append({ type: 'user', promptId, isMeta: true, message: { role: 'user', content: text } });
    },
    attachment(attachment: Rec): string {
      return append({ type: 'attachment', attachment });
    },
    /** A message the user typed while a turn was running. It has no user record of its own. */
    queued(prompt: string, kind = 'human'): string {
      return append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt, origin: { kind } } });
    },
    notification(callId: string | null, status: string, summary: string): string {
      const body = `<task-notification>\n${callId === null ? '' : `<tool-use-id>${callId}</tool-use-id>\n`}<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
      return append({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: body } });
    },
    localCommand(content: string): string {
      return append({ type: 'system', subtype: 'local_command', content, level: 'info' });
    },
    /**
     * A compaction as the host writes it: a boundary with no parent naming the preserved records both as a list and
     * as a segment, then the summary chained from the boundary. Later records chain from the last preserved record.
     */
    compact(summary: string, keep: readonly string[] = [], form: 'both' | 'list' | 'segment' = 'both'): { boundary: string; summary: string } {
      const summaryUuid = nextUuid();
      const meta: Rec = { trigger: 'auto', preTokens: 180000 };
      if (form !== 'segment') meta['preservedMessages'] = { anchorUuid: summaryUuid, uuids: [...keep], allUuids: [...keep] };
      if (form !== 'list' && keep.length > 0) meta['preservedSegment'] = { headUuid: keep[0], anchorUuid: summaryUuid, tailUuid: keep.at(-1) };
      const boundary = append({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info', logicalParentUuid: parent, compactMetadata: meta }, { parent: null });
      append({ type: 'user', uuid: summaryUuid, promptId, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: summary } }, { parent: boundary });
      parent = keep.at(-1) ?? summaryUuid;
      return { boundary, summary: summaryUuid };
    },
    lines,
    /** Written where the host puts it: `<dir>/<sessionId>.jsonl`, one complete record per line. */
    write(dir: string, content: readonly string[] = lines()): string {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${sessionId}.jsonl`);
      writeFileSync(path, content.join('\n') + '\n');
      return path;
    },
  };
  return api;
};

export type Conversation = ReturnType<typeof conversation>;
