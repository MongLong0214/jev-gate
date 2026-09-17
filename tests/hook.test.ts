import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { NEUTRAL_REMINDER } from '../src/brief.js';
import { MAX_PROMPT_BYTES, MAX_STDIN_BYTES, runHook, type HookDeps, type TraceRecord } from '../src/hook.js';
import { KINDS, ROLES, ROUTES } from '../src/types.js';

const PROMPT = '검색 응답이 역순으로 오면 옛 결과가 화면을 덮는 버그를 고쳐줘.\nAPI 응답 형식과 의존성은 바꾸지 마.\n늦은 응답을 재현하는 테스트도 추가해.';
const KEY = 'ts-secret-key-123';

const choice = (keys: readonly string[], winner: string, p = 0.9): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === winner ? p : (1 - p) / (keys.length - 1)])),
  confidence: p,
});
const answers = (route: string): Record<string, unknown> => ({ task_kind: choice(KINDS, 'debug'), route: choice(ROUTES, route), role_u1: choice(ROLES, 'goal'), role_u2: choice(ROLES, 'constraint'), role_u3: choice(ROLES, 'acceptance') });
const jevOk = (route: string): typeof fetch => (async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: answers(route), usage: { input_tokens: 400, output_tokens: 20 } }), { status: 200 })) as unknown as typeof fetch;

const stdinOf = (value: unknown): AsyncIterable<Uint8Array> => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (async function* () {
    yield Buffer.from(text, 'utf8');
  })();
};
const input = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ session_id: 's1', transcript_path: '/nope/t.jsonl', cwd: '/w', permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: PROMPT, ...extra });
const enoentRead = (): never => {
  const e = new Error('x') as NodeJS.ErrnoException;
  e.code = 'ENOENT';
  throw e;
};
const run = (deps: Partial<HookDeps> & { stdin: HookDeps['stdin'] }): ReturnType<typeof runHook> => runHook({ env: { TYPESAFE_API_KEY: KEY, HOME: '/nonexistent-home' }, fetchImpl: jevOk('opus'), ...deps });
void enoentRead;

const parse = (stdout: string): { hookSpecificOutput: { hookEventName: string; additionalContext: string } } => JSON.parse(stdout);

describe('runHook (in-process)', () => {
  it.each([
    ['opus', 'delegate to jev-gate:opus; requested model: opus'],
    ['fable', 'delegate to jev-gate:frontier; requested model: fable'],
    ['sonnet', 'handle in the current main session'],
    ['context_required', 'resolve in the current conversation (context_required)'],
  ])('emits one hook JSON for route %s', async (route, expected) => {
    const fetchImpl = vi.fn(jevOk(route));
    const r = await run({ stdin: stdinOf(input()), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.kind).toBe('output');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const out = parse(r.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toContain(expected);
    expect(out.hookSpecificOutput.additionalContext).toContain('- u2 constraint: "API 응답 형식과 의존성은 바꾸지 마.\\n"');
    expect(r.stdout).not.toContain(KEY);
  });

  it('skips silently without any Jev call for other events, subagents, empty prompts, slash commands and mode=off', async () => {
    const fetchImpl = vi.fn(jevOk('opus'));
    for (const stdin of [stdinOf(input({ hook_event_name: 'PreToolUse' })), stdinOf(input({ agent_id: 'a1', agent_type: 'Explore' })), stdinOf(input({ prompt: '   \n' })), stdinOf(input({ prompt: '/model opus' })), stdinOf({ hook_event_name: 'UserPromptSubmit' })]) {
      expect(await run({ stdin, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ kind: 'skip', code: null, stdout: null });
    }
    expect(await run({ stdin: stdinOf(input()), fetchImpl: fetchImpl as unknown as typeof fetch, env: { TYPESAFE_API_KEY: KEY, JEV_GATE_MODE: 'off', HOME: '/nonexistent-home' } })).toMatchObject({ kind: 'skip' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back with the neutral reminder and no Jev call when the key is missing, the config is invalid or the prompt is too large', async () => {
    const fetchImpl = vi.fn(jevOk('opus'));
    const noKey = await run({ stdin: stdinOf(input()), fetchImpl: fetchImpl as unknown as typeof fetch, env: { HOME: '/nonexistent-home' } });
    expect(noKey).toMatchObject({ kind: 'fallback', code: 'key_missing' });
    expect(parse(noKey.stdout!).hookSpecificOutput.additionalContext).toBe(NEUTRAL_REMINDER);
    const badConfig = await run({ stdin: stdinOf(input()), fetchImpl: fetchImpl as unknown as typeof fetch, env: { TYPESAFE_API_KEY: KEY, JEV_GATE_MODE: 'bogus', HOME: '/nonexistent-home' } });
    expect(badConfig).toMatchObject({ kind: 'fallback', code: 'config_invalid' });
    const big = await run({ stdin: stdinOf(input({ prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1) })), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(big).toMatchObject({ kind: 'fallback', code: 'prompt_too_large' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores oversize or malformed stdin without output', async () => {
    const fetchImpl = vi.fn(jevOk('opus'));
    expect(await run({ stdin: stdinOf('{"hook_event_name":"UserPromptSubmit","prompt":"' + 'y'.repeat(MAX_STDIN_BYTES) + '"}'), fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ kind: 'skip', code: 'stdin_too_large' });
    expect(await run({ stdin: stdinOf('not json'), fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ kind: 'skip', code: 'stdin_invalid_json' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'http_401'],
    [429, 'http_429'],
  ])('keeps the prompt flowing on HTTP %s with a single request', async (status, code) => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"x"}', { status }));
    const r = await run({ stdin: stdinOf(input()), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ kind: 'fallback', code });
    expect(parse(r.stdout!).hookSpecificOutput.additionalContext).toBe(NEUTRAL_REMINDER);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back on timeout and invalid JSON without retrying', async () => {
    const hanging = vi.fn((_: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('abort')))));
    const t = await run({ stdin: stdinOf(input()), fetchImpl: hanging as unknown as typeof fetch, env: { TYPESAFE_API_KEY: KEY, HOME: '/nonexistent-home', JEV_GATE_MODE: 'auto' } });
    expect(t).toMatchObject({ kind: 'fallback' });
    expect(['timeout', 'network']).toContain(t.code);
    expect(hanging).toHaveBeenCalledTimes(1);
    const invalid = vi.fn(async () => new Response('<html>', { status: 200 }));
    expect(await run({ stdin: stdinOf(input()), fetchImpl: invalid as unknown as typeof fetch })).toMatchObject({ kind: 'fallback', code: 'response_invalid' });
    expect(invalid).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('writes a trace only when JEV_GATE_TRACE_DIR is set, without the key, and degrades on write failure', async () => {
    const files = new Map<string, string>();
    const traceFs = { mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async (p: string, d: string) => void files.set(p, d)) };
    const ok = await run({ stdin: stdinOf(input()), env: { TYPESAFE_API_KEY: KEY, HOME: '/nonexistent-home', JEV_GATE_TRACE_DIR: '/trace/out' }, traceFs });
    expect(ok.kind).toBe('output');
    expect(traceFs.mkdir).toHaveBeenCalledWith('/trace/out');
    expect(files.size).toBe(1);
    const [path, body] = [...files.entries()][0]!;
    expect(path).toMatch(/^\/trace\/out\/hook-[0-9a-f-]{36}\.json$/);
    const trace = JSON.parse(body) as TraceRecord;
    expect(trace).toMatchObject({ version: 3, session_id: 's1', mode: 'auto', jev: { called: true, status: 200, model: 'jev-1.13.0', usage: { input_tokens: 400 } }, decision: { execution: 'delegate', agentName: 'jev-gate:opus' }, output: { kind: 'output' } });
    expect(trace.input?.prompt).toBe(PROMPT);
    expect(body).not.toContain(KEY);
    expect(body).not.toContain('Bearer');

    const noTrace = await run({ stdin: stdinOf(input()), traceFs });
    expect(noTrace.kind).toBe('output');
    expect(files.size).toBe(1);

    const unwritable = { mkdir: vi.fn(async () => Promise.reject(new Error('ro'))), writeFile: vi.fn() };
    const fetchImpl = vi.fn(jevOk('opus'));
    expect(await run({ stdin: stdinOf(input()), env: { TYPESAFE_API_KEY: KEY, HOME: '/nonexistent-home', JEV_GATE_TRACE_DIR: '/ro' }, traceFs: unwritable, fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ kind: 'fallback', code: 'trace_dir_unwritable' });
    expect(fetchImpl).not.toHaveBeenCalled();

    const failingWrite = { mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => Promise.reject(new Error('disk'))) };
    const degraded = await run({ stdin: stdinOf(input()), env: { TYPESAFE_API_KEY: KEY, HOME: '/nonexistent-home', JEV_GATE_TRACE_DIR: '/t' }, traceFs: failingWrite });
    expect(degraded).toMatchObject({ kind: 'fallback', code: 'trace_write_failed' });
    expect(parse(degraded.stdout!).hookSpecificOutput.additionalContext).toBe(NEUTRAL_REMINDER);
  });

  it('records fallbacks in the trace too', async () => {
    const files = new Map<string, string>();
    const traceFs = { mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async (p: string, d: string) => void files.set(p, d)) };
    const r = await run({ stdin: stdinOf(input()), env: { TYPESAFE_API_KEY: KEY, HOME: '/nonexistent-home', JEV_GATE_TRACE_DIR: '/t' }, traceFs, fetchImpl: (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch });
    expect(r.code).toBe('http_429');
    const trace = JSON.parse([...files.values()][0]!) as TraceRecord;
    expect(trace).toMatchObject({ error_code: 'http_429', jev: { called: true, status: 429, usage: null }, decision: { execution: 'native_fallback', reason: 'error' }, output: { kind: 'fallback' } });
  });
});

describe('runHook trace on disk', () => {
  it('creates the trace directory before the first fallback so key_missing is recorded', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'jev-trace-')), 'nested', 'trace');
    const r = await runHook({ stdin: stdinOf(input()), env: { HOME: '/nonexistent-home', JEV_GATE_TRACE_DIR: dir } });
    expect(r).toMatchObject({ kind: 'fallback', code: 'key_missing' });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const trace = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as TraceRecord;
    expect(trace).toMatchObject({ error_code: 'key_missing', jev: { called: false }, output: { kind: 'fallback' } });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('hook sources', () => {
  it('never spawn processes or read the transcript, credentials or .env', () => {
    for (const f of ['hook.ts', 'jev.ts', 'brief.ts', 'blocks.ts', 'config.ts']) {
      const src = readFileSync(join(__dirname, '..', 'src', f), 'utf8');
      expect(src, f).not.toMatch(/child_process|execSync|spawn/);
      expect(src, f).not.toMatch(/\.credentials|keychain|OAuth|\.env['"]/);
    }
    const hook = readFileSync(join(__dirname, '..', 'src', 'hook.ts'), 'utf8');
    expect(hook).not.toMatch(/readFile|createReadStream/);
    expect(hook).not.toMatch(/decision:\s*['"]block['"]|continue:\s*false|exit\(2\)|exitCode = 2/);
  });
});

describe('dist/hook.js (process)', () => {
  let tmp: string;
  let hookPath: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jev gate space '));
    const out = join(tmp, 'plugin dir', 'dist');
    const r = spawnSync(process.execPath, [join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(__dirname, '..', 'tsconfig.json'), '--outDir', out], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    hookPath = join(out, 'hook.js');
    expect(existsSync(hookPath)).toBe(true);
    cpSync(join(__dirname, '..', 'hooks'), join(tmp, 'plugin dir', 'hooks'), { recursive: true });
  }, 60_000);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const exec = (stdin: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [hookPath], { input: stdin, cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home'), ...env } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('from another cwd with a space in the plugin path, emits exactly one JSON line and the fixed code on stderr when the key is missing', () => {
    const r = exec(JSON.stringify(input()));
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(parse(r.stdout).hookSpecificOutput.additionalContext).toBe(NEUTRAL_REMINDER);
    expect(r.stderr.trim()).toBe('jev-gate: key_missing');
  });

  it('prints nothing for subagent events and mode=off', () => {
    expect(exec(JSON.stringify(input({ agent_id: 'x' })), { TYPESAFE_API_KEY: 'k' })).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(exec(JSON.stringify(input()), { TYPESAFE_API_KEY: 'k', JEV_GATE_MODE: 'off' })).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('matches the command registered in hooks.json', () => {
    const hooks = JSON.parse(readFileSync(join(tmp, 'plugin dir', 'hooks', 'hooks.json'), 'utf8')) as { hooks: { UserPromptSubmit: Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }> } };
    const handlers = hooks.hooks.UserPromptSubmit.flatMap((g) => g.hooks);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatchObject({ type: 'command', timeout: 5 });
    expect(handlers[0]!.command).toBe('node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"');
    const resolved = handlers[0]!.command.replace('${CLAUDE_PLUGIN_ROOT}', join(tmp, 'plugin dir'));
    const r = spawnSync(resolved, { shell: true, input: JSON.stringify(input()), encoding: 'utf8', cwd: tmpdir(), env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home') } });
    expect(r.status).toBe(0);
    expect(parse(r.stdout).hookSpecificOutput.additionalContext).toBe(NEUTRAL_REMINDER);
  });
});
