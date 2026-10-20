import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readRecentPrompts, RECENT_PROMPT_MAX_CHARS, withRecentPrompts } from '../src/recent-prompts.js';

const tmp = mkdtempSync(join(tmpdir(), 'recent-'));
let seq = 0;
const write = (lines: unknown[]): string => {
  const p = join(tmp, `t-${(seq += 1)}.jsonl`);
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
};
const user = (content: unknown, extra: Record<string, unknown> = {}): unknown => ({ type: 'user', message: { role: 'user', content }, ...extra });

describe('readRecentPrompts (#115)', () => {
  it('returns the last three typed prompts, oldest first, without the current one', () => {
    const p = write([user('one'), user('two'), { type: 'assistant', message: { usage: { input_tokens: 1 } } }, user('three'), user('four'), user('e2e 해봐')]);
    expect(readRecentPrompts(p, 'e2e 해봐')).toEqual(['two', 'three', 'four']);
    expect(readRecentPrompts(p, 'not appended yet')).toEqual(['three', 'four', 'e2e 해봐']);
  });

  it('skips tool results, meta, sidechain, commands and interruptions', () => {
    const p = write([
      user('real'),
      user([{ type: 'tool_result', tool_use_id: 'x', content: 'out' }]),
      user('host said', { isMeta: true }),
      user('subagent', { isSidechain: true }),
      user('<command-name>/model</command-name>'),
      user('<local-command-stdout>ok</local-command-stdout>'),
      user('[Request interrupted by user]'),
      user([{ type: 'text', text: 'blocks ' }, { type: 'text', text: 'joined' }]),
      user([{ type: 'text', text: 'with image' }, { type: 'image' }]),
      'not json',
    ]);
    expect(readRecentPrompts(p, 'now')).toEqual(['real', 'blocks \njoined']);
  });

  it('#281: keeps what a person typed and skips host notices, compact summaries and scheduled turns by their row, not their text', () => {
    const notice = '<task-notification>\n<task-id>b6w41xrqn</task-id>\n<status>completed</status>\n</task-notification>';
    const p = write([
      user('typed', { promptSource: 'typed', turnOrigin: 'human', origin: { kind: 'human' } }),
      user('queued while busy', { promptSource: 'queued', turnOrigin: 'human', origin: { kind: 'human' } }),
      user('accepted suggestion', { promptSource: 'suggestion_accepted', turnOrigin: 'human' }),
      user('from -p', { promptSource: 'sdk', turnOrigin: 'sdk' }),
      user(`pasted ${notice}`, { promptSource: 'typed', turnOrigin: 'human', origin: { kind: 'human' } }),
      // 2.1.30x, 2.1.27x (no producer, no turnOrigin) and transcript-only queue variants of a native notice.
      user(notice, { promptSource: 'system', turnOrigin: 'task_notification', origin: { kind: 'task-notification', producer: 'session-task' } }),
      user(notice, { promptSource: 'system', origin: { kind: 'task-notification' } }),
      user(notice, { promptSource: 'system', origin: { kind: 'task-notification', producer: 'session-task', runId: 'r' }, queueTranscriptOnly: true }),
      user('This session is being continued from a previous conversation.', { isCompactSummary: true, isVisibleInTranscriptOnly: true, turnOrigin: 'human' }),
      user('scheduled fire', { promptSource: 'system', turnOrigin: 'scheduled', isMeta: true }),
      user('peer message', { origin: { kind: 'peer' } }),
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notice } },
      { type: 'queue-operation', operation: 'enqueue', content: notice },
    ]);
    expect(readRecentPrompts(p, 'now', 10)).toEqual(['typed', 'queued while busy', 'accepted suggestion', 'from -p', `pasted ${notice}`]);
  });

  it('drops a turn that looks like a secret instead of redacting it, and truncates long turns', () => {
    const long = 'x'.repeat(RECENT_PROMPT_MAX_CHARS + 50);
    const p = write([user('password = correct-horse-battery-staple-0000'), user(long)]);
    const out = readRecentPrompts(p, 'now');
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(RECENT_PROMPT_MAX_CHARS + ' […]'.length);
  });

  it('is empty for a missing, empty or unnamed transcript', () => {
    expect(readRecentPrompts(join(tmp, 'gone.jsonl'), 'x')).toEqual([]);
    const target = write([user('private')]); const link = join(tmp, 'symlink.jsonl'); symlinkSync(target, link);
    expect(readRecentPrompts(link, 'x')).toEqual([]);
    expect(readRecentPrompts(tmp, 'x')).toEqual([]);
    expect(readRecentPrompts(null, 'x')).toEqual([]);
    expect(readRecentPrompts(write([{ type: 'assistant', message: {} }]), 'x')).toEqual([]);
  });

  it('renders earlier turns as numbered context with the current request last', () => {
    const text = withRecentPrompts('e2e 해봐', ['a', 'b']);
    expect(text).toMatch(/1\. a\n2\. b\n\nCurrent request:\ne2e 해봐$/);
  });
});
