import { mkdtempSync, readSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { clipPrompt, humanInputText, readCurrentTaskPrompts, RECENT_PROMPT_MAX_CHARS, selectRecentPrompts } from '../src/recent-prompts.js';

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

  it('clipPrompt never splits a surrogate pair and leaves a request within the bound as it was', () => {
    const emoji = 'x'.repeat(RECENT_PROMPT_MAX_CHARS - 1) + '😀tail';
    expect(clipPrompt(emoji)).toBe(`${'x'.repeat(RECENT_PROMPT_MAX_CHARS - 1)} […]`);
    expect(clipPrompt('짧은 요청 […] as typed')).toBe('짧은 요청 […] as typed');
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
    expect(readCurrentTaskPrompts(p)).toEqual({ ok: true, requests: [task] });
    expect(vi.mocked(readSync).mock.calls.map(c => Array.from(c)[3])).toEqual([2 * 1024 * 1024, split]);
  });

  it('returns the latest three requests of the first chunk that has one, whole, without reading further back', () => {
    const latest = 'latest task ' + 'a'.repeat(2500) + ' and keep the API';
    const p = write([user('old task'), user([{ type: 'tool_result', content: 'x'.repeat(3 * 1024 * 1024) }]), user('one'), user('two'), user('three'), user(latest)]);
    vi.mocked(readSync).mockClear();
    expect(readCurrentTaskPrompts(p)).toEqual({ ok: true, requests: ['two', 'three', latest] });
    expect(vi.mocked(readSync).mock.calls).toHaveLength(1);
    const alone = write([user('old task'), user([{ type: 'tool_result', content: 'x'.repeat(3 * 1024 * 1024) }]), user('only one')]);
    expect(readCurrentTaskPrompts(alone)).toEqual({ ok: true, requests: ['only one'] });
  });

  it('a latest request that looks like a secret anywhere in it means no current task, never an older one in its place', () => {
    const secret = 'Fix the deploy. ' + 'a'.repeat(9000) + ' password = correct-horse-battery-staple-0000';
    const p = write([user('old task'), user([{ type: 'tool_result', content: 'x'.repeat(3 * 1024 * 1024) }]), user('earlier'), user(secret)]);
    vi.mocked(readSync).mockClear();
    expect(readCurrentTaskPrompts(p)).toEqual({ ok: false, reason: 'input_secret' });
    expect(vi.mocked(readSync).mock.calls).toHaveLength(1);
  });

  it('an earlier request that looks like a secret is left out, not replaced by an older one', () => {
    const p = write([user('oldest'), user('password = correct-horse-battery-staple-0000'), user('middle'), user('latest')]);
    expect(readCurrentTaskPrompts(p)).toEqual({ ok: true, requests: ['middle', 'latest'] });
  });

  it('reaches the file start without treating tool output, notices, summaries, commands, meta or sidechain rows as a task', () => {
    const p = write([user('sidechain', { isSidechain: true }), user('meta', { isMeta: true }), user('<command-name>/compact</command-name>'),
      user('notice', { promptSource: 'system', origin: { kind: 'task-notification' } }), user('summary', { isCompactSummary: true }),
      user([{ type: 'tool_result', content: 'x'.repeat(3 * 1024 * 1024) }])]);
    expect(readCurrentTaskPrompts(p)).toEqual({ ok: false, reason: 'no_current_task' });
  });

  it('rejects missing paths, symlinks, directories and empty transcripts', () => {
    const target = write([user('private')]); const link = join(tmp, 'current-task-symlink.jsonl'); symlinkSync(target, link);
    for (const p of [null, undefined, '', join(tmp, 'missing-current.jsonl'), link, tmp, write([])]) expect(readCurrentTaskPrompts(p)).toEqual({ ok: false, reason: 'no_current_task' });
  });
});
