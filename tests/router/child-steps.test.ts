import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../mods/router/hooks/config.ts';
import { JEV_MODEL } from '../../mods/router/hooks/client.ts';
import { createRouter, type TurnStepEvent } from '../../mods/router/hooks/router.ts';
import { childStepContext } from '../../src/router-child-context.ts';
import { choice, deferred, drain, fakeEngine, streamNext, type SentRequest, type Responder } from './fake-engine.ts';

const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5', HAIKU = 'claude-haiku-5-5';
const reply = (req: SentRequest, target: string, effort = 'low') => ({ status: 200, text: JSON.stringify({ model: JEV_MODEL,
  answers: Object.fromEntries(Object.entries(req.questions).map(([name, q]) => [name, q.type === 'choice'
    ? choice(Object.keys(q.criteria), [name === 'model' ? target : name === 'control' ? 'task_clear' : 'ordinary', .99])
    : { type: 'score', probabilities: Object.fromEntries((q.criteria as string[]).map((text, i) => [i, text.startsWith(effort === 'high' ? 'Strong reasoning' : 'Light reasoning') ? 1 : 0])) }])) }) });
const step = (index: number, over: Partial<TurnStepEvent> = {}): TurnStepEvent => ({ agentId: 'child', turnId: 'child-turn', index, model: OPUS, effort: 'high', ...over });
async function setup(options: Record<string, boolean> = {}, respond: Responder = req => reply(req, SONNET), prompt = 'Find the cause of the failing test and repair it; preserve the public API.') {
  const { lean, ...switches } = options;
  const resolved = resolveConfig({ enabled: true, routeMainModel: false, routeMainEffort: false, allowFable: false, ...switches });
  if (!resolved.ok) throw Error(resolved.field);
  const router = createRouter(resolved.config, undefined, true);
  const f = fakeEngine({ hostBase: '2.1.293', respond });
  f.engine.modelAliases = async () => ({ opus: OPUS, sonnet: SONNET, haiku: HAIKU });
  f.engine.childContext = async () => ({ messages: 8, coverage: 'available', tools: [{ name: 'Read', state: 'done' }] });
  f.engine.dispatchPair = async () => ({ model: OPUS, effort_edit: { kind: 'set', value: 'high' } });
  const next = Object.assign(async (e: { model?: string }) => ({ agentId: 'child', model: e.model ?? OPUS }), { signal: new AbortController().signal });
  await router.agentSpawn(f.engine, { tool_use_id: 'spawn', prompt, description: 'repair test', subagentType: lean ? 'jev-gate:executor' : 'jev-gate:worker', provider: { plugin: 'jev-gate', tier: 'plugin' }, parentModel: OPUS, fork: false }, next);
  const first = streamNext<TurnStepEvent>();
  await drain(router.turnStep(f.engine, step(0), first.next));
  return { router, f, first };
}

describe('native worker inference routing', () => {
  it('keeps the initial Gate B batch, then reassesses each inference and observes the actual model', async () => {
    let phase = 0;
    const { router, f, first } = await setup({}, req => reply(req, ++phase === 1 ? SONNET : OPUS, phase === 1 ? 'low' : 'high'));
    expect(f.sent).toHaveLength(0);
    expect(first.calls[0]?.model).toBe(OPUS);
    const a = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, step(1), a.next));
    expect(a.calls).toEqual([step(1, { model: SONNET, effort: 'low' })]);
    const b = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, step(2, { model: SONNET, effort: 'low' }), b.next));
    expect(b.calls).toEqual([step(2)]);
    expect(f.sent).toHaveLength(2);
    expect(f.logs.filter(r => r.event === 'child_route')).toHaveLength(2);
    expect(f.logs.filter(r => r.event === 'child_result').at(-1)).toMatchObject({ requested: OPUS, observed: OPUS, confirmation: 'confirmed', observed_effort: 'unknown' });
    expect(JSON.stringify(f.logs)).not.toContain('preserve the public API');
    expect(f.sent[0]?.state).toMatchObject({ task: { source: 'child_contract' }, execution: { scope: 'child', step_index: 1, cache: { cross_model_reuse_proven: false } } });
  });

  it('offers current 1M Haiku without inventing a smaller-window bound and excludes legacy Haiku', async () => {
    const { router, f } = await setup();
    await drain(router.turnStep(f.engine, step(1), streamNext<TurnStepEvent>().next));
    expect(f.sent[0]?.questions.model?.criteria).toHaveProperty(HAIKU);
    expect(f.sent[0]?.questions.model?.criteria).not.toHaveProperty('claude-haiku-4-5-20251001');
    expect(f.logs.find(r => r.event === 'child_route')).toMatchObject({ excluded: { legacy_model: expect.any(Number) } });
  });

  it('sends current Haiku with its selected supported effort', async () => {
    const { router, f } = await setup({}, req => reply(req, HAIKU));
    f.engine.currentContextBound = async (turnId, index) => ({ turnId, index, inputUpperBound: 20_000, compatible: true });
    const n = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, step(1), n.next));
    expect(n.calls).toEqual([{ agentId: 'child', turnId: 'child-turn', index: 1, model: HAIKU, effort: 'low' }]);
  });

  it.each(['failure', 'invalid', 'no_context'] as const)('keeps native on %s and reassesses a later step', async mode => {
    const { router, f } = await setup({}, req => mode === 'failure' ? { status: 503, text: '{}' } : mode === 'invalid' ? { status: 200, text: '{}' } : reply(req, SONNET));
    if (mode === 'no_context') f.engine.childContext = async () => undefined;
    const n = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, step(1), n.next));
    expect(n.calls).toEqual([step(1)]);
    f.engine.childContext = async () => ({ messages: 9, coverage: 'available', tools: [] });
    await drain(router.turnStep(f.engine, step(2), streamNext<TurnStepEvent>().next));
    expect(f.logs.filter(r => r.event === 'child_route')).toHaveLength(2);
  });

  it('does not send a secret-bearing child contract to Jev', async () => {
    const { router, f } = await setup({}, req => reply(req, SONNET), 'Use TYPESAFE_API_KEY=sk-private-testsecret123456789 to fix the test.');
    const n = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, step(1), n.next));
    expect(f.sent).toHaveLength(0); expect(n.calls).toEqual([step(1)]);
    expect(JSON.stringify(f.logs)).not.toContain('sk-private-testsecret');
  });

  it('shares an assessment for simultaneous delivery of the exact same child step', async () => {
    const wait = deferred<ReturnType<typeof reply>>();
    let request: SentRequest | undefined;
    const { router, f } = await setup({}, req => { request = req; return wait.promise; });
    const a = streamNext<TurnStepEvent>(), b = streamNext<TurnStepEvent>();
    const pa = drain(router.turnStep(f.engine, step(1), a.next)), pb = drain(router.turnStep(f.engine, step(1), b.next));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.sent).toHaveLength(1); wait.resolve(reply(request!, SONNET));
    await Promise.all([pa, pb]); expect(a.calls[0]?.model).toBe(SONNET); expect(b.calls[0]?.model).toBe(SONNET);
  });

  it.each(['model', 'effort'] as const)('preserves a %s pin independently', async dimension => {
    const { router, f } = await setup();
    f.pins[dimension === 'model' ? 'subagentModel' : 'mainEffort'] = true;
    const n = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, step(1), n.next));
    expect(n.calls[0]?.[dimension]).toBe(dimension === 'model' ? OPUS : 'high');
    if (dimension === 'model') expect(f.sent[0]?.questions).not.toHaveProperty('model');
    else expect(Object.keys(f.sent[0]?.questions ?? {}).filter(k => k.startsWith('effort_'))).toEqual([]);
  });

  it('keeps unexpected native changes and continuation turns native', async () => {
    const { router, f } = await setup();
    const n = streamNext<TurnStepEvent>(); const changed = step(1, { model: 'claude-sonnet-5-5' });
    await drain(router.turnStep(f.engine, changed, n.next)); expect(n.calls).toEqual([changed]); expect(f.sent).toHaveLength(0);
  });

  it('does not assess Lean executor steps', async () => {
    const { router, f } = await setup({ lean: true });
    await drain(router.turnStep(f.engine, step(1), streamNext<TurnStepEvent>().next));
    expect(f.sent).toHaveLength(0);
  });

  it('discards a pending decision when the exact child finishes', async () => {
    const wait = deferred<ReturnType<typeof reply>>(); let request: SentRequest | undefined;
    const { router, f } = await setup({}, req => { request = req; return wait.promise; });
    const n = streamNext<TurnStepEvent>(), running = drain(router.turnStep(f.engine, step(1), n.next));
    await new Promise(resolve => setTimeout(resolve, 0));
    router.turnComplete({ agentId: 'child', turnId: 'child-turn' }); wait.resolve(reply(request!, SONNET));
    await running; expect(n.calls).toEqual([step(1)]);
  });

  it('continues the timed-out request once and assesses the next inference again', async () => {
    const wait = deferred<ReturnType<typeof reply>>(); let calls = 0;
    const { router, f } = await setup({}, req => ++calls === 1 ? wait.promise : reply(req, SONNET));
    const n = streamNext<TurnStepEvent>(), running = drain(router.turnStep(f.engine, step(1), n.next));
    await new Promise(resolve => setTimeout(resolve, 0)); f.expire(); await running;
    expect(n.calls).toEqual([step(1)]);
    const later = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, step(2), later.next));
    expect(f.sent).toHaveLength(2); expect(later.calls[0]?.model).toBe(SONNET);
  });

  it('does not resend or reapply a patched inference after a native stream failure', async () => {
    const { router, f } = await setup(); let calls = 0;
    const next = Object.assign(async function* (_e: TurnStepEvent) { calls++; yield 'chunk'; throw Error('provider failed'); }, { signal: new AbortController().signal });
    await expect(drain(router.turnStep(f.engine, step(1), next))).rejects.toThrow('provider failed');
    expect(calls).toBe(1);
    const later = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, step(2), later.next));
    expect(later.calls).toEqual([step(2)]); expect(f.sent).toHaveLength(1);
  });

  it('reduces exact child rows to outcome metadata without copying any tool payload', () => {
    const rows = [{ role: 'assistant' as const, text: 'PRIVATE', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/private' }, text: 'SOURCE SECRET' }, { tool_use_id: 'b', tool: 'Bash' }] },
      { role: 'user' as const, text: 'OUTPUT', toolUses: [], toolResults: [{ tool_use_id: 'b', text: 'SECRET OUTPUT', isError: true }] }];
    const context = childStepContext(rows);
    expect(context.tools).toEqual([{ name: 'Read', state: 'done' }, { name: 'Bash', state: 'error' }]);
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE|SECRET|SOURCE|OUTPUT|private/);
  });
});
