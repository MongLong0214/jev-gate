import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRpc } from '../../src/codex/rpc.js';
import { CodexPolicy } from '../../src/codex/policy.js';
import { readJob, updateJob, newGeneration, cleanupJobs, jobPath } from '../../src/job.js';
import type { Obj } from '../../src/codex/source.js';
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.restoreAllMocks(); });
const setup = async (scenario = 'uncertain', started = true) => {
  const root = mkdtempSync(join(tmpdir(), 'jev-worker-')); const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ gate: { mode: scenario === 'adhoc' ? 'auto' : 'native', admittedShape: scenario === 'planner' ? 'hierarchy' : 'single', maxParallelWorkers: 1, workerIsolation: 'none', guardAllowTools: ['*'], models: { fast: 'gpt-6.1-sol', standard: 'gpt-6.1-sol', deep: 'gpt-6.1-sol', frontier: 'gpt-6.1-sol' } }, router: { enabled: false } }));
  const input = new PassThrough(); const output = new PassThrough();
  const rpc = new CodexRpc(input, output); const sent: Obj[] = [];
  const reply = (id: unknown, result: Obj) => input.write(JSON.stringify({ id, result }) + '\n');
  const notify = (method: string, params: Obj) => input.write(JSON.stringify({ method, params }) + '\n');
  let start: Obj | undefined;
  const env = { HOME: root, JEV_CODEX_CONFIG: config, JEV_CODEX_TRACE_DIR: join(root, 'trace'), JEV_GATE_STATE_DIR: join(root, 'state'), ...(scenario !== 'adhoc' ? { JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' } : {}) };
  const stateEnv = { JEV_GATE_STATE_DIR: join(env.JEV_GATE_STATE_DIR, 'codex') };
  const policy = new CodexPolicy(rpc, env, undefined, { 'jev-gate:worker': 'Return a result', 'jev-gate:planner': 'Return a plan' }, true);
  const nativeRequest = rpc.request.bind(rpc);
  vi.spyOn(rpc, 'request').mockImplementation((m, p, timeout) => nativeRequest(m, p, m === 'turn/start' ? 15 : timeout));
  output.on('data', b => {
    for (const line of String(b).trim().split('\n')) {
      const m = JSON.parse(line) as Obj; sent.push(m);
      if (m['method'] === 'hooks/list') reply(m['id'], { data: [{ hooks: ['sessionStart','userPromptSubmit','preToolUse','postToolUse','preCompact','postCompact','stop'].map(eventName => ({ eventName, key: eventName, source: 'plugin', pluginId: 'jev-gate@fixture', enabled: true })) }] });
      if (m['method'] === 'config/read') reply(m['id'], { config: {} });
      if (m['method'] === 'thread/start') {
        if (scenario === 'pre-failure') input.write(JSON.stringify({ id: m['id'], error: { code: -1 } }) + '\n');
        else reply(m['id'], { model: 'gpt-6.1-sol', cwd: root, sandbox: { type: 'dangerFullAccess' }, thread: { id: 'worker' } });
      }
      if (m['method'] === 'turn/start') { start = m; if (started) notify('turn/started', { threadId: 'worker', turn: { id: 'turn-w' } }); if (['normal', 'planner', 'adhoc'].includes(scenario)) reply(m['id'], { turn: { id: 'turn-w' } }); }
      if (m['method'] === 'thread/read') reply(m['id'], { thread: { id: 'worker', turns: [] } });
      if (m['method'] === 'turn/interrupt' || m['method'] === 'thread/archive') reply(m['id'], {});
    }
  });
  policy.catalog = [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }];
  await rpc.onResponse({ model: 'gpt-6.1-sol', cwd: root, sandbox: { type: 'dangerFullAccess' }, thread: { id: 'parent' } }, 'thread/start', {});
  const parent = policy.sessions.get('parent')!; parent.prompt = 'p'; parent.controller = new AbortController(); parent.tokens = 500000;
  await policy.nativeHook({ hook_event_name: 'UserPromptSubmit', session_id: 'parent', prompt: 'Investigate and return a result' });
  cleanups.push(() => { rpc.close(); input.destroy(); output.destroy(); rmSync(root, { recursive: true, force: true }); });
  const launch = (background = false) => rpc.onRequest({ id: 'call', method: 'item/tool/call', params: { threadId: 'parent', callId: 'dispatch', tool: 'jev_agent', arguments: { run_in_background: background, subagent_type: scenario === 'planner' ? 'jev-gate:planner' : 'jev-gate:worker', prompt: 'Investigate and return a result' } } });
  const terminal = (status = 'completed', text = 'worker observation kept') => {
    notify('item/completed', { threadId: 'worker', item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text } });
    notify('turn/completed', { threadId: 'worker', turn: { id: 'turn-w', status } });
  };
  const job = () => { const r = readJob(stateEnv, 'parent'); if (!r.ok || !r.value) throw new Error('state missing'); return r.value; };
  const returned = () => sent.find(m => m['id'] === 'call') as Obj | undefined;
  return { policy, rpc, parent, sent, launch, terminal, job, stateEnv, root, returned, started: () => start !== undefined, lateResponse: () => { if (start) reply(start['id'], { turn: { id: 'turn-w' } }); } };
};
describe('Codex genuine terminal settlement (#139)', () => {
  it('runs a bounded direct worker and settles its subtask while keeping the main conversation direct', async () => {
    const f = await setup('adhoc'); expect(f.job().current.shape).toBe('direct');
    await f.launch(true); expect(JSON.stringify(f.returned())).toContain('launch receipt');
    expect(f.sent.filter(m => m['method'] === 'turn/start')).toHaveLength(1);
    f.parent.prompt = 'question'; f.parent.controller = new AbortController();
    expect(JSON.stringify(await f.policy.nativeHook({ hook_event_name: 'UserPromptSubmit', session_id: 'parent', prompt: 'Explain while the bounded lookup runs.' }))).toContain('answer the user');
    f.terminal('completed', JSON.stringify({ status: 'done', summary: 'bounded lookup result', changed_files: [], interfaces: [], checks: [], blockers: [] }));
    await vi.waitFor(() => expect(f.job().current.receipts[0]?.verdict).toBe('accept'));
    expect(f.job().current.shape).toBe('direct'); expect(f.job().current.root_fallback).not.toBe(true);
    await f.rpc.onRequest({ id: 'status', method: 'item/tool/call', params: { threadId: 'parent', tool: 'jev_agent', arguments: { action: 'status', agent_id: 'worker' } } });
    expect(JSON.stringify(f.sent.find(m => m['id'] === 'status'))).toContain('bounded lookup result');
  });
  it('returns a background launch immediately, preserves it across a new question and collects its original result', async () => {
    const f = await setup('normal'); await f.launch(true);
    expect(JSON.stringify(f.returned())).toContain('launch receipt'); expect(f.job().current.receipts).toHaveLength(0);
    f.parent.controller!.abort(); f.parent.controller = new AbortController(); f.parent.prompt = 'question';
    const answer = await f.policy.nativeHook({ hook_event_name: 'UserPromptSubmit', session_id: 'parent', prompt: 'Explain this feature while the worker runs.' });
    expect(JSON.stringify(answer)).toContain('answer the user'); expect(f.job().current.prompt_id).toBe('p');
    await f.policy.nativeHook({ hook_event_name: 'Stop', session_id: 'parent' });
    expect(f.job().current.outcome).toBeNull(); expect(f.sent.some(m => m['method'] === 'turn/interrupt')).toBe(false);
    f.terminal('completed', JSON.stringify({ status: 'done', summary: 'original result', changed_files: [], interfaces: [], checks: [], blockers: [] }));
    await vi.waitFor(() => expect(f.job().current.receipts[0]?.verdict).toBe('accept'));
    expect(f.job().current.active).toEqual({}); expect(f.job().current.background_context).toContain('original result');
    await f.rpc.onRequest({ id: 'status', method: 'item/tool/call', params: { threadId: 'parent', tool: 'jev_agent', arguments: { action: 'status', agent_id: 'worker' } } });
    expect(JSON.stringify(f.sent.find(m => m['id'] === 'status'))).toContain('original result');
    f.terminal(); expect(f.job().current.receipts).toHaveLength(1);
  });
  it('collects a committed background planner result without requiring a worker receipt', async () => {
    const f = await setup('planner'); await f.launch(true);
    f.terminal('completed', JSON.stringify({ status: 'ready', goal: 'Original goal', constraints: [], tasks: [{ id: 't1', outcome: 'Implement the goal', depends_on: [], deliverables: ['src/file'], constraints: [], checks: [{ id: 'c1', description: 'Check the outcome', required: true, command: 'vitest run' }] }] }));
    await vi.waitFor(() => expect(f.policy.sessions.has('worker')).toBe(false));
    expect(f.job().current.phase).toBe('planned'); expect(f.job().current.plan?.tasks[0]?.id).toBe('t1'); expect(f.job().current.active).toEqual({});
    expect(f.job().current.background_context).toContain('rev=1');
    await f.rpc.onRequest({ id: 'status', method: 'item/tool/call', params: { threadId: 'parent', tool: 'jev_agent', arguments: { action: 'status', agent_id: 'worker' } } });
    expect(JSON.stringify(f.sent.find(m => m['id'] === 'status'))).toContain('Original goal');
  });
  it('keeps cancellation ACK protected until the owned worker actually ends', async () => {
    const f = await setup('normal'); await f.launch(true);
    await f.rpc.onRequest({ id: 'cancel', method: 'item/tool/call', params: { threadId: 'parent', tool: 'jev_agent', arguments: { action: 'cancel', agent_id: 'worker' } } });
    expect(f.sent.filter(m => m['method'] === 'turn/interrupt')).toHaveLength(1);
    expect(f.job().current.active['dispatch']).toBeDefined(); expect(f.job().current.receipts).toHaveLength(0);
    f.terminal('interrupted'); await vi.waitFor(() => expect(f.job().current.active).toEqual({}));
    expect(f.job().current.receipts[0]?.verdict).not.toBe('accept');
  });
  it('releases a definite failure before user turn/start and allows the next dispatch', async () => {
    const f = await setup('pre-failure'); await f.launch();
    expect(f.sent.some(m => m['method'] === 'turn/start')).toBe(false);
    expect(Object.keys(f.job().current.active)).toHaveLength(0);
    expect(f.job().current.receipts).toHaveLength(1);
  });
  it.each([true, false])('keeps uncertain start and ACK-only termination protected (started=%s)', async started => {
    const f = await setup('uncertain', started); const t = Date.now(); await f.launch();
    expect(Date.now() - t).toBeLessThan(1600);
    expect(JSON.stringify(f.returned())).toContain('termination unconfirmed');
    expect(JSON.stringify(f.returned())).toContain('Internal execution identity: worker');
    expect(f.job().current.active['dispatch']?.codex_execution?.thread_id).toBe('worker');
    expect(f.sent.filter(m => m['method'] === 'turn/start')).toHaveLength(1);
    const write = await f.policy.nativeHook({ hook_event_name: 'PreToolUse', session_id: 'parent', tool_name: 'Write', tool_input: { file_path: join(f.root, 'src/file') } });
    expect(JSON.stringify(write)).toContain('deny');
    expect(await f.policy.nativeHook({ hook_event_name: 'PreToolUse', session_id: 'parent', tool_name: 'Read', tool_input: { file_path: join(f.root, 'src/file') } })).toEqual({});
    expect(f.sent.some(m => m['method'] === 'thread/archive')).toBe(false);
    f.terminal(); await vi.waitFor(() => expect(Object.keys(f.job().current.active)).toHaveLength(0));
    expect(f.job().current.receipts).toHaveLength(1);
    expect(f.job().current.receipts[0]!.verdict).not.toBe('accept');
    f.terminal(); f.lateResponse(); expect(f.job().current.receipts).toHaveLength(1);
    await f.rpc.onRequest({ id: 'recovered', method: 'item/tool/call', params: { threadId: 'parent', tool: 'jev_agent', arguments: { action: 'status', agent_id: 'worker' } } });
    expect(JSON.stringify(f.sent.find(m => m['id'] === 'recovered'))).toContain('worker observation kept');
  });
  it('preserves a terminal arriving before the start response and settles exactly once', async () => {
    const f = await setup(); const run = f.launch(); await vi.waitFor(() => expect(f.started()).toBe(true));
    f.terminal(); f.terminal(); f.lateResponse(); await run;
    expect(Object.keys(f.job().current.active)).toHaveLength(0); expect(f.job().current.receipts).toHaveLength(1);
    expect(f.policy.sessions.has('worker')).toBe(false);
  });
  it('retains old-generation protection through history limits, Stop and cleanup and settles the old dispatch only', async () => {
    const f = await setup(); await f.launch(); const oldSignal = f.parent.controller!.signal;
    f.parent.controller!.abort(); f.parent.controller = new AbortController(); f.parent.prompt = 'new';
    for (let i = 0; i < 12; i++) updateJob(f.stateEnv, 'parent', prev => newGeneration(prev, 'parent', `next-${i}`, 'direct').state);
    expect(oldSignal.aborted).toBe(true);
    expect(f.job().history.find(g => g.prompt_id === 'p')?.active['dispatch']).toBeDefined();
    expect(cleanupJobs(f.stateEnv, Date.now() + 100 * 24 * 3600000)).toBe(0);
    await f.policy.nativeHook({ hook_event_name: 'Stop', session_id: 'parent' });
    const conflict = await f.policy.nativeHook({ hook_event_name: 'PreToolUse', session_id: 'parent', tool_name: 'Edit', tool_input: { file_path: join(f.root, 'src/file') } });
    expect(JSON.stringify(conflict)).toContain('deny');
    f.terminal(); await vi.waitFor(() => expect(f.job().history.find(g => g.prompt_id === 'p')?.receipts).toHaveLength(1));
    expect(f.job().current.receipts).toHaveLength(0);
    expect(f.parent.controller.signal.aborted).toBe(false);
  });
  it('does not release on local RPC close', async () => {
    const f = await setup('normal'); const run = f.launch(); await vi.waitFor(() => expect(f.started()).toBe(true)); f.rpc.close(); await run;
    expect(f.job().current.active['dispatch']).toBeDefined(); expect(f.job().current.receipts).toHaveLength(0);
  });
  it('keeps terminal observations when commit fails and retries settlement without execution', async () => {
    const f = await setup(); await f.launch();
    const path = jobPath(f.stateEnv, 'parent'); mkdirSync(`${path}.lock`); writeFileSync(join(`${path}.lock`, 'owner'), String(process.pid));
    f.terminal(); await new Promise(r => setTimeout(r, 350));
    expect(f.job().current.active['dispatch']).toBeDefined(); expect(f.policy.sessions.has('worker')).toBe(true);
    rmSync(`${path}.lock`, { recursive: true });
    await f.policy.nativeHook({ hook_event_name: 'PreToolUse', session_id: 'parent', tool_name: 'Read', tool_input: { file_path: 'src/file' } });
    expect(f.job().current.receipts).toHaveLength(1); expect(Object.keys(f.job().current.active)).toHaveLength(0);
    expect(f.sent.filter(m => m['method'] === 'turn/start')).toHaveLength(1);
  });
  it('returns a recoverable identity if a foreground terminal cannot be committed, then collects without re-execution', async () => {
    const f = await setup('normal'); const run = f.launch(); await vi.waitFor(() => expect(f.started()).toBe(true));
    const path = jobPath(f.stateEnv, 'parent'); mkdirSync(`${path}.lock`); writeFileSync(join(`${path}.lock`, 'owner'), String(process.pid));
    f.terminal(); await run;
    expect(JSON.stringify(f.returned())).toContain('agent_id=worker'); expect(f.job().current.active['dispatch']).toBeDefined();
    rmSync(`${path}.lock`, { recursive: true });
    await f.rpc.onRequest({ id: 'recover', method: 'item/tool/call', params: { threadId: 'parent', tool: 'jev_agent', arguments: { action: 'status', agent_id: 'worker' } } });
    expect(JSON.stringify(f.sent.find(m => m['id'] === 'recover'))).toContain('worker observation kept');
    expect(f.sent.filter(m => m['method'] === 'turn/start')).toHaveLength(1); expect(f.job().current.receipts).toHaveLength(1);
  });
  it.each(['completed', 'failed', 'interrupted'])('settles normal observed %s without the uncertainty recovery budget', async status => {
    const f = await setup('normal'); const run = f.launch(); await vi.waitFor(() => expect(f.started()).toBe(true)); f.terminal(status); await run;
    expect(f.job().current.receipts).toHaveLength(1); expect(Object.keys(f.job().current.active)).toHaveLength(0);
    expect(f.sent.some(m => m['method'] === 'thread/read')).toBe(false);
  });
  it('protects only the managed write paths while allowing unrelated projects and status', async () => {
    const f = await setup(); await f.launch();
    updateJob(f.stateEnv, 'parent', prev => prev ? { ...prev, current: { ...prev.current, active: { ...prev.current.active, dispatch: { ...prev.current.active['dispatch']!, deliverables: ['src/owned.ts'] } } } } : null);
    for (const [tool, tool_input] of [['Write', { file_path: join(f.root, 'src/unrelated.ts') }], ['Bash', { command: 'git status --short' }]] as const) {
      expect(await f.policy.nativeHook({ hook_event_name: 'PreToolUse', session_id: 'parent', tool_name: tool, tool_input })).toEqual({});
    }
    await f.rpc.onResponse({ model: 'gpt-6.1-sol', cwd: join(f.root, '../different-project'), sandbox: { type: 'dangerFullAccess' }, thread: { id: 'other' } }, 'thread/start', {});
    const other = f.policy.sessions.get('other')!; other.prompt = 'other'; other.controller = new AbortController();
    expect(await f.policy.nativeHook({ hook_event_name: 'PreToolUse', session_id: 'other', tool_name: 'Write', tool_input: { file_path: join(f.root, '../different-project/src/file.ts') } })).toEqual({});
    expect(JSON.stringify(await f.policy.nativeHook({ hook_event_name: 'PreToolUse', session_id: 'parent', tool_name: 'Write', tool_input: { file_path: join(f.root, 'src/owned.ts') } }))).toContain('deny');
    f.terminal();
    await vi.waitFor(() => expect(f.job().current.receipts).toHaveLength(1));
  });

});
