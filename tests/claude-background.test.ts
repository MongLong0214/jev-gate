import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runHook } from '../src/hook.js';
import { jobPath, newGeneration, readJob, updateJob } from '../src/job.js';
import { claudeDefaults, prepareClaude } from '../src/claude-setup.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const fixture = async (direct = false) => {
  const root = mkdtempSync('/tmp/jev-bg-unit-'); roots.push(root);
  const cfg = join(root, 'config.json');
  writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'native', admittedShape: 'single', workerIsolation: 'none', maxParallelWorkers: 1, guardAllowTools: [] }));
  const env = { HOME: root, JEV_GATE_CONFIG: cfg, JEV_GATE_STATE_DIR: join(root, 'state'), CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0', JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' };
  const parent = join(root, 's.jsonl'); writeFileSync(parent, '');
  const run = (event: Record<string, unknown>) => runHook({ env, stdin: (async function* () { yield JSON.stringify({ session_id: 's', transcript_path: parent, ...event }); })() });
  await run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'original', prompt: 'Implement the original request.' });
  if (direct) updateJob(env, 's', prev => newGeneration(prev, 's', 'original', 'direct').state);
  const pre = await run({ hook_event_name: 'PreToolUse', prompt_id: 'original', tool_name: 'Agent', tool_use_id: 'dispatch', tool_input: { subagent_type: 'jev-gate:worker', prompt: 'Do the original work.', description: 'work', model: 'sonnet', run_in_background: false } });
  expect(pre.kind).toBe('patch');
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
  return { root, env, run, pre, input, path, report, transcript, terminal, launch, job };
};

describe('responsive native background contracts', () => {
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
      await f.run({ hook_event_name: 'UserPromptSubmit', prompt_id: 'notice', prompt: '<task-notification>native cancellation notice</task-notification>' });
      expect(f.job().current.prompt_id).toBe('original'); expect(f.job().current.outcome).toBe('incomplete');
    }
  });
  it.each([true, false])('releases a Lean executor only after a proven terminal (completed=%s)', async completed => {
    const f = await fixture(); await f.launch();
    updateJob(f.env, 's', prev => prev ? { ...prev, current: { ...prev.current, active: { dispatch: { ...prev.current.active['dispatch']!, role: 'executor', background_execution: { ...prev.current.active['dispatch']!.background_execution!, subagent_type: 'jev-gate:executor' } } } } } : null);
    f.transcript(!completed); await f.terminal({ agent_type: 'jev-gate:executor' });
    expect(f.job().current.active).toEqual({}); expect(f.job().current.outcome).toBe(completed ? 'completed' : 'incomplete');
    expect(f.job().current.receipts).toHaveLength(0);
  });
  it.each(['SubagentStop', 'PostToolUse'])('does not report a Lean release when its state write fails (%s)', async hook => {
    const f = await fixture(); await f.launch();
    updateJob(f.env, 's', prev => prev ? { ...prev, current: { ...prev.current, active: { dispatch: { ...prev.current.active['dispatch']!, role: 'executor', background_execution: { ...prev.current.active['dispatch']!.background_execution!, subagent_type: 'jev-gate:executor' } } } } } : null);
    const traceDir = join(f.root, 'trace'); Object.assign(f.env, { JEV_GATE_MODE: 'lean', JEV_GATE_TRACE_DIR: traceDir });
    // A directory at the atomic writer's temporary path fails after the release mutator has run.
    const blocked = `${jobPath(f.env, 's')}.${process.pid}.tmp`; mkdirSync(blocked);
    f.transcript();
    const terminal = () => hook === 'SubagentStop' ? f.terminal({ agent_type: 'jev-gate:executor' }) : f.run({ hook_event_name: 'PostToolUse', prompt_id: 'original', tool_name: 'Agent', tool_use_id: 'dispatch', tool_response: { status: 'completed' } });
    await terminal();
    expect(Object.keys(f.job().current.active)).toEqual(['dispatch']); expect(f.job().current.outcome).toBeNull();
    const post = readdirSync(traceDir).filter(p => p.startsWith('lean_post-')).map(p => JSON.parse(readFileSync(join(traceDir, p), 'utf8')))[0];
    expect(post).toMatchObject({ released: false, release_unconfirmed: true });
    rmSync(blocked, { recursive: true }); await terminal();
    expect(f.job().current.active).toEqual({}); expect(f.job().current.outcome).toBe('completed');
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
