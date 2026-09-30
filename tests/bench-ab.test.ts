import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CONDITIONS, cleanEnv, conditionSettings, grid, median, parseRunArgs, rotate, rowOf, usageOf, type CellResult, type Row } from '../src/bench/ab.js';

const row = (over: Partial<Row>): Row => ({ id: 'S-A-1', task: 'S', cond: 'A', rep: 1, ok: true, wall_s: 10, cost: 1, prime_cost: 1, prime_tools: 30, total_tokens: 100, cache_create: 10, cache_read: 80, output: 10, requests: 3, tools: 5, subs: 0, compacts: 0, shapes: '', ...over });

describe('bench ab (#130)', () => {
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
    expect(env).toEqual({ HOME: '/h', PATH: '/bin', JEV_GATE_MODE: 'auto' });
  });

  it('requires --tasks and --out and rejects unknown conditions', () => {
    expect(() => parseRunArgs(['--tasks', 't.json'])).toThrow(/--out/);
    expect(() => parseRunArgs(['--tasks', 't.json', '--out', 'o', '--conds', 'A,E'])).toThrow(/unknown condition E/);
    const o = parseRunArgs(['--tasks', 't.json', '--out', 'o', '--reps', '2', '--only', 'S,M', '--timeout-ms', '5000']);
    expect(o).toMatchObject({ reps: 2, only: ['S', 'M'], timeoutMs: 5000, conds: ['A', 'B', 'C', 'D'] });
  });

  it('counts the last usage per message id and every tool_use block', () => {
    const lines = [
      { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1, cache_read_input_tokens: 10, output_tokens: 1 }, content: [{ type: 'tool_use' }, { type: 'text' }] } },
      { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 2, cache_read_input_tokens: 20, output_tokens: 5 } } },
      { type: 'user', message: { content: 'x' } },
    ];
    expect(usageOf(lines)).toEqual({ input: 2, cache_create: 0, cache_read: 20, output: 5, requests: 1, tools: 1 });
  });

  it('measures only the second turn and reports the priming turn tool count separately (#123)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-'));
    const t = join(dir, 'sid.jsonl');
    const L = (o: unknown): string => JSON.stringify(o);
    writeFileSync(
      t,
      [
        L({ type: 'user', timestamp: '2026-09-30T00:00:00Z', message: { content: 'prime' } }),
        L({ type: 'assistant', timestamp: '2026-09-30T00:00:01Z', message: { id: 'p', usage: { cache_creation_input_tokens: 1000 }, content: [{ type: 'tool_use' }, { type: 'tool_use' }] } }),
        L({ type: 'user', timestamp: '2026-09-30T00:00:02Z', message: { content: 'task' } }),
        L({ type: 'assistant', timestamp: '2026-09-30T00:00:03Z', message: { id: 'w', usage: { cache_read_input_tokens: 500, output_tokens: 7 }, content: [{ type: 'tool_use' }] } }),
      ].join('\n'),
    );
    mkdirSync(join(dir, 'sid', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'sid', 'subagents', 'a.jsonl'), L({ type: 'assistant', timestamp: '2026-09-30T00:00:04Z', message: { id: 's', usage: { input_tokens: 3 }, content: [] } }));
    const cell: CellResult = { id: 'S-B-1', task: 'S', cond: 'B', rep: 1, sid: 'sid', cwd: dir, started_at: '', prime_wall_s: 1, wall_s: 2, prime_rc: 0, rc: 0, timed_out: false, check_rc: null, prime: {}, harness: { cost_usd: 0.5 }, result_head: 'SUCCESS' };
    const r = rowOf(cell, null, t, join(dir, 'no-trace'));
    expect(r).toMatchObject({ ok: true, prime_tools: 2, total_tokens: 510, cache_read: 500, output: 7, requests: 2, tools: 1, subs: 1 });
    const timedOut = rowOf({ ...cell, timed_out: true }, null, t, join(dir, 'no-trace'));
    expect(timedOut.ok).toBe(false);
    expect(rowOf(cell, null, null, join(dir, 'no-trace')).missing).toBe(true);
  });

  it('applies the result pattern gate from the tasks file', () => {
    const cell: CellResult = { id: 'L-A-1', task: 'L', cond: 'A', rep: 1, sid: 'x', cwd: '', started_at: '', prime_wall_s: 0, wall_s: 0, prime_rc: 0, rc: 0, timed_out: false, check_rc: null, prime: {}, harness: {}, result_head: 'it failed' };
    const file = { _prime: '', _repo: '', L: { prompt: 'p', resultPattern: 'SUCCESS|zip' } };
    expect(rowOf(cell, file, null, '/nope').ok).toBe(false);
    expect(rowOf({ ...cell, result_head: 'zip downloaded' }, file, null, '/nope').ok).toBe(true);
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
    ];
    const g = grid(rows, ['S']);
    expect(g.find((x) => x.cond === 'B')).toMatchObject({ n: 3, tokens: 80, 'tok/A': '0.80', paired: '3/3 below A → effect' });
    // A lower median is not an effect when one repetition went the other way.
    expect(g.find((x) => x.cond === 'C')).toMatchObject({ n: 3, tokens: 50, paired: '2/3 below A' });
    // A failed run is excluded: fewer tokens from not doing the work are not a saving.
    expect(g.find((x) => x.cond === 'D')).toMatchObject({ n: 0 });
  });
});
