import { mkdtempSync, readSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { humanInputText, readCurrentTaskPrompts, RECENT_PROMPT_MAX_CHARS, selectRecentPrompts } from '../src/recent-prompts.js';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});

const tmp = mkdtempSync(join(tmpdir(), 'recent-'));
let seq = 0;
const write = (lines: unknown[]): string => {
  const p = join(tmp, `t-${(seq += 1)}.jsonl`);
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
};
const user = (content: unknown, extra: Record<string, unknown> = {}): unknown => ({ type: 'user', message: { role: 'user', content }, ...extra });

describe('shared human input classification and selection', () => {
  it('keeps human rows and excludes host notices, summaries, commands, meta, sidechain and non-text blocks', () => {
    const notice = '<task-notification><task-id>task1</task-id></task-notification>';
    expect(humanInputText(user('typed', { promptSource: 'typed', origin: { kind: 'human' } }))).toBe('typed');
    expect(humanInputText(user('queued', { promptSource: 'queued' }))).toBe('queued');
    expect(humanInputText(user('accepted suggestion', { promptSource: 'suggestion_accepted', turnOrigin: 'human' }))).toBe('accepted suggestion');
    expect(humanInputText(user('from -p', { promptSource: 'sdk', turnOrigin: 'sdk' }))).toBe('from -p');
    expect(humanInputText(user(`quoted ${notice}`, { promptSource: 'typed', origin: { kind: 'human' } }))).toBe(`quoted ${notice}`);
    for (const row of [
      user(notice, { promptSource: 'system', origin: { kind: 'task-notification' } }),
      user(notice, { promptSource: 'system', turnOrigin: 'task_notification', origin: { kind: 'task-notification', producer: 'session-task' } }),
      user(notice, { promptSource: 'system', origin: { kind: 'task-notification', producer: 'session-task', runId: 'r' }, queueTranscriptOnly: true }),
      user('summary', { isCompactSummary: true }), user('meta', { isMeta: true }), user('sidechain', { isSidechain: true }),
      user('<command-name>/model</command-name>'), user('[Request interrupted by user]'),
      user([{ type: 'tool_result', content: 'out' }]), user([{ type: 'text', text: 'with image' }, { type: 'image' }]),
      user('scheduled', { promptSource: 'system' }), user('peer', { origin: { kind: 'peer' } }),
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notice } },
      { type: 'queue-operation', operation: 'enqueue', content: notice },
    ]) expect(humanInputText(row)).toBeNull();
    expect(humanInputText(user([{ type: 'text', text: 'blocks ' }, { type: 'text', text: 'joined' }]))).toBe('blocks \njoined');
  });

  it('filters secrets and host commands, keeps the latest bounded requests and clips long input', () => {
    const long = 'x'.repeat(RECENT_PROMPT_MAX_CHARS + 50);
    const selected = selectRecentPrompts(['old', 'password = correct-horse-battery-staple-0000', '<local-command-stdout>hidden</local-command-stdout>', 'two', long, '  ']);
    expect(selected).toEqual(['old', 'two', `${'x'.repeat(RECENT_PROMPT_MAX_CHARS)} […]`]);
    expect(selectRecentPrompts(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd']);
  });
});

describe('readCurrentTaskPrompts (classic Compact)', () => {
  it('reads back in bounded chunks and rejoins a split human row and UTF-8 character', () => {
    const task = '현재 작업을 보존해줘';
    const row = JSON.stringify(user(task)) + '\n';
    const split = Buffer.byteLength(row.slice(0, row.indexOf(task))) + 1;
    const tool = (text: string): string => JSON.stringify(user([{ type: 'tool_result', content: text }])) + '\n';
    const tail = tool('x'.repeat(2 * 1024 * 1024 - (Buffer.byteLength(row) - split) - Buffer.byteLength(tool(''))));
    const p = join(tmp, 'split-task.jsonl');
    writeFileSync(p, row + tail);
    vi.mocked(readSync).mockClear();
    expect(readCurrentTaskPrompts(p)).toEqual([task]);
    expect(vi.mocked(readSync).mock.calls.map(c => Array.from(c)[3])).toEqual([2 * 1024 * 1024, split]);
  });

  it('stops at the first chunk with a human task and applies shared secret filtering and clipping', () => {
    const p = write([user('old task'), user([{ type: 'tool_result', content: 'x'.repeat(3 * 1024 * 1024) }]), user('latest task ' + 'a'.repeat(2500)), user('password = correct-horse-battery-staple-0000')]);
    vi.mocked(readSync).mockClear();
    expect(readCurrentTaskPrompts(p)).toEqual(['latest task ' + 'a'.repeat(RECENT_PROMPT_MAX_CHARS - 12) + ' […]']);
    expect(vi.mocked(readSync).mock.calls).toHaveLength(1);
  });

  it('reaches the file start without treating tool output, notices, summaries, commands, meta or sidechain rows as a task', () => {
    const p = write([user('sidechain', { isSidechain: true }), user('meta', { isMeta: true }), user('<command-name>/compact</command-name>'),
      user('notice', { promptSource: 'system', origin: { kind: 'task-notification' } }), user('summary', { isCompactSummary: true }),
      user([{ type: 'tool_result', content: 'x'.repeat(3 * 1024 * 1024) }])]);
    expect(readCurrentTaskPrompts(p)).toEqual([]);
  });

  it('rejects missing paths, symlinks, directories and empty transcripts', () => {
    const target = write([user('private')]); const link = join(tmp, 'current-task-symlink.jsonl'); symlinkSync(target, link);
    for (const p of [null, undefined, '', join(tmp, 'missing-current.jsonl'), link, tmp, write([])]) expect(readCurrentTaskPrompts(p)).toEqual([]);
  });
});
