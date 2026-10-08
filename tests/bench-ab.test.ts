import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CONDITIONS, cleanEnv, conditionSettings, grid, median, parseRunArgs, rotate, rowOf, usageOf, run, report, sessionFacts, type CellResult, type Row } from '../src/bench/ab.js';

const row = (over: Partial<Row>): Row => ({ id: 'S-A-1', task: 'S', cond: 'A', rep: 1, ok: true, wall_s: 10, cost: 1, prime_cost: 1, prime_tools: 30, model: 'm', model_mismatch: false, prime_effort: 'xhigh', effort: 'xhigh', gate_turns: '-', total_tokens: 100, cache_create: 10, cache_read: 80, output: 10, requests: 3, tools: 5, subs: 0, compacts: 0, shapes: '', ...over });

describe('bench ab (#130)', () => {
  it('requires each non-pinned task response to have its own exact route confirmation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-route-')), trace = join(dir, 'trace'); mkdirSync(trace);
    const model = 'claude-haiku-5-5', transcript = join(dir, 'sid.jsonl');
    const usage = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
    const save = (name: string, value: object) => writeFileSync(join(trace, name), JSON.stringify({ session_id: 'sid', ...value }));
    save('prime.json', { phase: 'mod_router', event: 'root', turn: 'prime-turn', patch: { model } });
    save('prime-result.json', { phase: 'mod_router', event: 'root_result', turn: 'prime-turn', request_id: 'prime-request', confirmation: 'confirmed', observed: model });
    writeFileSync(transcript, [
      { type: 'user', message: { content: 'prime' } },
      { type: 'assistant', requestId: 'prime-request', message: { id: 'prime', model, usage } },
      { type: 'user', message: { content: 'task' } },
      { type: 'assistant', requestId: 'task-request', message: { id: 'task', model, usage } },
    ].map(v => JSON.stringify(v)).join('\n'));
    const cell: CellResult = { id: 'S-D-1', task: 'S', cond: 'D', rep: 1, sid: 'sid', cwd: dir, model: 'claude-opus-5-5', started_at: '', prime_wall_s: 1, wall_s: 2, prime_rc: 0, rc: 0, timed_out: false, check_rc: null, prime: {}, harness: {}, result_head: 'ok' };
    expect(rowOf(cell, null, transcript, trace)).toMatchObject({ ok: false, model_mismatch: true });
    save('task.json', { phase: 'mod_router', event: 'root', turn: 'task-turn', patch: { model } });
    save('task-result.json', { phase: 'mod_router', event: 'root_result', turn: 'task-turn', confirmation: 'confirmed', observed: model });
    expect(rowOf(cell, null, transcript, trace)).toMatchObject({ ok: false, model_mismatch: true });
    save('task-result.json', { phase: 'mod_router', event: 'root_result', turn: 'task-turn', request_id: 'task-request', confirmation: 'confirmed', observed: model });
    expect(rowOf(cell, null, transcript, trace)).toMatchObject({ ok: true, model_mismatch: false });
    rmSync(dir, { recursive: true });
  });
  it('counts exact Jev intent/result bindings once and retains unobserved consumption as unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-jev-'));
    const records = [
      { phase: 'admission_intent', request_id: 'gate' },
      { phase: 'admission_result', request_id: 'gate', attempted: true, jev: { usage: { input_tokens: 30, output_tokens: 10 } } },
      { phase: 'mod_router', event: 'request', scope: 'root', turn: 't', sent: true },
      { phase: 'mod_router', event: 'root', scope: 'root', turn: 't', sent: true, usage: { input: 40, output: 20 } },
    ];
    records.forEach((r, i) => writeFileSync(join(dir, `${i}.json`), JSON.stringify({ ...r, session_id: 'sid' })));
    expect(sessionFacts(dir, 'sid')).toMatchObject({ jevRequests: 2, jevInput: 70, jevOutput: 30 });
    writeFileSync(join(dir, 'lost.json'), JSON.stringify({ phase: 'pre_intent', request_id: 'lost', session_id: 'sid' }));
    expect(sessionFacts(dir, 'sid')).toMatchObject({ jevRequests: 3, jevInput: null, jevOutput: null });
    rmSync(dir, { recursive: true });
  });
  it('keeps session cost distinct from token savings and includes unobserved planned pairs', () => {
    const rows = [row({ cost: 1, total_tokens: 100 }), row({ id: 'S-D-1', cond: 'D', cost: 2, total_tokens: 50 })];
    expect(grid(rows, ['S'], ['A', 'D'], 5)[1]).toMatchObject({ 'cost/A': '2.00', 'tok/A': '0.50', cost_pairs: '0/5 lower cost; 1/5 observed', cost_ratios: [2, null, null, null, null] });
    expect(grid(rows, ['S'], ['B'], 5)[0]).toMatchObject({ n: 0, cost_pairs: '0/5 lower cost; 0/5 observed', cost_ratios: [null, null, null, null, null] });
  });
  it('rotates the condition order one position per repetition (#129 cache warming)', () => {
    expect(rotate(CONDITIONS, 1)).toEqual(['A', 'B', 'C', 'D']);
    expect(rotate(CONDITIONS, 2)).toEqual(['B', 'C', 'D', 'A']);
    expect(rotate(CONDITIONS, 4)).toEqual(['D', 'A', 'B', 'C']);
    expect(rotate(CONDITIONS, 5)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('writes plugin options under the installed plugin key, A all off and D all on', () => {
    const a = JSON.parse(conditionSettings('A')) as { pluginConfigs: Record<string, { options: Record<string, unknown> }> };
    expect(a.pluginConfigs['jev-gate@jev-gate']!.options).toMatchObject({ gateMode: 'off', compactEnabled: false, routerEnabled: false, outputEnabled: false });
    const d = JSON.parse(conditionSettings('D')) as { pluginConfigs: Record<string, { options: Record<string, unknown> }> };
    expect(d.pluginConfigs['jev-gate@jev-gate']!.options).toMatchObject({ gateMode: 'auto', compactEnabled: true, routerEnabled: true, outputEnabled: true });
  });

  it('strips the parent CLAUDE_*/JEV_GATE_* environment and sets only the mode', () => {
    const env = cleanEnv({ HOME: '/h', CLAUDE_CODE_FORK_SUBAGENT: '0', JEV_GATE_TRACE_DIR: '/t', PATH: '/bin' }, 'auto');
    expect(env).toEqual({ HOME: '/h', PATH: '/bin', JEV_GATE_MODE: 'auto', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' });
  });

  it('requires --tasks and --out and rejects unknown conditions', () => {
    expect(() => parseRunArgs(['--tasks', 't.json'])).toThrow(/--out/);
    // #133: a bench never inherits the user's default model.
    expect(() => parseRunArgs(['--tasks', 't.json', '--out', 'o'])).toThrow(/--model/);
    expect(() => parseRunArgs(['--tasks', 't.json', '--out', 'o', '--model', 'm', '--conds', 'A,E'])).toThrow(/unknown condition E/);
    const o = parseRunArgs(['--tasks', 't.json', '--out', 'o', '--model', 'claude-fable-5-1', '--reps', '2', '--only', 'S,M', '--timeout-ms', '5000']);
    expect(o).toMatchObject({ model: 'claude-fable-5-1', reps: 2, only: ['S', 'M'], timeoutMs: 5000, conds: ['A', 'B', 'C', 'D'] });
  });

  it('counts the last usage per message id and every tool_use block', () => {
    const lines = [
      { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 1 }, content: [{ type: 'tool_use' }, { type: 'text' }] } },
      { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 5 } } },
      { type: 'user', message: { content: 'x' } },
    ];
    expect(usageOf(lines)).toEqual({ input: 2, cache_create: 0, cache_read: 20, output: 5, requests: 1, tools: 1, complete: true });
  });

  it('measures only the second turn and reports the priming turn tool count separately (#123)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-'));
    const t = join(dir, 'sid.jsonl');
    const L = (o: unknown): string => JSON.stringify(o);
    writeFileSync(
      t,
      [
        L({ type: 'user', timestamp: '2026-09-30T00:00:00Z', message: { content: 'prime' } }),
        L({ type: 'assistant', timestamp: '2026-09-30T00:00:01Z', effort: 'low', message: { id: 'p', model: 'claude-fable-5-1', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 }, content: [{ type: 'tool_use' }, { type: 'tool_use' }] } }),
        L({ type: 'user', timestamp: '2026-09-30T00:00:02Z', message: { content: 'task' } }),
        L({ type: 'assistant', timestamp: '2026-09-30T00:00:03Z', effort: 'medium', message: { id: 'w', model: 'claude-fable-5-1', usage: { input_tokens: 0, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, output_tokens: 7 }, content: [{ type: 'tool_use' }] } }),
      ].join('\n'),
    );
    mkdirSync(join(dir, 'sid', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'sid', 'subagents', 'a.jsonl'), L({ type: 'assistant', timestamp: '2026-09-30T00:00:04Z', message: { id: 's', usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } }));
    const trace = join(dir, 'trace');
    mkdirSync(trace);
    writeFileSync(join(trace, 'admission_result-1.json'), L({ session_id: 'sid', decision: { shape: 'direct', reason: 'admission_not_worth' }, estimate: { turns: 6, saving_tokens: -100 } }));
    const cell: CellResult = { id: 'S-B-1', task: 'S', cond: 'B', rep: 1, sid: 'sid', cwd: dir, model: 'claude-fable-5-1', started_at: '', prime_wall_s: 1, wall_s: 2, prime_rc: 0, rc: 0, timed_out: false, check_rc: null, prime: {}, harness: { cost_usd: 0.5 }, result_head: 'SUCCESS' };
    const r = rowOf(cell, null, t, trace);
    // #132/#133/#135: model, per-turn effort and Gate A's own turn estimate sit beside the measured numbers.
    expect(r).toMatchObject({ ok: true, prime_tools: 2, total_tokens: 510, cache_read: 500, output: 7, requests: 2, tools: 1, subs: 1, model: 'claude-fable-5-1', model_mismatch: false, prime_effort: 'low', effort: 'medium', gate_turns: '6', shapes: 'direct' });
    // #133: the transcript says the task ran on another model than the sweep pinned -- not this cell's number.
    const other = rowOf({ ...cell, model: 'claude-opus-5-5' }, null, t, trace);
    expect(other).toMatchObject({ ok: false, model_mismatch: true, model: 'claude-fable-5-1' });
    const timedOut = rowOf({ ...cell, timed_out: true }, null, t, join(dir, 'no-trace'));
    expect(timedOut.ok).toBe(false);
    expect(rowOf(cell, null, null, join(dir, 'no-trace')).missing).toBe(true);
  });

  it('applies the result pattern gate from the tasks file', () => {
    const cell: CellResult = { id: 'L-A-1', task: 'L', cond: 'A', rep: 1, sid: 'x', cwd: '', model: 'm', started_at: '', prime_wall_s: 0, wall_s: 0, prime_rc: 0, rc: 0, timed_out: false, check_rc: null, prime: {}, harness: {}, result_head: 'it failed' };
    const file = { _prime: '', _repo: '', L: { prompt: 'p', resultPattern: 'SUCCESS|zip' } };
    expect(rowOf(cell, file, null, '/nope').ok).toBe(false);
    expect(rowOf({ ...cell, result_head: 'zip downloaded' }, file, null, '/nope')).toMatchObject({ ok: false, total_tokens: null });
  });

  it('declares an effect only when every paired repetition is below A (#129 item 6)', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
    const rows = [
      row({ id: 'S-A-1', rep: 1, total_tokens: 100 }),
      row({ id: 'S-A-2', rep: 2, total_tokens: 100 }),
      row({ id: 'S-A-3', rep: 3, total_tokens: 100 }),
      row({ id: 'S-B-1', cond: 'B', rep: 1, total_tokens: 90 }),
      row({ id: 'S-B-2', cond: 'B', rep: 2, total_tokens: 80 }),
      row({ id: 'S-B-3', cond: 'B', rep: 3, total_tokens: 70 }),
      row({ id: 'S-C-1', cond: 'C', rep: 1, total_tokens: 50 }),
      row({ id: 'S-C-2', cond: 'C', rep: 2, total_tokens: 120 }),
      row({ id: 'S-C-3', cond: 'C', rep: 3, total_tokens: 50 }),
      row({ id: 'S-D-1', cond: 'D', rep: 1, total_tokens: 10, ok: false }),
      row({ id: 'S-D-2', cond: 'D', rep: 2, total_tokens: 20, effort: 'medium' }),
    ];
    const g = grid(rows, ['S']);
    expect(g.find((x) => x.cond === 'B')).toMatchObject({ n: 3, tokens: 80, 'tok/A': '0.80', paired: '3/3 below A → effect', effort: 'xhigh' });
    // A lower median is not an effect when one repetition went the other way.
    expect(g.find((x) => x.cond === 'C')).toMatchObject({ n: 3, tokens: 50, paired: '2/3 below A' });
    // A failed run is excluded: fewer tokens from not doing the work are not a saving.
    expect(g.find((x) => x.cond === 'D')).toMatchObject({ n: 1, effort: 'medium' });
  });
  it('never interprets absent or invalid usage as a zero-token success', () => {
    expect(usageOf([]).complete).toBe(false);
    expect(usageOf([{ type: 'assistant', message: { id: 'm', usage: {} } }]).complete).toBe(false);
    const duplicate = { type: 'assistant', message: { id: 'm', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id: 'call1' }] } };
    expect(usageOf([duplicate, duplicate])).toMatchObject({ tools: 1, requests: 1, complete: true });
    expect(grid([row({ total_tokens: null })], ['S'])[0]).toMatchObject({ n: 0 });
    const paired = [1,2,3].flatMap(rep => [row({ rep }), row({ cond: 'B', rep, total_tokens: 90 })]);
    expect(grid(paired, ['S'], ['A','B'], 4)[1]?.paired).not.toContain('effect');
  });

  it('runs an isolated two-turn fake host, freezes inputs and resumes without mixing measurements', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-runtime-'));
    const oldHome = process.env['HOME'];
    process.env['HOME'] = dir;
    try {
      const cli = join(dir, 'fake-claude.mjs');
      writeFileSync(cli, `#!/usr/bin/env node
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const flag = n => args[args.indexOf(n)+1];
const prime = args.includes('--session-id');
const sid = flag(prime ? '--session-id' : '--resume');
if (!process.env.JEV_GATE_STATE_DIR || !process.env.JEV_GATE_TRACE_DIR || process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS !== '1') process.exit(3);
const root = join(process.env.HOME, '.claude', 'projects', 'fixture'); mkdirSync(root, { recursive: true });
for (const record of [{ type:'user', timestamp:new Date().toISOString(), message:{content:flag('-p')} }, { type:'assistant', timestamp:new Date().toISOString(), message:{id:prime?'p':flag('-p'), model:flag('--model'), usage:{input_tokens:5,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0},content:[]} }]) appendFileSync(join(root,sid+'.jsonl'),JSON.stringify(record)+'\\n');
console.log(JSON.stringify({result:'SUCCESS', session_id:sid, total_cost_usd:0.01}));
`);
      chmodSync(cli, 0o700);
      const tasks = join(dir, 'tasks.json'); const out = join(dir, 'output');
      const inputs = { _repo: dir, _prime: 'prime', S: { prompt: 'task', followups: [{ prompt: 'light' }, { prompt: 'heavy', waitMs: 0 }], check: 'test -r \"$JEV_BENCH_RESULT_PATH\"', resultPattern: 'SUCCESS' } };
      writeFileSync(tasks, JSON.stringify(inputs));
      const args = ['--tasks',tasks,'--out',out,'--model','fake-model','--conds','A,B','--reps','1','--claude',cli];
      run(args);
      const cell = JSON.parse(readFileSync(join(out,'results','S-A-1.json'),'utf8')) as CellResult;
      expect(cell).toMatchObject({ rc:0, prime_rc:0, check_rc:0 });
      const transcript = join(dir,'.claude','projects','fixture',cell.sid+'.jsonl');
      expect(rowOf(cell,inputs,transcript,join(out,'trace'))).toMatchObject({ ok:true,total_tokens:21 });
      const before = readFileSync(join(out,'plan.json'),'utf8'); run(args);
      expect(readFileSync(join(out,'plan.json'),'utf8')).toBe(before);
      writeFileSync(tasks, JSON.stringify({ ...inputs, S: { prompt:'changed' } }));
      expect(() => run(args)).toThrow(/different or unfrozen/);
      // Report still uses frozen quality checks, even after the source file changes.
      expect(() => report(['--out',out])).not.toThrow();
      const failed = rowOf({...cell,prime_rc:1},inputs,transcript,join(out,'trace'));
      expect(failed.ok).toBe(false);
      expect(rowOf({...cell,check_rc:null},inputs,transcript,join(out,'trace')).ok).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env['HOME']; else process.env['HOME'] = oldHome;
      rmSync(dir,{recursive:true,force:true});
    }
  });

});
