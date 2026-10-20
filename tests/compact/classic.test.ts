import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RESTORE_CAP, askedPath, buildRestore, buildSteering, classicConfig, runClassicCompact, shares, transcriptMessages, heldRecords } from '../../src/claude-compact.ts';
import type { Transport } from '../../mods/router/hooks/client.ts';
import { sessionFacts } from '../../src/bench/ab.js';

const loss = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (loss.on && String(args[0]).includes('/trace/.mod_compact-')) throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
    return fs.openSync(...args);
  } };
});

const SESSION = 'b4f5b22d-d356-47c4-8e6c-dc52ae655985';
let dir: string;
let env: Record<string, string>;
let transcript: string;

type Rec = Record<string, unknown>;
const user = (text: string): Rec => ({ type: 'user', uuid: `u-${Math.random()}`, message: { role: 'user', content: text } });
const call = (n: number, result: string, isError = false): Rec[] => [
  { type: 'assistant', uuid: `a${n}`, message: { id: `m${n}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: { file_path: `/r/file${n}.ts` } }] } },
  { type: 'user', uuid: `r${n}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: result, ...(isError ? { is_error: true } : {}) }] } },
];
const write = (recs: Rec[]): void => writeFileSync(transcript, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
const session = (n = 8, size = 3000): Rec[] => [user('Rename parseRow to readRow in src/rows.ts and keep the tests green.'), ...Array.from({ length: n }, (_, i) => call(i, `result ${i} ` + 'x'.repeat(size))).flat(), ...call(99, 'FAIL expected 1 got 2', true), ...call(100, 'last exchange the engine keeps itself')];
const input = (event: string, extra: Rec = {}): string => JSON.stringify({ hook_event_name: event, session_id: SESSION, transcript_path: transcript, ...extra });
const files = (sub: string): string[] => { try { return readdirSync(join(dir, sub)); } catch { return []; } };
const noJev = { 'CLAUDE_PLUGIN_OPTION_COMPACTJEVENABLED': 'false' };
const fakeJev = (answers: (ids: string[]) => Record<string, string>): { transport: Transport; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      sleep: () => new Promise<void>(() => undefined),
      fetch: async (_url, init) => {
        calls.push(init.body);
        const questions = JSON.parse(init.body).questions as Record<string, unknown>;
        return { status: 200, text: JSON.stringify({ choices: Object.fromEntries(Object.entries(answers(Object.keys(questions))).map(([k, v]) => [k, { choice: v }])), model: 'jev-1.14.0', usage: { input_tokens: 1, output_tokens: 1 } }) };
      },
    },
  };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jev-classic-'));
  transcript = join(dir, 'transcript.jsonl');
  env = { HOME: dir, JEV_GATE_STATE_DIR: join(dir, 'state'), JEV_GATE_TRACE_DIR: join(dir, 'trace'), XDG_CONFIG_HOME: join(dir, 'config'), ...noJev };
  mkdirSync(env['JEV_GATE_TRACE_DIR']!, { recursive: true, mode: 0o700 });
  write(session());
});
afterEach(() => { loss.on = false; rmSync(dir, { recursive: true, force: true }); });

// Trace files are named by a random id, so order comes from each record's write time.
const traces = (): Rec[] => files('trace').filter((n) => n.startsWith('mod_compact-')).map((n) => JSON.parse(readFileSync(join(dir, 'trace', n), 'utf8')) as Rec)
  .sort((a, b) => String(a['written_at']).localeCompare(String(b['written_at'])));

describe('classic path: which path runs', () => {
  it('binds pre-send intent and completion to a fake send whose receipt is lost, even if restore persistence then fails', async () => {
    mkdirSync(join(dir, 'state/jev-gate'), { recursive: true });
    writeFileSync(join(dir, 'state/jev-gate/compact'), 'not a directory');
    const fake = fakeJev(ids => Object.fromEntries(ids.map(id => [id, 'discard'])));
    const fetch = fake.transport.fetch;
    fake.transport.fetch = async (url, init) => { const reply = await fetch(url, init); loss.on = true; return reply; };
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), { ...env, CLAUDE_PLUGIN_OPTION_COMPACTJEVENABLED: 'true' }, { key: 'k'.repeat(16), transport: fake.transport })).toBeNull();
    loss.on = false;
    expect(fake.calls).toHaveLength(1);
    expect(traces()).toMatchObject([{ stage: 'started', run_id: expect.any(String) }]);
    const receipt = files('trace').find(name => name.startsWith('recording_complete-'))!;
    expect(JSON.parse(readFileSync(join(dir, 'trace', receipt), 'utf8'))).toMatchObject({ complete: false, producer: 'classic' });
    expect(sessionFacts(join(dir, 'trace'), SESSION)).toMatchObject({ jevRequests: 1, jevCost: null });
  });
  it('PreCompact the engine runs (the Mod was never asked) guides the summarizer and saves the restore', async () => {
    const out = await runClassicCompact(input('PreCompact', { trigger: 'auto', custom_instructions: null }), env);
    expect(out).toContain('Write no <analysis> section');
    expect(out).toContain(`under ${shares(40000).summary} characters`);
    expect(out!.startsWith('{')).toBe(false);
    expect(files('state/jev-gate/compact')).toHaveLength(1);
    expect(traces().find((t) => t['guided'] === true)).toMatchObject({ stage: 'pre', trigger: 'auto', restore_chars: expect.any(Number) });
  });

  it('stays silent, and saves nothing, when the Mod was asked and deferred (its marker is fresh)', async () => {
    writeFileSync(askedPath(env, SESSION), '{}');
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env)).toBeNull();
    expect(files('state/jev-gate/compact')).toEqual([]);
    expect(traces().map((t) => t['deferred'])).toEqual(['function_path']);
  });

  it('runs again once the marker is old: a seat that stopped passing the Mod over is not shadowed forever', async () => {
    const marker = askedPath(env, SESSION);
    writeFileSync(marker, '{}');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(marker, old, old);
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env)).toContain('jev-gate compact');
  });

  it('a compaction the Mod answered after PreCompact saved its restore is not given that restore', async () => {
    await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env);
    const later = new Date(Date.now() + 5000);
    writeFileSync(askedPath(env, SESSION), '{}');
    utimesSync(askedPath(env, SESSION), later, later);
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), env)).toBeNull();
  });

  it('is the person\'s own when /compact carries instructions, and for a subagent or a manual one the option turned off', async () => {
    expect(await runClassicCompact(input('PreCompact', { trigger: 'manual', custom_instructions: 'keep the plan' }), env)).toBeNull();
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto', agent_id: 'a1' }), env)).toBeNull();
    expect(await runClassicCompact(input('PreCompact', { trigger: 'manual' }), { ...env, CLAUDE_PLUGIN_OPTION_COMPACTMANUAL: 'false' })).toBeNull();
    expect(await runClassicCompact(input('PreCompact', { trigger: 'manual', custom_instructions: null }), env)).toContain('jev-gate compact');
    expect(traces().filter((t) => t['stage'] === 'pre').map((t) => String(t['deferred'] ?? 'guided')).sort()).toEqual(['guided', 'instructions', 'subagent', 'trigger']);
  });

  it('off, or an option it cannot use, does nothing at all', async () => {
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), { ...env, CLAUDE_PLUGIN_OPTION_COMPACTENABLED: 'false' })).toBeNull();
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), { ...env, CLAUDE_PLUGIN_OPTION_COMPACTBUDGETCHARS: '12' })).toBeNull();
    expect(files('state/jev-gate/compact')).toEqual([]);
  });

  it('JEV_GATE_COMPACT=off is a kill switch for one launch', async () => {
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), { ...env, JEV_GATE_COMPACT: 'off' })).toBeNull();
    expect(files('state/jev-gate/compact')).toEqual([]);
    expect(traces()).toEqual([]);
  });

  it('shadow builds and records, and says nothing to the engine or the model', async () => {
    const shadow = { ...env, CLAUDE_PLUGIN_OPTION_COMPACTMODE: 'shadow' };
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), shadow)).toBeNull();
    expect(files('state/jev-gate/compact')).toHaveLength(1);
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), shadow)).toBeNull();
    expect(traces().find((t) => t['stage'] === 'pre')).toMatchObject({ guided: false });
  });
});

describe('classic path: restore', () => {
  it.each([false, true])('finds the last human request before a tool-filled 2 MiB tail (one oversized row: %s)', async oversized => {
    const task = '현재 작업: repair the parser and keep the existing API.';
    const output = oversized ? call(1, 'x'.repeat(5 * 1024 * 1024)) : Array.from({ length: 6 }, (_, i) => call(i, 'x'.repeat(512 * 1024))).flat();
    write([user('An older request.'), user(task), ...output,
      { ...user('Background job completed.'), promptSource: 'system', origin: { kind: 'task-notification' } },
      { ...user('Previous compaction summary.'), isCompactSummary: true }]);
    const out = await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env);
    expect(out).toContain(`The current task: "${task}"`);
    const restored = await runClassicCompact(input('SessionStart', { source: 'compact' }), env);
    expect(restored).toContain(task);
    expect(restored).not.toContain('Background job completed.');
    expect(restored).not.toContain('Previous compaction summary.');
  });

  it.each([false, true])('records no_current_task for only notices and summaries, without restoring either (Jev enabled: %s)', async enabled => {
    write([{ ...user('Background job completed.'), promptSource: 'system', origin: { kind: 'task-notification' } },
      { ...user('Previous compaction summary.'), isCompactSummary: true }]);
    const jev = { ...env, CLAUDE_PLUGIN_OPTION_COMPACTJEVENABLED: String(enabled) };
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), jev)).toBeNull();
    expect(traces()).toMatchObject([{ deferred: 'nothing_to_restore', selection: 'no_current_task' }]);
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), jev)).toBeNull();
    expect(files('state/jev-gate/compact')).toEqual([]);
  });

  it('still restores the human task when a single tool result fills even the 16 MiB message tail', async () => {
    write([user('Keep this human task.'), ...call(1, 'x'.repeat(17 * 1024 * 1024))]);
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env)).toContain('The current task: "Keep this human task."');
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), env)).toContain('Keep this human task.');
  });

  it('a new root compaction with no human task cannot restore a previous pending task', async () => {
    await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env);
    write([{ ...user('Background job completed.'), promptSource: 'system', origin: { kind: 'task-notification' } }]);
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env)).toBeNull();
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), env)).toBeNull();
    expect(files('state/jev-gate/compact')).toEqual([]);
    expect(traces().filter((r) => 'deferred' in r).at(-1)).toMatchObject({ deferred: 'nothing_to_restore', selection: 'no_current_task' });
  });

  it.each(['SessionStart', 'PostCompact'])('a sidechain %s cannot consume or clear the parent restore', async event => {
    await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env);
    const file = join(dir, 'state/jev-gate/compact', files('state/jev-gate/compact')[0]!);
    const saved = readFileSync(file, 'utf8');
    expect(await runClassicCompact(input(event, { source: 'compact', agent_id: 'child', compact_summary: 'child summary' }), env)).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(saved);
    expect(traces().some(t => t['stage'] === 'restore' || t['stage'] === 'post')).toBe(false);
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), env)).toContain('Rename parseRow');
  });

  it.each(['SessionStart', 'PostCompact'])('%s for another transcript cannot consume the saved restore', async event => {
    await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env);
    expect(await runClassicCompact(input(event, { source: 'compact', transcript_path: join(dir, 'child.jsonl') }), env)).toBeNull();
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), env)).toContain('Rename parseRow');
  });

  it.each([
    ['disabled', false, 'session'],
    ['no_current_task', true, 'tools'],
    ['no_prior_assistant', true, 'user'],
    ['no_key', true, 'session'],
    ['no_candidates', true, 'assistant'],
  ] as const)('records the actual Jev selection reason: %s', async (reason, enabled, content) => {
    if (content === 'tools') write(session().slice(1));
    if (content === 'user') write([user('Only a human request.')]);
    if (content === 'assistant') write([user('A human request.'), { type: 'assistant', message: { content: 'No tool results.' } }]);
    const jev = { ...env, CLAUDE_PLUGIN_OPTION_COMPACTJEVENABLED: String(enabled) };
    await runClassicCompact(input('PreCompact', { trigger: 'auto' }), jev, { key: reason === 'no_key' ? undefined : 'k'.repeat(16) });
    expect(traces().find(t => t['guided'] === true)).toMatchObject({ selection: reason });
    await runClassicCompact(input('SessionStart', { source: 'compact' }), jev);
    await runClassicCompact(input('PostCompact', { compact_summary: 'summary' }), jev);
    expect(traces().find(t => t['stage'] === 'post')).toMatchObject({ selection: reason });
  });

  it('SessionStart(compact) hands the restore up once, as additional context', async () => {
    await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env);
    const out = JSON.parse((await runClassicCompact(input('SessionStart', { source: 'compact' }), env))!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('Rename parseRow to readRow');
    expect(out.hookSpecificOutput.additionalContext).toContain('/r/file99.ts');
    expect(out.hookSpecificOutput.additionalContext).toContain('FAIL expected 1 got 2');
    expect(out.hookSpecificOutput.additionalContext).not.toContain('/r/file100.ts');
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), env)).toBeNull();
    const saved = JSON.parse(readFileSync(join(dir, 'state/jev-gate/compact', files('state/jev-gate/compact')[0]!), 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ restore: null, restored_chars: expect.any(Number) });
  });

  it('other session starts, and a restore saved too long ago, give nothing', async () => {
    await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env);
    expect(await runClassicCompact(input('SessionStart', { source: 'startup' }), env)).toBeNull();
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), env, { now: () => Date.now() + 31 * 60_000 })).toBeNull();
  });

  it('PostCompact records the summary against the budget and clears the state', async () => {
    await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env);
    await runClassicCompact(input('SessionStart', { source: 'compact' }), env);
    expect(await runClassicCompact(input('PostCompact', { trigger: 'auto', compact_summary: 'x'.repeat(900) }), env)).toBeNull();
    expect(traces().find((t) => t['stage'] === 'post')).toMatchObject({ summary_chars: 900, within_budget: true, budget: 40000 });
    expect(files('state/jev-gate/compact')).toEqual([]);
  });

  it('PostCompact says when the summary and the restore passed the budget', async () => {
    const small = { ...env, CLAUDE_PLUGIN_OPTION_COMPACTBUDGETCHARS: '8000' };
    await runClassicCompact(input('PreCompact', { trigger: 'auto' }), small);
    await runClassicCompact(input('SessionStart', { source: 'compact' }), small);
    await runClassicCompact(input('PostCompact', { trigger: 'auto', compact_summary: 'x'.repeat(8000) }), small);
    expect(traces().find((t) => t['stage'] === 'post')).toMatchObject({ within_budget: false });
  });

  it('restores the results Jev names as this task\'s dependencies, newest candidates first', async () => {
    write(session(30, 400));
    const { transport, calls } = fakeJev((ids) => Object.fromEntries(ids.map((id) => [id, id.endsWith('t0') ? 'required' : 'unrelated'])));
    const jev = { ...env, CLAUDE_PLUGIN_OPTION_COMPACTJEVENABLED: 'true' };
    await runClassicCompact(input('PreCompact', { trigger: 'auto' }), jev, { transport, key: 'k'.repeat(16) });
    const body = JSON.parse(calls[0]!) as { state: { candidates: Array<{ id: string }> } };
    // 30 results, 16 asked about: the newest, not the oldest.
    expect(body.state.candidates).toHaveLength(16);
    expect(body.state.candidates.map((c) => c.id)).not.toContain('m1t0');
    expect(Math.min(...body.state.candidates.map((c) => Number(/^m(\d+)t/.exec(c.id)![1])))).toBeGreaterThan(20);
    expect((await runClassicCompact(input('SessionStart', { source: 'compact' }), jev))).toContain('"additionalContext"');
  });

  it('#281: the current task is the person\'s last request, never a task notice or an earlier compact summary', async () => {
    const notice = '<task-notification>\n<task-id>b6w41xrqn</task-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>';
    write([...session(), { type: 'user', uuid: 'n1', promptSource: 'system', turnOrigin: 'task_notification', origin: { kind: 'task-notification', producer: 'session-task' }, message: { role: 'user', content: notice } },
      { type: 'user', uuid: 'c1', isCompactSummary: true, isVisibleInTranscriptOnly: true, turnOrigin: 'human', message: { role: 'user', content: 'This session is being continued from a previous conversation.' } }]);
    const out = await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env);
    expect(out).toContain('The current task: "Rename parseRow to readRow in src/rows.ts and keep the tests green."');
  });

  it('a Jev that fails or answers wrongly costs the selection only: the guidance and the restore stand', async () => {
    const jev = { ...env, CLAUDE_PLUGIN_OPTION_COMPACTJEVENABLED: 'true' };
    const down: Transport = { sleep: () => new Promise<void>(() => undefined), fetch: async () => { throw new Error('network'); } };
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), jev, { transport: down, key: 'k'.repeat(16) })).toContain('jev-gate compact');
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), jev)).toContain('Rename parseRow');
  });

  it('a key lookup that throws is a Jev that is not there, not a broken compaction', async () => {
    const jev = { ...env, CLAUDE_PLUGIN_OPTION_COMPACTJEVENABLED: 'true' };
    const deps = { get key(): string { throw new Error('keychain'); } };
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), jev, deps)).toContain('jev-gate compact');
    expect(traces().find((t) => t['guided'] === true)).toMatchObject({ selection: 'error' });
  });
});

describe('classic path: budget', () => {
  it('the summarizer\'s share and the restore never pass the budget, at any budget', () => {
    for (const budget of [8000, 12000, 40000, 400000]) {
      const { summary, restore } = shares(budget);
      expect(summary + restore).toBeLessThanOrEqual(budget);
      expect(restore).toBeLessThanOrEqual(RESTORE_CAP);
      expect(summary).toBeGreaterThanOrEqual(4000);
    }
  });

  it('a restore from a huge conversation stays within its share, whole lines or cut with a mark', async () => {
    const recs = [user('Request one. ' + 'a'.repeat(5000)), user('Request two. ' + 'b'.repeat(5000)), ...Array.from({ length: 60 }, (_, i) => call(i, 'z'.repeat(20000), i % 7 === 0)).flat()];
    write(recs);
    for (const budget of ['8000', '40000']) {
      await runClassicCompact(input('PreCompact', { trigger: 'auto' }), { ...env, CLAUDE_PLUGIN_OPTION_COMPACTBUDGETCHARS: budget });
      const state = JSON.parse(readFileSync(join(dir, 'state/jev-gate/compact', files('state/jev-gate/compact')[0]!), 'utf8')) as { restore: string };
      expect(state.restore.length).toBeLessThanOrEqual(shares(Number(budget)).restore);
      expect(state.restore).toContain('[…]');
    }
  });

  it('a saved restore over the share it is handed back under is never given to the model', async () => {
    await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env);
    const file = join(dir, 'state/jev-gate/compact', files('state/jev-gate/compact')[0]!);
    const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    // The option shrank, or the file was edited, between PreCompact and SessionStart.
    writeFileSync(file, JSON.stringify({ ...state, restore: 'x'.repeat(shares(8000).restore + 1) }), { mode: 0o600 });
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), { ...env, CLAUDE_PLUGIN_OPTION_COMPACTBUDGETCHARS: '8000' })).toBeNull();
  });

  it('buildRestore never returns more than its budget, down to nothing', () => {
    const messages = transcriptMessages(heldRecords(session(20, 5000)), 'Fix it.');
    for (const budget of [0, 100, 600, 3000, 9000]) {
      const text = buildRestore(messages, ['Fix it. ' + 'q'.repeat(3000)], [], budget);
      expect(text === null || text.length <= budget).toBe(true);
    }
  });

  it('the steering text is short and carries the summary\'s share', () => {
    const text = buildSteering('Rename parseRow.', 2500);
    expect(text.length).toBeLessThan(1500);
    expect(text).toContain('under 2500 characters');
    expect(text).toContain('Rename parseRow.');
  });
});

describe('classic path: an error leaves the engine\'s compaction as it was', () => {
  it('garbage, an unknown event and a missing transcript answer nothing and throw nothing', async () => {
    for (const text of ['', 'not json', '{}', '[]', JSON.stringify({ hook_event_name: 'PreCompact' }), JSON.stringify({ hook_event_name: 'PreCompact', session_id: '../x', transcript_path: transcript }), input('Stop')]) {
      expect(await runClassicCompact(text, env)).toBeNull();
    }
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto', transcript_path: join(dir, 'missing.jsonl') }), env)).toBeNull();
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto', transcript_path: undefined }), env)).toBeNull();
    expect(traces().map((t) => t['deferred'])).toEqual(['no_transcript', 'no_transcript']);
  });

  it('whatever throws inside, the hook answers nothing', async () => {
    const boom = { now: (): number => { throw new Error('clock'); } };
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env, boom)).toBeNull();
    expect(await runClassicCompact(input('SessionStart', { source: 'compact' }), env, boom)).toBeNull();
    expect(await runClassicCompact(input('PostCompact', { trigger: 'auto' }), env, boom)).toBeNull();
  });

  it('a state directory it cannot use means no guidance (the summary is never asked to be short for a restore that will not come)', async () => {
    writeFileSync(join(dir, 'blocker'), 'a file where a directory is needed');
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), { ...env, JEV_GATE_STATE_DIR: join(dir, 'blocker') })).toBeNull();
  });

  it('a transcript with nothing in it to restore gives no guidance either', async () => {
    write([{ type: 'summary', summary: 'x' }]);
    expect(await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env)).toBeNull();
    expect(traces().map((t) => t['deferred'])).toEqual(['nothing_to_restore']);
    expect(files('state/jev-gate/compact')).toEqual([]);
  });

  it('never exits with a block: no path returns the host\'s blocking forms', async () => {
    const out = await runClassicCompact(input('PreCompact', { trigger: 'auto' }), env);
    expect(out).not.toMatch(/"decision"|"continue":\s*false/);
  });
});

describe('classic path: wiring', () => {
  it('config reads the plugin options the host hands a command hook', () => {
    expect(classicConfig({})).toMatchObject({ enabled: true, mode: 'active', budgetChars: 40000, manual: true, jevEnabled: true });
    expect(classicConfig({ CLAUDE_PLUGIN_OPTION_COMPACTBUDGETCHARS: '60000', CLAUDE_PLUGIN_OPTION_COMPACTMODE: 'shadow', CLAUDE_PLUGIN_OPTION_COMPACTENABLED: 'false' })).toMatchObject({ enabled: false, mode: 'shadow', budgetChars: 60000 });
    expect(classicConfig({ CLAUDE_PLUGIN_OPTION_COMPACTMODE: 'fast' })).toBeNull();
  });

  it('hooks.json runs the bundle on PreCompact, PostCompact and SessionStart(compact) only', () => {
    const hooks = (JSON.parse(readFileSync(new URL('../../hooks/hooks.json', import.meta.url), 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>> }).hooks;
    const ours = Object.entries(hooks).flatMap(([event, groups]) => groups.filter((g) => g.hooks.some((h) => h.command.includes('compact-hook.js'))).map((g) => `${event}:${g.matcher ?? '*'}`));
    expect(ours.sort()).toEqual(['PostCompact:*', 'PreCompact:*', 'SessionStart:compact']);
    expect(statSync(new URL('../../scripts/build-claude-compact.mjs', import.meta.url)).isFile()).toBe(true);
  });
});
