import { PassThrough } from 'node:stream';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { codexSource, codexObservation, type Obj } from '../../src/codex/source.js';
import { catalogTierModels, loadCodexPolicy } from '../../src/codex/config.js';
import { routeCodex } from '../../src/codex/router.js';
import { CodexRpc } from '../../src/codex/rpc.js';
import { CodexPolicy } from '../../src/codex/policy.js';
import { readJob } from '../../src/job.js';
import { extractCodexCompact, compactResponse } from '../../src/codex/compact.js';
import { nativeLaunchOptions, nativeWorkspaceUpstream } from '../../src/codex/launch.js';
import { buildOperations } from '../../src/operations.js';
const tmp = mkdtempSync(join(tmpdir(), 'jev-codex-policy-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
writeFileSync(join(tmp, 'policy.json'), '{}');
const config = loadCodexPolicy({ JEV_CODEX_CONFIG: join(tmp, 'policy.json') });
const catalog = [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort })) }];
const response = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
describe('Codex ordered routing and recorded application', () => {
  it('chooses accessible model tiers from live descriptions and keeps explicit mappings', () => {
    const available = [
      { ...catalog[0]!, model: 'account-workhorse', description: 'Latest workhorse model for coding and everyday work.', isDefault: true },
      { ...catalog[0]!, model: 'account-frontier', description: 'Frontier intelligence for the most demanding work.' },
      { ...catalog[0]!, model: 'account-fast', description: 'Fast and affordable model for easier tasks.' },
      { ...catalog[0]!, model: 'hidden-review', description: 'Fast frontier model', hidden: true },
    ];
    const models = { fast: 'account-fast', standard: 'account-workhorse', deep: 'account-workhorse', frontier: 'account-frontier' };
    expect(catalogTierModels('account-workhorse', available)).toEqual(models);
    const p = loadCodexPolicy({ JEV_CODEX_CONFIG: join(tmp, 'policy.json'), JEV_CODEX_MODEL: 'account-workhorse' }, available);
    expect(p.gate).toMatchObject({ models, maxParallelWorkers: 16, workerIsolation: 'worktree', guardAllowTools: ['*'], delegationDepthFloor: 0, planInterpretation: true });
    expect(p.router.model).toBe(true); expect(p.compact.manual).toBe(true);
    const serial = join(tmp, 'serial-policy.json'); writeFileSync(serial, JSON.stringify({ gate: { maxParallelWorkers: 1, guardAllowTools: [] } }));
    expect(loadCodexPolicy({ JEV_CODEX_CONFIG: serial }).gate.workerIsolation).toBe('none');
    const override = join(tmp, 'explicit-models.json'); writeFileSync(override, JSON.stringify({ gate: { models: { fast: 'owner-model' } } }));
    expect(loadCodexPolicy({ JEV_CODEX_CONFIG: override, JEV_CODEX_MODEL: 'account-workhorse' }, available).gate.models).toEqual({ ...models, fast: 'owner-model' });
  });
  const answersFor = (request: Obj, model = '__keep__', effort = 'low', control = 'task_clear'): Obj => {
    const questions = request['questions'] as Record<string, { type: string; criteria: Record<string, string> | string[] }>;
    return Object.fromEntries(Object.entries(questions).map(([name, q]) => {
      if (q.type === 'choice') {
        const pick = name === 'control' ? control : name === 'model' ? model : 'ordinary';
        return [name, { type: 'choice', choice: pick, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === pick ? 1 : 0])) }];
      }
      const prefix: Record<string, string> = { none: 'No reasoning', minimal: 'A trivial', low: 'Light reasoning', medium: 'Ordinary reasoning', high: 'Strong reasoning', xhigh: 'Exceptional reasoning', max: 'Maximum sustained', ultra: 'Exhaustive host' };
      return [name, { type: 'score', probabilities: Object.fromEntries((q.criteria as string[]).map((v, i) => [i, v.startsWith(prefix[effort]!) ? 1 : 0])) }];
    }));
  };
  const invoke = async (kind = 'valid', effort: string | null = 'medium') => {
    const rows: Obj[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const request = JSON.parse(String(init?.body)) as Obj;
      const answers = answersFor(request, '__keep__', 'low', kind === 'locked' ? 'explicit_lock' : 'task_clear');
      if (kind === 'invalid') answers['effort_0'] = { type: 'score', probabilities: { 0: .4, 1: .4 } };
      if (kind === 'failed') return new Response('', { status: 503 });
      return response({ model: kind === 'model-mismatch' ? 'wrong-model' : request['model'], answers });
    });
    const patch = await routeCodex({ model: 'gpt-6.1-sol', effort, task: 'PRIVATE_REQUEST', session: 's', prompt: 'p', catalog, config,
      env: { TYPESAFE_API_KEY: 'PRIVATE_KEY', ...(kind === 'disabled' ? { JEV_CODEX_ENABLED: '0' } : {}) }, fetchImpl: fetchImpl as typeof fetch,
      trace: { write: (phase, row) => { rows.push({ phase, written_at: '2026-09-30T01:00:00Z', ...row }); if (kind === 'disk-threw') throw new Error('disk'); return kind === 'disk-failed' ? { ok: false, error: 'full' } : { ok: true, file: 'f' }; } } });
    return { patch, rows, fetchImpl };
  };
  it('uses ordered effort scores and records selections without confirming a response', async () => {
    const { patch, rows } = await invoke();
    expect(patch).toEqual({ effort: 'low', effortEdit: { kind: 'set', value: 'low' } });
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_REQUEST|PRIVATE_KEY/);
    const view = buildOperations([...rows, { phase: 'codex_route_applied', host: 'codex', session_id: 's', prompt_id: 'p', written_at: '2026-09-30T01:00:01Z', applied: true, selected_model: 'gpt-6.1-sol', submitted_model: 'gpt-6.1-sol', submitted_effort: 'low' }], [], new Date('2026-09-30T01:00:02Z'), { trace: true, debug: false, host: 'codex' });
    expect(view.requests).toBe(1); expect(view.latency.measured).toBe(1);
    expect(view.feed.find(s => s.lane === 'host')?.model?.status).toBe('unobserved');
    expect(view.feed.some(s => s.judgements?.length)).toBe(true);
  });
  it.each(['locked', 'invalid', 'failed', 'model-mismatch', 'disabled'])('preserves the original call on %s', async kind => {
    const r = await invoke(kind); expect(r.patch).toEqual({}); expect(r.fetchImpl).toHaveBeenCalledTimes(kind === 'disabled' ? 0 : 1);
  });
  it.each(['disk-failed', 'disk-threw'])('keeps identical execution when optional recording is %s', async kind => {
    const r = await invoke(kind); expect(r.patch).toEqual((await invoke()).patch); expect(r.fetchImpl).toHaveBeenCalledOnce();
  });
  it('keeps unsupported host modes when the service answer is unavailable', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    expect(await routeCodex({ model: 'gpt-6-luna', effort: 'ultra', task: 'task', session: 's', prompt: 'p', catalog: [{ ...catalog[0]!, model: 'gpt-6-luna', supportedReasoningEfforts: catalog[0]!.supportedReasoningEfforts.slice(0, 5) }], config, env: { TYPESAFE_API_KEY: 'key' }, fetchImpl })).toEqual({});
  });
  it('does not substitute a catalog default for an unobserved baseline effort', async () => {
    expect((await invoke('valid', null)).patch).toEqual({ effort: 'low', effortEdit: { kind: 'set', value: 'low' } });
  });
  it.each(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-daybreak-blue-latest', 'account-specific-model'])('selects every listed effort on %s', async model => {
    const native = { ...catalog[0]!, model };
    for (const target of native.supportedReasoningEfforts.map(e => e.reasoningEffort)) {
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => { const req = JSON.parse(String(init?.body)); return response({ model: req.model, answers: answersFor(req, '__keep__', target) }); });
      expect(await routeCodex({ model, effort: target === 'low' ? 'ultra' : 'low', task: 'task', session: 's', prompt: 'p', catalog: [native], config, env: { TYPESAFE_API_KEY: 'key' }, fetchImpl })).toEqual({ effort: target, effortEdit: { kind: 'set', value: target } });
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });
  it.each(['Fixture-E', 'Fixture-F'])('selects %s outside four role preferences, including an unknown baseline', async target => {
    const native = ['Fixture-A', 'Fixture-B', 'Fixture-C', 'Fixture-D', 'Fixture-E', 'Fixture-F'].map(model => ({ model, description: 'General coding model', supportedReasoningEfforts: ['low', 'high', 'max'].map(reasoningEffort => ({ reasoningEffort })) }));
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => { const req = JSON.parse(String(init?.body)); expect(Object.keys(req.questions.model.criteria)).toContain(target); return response({ model: req.model, answers: answersFor(req, target, 'max') }); });
    expect(await routeCodex({ model: 'outside-role-mapping', effort: 'high', task: 'task', session: 's', prompt: 'p', catalog: native, config, env: { TYPESAFE_API_KEY: 'key' }, fetchImpl })).toEqual({ model: target, effort: 'max', effortEdit: { kind: 'set', value: 'max' } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
describe('native workspace authentication routing', () => {
  const result = (origin = 'https://workspace.example.invalid', id = 'same-workspace') => ({ workspaceRouting: { chatgptAccountId: id, backendOrigin: origin, accountRoutingOverride: 'us_cr' } });
  it('preserves the official native workspace origin and residency header without reading credentials', () => {
    expect(nativeWorkspaceUpstream(result(), 'same-workspace')).toEqual({ origin: 'https://workspace.example.invalid', override: 'us_cr' });
    expect(nativeWorkspaceUpstream({ workspaceRouting: null }, 'same-workspace')).toBeNull();
  });
  it.each(['http://workspace.example.invalid', 'https://user:secret@workspace.example.invalid', 'https://workspace.example.invalid/path', 'https://workspace.example.invalid/?x=1', 'https://workspace.example.invalid/#x'])('refuses an invalid native origin: %s', origin => expect(() => nativeWorkspaceUpstream(result(origin), 'same-workspace')).toThrow());
  it('refuses routing discovered for a different workspace', () => expect(() => nativeWorkspaceUpstream(result(undefined, 'other'), 'same-workspace')).toThrow());
});
describe('native source integrity and check evidence', () => {
  const binding = { sessionId: 's', promptId: 'p', request: 'current request', phase: 'dispatch' as const };
  const current = { id: 'u2', type: 'userMessage', clientId: 'p', content: [{ type: 'text', text: 'current request' }] };
  const items = [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'keep my constraint' }] }, { id: 'a1', type: 'agentMessage', text: 'old irrelevant narrative' }, current];
  it('preserves human constraints and binds to the exact request; later human input invalidates recency', () => {
    const source = codexSource(items, binding, 'epoch', true);
    expect(source).toMatchObject({ ok: true, source: { requestRecorded: true, newerHumanText: false, groups: [{ mandatory: true, origin: 'human' }, { mandatory: false, origin: 'assistant_tool' }] } });
    expect(codexSource([...items, { ...current, id: 'u3', clientId: 'next' }], binding, 'epoch', true)).toMatchObject({ ok: true, source: { newerHumanText: true } });
    expect(codexSource(items, { ...binding, request: 'different' }, 'epoch', true)).toMatchObject({ ok: false, reason: 'source_identity_mismatch' });
  });
  it.each([
    [false, items, 'source_incomplete'], [true, [...items.slice(0, -1), { ...current, content: [{ type: 'image', url: 'x' }] }], 'source_identity_mismatch'],
    [true, [{ id: 'opaque', type: 'contextCompaction' }, current], 'source_unsupported'], [true, [{ id: 'pending', type: 'commandExecution', status: 'inProgress' }, current], 'source_incomplete'],
  ] as const)('falls back for an incomplete or opaque source (%#)', (complete, source, reason) => expect(codexSource(source, binding, 'epoch', complete)).toMatchObject({ ok: false, reason }));
  it('never treats a reported pass or a successful shell wrapper with extra commands as observed pass', () => {
    const commands = new Map([['c1', 'vitest run'], ['c2', 'vitest run']]);
    const observation = codexObservation([{ id: 'c1', type: 'commandExecution', command: "/bin/zsh -c 'vitest run'", status: 'failed', exitCode: 1 }, { id: 'w', type: 'fileChange', status: 'inProgress' }, { id: 'c2', type: 'commandExecution', command: "/bin/zsh -c 'vitest run; true'", status: 'completed', exitCode: 0 }], false, commands);
    expect(observation).toMatchObject({ truncated: true, openWrite: true, lastWrite: 1, runs: [{ command: 'vitest run', status: 'failed' }, { command: "/bin/zsh -c 'vitest run; true'", status: 'passed' }] });
  });
});
describe('native compaction contract', () => {
  it('shows a digest waiting for installation and closes only on the native installed record', () => {
    const selected = { host: 'codex', phase: 'codex_compact', session_id: 's', run_id: 'c', stage: 'selected', applied: false, written_at: '2026-09-30T01:00:00Z' };
    const now = new Date('2026-09-30T01:00:01Z');
    const open = buildOperations([selected], [], now, { trace: true, debug: false, host: 'codex' });
    expect(open.runs.find(r => r.source === 'compact')).toMatchObject({ state: 'active', title: expect.stringContaining('Compact') });
    const installed = { ...selected, stage: 'installed', applied: true, written_at: '2026-09-30T01:00:01Z' };
    expect(buildOperations([selected, installed], [], now, { trace: true, debug: false, host: 'codex' }).runs.find(r => r.source === 'compact')?.state).toBe('done');
  });
  const message = (role: string, text: string) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
  const input = [message('user', 'Preserve this exact constraint.'), message('assistant', 'irrelevant narrative '.repeat(4000)), message('user', 'New question'), message('assistant', 'new reply'), message('user', 'compact-marker')];
  it('preserves user constraints in a valid native response with complete usage fields', () => {
    const compact = extractCodexCompact(input, 'compact-marker', 40000); expect(compact.ok).toBe(true);
    if (!compact.ok) return;
    expect(compact.summary).toContain('Preserve this exact constraint.');
    expect(compact.after).toBeLessThan(compact.before / 2);
    expect(extractCodexCompact([{ type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'jev_agent' }] }, ...input], 'compact-marker', 40000)).toMatchObject({ ok: true, summary: compact.summary });
    const events = compactResponse(compact.summary).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    expect(events.at(-1).response.usage).toMatchObject({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });
  it.each([
    [[...input.slice(0, -1), message('user', 'normal prompt')], 'not_compact'],
    [[{ type: 'reasoning', encrypted_content: 'opaque' }, ...input], 'opaque_context'],
    [[{ type: 'function_call', call_id: 'pending', name: 'tool', arguments: '{}' }, ...input], 'pending_call'],
    [[{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'image' }] }, ...input], 'media_or_role'],
  ])('preserves native compaction for an unsafe extraction (%#)', (source, reason) => expect(extractCodexCompact(source, 'compact-marker', 40000)).toEqual({ ok: false, reason }));
});
describe('native transport authority', () => {
  it('confirms Ultra only from an official host setting and preserves selected versus wire facts', async () => {
    const rpc = new CodexRpc(new PassThrough(), new PassThrough());
    const trace = join(tmp, 'ultra-observation');
    const policy = new CodexPolicy(rpc, { JEV_CODEX_TRACE_DIR: trace });
    policy.catalog = catalog;
    await rpc.onResponse({ model: 'gpt-6.1-sol', reasoningEffort: 'medium', cwd: tmp, thread: { id: 'ultra' } }, 'thread/start', {});
    const session = policy.sessions.get('ultra')!;
    session.prompt = 'unconfirmed'; session.route = { effort: 'ultra' };
    policy.observeRequest('ultra', { model: 'gpt-6.1-sol', reasoning: { effort: 'max' } });
    rpc.onNotification({ method: 'thread/settings/updated', params: { threadId: 'ultra', threadSettings: { effort: 'ultra' } } });
    session.prompt = 'confirmed'; session.route = { effort: 'ultra' };
    policy.observeRequest('ultra', { model: 'gpt-6.1-sol', reasoning: { effort: 'max' } });
    expect(session.settings['effort']).toBe('ultra');
    expect(session.requestEffort).toBe('max');
    const rows = readdirSync(trace).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8')));
    expect(rows.find(r => r.prompt_id === 'unconfirmed' && r.phase === 'codex_route_applied')).toMatchObject({ applied: false, selected_effort: 'ultra', submitted_effort: 'max', observed_effort: 'unknown' });
    expect(rows.find(r => r.prompt_id === 'confirmed' && r.phase === 'codex_route_applied')).toMatchObject({ applied: true, selected_effort: 'ultra', observed_host_effort: 'ultra', submitted_effort: 'max', observed_effort: 'unknown', effort_resolution: 'native_ultra' });
    rpc.close();
  });
  it('refuses duplicate active Jev installations before registering a thread', async () => {
    const rpc = new CodexRpc(new PassThrough(), new PassThrough());
    const forward = vi.spyOn(rpc, 'forward');
    vi.spyOn(rpc, 'request').mockImplementation(async method => method === 'hooks/list' ? { data: [{ hooks: ['one', 'two'].map(id => ({ source: 'plugin', pluginId: `jev-gate@${id}`, enabled: true, key: id })) }] } : { config: {} });
    const policy = new CodexPolicy(rpc, { JEV_CODEX_TRACE_DIR: join(tmp, 'duplicate') });
    await expect(policy.client({ id: 1, method: 'thread/start', params: {} })).rejects.toThrow('only one');
    expect(forward).not.toHaveBeenCalled(); rpc.close();
  });
  it('does not apply a late admission after its native hook request was cancelled', async () => {
    const rpc = new CodexRpc(new PassThrough(), new PassThrough());
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 20));
      const request = JSON.parse(String(init?.body));
      return response({ model: request.model, answers: Object.fromEntries(Object.keys(request.questions).map(k => [k, { type: 'score', score: 4, probabilities: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1 } }])) });
    });
    const env = { JEV_CODEX_CONFIG: join(tmp, 'policy.json'), JEV_CODEX_TRACE_DIR: join(tmp, 'cancelled'), JEV_GATE_STATE_DIR: join(tmp, 'cancelled-state'), TYPESAFE_API_KEY: 'fixture-key' };
    const policy = new CodexPolicy(rpc, env, fetchImpl as typeof fetch);
    await rpc.onResponse({ model: 'gpt-6.1-sol', cwd: tmp, thread: { id: 'cancelled' } }, 'thread/start', {});
    const session = policy.sessions.get('cancelled')!;
    session.prompt = 'p'; session.tokens = 500000; session.window = 1000000;
    expect(await policy.nativeHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cancelled', prompt: 'Investigate the repository.' }, controller.signal)).toEqual({});
    expect(fetchImpl).toHaveBeenCalledOnce();
    const job = readJob({ JEV_GATE_STATE_DIR: join(env.JEV_GATE_STATE_DIR, 'codex') }, 'cancelled');
    expect(job.ok && job.value?.current.shape).toBe('direct'); rpc.close();
  });
  it('reclassifies a native follow-up with only observed earlier human requests and carries them into dispatch', async () => {
    const rpc = new CodexRpc(new PassThrough(), new PassThrough()); const seen: string[] = [];
    const env = { JEV_CODEX_CONFIG: join(tmp, 'policy.json'), JEV_CODEX_TRACE_DIR: join(tmp, 'followup'), JEV_GATE_STATE_DIR: join(tmp, 'followup-state'), TYPESAFE_API_KEY: 'fixture-key' };
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)); seen.push(request.state.request);
      const answers = Object.fromEntries(Object.entries(request.questions as Record<string, { type: string; criteria: string[] | Record<string, string> }>).map(([k,q]) => {
        if (q.type === 'noul') return [k, { type:'noul',noul:0 }];
        if (q.type === 'score') return [k,{ type:'score', score:4, confidence:1, probabilities:Object.fromEntries((q.criteria as string[]).map((_,i)=>[i,i===4?1:0])) }];
        const keys = Object.keys(q.criteria);
        const pick = k === 'task_context' && request.state.request === 'Run it now.' ? 'needs_context' : keys[0];
        return [k,{ type:'choice',choice:pick,confidence:1,probabilities:Object.fromEntries(keys.map(v=>[v,v===pick?1:0])) }];
      })); return response({ model:request.model, answers });
    });
    const policy = new CodexPolicy(rpc,env,fetchImpl as typeof fetch);
    await rpc.onResponse({model:'gpt-6.1-sol',cwd:tmp,thread:{id:'followup'}},'thread/start',{});
    const session = policy.sessions.get('followup')!; session.tokens=500000; session.window=1000000;
    session.prompt='first';
    await policy.nativeHook({hook_event_name:'UserPromptSubmit',session_id:'followup',prompt:'Implement the download validation and run its full checks.'});
    session.prompt='second';
    await policy.nativeHook({hook_event_name:'UserPromptSubmit',session_id:'followup',prompt:'Run it now.'});
    expect(seen.at(-1)).toContain('Implement the download validation');
    const job = readJob({JEV_GATE_STATE_DIR:join(env.JEV_GATE_STATE_DIR,'codex')},'followup');
    expect(job.ok && job.value?.current.request).toContain('Current request:\nRun it now.');
    rpc.close();
  });
  it('separates colliding client, internal and approval ids, preserving approval payload exactly', async () => {
    const input = new PassThrough(); const output = new PassThrough(); const outbound: Obj[] = []; const emitted: Obj[] = [];
    output.on('data', chunk => outbound.push(...String(chunk).trim().split('\n').map(l => JSON.parse(l))));
    const rpc = new CodexRpc(input, output); rpc.emit = m => emitted.push(m);
    const internal = rpc.request('internal', {}); rpc.forward({ id: 1, method: 'external', params: {} });
    input.write(JSON.stringify({ id: outbound[1]!['id'], result: { external: true } }) + '\n');
    input.write(JSON.stringify({ id: outbound[0]!['id'], result: { internal: true } }) + '\n');
    input.write(JSON.stringify({ id: 1, method: 'item/commandExecution/requestApproval', params: { command: 'touch file' } }) + '\n');
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    expect(await internal).toEqual({ internal: true }); expect(emitted[0]).toMatchObject({ id: 1, result: { external: true } });
    expect(emitted[1]!['params']).toEqual({ command: 'touch file' });
    rpc.forward({ id: emitted[1]!['id'], result: { decision: 'decline' } });
    expect(outbound[2]).toEqual({ id: 1, result: { decision: 'decline' } }); rpc.close();
  });
  it('rejects pending requests on disconnect and ignores late replies', async () => {
    const input = new PassThrough(); const rpc = new CodexRpc(input, new PassThrough());
    const pending = rpc.request('wait', {}); const rejected = expect(pending).rejects.toThrow('disconnected'); rpc.close(); await rejected;
    await expect(rpc.request('after', {})).rejects.toThrow('unavailable');
  });
  it('preserves native CLI sandbox and approval choices, and resolves relative workspaces', () => {
    expect(nativeLaunchOptions(['-s', 'read-only', '-a', 'never', '-m', 'gpt-6.1-sol', '-C', 'repo'], '/tmp')).toEqual({ cwd: '/tmp/repo', serverArgs: ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-c', 'model="gpt-6.1-sol"'] });
    expect(nativeLaunchOptions(['--search', '--dangerously-bypass-approvals-and-sandbox'], '/tmp').serverArgs).toContain('sandbox_mode="danger-full-access"');
    expect(() => nativeLaunchOptions(['--remote', 'ws://other'], '/tmp')).toThrow();
  });
});
