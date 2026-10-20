import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHook } from '../src/hook.js';
import { jobPath, MAX_HISTORY, newGeneration, readJob, updateJob } from '../src/job.js';
import { claudeDefaults, prepareClaude } from '../src/claude-setup.js';
import { isNativeTaskNotification, isStopNotice, noticeClaim } from '../src/claude-background.js';
import { humanInputText } from '../src/recent-prompts.js';

// Exercise the real state writer through fsync, failing only the claim's rename. Other writes (including a new human
// generation) still commit. A tmp-open failure would not prove that the classifier honors the writer's final result.
const renameFailure = vi.hoisted(() => ({ file: '', claim: '', calls: 0 }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (String(args[1]) === renameFailure.file && JSON.parse(actual.readFileSync(args[0], 'utf8')).current.notices_taken?.includes(renameFailure.claim)) {
      renameFailure.calls++;
      throw Object.assign(new Error('fixture claim rename is full'), { code: 'ENOSPC' });
    }
    return actual.renameSync(...args);
  } };
});

const roots: string[] = [];
afterEach(() => {
  renameFailure.file = ''; renameFailure.claim = ''; renameFailure.calls = 0;
  roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true }));
});
const fixture = async (direct = false, reportFields: Record<string, unknown> = {}, workerIsolation: 'none' | 'worktree' = 'none') => {
  const root = mkdtempSync('/tmp/jev-bg-unit-'); roots.push(root);
  const cfg = join(root, 'config.json');
  writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'native', workerIsolation }));
  const env = { JEV_GATE_TRACE_DIR: join(root, 'trace'), HOME: root, JEV_GATE_CONFIG: cfg, JEV_GATE_STATE_DIR: join(root, 'state'), CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0', JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' };
  const parent = join(root, 's.jsonl'); writeFileSync(parent, '');
  const run = (event: Record<string, unknown>, fetchImpl?: typeof fetch) => runHook({ env, ...(fetchImpl ? { fetchImpl } : {}), stdin: (async function* () { yield JSON.stringify({ session_id: 's', transcript_path: parent, ...event }); })() });
  await run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'original', prompt: 'Implement the original request.' });
  if (direct) updateJob(env, 's', prev => newGeneration(prev, 's', 'original', 'direct').state);
  const pre = await run({ hook_event_name: 'PreToolUse', prompt_id: 'original', tool_name: 'Agent', tool_use_id: 'dispatch', tool_input: { subagent_type: 'jev-gate:worker', prompt: 'Do the original work.', description: 'work', model: 'sonnet', run_in_background: false } });
  expect(pre.kind, JSON.stringify(pre)).toBe('patch');
  const input = JSON.parse(pre.stdout!).hookSpecificOutput.updatedInput;
  const path = join(root, 's', 'subagents', 'agent-worker.jsonl'); mkdirSync(join(root, 's', 'subagents'), { recursive: true });
  const report = JSON.stringify({ status: 'done', summary: 'original result', changed_files: [], interfaces: [], checks: [], blockers: [], ...reportFields });
  const transcript = (error = false) => writeFileSync(path, [
    { type: 'user', agentId: 'worker', sessionId: 's', message: { content: input.prompt } },
    { type: 'assistant', agentId: 'worker', sessionId: 's', isApiErrorMessage: error, message: { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: report }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const terminal = (over = {}) => run({ hook_event_name: 'SubagentStop', prompt_id: 'question', agent_id: 'worker', agent_type: 'jev-gate:worker', agent_transcript_path: path, last_assistant_message: report, ...over });
  const launch = () => run({ hook_event_name: 'PostToolUse', prompt_id: 'original', tool_name: 'Agent', tool_use_id: 'dispatch', tool_input: input, tool_response: { status: 'async_launched', isAsync: true, agentId: 'worker', resolvedModel: 'claude-sonnet-5' } });
  const job = () => { const r = readJob(env, 's'); if (!r.ok || !r.value) throw new Error('missing job'); return r.value; };
  return { root, cfg, parent, env, run, pre, input, path, report, transcript, terminal, launch, job };
};

describe('responsive native background contracts', () => {
  it('C1: retains functional Claude settlement and replay fields while dropping unscreened commands and notes', async () => {
    const command = 'printf sessionid=canary123', note = 'sessionid=canary123_note';
    const fields = { status: 'blocked', summary: 'Functional Claude result', changed_files: ['src/claude-result.ts'], interfaces: ['integrate(): void'], blockers: ['Needs integration'],
      checks: [{ check_id: command, result: 'pass', note, observed_output: note, error: note }] };
    for (const isolation of ['none', 'worktree'] as const) {
      const f = await fixture(false, fields, isolation); await f.launch(); f.transcript(); await f.terminal();
      const replay = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'delivery', prompt: 'Explain the result.' });
      const context = f.job().current.background_context!;
      const foreground = await fixture(false, fields, isolation); foreground.transcript();
      const post = await foreground.run({ hook_event_name: 'PostToolUse', prompt_id: 'original', tool_name: 'Agent', tool_use_id: 'dispatch', tool_input: foreground.input,
        tool_response: { status: 'completed', agentId: 'worker', content: [{ type: 'text', text: foreground.report }] } });
      expect(JSON.parse(post.stdout!).hookSpecificOutput.additionalContext).toBe(context);
      for (const value of [context, JSON.stringify(replay), readFileSync(jobPath(f.env, 's'), 'utf8')]) {
        expect(value).not.toContain('sessionid=canary123');
        for (const text of ['Functional Claude result', 'src/claude-result.ts', 'integrate(): void', 'Needs integration']) expect(value).toContain(text);
      }
    }
  });

  it.each([false, true])('B3: strips report prose from Claude background settlement and replay (direct=%s)', async direct => {
    const sentinel = 'B3_SYNTHETIC_CLAUDE_BACKGROUND_SENTINEL';
    const text = `echo ${sentinel}; Bearer synthetic-${sentinel}`;
    const f = await fixture(direct, { summary: text, changed_files: [text], interfaces: [text], blockers: [text],
      checks: [{ check_id: 'npm test', result: 'pass', note: text, observed_output: text, output: text, error: text }] });
    await f.launch(); f.transcript();
    const rows = readFileSync(f.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    rows.splice(1, 0,
      { type: 'assistant', agentId: 'worker', sessionId: 's', message: { content: [{ type: 'tool_use', id: 'check', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', agentId: 'worker', sessionId: 's', message: { content: [{ type: 'tool_result', tool_use_id: 'check', content: text }] } });
    writeFileSync(f.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const terminal = await f.terminal();
    expect(f.job().current.receipts[0]?.reply).toEqual({ status: 'done', changed_files: [], interfaces: [], blockers: [], checks: [{ check_id: '#1', result: 'pass' }] });
    const replay = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'delivery', prompt: 'Explain the result.' });
    const trace = readdirSync(join(f.root, 'trace')).map(file => readFileSync(join(f.root, 'trace', file), 'utf8')).join('\n');
    for (const output of [readFileSync(jobPath(f.env, 's'), 'utf8'), f.job().current.background_context, JSON.stringify(terminal), JSON.stringify(replay), trace]) expect.soft(output).not.toContain(sentinel);
  });

  it('absorbs a native cancellation notice by its host row, never by the queue record a person\'s input gets too', async () => {
    const f = await fixture(); await f.launch();
    updateJob(f.env, 's', prev => prev ? { ...prev, current: { ...prev.current, active: {}, outcome: 'incomplete' } } : null);
    const prompt = '<task-notification>\n<task-id>worker</task-id>\n<tool-use-id>dispatch</tool-use-id>\n<output-file>/tmp/worker.output</output-file>\n<status>killed</status>\n</task-notification>';
    const rows = [
      { type: 'user', sessionId: 's', toolUseResult: { status: 'async_launched', agentId: 'worker', outputFile: '/tmp/worker.output' }, message: { content: [{ type: 'tool_result', tool_use_id: 'dispatch' }] } },
      { type: 'user', sessionId: 's', promptId: 'cancel-turn', promptSource: 'sdk', turnOrigin: 'sdk', message: { content: 'Cancel the original worker now.' }, timestamp: '2026-10-08T09:27:47.477Z' },
      { type: 'queue-operation', operation: 'enqueue', sessionId: 's', content: prompt, timestamp: '2026-10-08T09:27:47.689Z' },
    ];
    const input = { hook_event_name: 'UserPromptSubmit', session_id: 's', transcript_path: f.parent, prompt_id: 'cancel-turn', prompt };
    writeFileSync(f.parent, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    // Before the notice's own row, either author's input has this queue record: mid-turn with the running turn's ID, idle with a fresh one.
    for (const prompt_id of ['cancel-turn', 'idle-turn']) expect(isNativeTaskNotification({ ...input, prompt_id })).toBe(false);
    const notice = { ...input, prompt_id: 'notice-turn' };
    writeFileSync(f.parent, [...rows, { type: 'user', sessionId: 's', promptId: 'notice-turn', promptSource: 'system', turnOrigin: 'task_notification', origin: { kind: 'task-notification', producer: 'session-task' }, message: { content: prompt } }].map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(isNativeTaskNotification(notice)).toBe(true);
    await f.run(notice); expect(f.job().current.prompt_id).toBe('original');
    // User/Sdk provenance, or a copy of the delivered notice under another prompt, cannot authenticate XML.
    for (const source of ['user', 'sdk'] as const) expect(isNativeTaskNotification({ ...notice, source })).toBe(false);
    expect(isNativeTaskNotification({ ...notice, prompt_id: 'new-human' })).toBe(false);
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human-after-cancel', prompt: 'Add a README section.' });
    expect(f.job().current.prompt_id).toBe('human-after-cancel');
  });
  it.each(['completed', 'incomplete'] as const)('admits a human prompt after an older closed generation without a delivery marker (%s)', async outcome => {
    const f = await fixture(); await f.launch();
    updateJob(f.env, 's', prev => prev ? { ...prev, current: { ...prev.current, active: {}, outcome, background_context: 'Historical policy result.' } } : null);
    const next = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human-after-old-state', prompt: 'Add a new README section.' });
    expect(f.job().current.prompt_id).toBe('human-after-old-state'); expect(next.stdout).not.toContain('background completion notice');
  });
  it.each([true, false])('records idle policy delivery without a false admission block and reports closure (accepted=%s)', async accepted => {
    const f = await fixture(); const trace = join(f.root, 'trace'); Object.assign(f.env, { JEV_GATE_TRACE_DIR: trace });
    await f.launch(); f.transcript(!accepted); await f.terminal();
    const idleSince = f.job().current.background_idle_since;
    expect(idleSince).toMatch(/^\d{4}-/);
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'delivery', prompt: 'Explain the result.' });
    const delivery = f.job().current.background_delivery;
    expect(delivery?.stalled_since).toBe(idleSince);
    await f.run({ hook_event_name: 'Stop', prompt_id: 'delivery' });
    const records = readdirSync(trace).map(file => JSON.parse(readFileSync(join(trace, file), 'utf8')));
    expect(records.filter(r => r.phase === 'background_stalled')).toHaveLength(0);
    expect(records).toContainEqual(expect.objectContaining({ phase: 'background_policy_delivery', admission_blocked: false, stalled_since: idleSince, stalled_since_basis: 'reservation_release', human_input: { verdict: 'human', basis: 'not_notice' } }));
    expect(records).toContainEqual(expect.objectContaining({ phase: 'background_conversation', prompt_id: 'delivery', human_input: { verdict: 'human', basis: 'not_notice' } }));
    const stopped = records.find(r => r.phase === 'stop' && r.prompt_id === 'delivery');
    expect(stopped?.outcome).toBe(accepted ? 'completed' : 'incomplete');
    if (!accepted) expect(stopped?.closed_reason).toBe('no_active_execution_after_policy_delivery');
  });
  it.each(['system', undefined] as const)('delivers an idle incomplete policy once, closes on Stop, and admits unrelated prompts (source=%s)', async source => {
    const f = await fixture(); const trace = join(f.root, 'trace'); Object.assign(f.env, { JEV_GATE_TRACE_DIR: trace });
    await f.launch(); f.transcript(true); await f.terminal();
    await f.run({ hook_event_name: 'Stop', prompt_id: 'original' });
    expect(f.job().current.outcome).toBeNull(); // Stop before delivery retains the policy.
    const delivered = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'delivery', prompt: 'Explain the result.' });
    expect(delivered.stdout).toContain('policy result');
    const prompt = '<task-notification>completed</task-notification>';
    writeFileSync(f.parent, JSON.stringify({ type: 'user', sessionId: 's', promptId: 'duplicate', origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', turnOrigin: 'task_notification', message: { content: prompt } }) + '\n');
    const notice = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'duplicate', source, prompt });
    expect(notice.stdout).toBeNull();
    expect(readdirSync(trace).map(file => JSON.parse(readFileSync(join(trace, file), 'utf8'))).filter(r => r.phase === 'admission_result' && r.prompt_id === 'duplicate')).toEqual([
      expect.objectContaining({ human_input: { verdict: 'task_notification', basis: source ? 'source' : 'transcript_row' }, decision: expect.objectContaining({ reason: 'task_notification' }) })]);
    await f.run({ hook_event_name: 'Stop', prompt_id: 'delivery' });
    expect(f.job().current.outcome).toBe('incomplete');
    for (let i = 0; i < 3; i++) {
      await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: `new-${i}`, prompt: 'An unrelated request.' });
      expect(f.job().current.prompt_id).toBe(`new-${i}`);
    }
    expect(f.job().history.find(g => g.prompt_id === 'original')?.outcome).toBe('incomplete');
  });
  it.each(['user', 'sdk', undefined] as const)('does not suppress copied notification XML from a human source %s', async source => {
    const f = await fixture(); await f.launch(); f.transcript(true); await f.terminal();
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'delivery', prompt: 'Explain the result.' });
    await f.run({ hook_event_name: 'Stop', prompt_id: 'delivery' });
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human-next', source, prompt: '<task-notification>Example</task-notification>\nFix this parser.' });
    expect(f.job().current.prompt_id).toBe('human-next');
    expect(f.job().history.find(g => g.prompt_id === 'original')?.outcome).toBe('incomplete');
  });
  it('preserves a genuine machine notification delivered before its transcript flush', async () => {
    const f = await fixture(); await f.launch(); f.transcript(true); await f.terminal();
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'delivery', prompt: 'Explain the result.' });
    await f.run({ hook_event_name: 'Stop', prompt_id: 'delivery' });
    const result = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'native-notice', source: 'system', prompt: '<task-notification>completed</task-notification>' });
    expect(result.stdout).toBeNull(); expect(f.job().current.prompt_id).toBe('original');
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'new-human', source: 'user', prompt: 'Continue with new work.' });
    expect(f.job().current.prompt_id).toBe('new-human');
  });
  it('returns three unrelated human prompts to fresh Gate A after one idle policy delivery', async () => {
    const f = await fixture(); await f.launch(); f.transcript(true); await f.terminal();
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', prompt: '<task-notification>completed</task-notification>' });
    const trace = join(f.root, 'trace'); Object.assign(f.env, { TYPESAFE_API_KEY: 'fixture-key', JEV_GATE_TRACE_DIR: trace });
    delete (f.env as Record<string, string>)['JEV_GATE_EXPERIMENT_ADMISSION'];
    writeFileSync(f.cfg, JSON.stringify({ version: 5, mode: 'auto', delegationDepthFloor: 0 }));
    writeFileSync(f.parent, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n');
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++; const request = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.entries(request.questions as Record<string, any>).map(([name, q]) => [name,
        q.type === 'noul' ? { type: 'noul', noul: 0 } : q.type === 'choice' ? { type: 'choice', choice: name === 'task_context' ? 'self_contained' : 'other', confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === (name === 'task_context' ? 'self_contained' : 'other') ? 1 : 0])) } : { type: 'score', score: 0, confidence: 1, probabilities: { 0: 1 } }]));
      return new Response(JSON.stringify({ model: request.model, answers }), { headers: { 'content-type': 'application/json' } });
    };
    for (let i = 0; i < 3; i++) {
      const result = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: `fresh-${i}`, prompt: 'Explain a separate bounded question.' }, fetchImpl);
      expect(result.stdout ?? '').not.toContain('policy result'); expect(f.job().current.prompt_id).toBe(`fresh-${i}`);
    }
    expect(calls).toBe(3);
    const intents = readdirSync(trace).map(file => JSON.parse(readFileSync(join(trace, file), 'utf8'))).filter(r => r.phase === 'admission_intent');
    expect(intents.map(r => r.prompt_id).sort()).toEqual(['fresh-0', 'fresh-1', 'fresh-2']);
    expect(f.job().history.find(g => g.prompt_id === 'original')?.outcome).toBe('superseded');
  });
  it.each(['UserPromptSubmit', 'PreToolUse'])('recovers a completed worker with no stop_reason from a native notification before %s', async event => {
    const f = await fixture(); await f.launch(); f.transcript();
    const rows = readFileSync(f.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    rows.at(-1).message.stop_reason = null; rows.at(-1).timestamp = '2026-10-07T05:31:45.968Z';
    writeFileSync(f.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await f.terminal(); expect(f.job().current.active['dispatch']).toBeDefined();
    writeFileSync(join(f.root, 's.jsonl'), JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-10-07T05:31:46.678Z', origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', turnOrigin: 'task_notification', message: { content: '<task-notification><task-id>worker</task-id><status>completed</status></task-notification>' } }) + '\n');
    await f.run({ hook_event_name: event, prompt_id: 'question', prompt: 'Continue', tool_name: 'Read', tool_use_id: 'read', tool_input: { file_path: 'x' } });
    expect(f.job().current.active).toEqual({});
    expect(f.job().current.receipts).toEqual([expect.objectContaining({ verdict: 'accept' })]);
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'again', prompt: 'Continue' });
    expect([f.job().current, ...f.job().history].find(g => g.prompt_id === 'original')?.receipts).toHaveLength(1);
  });
  it.each(['human', 'wrong_agent', 'older', 'tool_use', 'invalid_child_time'])('does not settle missing stop_reason from an invalid notification (%s)', async kind => {
    const f = await fixture(); await f.launch(); f.transcript();
    const rows = readFileSync(f.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    rows.at(-1).message.stop_reason = null; rows.at(-1).timestamp = '2026-10-07T05:31:45.968Z';
    if (kind === 'invalid_child_time') rows.at(-1).timestamp = 'not-a-time';
    if (kind === 'tool_use') rows.at(-1).message.content.push({ type: 'tool_use', name: 'Bash', id: 'tool' });
    writeFileSync(f.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(join(f.root, 's.jsonl'), JSON.stringify({ type: 'user', sessionId: 's', timestamp: kind === 'older' ? '2026-10-07T05:30:00.000Z' : '2026-10-07T05:31:46.678Z', ...(kind === 'human' ? {} : { origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', turnOrigin: 'task_notification' }), message: { content: `<task-notification><task-id>${kind === 'wrong_agent' ? 'another' : 'worker'}</task-id><status>completed</status></task-notification>` } }) + '\n');
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'question', prompt: 'Continue' });
    expect(f.job().current.active['dispatch']).toBeDefined(); expect(f.job().current.receipts).toHaveLength(0);
  });
  it.each(['tool_use', null])('settles a native stop whose final transcript row is flushed after the hook starts (%s)', async stopReason => {
    const f = await fixture(); await f.launch();
    writeFileSync(f.path, JSON.stringify({ type: 'assistant', agentId: 'worker', sessionId: 's', message: { stop_reason: stopReason, content: [{ type: 'text', text: stopReason === null ? f.report : '' }] } }) + '\n');
    const flush = setTimeout(() => f.transcript(), 80);
    try { await f.terminal(); } finally { clearTimeout(flush); }
    expect(f.job().current.active).toEqual({});
    expect(f.job().current.receipts).toEqual([expect.objectContaining({ verdict: 'accept' })]);
  });
  it('tracks a bounded direct worker without orchestrating or completing the overall request', async () => {
    const f = await fixture(true);
    expect(f.job().current.shape).toBe('direct'); expect(f.job().current.execution).toBeUndefined();
    await f.launch(); await f.run({ hook_event_name: 'Stop', prompt_id: 'original' });
    expect(f.job().current.outcome).toBeNull();
    const question = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'question', prompt: 'Explain while the subtask runs.' });
    expect(question.stdout).toContain('answer the user'); expect(f.job().current.prompt_id).toBe('original');
    const duplicate = await f.run({ hook_event_name: 'PreToolUse', prompt_id: 'original', tool_name: 'Agent', tool_use_id: 'duplicate', tool_input: { subagent_type: 'jev-gate:worker', prompt: 'Do not duplicate.', description: 'duplicate' } });
    expect(duplicate.kind).toBe('deny'); expect(Object.keys(f.job().current.active)).toEqual(['dispatch']);
    f.transcript(); await f.terminal(); await f.terminal();
    expect(f.job().current.receipts).toHaveLength(1); expect(f.job().current.receipts[0]?.verdict).toBe('accept');
    expect(f.job().current.active).toEqual({}); expect(f.job().current.root_fallback).not.toBe(true);
    expect(f.job().current.background_context).toContain('overall user request remains yours');
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', prompt: '<task-notification>completed</task-notification>' });
    await f.run({ hook_event_name: 'Stop', prompt_id: 'question' }); expect(f.job().current.outcome).toBe('completed');
  });
  it('answers new questions without superseding the worker and accepts its genuine result exactly once', async () => {
    const f = await fixture(); expect(f.input).toMatchObject({ run_in_background: true, model: 'sonnet' });
    await f.launch(); expect(f.job().current.receipts).toHaveLength(0);
    await f.run({ hook_event_name: 'Stop', prompt_id: 'original' }); expect(f.job().current.outcome).toBeNull();
    const response = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'question', prompt: 'What does that feature do?' });
    expect(response.stdout).toContain('answer the user');
    expect(f.job().current.prompt_id).toBe('original'); expect(f.job().history).toHaveLength(0);
    await f.run({ hook_event_name: 'Stop', prompt_id: 'question' }); expect(f.job().current.outcome).toBeNull();
    f.transcript(); await f.terminal(); await f.terminal();
    expect(f.job().current.active).toEqual({}); expect(f.job().current.receipts).toHaveLength(1);
    expect(f.job().current.receipts[0]).toMatchObject({ verdict: 'accept', tool_use_id: 'dispatch' });
    expect(f.job().current.background_context).toContain('worker actually ended');
  });
  it('settles a terminal before the async launch hook using the private dispatch token', async () => {
    const f = await fixture(); f.transcript(); await f.terminal(); await f.launch();
    expect(f.job().current.receipts).toHaveLength(1); expect(f.job().current.active).toEqual({});
  });
  it('does not release a live worker when a main-session tool wait is interrupted', async () => {
    const f = await fixture(); await f.launch();
    await f.run({ hook_event_name: 'PostToolUseFailure', prompt_id: 'original', tool_name: 'Agent', tool_use_id: 'dispatch', is_interrupt: true, error: 'main wait interrupted' });
    expect(f.job().current.active['dispatch']).toBeDefined(); expect(f.job().current.receipts).toHaveLength(0);
    f.transcript(); await f.terminal(); expect(f.job().current.receipts[0]?.verdict).toBe('accept');
  });
  it.each(['identity', 'profile', 'path', 'report', 'symlink'])('retains ownership when terminal evidence has the wrong %s', async kind => {
    const f = await fixture(); await f.launch(); f.transcript();
    if (kind === 'symlink') { const saved = join(f.root, 'outside.jsonl'); writeFileSync(saved, ''); rmSync(f.path); symlinkSync(saved, f.path); }
    await f.terminal(kind === 'identity' ? { agent_id: 'another' } : kind === 'profile' ? { agent_type: 'Explore' } : kind === 'path' ? { agent_transcript_path: join(f.root, 'outside') } : kind === 'report' ? { last_assistant_message: 'forged report' } : {});
    expect(f.job().current.active['dispatch']).toBeDefined(); expect(f.job().current.receipts).toHaveLength(0);
  });
  it('does not accept a structured pass from an API error terminal', async () => {
    const f = await fixture(); await f.launch(); f.transcript(true); await f.terminal();
    expect(f.job().current.receipts[0]?.verdict).not.toBe('accept'); expect(f.job().current.active).toEqual({});
  });
  // #284: the same prompt ID registered again is a new job too; only its generation tells them apart.
  it.each(['replacement', 'original'])('never applies a retired result to the new job (new prompt ID %s)', async promptId => {
    const f = await fixture(); await f.launch(); f.transcript();
    updateJob(f.env, 's', prev => newGeneration(prev, 's', promptId, 'direct').state);
    await f.terminal(); expect(f.job().current.prompt_id).toBe(promptId); expect(f.job().current.receipts).toHaveLength(0);
    expect(f.job().history[0]?.active).toEqual({});
    expect(f.job().history[0]?.receipts[0]).toMatchObject({ verdict: 'unknown', verdict_reason: 'generation_changed' });
  });
  it('settles a native TaskStop into the retired generation, never the new one with the same prompt ID (#284)', async () => {
    const f = await fixture(); await f.launch();
    updateJob(f.env, 's', prev => newGeneration(prev, 's', 'original', 'direct').state);
    await f.run({ hook_event_name: 'PostToolUse', prompt_id: 'original', tool_name: 'TaskStop', tool_input: { task_id: 'worker' }, tool_response: { message: 'Successfully stopped task: worker (work)', task_id: 'worker', task_type: 'local_agent' } });
    expect(f.job().current).toMatchObject({ prompt_id: 'original', outcome: null, receipts: [] });
    expect(f.job().history[0]?.active).toEqual({});
    expect(f.job().history[0]?.receipts[0]).toMatchObject({ verdict: 'unknown', verdict_reason: 'generation_changed' });
  });
  it.each(['success', 'failed', 'mismatched', 'duplicate'])('settles only a genuine native TaskStop terminal (%s)', async kind => {
    const f = await fixture(); await f.launch();
    const event = { hook_event_name: 'PostToolUse', prompt_id: 'question', tool_name: 'TaskStop', tool_input: { task_id: kind === 'mismatched' ? 'another' : 'worker' }, tool_response: { message: kind === 'failed' ? 'Task could not be stopped' : 'Successfully stopped task: worker (work)', task_id: 'worker', task_type: 'local_agent' } };
    await f.run(event); if (kind === 'duplicate') await f.run(event);
    const settled = kind === 'success' || kind === 'duplicate';
    expect(Object.keys(f.job().current.active)).toHaveLength(settled ? 0 : 1);
    expect(f.job().current.receipts).toHaveLength(settled ? 1 : 0);
    expect(f.job().current.receipts.some(r => r.verdict === 'accept')).toBe(false);
    if (settled) {
      expect(f.job().current.receipts[0]).toMatchObject({ verdict: 'unknown', verdict_reason: 'worker_cancelled' });
      const rows = readdirSync(join(f.root, 'trace')).filter(f => f.endsWith('.json')).map(file => JSON.parse(readFileSync(join(f.root, 'trace', file), 'utf8')));
      expect(rows.filter(r => r.phase === 'background_terminal')).toMatchObject([{ status: 'cancelled', verdict_reason: 'worker_cancelled' }]);
      expect(rows.some(r => r.phase === 'background_terminal' && r.status === 'failed')).toBe(false);
      await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', source: 'system', prompt: '<task-notification>native cancellation notice</task-notification>' });
      expect(f.job().current.prompt_id).toBe('original'); expect(f.job().current.outcome).toBe('incomplete');
    }
  });
  it('admits the first ordinary prompt immediately after native TaskStop, before any notification delivery', async () => {
    const f = await fixture(); await f.launch();
    await f.run({ hook_event_name: 'PostToolUse', prompt_id: 'original', tool_name: 'TaskStop', tool_input: { task_id: 'worker' }, tool_response: { message: 'Successfully stopped task: worker (work)', task_id: 'worker', task_type: 'local_agent' } });
    expect(f.job().current.outcome).toBe('incomplete'); expect(f.job().current.background_delivery).toBeUndefined();
    const next = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'next-human', prompt: 'Implement a different request.' });
    expect(f.job().current.prompt_id).toBe('next-human'); expect(next.stdout).not.toContain('background completion notice');
  });
  // #281: on 2.1.304 the killed notice carries no source and its hook runs before its row. The TaskStop on record proves it, once.
  const killed = '<task-notification>\n<task-id>worker</task-id>\n<tool-use-id>dispatch</tool-use-id>\n<output-file>/tmp/worker.output</output-file>\n<status>killed</status>\n<summary>Agent "work" was stopped</summary>\n</task-notification>';
  it.each([['current', 'original'], ['current', 'notice-turn'], ['retired', 'notice-turn']] as const)('settles the killed notice of a native TaskStop into the stopped job before its row is written (%s job, prompt ID %s)', async (job, promptId) => {
    const f = await fixture(); const trace = join(f.root, 'trace'); Object.assign(f.env, { JEV_GATE_TRACE_DIR: trace });
    await f.launch();
    if (job === 'retired') updateJob(f.env, 's', prev => newGeneration(prev, 's', 'human-after', 'direct').state);
    const before = f.job().current;
    await f.run({ hook_event_name: 'PostToolUse', prompt_id: 'original', tool_name: 'TaskStop', tool_input: { task_id: 'worker' }, tool_response: { message: 'Successfully stopped task: worker (work)', task_id: 'worker', task_type: 'local_agent' } });
    expect(isNativeTaskNotification({ hook_event_name: 'UserPromptSubmit', session_id: 's', transcript_path: f.parent, prompt_id: promptId, prompt: killed })).toBe(false);
    const notice = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: promptId, prompt: killed });
    expect(f.job().current).toMatchObject({ prompt_id: before.prompt_id, generation_id: before.generation_id });
    if (job === 'current') { expect(f.job().current.outcome).toBe('incomplete'); expect(notice.stdout).toContain('background completion notice'); }
    const records = readdirSync(trace).map(file => JSON.parse(readFileSync(join(trace, file), 'utf8')));
    expect(records.filter(r => r.prompt_id === promptId && r.human_input).map(r => r.human_input)).toContainEqual({ verdict: 'task_notification', basis: 'task_stop' });
    // The record is taken: the same XML again is a person's and opens its own job.
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'pasted', prompt: killed });
    expect(f.job().current.prompt_id).toBe('pasted');
  });
  // JG-281-01: before any row nothing tells a person's exact copy from the host's notice, so the first arrival takes the
  // stop and the host's notice after it is a person's. It never displaces a job still running; a settled one retires intact.
  it.each(['settled', 'running'] as const)('takes a person\'s copy that arrives first as the stop\'s notice and the host\'s after it as a person\'s (%s job)', async job => {
    const f = await fixture(); const trace = join(f.root, 'trace'); Object.assign(f.env, { JEV_GATE_TRACE_DIR: trace });
    await f.launch();
    if (job === 'running') updateJob(f.env, 's', prev => prev ? { ...prev, current: { ...prev.current, active: { ...prev.current.active, other: { ...prev.current.active['dispatch']!, background_execution: { ...prev.current.active['dispatch']!.background_execution!, agent_id: 'other' } } } } } : null);
    const before = f.job().current;
    await f.run({ hook_event_name: 'PostToolUse', prompt_id: 'original', tool_name: 'TaskStop', tool_input: { task_id: 'worker' }, tool_response: { message: 'Successfully stopped task: worker (work)', task_id: 'worker', task_type: 'local_agent' } });
    await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'pasted', prompt: killed });
    expect(f.job().current).toMatchObject({ prompt_id: before.prompt_id, generation_id: before.generation_id });
    const host = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'host-notice', prompt: killed });
    const records = readdirSync(trace).map(file => JSON.parse(readFileSync(join(trace, file), 'utf8')));
    expect(records.filter(r => r.prompt_id === 'pasted' && r.human_input).map(r => r.human_input)).toContainEqual({ verdict: 'task_notification', basis: 'task_stop' });
    expect(records.filter(r => r.prompt_id === 'host-notice' && r.human_input).map(r => r.human_input)).toContainEqual({ verdict: 'human', basis: 'unproven' });
    if (job === 'running') {
      expect(f.job().current).toMatchObject({ prompt_id: before.prompt_id, generation_id: before.generation_id, outcome: null });
      expect(host.stdout).toContain('does not cancel or replace them');
    } else {
      expect(f.job().current.prompt_id).toBe('host-notice');
      expect(f.job().history[0]).toMatchObject({ prompt_id: before.prompt_id, generation_id: before.generation_id, outcome: 'incomplete' });
    }
  });
  it('takes no other execution\'s notice, status or envelope as a stop\'s notice', () => {
    const stop = { agent_id: 'worker', tool_use_id: 'dispatch' };
    expect(isStopNotice(killed, stop)).toBe(true);
    for (const prompt of [killed.replace('<tool-use-id>dispatch', '<tool-use-id>other'), killed.replace('<task-id>worker', '<task-id>other'), killed.replace('killed', 'completed'),
      killed.replace('<task-id>worker</task-id>', '<task-id>worker</task-id><task-id>worker</task-id>'), killed.replace('<tool-use-id>dispatch</tool-use-id>\n', ''), `${killed}\nAlso fix the parser.`])
      expect(isStopNotice(prompt, stop)).toBe(false);
  });
  it('upgrades only the complete old Jev launch profile without changing host permissions', () => {
    const root = mkdtempSync('/tmp/jev-bg-setup-'); roots.push(root); mkdirSync(join(root, '.claude'));
    const env = { HOME: root }; const permissions = { deny: ['Read(.env)'] };
    const path = join(root, '.claude/settings.json');
    writeFileSync(path, JSON.stringify({ permissions, env: { ...claudeDefaults(env), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } }));
    expect(prepareClaude(env)).toMatchObject({ changed: true, conflicts: [] });
    const config = JSON.parse(readFileSync(path, 'utf8')); expect(config).toMatchObject({ permissions, env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' } });
    writeFileSync(path, JSON.stringify({ permissions, env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } }));
    expect(prepareClaude(env).conflicts).toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS');
    expect(JSON.parse(readFileSync(path, 'utf8')).env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
  });
});

describe('Gate A and host task notifications', () => {
  /** An auto-mode session whose fake Jev counts its calls; `admissions` reads the Gate A records of one prompt. */
  const gateSession = () => {
    const root = mkdtempSync('/tmp/jev-bg-notice-'); roots.push(root);
    const cfg = join(root, 'config.json'); const trace = join(root, 'trace'); const parent = join(root, 's.jsonl');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', delegationDepthFloor: 0 }));
    const depth = { type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    const transcript = (rows: unknown[]) => writeFileSync(parent, [depth, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
    transcript([]);
    const env = { HOME: root, JEV_GATE_CONFIG: cfg, JEV_GATE_STATE_DIR: join(root, 'state'), JEV_GATE_TRACE_DIR: trace, TYPESAFE_API_KEY: 'fixture-key', CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' };
    const session = { env, parent, transcript, calls: 0, run: (event: Record<string, unknown>) => runHook({ env, fetchImpl, stdin: (async function* () { yield JSON.stringify({ session_id: 's', transcript_path: parent, ...event }); })() }),
      admissions: (promptId: string | null) => readdirSync(trace).map(file => JSON.parse(readFileSync(join(trace, file), 'utf8'))).filter(r => r.phase === 'admission_result' && r.prompt_id === promptId) };
    const fetchImpl: typeof fetch = async (_url, init) => {
      session.calls++; const request = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.entries(request.questions as Record<string, any>).map(([name, q]) => [name,
        q.type === 'noul' ? { type: 'noul', noul: 0 } : q.type === 'choice' ? { type: 'choice', choice: name === 'task_context' ? 'self_contained' : 'other', confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === (name === 'task_context' ? 'self_contained' : 'other') ? 1 : 0])) } : { type: 'score', score: 0, confidence: 1, probabilities: { 0: 1 } }]));
      return new Response(JSON.stringify({ model: request.model, answers }), { headers: { 'content-type': 'application/json' } });
    };
    return session;
  };
  it('never asks Gate A about a native notice and leaves the current generation in force', async () => {
    const g = gateSession(); const { env, run } = g;
    await run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', source: 'user', prompt: 'Explain a separate bounded question.' });
    const asked = g.calls; expect(asked).toBeGreaterThan(0);
    const notice = await run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', source: 'system', prompt: '<task-notification>\n<task-id>bash-1</task-id>\n<status>completed</status>\n</task-notification>' });
    expect(notice.stdout).toBeNull();
    expect(g.calls).toBe(asked);
    const job = readJob(env, 's'); expect(job.ok && job.value?.current.prompt_id).toBe('human');
    expect(g.admissions('notice')).toEqual([expect.objectContaining({ attempted: false, known_not_sent: true, human_input: { verdict: 'task_notification', basis: 'source' }, decision: expect.objectContaining({ reason: 'task_notification' }) })]);
  });
  /**
   * #281: shapes from real 2.1.30x sessions, contents replaced. The payload carries no `source`, and the notice's own
   * row is flushed only after the hook. Until then a person's queued input looks the same: the same enqueue record and
   * the same prompt ID, the running turn's mid-turn and a fresh one when idle (2.1.304, fake-API probe, all three shapes).
   */
  const human = { type: 'user', sessionId: 's', promptId: 'human', promptSource: 'typed', turnOrigin: 'human', origin: { kind: 'human' }, timestamp: '2026-10-19T03:00:00.000Z', message: { content: 'Watch the build and fix what breaks.' } };
  const receipt = (tool: string, toolUseResult: Record<string, unknown>) => ({ type: 'user', sessionId: 's', timestamp: '2026-10-19T03:00:05.000Z', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: tool, content: 'launched' }] } });
  const shapes = {
    monitor: { prompt: '<task-notification>\n<task-id>bmon7x2q1</task-id>\n<summary>Monitor event: "build watch"</summary>\n<event>[build] ok</event>\n</task-notification>', launch: receipt('toolu_monitor', { taskId: 'bmon7x2q1', persistent: false, timeoutMs: 300000 }) },
    bash: { prompt: '<task-notification>\n<task-id>b6w41xrqn</task-id>\n<tool-use-id>toolu_bash</tool-use-id>\n<output-file>/tmp/tasks/b6w41xrqn.output</output-file>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>', launch: receipt('toolu_bash', { backgroundTaskId: 'b6w41xrqn', stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }) },
    agent: { prompt: '<task-notification>\n<task-id>a1b2c3d4e5f6</task-id>\n<tool-use-id>toolu_agent</tool-use-id>\n<output-file>/tmp/tasks/a1b2c3d4e5f6.output</output-file>\n<status>completed</status>\n<summary>Agent "Review" completed</summary>\n<note>Read the output file.</note>\n<result>\nreviewed\n</result>\n<usage><subagent_tokens>10</subagent_tokens><tool_uses>1</tool_uses><duration_ms>5</duration_ms></usage>\n</task-notification>', launch: receipt('toolu_agent', { status: 'async_launched', agentId: 'a1b2c3d4e5f6', outputFile: '/tmp/tasks/a1b2c3d4e5f6.output', isAsync: true }) },
  };
  const enqueue = (prompt: string) => ({ type: 'queue-operation', operation: 'enqueue', sessionId: 's', timestamp: '2026-10-19T03:01:00.000Z', content: prompt });
  it.each(Object.keys(shapes).flatMap(shape => ['human', 'fresh'].map(promptId => [shape, promptId] as const)))('never asks Gate A about a real %s notice before or after its row is written (prompt ID %s)', async (shape, promptId) => {
    const g = gateSession(); const { prompt, launch } = shapes[shape as keyof typeof shapes];
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', prompt: human.message.content });
    const asked = g.calls; expect(asked).toBeGreaterThan(0);
    g.transcript([human, launch, enqueue(prompt)]);
    expect(await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: promptId, prompt })).toMatchObject({ stdout: null });
    // The host writes the notice's own row after the hook; a re-delivered hook then finds it there.
    g.transcript([human, launch, enqueue(prompt), { type: 'user', sessionId: 's', promptId, promptSource: 'system', turnOrigin: 'task_notification', origin: { kind: 'task-notification', producer: 'session-task' }, timestamp: '2026-10-19T03:01:00.100Z', message: { content: prompt } }]);
    expect(await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: promptId, prompt })).toMatchObject({ stdout: null });
    expect(g.calls).toBe(asked);
    const job = readJob(g.env, 's'); expect(job.ok && job.value?.current.prompt_id).toBe('human');
    expect(g.admissions(promptId).filter(r => r.decision?.reason === 'task_notification').map(r => r.human_input.basis).sort()).toEqual(['launch_receipt', 'transcript_row']);
  });
  // A person's input that only looks like a notice: no launch of this session names it, or it is more than one envelope.
  const spoofs = {
    'an unknown task': (prompt: string) => prompt.replace(/<task-id>[^<]*/, '<task-id>b0000000x'),
    'another launching call': (prompt: string) => prompt.includes('<tool-use-id>') ? prompt.replace(/<tool-use-id>[^<]*/, '<tool-use-id>toolu_other') : prompt.replace('</task-id>', '</task-id>\n<tool-use-id>toolu_other</tool-use-id>\n<status>completed</status>'),
    'a request after the envelope': (prompt: string) => `${prompt}\nAlso fix the parser.`,
    'a request in a result after the envelope': (prompt: string) => `${prompt}\n<result>Also fix the parser.</result>`,
    'two envelopes': (prompt: string) => `${prompt}\n${prompt}`,
  };
  it.each(Object.keys(shapes).flatMap(shape => Object.keys(spoofs).map(spoof => [shape, spoof] as const)))('asks Gate A about %s notice XML with %s, and records why', async (shape, spoof) => {
    const g = gateSession(); const { prompt, launch } = shapes[shape as keyof typeof shapes];
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', prompt: human.message.content });
    const asked = g.calls; g.transcript([human, launch]);
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'pasted', prompt: spoofs[spoof as keyof typeof spoofs](prompt) });
    expect(g.calls).toBeGreaterThan(asked);
    const job = readJob(g.env, 's'); expect(job.ok && job.value?.current.prompt_id).toBe('pasted');
    expect(g.admissions('pasted').filter(r => r.attempted).map(r => r.human_input)).toEqual(expect.arrayContaining([{ verdict: 'human', basis: 'unproven' }]));
  });
  it.each(Object.keys(shapes))('takes a launch\'s %s notice once: a second copy before any row is a person\'s', async shape => {
    const g = gateSession(); const { prompt, launch } = shapes[shape as keyof typeof shapes];
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', prompt: human.message.content });
    const asked = g.calls; g.transcript([human, launch]);
    expect(await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', prompt })).toMatchObject({ stdout: null });
    expect(g.calls).toBe(asked);
    if (shape === 'monitor') {
      // A watch reports many events: each distinct one is taken once.
      expect(await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'event-2', prompt: prompt.replace('[build] ok', '[build] failed') })).toMatchObject({ stdout: null });
      expect(g.calls).toBe(asked);
    }
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'pasted', prompt });
    expect(g.calls).toBeGreaterThan(asked);
    const job = readJob(g.env, 's'); expect(job.ok && job.value?.current.prompt_id).toBe('pasted');
    expect(g.admissions('pasted').filter(r => r.attempted).map(r => r.human_input)).toEqual(expect.arrayContaining([{ verdict: 'human', basis: 'unproven' }]));
  });
  it('JG-281-02: takes an Agent notice whose result quotes envelope tags before its row', async () => {
    const g = gateSession(); const { prompt, launch } = shapes.agent;
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', prompt: human.message.content });
    const asked = g.calls; g.transcript([human, launch]);
    const quoting = prompt.replace('reviewed', 'The probe printed <status>ready</status>, <task-id>x</task-id>, <tool-use-id>quoted</tool-use-id> and <task-notification><task-id>nested</task-id></task-notification>.');
    expect(await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', prompt: quoting })).toMatchObject({ stdout: null });
    expect(g.calls).toBe(asked);
    expect(g.admissions('notice').map(r => r.human_input)).toEqual([{ verdict: 'task_notification', basis: 'launch_receipt' }]);
    const job = readJob(g.env, 's');
    expect(job.ok && job.value?.current).toMatchObject({ prompt_id: 'human', notices_taken: [noticeClaim(prompt)] });
  });
  it.each(['receipt', 'TaskStop'])('JG-281-01: a failed claim rename sends consecutive identical inputs to Gate A (%s)', async kind => {
    const g = gateSession(); const { prompt, launch } = shapes.bash;
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', prompt: human.message.content });
    const text = kind === 'TaskStop' ? prompt.replace('completed', 'killed') : prompt;
    if (kind === 'TaskStop') expect(updateJob(g.env, 's', prev => prev && { ...prev, current: { ...prev.current, background_stopped: [{ agent_id: 'b6w41xrqn', tool_use_id: 'toolu_bash' }] } }).ok).toBe(true);
    g.transcript([human, ...(kind === 'receipt' ? [launch] : [])]);
    renameFailure.file = jobPath(g.env, 's'); renameFailure.claim = noticeClaim(text)!;
    let asked = g.calls;
    for (const id of ['first', 'second']) {
      await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: id, prompt: text });
      expect(g.calls).toBe(++asked);
      expect(g.admissions(id)).toEqual([expect.objectContaining({ attempted: true, human_input: { verdict: 'human', basis: 'unproven' } })]);
      const saved = readJob(g.env, 's');
      expect(saved.ok && saved.value?.current.prompt_id).toBe(id);
      expect(saved.ok && saved.value && [saved.value.current, ...saved.value.history].flatMap(gen => gen.notices_taken ?? [])).toEqual([]);
    }
    expect(renameFailure.calls).toBe(2); renameFailure.file = '';
    expect(await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'third', prompt: text })).toMatchObject({ stdout: null });
    expect(g.calls).toBe(asked);
    expect(g.admissions('third').map(r => r.human_input)).toEqual([{ verdict: 'task_notification', basis: kind === 'TaskStop' ? 'task_stop' : 'launch_receipt' }]);
    const saved = readJob(g.env, 's');
    expect(saved.ok && saved.value?.current).toMatchObject({ prompt_id: 'second', notices_taken: [noticeClaim(text)] });
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'fourth', prompt: text });
    expect(g.calls).toBe(asked + 1);
    expect(g.admissions('fourth').map(r => r.human_input)).toEqual([{ verdict: 'human', basis: 'unproven' }]);
  });
  it('asks Gate A about a copy of a launch\'s written notice once the state has forgotten its claim', async () => {
    const g = gateSession(); const { prompt, launch } = shapes.bash;
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', prompt: human.message.content });
    g.transcript([human, launch]);
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', prompt });
    g.transcript([human, launch, { type: 'user', sessionId: 's', promptId: 'notice', promptSource: 'system', turnOrigin: 'task_notification', origin: { kind: 'task-notification', producer: 'session-task' }, timestamp: '2026-10-19T03:01:00.100Z', message: { content: prompt } }]);
    // An older state may already have forgotten this claim; the host row still proves prior delivery.
    updateJob(g.env, 's', prev => prev && { ...prev, current: { ...prev.current, notices_taken: [] } });
    const asked = g.calls;
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'pasted', prompt });
    expect(g.calls).toBeGreaterThan(asked);
    expect(g.admissions('pasted').filter(r => r.attempted).map(r => r.human_input)).toEqual(expect.arrayContaining([{ verdict: 'human', basis: 'unproven' }]));
  });
  it('asks Gate A about a written TaskStop notice even if an older state forgot its claim', async () => {
    const g = gateSession(); const prompt = shapes.bash.prompt.replace('completed', 'killed');
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', prompt: human.message.content });
    expect(updateJob(g.env, 's', prev => prev && { ...prev, current: { ...prev.current, background_stopped: [{ agent_id: 'b6w41xrqn', tool_use_id: 'toolu_bash' }] } }).ok).toBe(true);
    g.transcript([human, { type: 'user', sessionId: 's', promptId: 'delivered', promptSource: 'system', origin: { kind: 'task-notification' }, message: { content: prompt } }]);
    const asked = g.calls;
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'pasted', prompt });
    expect(g.calls).toBe(asked + 1);
    expect(g.admissions('pasted').map(r => r.human_input)).toEqual([{ verdict: 'human', basis: 'unproven' }]);
  });
  it.each(['receipt', 'TaskStop'])('retains a consumed claim after its generation leaves history (%s)', async kind => {
    const g = gateSession(); const { launch } = shapes.bash;
    const prompt = kind === 'TaskStop' ? shapes.bash.prompt.replace('completed', 'killed') : shapes.bash.prompt;
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', prompt: human.message.content });
    if (kind === 'TaskStop') expect(updateJob(g.env, 's', prev => prev && { ...prev, current: { ...prev.current, background_stopped: [{ agent_id: 'b6w41xrqn', tool_use_id: 'toolu_bash' }] } }).ok).toBe(true);
    g.transcript([human, launch]);
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', prompt });
    // No host row was flushed: the receipt remains in the transcript after the original generation is evicted.
    for (let i = 0; i <= MAX_HISTORY; i++) expect(updateJob(g.env, 's', prev => newGeneration(prev, 's', `next-${i}`, 'direct').state).ok).toBe(true);
    const before = readJob(g.env, 's');
    expect(before.ok && before.value?.history.some(gen => gen.prompt_id === 'human')).toBe(false);
    expect(before.ok && before.value?.current.notices_taken).toEqual([noticeClaim(prompt)]);
    const asked = g.calls;
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'pasted', prompt });
    expect(g.calls).toBe(asked + 1);
    expect(g.admissions('pasted').map(r => r.human_input)).toEqual([{ verdict: 'human', basis: 'unproven' }]);
  });
  it.each(['receipt', 'TaskStop'])('never evicts a consumed claim at capacity; new unproven notices take Gate A (%s)', async kind => {
    const g = gateSession(); const { launch } = shapes.bash;
    const prompt = kind === 'TaskStop' ? shapes.bash.prompt.replace('completed', 'killed') : shapes.bash.prompt;
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', prompt: human.message.content });
    if (kind === 'TaskStop') expect(updateJob(g.env, 's', prev => prev && { ...prev, current: { ...prev.current, background_stopped: [{ agent_id: 'b6w41xrqn', tool_use_id: 'toolu_bash' }] } }).ok).toBe(true);
    g.transcript([human, launch, shapes.monitor.launch]);
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', prompt });
    // Reach the boundary without 255 redundant hook invocations. All entries are real distinct Monitor claim shapes.
    const claims = [noticeClaim(prompt)!, ...Array.from({ length: 255 }, (_, i) => noticeClaim(shapes.monitor.prompt.replace('[build] ok', `[build] event ${i}`))!)];
    expect(updateJob(g.env, 's', prev => prev && { ...prev, current: { ...prev.current, notices_taken: claims } }).ok).toBe(true);
    const asked = g.calls;
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'overflow', prompt: shapes.monitor.prompt });
    expect(g.calls).toBe(asked + 1);
    expect(g.admissions('overflow').map(r => r.human_input)).toEqual([{ verdict: 'human', basis: 'unproven' }]);
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'pasted', prompt });
    expect(g.calls).toBe(asked + 2);
    const saved = readJob(g.env, 's'); expect(saved.ok && saved.value?.current.notices_taken).toEqual(claims);
  });
  it.each(Object.keys(shapes))('takes an older %s notice row without turnOrigin or producer in Gate A and the shared human filter', async shape => {
    const g = gateSession(); const { prompt } = shapes[shape as keyof typeof shapes];
    const row = { type: 'user', sessionId: 's', uuid: 'legacy', promptSource: 'system', origin: { kind: 'task-notification' }, timestamp: '2026-10-19T03:01:00.000Z', message: { content: [{ type: 'text', text: prompt }] } };
    g.transcript([human, row]);
    expect(humanInputText(row)).toBeNull();
    expect(await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'legacy', prompt })).toMatchObject({ stdout: null });
    expect(g.calls).toBe(0);
    expect(g.admissions('legacy').map(r => r.human_input)).toEqual([{ verdict: 'task_notification', basis: 'transcript_row' }]);
  });
  it.each([false, true])('preserves the safe path when a receipt is outside the 8 MiB tail (notice row=%s)', async flushed => {
    const g = gateSession(); const { prompt, launch } = shapes.agent;
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', prompt: human.message.content });
    const row = { type: 'user', sessionId: 's', promptId: 'notice', promptSource: 'system', origin: { kind: 'task-notification' }, message: { content: prompt } };
    // The final depth row keeps this a live Gate A test even though both the receipt and the initial depth are out of tail.
    g.transcript([human, launch, { type: 'assistant', message: { content: 'x'.repeat(8 * 1024 * 1024) } }, { type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 100000 } } }, ...(flushed ? [row] : [])]);
    const asked = g.calls;
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', prompt });
    expect(g.calls).toBe(asked + (flushed ? 0 : 1));
    expect(g.admissions('notice').map(r => r.human_input)).toEqual([{ verdict: flushed ? 'task_notification' : 'human', basis: flushed ? 'transcript_row' : 'unproven' }]);
    const saved = readJob(g.env, 's'); expect(saved.ok && saved.value?.current.prompt_id).toBe(flushed ? 'human' : 'notice');
  });
  it.each(Object.keys(shapes).flatMap(shape => [false, true].map(flushed => [shape, flushed] as const)))('preserves the safe path without job state (%s, notice row=%s)', async (shape, flushed) => {
    const g = gateSession(); const { prompt, launch } = shapes[shape as keyof typeof shapes];
    const row = { type: 'user', sessionId: 's', promptId: 'notice', promptSource: 'system', origin: { kind: 'task-notification' }, message: { content: prompt } };
    g.transcript([human, launch, ...(flushed ? [row] : [])]);
    expect(readJob(g.env, 's')).toEqual({ ok: true, value: null });
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', prompt });
    expect(g.calls).toBe(flushed ? 0 : 1);
    expect(g.admissions('notice').map(r => r.human_input)).toEqual([{ verdict: flushed ? 'task_notification' : 'human', basis: flushed ? 'transcript_row' : 'unproven' }]);
    const saved = readJob(g.env, 's'); expect(saved.ok && saved.value?.current.prompt_id).toBe(flushed ? undefined : 'notice');
  });
  it('records the human verdict on the Gate A records that never ask', async () => {
    const g = gateSession(); const verdict = { verdict: 'human', basis: 'not_notice' };
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt: 'A turn without an identity.' });
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'veto', prompt: 'Fix the parser. Do not delegate or use a subagent.' });
    writeFileSync(g.parent, '');
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'no-depth', prompt: 'Fix the parser.' });
    delete (g.env as Record<string, string>)['TYPESAFE_API_KEY'];
    await g.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'no-key', prompt: 'Fix the parser.' });
    expect(g.calls).toBe(0);
    expect([null, 'veto', 'no-depth', 'no-key'].flatMap(id => g.admissions(id)).map(r => [r.decision.reason, r.human_input])).toEqual(
      ['prompt_id_absent', 'admission_forbids_delegation', 'depth_unknown', 'key_missing'].map(reason => [reason, verdict]));
  });
});
