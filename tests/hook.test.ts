import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ALLOCATION_SENTENCE } from '../src/coordinator.js';
import { MAX_STDIN_BYTES, runHook, type HookDeps } from '../src/hook.js';
import { CONTEXT_ANSWERS, ROUTE_ANSWERS, TASK_KINDS } from '../src/types.js';

const KEY = 'ts-secret-key-123';
const PROMPT = 'Implement pan and zoom.\r\nPreserve the camera API.\n```js\nconst z = "😀";\n```';
const choice = (keys: readonly string[], winner: string, p = 0.9, confidence = p): Record<string, unknown> => ({ type: 'choice', choice: winner, probabilities: Object.fromEntries(keys.map((k) => [k, k === winner ? p : (1 - p) / (keys.length - 1)])), confidence });
const answers = (route = 'opus', context = 'ready'): Record<string, unknown> => ({ context: choice(CONTEXT_ANSWERS, context), route: choice(ROUTE_ANSWERS, route), kind: choice(TASK_KINDS, 'implement') });
const jevOk = (route = 'opus', context = 'ready'): typeof fetch => (async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: answers(route, context), usage: { input_tokens: 400, output_tokens: 20 } }), { status: 200 })) as unknown as typeof fetch;

const stdinOf = (value: unknown): AsyncIterable<Uint8Array> => (async function* () { yield Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'); })();
const pre = (input: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: 's1', cwd: '/w', permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1',
  tool_input: { subagent_type: 'jev-gate:worker', description: 'Implement camera controls', prompt: PROMPT, run_in_background: false, ...input },
  ...top,
});
const prompt = (text = 'Fix the search race and add a regression test.', top: Record<string, unknown> = {}): Record<string, unknown> => ({ session_id: 's1', cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: text, ...top });
const ENV = { TYPESAFE_API_KEY: KEY, HOME: '/nonexistent-home', JEV_GATE_MODE: 'auto' };
const run = (deps: Partial<HookDeps> & { stdin: HookDeps['stdin'] }): ReturnType<typeof runHook> => runHook({ env: ENV, fetchImpl: jevOk(), ...deps });
const parse = (s: string): { hookSpecificOutput: Record<string, unknown> } => JSON.parse(s);

describe('UserPromptSubmit', () => {
  it('injects fixed coordinator guidance in native/auto with zero Jev calls and no prompt echo', async () => {
    const fetchImpl = vi.fn();
    const auto = await run({ stdin: stdinOf(prompt()), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(auto.kind).toBe('guidance');
    const ctx = String(parse(auto.stdout!).hookSpecificOutput['additionalContext']);
    expect(parse(auto.stdout!).hookSpecificOutput['hookEventName']).toBe('UserPromptSubmit');
    expect(ctx).toContain(ALLOCATION_SENTENCE.auto);
    expect(ctx).not.toContain('search race');
    const native = await run({ stdin: stdinOf(prompt()), env: { ...ENV, JEV_GATE_MODE: 'native' }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(String(parse(native.stdout!).hookSpecificOutput['additionalContext'])).toContain(ALLOCATION_SENTENCE.native);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('adds nothing for off mode, empty, slash, child and custom-agent inputs', async () => {
    expect(await run({ stdin: stdinOf(prompt()), env: { ...ENV, JEV_GATE_MODE: 'off' } })).toMatchObject({ kind: 'skip', code: 'mode_off' });
    expect(await run({ stdin: stdinOf(prompt()), env: { TYPESAFE_API_KEY: KEY, HOME: '/nonexistent-home' } })).toMatchObject({ kind: 'skip', code: 'mode_off' });
    for (const p of [prompt('  '), prompt('/model opus'), prompt('x', { agent_id: 'a' }), prompt('x', { agent_type: 'custom' })]) {
      expect(await run({ stdin: stdinOf(p) })).toMatchObject({ kind: 'skip', code: null });
    }
  });
});

describe('PreToolUse:Agent', () => {
  it('patches the full input with model and suffix after exactly one Jev call', async () => {
    const fetchImpl = vi.fn(jevOk('opus'));
    const r = await run({ stdin: stdinOf(pre({ mode: 'default', extra: { keep: true } })), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.kind).toBe('patch');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const out = parse(r.stdout!).hookSpecificOutput;
    expect(out['hookEventName']).toBe('PreToolUse');
    expect(out).not.toHaveProperty('permissionDecision');
    const updated = out['updatedInput'] as Record<string, unknown>;
    expect(updated).toMatchObject({ subagent_type: 'jev-gate:worker', description: 'Implement camera controls', run_in_background: false, mode: 'default', extra: { keep: true }, model: 'opus' });
    expect(String(updated['prompt']).startsWith(PROMPT)).toBe(true);
    expect(String(updated['prompt'])).toContain('[Jev Gate task hint]\nTask kind: implement.');
    expect(r.stdout).not.toContain(KEY);
    expect(r.stdout!.trim().split('\n')).toHaveLength(1);
  });

  it('uses the configured model identifier for the selected tier', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jev-cfg-'));
    writeFileSync(join(tmp, 'c.json'), JSON.stringify({ version: 4, mode: 'auto', models: { opus: 'claude-opus-5' } }));
    const r = await run({ stdin: stdinOf(pre()), env: { ...ENV, JEV_GATE_CONFIG: join(tmp, 'c.json') } });
    expect((parse(r.stdout!).hookSpecificOutput['updatedInput'] as Record<string, unknown>)['model']).toBe('claude-opus-5');
    rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    ['mode off (env, before config)', { ...ENV, JEV_GATE_MODE: 'off', JEV_GATE_CONFIG: '/nope/invalid.json' }, pre(), 'mode_off'],
    ['mode native', { ...ENV, JEV_GATE_MODE: 'native' }, pre(), 'mode_native'],
    ['invalid config', { ...ENV, JEV_GATE_CONFIG: '/nope/missing.json' }, pre(), 'config_invalid'],
    ['key missing', { HOME: '/nonexistent-home', JEV_GATE_MODE: 'auto' }, pre(), 'key_missing'],
    ['caller pin', ENV, pre({ model: 'sonnet' }), 'model_pinned'],
    ['background', ENV, pre({ run_in_background: true }), 'not_foreground'],
    ['resume control', ENV, pre({ resume: 'agent-1' }), 'execution_control_present'],
    ['child caller', ENV, pre({}, { agent_id: 'child' }), 'child_caller'],
    ['other agent', ENV, pre({ subagent_type: 'Explore' }), 'role_not_owned'],
    ['concrete override', { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, pre(), 'subagent_model_override'],
  ])('%s → preserve with HTTP 0', async (_n, env, input, code) => {
    const fetchImpl = vi.fn(jevOk());
    expect(await run({ stdin: stdinOf(input), env, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ kind: 'preserve', code, stdout: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves on HTTP errors and timeouts with one attempt, and on the V3 .77 policy case', async () => {
    const e429 = vi.fn(async () => new Response('{}', { status: 429 }));
    expect(await run({ stdin: stdinOf(pre()), fetchImpl: e429 as unknown as typeof fetch })).toEqual({ kind: 'preserve', code: 'http_429', stdout: null });
    expect(e429).toHaveBeenCalledTimes(1);
    const hang = vi.fn((_: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('abort')))));
    const tmp = mkdtempSync(join(tmpdir(), 'jev-cfg-'));
    writeFileSync(join(tmp, 'c.json'), JSON.stringify({ version: 4, mode: 'auto', requestDeadlineMs: 20 }));
    expect(await run({ stdin: stdinOf(pre()), env: { ...ENV, JEV_GATE_CONFIG: join(tmp, 'c.json') }, fetchImpl: hang as unknown as typeof fetch })).toMatchObject({ kind: 'preserve', code: 'timeout' });
    rmSync(tmp, { recursive: true, force: true });
    const v3 = (async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { ...answers(), route: { type: 'choice', choice: 'sonnet', probabilities: { sonnet: 0.82, opus: 0.18, fable: 0, abstain: 0 }, confidence: 0.77 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })) as unknown as typeof fetch;
    expect(await run({ stdin: stdinOf(pre()), fetchImpl: v3 })).toEqual({ kind: 'preserve', code: 'route_low_confidence', stdout: null });
    expect(await run({ stdin: stdinOf(pre()), fetchImpl: jevOk('opus', 'needs_context') })).toEqual({ kind: 'preserve', code: 'needs_context', stdout: null });
  });

  it('cancellation before evaluation makes no request; an oversized envelope is discarded whole after the attempt', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = vi.fn(jevOk());
    expect(await run({ stdin: stdinOf(pre()), signal: ac.signal, fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ kind: 'preserve', code: 'aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();
    // The 512 KiB envelope bound is unreachable through stdin (256 KiB cap): a large-but-legal input still patches whole.
    const large = await run({ stdin: stdinOf(pre({ extra: 'z'.repeat(150 * 1024) })), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(large.kind).toBe('patch');
    expect((parse(large.stdout!).hookSpecificOutput['updatedInput'] as Record<string, unknown>)['extra']).toHaveLength(150 * 1024);
    expect(await run({ stdin: stdinOf(pre({ extra: 'z'.repeat(300 * 1024) })), fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ kind: 'skip', code: 'stdin_too_large' });
  });
});

describe('trace (opt-in)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'jev-hook-trace-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const records = (dir: string): Array<Record<string, unknown>> => readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);

  it('writes intent before the request and a terminal result after it, never the key', async () => {
    const dir = join(tmp, 'ok');
    const r = await run({ stdin: stdinOf(pre()), env: { ...ENV, JEV_GATE_TRACE_DIR: dir } });
    expect(r.kind).toBe('patch');
    const recs = records(dir);
    const intent = recs.find((x) => x['phase'] === 'pre_intent')!;
    const result = recs.find((x) => x['phase'] === 'pre_result')!;
    expect(intent).toMatchObject({ session_id: 's1', tool_use_id: 'toolu_1', role: 'worker', caller: { agent_id: null, agent_type: null } });
    expect(result).toMatchObject({ attempted: true, http: { status: 200 }, jev: { model: 'jev-1.13.0', usage: { input_tokens: 400 } }, decision: { action: 'patch', tier: 'opus', kind: 'implement' }, patch: { model: 'opus', emitted: true } });
    const all = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('Bearer');
    expect(all).not.toContain(PROMPT);
  });

  it('records a completed pre-call skip as known_not_sent and a failed attempt as attempted with unknown usage', async () => {
    const dir = join(tmp, 'skip');
    await run({ stdin: stdinOf(pre({ model: 'opus' })), env: { ...ENV, JEV_GATE_TRACE_DIR: dir } });
    expect(records(dir)).toEqual([expect.objectContaining({ phase: 'pre_result', attempted: false, known_not_sent: true, skip_code: 'model_pinned' })]);
    const dir2 = join(tmp, 'fail');
    await run({ stdin: stdinOf(pre()), env: { ...ENV, JEV_GATE_TRACE_DIR: dir2 }, fetchImpl: (async () => new Response('{}', { status: 529 })) as unknown as typeof fetch });
    const res = records(dir2).find((x) => x['phase'] === 'pre_result')!;
    expect(res).toMatchObject({ attempted: true, http: { status: 529, code: 'http_529' }, jev: { usage: null }, decision: null });
  });

  it('an intent that cannot be written prevents the Jev call and preserves the input', async () => {
    const fetchImpl = vi.fn(jevOk());
    const file = join(tmp, 'not-a-dir');
    writeFileSync(file, 'x');
    expect(await run({ stdin: stdinOf(pre()), env: { ...ENV, JEV_GATE_TRACE_DIR: join(file, 'sub') }, fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ kind: 'preserve', code: 'trace_intent_failed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('post and failure events record whitelisted facts only and emit nothing', async () => {
    const dir = join(tmp, 'post');
    const fetchImpl = vi.fn();
    const post = { ...pre(), hook_event_name: 'PostToolUse', tool_response: { status: 'completed', agentId: 'a1', resolvedModel: 'claude-sonnet-5', modelsUsed: ['claude-sonnet-5', 'claude-haiku-4-5'], totalDurationMs: 4000, totalToolUseCount: 3, totalTokens: 999, usage: { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 7, cache_read_input_tokens: 8 }, content: [{ type: 'text', text: 'SECRET body' }], weird: 'reflected sk-x' }, duration_ms: 4100 };
    expect(await run({ stdin: stdinOf(post), env: { ...ENV, JEV_GATE_TRACE_DIR: dir }, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ kind: 'skip', code: null, stdout: null });
    const fail = { ...pre(), hook_event_name: 'PostToolUseFailure', error: 'Agent terminated early\nsk-leak line two', is_interrupt: false, duration_ms: 10 };
    await run({ stdin: stdinOf(fail), env: { ...ENV, JEV_GATE_TRACE_DIR: dir }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    const recs = records(dir);
    const p = recs.find((x) => x['phase'] === 'post')!;
    expect(p).toMatchObject({ tool_use_id: 'toolu_1', tool_response: { status: 'completed', agentId: 'a1', resolvedModel: 'claude-sonnet-5', modelsUsed: ['claude-sonnet-5', 'claude-haiku-4-5'], totalTokens: 999, usage: { input_tokens: 5, cache_read_input_tokens: 8 } }, tool_input: { subagent_type: 'jev-gate:worker', has_model: false }, duration_ms: 4100 });
    expect(JSON.stringify(p)).not.toMatch(/SECRET|reflected|weird/);
    const f = recs.find((x) => x['phase'] === 'failure')!;
    expect(f).toMatchObject({ error_first_line: 'Agent terminated early', is_interrupt: false });
    expect(JSON.stringify(f)).not.toContain('sk-leak');
  });

  it('writes nothing when mode is off even with a trace dir', async () => {
    const dir = join(tmp, 'off');
    await run({ stdin: stdinOf(pre()), env: { ...ENV, JEV_GATE_MODE: 'off', JEV_GATE_TRACE_DIR: dir } });
    await run({ stdin: stdinOf(prompt()), env: { ...ENV, JEV_GATE_MODE: 'off', JEV_GATE_TRACE_DIR: dir } });
    expect(existsSync(dir)).toBe(false);
  });
});

describe('sources', () => {
  it('hook modules never spawn processes or read the transcript/credentials', () => {
    for (const f of ['hook.ts', 'jev.ts', 'brief.ts', 'blocks.ts', 'config.ts', 'coordinator.ts', 'trace.ts']) {
      const src = readFileSync(join(__dirname, '..', 'src', f), 'utf8');
      expect(src, f).not.toMatch(/child_process|execSync|spawn\(/);
      expect(src, f).not.toMatch(/\.credentials|keychain|transcript_path/);
    }
    const hook = readFileSync(join(__dirname, '..', 'src', 'hook.ts'), 'utf8');
    expect(hook).not.toMatch(/permissionDecision|updatedPermissions|decision:\s*['"]block['"]|continue:\s*false|exit\(2\)|exitCode = 2/);
  });
});

describe('dist/hook.js (process)', () => {
  let tmp: string;
  let hookPath: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jev gate v4 '));
    const out = join(tmp, 'plugin dir', 'dist');
    const r = spawnSync(process.execPath, [join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(__dirname, '..', 'tsconfig.json'), '--outDir', out], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    hookPath = join(out, 'hook.js');
    cpSync(join(__dirname, '..', 'hooks'), join(tmp, 'plugin dir', 'hooks'), { recursive: true });
  }, 60_000);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const exec = (stdin: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [hookPath], { input: stdin, cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home'), ...env } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('preserves an eligible call with only a fixed stderr code when the key is missing; injects guidance for prompts', () => {
    expect(exec(JSON.stringify(pre()), { JEV_GATE_MODE: 'auto' })).toEqual({ status: 0, stdout: '', stderr: 'jev-gate: key_missing\n' });
    const g = exec(JSON.stringify(prompt()), { JEV_GATE_MODE: 'auto' });
    expect(g.status).toBe(0);
    expect(g.stdout.trim().split('\n')).toHaveLength(1);
    expect(String(parse(g.stdout).hookSpecificOutput['additionalContext'])).toContain('coordinator guidance');
    expect(exec(JSON.stringify(pre()), {})).toEqual({ status: 0, stdout: '', stderr: 'jev-gate: mode_off\n' });
  });

  it('fails native on invalid, non-UTF-8 or oversized stdin without external work', () => {
    expect(exec('{not json', { JEV_GATE_MODE: 'auto' })).toEqual({ status: 0, stdout: '', stderr: 'jev-gate: stdin_invalid_json\n' });
    expect(exec('{"hook_event_name":"PreToolUse","prompt":"' + 'y'.repeat(MAX_STDIN_BYTES) + '"}', { JEV_GATE_MODE: 'auto' })).toEqual({ status: 0, stdout: '', stderr: 'jev-gate: stdin_too_large\n' });
    const bad = spawnSync(process.execPath, [hookPath], { input: Buffer.concat([Buffer.from('{"hook_event_name":"PreToolUse","prompt":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]), cwd: tmpdir(), env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home'), JEV_GATE_MODE: 'auto' } });
    expect(bad.status).toBe(0);
    expect(bad.stdout.toString()).toBe('');
    expect(bad.stderr.toString()).toBe('jev-gate: stdin_invalid_utf8\n');
  });

  it('hooks.json registers exactly one shell-form command per event on ^Agent$ that resolves with a space in the plugin path', () => {
    const hooks = JSON.parse(readFileSync(join(tmp, 'plugin dir', 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>> };
    expect(hooks.hooks['UserPromptSubmit']![0]!.matcher).toBeUndefined();
    for (const ev of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      expect(hooks.hooks[ev]).toHaveLength(1);
      expect(hooks.hooks[ev]![0]!.matcher).toBe('^Agent$');
      expect(hooks.hooks[ev]![0]!.hooks).toEqual([{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"', timeout: 5 }]);
    }
    const resolved = hooks.hooks['PreToolUse']![0]!.hooks[0]!.command.replace('${CLAUDE_PLUGIN_ROOT}', join(tmp, 'plugin dir'));
    const r = spawnSync(resolved, { shell: true, input: JSON.stringify(pre()), encoding: 'utf8', cwd: tmpdir(), env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home'), JEV_GATE_MODE: 'auto' } });
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: 'jev-gate: key_missing\n' });
  });
});
