import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRpc, RpcRequestError } from '../../src/codex/rpc.js';
import { CodexPolicy } from '../../src/codex/policy.js';
import { AGENT_TOOL } from '../../src/codex/profiles.js';
import { readJob, updateJob, newGeneration, cleanupJobs, jobPath } from '../../src/job.js';
import { buildOperations } from '../../src/operations.js';
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
  vi.spyOn(rpc, 'request').mockImplementation((m, p, timeout) => scenario === 'turn-unsent' && m === 'turn/start' ? Promise.reject(new RpcRequestError('unavailable', false)) : nativeRequest(m, p, m === 'turn/start' ? 15 : timeout));
  const lock = () => { const path = jobPath(stateEnv, 'parent'); mkdirSync(`${path}.lock`); writeFileSync(join(`${path}.lock`, 'owner'), String(process.pid)); return () => rmSync(`${path}.lock`, { recursive: true }); };
  let unlock: (() => void) | undefined;
  output.on('data', b => {
    for (const line of String(b).trim().split('\n')) {
      const m = JSON.parse(line) as Obj; sent.push(m);
      if (m['method'] === 'hooks/list') reply(m['id'], { data: [{ hooks: ['sessionStart','userPromptSubmit','preToolUse','postToolUse','preCompact','postCompact','stop'].map(eventName => ({ eventName, key: eventName, source: 'plugin', pluginId: 'jev-gate@fixture', enabled: true })) }] });
      if (m['method'] === 'config/read') reply(m['id'], { config: {} });
      if (m['method'] === 'thread/start') {
        if (scenario === 'reservation-lock') unlock = lock();
        if (scenario === 'conflict') {
          // Another session's unsettled execution holds this workspace for every attempt.
          const r = readJob(stateEnv, 'parent'); const state = r.ok ? r.value : null; const held = state ? Object.values(state.current.active)[0] : undefined;
          if (state && held) updateJob(stateEnv, 'holder', () => ({ ...state, session_id: 'holder', history: [], current: { ...state.current, active: { held: { ...held, codex_execution: { thread_id: 'held', turn_id: 'held-turn', cwd: root, root_cwd: root } } } } }));
        }
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
  const traces = (phase: string) => { try { return readdirSync(env.JEV_CODEX_TRACE_DIR).filter(f => f.startsWith(`${phase}-`)).map(f => JSON.parse(readFileSync(join(env.JEV_CODEX_TRACE_DIR, f), 'utf8')) as Obj); } catch { return []; } };
  const status = async (id: string) => { await rpc.onRequest({ id, method: 'item/tool/call', params: { threadId: 'parent', tool: 'jev_agent', arguments: { action: 'status', agent_id: 'worker' } } }); return JSON.stringify(sent.find(m => m['id'] === id)); };
  return { policy, rpc, parent, sent, launch, terminal, job, stateEnv, root, returned, traces, status, unlock: () => unlock?.(), started: () => start !== undefined, lateResponse: () => { if (start) reply(start['id'], { turn: { id: 'turn-w' } }); } };
};
describe('Codex genuine terminal settlement (#139)', () => {
  it('does not start a new owned worker on a catalog-declared previous generation', async () => {
    const f = await setup('normal');
    f.policy.catalog = f.policy.catalog.map(m => ({ ...m, description: 'Previous generation workhorse model.' }));
    await f.launch(true);
    expect(f.sent.some(m => m['method'] === 'thread/start' || m['method'] === 'turn/start')).toBe(false);
    expect(f.job().current.active).toEqual({});
  });
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
describe('Codex dispatch failure reason (#233)', () => {
  const feed = (rows: Obj[]) => buildOperations(rows, [], new Date(), { trace: true }).feed;
  const retry = (f: Awaited<ReturnType<typeof setup>>, id: string) => f.rpc.onRequest({ id, method: 'item/tool/call', params: { threadId: 'parent', callId: `dispatch-${id}`, tool: 'jev_agent', arguments: { run_in_background: false, subagent_type: 'jev-gate:worker', prompt: 'Investigate and return a result' } } });
  it.each([
    ['pre-failure', 'native_start_rejected', 'thread_start', 'Codex 워커 시작 거부'],
    ['turn-unsent', 'native_start_rejected', 'turn_start', 'Codex 워커 시작 거부'],
    ['conflict', 'preflight_conflict', 'reservation', '실행 전 점검 충돌'],
  ])('reports a definite %s startup failure as not started, from trace to tool result to dashboard', async (scenario, category, stage, label) => {
    const f = await setup(scenario); await f.launch();
    const result = JSON.stringify(f.returned());
    expect(result).toContain(`Worker not started: ${category} at ${stage}.`); expect(result).not.toMatch(/interrupted|Codex request|write conflict/);
    expect(f.sent.some(m => m['method'] === 'turn/start')).toBe(false);
    expect(f.job().current.active).toEqual({}); expect(f.job().current.receipts).toHaveLength(1);
    const rows = f.traces('failure'); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ host: 'codex', error_first_line: category, failure_category: category, failure_stage: stage, not_executed: true, is_interrupt: false });
    expect(typeof rows[0]!['duration_ms']).toBe('number');
    expect(JSON.stringify(rows)).not.toMatch(/Investigate and return|Codex request|write conflict/);
    const step = feed(rows).find(s => s.title === '호스트 호출 실패')!;
    expect(step).toMatchObject({ state: 'error', summary: `${label} · jev-gate:worker` }); expect(step.details).toContain('워커 미실행 · 완료 주장 없음');
    // A created worker keeps the same outcome for status; an uncreated one never returned an identity.
    if (scenario !== 'pre-failure') { expect(await f.status('s1')).toContain(`Worker not started: ${category} at ${stage}.`); expect(await f.status('s2')).toContain(`Worker not started: ${category} at ${stage}.`); }
    if (scenario === 'conflict') {
      await retry(f, 'again');
      expect(JSON.stringify(f.sent.find(m => m['id'] === 'again'))).toContain('Worker not started: preflight_conflict at reservation.');
      expect(f.sent.some(m => m['method'] === 'turn/start')).toBe(false); expect(f.job().current.active).toEqual({});
    }
  });
  it('reports a parent permission profile it cannot carry as its own category, not as a write-scope conflict (#287)', async () => {
    const f = await setup('normal'); f.parent.external = true; await f.launch();
    const result = JSON.stringify(f.returned());
    expect(result).toContain('Worker not started: permissions_unavailable at preflight.'); expect(result).not.toMatch(/write scope|preflight_conflict/);
    expect(f.sent.some(m => m['method'] === 'thread/start' || m['method'] === 'turn/start')).toBe(false);
    const rows = f.traces('failure'); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ error_first_line: 'permissions_unavailable', failure_category: 'permissions_unavailable', failure_stage: 'preflight', not_executed: true });
    expect(feed(rows)[0]).toMatchObject({ state: 'error', summary: '부모 권한 전달 불가 · jev-gate:worker' });
  });
  it('records a background start that was never sent as not started, not as an interrupted worker', async () => {
    const f = await setup('turn-unsent'); await f.launch(true);
    expect(JSON.stringify(f.returned())).toContain('Worker not started: native_start_rejected at turn_start.');
    const [terminal] = f.traces('background_terminal');
    expect(terminal).toMatchObject({ status: 'failed', failure_category: 'native_start_rejected', failure_stage: 'turn_start', not_executed: true });
    expect(feed([terminal!])[0]).toMatchObject({ state: 'error', summary: 'Codex 워커 시작 거부' });
  });
  it('keeps an unrecordable reservation pending with its reason, then settles it once on a status retry without execution', async () => {
    const f = await setup('reservation-lock'); await f.launch();
    const pending = JSON.stringify(f.returned());
    expect(pending).toContain('Worker not started: reservation_unavailable at reservation; settlement pending'); expect(pending).toContain('agent_id=worker');
    expect(f.job().current.active['dispatch']).toBeDefined(); expect(f.job().current.receipts).toHaveLength(0);
    f.unlock();
    expect(await f.status('s1')).toContain('Worker not started: reservation_unavailable at reservation. Job state could not record');
    expect(f.job().current.active).toEqual({}); expect(f.job().current.receipts).toHaveLength(1);
    expect(await f.status('s2')).toContain('Worker not started: reservation_unavailable at reservation.');
    expect(f.sent.some(m => m['method'] === 'turn/start')).toBe(false);
    expect(f.traces('failure').at(-1)).toMatchObject({ failure_category: 'reservation_unavailable', failure_stage: 'reservation', not_executed: true });
  });
  it.each([['failed', 'native_failed_turn', 'error', 'Codex 워커 턴 실패'], ['interrupted', 'interrupted', 'interrupted', '워커 중단']])('reports an observed %s turn as a terminal, not as non-execution', async (status, category, state, label) => {
    const f = await setup('normal'); const run = f.launch(); await vi.waitFor(() => expect(f.started()).toBe(true)); f.terminal(status); await run;
    expect(JSON.stringify(f.returned())).toContain(`Worker did not complete: ${category} at turn.`);
    const rows = f.traces('failure');
    expect(rows[0]).toMatchObject({ failure_category: category, failure_stage: 'turn', not_executed: false, is_interrupt: status === 'interrupted' });
    const step = feed(rows).find(s => s.title === '호스트 호출 실패')!;
    expect(step).toMatchObject({ state, summary: `${label} · jev-gate:worker` }); expect(step.details).not.toContain('워커 미실행 · 완료 주장 없음');
    expect(await f.status('s1')).toContain(`Worker did not complete: ${category} at turn.`);
  });
  it('reports unknown termination with its reason, keeps the reservation and answers status the same until a terminal', async () => {
    const f = await setup('uncertain'); await f.launch();
    const result = JSON.stringify(f.returned()); expect(result).toContain('Worker termination unconfirmed: termination_unconfirmed at turn_start.');
    expect(f.job().current.active['dispatch']?.codex_execution?.thread_id).toBe('worker'); expect(f.job().current.receipts).toHaveLength(0);
    const rows = f.traces('failure');
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ failure_category: 'termination_unconfirmed', not_executed: false, release_unconfirmed: true });
    expect(feed(rows)[0]).toMatchObject({ state: 'unconfirmed', summary: '워커 종료 미확인 · 예약 유지 · jev-gate:worker' });
    expect(await f.status('s1')).toContain('Worker termination unconfirmed: termination_unconfirmed at turn_start.');
    expect(f.job().current.active['dispatch']).toBeDefined();
    f.terminal(); await vi.waitFor(() => expect(f.job().current.active).toEqual({}));
    expect(await f.status('s2')).toContain('worker observation kept');
    expect(f.sent.filter(m => m['method'] === 'turn/start')).toHaveLength(1);
  });
});
describe('Codex write scope from native tool targets (#234)', () => {
  // Codex 0.162.1 hook shapes: apply_patch -> { command: patch }; exec_command -> Bash { command }, its workdir not reported.
  const scoped = async () => {
    const f = await setup(); await f.launch();
    const other = mkdtempSync(join(tmpdir(), 'jev-unrelated-')); cleanups.push(() => rmSync(other, { recursive: true, force: true }));
    const hook = (tool_name: string, tool_input: Obj, cwd = f.root) => f.policy.nativeHook({ hook_event_name: 'PreToolUse', session_id: 'parent', cwd, tool_name, tool_input });
    const blocked = async (tool_name: string, tool_input: Obj, cwd?: string) => JSON.stringify(await hook(tool_name, tool_input, cwd)).includes('terminal settlement');
    return { ...f, other, hook, blocked };
  };
  const patch = (...lines: string[]) => ({ command: `*** Begin Patch\n${lines.join('\n')}\n*** End Patch\n` });
  const add = (path: string) => `*** Add File: ${path}\n+export const x = 1;`;
  it('allows a patch or edit whose every target is unrelated and denies any overlapping target', async () => {
    const f = await scoped();
    expect(await f.hook('apply_patch', patch(add(join(f.other, 'a.ts')), add(join(f.other, 'nested/b.ts'))))).toEqual({});
    expect(await f.blocked('apply_patch', patch(add(join(f.other, 'a.ts')), add(join(f.root, 'src/x.ts'))))).toBe(true);
    expect(await f.blocked('apply_patch', patch(`*** Update File: ${join(f.other, 'a.ts')}`, `*** Move to: ${join(f.root, 'a.ts')}`, '@@', '-a', '+b'))).toBe(true);
    expect(await f.blocked('apply_patch', patch('*** Delete File: gone.ts'))).toBe(true);
    expect(await f.blocked('apply_patch', { command: 'not a patch' })).toBe(true);
    expect(await f.blocked('Write', { file_path: join(f.root, 'src/x.ts') })).toBe(true);
    // Relative targets resolve against the hook cwd, not against the protected root.
    expect(await f.hook('apply_patch', patch('*** Delete File: gone.ts'), f.other)).toEqual({});
    expect(await f.hook('Edit', { file_path: 'src/x.ts' }, f.other)).toEqual({});
    expect(await f.blocked('Edit', { file_path: `../${basename(f.root)}/src/x.ts` }, f.other)).toBe(true);
  });
  it('compares symlink aliases and traversal by the paths they reach', async () => {
    const f = await scoped();
    mkdirSync(join(f.root, 'sub')); symlinkSync(f.root, join(f.other, 'alias')); symlinkSync(join(f.root, 'sub'), join(f.other, 'deep'));
    expect(await f.blocked('apply_patch', patch(add(join(f.other, 'alias/new.ts'))))).toBe(true);
    expect(await f.blocked('Write', { file_path: join(realpathSync(f.root), 'src/x.ts') }, f.other)).toBe(true);
    // Lexically other/x.ts, but the kernel leaves the symlink target: root/x.ts.
    expect(await f.blocked('apply_patch', patch(add(`${f.other}/deep/../x.ts`)), f.other)).toBe(true);
    expect(await f.blocked('apply_patch', patch(add(`${f.other}/alias/missing/../x.ts`)), f.other)).toBe(true);
    expect(await f.hook('apply_patch', patch(add(`${f.other}/alias/../unrelated.ts`), add(`${f.other}/plain/../unrelated.ts`)), f.other)).toEqual({});
  });
  it('keeps read/status diagnostics with quoted search patterns available inside the protected root', async () => {
    const f = await scoped();
    for (const command of ['ps aux', 'gh issue view 234 --repo MongLong0214/jev-gate --comments', 'gh pr list --state open', 'git status --short', 'git diff --check',
      `rg -n "write|conflict; rm -rf src > hits" src`, `grep -rn 'a && b $(c)' ${f.root}`, 'ps aux | grep -i "codex" 2>/dev/null', `cd ${f.root} && git --no-pager log --oneline -3`,
      `find . -name '*.ts' -not -path './node_modules/*'`, 'cat src/file | wc -l', 'pwd']) {
      expect(await f.hook('Bash', { command }), command).toEqual({});
    }
    for (const command of ['rg foo $(cat list)', 'rg foo `cat list`', 'rg foo > hits.txt', 'git status; touch src/x', 'find . -name x -delete', 'find . -exec rm {} ;',
      'git diff --output=change.diff', 'ps aux | tee ps.txt', 'gh pr merge 1', 'git -c core.pager=sh log', 'rg --pre ./run.sh foo', 'rg "foo', 'echo "$PATH"']) {
      expect(await f.blocked('Bash', { command }), command).toBe(true);
    }
  });
  it('keeps the read commands Codex workers ran during a settlement available and their writing forms blocked (#287)', async () => {
    const f = await scoped();
    for (const command of ['nl -ba src/file.ts', `sed -n '1,80p' src/file.ts`, `sed -n -e '10p;20,30p' -e '$p' a b`, `rg -n foo src | nl -ba | sed -n '1,40p'`, 'command -v codex', 'command -V node',
      'which node', 'node --version', 'git rev-parse --show-toplevel', 'git ls-files src', 'git branch --show-current', 'git blame -L 1,9 src/a.ts',
      'git cat-file -p HEAD', 'git merge-base HEAD origin/main', 'git describe --tags', 'git remote -v', 'git remote get-url origin', 'git config --get user.name',
      'sort -u a', 'uniq -c a', 'cut -d: -f1 a', 'tr a-z A-Z < a', 'stat a', 'file a', 'diff a b', 'jq .x a.json', 'basename a/b', 'dirname a/b', 'realpath a',
      'echo ok', `printf '%s\\n' a`, 'true', 'test -f a', '[ -d src ]', 'date +%s', 'date -u']) {
      expect(await f.hook('Bash', { command }), command).toEqual({});
    }
    for (const command of ['sed -i s/a/b/ src/file.ts', `sed -n '1,80p' -i src/file.ts`, 'sed --in-place -n 1p a', `sed -n 'w out' a`, `sed -n '1w out' a`, `sed -n '1e touch x' a`,
      `sed -n -f script.sed a`, `sed '1,80p' a`, 'sort -o out a', 'sort --output=out a', 'sort -no out a', 'uniq a b', 'date -s 2026-01-01', 'date 0101000026', 'printf -v x y',
      'nl a > out', 'echo x >> src/file.ts', 'jq . a > b', 'command node x.js', 'node --version extra', 'npm -v', 'python -v', 'bash -V', './run.sh --version', 'file -C -m magic', 'git branch -D main', 'git branch new',
      'git remote add x y', 'git config user.name x', 'git config --unset user.name', 'awk 1 a', 'xargs rm', 'env', 'tee out', `cd ${f.root} && node script.mjs`]) {
      expect(await f.blocked('Bash', { command }), command).toBe(true);
    }
  });
  it('counts a dash-led operand after `--` or after the first operand as a file, and an abbreviated writing option as that option (#287)', async () => {
    const f = await scoped();
    for (const command of ['uniq -c -- a', 'uniq -- a', 'uniq -d a', 'sort -r -- a', 'file -b a']) expect(await f.hook('Bash', { command }), command).toEqual({});
    // BSD uniq (macOS) stops options at its first operand and GNU at `--`, so `-out` is the output file; getopt_long takes any unique prefix.
    for (const command of ['uniq -- package.json -out', 'uniq package.json -out', 'uniq -c a -', 'uniq - out', 'sort --out=x a', 'sort --o=x a', 'sort --temp=d a', 'sort --compress=gzip a',
      'file --comp -m magic', 'rg --hostname-bin=x foo']) {
      expect(await f.blocked('Bash', { command }), command).toBe(true);
    }
  });
  it('blocks the git read options that run configured filters, textconv, external diff or gpg, prefixes included (#287)', async () => {
    const f = await scoped();
    for (const command of ['git cat-file -p HEAD:package.json', 'git diff --no-ext-diff --no-textconv', 'git log --format=%H -1', 'git show --stat HEAD',
      'git log --no-show-signature --no-textconv -p', 'git show --no-ext-diff --no-textconv HEAD', 'git blame --no-textconv a',
      'git status --short', 'git rev-parse HEAD', 'git ls-files', 'git merge-base HEAD main', 'git describe HEAD',
      'git branch --show-current', 'git remote get-url origin', 'git config --get user.name']) {
      expect(await f.hook('Bash', { command }), command).toEqual({});
    }
    for (const command of ['git cat-file --filters --path=package.json HEAD:package.json', 'git cat-file --textconv HEAD:package.json', 'git cat-file --textc HEAD:a', 'git cat-file --text HEAD:a',
      'git cat-file --filt --path=a HEAD:a', 'git cat-file --batch --filters', 'git diff --ext-diff', 'git diff --textconv', 'git log -p --ext-diff', 'git show --textconv HEAD',
      'git -C . blame --textconv a', 'git log --show-signature -1', 'git log --format=%G? -1', 'git show --pretty=format:%GS HEAD',
      'git diff --no-no-textconv', 'git diff --no-no-ext-diff', 'git log --no-no-textc -p', 'git show --no-no-ext HEAD',
      'git cat-file --no-no-filt --path=a HEAD:a', 'git log --no-no-show-signature -1', 'git diff --textconv=true',
      'git diff --ext', 'git log -p --textc', 'git show --ext-diff HEAD', 'git grep --textconv pattern', 'git grep --textc pattern',
      'git grep --ext-diff pattern', 'git grep --no-no-textconv pattern']) {
      expect(await f.blocked('Bash', { command }), command).toBe(true);
    }
  });
  describe('ROUND1-ESCAPE-1 Git configuration callbacks', () => {
    const keys = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXTERNAL_DIFF'] as const;
    const cleanEnv = () => {
      for (const key of keys) {
        const old = process.env[key];
        cleanups.push(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
        delete process.env[key];
      }
    };
    it.each([
      `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0='printf FILTER_EXECUTED' git diff --no-index -- a b`,
      `GIT_EXTERNAL_DIFF='printf FILTER_EXECUTED' git diff --no-index -- a b`,
      'GIT_CONFIG_GLOBAL=callbacks.config git diff --no-index -- a b',
      `GIT_CONFIG_PARAMETERS="'diff.external=printf FILTER_EXECUTED'" git diff --no-index -- a b`,
      'ARBITRARY=1 git diff --no-index -- a b',
      'ARBITRARY= git status --short',
      `git -c diff.external='printf FILTER_EXECUTED' diff --no-index -- a b`,
      `git -cdiff.external='printf FILTER_EXECUTED' diff --no-index -- a b`,
      'git --config-env=diff.external=CALLBACK diff --no-index -- a b',
      'git --config-env diff.external=CALLBACK diff --no-index -- a b',
      'git -c color.ui=false status --short',
    ])('blocks unknown targets from an unrelated directory: %s', async command => {
      cleanEnv(); const f = await scoped();
      expect(await f.blocked('exec_command', { cmd: command, workdir: f.other }, f.other)).toBe(true);
      expect(await f.blocked('Bash', { command: `cd ${f.other} && ${command}` })).toBe(true);
    });
    it.each(keys.flatMap(key => ['', key === 'GIT_CONFIG_COUNT' ? '1' : 'callback'].map(value => [key, value] as const)))('blocks inherited %s=%s including empty presence', async (key, value) => {
      cleanEnv(); const f = await scoped(); process.env[key] = value;
      for (const command of ['git diff --no-index -- a b', 'git status --short']) {
        expect(await f.blocked('exec_command', { cmd: command, workdir: f.other }, f.other), command).toBe(true);
        expect(await f.blocked('Bash', { command }), command).toBe(true);
      }
    });
    it.each(['git diff --no-index -- a b', 'git status --short'])('allows clean-env plain reads: %s', async command => {
      cleanEnv(); const f = await scoped();
      expect(await f.hook('Bash', { command })).toEqual({});
      expect(await f.hook('exec_command', { cmd: command, workdir: f.other }, f.other)).toEqual({});
    });
  });
  it('confines an unknown shell command by its reported workdir, a leading absolute cd or the session cwd, and the paths it names', async () => {
    const f = await scoped();
    expect(await f.hook('exec_command', { cmd: 'npx vitest run tests/a.test.ts', workdir: f.other })).toEqual({});
    expect(await f.hook('Bash', { command: `cd ${f.other} && npx vitest run tests/a.test.ts --reporter=dot` })).toEqual({});
    expect(await f.hook('Bash', { command: `cd ${f.other} && cd nested && touch out.txt` })).toEqual({});
    // Without a reported workdir the session cwd stands in, as before #234: a session outside every scope keeps its shell.
    expect(await f.hook('Bash', { command: 'npx vitest run' }, f.other)).toEqual({});
    expect(await f.hook('Bash', { command: 'cd nested && touch x' }, f.other)).toEqual({});
    expect(await f.hook('write_stdin', { session_id: 1, chars: 'y\n' }, f.other)).toEqual({});
    for (const [tool, input, cwd] of [
      ['exec_command', { cmd: 'npx vitest run' }, f.root], ['exec_command', { cmd: 'touch x', workdir: join(f.root, 'src') }, f.other],
      ['Bash', { command: 'npx vitest run' }, f.root], ['Bash', { command: 'cd nested && touch x' }, f.root],
      ['Bash', { command: `cd ${f.other} && rm -rf ${join(f.root, 'src')}` }, f.root], ['Bash', { command: `cd ${f.other} && cp a.ts ../${basename(f.root)}/a.ts` }, f.root],
      ['Bash', { command: `cd ${f.other} && touch --out=../${basename(f.root)}/x` }, f.root], ['Bash', { command: `cd ${f.other} && rm -rf ../*` }, f.root],
      ['Bash', { command: `cd ${f.other} && touch "$HOME/x"` }, f.root], ['Bash', { command: `cd ${f.other} && bash -c 'cd ..; rm -rf x'` }, f.root],
      ['Bash', { command: `cd ${f.other} && (cd .. && rm x)` }, f.root], ['Bash', { command: `cd ${f.other}; rm x` }, f.root], ['Bash', { command: `cd ${f.other} && touch ~/x` }, f.root],
      ['write_stdin', { session_id: 1, chars: 'rm -rf src\n' }, f.root],
    ] as const) expect(await f.blocked(tool, input, cwd), JSON.stringify(input)).toBe(true);
  });
  it('protects several managed workers by their own scopes and releases one only at its observed terminal settlement', async () => {
    const f = await scoped(); const state = f.job(); const held = state.current.active['dispatch']!;
    updateJob(f.stateEnv, 'holder', () => ({ ...state, session_id: 'holder', history: [], current: { ...state.current, active: { held: { ...held, deliverables: ['owned.ts'], codex_execution: { thread_id: 'held', turn_id: 'held-turn', cwd: f.other, root_cwd: f.other } } } } }));
    expect(await f.blocked('Write', { file_path: join(f.other, 'owned.ts') }, f.other)).toBe(true);
    expect(await f.blocked('Bash', { command: `cd ${f.other} && touch free.ts` })).toBe(true);
    expect(await f.hook('Bash', { command: `cd ${join(f.other, 'nested')} && touch free.ts` })).toEqual({});
    expect(await f.hook('Write', { file_path: join(f.other, 'free.ts') }, f.other)).toEqual({});
    expect(await f.blocked('Write', { file_path: join(f.root, 'src/x.ts') }, f.other)).toBe(true);
    // An unconfirmed execution keeps its reservation through status queries; only the observed terminal releases it.
    expect(await f.status('s1')).toContain('termination unconfirmed');
    expect(await f.blocked('Write', { file_path: join(f.root, 'src/x.ts') }, f.other)).toBe(true);
    f.terminal(); await vi.waitFor(() => expect(f.job().current.active).toEqual({}));
    expect(await f.hook('Write', { file_path: join(f.root, 'src/x.ts') }, f.other)).toEqual({});
    expect(await f.blocked('Write', { file_path: join(f.other, 'owned.ts') }, f.other)).toBe(true);
    expect(f.job().current.receipts).toHaveLength(1); expect(f.sent.filter(m => m['method'] === 'turn/start')).toHaveLength(1);
  });
});

describe('Codex reservation across a host restart (#239)', () => {
  const exitedPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;
  type F = Awaited<ReturnType<typeof setup>>;
  const write = (f: F) => f.policy.nativeHook({ hook_event_name: 'PreToolUse', session_id: 'parent', tool_name: 'Write', tool_input: { file_path: join(f.root, 'src/file') } });
  // A new process never knew the worker; only its durable reservation and recorded host remain.
  const restartHost = (f: F, hostPid: number | undefined) => {
    f.policy.sessions.delete('worker');
    updateJob(f.stateEnv, 'parent', prev => {
      if (!prev) return null;
      const r = prev.current.active['dispatch']!; const { host_pid: _recorded, ...e } = r.codex_execution!;
      return { ...prev, current: { ...prev.current, active: { dispatch: { ...r, codex_execution: hostPid === undefined ? e : { ...e, host_pid: hostPid } } } } };
    });
  };
  it('settles a worker whose app-server exited, stops protecting its scope and answers status with that result', async () => {
    const f = await setup('uncertain'); f.policy.hostPid = process.pid; await f.launch();
    expect(f.job().current.active['dispatch']?.codex_execution?.host_pid).toBe(process.pid);
    expect(JSON.stringify(await write(f))).toContain('deny');
    restartHost(f, exitedPid());
    expect(JSON.stringify(await write(f))).not.toContain('deny');
    expect(f.job().current.active).toEqual({});
    expect(f.job().current.receipts).toHaveLength(1); expect(f.job().current.receipts[0]!.verdict).not.toBe('accept');
    expect(f.traces('failure').filter(t => t['failure_category'] === 'interrupted' && t['failure_stage'] === 'turn')).toHaveLength(1);
    expect(await f.status('s1')).toContain('app-server exited');
    await write(f); expect(f.job().current.receipts).toHaveLength(1);
  });
  it('keeps protection while the recorded app-server still runs elsewhere; an exited host in another session never blocks and ages out', async () => {
    const f = await setup('uncertain'); f.policy.hostPid = process.pid; await f.launch();
    restartHost(f, process.ppid);
    expect(JSON.stringify(await write(f))).toContain('deny');
    expect(await f.status('s1')).toContain('still running');
    expect(f.job().current.active['dispatch']).toBeDefined();
    const state = f.job(); const held = state.current.active['dispatch']!;
    updateJob(f.stateEnv, 'holder', () => ({ ...state, session_id: 'holder', history: [], current: { ...state.current, active: { held: { ...held, codex_execution: { ...held.codex_execution!, host_pid: exitedPid() } } } } }));
    updateJob(f.stateEnv, 'parent', prev => prev && { ...prev, current: { ...prev.current, active: {} } });
    expect(JSON.stringify(await write(f))).not.toContain('deny');
    cleanupJobs(f.stateEnv, Date.now() + 100 * 24 * 3600000);
    expect(existsSync(jobPath(f.stateEnv, 'holder'))).toBe(false);
  });
  it('keeps a reservation without a recorded host until an explicit cancel releases it', async () => {
    const f = await setup('uncertain'); await f.launch();
    expect(f.job().current.active['dispatch']?.codex_execution?.host_pid).toBeUndefined();
    restartHost(f, undefined);
    expect(JSON.stringify(await write(f))).toContain('deny');
    expect(await f.status('s1')).toContain('did not record its Codex host');
    expect(f.job().current.active['dispatch']).toBeDefined();
    await f.rpc.onRequest({ id: 'cancel', method: 'item/tool/call', params: { threadId: 'parent', tool: 'jev_agent', arguments: { action: 'cancel', agent_id: 'worker' } } });
    expect(JSON.stringify(f.sent.find(m => m['id'] === 'cancel'))).toContain('explicit user cancellation');
    expect(f.job().current.active).toEqual({}); expect(f.job().current.receipts).toHaveLength(1);
    expect(JSON.stringify(await write(f))).not.toContain('deny');
  });
});
describe('Codex owned dispatch input guidance (#287)', () => {
  it('records a thrown native dispatch by its closed category where it is caught, never its message (#287 R2)', async () => {
    const f = await setup('normal');
    const agent = vi.spyOn(f.policy as unknown as { agent: (p: Obj) => Promise<string> }, 'agent');
    agent.mockRejectedValueOnce(new RpcRequestError('closed', true)).mockRejectedValueOnce(new Error('EACCES /secret/path'));
    for (const id of ['a', 'b']) await f.rpc.onRequest({ id, method: 'item/tool/call', params: { threadId: 'parent', callId: id, tool: 'jev_agent', arguments: {} } });
    expect(JSON.stringify(f.sent.filter(m => m['id'] === 'a' || m['id'] === 'b'))).toContain('Jev dispatch failed or was interrupted');
    const rows = f.traces('failure');
    expect(rows.map(r => r['dispatch_failure']).sort()).toEqual(['exception', 'rpc_closed']);
    for (const row of rows) expect(row).toMatchObject({ host: 'codex', session_id: 'parent', tool_name: 'jev_agent', error_first_line: `dispatch_${String(row['dispatch_failure'])}` });
    expect(JSON.stringify(rows)).not.toMatch(/EACCES|secret|disconnected/);
  });
  it('names the real jev_agent fields in the tool, the session instructions and the refusal, so a retry can succeed', async () => {
    const f = await setup('normal');
    await f.rpc.onRequest({ id: 'wrong', method: 'item/tool/call', params: { threadId: 'parent', callId: 'wrong', tool: 'jev_agent', arguments: { action: 'start', profile: 'jev-gate:worker-fast', marker: '[JEV_TASK rev=1 id=a attempt=1]', task: 'Investigate' } } });
    const refusal = JSON.stringify(f.sent.find(m => m['id'] === 'wrong'));
    for (const text of ['subagent_type (one of jev-gate:worker, jev-gate:planner)', 'prompt (', '[JEV_TASK', 'status|cancel with agent_id']) expect(refusal).toContain(text);
    expect(f.sent.some(m => m['method'] === 'thread/start')).toBe(false);
    await f.policy.client({ id: 'root', method: 'thread/start', params: { cwd: f.root } });
    const instructions = String((f.sent.find(m => m['method'] === 'thread/start')?.['params'] as Obj | undefined)?.['developerInstructions']);
    for (const text of [AGENT_TOOL.description, instructions]) {
      expect(text).toMatch(/\bsubagent_type\b/); expect(text).toMatch(/\bprompt\b/); expect(text).toContain('[JEV_TASK'); expect(text).not.toMatch(/profile and marker/);
    }
  });
});
