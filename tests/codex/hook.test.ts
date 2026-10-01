import { mkdtempSync, readdirSync, readFileSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCodexHook as executeCodexHook, toolOutcome, type CodexHookDeps } from '../../src/codex/hook.js';
import { foldCodexOutput } from '../../src/codex/output.js';
import { codexTraceDir } from '../../src/codex-paths.js';
import { buildOperations } from '../../src/operations.js';
import { loadActivity } from '../../src/activity.js';

export const passing = `\n RUN  v5.0.1 /test/project\n\n${'stdout: repeated test detail\n'.repeat(90)} ✓ src/a.test.ts (2 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n   Start at  10:20:30\n   Duration  123ms\n`;
const dirs: string[] = [];
const runCodexHook = (deps: CodexHookDeps) => executeCodexHook({ ...deps, env: { ...deps.env, JEV_CODEX_AUTO_CONNECT: '0' } });
const dir = (): string => { const d = mkdtempSync(join(tmpdir(), 'jev-codex-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function* stdin(v: unknown): AsyncIterable<string> { yield typeof v === 'string' ? v : JSON.stringify(v); }
const input = { hook_event_name: 'PostToolUse', session_id: 'session', turn_id: 'turn', tool_use_id: 'call', model: 'native-model', tool_name: 'Bash', tool_input: { command: 'vitest run' }, tool_response: passing };

describe('native Codex hook', () => {
  it('records only explicit failure metadata without interpreting raw output as status', () => {
    expect(toolOutcome({ isError: true, content: [{ text: 'PRIVATE' }] })).toEqual({ exit_code: null, is_error: true });
    expect(toolOutcome({ exit_code: 2, output: 'PRIVATE' })).toEqual({ exit_code: 2, is_error: true });
    expect(toolOutcome('Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 7\nOutput:\nPRIVATE')).toEqual({ exit_code: 7, is_error: true });
    expect(toolOutcome('example: Process exited with code 1')).toEqual({ exit_code: null, is_error: false });
    expect(toolOutcome('PRIVATE')).toEqual({ exit_code: null, is_error: false });
  });
  it('replaces only known output, keeps repeat counts, and records metadata without raw data', async () => {
    const path = dir();
    const result = await runCodexHook({ stdin: stdin({ ...input, prompt: 'PRIVATE_PROMPT', transcript_path: '/PRIVATE_PATH', api_key: 'sk-private' }), env: { JEV_CODEX_TRACE_DIR: path } });
    expect(result['continue']).toBe(false);
    expect(result['stopReason']).toContain('90 times in a row');
    expect(result['stopReason']).toContain('2 passed');
    expect(result['stopReason']).not.toContain('Process exited with code 0');
    const records = readdirSync(path).map(f => JSON.parse(readFileSync(join(path, f), 'utf8')) as Record<string, unknown>);
    expect(records.find(r => r['phase'] === 'codex_event')).toMatchObject({ host: 'codex', exit_code: null, prompt_id: 'turn' });
    expect(records.find(r => r['phase'] === 'codex_output')).toMatchObject({ applied: true, runs: 1 });
    for (const secret of ['PRIVATE_PROMPT', 'PRIVATE_PATH', 'sk-private', 'stdout: repeated test detail', 'vitest run']) expect(JSON.stringify(records)).not.toContain(secret);
    for (const file of readdirSync(path)) expect(lstatSync(join(path, file)).mode & 0o777).toBe(0o600);
  });

  it.each(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt', 'SessionEnd'])('never approves permissions or patches inputs for %s', async event => {
    const result = await runCodexHook({ stdin: stdin({ ...input, hook_event_name: event, tool_response: 'ordinary result' }), env: { JEV_CODEX_TRACE_DIR: dir() } });
    expect(JSON.stringify(result)).not.toMatch(/permissionDecision|updatedInput|decision.*block/);
    if (event === 'SessionStart') expect(JSON.stringify(result)).toContain('connects ordinary native Codex automatically');
    else expect(result).toEqual({});
  });

  it('disables hooks without reading input or opening traces, and can disable only output folding', async () => {
    const openTrace = vi.fn(() => { throw Error('must not open'); });
    const neverRead = { async *[Symbol.asyncIterator]() { throw Error('must not read'); yield ''; } };
    expect(await runCodexHook({ stdin: neverRead, env: { JEV_CODEX_ENABLED: '0' }, openTrace })).toEqual({});
    expect(openTrace).not.toHaveBeenCalled();
    const path = dir();
    expect(await runCodexHook({ stdin: stdin(input), env: { JEV_CODEX_OUTPUT: 'off', JEV_CODEX_TRACE_DIR: path } })).toEqual({});
    expect(readdirSync(path)).toHaveLength(1);
  });

  it('does not contact a running native connection when automatic connection is disabled', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not contact the connection'));
    try {
      const result = await runCodexHook({ stdin: stdin({ ...input, hook_event_name: 'SessionStart', cwd: dir() }), env: { JEV_CODEX_TRACE_DIR: dir() } });
      expect(JSON.stringify(result)).toContain('native Codex plugin');
      expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });

  it.each(['broken json', '[]', 'null', 'x'.repeat(2 * 1024 * 1024 + 1)])('preserves native behavior for malformed or oversized input (%#)', async text => {
    expect(await runCodexHook({ stdin: stdin(text), env: { JEV_CODEX_TRACE_DIR: dir() } })).toEqual({});
  });

  it('preserves execution on a recording exception and refuses symlinked trace directories', async () => {
    const target = dir(); const link = join(dir(), 'link'); symlinkSync(target, link);
    expect(await runCodexHook({ stdin: stdin(input), env: { JEV_CODEX_TRACE_DIR: link } })).toEqual({});
    expect(readdirSync(target)).toEqual([]);
    expect(await runCodexHook({ stdin: stdin(input), env: { JEV_CODEX_TRACE_DIR: target }, openTrace: () => { throw Error('disk failure'); } })).toEqual({});
    expect(await runCodexHook({ stdin: stdin(input), env: { JEV_CODEX_TRACE_DIR: 'relative' } })).toEqual({});
  });

  it.each(['codex_event', 'codex_output'])('preserves the original tool result if recording %s fails', async failedPhase => {
    expect(await runCodexHook({ stdin: stdin(input), env: { JEV_CODEX_TRACE_DIR: dir() }, openTrace: () => ({
      ok: true, writer: { write: phase => phase === failedPhase ? { ok: false, error: 'disk_full' } : { ok: true, file: 'recorded' } },
    }) })).toEqual({});
  });

  it('separates Codex defaults and rejects relative overrides', () => {
    expect(codexTraceDir({ XDG_STATE_HOME: '/state', CLAUDE_PROJECT_DIR: '/wrong' })).toBe('/state/jev-gate/codex/traces');
    expect(codexTraceDir({ JEV_CODEX_TRACE_DIR: '/codex', JEV_GATE_TRACE_DIR: '/claude' })).toBe('/codex');
    expect(() => codexTraceDir({ JEV_CODEX_TRACE_DIR: '' })).toThrow();
  });
});

describe('Codex output preservation', () => {
  it.each([
    ['npm test', passing], ['vitest run && echo ok', passing], ['vitest run', 'ordinary output'],
    ['vitest run', passing.replace('2 passed', '1 failed | 1 passed')],
    ['vitest run', passing.replace('stdout:', 'output truncated stdout:')],
    ['vitest run', passing.replace('stdout:', '\x1b[31mstdout:')],
    ['vitest run', { exit_code: 1, output: passing }],
    ['vitest run', { exit_code: 0, output: passing, session_id: 10 }],
    ['vitest run', { exit_code: 0, output: passing, stderr: 'failure' }],
    ['vitest run', { exit_code: 0, output: passing, original_token_count: 1 }],
    ['vitest run', { exit_code: 0, output: passing, truncated: true }],
  ])('preserves unknown, failing, partial or wrapped output (%#)', (command, response) => {
    expect(foldCodexOutput(command, response).applied).toBe(false);
  });
  it('handles the known completed object but never reruns the command', () => {
    expect(foldCodexOutput('vitest run', { exit_code: 0, output: passing, wall_time_seconds: .01 }).applied).toBe(true);
    expect(foldCodexOutput('vitest run', `Chunk ID: a123\nWall time: 0.1 seconds\nProcess exited with code 0\nFinal output:\n${passing}`).applied).toBe(true);
  });
});

describe('Codex lifecycle in the dashboard', () => {
  const now = new Date('2026-09-30T01:00:10Z');
  const row = (event: string, extra: Record<string, unknown> = {}) => ({ phase: 'codex_event', host: 'codex', event, written_at: '2026-09-30T01:00:00Z', session_id: 's', prompt_id: 'p', invocation_id: event, ...extra });
  it('closes the tool span without prematurely completing the child, and does not count host latency as Jev', () => {
    const records = [row('PreToolUse', { tool_name: 'spawn_agent', tool_use_id: 'call' }), row('SubagentStart', { agent_id: 'child', agent_type: 'default' }), row('PostToolUse', { tool_name: 'spawn_agent', tool_use_id: 'call', written_at: '2026-09-30T01:00:01Z' })];
    const view = buildOperations(records, [], now, { trace: true, debug: false, host: 'codex' });
    expect(view.runs.filter(r => r.state === 'active')).toHaveLength(1);
    expect(view.feed.find(s => s.title.includes('도구 시작'))).toMatchObject({ state: 'done', durationMs: 1000 });
    expect(view.feed.find(s => s.title.includes('에이전트 시작'))).toMatchObject({ state: 'active' });
    expect(view.requests).toBe(0);
    expect(view.latency.measured).toBe(0);
    expect(view.features.find(f => f.id === 'admission')?.capability?.mode).toBe('connect');
    expect(view.features.find(f => f.id === 'compact')?.capability?.mode).toBe('observe');
    const ended = buildOperations([...records, row('SubagentStop', { agent_id: 'child', written_at: '2026-09-30T01:00:02Z', last_assistant_message: 'SECRET_FINAL' })], [], now, { trace: true, debug: false });
    expect(ended.active).toBe(0);
    expect(JSON.stringify(ended)).not.toContain('SECRET_FINAL');
    expect(ended.feed.find(s => s.title.includes('종료 이벤트'))?.summary).toContain('수락 검사 없음');
  });
  it('never joins different sessions or repeated compactions to old completion events', () => {
    const records = [row('PreToolUse', { tool_use_id: 'call' }), row('PostToolUse', { session_id: 'other', tool_use_id: 'call' }), row('PreCompact', { written_at: '2026-09-30T00:58:00Z' }), row('PostCompact', { written_at: '2026-09-30T00:58:01Z' }), row('PreCompact')];
    const view = buildOperations(records, [], now, { trace: true, debug: false });
    expect(view.feed.filter(s => s.state === 'active')).toHaveLength(2);
    const stale = buildOperations([row('PreToolUse', { tool_use_id: 'lost' })], [], new Date('2026-09-30T02:00:00Z'), { trace: true, debug: false });
    expect(stale.feed[0]?.state).toBe('unconfirmed');
  });
  it('pairs interrupted turns without reporting successful completion', () => {
    const view = buildOperations([row('UserPromptSubmit'), row('Interrupt', { written_at: '2026-09-30T01:00:01Z' })], [], now, { trace: true, debug: false });
    expect(view.feed.find(s => s.title.includes('턴 시작'))).toMatchObject({ state: 'interrupted', durationMs: 1000 });
    expect(view.runs[0]?.state).toBe('interrupted');
    expect(view.attention).toBe(0);
    expect(view.active).toBe(0);
  });
  it('ends pending indicators on turn closure without inventing a tool success', () => {
    const view = buildOperations([row('PreToolUse', { tool_use_id: 'lost' }), row('Stop', { written_at: '2026-09-30T01:00:01Z' })], [], now, { trace: true, debug: false });
    expect(view.runs[0]?.state).toBe('unconfirmed');
    expect(view.active).toBe(0); expect(view.attention).toBe(0);
    expect(view.feed.find(s => s.title.includes('도구 시작'))?.summary).toContain('결과 이벤트는 미관측');
  });
  it('pairs delayed exec receipts across turns by session and call, and propagates observed failure', () => {
    const view = buildOperations([row('PreToolUse', { tool_use_id: 'call' }), row('PostToolUse', { prompt_id: 'later', tool_use_id: 'call', exit_code: 1, written_at: '2026-09-30T01:00:01Z' })], [], now, { trace: true, debug: false });
    expect(view.feed.find(s => s.title.includes('도구 시작'))).toMatchObject({ state: 'error', durationMs: 1000 });
    expect(view.active).toBe(0); expect(view.attention).toBe(2);
  });
  it('filters a shared trace directory by host', async () => {
    const path = dir();
    await runCodexHook({ stdin: stdin(input), env: { JEV_CODEX_TRACE_DIR: path } });
    const codex = loadActivity({ traceDir: path, debugDir: null, env: {}, host: 'codex' });
    const claude = loadActivity({ traceDir: path, debugDir: null, env: {}, host: 'claude' });
    expect(codex.operations.runs.length).toBeGreaterThan(0);
    expect(codex.host).toBe('codex');
    expect(claude.operations.runs).toEqual([]);
  });
});
