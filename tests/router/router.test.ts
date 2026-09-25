import { describe, expect, it, vi } from 'vitest';

import type { HttpReply } from '../../mods/router/hooks/client.ts';
import { JEV_ENDPOINT, JEV_MODEL } from '../../mods/router/hooks/client.ts';
import { resolveConfig } from '../../mods/router/hooks/config.ts';
import type { SpawnEvent, SpawnOutcome, TurnStepEvent } from '../../mods/router/hooks/router.ts';
import { createRouter, VERIFIED_HOST } from '../../mods/router/hooks/router.ts';
import { answering, CLEAR, deferred, drain, FAKE_KEY, fakeEngine, streamNext } from './fake-engine.ts';

const configOf = (options: Record<string, string | number | boolean>) => {
  const r = resolveConfig({ enabled: true, ...options });
  if (!r.ok) throw new Error(`invalid option ${r.field}`);
  return r.config;
};

const EFFORT_ONLY = { routeMainEffort: true, routeMainModel: false, routeSubagentModel: false };
const FULL_IDS = { fastModel: 'claude-haiku-4-5', standardModel: 'claude-sonnet-5', deepModel: 'claude-opus-5-5', frontierModel: 'claude-fable-5-1' };
const MODEL_ONLY = { routeMainEffort: false, routeMainModel: true, routeSubagentModel: false, ...FULL_IDS };
const SPAWN_ONLY = { routeMainEffort: false, routeMainModel: false, routeSubagentModel: true };
/** Root switches these tests declare verified, to reach the root-model path; the shipped list is empty. */
const SWITCHES = ([
  ['claude-sonnet-5', 'claude-opus-5-5'],
  ['claude-opus-5-5', 'claude-sonnet-5'],
  ['claude-sonnet-5', 'claude-fable-5-1'],
  ['claude-sonnet-5', 'claude-haiku-4-5'],
] as const).map(([from, to]) => ({ from, to }));

const TEXT = 'Rename the helper parseRow to parseRecord in src/rows.ts and update its two callers.';
const step = (over: Partial<TurnStepEvent> = {}): TurnStepEvent => ({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', ...over });

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('root effort', () => {
  it('applies a confident, ordinary downgrade to the first step and every later step of the turn, with one request', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });

    const first = streamNext<TurnStepEvent>();
    const { chunks } = await drain(router.turnStep(f.engine, step(), first.next));
    expect(chunks).toEqual(['chunk']);
    expect(first.calls).toEqual([{ ...step(), effort: 'low' }]);

    const second = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ index: 1 }), second.next));
    expect(second.calls).toEqual([{ ...step({ index: 1 }), effort: 'low' }]);

    expect(f.sent).toHaveLength(1);
    const [req] = f.sent;
    expect(req?.url).toBe(JEV_ENDPOINT);
    expect(req?.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);
    expect(req?.state).toEqual({ task: { text: TEXT } });
    expect(Object.keys(req?.questions ?? {})).toEqual(['control', 'effort', 'action_risk']);
    // Offered levels are the model's unconditional ones, never max.
    expect(Object.keys(req?.questions['effort']?.criteria ?? {})).toEqual(['low', 'medium', 'high', 'xhigh', 'preserve']);

    const root = f.logs.find((l) => l['event'] === 'root');
    expect(root).toMatchObject({ assessment: 'ok', sent: true, patch: { effort: 'low' }, reasons: { effort: 'applied', model: 'not_asked' } });
    expect(JSON.stringify(f.logs)).not.toContain('parseRow');
    expect(JSON.stringify(f.logs)).not.toContain(FAKE_KEY);
  });

  it('keeps effort when the request would operate a live system, and upgrades on the lower floor', async () => {
    const down = createRouter(configOf(EFFORT_ONLY));
    const f1 = fakeEngine({ respond: answering({ control: ['task_clear', 0.97], action_risk: ['consequential', 0.97], effort: ['low', 0.95] }) });
    down.turnStart({ turnId: 't1', text: TEXT });
    const n1 = streamNext<TurnStepEvent>();
    await drain(down.turnStep(f1.engine, step(), n1.next));
    expect(n1.calls).toEqual([step()]);
    expect(f1.logs.find((l) => l['event'] === 'root')).toMatchObject({ reasons: { effort: 'risk_blocks_downgrade' } });

    const up = createRouter(configOf(EFFORT_ONLY));
    const f2 = fakeEngine({ respond: answering({ control: ['task_clear', 0.85], action_risk: ['unclear', 0.5], effort: ['xhigh', 0.85] }) });
    up.turnStart({ turnId: 't1', text: TEXT });
    const n2 = streamNext<TurnStepEvent>();
    await drain(up.turnStep(f2.engine, step({ effort: 'medium' }), n2.next));
    expect(n2.calls).toEqual([step({ effort: 'xhigh' })]);
  });

  it('stops for the rest of the turn when a step arrives with parameters other than the baseline', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step(), streamNext<TurnStepEvent>().next));

    const changed = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ index: 1, effort: 'medium' }), changed.next));
    expect(changed.calls).toEqual([step({ index: 1, effort: 'medium' })]);
    const back = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ index: 2 }), back.next));
    expect(back.calls).toEqual([step({ index: 2 })]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root_stop', reason: 'incoming_divergence' }));
  });

  it('asks nothing when effort cannot change: pinned, numeric, absent, or a model that takes none', async () => {
    const cases: Array<[TurnStepEvent, Partial<{ mainEffort: boolean }>]> = [
      [step(), { mainEffort: true }],
      [step({ effort: 12_000 }), {}],
      [{ turnId: 't1', index: 0, model: 'claude-opus-5-5' }, {}],
      [step({ model: 'claude-haiku-4-5-20251001' }), {}],
      [step({ model: 'claude-unknown-9' }), {}],
    ];
    for (const [e, pins] of cases) {
      const router = createRouter(configOf(EFFORT_ONLY));
      const f = fakeEngine({ pins, respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
      router.turnStart({ turnId: 't1', text: TEXT });
      const n = streamNext<TurnStepEvent>();
      await drain(router.turnStep(f.engine, e, n.next));
      expect(n.calls).toEqual([e]);
      expect(f.sent).toHaveLength(0);
    }
  });

  it('never routes a child step, a step that is not the first, or a turn with no text', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    for (const e of [step({ agentId: 'a1' }), step({ turnId: 't2', index: 3 }), step({ turnId: 't3' })]) {
      const n = streamNext<TurnStepEvent>();
      await drain(router.turnStep(f.engine, e, n.next));
      expect(n.calls).toEqual([e]);
    }
    expect(f.sent).toHaveLength(0);
  });

  it('sends nothing without a key, or for text that looks like a credential', async () => {
    const noKey = createRouter(configOf(EFFORT_ONLY));
    const f1 = fakeEngine({ envKey: undefined, respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    noKey.turnStart({ turnId: 't1', text: TEXT });
    const n1 = streamNext<TurnStepEvent>();
    await drain(noKey.turnStep(f1.engine, step(), n1.next));
    expect(n1.calls).toEqual([step()]);
    expect(f1.logs).toContainEqual(expect.objectContaining({ event: 'root', skipped: 'key_missing' }));

    const secret = createRouter(configOf(EFFORT_ONLY));
    const f2 = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    secret.turnStart({ turnId: 't1', text: `Use token sk-${'a'.repeat(24)}testonlynotakey for the call` });
    const n2 = streamNext<TurnStepEvent>();
    await drain(secret.turnStep(f2.engine, step(), n2.next));
    expect(n2.calls).toEqual([step()]);
    expect(f2.sent).toHaveLength(0);
    expect(f2.logs).toContainEqual(expect.objectContaining({ assessment: 'input_secret', sent: false }));
  });

  it('runs natively on timeout, and a late reply changes nothing', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const reply = deferred<HttpReply>();
    const f = fakeEngine({ respond: () => reply.promise });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    const run = drain(router.turnStep(f.engine, step(), n.next));
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.expire();
    await run;
    expect(n.calls).toEqual([step()]);

    reply.resolve(answering({ ...CLEAR, effort: ['low', 0.95] })(f.sent[0]!) as HttpReply);
    await settle();
    const later = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ index: 1 }), later.next));
    expect(later.calls).toEqual([step({ index: 1 })]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', assessment: 'timeout', sent: true }));
    // What the late reply cost is still recorded, against the turn that asked.
    expect(f.logs).toContainEqual({ event: 'late', scope: 'root', turn: 't1', usage: { input_tokens: 900, output_tokens: 40 } });
  });

  it('stops asking for the rest of the activation after a 401, including one that arrives late', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: () => ({ status: 401, text: '{}' }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step(), streamNext<TurnStepEvent>().next));
    router.turnStart({ turnId: 't2', text: TEXT });
    await drain(router.turnStep(f.engine, step({ turnId: 't2' }), streamNext<TurnStepEvent>().next));
    expect(f.sent).toHaveLength(1);
    expect(f.logs).toContainEqual(expect.objectContaining({ turn: 't2', assessment: 'credential_refused', sent: false }));

    const lateRouter = createRouter(configOf(EFFORT_ONLY));
    const reply = deferred<HttpReply>();
    const g = fakeEngine({ respond: () => reply.promise });
    lateRouter.turnStart({ turnId: 't1', text: TEXT });
    const run = drain(lateRouter.turnStep(g.engine, step(), streamNext<TurnStepEvent>().next));
    await vi.waitFor(() => expect(g.sent).toHaveLength(1));
    g.expire();
    await run;
    reply.resolve({ status: 402, text: '{}' });
    await settle();
    lateRouter.turnStart({ turnId: 't2', text: TEXT });
    await drain(lateRouter.turnStep(g.engine, step({ turnId: 't2' }), streamNext<TurnStepEvent>().next));
    expect(g.sent).toHaveLength(1);
  });

  it('does not call next once its dispatch was abandoned', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const reply = deferred<HttpReply>();
    const f = fakeEngine({ respond: () => reply.promise });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    const run = drain(router.turnStep(f.engine, step(), n.next));
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    n.controller.abort();
    const { chunks, result } = await run;
    expect(chunks).toEqual([]);
    expect(result).toBeUndefined();
    expect(n.calls).toHaveLength(0);
  });

  it('keeps the rest of the turn native once its first step went ahead without the hook', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const reply = deferred<HttpReply>();
    const f = fakeEngine({ respond: () => reply.promise });
    router.turnStart({ turnId: 't1', text: TEXT });
    const first = streamNext<TurnStepEvent>();
    const run = drain(router.turnStep(f.engine, step(), first.next));
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    first.controller.abort();
    await run;
    // The answer arrives after the host already ran step 0 natively: step 1 must not switch away from it.
    reply.resolve(answering({ ...CLEAR, effort: ['low', 0.95] })(f.sent[0]!) as HttpReply);
    await settle();
    const second = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ index: 1 }), second.next));
    expect(second.calls).toEqual([step({ index: 1 })]);
    expect(f.logs).toContainEqual({ event: 'root_stop', turn: 't1', index: 0, reason: 'step_abandoned' });
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'late', scope: 'root', turn: 't1' }));
  });

  it('honours a pin set after the decision, from the next step on', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const first = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step(), first.next));
    expect(first.calls[0]?.effort).toBe('low');
    f.pins.mainEffort = true;
    const second = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ index: 1 }), second.next));
    expect(second.calls).toEqual([step({ index: 1 })]);
    expect(f.logs).toContainEqual({ event: 'root_stop', turn: 't1', index: 1, reason: 'effort_pinned' });

    // Set while the assessment is in flight: the first step already runs natively.
    const during = createRouter(configOf(EFFORT_ONLY));
    const g = fakeEngine({
      respond: (req) => {
        g.pins.mainEffort = true;
        return answering({ ...CLEAR, effort: ['low', 0.95] })(req);
      },
    });
    during.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(during.turnStep(g.engine, step(), n.next));
    expect(n.calls).toEqual([step()]);
    expect(g.logs).toContainEqual({ event: 'root_stop', turn: 't1', index: 0, reason: 'effort_pinned' });
  });

  it('stops an effort-only override when a fallback model answers that cannot take it, or no model is reported', async () => {
    for (const observed of ['claude-sonnet-5', null]) {
      const router = createRouter(configOf(EFFORT_ONLY));
      const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['xhigh', 0.95] }) });
      router.turnStart({ turnId: 't1', text: TEXT });
      const first = streamNext<TurnStepEvent>(() => observed);
      await drain(router.turnStep(f.engine, step(), first.next));
      expect(first.calls[0]?.effort).toBe('xhigh');
      const second = streamNext<TurnStepEvent>();
      await drain(router.turnStep(f.engine, step({ index: 1 }), second.next));
      expect(second.calls, String(observed)).toEqual([step({ index: 1 })]);
      expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root_stop', reason: observed === null ? 'model_unobserved' : 'model_mismatch', requested: 'claude-opus-5-5' }));
    }
  });

  it('keeps an effort the answering model takes, and reads an unsuffixed answer as the requested variant', async () => {
    const cases: Array<[TurnStepEvent, string, boolean]> = [
      // A fallback that takes low: the effort stays, the mismatch is still logged.
      [step(), 'claude-sonnet-5', true],
      // The reported id has no [1m]: it neither confirms nor refutes the variant, and is no mismatch.
      [step({ model: 'claude-opus-5-5[1m]' }), 'claude-opus-5-5', false],
    ];
    for (const [e, observed, mismatch] of cases) {
      const router = createRouter(configOf(EFFORT_ONLY));
      const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
      router.turnStart({ turnId: 't1', text: TEXT });
      await drain(router.turnStep(f.engine, e, streamNext<TurnStepEvent>(() => observed).next));
      const second = streamNext<TurnStepEvent>();
      await drain(router.turnStep(f.engine, { ...e, index: 1 }, second.next));
      expect(second.calls, e.model).toEqual([{ ...e, index: 1, effort: 'low' }]);
      expect(f.logs.some((l) => l['event'] === 'root_stop'), e.model).toBe(mismatch);
    }
  });

  it('retires a turn on its completion, and a child completion leaves it alone', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step(), streamNext<TurnStepEvent>().next));
    router.turnComplete({ turnId: 't1', agentId: 'child' });
    const kept = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ index: 1 }), kept.next));
    expect(kept.calls[0]?.effort).toBe('low');
    router.turnComplete({ turnId: 't1' });
    const gone = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ index: 2 }), gone.next));
    expect(gone.calls).toEqual([step({ index: 2 })]);
  });
});

describe('root model', () => {
  it('keeps the root model native as shipped: no model question, and with nothing else to ask, no request', async () => {
    const router = createRouter(configOf(MODEL_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.99] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), n.next));
    expect(n.calls).toEqual([step({ model: 'claude-sonnet-5' })]);
    expect(f.sent).toHaveLength(0);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', model_withheld: 'no_applicable_target', skipped: 'nothing_to_change' }));

    const both = createRouter(configOf({ ...MODEL_ONLY, routeMainEffort: true }));
    const g = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    both.turnStart({ turnId: 't1', text: TEXT });
    await drain(both.turnStep(g.engine, step(), streamNext<TurnStepEvent>().next));
    expect(Object.keys(g.sent[0]?.questions ?? {})).toEqual(['control', 'effort', 'action_risk']);
  });

  it('moves to a stronger configured model on the upgrade floor, and offers only the targets a switch could reach', async () => {
    const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ control: ['task_clear', 0.85], tier: ['deep', 0.85] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), n.next));
    expect(n.calls).toEqual([step({ model: 'claude-opus-5-5' })]);
    // fast is a smaller window, so it is not offered even though a switch to it is listed.
    expect(Object.keys(f.sent[0]?.questions['tier']?.criteria ?? {})).toEqual(['standard', 'deep', 'frontier', 'preserve']);
  });

  it('refuses a pair the target rejects, and asks nothing when no other profile could be applied', async () => {
    const pair = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['standard', 0.95] }) });
    pair.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(pair.turnStep(f.engine, step({ effort: 'max' }), n.next));
    expect(n.calls).toEqual([step({ effort: 'max' })]);
    expect(f.logs.find((l) => l['event'] === 'root')).toMatchObject({ reasons: { model: 'pair_invalid' } });

    const cases: Array<[string, readonly { from: string; to: string }[], readonly string[] | undefined]> = [
      ['only a smaller window is verified', [{ from: 'claude-sonnet-5', to: 'claude-haiku-4-5' }], undefined],
      ['every other target is outside availableModels', SWITCHES, ['claude-sonnet-5', 'sonnet']],
    ];
    for (const [label, switches, availableModels] of cases) {
      const router = createRouter(configOf(MODEL_ONLY), switches);
      const g = fakeEngine({ availableModels, respond: answering({ ...CLEAR, tier: ['deep', 0.95] }) });
      router.turnStart({ turnId: 't1', text: TEXT });
      const m = streamNext<TurnStepEvent>();
      await drain(router.turnStep(g.engine, step({ model: 'claude-sonnet-5' }), m.next));
      expect(m.calls, label).toEqual([step({ model: 'claude-sonnet-5' })]);
      expect(g.sent, label).toHaveLength(0);
      expect(g.logs, label).toContainEqual(expect.objectContaining({ event: 'root', model_withheld: 'no_applicable_target' }));
    }
  });

  it('stops the model override when a pin appears after the decision', async () => {
    const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const first = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), first.next));
    expect(first.calls[0]?.model).toBe('claude-opus-5-5');
    f.pins.mainModel = true;
    const second = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5', index: 1 }), second.next));
    expect(second.calls).toEqual([step({ model: 'claude-sonnet-5', index: 1 })]);
    expect(f.logs).toContainEqual({ event: 'root_stop', turn: 't1', index: 1, reason: 'model_pinned' });
  });

  it('stops the model override when the response names another model, or none', async () => {
    for (const observed of ['claude-sonnet-5', null]) {
      const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
      const f = fakeEngine({ respond: answering({ control: ['task_clear', 0.9], tier: ['deep', 0.9] }) });
      router.turnStart({ turnId: 't1', text: TEXT });
      const first = streamNext<TurnStepEvent>(() => observed);
      await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), first.next));
      expect(first.calls[0]?.model).toBe('claude-opus-5-5');
      const second = streamNext<TurnStepEvent>();
      await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5', index: 1 }), second.next));
      expect(second.calls).toEqual([step({ model: 'claude-sonnet-5', index: 1 })]);
      expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root_stop', reason: observed === null ? 'model_unobserved' : 'model_mismatch' }));
    }
  });

  it('offers no model change with the default aliases, since a root request takes only exact identifiers', async () => {
    const router = createRouter(configOf({ ...MODEL_ONLY, fastModel: 'haiku', standardModel: 'sonnet', deepModel: 'opus', frontierModel: '' }));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.99] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step(), n.next));
    expect(n.calls).toEqual([step()]);
    expect(f.sent).toHaveLength(0);
  });
});

const spawn = (over: Partial<SpawnEvent> = {}): SpawnEvent => ({
  tool_use_id: 'tu1',
  prompt: 'List every file under src/ that imports from ./config and report the import lines.',
  description: 'find config imports',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  fork: false,
  ...over,
});

const OFFER_BUILT_IN = (agent: string) => ({ agent, source: 'built-in', provider: { plugin: 'engine', tier: 'core' } });

const spawnNext = (resolved: (e: SpawnEvent) => SpawnOutcome = (e) => ({ model: e.model ?? 'claude-opus-5-5' })) => {
  const calls: SpawnEvent[] = [];
  const controller = new AbortController();
  const next = Object.assign(
    async (e: SpawnEvent): Promise<SpawnOutcome> => {
      calls.push(e);
      return resolved(e);
    },
    { signal: controller.signal },
  );
  return { next, calls, controller };
};

describe('spawn model', () => {
  it('routes an inheriting built-in with no model to a configured profile, calling next once', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const n = spawnNext();
    const result = await router.agentSpawn(f.engine, spawn(), n.next);
    expect(n.calls).toEqual([{ ...spawn(), model: 'haiku' }]);
    expect(result).toEqual({ model: 'haiku' });
    expect(f.sent[0]?.state).toEqual({ task: { text: spawn().prompt, description: spawn().description, subagent_type: 'general-purpose' } });
    expect(Object.keys(f.sent[0]?.questions ?? {})).toEqual(['control', 'tier', 'action_risk']);
  });

  it('stays native for every unverified case without a request', async () => {
    const cases: Array<[string, SpawnEvent, Parameters<typeof fakeEngine>[0], boolean]> = [
      ['fork', spawn({ fork: true }), {}, true],
      ['explicit_model', spawn({ model: 'sonnet' }), {}, true],
      ['subagent_model_pinned', spawn(), { pins: { subagentModel: true } }, true],
      ['alias_remapped', spawn(), { pins: { aliasRemap: true } }, true],
      ['type_unverified', spawn({ subagentType: 'code-reviewer' }), {}, true],
      ['definition_unverified', spawn(), {}, false],
      ['definition_unverified', spawn({ provider: { plugin: 'someone', tier: 'append' } }), {}, true],
      ['host_unverified', spawn(), { hostBase: '2.1.283' }, true],
      ['host_unverified', spawn(), { hostBase: undefined }, true],
      ['baseline_unknown', spawn({ subagentType: 'Explore', parentModel: 'claude-fable-5-1' }), {}, true],
      ['lean_marker', spawn({ prompt: 'Execute packet jev-lean-0123456789abcdef now.' }), {}, true],
      ['rank_unknown', spawn({ parentModel: 'claude-unknown-9' }), {}, true],
    ];
    for (const [reason, e, opts, offered] of cases) {
      const router = createRouter(configOf(SPAWN_ONLY));
      const f = fakeEngine({ ...opts, respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
      if (offered) {
        router.agentOffer(OFFER_BUILT_IN('general-purpose'));
        router.agentOffer(OFFER_BUILT_IN('Explore'));
        router.agentOffer(OFFER_BUILT_IN('code-reviewer'));
      }
      const n = spawnNext();
      await router.agentSpawn(f.engine, e, n.next);
      expect(n.calls, reason).toEqual([e]);
      expect(f.sent, reason).toHaveLength(0);
      expect(f.logs, reason).toContainEqual(expect.objectContaining({ event: 'spawn', skipped: reason }));
    }
  });

  it('does not trust a listing whose source is not the built-in one', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
    router.agentOffer({ agent: 'general-purpose', source: 'projectSettings', provider: { plugin: 'engine', tier: 'core' } });
    const n = spawnNext();
    await router.agentSpawn(f.engine, spawn(), n.next);
    expect(n.calls).toEqual([spawn()]);
    expect(f.sent).toHaveLength(0);
  });

  it('assesses every dispatch on its own text, even under the same tool use', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const QUICK = 'List the files under src/.';
    const f = fakeEngine({
      respond: (req) => answering({ ...CLEAR, tier: [(req.state as { task: { text: string } }).task.text === QUICK ? 'fast' : 'standard', 0.95] })(req),
    });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const a = spawnNext();
    const b = spawnNext();
    await Promise.all([router.agentSpawn(f.engine, spawn({ prompt: QUICK }), a.next), router.agentSpawn(f.engine, spawn(), b.next)]);
    expect(f.sent).toHaveLength(2);
    expect(a.calls[0]?.model).toBe('haiku');
    expect(b.calls[0]?.model).toBe('sonnet');
  });

  it('lets an abandoned dispatch decide nothing for a later one, and records what its reply cost', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const first = deferred<HttpReply>();
    let calls = 0;
    const f = fakeEngine({ respond: (req) => (calls++ === 0 ? first.promise : answering({ ...CLEAR, tier: ['standard', 0.95] })(req)) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const abandoned = spawnNext();
    const run = router.agentSpawn(f.engine, spawn(), abandoned.next);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    abandoned.controller.abort();
    await expect(run).rejects.toThrow('abandoned');

    const again = spawnNext();
    const pending = router.agentSpawn(f.engine, spawn(), again.next);
    first.resolve(answering({ ...CLEAR, tier: ['fast', 0.95] })(f.sent[0]!) as HttpReply);
    await pending;
    expect(f.sent).toHaveLength(2);
    expect(again.calls[0]?.model).toBe('sonnet');
    await vi.waitFor(() => expect(f.logs).toContainEqual(expect.objectContaining({ event: 'late', scope: 'spawn', tool_use_id: 'tu1' })));
  });

  it('logs a denial and a resolved model outside the requested family, and changes neither', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const denied = spawnNext(() => ({ deny: 'policy' }));
    expect(await router.agentSpawn(f.engine, spawn(), denied.next)).toEqual({ deny: 'policy' });
    const other = spawnNext(() => ({ model: 'claude-sonnet-5' }));
    expect(await router.agentSpawn(f.engine, spawn({ tool_use_id: 'tu2' }), other.next)).toEqual({ model: 'claude-sonnet-5' });
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn_result', denied: true }));
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn_result', reason: 'model_mismatch', requested: 'haiku', observed: 'claude-sonnet-5' }));
  });

  it('throws instead of calling next once its dispatch was abandoned', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const reply = deferred<HttpReply>();
    const f = fakeEngine({ respond: () => reply.promise });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const n = spawnNext();
    const run = router.agentSpawn(f.engine, spawn(), n.next);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    n.controller.abort();
    await expect(run).rejects.toThrow('abandoned');
    expect(n.calls).toHaveLength(0);
  });

  it('verifies against the host release it was read from', () => {
    expect(VERIFIED_HOST).toBe('2.1.282');
  });
});

describe('lifecycle', () => {
  it('session end aborts pending waits and forgets offers', async () => {
    const router = createRouter(configOf({ routeMainEffort: true, routeSubagentModel: true }));
    const reply = deferred<HttpReply>();
    const f = fakeEngine({ respond: () => reply.promise });
    router.turnStart({ turnId: 't1', text: TEXT });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const n = streamNext<TurnStepEvent>();
    const run = drain(router.turnStep(f.engine, step(), n.next));
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    router.sessionEnd();
    await run;
    expect(n.calls).toEqual([step()]);

    const s = spawnNext();
    await router.agentSpawn(fakeEngine({}).engine, spawn(), s.next);
    expect(s.calls).toEqual([spawn()]);
  });

  it('a diagnostic that throws changes nothing: the routed calls, the native result and a native error pass through', async () => {
    const router = createRouter(configOf({ routeMainEffort: true, routeSubagentModel: true }));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95], tier: ['fast', 0.95] }) });
    const engine = {
      ...f.engine,
      log: () => {
        throw new Error('log sink down');
      },
    };
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    expect((await drain(router.turnStep(engine, step(), n.next))).chunks).toEqual(['chunk']);
    expect(n.calls).toEqual([{ ...step(), effort: 'low' }]);

    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const ok = spawnNext();
    expect(await router.agentSpawn(engine, spawn(), ok.next)).toEqual({ model: 'haiku' });
    const failure = new Error('native spawn failed');
    const bad = spawnNext(() => {
      throw failure;
    });
    await expect(router.agentSpawn(engine, spawn({ tool_use_id: 'tu2' }), bad.next)).rejects.toBe(failure);
    expect(bad.calls).toEqual([{ ...spawn({ tool_use_id: 'tu2' }), model: 'haiku' }]);
  });

  it('a reply naming another Jev model is not applied', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: (req) => ({ ...(answering({ ...CLEAR, effort: ['low', 0.95] })(req) as HttpReply), text: JSON.stringify({ model: `${JEV_MODEL}-x`, answers: {} }) }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step(), n.next));
    expect(n.calls).toEqual([step()]);
    expect(f.logs).toContainEqual(expect.objectContaining({ assessment: 'model_mismatch' }));
  });
});
