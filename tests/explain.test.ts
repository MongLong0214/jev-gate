import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { TraceDirectoryReader, allocatedTraceRecords, EXPLAIN_CAVEATS, explainDir, explainRecords, readTraceRecords, type TraceCache } from '../src/explain.js';

// What the gate did was already recorded; only reading it was missing. These drive the real reader over real record
// shapes, so a rendered line is only ever a field that was written.

const tmp = mkdtempSync(join(tmpdir(), 'jev-explain-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const iso = (ms: number): string => new Date(Date.UTC(2026, 8, 20, 0, 0, 0, ms)).toISOString();

type Rec = Record<string, unknown>;
const base = (phase: string, at: number, extra: Rec = {}): Rec => ({ version: 5, phase, session_id: 's-1', mode: 'auto', written_at: iso(at), ...extra });

const admission = (at: number, extra: Rec): Rec => base('admission_result', at, extra);
const dispatch = (at: number, toolUseId: string, extra: Rec): Rec =>
  base('pre_result', at, { role: 'worker', task_id: 't1', called_tier: 'standard', attempt: 1, attempted: true, http: { status: 200, code: null, duration_ms: 120, request_bytes: 900 }, tool_use_id: toolUseId, ...extra });
const post = (at: number, toolUseId: string, resolvedModel: string | null, extra: Rec = {}): Rec =>
  base('post', at, { task_id: 't1', attempt: 1, verdict: 'accept', verdict_reason: null, tool_use_id: toolUseId, tool_response: { status: 'completed', resolvedModel, totalDurationMs: 91604, totalToolUseCount: 50 }, ...extra });

const render = (records: Rec[]): string => explainRecords({ records, unreadable: 0 }).join('\n');

describe('explain (2026-09-20)', () => {
  it('reuses unchanged records while noticing replacements, deletion, malformed writes and symlink substitution', () => {
    const dir = mkdtempSync(join(tmp, 'cached-')), path = join(dir, 'event.json'), cache: TraceCache = new Map();
    writeFileSync(path, JSON.stringify(base('admission_intent', 1)));
    const first = readTraceRecords(dir, cache); expect(first.records).toHaveLength(1);
    expect(readTraceRecords(dir, cache).records[0]).toBe(first.records[0]);
    writeFileSync(path, JSON.stringify(base('admission_result', 2)));
    expect(readTraceRecords(dir, cache).records[0]?.phase).toBe('admission_result');
    writeFileSync(path, '{'); expect(readTraceRecords(dir, cache)).toEqual({ records: [], unreadable: 1 }); expect(cache.size).toBe(0);
    writeFileSync(path, JSON.stringify(base('stop', 3))); expect(readTraceRecords(dir, cache).records).toHaveLength(1);
    rmSync(path); symlinkSync(join(tmp, 'outside.json'), path);
    writeFileSync(join(tmp, 'outside.json'), JSON.stringify({ secret: 'outside' }));
    expect(readTraceRecords(dir, cache)).toEqual({ records: [], unreadable: 1 }); expect(cache.size).toBe(0);
    rmSync(path); expect(readTraceRecords(dir + '/', cache)).toEqual({ records: [], unreadable: 0 }); expect(cache.size).toBe(0);
  });
  it('reads withdrawn Lean records as history without a line of their own (#217)', () => {
    const lean = { mode: 'lean', prompt_id: 'p-lean' };
    const records = [base('lean_intent', 1, { ...lean, request_id: 'l1' }), base('lean_result', 2, { ...lean, request_id: 'l1', attempted: true, decision: { action: 'select' } }), base('lean_dispatch', 3, { ...lean, applied: true }), base('lean_post', 4, { ...lean, status: 'completed' }), base('stop', 5, { outcome: 'aborted' })];
    const out = render(records);
    expect(out).toContain('stop     aborted');
    expect(out).not.toMatch(/^\s+(lean|packet|dispatch executor|result {3}executor)/m);
  });
  it('says why a turn stayed native, with the confidence that decided it', () => {
    const out = render([admission(1, { attempted: true, context_tokens: 193553, http: { status: 200, code: null, duration_ms: 555, request_bytes: 800 }, answers: { execution: { type: 'choice', choice: 'direct', confidence: 0.39 } }, decision: { shape: 'direct', decided: true, reason: 'admission_low_confidence', changed_default: false } })]);
    expect(out).toContain('gate A   direct');
    expect(out).toContain('confidence 0.39');
    expect(out).toContain('context 193,553 tokens');
    expect(out).toContain('reason: admission_low_confidence');
  });

  it('distinguishes a turn Jev was never asked about from one it answered', () => {
    const out = render([admission(1, { attempted: false, known_not_sent: true, context_tokens: 120000, depth_floor: 300000, decision: { shape: 'direct', decided: false, reason: 'depth_below_floor', changed_default: false } })]);
    expect(out).toContain('not asked');
    expect(out).toContain('(floor 300,000)');
    expect(out).not.toContain('http');
  });

  it('names the model a dispatch asked for and the one the host resolved', () => {
    const out = render([dispatch(1, 'toolu_a', { decision: { action: 'patch', tier: 'deep', reason: null, changed_default: true, model: 'opus' } }), post(2, 'toolu_a', 'claude-opus-5[1m]')]);
    expect(out).toContain('patch deep (opus)');
    expect(out).toContain('ran claude-opus-5[1m]');
    expect(out).not.toContain('which is not the');
  });

  it('reports a resolved model that is not the one asked for, without calling every patch a disagreement', () => {
    const out = render([dispatch(1, 'toolu_a', { decision: { action: 'patch', tier: 'deep', reason: null, changed_default: true, model: 'opus' } }), post(2, 'toolu_a', 'claude-sonnet-5')]);
    expect(out).toContain('ran claude-sonnet-5, which is not the opus it asked for');
  });

  it('leaves a dispatch with no result unanswered rather than borrowing another dispatch result', () => {
    const out = render([
      dispatch(1, 'toolu_a', { decision: { action: 'patch', tier: 'deep', reason: null, changed_default: true, model: 'opus' } }),
      dispatch(2, 'toolu_b', { task_id: 't2', decision: { action: 'patch', tier: 'fast', reason: null, changed_default: true, model: 'haiku' } }),
      post(3, 'toolu_b', 'claude-haiku-4-5'),
    ]);
    const lines = out.split('\n').filter((l) => l.includes('dispatch'));
    expect(lines[0]).toContain('(no result recorded)');
    expect(lines[0]).not.toContain('haiku-4-5');
    expect(lines[1]).toContain('ran claude-haiku-4-5');
  });

  it('a preserve names the coordinator model rather than a tier model it never asked for', () => {
    const out = render([dispatch(1, 'toolu_a', { decision: { action: 'preserve', tier: 'standard', reason: 'route_low_confidence', changed_default: false, model: null } }), post(2, 'toolu_a', 'claude-sonnet-5')]);
    expect(out).toContain('preserve standard (the model the coordinator called)');
    expect(out).toContain('ran claude-sonnet-5');
    expect(out).not.toContain('which is not the');
  });

  it('a record written before the model field existed says so rather than guessing one from the tier', () => {
    const out = render([dispatch(1, 'toolu_a', { decision: { action: 'patch', tier: 'deep', reason: null, changed_default: true } })]);
    expect(out).toContain('patch deep (model not recorded)');
  });

  it('prints the price the atomic gate put on a turn', () => {
    const out = render([admission(1, { attempted: true, context_tokens: 406000, http: { status: 200, code: null, duration_ms: 555, request_bytes: 800 }, decision: { shape: 'orchestrated', decided: true, reason: null, changed_default: true }, estimate: { turns: 60, saving_tokens: 17494000 } })]);
    expect(out).toContain('priced 60 turns, saving 17,494,000 tokens');
    const direct = render([admission(1, { attempted: true, context_tokens: 55000, decision: { shape: 'direct', decided: false, reason: 'admission_not_worth', changed_default: false }, estimate: { turns: 10, saving_tokens: -30000 } })]);
    expect(direct).toContain('saving -30,000 tokens');
    expect(direct).toContain('reason: admission_not_worth');
  });

  it('prints what the worker transcript showed about each reported pass', () => {
    const out = render([post(1, 'toolu_a', 'claude-sonnet-5', { verdict: 'incomplete', verification: { transcript: 'read', contradicted: ['npm test'], unobserved: ['c2'], stale: [] } })]);
    expect(out).toContain('transcript read, contradicted npm test, unobserved c2');
    expect(out).not.toContain('stale');
  });

  it('calls a verdict worker-reported, and always prints what the trace cannot answer', () => {
    const out = render([post(1, 'toolu_a', 'claude-sonnet-5')]);
    expect(out).toContain('worker-reported accept');
    expect(out).toContain('(92s, 50 tool calls)');
    for (const caveat of EXPLAIN_CAVEATS) expect(out).toContain(caveat);
  });

  /**
   * #48 P0-2: this is the record shape a native call with no job state now writes -- 22 Fable runs went unrecorded
   * this way in issue #48. `explain` shows what was asked for and what actually ran, side by side.
   */
  it('names the subagent, the no-job note and the requested → resolved models on an unmatched dispatch', () => {
    const out = render([base('post', 1, { matched: false, job_state: 'absent', subagent_type: 'jev-gate:worker-frontier', requested_model: 'opus', resolved_model: 'fable' })]);
    expect(out).toContain('result   unmatched dispatch (jev-gate:worker-frontier)');
    expect(out).toContain('no job state for this session');
    expect(out).toContain('opus → fable');
  });

  it('renders no arrow at all for a record from before requested_model/resolved_model existed', () => {
    const out = render([base('post', 1, { matched: false, job_state: 'absent', subagent_type: 'jev-gate:worker' })]);
    expect(out).not.toContain('→');
    expect(out).toContain('result   unmatched dispatch (jev-gate:worker)');
  });

  it('names the subagent and the requested → resolved models on a PostToolUseFailure', () => {
    const out = render([base('failure', 1, { subagent_type: 'jev-gate:worker-frontier', requested_model: 'opus', resolved_model: null, error_first_line: 'boom', duration_ms: 40 })]);
    expect(out).toContain('failure  boom  after 40ms  (jev-gate:worker-frontier)');
    expect(out).toContain('opus → unrecorded');
  });

  it('separates turns on the prompt id every phase carries, and keeps sessions apart', () => {
    const out = render([
      { ...admission(1, { attempted: true, decision: { shape: 'direct', decided: true, reason: 'first', changed_default: false } }), prompt_id: 'p-1' },
      { ...admission(2, { attempted: true, decision: { shape: 'orchestrated', decided: true, reason: 'second', changed_default: false } }), prompt_id: 'p-2' },
      { ...admission(3, { attempted: true, decision: { shape: 'direct', decided: true, reason: 'other', changed_default: false } }), session_id: 's-2', prompt_id: 'p-3' },
    ]);
    expect(out).toContain('session s-1 (mode auto)');
    expect(out).toContain('session s-2 (mode auto)');
    expect(out.split('\n').filter((l) => l.startsWith('  gate A')).length).toBe(3);
  });

  it('keeps a late result with the turn it belonged to rather than the turn that is open', () => {
    // T2/A2: a result that arrives after a newer prompt replaced its generation is recorded and never advances the
    // current plan. Reading it as part of the open turn would show the wrong turn dispatching work it never did.
    const out = render([
      { ...dispatch(1, 'toolu_a', { decision: { action: 'patch', tier: 'deep', reason: null, changed_default: true, model: 'opus' } }), prompt_id: 'p-1' },
      { ...admission(2, { attempted: true, decision: { shape: 'direct', decided: true, reason: 'admission_low_confidence', changed_default: false } }), prompt_id: 'p-2' },
      { ...post(3, 'toolu_a', 'claude-opus-5[1m]'), prompt_id: 'p-1' },
    ]);
    const turns = out.split('\n\n');
    expect(turns[0]).toContain('dispatch task t1');
    expect(turns[0]).toContain('result   task t1');
    expect(turns[1]).toContain('gate A   direct');
    expect(turns[1]).not.toContain('result   task t1');
  });

  it('orders by the time written, skips partial files, and counts what did not parse', () => {
    const dir = join(tmp, 'd1');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'zzz.json'), JSON.stringify(admission(1, { attempted: true, decision: { shape: 'direct', decided: true, reason: 'first', changed_default: false } })));
    writeFileSync(join(dir, 'aaa.json'), JSON.stringify(admission(9, { attempted: true, decision: { shape: 'orchestrated', decided: true, reason: 'second', changed_default: false } })));
    writeFileSync(join(dir, '.pre_result-x.tmp'), '{"phase":');
    writeFileSync(join(dir, 'broken.json'), 'not json');
    const read = readTraceRecords(dir);
    expect(read.records.length).toBe(2);
    expect(read.unreadable).toBe(1);
    const lines = explainDir(dir);
    expect(lines.find((l) => l.includes('reason: first'))).toBeDefined();
    expect(lines.indexOf(lines.find((l) => l.includes('reason: first')) as string)).toBeLessThan(lines.indexOf(lines.find((l) => l.includes('reason: second')) as string));
    expect(lines.some((l) => l.includes('1 file(s) in the directory did not parse'))).toBe(true);
  });

  it('an absent or empty directory reads as no records, not as a crash', () => {
    expect(explainDir(join(tmp, 'does-not-exist'))).toEqual(['no trace records found']);
  });
});


describe('final host allocation diagnostics', () => {
  it.each(['claude', 'codex'])('joins selected models by exact host/session/tool identity without changing original records (%s)', host => {
    const selected = host === 'claude' ? 'claude-sonnet-5-5' : 'gpt-6.1-sol';
    const records = [dispatch(1, 'tool', { host, allocation: { selected_model: selected, effort_edit: { kind: 'set', value: 'high' } }, decision: { tier: 'deep', model: 'opus', action: 'patch' } }),
      base('post', 2, { host, tool_use_id: 'tool', requested_model: 'opus', resolved_model: selected }),
      base('failure', 3, { host, tool_use_id: 'tool', requested_model: 'opus' }),
      base('post', 4, { host, session_id: 'other', tool_use_id: 'tool', requested_model: 'opus' })];
    const joined = allocatedTraceRecords(records);
    expect(joined[1]?.requested_model).toBe(selected);
    expect(joined[2]?.requested_model).toBe(selected);
    expect(joined[3]?.requested_model).toBe('opus');
    expect(records[1]?.requested_model).toBe('opus');
    const out = render(records);
    expect(out).toContain(`selected ${selected} / high`);
    expect(out).not.toContain(`not the ${selected}`);
  });
});

describe('incremental directory reconciliation', () => {
  it('uses named watch additions directly and reconciles an unnotified name at the fallback deadline', async () => {
    const dir = mkdtempSync(join(tmp, 'named-')), reader = new TraceDirectoryReader(100);
    writeFileSync(join(dir, 'a.json'), JSON.stringify(base('post', 1)));
    reader.read(dir, 1000);
    writeFileSync(join(dir, 'b.json'), JSON.stringify(base('post', 2))); reader.invalidate(dir, 'b.json');
    writeFileSync(join(dir, 'missed.json'), JSON.stringify(base('failure', 3)));
    utimesSync(dir, new Date(), new Date(Date.now() + 1000));
    await reader.prepare(dir, 1001);
    expect(reader.read(dir, 1001).records.map(r => r['phase'])).toEqual(['post', 'post']);
    expect(reader.read(dir, 1100).records.map(r => r['phase'])).toEqual(['post', 'post', 'failure']);
  });
  it('reuses idle results, reads changed names, and recovers missed additions, deletions and replacements', () => {
    const dir = mkdtempSync(join(tmp, 'incremental-')), reader = new TraceDirectoryReader(100), file = join(dir, 'event.json');
    writeFileSync(file, JSON.stringify(base('pre_result', 1)));
    const initial = reader.read(dir, 1000);
    expect(reader.read(dir, 1001)).toBe(initial);
    writeFileSync(file, JSON.stringify(base('post', 2))); reader.invalidate(dir, 'event.json');
    expect(reader.read(dir, 1002).records[0]?.phase).toBe('post');
    writeFileSync(join(dir, 'missed.json'), JSON.stringify(base('failure', 3)));
    utimesSync(dir, new Date(), new Date(Date.now() + 1000));
    // A changed directory timestamp recovers an append before the periodic reconciliation, even without fs.watch.
    const appended = reader.read(dir, 1003);
    expect(appended.records).toHaveLength(2);
    expect(reader.read(dir, 1100)).toBe(appended);
    rmSync(file); reader.invalidate(dir, 'event.json');
    expect(reader.read(dir, 1101).records).toHaveLength(1);
    writeFileSync(join(dir, 'missed.json'), '{'); reader.invalidate(dir, 'missed.json');
    expect(reader.read(dir, 1102)).toEqual({ records: [], unreadable: 1 });
    rmSync(join(dir, 'missed.json'));
    expect(reader.read(dir, 1200)).toEqual({ records: [], unreadable: 0 });
    writeFileSync(file, JSON.stringify(base('post', 4))); reader.invalidate(dir);
    expect(reader.read(dir, 1201).records).toHaveLength(1);
    rmSync(dir, { recursive: true }); mkdirSync(dir);
    expect(reader.read(dir, 1202)).toEqual({ records: [], unreadable: 0 });
  });
  it('reads only unknown or unreadable names in a periodic pass, so an idle history is not read again; a full invalidation still is', () => {
    const dir = mkdtempSync(join(tmp, 'periodic-')), reader = new TraceDirectoryReader(100);
    writeFileSync(join(dir, 'a.json'), JSON.stringify(base('post', 1)));
    writeFileSync(join(dir, 'bad.json'), '{');
    const initial = reader.read(dir, 1000);
    expect(initial.unreadable).toBe(1);
    expect(reader.read(dir, 1100)).toBe(initial);
    // Records are written once; a file changed in place without a notification is not read again by the periodic pass.
    writeFileSync(join(dir, 'a.json'), JSON.stringify(base('failure', 2)));
    writeFileSync(join(dir, 'bad.json'), JSON.stringify(base('post', 3)));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(base('post', 4)));
    expect(reader.read(dir, 1200).records.map(r => r['phase'])).toEqual(['post', 'post', 'post']);
    reader.invalidate(dir);
    expect(reader.read(dir, 1201).records.map(r => r['phase'])).toEqual(['failure', 'post', 'post']);
    // An unreadable directory reads as one shared result, so an unchanged missing directory is not a change.
    rmSync(dir, { recursive: true });
    expect(reader.read(dir, 1202)).toBe(reader.read(dir, 1300));
  });
  it('orders added files as a full read does, whether they extend the history or land inside it (#215)', () => {
    const dir = mkdtempSync(join(tmp, 'append-')), reader = new TraceDirectoryReader(60_000);
    writeFileSync(join(dir, 'b.json'), JSON.stringify(base('post', 2)));
    reader.read(dir, 1000);
    for (const [name, at] of [['a.json', 3], ['c.json', 1], ['d.json', 3]] as const) {
      writeFileSync(join(dir, name), JSON.stringify(base('post', at, { name }))); reader.invalidate(dir, name);
      expect(reader.read(dir, 1001)).toEqual(readTraceRecords(dir));
    }
    expect(reader.read(dir, 1001).records.map(r => r['name'] ?? 'b.json')).toEqual(['c.json', 'b.json', 'a.json', 'd.json']);
  });
  it('rejects substituted file and directory symlinks and oversized records, and discovers a newly created directory', () => {
    const dir = join(tmp, 'later-reader'), outside = mkdtempSync(join(tmp, 'outside-reader-')), reader = new TraceDirectoryReader(100);
    expect(reader.read(dir, 1000).records).toEqual([]); mkdirSync(dir);
    const external = join(outside, 'private.json'); writeFileSync(external, JSON.stringify({ secret: 'never shown' }));
    const file = join(dir, 'event.json'); symlinkSync(external, file);
    writeFileSync(join(dir, 'large.json'), JSON.stringify({ value: 'x'.repeat(512001) }));
    expect(reader.read(dir, 1001)).toEqual({ records: [], unreadable: 2 });
    rmSync(file); writeFileSync(file, JSON.stringify(base('post', 1))); reader.invalidate(dir, 'event.json');
    expect(reader.read(dir, 1002).records).toHaveLength(1);
    rmSync(dir, { recursive: true }); symlinkSync(outside, dir);
    expect(reader.read(dir, 1003)).toEqual({ records: [], unreadable: 0 });
  });
});
