import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../../mods/router/hooks/config.ts';
import { JEV_MODEL } from '../../mods/router/hooks/client.ts';
import { createRouter, type TurnStepEvent } from '../../mods/router/hooks/router.ts';
import type { EffortEdit } from '../../src/router-selection.ts';
import { activityChecks } from '../../src/doctor-activity.js';
import { createRecorder } from '../../mods/router/hooks/recording.ts';
import { childStepContext } from '../../src/router-child-context.ts';
import { dispatchMarker } from '../../src/claude-background.js';
import { choice, deferred, drain, fakeEngine, streamNext, type SentRequest, type Responder } from './fake-engine.ts';

const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5', HAIKU = 'claude-haiku-5-5';
const OPTION: Record<string, string> = { [HAIKU]: 'mechanical', [SONNET]: 'routine', [OPUS]: 'complex' };
const reply = (req: SentRequest, target: string, effort = 'low') => ({ status: 200, text: JSON.stringify({ model: JEV_MODEL,
  answers: Object.fromEntries(Object.entries(req.questions).map(([name, q]) => [name, q.type === 'choice'
    ? choice(Object.keys(q.criteria), [name === 'capability' ? OPTION[target]! : name === 'control' ? 'task_clear' : 'ordinary', .99])
    : { type: 'score', probabilities: Object.fromEntries((q.criteria as string[]).map((text, i) => [i, text.startsWith(effort === 'high' ? 'Strong reasoning' : 'Light reasoning') ? 1 : 0])) }])) }) });
const step = (index: number, over: Partial<TurnStepEvent> = {}): TurnStepEvent => ({ agentId: 'child', turnId: 'child-turn', index, model: OPUS, effort: 'high', ...over });
/** What a step reports: the switch cost guard reads the subagent's prefix from it. */
const COUNTS = { input_tokens: 900, output_tokens: 20, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 1000 };
async function setup(options: Record<string, boolean> = {}, respond: Responder = req => reply(req, SONNET), prompt = 'Find the cause of the failing test and repair it; preserve the public API.',
  { edit = { kind: 'keep' } as EffortEdit, first: drainFirst = true } = {}) {
  const resolved = resolveConfig({ enabled: true, routeMainModel: false, routeMainEffort: false, allowFable: false, ...options });
  if (!resolved.ok) throw Error(resolved.field);
  const router = createRouter(resolved.config, undefined, true);
  const f = fakeEngine({ hostBase: '2.1.293', respond });
  f.engine.modelAliases = async () => ({ opus: OPUS, sonnet: SONNET, haiku: HAIKU });
  f.engine.childContext = async () => ({ messages: 8, coverage: 'available', tools: [{ name: 'Read', state: 'done' }] });
  f.engine.dispatchPair = async () => ({ model: OPUS, effort_edit: edit });
  const next = Object.assign(async (e: { model?: string }) => ({ agentId: 'child', model: e.model ?? OPUS }), { signal: new AbortController().signal });
  await router.agentSpawn(f.engine, { tool_use_id: 'spawn', prompt, description: 'repair test', subagentType: 'jev-gate:worker', provider: { plugin: 'jev-gate', tier: 'plugin' }, parentModel: OPUS, fork: false }, next);
  const first = streamNext<TurnStepEvent>(undefined, COUNTS);
  if (drainFirst) await drain(router.turnStep(f.engine, step(0), first.next));
  return { router, f, first };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const later = async ({ router, f }: Pick<Setup, 'router' | 'f'>, index: number, over: Partial<TurnStepEvent> = {}) => {
  const n = streamNext<TurnStepEvent>(undefined, COUNTS); await drain(router.turnStep(f.engine, step(index, over), n.next)); return n.calls;
};

describe('native worker inference routing', () => {
  it.each(['id', 'token'])('N1: passes the %s dispatch identity to Router ownership checks', async key => {
    const resolved = resolveConfig({ enabled: true, allowFable: false });
    if (!resolved.ok) throw Error(resolved.field);
    const router = createRouter(resolved.config, undefined, true), f = fakeEngine();
    const id = '12345678-1234-4234-8234-123456789abc';
    const dispatch = vi.fn(async () => ({ deny: 'Fixture ownership refusal; no child started.' }));
    f.engine.dispatchPair = dispatch;
    const next = vi.fn(Object.assign(async () => ({ agentId: 'child', model: OPUS }), { signal: new AbortController().signal }));
    await router.agentSpawn(f.engine, { tool_use_id: 'spawn', prompt: 'Repair src/rows.ts.' + dispatchMarker(id).replace(/(?:id|token)=/, `${key}=`),
      description: 'repair', subagentType: 'jev-gate:worker', provider: { plugin: 'jev-gate', tier: 'plugin' }, parentModel: OPUS, fork: false }, next);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith('spawn', '', false, 'jev-gate:worker', true, id);
    expect(next).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
  });

  it('N1: assesses a child with the real Gate dispatch marker instead of input_secret', async () => {
    const prompt = 'Repair src/rows.ts and run npm test.' + dispatchMarker('12345678-1234-4234-8234-123456789abc');
    const { f } = await setup({}, req => reply(req, OPUS), prompt);
    expect(f.sent).toHaveLength(1);
    expect(JSON.stringify(f.sent[0]!.state)).toContain(prompt.replaceAll('\n', '\\n'));
    expect(f.logs.filter(row => row.event === 'child_route')).toEqual([expect.objectContaining({ sent: true, index: 0 })]);
    expect(f.logs.some(row => row.assessment === 'input_secret')).toBe(false);
  });

  it('#392: carries a Gate B effort through every later step without asking Jev', async () => {
    const s = await setup({}, req => reply(req, HAIKU), undefined, { edit: { kind: 'set', value: 'low' } });
    expect(s.first.calls).toEqual([step(0, { effort: 'low' })]);
    expect(await later(s, 1)).toEqual([step(1, { effort: 'low' })]);
    expect(await later(s, 2, { effort: 'low' })).toEqual([step(2, { effort: 'low' })]);
    expect(s.f.sent).toHaveLength(0);
    expect(s.f.logs.filter(r => r.event === 'child_route')).toEqual([]);
  });

  it('#392: assesses a child the spawn kept once, at its first step, and carries that effort', async () => {
    let phase = 0;
    const s = await setup({}, req => reply(req, OPUS, ++phase === 1 ? 'low' : 'high'));
    expect(s.first.calls).toEqual([step(0, { effort: 'low' })]);
    expect(await later(s, 1)).toEqual([step(1, { effort: 'low' })]);
    expect(await later(s, 2, { effort: 'low' })).toEqual([step(2, { effort: 'low' })]);
    const { f } = s;
    expect(f.sent).toHaveLength(1);
    expect(f.sent.every(r => !('capability' in r.questions) && !('model' in r.questions))).toBe(true);
    expect(f.logs.filter(r => r.event === 'child_route')).toHaveLength(1);
    expect(f.logs.find(r => r.event === 'child_route')).toMatchObject({ index: 0, model_asked: false, effort_asked: true, model_not_asked: 'child_step_model_fixed', reasons: { model: 'child_step_model_fixed' } });
    expect(f.logs.filter(r => r.event === 'child_result').at(-1)).toMatchObject({ requested: OPUS, observed: OPUS, confirmation: 'confirmed', observed_effort: 'unknown' });
    expect(JSON.stringify(f.logs)).not.toContain('preserve the public API');
    expect(f.sent[0]?.state).toMatchObject({ task: { source: 'child_contract' }, execution: { scope: 'child', step_index: 0, cache: { cross_model_reuse_proven: false } } });
    // The answer is carried through the turn, so the question covers the whole contract, not the next inference.
    const asked = JSON.stringify(f.sent[0]?.questions);
    expect(asked).toContain('complete the ENTIRE requested outcome'); expect(asked).not.toContain('NEXT inference');
  });

  it.each(['failure', 'invalid', 'no_context'] as const)('keeps the whole child turn native on %s, without asking again', async mode => {
    const s = await setup({}, req => mode === 'failure' ? { status: 503, text: '{}' } : mode === 'invalid' ? { status: 200, text: '{}' } : reply(req, SONNET),
      undefined, { first: false });
    if (mode === 'no_context') s.f.engine.childContext = async () => undefined;
    await drain(s.router.turnStep(s.f.engine, step(0), s.first.next));
    expect(s.first.calls).toEqual([step(0)]);
    s.f.engine.childContext = async () => ({ messages: 9, coverage: 'available', tools: [] });
    expect(await later(s, 1)).toEqual([step(1)]);
    expect(s.f.sent).toHaveLength(mode === 'no_context' ? 0 : 1);
    expect(s.f.logs.filter(r => r.event === 'child_route')).toHaveLength(1);
  });

  it('does not send a secret-bearing child contract to Jev', async () => {
    const s = await setup({}, req => reply(req, SONNET), 'Use TYPESAFE_API_KEY=sk-private-testsecret123456789 to fix the test.');
    expect(s.first.calls).toEqual([step(0)]);
    expect(await later(s, 1)).toEqual([step(1)]);
    expect(s.f.sent).toHaveLength(0);
    expect(JSON.stringify(s.f.logs)).not.toContain('sk-private-testsecret');
  });

  it('never moves a step off the spawned model, so the subagent\'s cache is never re-read on another', async () => {
    const { router, f, first } = await setup({}, req => reply(req, HAIKU), undefined, { first: false });
    f.engine.currentContextBound = async (turnId, index) => ({ turnId, index, inputUpperBound: 20_000, compatible: true });
    await drain(router.turnStep(f.engine, step(0), first.next));
    expect(first.calls).toEqual([step(0, { effort: 'low' })]);
  });

  it('shares an assessment for simultaneous delivery of the exact same child step', async () => {
    const wait = deferred<ReturnType<typeof reply>>();
    let request: SentRequest | undefined;
    const { router, f } = await setup({}, req => { request = req; return wait.promise; }, undefined, { first: false });
    const a = streamNext<TurnStepEvent>(), b = streamNext<TurnStepEvent>();
    const pa = drain(router.turnStep(f.engine, step(0), a.next)), pb = drain(router.turnStep(f.engine, step(0), b.next));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.sent).toHaveLength(1); wait.resolve(reply(request!, HAIKU));
    await Promise.all([pa, pb]); expect(a.calls).toEqual([step(0, { effort: 'low' })]); expect(b.calls).toEqual([step(0, { effort: 'low' })]);
  });

  it.each(['model', 'effort'] as const)('preserves a %s pin independently', async dimension => {
    const { router, f, first } = await setup({}, undefined, undefined, { first: false });
    f.pins[dimension === 'model' ? 'subagentModel' : 'mainEffort'] = true;
    await drain(router.turnStep(f.engine, step(0), first.next));
    expect(first.calls[0]?.[dimension]).toBe(dimension === 'model' ? OPUS : 'high');
    if (dimension === 'model') expect(f.sent[0]?.questions).not.toHaveProperty('model');
    else expect(Object.keys(f.sent[0]?.questions ?? {}).filter(k => k.startsWith('effort_'))).toEqual([]);
  });

  it('keeps unexpected native changes and continuation turns native', async () => {
    const s = await setup();
    const changed = step(1, { model: 'claude-sonnet-5-5' });
    const n = streamNext<TurnStepEvent>(); await drain(s.router.turnStep(s.f.engine, changed, n.next)); expect(n.calls).toEqual([changed]);
    expect(s.f.sent).toHaveLength(1);
  });

  it('discards a pending decision when the exact child finishes', async () => {
    const wait = deferred<ReturnType<typeof reply>>(); let request: SentRequest | undefined;
    const { router, f } = await setup({}, req => { request = req; return wait.promise; }, undefined, { first: false });
    const n = streamNext<TurnStepEvent>(), running = drain(router.turnStep(f.engine, step(0), n.next));
    await new Promise(resolve => setTimeout(resolve, 0));
    router.turnComplete({ agentId: 'child', turnId: 'child-turn' }); wait.resolve(reply(request!, SONNET));
    await running; expect(n.calls).toEqual([step(0)]);
  });

  it('continues a timed-out step native, asks once more at the next step, then carries that answer', async () => {
    const wait = deferred<ReturnType<typeof reply>>(); let calls = 0;
    const s = await setup({}, req => ++calls === 1 ? wait.promise : reply(req, HAIKU), undefined, { first: false });
    const n = streamNext<TurnStepEvent>(undefined, COUNTS), running = drain(s.router.turnStep(s.f.engine, step(0), n.next));
    await new Promise(resolve => setTimeout(resolve, 0)); s.f.expire(); await running;
    expect(n.calls).toEqual([step(0)]);
    expect(await later(s, 1)).toEqual([step(1, { effort: 'low' })]);
    expect(await later(s, 2)).toEqual([step(2, { effort: 'low' })]);
    expect(s.f.sent).toHaveLength(2);
  });

  it('keeps the turn native after a second timeout, without a third request', async () => {
    const wait = deferred<ReturnType<typeof reply>>();
    const s = await setup({}, () => wait.promise, undefined, { first: false });
    for (const index of [0, 1]) {
      const n = streamNext<TurnStepEvent>(undefined, COUNTS), running = drain(s.router.turnStep(s.f.engine, step(index), n.next));
      await new Promise(resolve => setTimeout(resolve, 0)); s.f.expire(); await running;
      expect(n.calls).toEqual([step(index)]);
    }
    expect(await later(s, 2)).toEqual([step(2)]);
    expect(await later(s, 3)).toEqual([step(3)]);
    expect(s.f.sent).toHaveLength(2);
  });

  it('does not resend or reapply a patched inference after a native stream failure', async () => {
    const s = await setup({}, undefined, undefined, { first: false }); let calls = 0;
    const next = Object.assign(async function* (_e: TurnStepEvent) { calls++; yield 'chunk'; throw Error('provider failed'); }, { signal: new AbortController().signal });
    await expect(drain(s.router.turnStep(s.f.engine, step(0), next))).rejects.toThrow('provider failed');
    expect(calls).toBe(1);
    expect(await later(s, 1)).toEqual([step(1)]); expect(s.f.sent).toHaveLength(1);
  });

  it('reduces exact child rows to outcome metadata without copying any tool payload', () => {
    const rows = [{ role: 'assistant' as const, text: 'PRIVATE', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/private' }, text: 'SOURCE SECRET' }, { tool_use_id: 'b', tool: 'Bash' }] },
      { role: 'user' as const, text: 'OUTPUT', toolUses: [], toolResults: [{ tool_use_id: 'b', text: 'SECRET OUTPUT', isError: true }] }];
    const context = childStepContext(rows);
    expect(context.tools).toEqual([{ name: 'Read', state: 'done' }, { name: 'Bash', state: 'error' }]);
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE|SECRET|SOURCE|OUTPUT|private/);
  });
});


it('D4: real Claude child step records reach activity', async () => {
  const { router, f, first } = await setup(undefined, undefined, undefined, { first: false });
  const records: Array<Record<string, unknown>> = [];
  const recorder = createRecorder({
    paths: async () => ({ home: '/synthetic', state: '/synthetic', config: '/synthetic', trace: '/synthetic', session: 'producer-child' }),
    stat: async () => ({ isLink: false, kind: 'dir', size: 0 }), exists: async () => false, read: async () => '',
    write: async (_path, text) => { records.push(JSON.parse(text)); }, wait: () => new Promise<void>(() => undefined),
  });
  f.engine.log = recorder.log;
  await drain(router.turnStep(f.engine, step(0), first.next));
  await recorder.flush();
  const checks = activityChecks({ traces: { claude: { records, unreadable: 0 } }, now: Date.now(), installed: null, recording: true, keyPresent: true, codexOwner: null, liveness: null });
  expect(checks.find(c => c.message.startsWith('child_effect:'))?.message).toContain('1 child steps sent to Jev, 1 changed the effort');
  expect(checks.find(c => c.message.startsWith('router_applied:'))?.message).toContain('1 requests with an observed model');
});
