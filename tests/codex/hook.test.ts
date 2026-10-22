import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCodexHook as executeCodexHook, toolOutcome, type CodexHookDeps } from '../../src/codex/hook.js';
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
  it.each([
    'Wall time: 0.2000 seconds\nProcess exited with code 7\nOutput:\nPRIVATE',
    'Chunk ID: abc\nWall time: 0.2000 seconds\nProcess exited with code 7\nOriginal token count: 9000\nOutput:\nPRIVATE',
  ])('reads the native exec status when optional header fields vary (%#)', output => {
    expect(toolOutcome(output)).toEqual({ exit_code: 7, is_error: true });
  });
  it.each([
    'Script failed\nWall time 0.1 seconds\nOutput:\n',
    'Script failed\nWall time 0.123 seconds (code-mode 0.124 seconds; overhead -0.001 seconds)\nOutput:\n',
  ])('recognizes only the code-mode outer failure header (%#)', header => {
    expect(toolOutcome([{ type: 'input_text', text: header }, { type: 'input_text', text: 'PRIVATE' }])).toEqual({ exit_code: null, is_error: true });
  });
  it.each([
    [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: '{"exit_code":1}' }],
    [{ type: 'input_text', text: 'Script running with cell ID 123\nWall time 0.1 seconds\nOutput:\n' }],
    [{ type: 'input_text', text: 'ordinary body' }, { type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' }],
    [{ type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\nquoted body' }],
    [{ type: 'output_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' }],
    'Chunk ID: abc\nWall time: 0.1 seconds\nProcess running with session ID 123\nOutput:\nProcess exited with code 1',
    'Wall time: 0.1 seconds\nProcess exited with code 9007199254740992\nOutput:\nPRIVATE',
  ])('keeps missing, quoted and nested failure evidence unknown (%#)', output => {
    expect(toolOutcome(output)).toEqual({ exit_code: null, is_error: false });
  });
  it('records metadata without raw data and leaves the tool result alone', async () => {
    const path = dir();
    const result = await runCodexHook({ stdin: stdin({ ...input, prompt: 'PRIVATE_PROMPT', transcript_path: '/PRIVATE_PATH', api_key: 'sk-private' }), env: { JEV_CODEX_TRACE_DIR: path } });
    expect(result).toEqual({});
    const records = readdirSync(path).map(f => JSON.parse(readFileSync(join(path, f), 'utf8')) as Record<string, unknown>);
    expect(records.find(r => r['phase'] === 'codex_event')).toMatchObject({ host: 'codex', exit_code: null, prompt_id: 'turn' });
    for (const secret of ['PRIVATE_PROMPT', 'PRIVATE_PATH', 'sk-private', 'stdout: repeated test detail', 'vitest run']) expect(JSON.stringify(records)).not.toContain(secret);
    for (const file of readdirSync(path)) expect(lstatSync(join(path, file)).mode & 0o777).toBe(0o600);
  });

  it.each(['jv_live_' + '0123456789abcdef'.repeat(4), 'sk-canary', 'ghp_' + 'a1'.repeat(20), 'AKIAIOSFODNN7EXAMPLE'])('H1: applies the shared credential screen to Codex hook metadata: %s', async secret => {
    const path = dir();
    await runCodexHook({ stdin: stdin({ ...input, model: secret }), env: { HOME: dir(), JEV_CODEX_TRACE_DIR: path } });
    const records = readdirSync(path).map(f => JSON.parse(readFileSync(join(path, f), 'utf8')) as Record<string, unknown>);
    expect(records.find(r => r['phase'] === 'codex_event')).toMatchObject({ model: null });
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  it.each(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt', 'SessionEnd'])('never approves permissions or patches inputs for %s', async event => {
    const result = await runCodexHook({ stdin: stdin({ ...input, hook_event_name: event, tool_response: 'ordinary result' }), env: { JEV_CODEX_TRACE_DIR: dir() } });
    expect(JSON.stringify(result)).not.toMatch(/permissionDecision|updatedInput|decision.*block/);
    if (event === 'SessionStart') expect(JSON.stringify(result)).toContain('connects ordinary native Codex automatically');
    else expect(result).toEqual({});
  });

  it('disables hooks without reading input or opening traces', async () => {
    const openTrace = vi.fn(() => { throw Error('must not open'); });
    const neverRead = { async *[Symbol.asyncIterator]() { throw Error('must not read'); yield ''; } };
    expect(await runCodexHook({ stdin: neverRead, env: { JEV_CODEX_ENABLED: '0' }, openTrace })).toEqual({});
    expect(openTrace).not.toHaveBeenCalled();
  });

  it('does not contact a running native connection when automatic connection is disabled', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not contact the connection'));
    try {
      const result = await runCodexHook({ stdin: stdin({ ...input, hook_event_name: 'SessionStart', cwd: dir() }), env: { JEV_CODEX_TRACE_DIR: dir() } });
      expect(JSON.stringify(result)).toContain('native Codex plugin');
      expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });

  it.each([
    ['openai', 'codex-tui', 'startup', 'without the Jev Gate connection'],
    ['jev-gate-native', 'codex-tui', 'startup', '-m/--model'],
    ['jev-gate-native', 'codex_exec', 'startup', null],
    ['openai', 'codex-tui', 'resume', null],
  ])('tells the user how a session started on %s by %s (%s) is routed', async (provider, originator, source, notice) => {
    const path = dir(); const transcript = join(dir(), 'rollout.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: 'session', model_provider: provider, originator, base_instructions: { text: 'PRIVATE_INSTRUCTIONS' } } })}\n{"type":"turn_context"}\n`);
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no connection owner'));
    try {
      // CODEX_HOME holds no connection owner, so the connection stays unavailable and no helper starts from src/.
      const result = await executeCodexHook({ stdin: stdin({ hook_event_name: 'SessionStart', session_id: 'session', source, model: 'native-model', cwd: dir(), transcript_path: transcript, permission_mode: 'default' }), env: { JEV_CODEX_TRACE_DIR: path, CODEX_HOME: dir() } });
      if (notice) expect(result['systemMessage']).toContain(notice); else expect(result).not.toHaveProperty('systemMessage');
      expect(JSON.stringify(result)).toContain('native Codex plugin');
      const event = readdirSync(path).filter(f => f.startsWith('codex_event-')).map(f => JSON.parse(readFileSync(join(path, f), 'utf8')) as Record<string, unknown>).find(r => r['phase'] === 'codex_event');
      if (provider === 'openai' && source === 'startup') expect(event).toMatchObject({ event: 'SessionStart', routed: false, model_provider: 'openai' });
      else expect(event).not.toHaveProperty('routed');
      expect(JSON.stringify(event)).not.toContain('PRIVATE_INSTRUCTIONS');
    } finally { request.mockRestore(); }
  });

  it.each([
    ['no', null, null, false, 'without the Jev Gate connection'],
    ['a live', process.pid, null, 'unknown', 'is unknown'],
    ['a stopped', spawnSync(process.execPath, ['-e', '']).pid, null, 'unknown', 'is unknown'],
    ['a live', process.pid, 'unreadable', 'unknown', 'is unknown'],
    ['a live', process.pid, 'mismatched', 'unknown', 'is unknown'],
  ] as const)('judges an ephemeral start without usable start metadata from %s connection owner and %s transcript', async (_owner, pid, transcript, routed, notice) => {
    const path = dir(); const home = dir(); const token = 'f'.repeat(64);
    if (pid) {
      mkdirSync(join(home, 'jev-gate', 'connection'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'jev-gate', 'connection', 'owner.json'), JSON.stringify({ version: 1, pid, port: 1, token, marker: 'marker', root: dir(), original: {}, installed: {} }), { mode: 0o600 });
    }
    const file = join(dir(), 'rollout.jsonl');
    if (transcript === 'mismatched') writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 'other', model_provider: 'jev-gate-native' } })}\n`);
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no connection'));
    try {
      const result = await executeCodexHook({ stdin: stdin({ hook_event_name: 'SessionStart', session_id: 'session', source: 'startup', model: 'native-model', cwd: dir(), transcript_path: transcript ? file : null, permission_mode: 'default' }), env: { JEV_CODEX_TRACE_DIR: path, CODEX_HOME: home } });
      expect(result['systemMessage']).toContain(notice);
      expect(String(result['systemMessage'])).not.toContain('"unknown"');
      const event = readdirSync(path).filter(f => f.startsWith('codex_event-')).map(f => JSON.parse(readFileSync(join(path, f), 'utf8')) as Record<string, unknown>).find(r => r['phase'] === 'codex_event');
      expect(event).toMatchObject({ event: 'SessionStart', routed, model_provider: null });
      expect(JSON.stringify([result, event])).not.toContain(token);
    } finally { request.mockRestore(); }
  });

  it('does not trust a helper that is available when the hook checks it: the session may have loaded another provider', async () => {
    const path = dir(); const home = dir();
    mkdirSync(join(home, 'jev-gate', 'connection'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'jev-gate', 'connection', 'owner.json'), JSON.stringify({ version: 1, pid: process.pid, port: 1, token: 'e'.repeat(64), marker: 'marker', root: dir(), original: {}, installed: {} }), { mode: 0o600 });
    // The helper answers every request: the MCP started it independently, before this session's provider was fixed.
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    try {
      const result = await executeCodexHook({ stdin: stdin({ hook_event_name: 'SessionStart', session_id: 'session', source: 'startup', model: 'native-model', cwd: dir(), transcript_path: null, permission_mode: 'default' }), env: { JEV_CODEX_TRACE_DIR: path, CODEX_HOME: home } });
      expect(String(result['systemMessage'])).toContain('is unknown');
      const event = readdirSync(path).filter(f => f.startsWith('codex_event-')).map(f => JSON.parse(readFileSync(join(path, f), 'utf8')) as Record<string, unknown>).find(r => r['phase'] === 'codex_event');
      expect(event).toMatchObject({ event: 'SessionStart', routed: 'unknown' });
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

  it('preserves the original tool result if recording fails', async () => {
    expect(await runCodexHook({ stdin: stdin(input), env: { JEV_CODEX_TRACE_DIR: dir() }, openTrace: () => ({
      ok: true, writer: { write: () => ({ ok: false, error: 'disk_full' }) },
    }) })).toEqual({});
  });

  it('separates Codex defaults and rejects relative overrides', () => {
    expect(codexTraceDir({ XDG_STATE_HOME: '/state', CLAUDE_PROJECT_DIR: '/wrong' })).toBe('/state/jev-gate/codex/traces');
    expect(codexTraceDir({ JEV_CODEX_TRACE_DIR: '/codex', JEV_GATE_TRACE_DIR: '/claude' })).toBe('/codex');
    expect(() => codexTraceDir({ JEV_CODEX_TRACE_DIR: '' })).toThrow();
  });
});

describe('Codex lifecycle in the dashboard', () => {
  const now = new Date('2026-09-30T01:00:10Z');
  const row = (event: string, extra: Record<string, unknown> = {}) => ({ phase: 'codex_event', host: 'codex', event, written_at: '2026-09-30T01:00:00Z', session_id: 's', prompt_id: 'p', invocation_id: event, ...extra });
  it('closes the tool span without prematurely completing the child, and does not count host latency as Jev', () => {
    const records = [row('PreToolUse', { tool_name: 'spawn_agent', tool_use_id: 'call' }), row('SubagentStart', { agent_id: 'child', agent_type: 'default' }), row('PostToolUse', { tool_name: 'spawn_agent', tool_use_id: 'call', written_at: '2026-09-30T01:00:01Z' })];
    const view = buildOperations(records, [], now, { trace: true, host: 'codex' });
    expect(view.runs.filter(r => r.state === 'active')).toHaveLength(1);
    expect(view.feed.find(s => s.title.includes('도구 시작'))).toMatchObject({ state: 'done', durationMs: 1000 });
    expect(view.feed.find(s => s.title.includes('에이전트 시작'))).toMatchObject({ state: 'active' });
    expect(view.requests).toBe(0);
    expect(view.latency.measured).toBe(0);
    expect(view.features.find(f => f.id === 'admission')?.capability?.mode).toBe('connect');
    expect(view.features.find(f => f.id === 'compact')).toMatchObject({ state: 'waiting', capability: { mode: 'connect' } });
    const ended = buildOperations([...records, row('SubagentStop', { agent_id: 'child', written_at: '2026-09-30T01:00:02Z', last_assistant_message: 'SECRET_FINAL' })], [], now, { trace: true });
    expect(ended.active).toBe(0);
    expect(JSON.stringify(ended)).not.toContain('SECRET_FINAL');
    expect(ended.feed.find(s => s.title.includes('종료 이벤트'))?.summary).toContain('수락 검사 없음');
  });
  it('never joins different sessions and records native compaction without inventing Jev requests', () => {
    const records = [row('PreToolUse', { tool_use_id: 'call' }), row('PostToolUse', { session_id: 'other', tool_use_id: 'call' }), row('PreCompact', { written_at: '2026-09-30T00:58:00Z' }), row('PostCompact', { written_at: '2026-09-30T00:58:01Z' }), row('PreCompact')];
    const view = buildOperations(records, [], now, { trace: true });
    expect(view.feed.filter(s => s.state === 'active')).toHaveLength(2);
    expect(view.feed.filter(s => s.feature === 'compact')).toHaveLength(3);
    expect(view.requests).toBe(0);
    expect(view.latency.measured).toBe(0);
    const stale = buildOperations([row('PreToolUse', { tool_use_id: 'lost' })], [], new Date('2026-09-30T02:00:00Z'), { trace: true });
    expect(stale.feed[0]?.state).toBe('unconfirmed');
  });
  it('pairs interrupted turns without reporting successful completion', () => {
    const view = buildOperations([row('UserPromptSubmit'), row('Interrupt', { written_at: '2026-09-30T01:00:01Z' })], [], now, { trace: true });
    expect(view.feed.find(s => s.title.includes('턴 시작'))).toMatchObject({ state: 'interrupted', durationMs: 1000 });
    expect(view.runs[0]?.state).toBe('interrupted');
    expect(view.attention).toBe(0);
    expect(view.active).toBe(0);
  });
  it('ends pending indicators on turn closure without inventing a tool success', () => {
    const view = buildOperations([row('PreToolUse', { tool_use_id: 'lost' }), row('Stop', { written_at: '2026-09-30T01:00:01Z' })], [], now, { trace: true });
    expect(view.runs[0]?.state).toBe('unconfirmed');
    expect(view.active).toBe(0); expect(view.attention).toBe(0);
    expect(view.feed.find(s => s.title.includes('도구 시작'))?.summary).toContain('결과 이벤트는 미관측');
  });
  it('pairs delayed exec receipts across turns by session and call, and propagates observed failure', () => {
    const view = buildOperations([row('PreToolUse', { tool_use_id: 'call' }), row('PostToolUse', { prompt_id: 'later', tool_use_id: 'call', exit_code: 1, written_at: '2026-09-30T01:00:01Z' })], [], now, { trace: true });
    expect(view.feed.find(s => s.title.includes('도구 시작'))).toMatchObject({ state: 'error', durationMs: 1000 });
    expect(view.active).toBe(0); expect(view.attention).toBe(2);
  });
  it('filters a shared trace directory by host', async () => {
    const path = dir();
    await runCodexHook({ stdin: stdin(input), env: { JEV_CODEX_TRACE_DIR: path } });
    const codex = loadActivity({ traceDir: path, env: {}, host: 'codex' });
    const claude = loadActivity({ traceDir: path, env: {}, host: 'claude' });
    expect(codex.operations.runs.length).toBeGreaterThan(0);
    expect(codex.host).toBe('codex');
    expect(claude.operations.runs).toEqual([]);
  });
});
