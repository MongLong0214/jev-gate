import { PassThrough } from 'node:stream';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { codexObservation, type Obj } from '../../src/codex/source.js';
import { catalogTierModels, loadCodexPolicy, runtimeCodexPolicy } from '../../src/codex/config.js';
import { codexCandidates, routeCodex, type CodexModel } from '../../src/codex/router.js';
import { codexSuccessor } from '../../src/codex/catalog.js';
import { CodexRpc } from '../../src/codex/rpc.js';
import { CodexPolicy } from '../../src/codex/policy.js';
import { readJob } from '../../src/job.js';
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
    expect(p.gate).toMatchObject({ models, delegationDepthFloor: 0 });
    expect(p.gate).not.toHaveProperty('maxParallelWorkers');
    expect(p.router.model).toBe(true);
    const serial = join(tmp, 'serial-policy.json'); writeFileSync(serial, JSON.stringify({ gate: { maxParallelWorkers: 1, guardAllowTools: [], workerIsolation: 'worktree' } }));
    // #289: a deployed file that still sets the removed keys loads, and they are dropped unread.
    const old = loadCodexPolicy({ JEV_CODEX_CONFIG: serial }).gate;
    expect(old).not.toHaveProperty('guardAllowTools'); expect(old.workerIsolation).toBe('worktree');
    const override = join(tmp, 'explicit-models.json'); writeFileSync(override, JSON.stringify({ gate: { models: { fast: 'owner-model' } } }));
    expect(loadCodexPolicy({ JEV_CODEX_CONFIG: override, JEV_CODEX_MODEL: 'account-workhorse' }, available).gate.models).toEqual({ ...models, fast: 'owner-model' });
  });
  it('turns off only the Gate for a mode it no longer knows, from the policy file or JEV_GATE_MODE, and keeps the Router', () => {
    const old = join(tmp, 'old-mode-policy.json'); writeFileSync(old, JSON.stringify({ gate: { mode: 'lean' }, router: { allowAstra: true }, compact: { budgetChars: 9000 } }));
    const fromFile = runtimeCodexPolicy({ JEV_CODEX_CONFIG: old });
    expect(fromFile.gate.mode).toBe('off');
    expect(fromFile.router).toMatchObject({ enabled: true, model: true, effort: true });
    // Legacy budget keys are ignored; current selection defaults remain available.
    expect(fromFile.compact).toEqual({ enabled: true, timeoutMs: 800 });
    const fromEnv = runtimeCodexPolicy({ JEV_CODEX_CONFIG: join(tmp, 'policy.json'), JEV_GATE_MODE: 'lean' });
    expect(fromEnv.gate.mode).toBe('off');
    expect(fromEnv.router.enabled).toBe(true);
    // Doctor still reports the value, and a different invalid section still disables every dispatch.
    expect(() => loadCodexPolicy({ JEV_CODEX_CONFIG: old })).toThrow('invalid Codex gate config');
    const broken = join(tmp, 'broken-section.json'); writeFileSync(broken, JSON.stringify({ router: { enabled: 'yes' } }));
    expect(runtimeCodexPolicy({ JEV_CODEX_CONFIG: broken })).toMatchObject({ gate: { mode: 'off' }, router: { enabled: false } });
    // JEV_CODEX_OUTPUT belonged to the removed Codex Output fold; nothing reads it.
    expect(runtimeCodexPolicy({ JEV_CODEX_CONFIG: join(tmp, 'policy.json'), JEV_CODEX_OUTPUT: 'off' })).toEqual(runtimeCodexPolicy({ JEV_CODEX_CONFIG: join(tmp, 'policy.json') }));
  });
  const answersFor = (request: Obj, model = '__keep__', effort = 'low', control = 'task_clear'): Obj => {
    const questions = request['questions'] as Record<string, { type: string; criteria: Record<string, string> | string[] }>;
    return Object.fromEntries(Object.entries(questions).map(([name, q]) => {
      if (q.type === 'choice') {
        const pick = name === 'control' ? control : name === 'model' || name === 'capability' ? model : 'ordinary';
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
    const view = buildOperations([...rows, { phase: 'codex_route_applied', host: 'codex', session_id: 's', prompt_id: 'p', written_at: '2026-09-30T01:00:01Z', applied: true, selected_model: 'gpt-6.1-sol', submitted_model: 'gpt-6.1-sol', submitted_effort: 'low' }], [], new Date('2026-09-30T01:00:02Z'), { trace: true, host: 'codex' });
    expect(view.requests).toBe(1); expect(view.latency.measured).toBe(1);
    expect(view.feed.find(s => s.lane === 'host')?.model?.status).toBe('unobserved');
    expect(view.feed.some(s => s.judgements?.length)).toBe(true);
  });
  it('judges effort for the actual conditional model without turning model guidance into a floor', async () => {
    const account = [
      { ...catalog[0]!, description: 'Latest workhorse model for coding and everyday work.', defaultReasoningEffort: 'low' },
      { ...catalog[0]!, model: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.', defaultReasoningEffort: 'medium' },
    ];
    let sent: Obj | undefined;
    const fetchImpl = vi.fn(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return response({ model: sent!['model'], answers: answersFor(sent!, 'mechanical', 'low') });
    });
    const patch = await routeCodex({ model: 'gpt-6.1-sol', effort: 'xhigh', task: 'Return the number 1.', session: 's', prompt: 'p',
      catalog: account, config, billing: 'chatgpt', env: { TYPESAFE_API_KEY: 'fake-key' }, fetchImpl });
    expect(patch).toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
    const questions = Object.values(sent!['questions'] as Record<string, { type: string; instructions: string; criteria: string[] }>).filter(q => q.type === 'score');
    const luna = questions.find(q => q.instructions.includes('actual account candidate gpt-6-luna'))!;
    const sol = questions.find(q => q.instructions.includes('actual account candidate gpt-6.1-sol'))!;
    expect(luna.instructions).toContain('account-listed default effort is medium');
    expect(luna.instructions).toContain('starts explicit GPT-6 Luna settings at high');
    expect(sol.instructions).toContain('account-listed default effort is low');
    expect(sol.instructions).not.toContain('starts explicit GPT-6 Luna');
    expect(luna.criteria.find(v => v.startsWith('Strong'))).toContain('coordinates discovery');
    expect(sol.criteria.find(v => v.startsWith('Strong'))).not.toContain('coordinates discovery');
    for (const q of questions) expect(q.instructions).toContain('not a floor or pin');
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
  it.each(['Fixture-E', 'Fixture-F'])('selects %s outside four role preferences, including an unknown baseline, and holds the unpriced switch', async target => {
    const native = ['Fixture-A', 'Fixture-B', 'Fixture-C', 'Fixture-D', 'Fixture-E', 'Fixture-F'].map(model => ({ model, description: 'General coding model', supportedReasoningEfforts: ['low', 'high', 'max'].map(reasoningEffort => ({ reasoningEffort })) }));
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => { const req = JSON.parse(String(init?.body)); expect(Object.keys(req.questions.model.criteria)).toContain(target); return response({ model: req.model, answers: answersFor(req, target, 'max') }); });
    const rows: Obj[] = [];
    // No published price for either side: the switch's cost is unknown, so the model stays, with the effort it had (an unlisted model's levels are unknown).
    expect(await routeCodex({ model: 'outside-role-mapping', effort: 'high', task: 'task', session: 's', prompt: 'p', catalog: native, config, env: { TYPESAFE_API_KEY: 'key' }, fetchImpl,
      trace: { write: (phase, row) => { rows.push({ phase, ...row }); return { ok: true, file: 'f' }; } } })).toEqual({});
    expect(rows.at(-1)).toMatchObject({ answers: { model: { choice: target } }, cost: { basis: 'unknown', actual_bill: 'unknown', hold: true }, cost_reason: 'cost_unknown_hold', reasons: { model: 'cost_unknown_hold' } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  // Descriptions as this account's catalog lists them (~/.codex/models_cache.json, 2026-10-15).
  const levels = (n = 6) => ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].slice(0, n).map(reasoningEffort => ({ reasoningEffort }));
  const account: CodexModel[] = [
    { model: 'gpt-6.1-sol', description: 'Latest workhorse model for coding and everyday work.', supportedReasoningEfforts: levels() },
    { model: 'gpt-6-astra', description: 'Frontier intelligence for the most demanding work.', supportedReasoningEfforts: levels() },
    { model: 'gpt-6-sol', description: 'Previous generation workhorse model.', supportedReasoningEfforts: levels() },
    { model: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.', supportedReasoningEfforts: levels(5) },
    { model: 'gpt-5.6-sol', description: 'Older generation workhorse model.', supportedReasoningEfforts: levels() },
    { model: 'gpt-5.6-terra', description: 'Older balanced model for straightforward work.', supportedReasoningEfforts: levels() },
    { model: 'gpt-5.6-luna', description: 'Older fast and efficient model.', supportedReasoningEfforts: levels(5) },
    { model: 'gpt-daybreak-blue-latest', description: 'Latest frontier agentic coding model for broad defensive cybersecurity work.', supportedReasoningEfforts: levels() },
    { model: 'codex-auto-review', description: 'Automatic approval review model for Codex.', hidden: true, supportedReasoningEfforts: levels(5) },
  ];
  // The same IDs without any older/previous wording, so only the version rule can find a successor.
  const plain = account.map(m => ({ ...m, description: 'Coding model.' }));
  it('finds the newest general successor by family and numeric version, and never for an ID outside the grammar', () => {
    expect(codexSuccessor('gpt-6-sol', plain)).toBe('gpt-6.1-sol');
    expect(codexSuccessor('gpt-5.6-sol', plain)).toBe('gpt-6.1-sol');
    expect(codexSuccessor('gpt-5.6-luna', plain)).toBe('gpt-6-luna');
    for (const id of ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-daybreak-blue-latest', 'codex-auto-review', 'gpt-6-sol-2026-10-01', 'GPT-5-sol']) expect(codexSuccessor(id, plain)).toBeNull();
    const versions = ['gpt-6.9-sol', 'gpt-6.10-sol', 'gpt-7-sol-latest', 'gpt-6-sol-mini'].map(model => ({ model, description: 'Coding model.', supportedReasoningEfforts: levels() }));
    expect(codexSuccessor('gpt-6.9-sol', versions)).toBe('gpt-6.10-sol');
    expect(codexSuccessor('gpt-6.10-sol', versions)).toBeNull();
    expect(codexSuccessor('gpt-6.1-sol', [...plain, { ...plain[0]!, model: 'gpt-7-sol', hidden: true }])).toBeNull();
  });
  it('never offers or picks a superseded model, and counts it as excluded', async () => {
    expect(codexCandidates(plain, true).map(c => c.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-daybreak-blue-latest']);
    // Superseded models listed first with current wording, so only the version rule keeps them out of the tiers.
    const listedFirst = [{ ...account[2]!, description: account[0]!.description! }, { ...account[6]!, description: account[3]!.description! }, ...account];
    expect(catalogTierModels('gpt-6-sol', listedFirst)).toEqual({ fast: 'gpt-6-luna', standard: 'gpt-6.1-sol', deep: 'gpt-6.1-sol', frontier: 'gpt-6-astra' });
    const rows: Obj[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => { const req = JSON.parse(String(init?.body)); return response({ model: req.model, answers: answersFor(req, 'mechanical') }); });
    // An unobserved thread's prefix is unknown, and Luna's write (0.125/M) exceeds Sol's read (0.1/M) at any size: the picked downgrade is held.
    expect(await routeCodex({ model: 'gpt-6.1-sol', effort: 'medium', task: 'Rename a symbol.', session: 's', prompt: 'p', catalog: account, config, env: { TYPESAFE_API_KEY: 'key' }, fetchImpl, trace: { write: (phase, row) => { rows.push({ phase, ...row }); return { ok: true, file: 'f' }; } } })).toEqual({ effort: 'low', effortEdit: { kind: 'set', value: 'low' } });
    expect(rows.at(-1)).toMatchObject({ excluded: { superseded: 3 }, selection: { roles: [{ option: 'mechanical', model: 'gpt-6-luna' }, { option: 'routine', model: 'gpt-6-luna' }, { option: 'complex', model: 'gpt-6.1-sol' }] }, cost_reason: 'cost_unknown_hold', reasons: { model: 'cost_unknown_hold' } });
  });
  const superseded = async (model: string, kind: string, extra: Partial<Parameters<typeof routeCodex>[0]> = {}) => {
    const rows: Obj[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (kind === 'failed') return new Response('', { status: 503 });
      const req = JSON.parse(String(init?.body)); return response({ model: req.model, answers: answersFor(req, kind) });
    });
    const patch = await routeCodex({ model, effort: 'medium', task: 'Fix the cache bug.', session: 's', prompt: 'p', catalog: account, config, env: kind === 'key_missing' ? {} : { TYPESAFE_API_KEY: 'key' }, fetchImpl,
      trace: { write: (phase, row) => { rows.push({ phase, ...row }); return { ok: true, file: 'f' }; } }, ...extra });
    return { patch, rows, fetchImpl };
  };
  it.each([[undefined], [{ agentId: 'worker', step: 1, context: {} }]])('moves a superseded baseline to its successor with or without a Jev answer (child %o)', async child => {
    const extra = child ? { child } : {};
    const kept = await superseded('gpt-6-sol', 'complex', extra);
    expect(kept.patch).toEqual({ model: 'gpt-6.1-sol', effort: 'low', effortEdit: { kind: 'set', value: 'low' } });
    expect(kept.rows.at(-1)).toMatchObject({ scope: child ? 'child' : 'root', baseline_model: 'gpt-6-sol', superseded_baseline: { from: 'gpt-6-sol', to: 'gpt-6.1-sol' }, reasons: { model: 'superseded_baseline' } });
    // A held downgrade still leaves the superseded baseline for its successor.
    const held = await superseded('gpt-6-sol', 'mechanical', extra);
    expect(held.patch).toMatchObject({ model: 'gpt-6.1-sol' }); expect(held.rows.at(-1)).toMatchObject({ cost_reason: 'cost_unknown_hold' });
    expect((await superseded('gpt-5.6-sol', 'failed', extra)).patch).toEqual({ model: 'gpt-6.1-sol' });
    const missing = await superseded('gpt-6-sol', 'key_missing', extra);
    expect(missing.patch).toEqual({ model: 'gpt-6.1-sol' }); expect(missing.fetchImpl).not.toHaveBeenCalled();
    expect(missing.rows).toEqual([expect.objectContaining({ phase: 'codex_router_skipped', reason: 'key_missing', superseded_baseline: { from: 'gpt-6-sol', to: 'gpt-6.1-sol' } })]);
  });
  it('keeps a superseded baseline whose successor is not an allowed target for the same effort', async () => {
    const astra = [...account, { ...account[1]!, model: 'gpt-5.6-astra' }];
    expect((await superseded('gpt-5.6-astra', 'key_missing', { catalog: astra })).patch).toEqual({});
    expect((await superseded('gpt-5.6-astra', 'key_missing', { catalog: astra, config: { ...config, router: { ...config.router, allowAstra: true } } })).patch).toEqual({ model: 'gpt-6-astra' });
    expect((await superseded('gpt-5.6-luna', 'key_missing', { effort: 'ultra', catalog: account.map(m => m.model === 'gpt-5.6-luna' ? { ...m, supportedReasoningEfforts: levels() } : m) })).patch).toEqual({});
    expect((await superseded('gpt-5.6-terra', 'key_missing')).patch).toEqual({});
    expect((await superseded('gpt-6-sol', 'key_missing', { modelPinned: true })).patch).toEqual({});
    // A pinned model is kept exactly, superseded or not; a run pinning both is never assessed.
    const pinned = await superseded('gpt-6-sol', 'complex', { modelPinned: true, effortPinned: true });
    expect(pinned.patch).toEqual({}); expect(pinned.fetchImpl).not.toHaveBeenCalled();
    expect(pinned.rows).toEqual([expect.objectContaining({ phase: 'codex_router_skipped', reason: 'pinned' })]);
    expect(pinned.rows[0]).not.toHaveProperty('superseded_baseline');
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
describe('native check evidence', () => {
  it('never treats a reported pass or a successful shell wrapper with extra commands as observed pass', () => {
    const commands = new Map([['c1', 'vitest run'], ['c2', 'vitest run']]);
    const observation = codexObservation([{ id: 'c1', type: 'commandExecution', command: "/bin/zsh -c 'vitest run'", status: 'failed', exitCode: 1 }, { id: 'w', type: 'fileChange', status: 'inProgress' }, { id: 'c2', type: 'commandExecution', command: "/bin/zsh -c 'vitest run; true'", status: 'completed', exitCode: 0 }], false, commands);
    expect(observation).toMatchObject({ truncated: true, openWrite: true, lastWrite: 1, runs: [{ command: 'vitest run', status: 'failed' }, { command: "/bin/zsh -c 'vitest run; true'", status: 'passed' }] });
  });
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
  it('keeps a native needs_context follow-up direct after one call without carrying earlier requests', async () => {
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
    expect(await policy.nativeHook({hook_event_name:'UserPromptSubmit',session_id:'followup',prompt:'Run it now.'})).toEqual({});
    expect(seen).toEqual(['Implement the download validation and run its full checks.', 'Run it now.']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const job = readJob({JEV_GATE_STATE_DIR:join(env.JEV_GATE_STATE_DIR,'codex')},'followup');
    expect(job.ok && job.value?.current).toMatchObject({ shape: 'direct', request: null });
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
