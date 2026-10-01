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
  const invoke = async (kind = 'valid', effort = 'medium') => {
    const rows: Obj[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const request = JSON.parse(String(init?.body)) as Obj;
      const answers: Obj = { control: { type: 'choice', choice: 'task_clear', confidence: 1, probabilities: { task_clear: 1, explicit_lock: 0, needs_context: 0, unclear: 0 } }, action_risk: { type: 'choice', choice: 'ordinary', confidence: 1, probabilities: { ordinary: 1, consequential: 0, unclear: 0 } }, effort: { type: 'score', score: 0, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } } };
      if (kind === 'locked') (answers['control'] as Obj)['choice'] = 'explicit_lock';
      if (kind === 'invalid') (answers['effort'] as Obj)['probabilities'] = { 0: 0.4, 1: 0.4 };
      if (kind === 'failed') return new Response('', { status: 503 });
      return response({ model: kind === 'model-mismatch' ? 'wrong-model' : request['model'], answers });
    });
    const patch = await routeCodex({ model: 'gpt-6.1-sol', effort, task: 'PRIVATE_REQUEST', session: 's', prompt: 'p', catalog, config,
      env: { TYPESAFE_API_KEY: 'PRIVATE_KEY', ...(kind === 'disabled' ? { JEV_CODEX_ENABLED: '0' } : {}) }, fetchImpl: fetchImpl as typeof fetch,
      trace: { write: (phase, row) => { rows.push({ phase, written_at: '2026-09-30T01:00:00Z', ...row }); return kind === 'disk-failed' ? { ok: false, error: 'full' } : { ok: true, file: 'f' }; } } });
    return { patch, rows, fetchImpl };
  };
  it('uses the full ordered distribution, applies a supported effort, and never publishes source/key', async () => {
    const { patch, rows } = await invoke();
    expect(patch).toEqual({ effort: 'low' });
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_REQUEST|PRIVATE_KEY/);
    const view = buildOperations([...rows, { phase: 'codex_route_applied', host: 'codex', session_id: 's', prompt_id: 'p', written_at: '2026-09-30T01:00:01Z', applied: true, observed_model: 'gpt-6.1-sol', observed_effort: 'low' }], [], new Date('2026-09-30T01:00:02Z'), { trace: true, debug: false, host: 'codex' });
    expect(view.requests).toBe(1);
    expect(view.latency.measured).toBe(1);
    expect(view.features.find(f => f.id === 'router')).toMatchObject({ state: 'observed', capability: { mode: 'active' } });
    expect(view.feed.some(s => s.feature === 'router' && s.lane === 'host')).toBe(true);
    expect(view.feed.some(s => s.judgements?.length)).toBe(true);
  });
  it.each(['locked', 'invalid', 'failed', 'model-mismatch', 'disabled', 'disk-failed'])('preserves the original call on %s', async kind => {
    const r = await invoke(kind); expect(r.patch).toEqual({});
    expect(r.fetchImpl).toHaveBeenCalledTimes(['disabled', 'disk-failed'].includes(kind) ? 0 : 1);
  });
  it('preserves an unknown account model without a request', async () => {
    const fetchImpl = vi.fn();
    expect(await routeCodex({ model: 'unknown', effort: 'medium', task: 'task', session: 's', prompt: 'p', catalog, config, env: { TYPESAFE_API_KEY: 'key' }, fetchImpl })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('routes an inherited effort from the account catalog without guessing a default', async () => {
    const r = await invoke();
    const patch = await routeCodex({ model: 'gpt-6.1-sol', effort: null, task: 'task', session: 's', prompt: 'p', catalog: [{ ...catalog[0]!, defaultReasoningEffort: 'medium' }], config, env: { TYPESAFE_API_KEY: 'key' }, fetchImpl: r.fetchImpl as typeof fetch,
      trace: { write: () => ({ ok: true, file: 'f' }) } });
    expect(patch).toEqual({ effort: 'low' });
  });
  it.each(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-daybreak-blue-latest', 'account-specific-model'])('routes all catalog-supported efforts on %s without a model-name whitelist', async model => {
    const native = { ...catalog[0]!, model };
    const trace = { write: () => ({ ok: true as const, file: 'f' }) };
    for (const target of native.supportedReasoningEfforts.map(e => e.reasoningEffort)) {
      const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
        const request = JSON.parse(String(init?.body));
        expect(request.questions.effort.criteria).toHaveLength(6);
        return response({ model: request.model, answers: {
          control: { type: 'choice', choice: 'task_clear', confidence: 1, probabilities: { task_clear: 1, explicit_lock: 0, needs_context: 0, unclear: 0 } },
          action_risk: { type: 'choice', choice: 'ordinary', confidence: 1, probabilities: { ordinary: 1, consequential: 0, unclear: 0 } },
          effort: { type: 'score', probabilities: Object.fromEntries(native.supportedReasoningEfforts.map((e, i) => [i, e.reasoningEffort === target ? 1 : 0])) },
        } });
      });
      const from = target === 'low' ? 'ultra' : 'low';
      expect(await routeCodex({ model, effort: from, task: 'task', session: 's', prompt: 'p', catalog: [native], config, env: { TYPESAFE_API_KEY: 'key' }, trace, fetchImpl })).toEqual({ effort: target });
    }
  });
  it('offers only Luna-supported efforts and preserves unsupported ultra without a paid request', async () => {
    const model = 'gpt-6-luna';
    const native = { ...catalog[0]!, model, supportedReasoningEfforts: catalog[0]!.supportedReasoningEfforts.slice(0, 5) };
    const fetchImpl = vi.fn();
    expect(await routeCodex({ model, effort: 'ultra', task: 'task', session: 's', prompt: 'p', catalog: [native], config, env: { TYPESAFE_API_KEY: 'key' }, trace: { write: () => ({ ok: true, file: 'f' }) }, fetchImpl })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('allows explicit Terra model routing and rejects an incompatible model-effort pair', async () => {
    const models = { fast: 'gpt-6-luna', standard: 'gpt-5.6-terra', deep: 'gpt-6.1-sol', frontier: 'gpt-6-astra' };
    const native = Object.values(models).map(model => ({ ...catalog[0]!, model, supportedReasoningEfforts: model.endsWith('luna') ? catalog[0]!.supportedReasoningEfforts.slice(0, 5) : catalog[0]!.supportedReasoningEfforts }));
    for (const tier of [0, 1]) {
      const fetchImpl = async (_url: unknown, init: RequestInit | undefined) => {
        const request = JSON.parse(String(init?.body));
        return response({ model: request.model, answers: {
          control: { type: 'choice', choice: 'task_clear', confidence: 1, probabilities: { task_clear: 1, explicit_lock: 0, needs_context: 0, unclear: 0 } },
          action_risk: { type: 'choice', choice: 'ordinary', confidence: 1, probabilities: { ordinary: 1, consequential: 0, unclear: 0 } },
          tier: { type: 'score', probabilities: Object.fromEntries([0, 1, 2, 3].map(i => [i, i === tier ? 1 : 0])) },
          effort: { type: 'score', probabilities: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 } },
        } });
      };
      const patch = await routeCodex({ model: 'gpt-6.1-sol', effort: 'high', task: 'task', session: 's', prompt: 'p', catalog: native, config: { ...config, gate: { ...config.gate, models }, router: { ...config.router, model: true } }, env: { TYPESAFE_API_KEY: 'key' }, trace: { write: () => ({ ok: true, file: 'f' }) }, fetchImpl: fetchImpl as typeof fetch });
      expect(patch).toEqual(tier === 1 ? { model: 'gpt-5.6-terra', effort: 'ultra' } : { effort: 'ultra' });
    }
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
    expect(rows.find(r => r.prompt_id === 'unconfirmed')).toMatchObject({ applied: false, selected_effort: 'ultra', observed_effort: 'max' });
    expect(rows.find(r => r.prompt_id === 'confirmed')).toMatchObject({ applied: true, selected_effort: 'ultra', observed_host_effort: 'ultra', observed_effort: 'max', effort_resolution: 'native_ultra' });
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
