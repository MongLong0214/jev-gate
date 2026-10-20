import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runHook } from '../src/hook.js';
import { newGeneration, readJob, updateJob } from '../src/job.js';
import { claudeDefaults, prepareClaude } from '../src/claude-setup.js';
import { isNativeTaskNotification } from '../src/claude-background.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const fixture = async (direct = false) => {
  const root = mkdtempSync('/tmp/jev-bg-unit-'); roots.push(root);
  const cfg = join(root, 'config.json');
  writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'native' }));
  const env = { HOME: root, JEV_GATE_CONFIG: cfg, JEV_GATE_STATE_DIR: join(root, 'state'), CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0', JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' };
  const parent = join(root, 's.jsonl'); writeFileSync(parent, '');
  const run = (event: Record<string, unknown>, fetchImpl?: typeof fetch) => runHook({ env, ...(fetchImpl ? { fetchImpl } : {}), stdin: (async function* () { yield JSON.stringify({ session_id: 's', transcript_path: parent, ...event }); })() });
  await run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'original', prompt: 'Implement the original request.' });
  if (direct) updateJob(env, 's', prev => newGeneration(prev, 's', 'original', 'direct').state);
  const pre = await run({ hook_event_name: 'PreToolUse', prompt_id: 'original', tool_name: 'Agent', tool_use_id: 'dispatch', tool_input: { subagent_type: 'jev-gate:worker', prompt: 'Do the original work.', description: 'work', model: 'sonnet', run_in_background: false } });
  expect(pre.kind, JSON.stringify(pre)).toBe('patch');
  const input = JSON.parse(pre.stdout!).hookSpecificOutput.updatedInput;
  const path = join(root, 's', 'subagents', 'agent-worker.jsonl'); mkdirSync(join(root, 's', 'subagents'), { recursive: true });
  const report = JSON.stringify({ status: 'done', summary: 'original result', changed_files: [], interfaces: [], checks: [], blockers: [] });
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
  it('absorbs a queued native cancellation before transcript flush with a reused human prompt ID', async () => {
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
    expect(isNativeTaskNotification(input)).toBe(true);
    await f.run(input); expect(f.job().current.prompt_id).toBe('original');
    // User/Sdk provenance, an unrelated ID, a copied user message, or unbound queue data cannot authenticate XML.
    for (const source of ['user', 'sdk'] as const) expect(isNativeTaskNotification({ ...input, source })).toBe(false);
    expect(isNativeTaskNotification({ ...input, prompt_id: 'new-human' })).toBe(false);
    for (const variant of [
      [rows[0], { ...rows[1], message: { content: prompt } }, rows[2]],
      [rows[0], rows[1], { ...rows[2], sessionId: 'other' }],
      [{ ...rows[0], toolUseResult: { status: 'async_launched', agentId: 'another', outputFile: '/tmp/worker.output' } }, rows[1], rows[2]],
      [{ ...rows[0], message: { content: [{ type: 'tool_result', tool_use_id: 'another' }] } }, rows[1], rows[2]],
      [{ ...rows[0], toolUseResult: { status: 'async_launched', agentId: 'worker', outputFile: '/tmp/another.output' } }, rows[1], rows[2]],
      [rows[0], rows[1]],
      [rows[0], rows[2], rows[1]],
    ]) { writeFileSync(f.parent, variant.map(r => JSON.stringify(r)).join('\n') + '\n'); expect(isNativeTaskNotification(input)).toBe(false); }
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
    expect(records).toContainEqual(expect.objectContaining({ phase: 'background_policy_delivery', admission_blocked: false, stalled_since: idleSince, stalled_since_basis: 'reservation_release' }));
    const stopped = records.find(r => r.phase === 'stop' && r.prompt_id === 'delivery');
    expect(stopped?.outcome).toBe(accepted ? 'completed' : 'incomplete');
    if (!accepted) expect(stopped?.closed_reason).toBe('no_active_execution_after_policy_delivery');
  });
  it.each(['system', undefined] as const)('delivers an idle incomplete policy once, closes on Stop, and admits unrelated prompts (source=%s)', async source => {
    const f = await fixture(); await f.launch(); f.transcript(true); await f.terminal();
    await f.run({ hook_event_name: 'Stop', prompt_id: 'original' });
    expect(f.job().current.outcome).toBeNull(); // Stop before delivery retains the policy.
    const delivered = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'delivery', prompt: 'Explain the result.' });
    expect(delivered.stdout).toContain('policy result');
    const prompt = '<task-notification>completed</task-notification>';
    writeFileSync(f.parent, JSON.stringify({ type: 'user', sessionId: 's', promptId: 'duplicate', origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', turnOrigin: 'task_notification', message: { content: prompt } }) + '\n');
    const notice = await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'duplicate', source, prompt });
    expect(notice.stdout).toBeNull();
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
  it('never applies a retired result to the new job', async () => {
    const f = await fixture(); await f.launch(); f.transcript();
    updateJob(f.env, 's', prev => newGeneration(prev, 's', 'replacement', 'direct').state);
    await f.terminal(); expect(f.job().current.prompt_id).toBe('replacement'); expect(f.job().current.receipts).toHaveLength(0);
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
  it('never asks Gate A about a native notice and leaves the current generation in force', async () => {
    const root = mkdtempSync('/tmp/jev-bg-notice-'); roots.push(root);
    const cfg = join(root, 'config.json'); const trace = join(root, 'trace'); const parent = join(root, 's.jsonl');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', delegationDepthFloor: 0 }));
    writeFileSync(parent, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n');
    const env = { HOME: root, JEV_GATE_CONFIG: cfg, JEV_GATE_STATE_DIR: join(root, 'state'), JEV_GATE_TRACE_DIR: trace, TYPESAFE_API_KEY: 'fixture-key', CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' };
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++; const request = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.entries(request.questions as Record<string, any>).map(([name, q]) => [name,
        q.type === 'noul' ? { type: 'noul', noul: 0 } : q.type === 'choice' ? { type: 'choice', choice: name === 'task_context' ? 'self_contained' : 'other', confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === (name === 'task_context' ? 'self_contained' : 'other') ? 1 : 0])) } : { type: 'score', score: 0, confidence: 1, probabilities: { 0: 1 } }]));
      return new Response(JSON.stringify({ model: request.model, answers }), { headers: { 'content-type': 'application/json' } });
    };
    const run = (event: Record<string, unknown>) => runHook({ env, fetchImpl, stdin: (async function* () { yield JSON.stringify({ session_id: 's', transcript_path: parent, ...event }); })() });
    await run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'human', source: 'user', prompt: 'Explain a separate bounded question.' });
    const asked = calls; expect(asked).toBeGreaterThan(0);
    const notice = await run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', source: 'system', prompt: '<task-notification>\n<task-id>bash-1</task-id>\n<status>completed</status>\n</task-notification>' });
    expect(notice.stdout).toBeNull();
    expect(calls).toBe(asked);
    const job = readJob(env, 's'); expect(job.ok && job.value?.current.prompt_id).toBe('human');
    const results = readdirSync(trace).map(file => JSON.parse(readFileSync(join(trace, file), 'utf8'))).filter(r => r.phase === 'admission_result' && r.prompt_id === 'notice');
    expect(results).toEqual([expect.objectContaining({ attempted: false, known_not_sent: true, decision: expect.objectContaining({ reason: 'task_notification' }) })]);
  });
});
