import { describe, expect, it, vi } from 'vitest';

import type { HttpReply } from '../../mods/router/hooks/client.ts';
import { JEV_ENDPOINT, JEV_MODEL } from '../../mods/router/hooks/client.ts';
import { resolveConfig } from '../../mods/router/hooks/config.ts';
import type { SymbolicEffort } from '../../mods/router/hooks/models.ts';
import { offerableEfforts, TIER_LEVELS } from '../../mods/router/hooks/policy.ts';
import type { SpawnEvent, SpawnOutcome, TurnStepEvent } from '../../mods/router/hooks/router.ts';
import { cachePatch, createRouter, hostSupported, VERIFIED_HOST } from '../../mods/router/hooks/router.ts';
import { answering, choice, CLEAR, deferred, drain, FAKE_KEY, fakeEngine, streamNext } from './fake-engine.ts';

const configOf = (options: Record<string, string | number | boolean>) => {
  const r = resolveConfig({ enabled: true, allowFable: true, ...options });
  if (!r.ok) throw new Error(`invalid option ${r.field}`);
  return r.config;
};

/** Each switch alone; the subagent-effort and named-model switches, on by default, get their own cases below. */
const SUBAGENT_OFF = { routeSubagentEffort: false, routeExplicitSpawnModel: false };
const EFFORT_ONLY = { routeMainEffort: true, routeMainModel: false, routeSubagentModel: false, ...SUBAGENT_OFF };
const FULL_IDS = { fastModel: 'claude-haiku-4-5', standardModel: 'claude-sonnet-5', deepModel: 'claude-opus-5-5', frontierModel: 'claude-fable-5-1' };
const MODEL_ONLY = { routeMainEffort: false, routeMainModel: true, routeSubagentModel: false, ...SUBAGENT_OFF, ...FULL_IDS };
const SPAWN_ONLY = { routeMainEffort: false, routeMainModel: false, routeSubagentModel: true, ...SUBAGENT_OFF, routeSubagentEffort: true };
/** Explicit switch overrides used by tests that constrain the root-model path. */
const SWITCHES = ([
  ['claude-sonnet-5', 'claude-opus-5-5'],
  ['claude-opus-5-5', 'claude-sonnet-5'],
  ['claude-sonnet-5', 'claude-fable-5-1'],
  ['claude-sonnet-5', 'claude-haiku-4-5'],
] as const).map(([from, to]) => ({ from, to }));

const TEXT = 'Rename the helper parseRow to parseRecord in src/rows.ts and update its two callers.';
const step = (over: Partial<TurnStepEvent> = {}): TurnStepEvent => ({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', ...over });

const settle = () => new Promise((r) => setTimeout(r, 0));
describe('root window compatibility at the current request', () => {
  it.each(['native_default', 'native_echo', 'conditional_haiku_echo', 'conditional_haiku_default'] as const)('reassesses three root turns and reuses only the current turn: %s', async mode => {
    let phase = 0;
    const targets = ['claude-sonnet-5-5', mode.startsWith('conditional') ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-5-5', 'claude-opus-5-5'];
    const router = createRouter(configOf({ routeMainModel: true, routeMainEffort: true, ...SUBAGENT_OFF }));
    const f = fakeEngine({ hostBase: '2.1.287', respond: req => {
      const target = targets[phase]!;
      const q = req.questions.model?.criteria as Record<string, string> | undefined;
      const pick = q && target in q ? target : '__keep__';
      return { status: 200, text: JSON.stringify({ model: JEV_MODEL, answers: Object.fromEntries(Object.entries(req.questions).map(([name, q]) => [name,
        q.type === 'choice' ? choice(Object.keys(q.criteria), [name === 'model' ? pick : name === 'control' ? 'task_clear' : 'ordinary', .99]) :
          { type: 'score', probabilities: Object.fromEntries((q.criteria as string[]).map((s, i) => [i, s.startsWith(phase < 2 ? 'Light reasoning' : 'Strong reasoning') ? 1 : 0])) }])) }) };
    } });
    // A complete current-request bound and compatible transform are synthetic capabilities, not Claude host evidence.
    f.engine.currentContextBound = async (turnId, index) => ({ turnId, index, inputUpperBound: 20_000, compatible: true });
    f.engine.currentEffort = async () => undefined;
    for (phase = 0; phase < 3; phase++) {
      const turnId = `turn-${phase}`;
      const model = phase === 0 || mode.endsWith('default') ? 'claude-opus-5-5' : targets[phase - 1]!;
      const e = { turnId, index: 0, model, ...(model.includes('haiku') ? {} : { effort: phase === 0 || mode.endsWith('default') ? 'high' as const : 'low' as const }) };
      router.turnStart({ turnId, text: phase === 0 ? 'Find the exact helper file.' : phase === 1 ? 'Find the exact caller file.' : 'Continue: diagnose the concurrency failure and fix it without changing the API.' });
      const expected = { ...e, model: targets[phase]!, ...(targets[phase]!.includes('haiku') ? {} : { effort: phase < 2 ? 'low' : 'high' }) };
      if (targets[phase]!.includes('haiku')) delete expected.effort;
      const first = streamNext<TurnStepEvent>(undefined, { input_tokens: 900, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 1000 });
      await drain(router.turnStep(f.engine, e, first.next));
      expect(first.calls).toEqual([expected]);
      const later = streamNext<TurnStepEvent>();
      await drain(router.turnStep(f.engine, { ...e, index: 1 }, later.next));
      expect(later.calls).toEqual([{ ...expected, index: 1 }]);
      expect(f.sent).toHaveLength(phase + 1);
      router.turnComplete({ turnId, reason: 'answer', answer: 'Observed result.' });
    }
    expect(f.logs.filter(l => l.event === 'root').map(l => l.turn)).toEqual(['turn-0', 'turn-1', 'turn-2']);
    expect(f.sent[1]?.state).toMatchObject({ execution: { cache: { source: 'provider_response_usage', cross_model_reuse_proven: false, current_fit_proven: false } } });
    expect(f.logs.filter(l => l.event === 'root')[2]).toMatchObject({ selection: { direction: mode.endsWith('default') ? 'unknown' : 'upgrade' }, reasons: { model: mode.endsWith('default') ? 'same_value' : 'selected' } });
  });
  it('does not let a late retired root response or completion replace newer cache and visible context', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', .99] }) });
    const late = deferred<void>(); let started = false;
    const next = Object.assign(async function* (e: TurnStepEvent) {
      started = true; await late.promise;
      return { answer: 'OLD_REPLY', usage: { model: e.model, input_tokens: 11, cache_read_input_tokens: 111 } };
    }, { signal: new AbortController().signal });
    router.turnStart({ turnId: 't1', text: TEXT });
    const old = drain(router.turnStep(f.engine, step(), next));
    await vi.waitFor(() => expect(started).toBe(true));
    router.turnStart({ turnId: 't2', text: 'Find the current file.' });
    await drain(router.turnStep(f.engine, step({ turnId: 't2' }), streamNext<TurnStepEvent>(undefined, { input_tokens: 22, cache_read_input_tokens: 222 }).next));
    router.turnComplete({ turnId: 't2', reason: 'answer', answer: 'NEW_REPLY' });
    late.resolve(); await old;
    router.turnComplete({ turnId: 't1', reason: 'answer', answer: 'OLD_REPLY' });
    router.turnStart({ turnId: 't3', text: 'Continue' });
    await drain(router.turnStep(f.engine, step({ turnId: 't3' }), streamNext<TurnStepEvent>().next));
    expect(f.sent[2]?.state).toMatchObject({ task: { previous_reply: 'NEW_REPLY' }, execution: { cache: { cache_read_tokens: 222 } } });
  });
  it.each(['effective', 'unknown', 'numeric', 'auto', 'pinned'] as const)('resolves an absent field without inventing a host value: %s', async scenario => {
    const router = createRouter(configOf({ routeMainModel: true, routeMainEffort: true, ...SUBAGENT_OFF }));
    const f = fakeEngine({ hostBase: '2.1.287', pins: { mainEffort: scenario === 'pinned' }, respond: answering({ ...CLEAR, tier: ['standard', .95], effort: ['high', .95] }) });
    f.engine.currentEffort = async () => scenario === 'effective' || scenario === 'pinned' ? 'high' : scenario === 'numeric' ? 12000 : undefined;
    router.turnStart({ turnId: 't1', text: TEXT }); const first = streamNext<TurnStepEvent>();
    const e = { turnId: 't1', index: 0, model: 'claude-opus-5-5' };
    await drain(router.turnStep(f.engine, e, first.next));
    if (scenario === 'numeric') expect(first.calls).toEqual([e]);
    else expect(first.calls[0]?.model).toBe('claude-sonnet-5');
    if (scenario === 'unknown' || scenario === 'auto') expect(first.calls[0]?.effort).toBe('high');
    const metadata = f.logs.find(l => l.event === 'root'); if (metadata) expect(metadata.effort_source).toBe(scenario === 'effective' || scenario === 'numeric' || scenario === 'pinned' ? 'host_effective' : 'unknown');
  });
  it.each(['fit', 'large', 'unknown', 'failure', 'grows', 'estimate_only', 'stale', 'incompatible'] as const)('routes to Haiku only with a current fitting context and rechecks later requests: %s', async scenario => {
    let tokens = 22_000;
    const router = createRouter(configOf({ routeMainEffort: true, routeMainModel: true, ...SUBAGENT_OFF }));
    const f = fakeEngine({ respond: req => {
      const q = req.questions.model!.criteria as Record<string, string>;
      const pick = Object.keys(q).find(k => k.includes('haiku')) ?? '__keep__';
      return { status: 200, text: JSON.stringify({ model: JEV_MODEL, answers: { model: choice(Object.keys(q), [pick, .99]), control: choice(Object.keys(req.questions.control!.criteria), ['task_clear', .99]), action_risk: choice(Object.keys(req.questions.action_risk!.criteria), ['ordinary', .99]) } }) };
    } });
    if (scenario !== 'estimate_only') f.engine.currentContextBound = async (turnId, index) => { if (scenario === 'failure') throw new Error('bound unavailable'); return scenario === 'unknown' ? undefined : { turnId: scenario === 'stale' ? 'old-turn' : turnId, index, inputUpperBound: scenario === 'large' ? 180_000 : tokens, compatible: scenario !== 'incompatible' }; };
    router.turnStart({ turnId: 't1', text: TEXT }); const first = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ effort: 'xhigh' }), first.next));
    if (scenario === 'fit' || scenario === 'grows') expect(first.calls).toEqual([{ turnId: 't1', index: 0, model: 'claude-haiku-4-5-20251001' }]);
    else expect(first.calls).toEqual([step({ effort: 'xhigh' })]);
    tokens = 180_000; const later = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, step({ index: 1, effort: 'xhigh' }), later.next));
    expect(later.calls).toEqual([step({ index: 1, effort: 'xhigh' })]); expect(f.sent).toHaveLength(1);
    if (scenario === 'grows') expect(f.logs.some(l => l.reason === 'context_unverified')).toBe(true);
  });
});
/** Runs `f` after `hops` microtask turns, to land between two awaits of the code under test. */
const later = (hops: number, f: () => void): void => {
  if (hops === 0) f();
  else queueMicrotask(() => later(hops - 1, f));
};

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
    expect(req?.state).toEqual({ task: { text: TEXT, source: 'current_human_request', truncated: false, recent_requests: [] } });
    expect(Object.keys(req?.questions ?? {})).toEqual(['effort_0', 'control', 'action_risk']);
    // Effort is asked as four levels of work; which effort each maps to is decided locally.
    expect(req?.questions['effort_0']).toMatchObject({ type: 'score', criteria: expect.arrayContaining([expect.stringContaining('Light reasoning'), expect.stringContaining('Maximum sustained')]) });

    const root = f.logs.find((l) => l['event'] === 'root');
    expect(root).toMatchObject({ assessment: 'ok', sent: true, patch: { effort: 'low' }, reasons: { effort: 'selected', model: 'not_asked' } });
    // The receipt: what the move was read from.
    expect(root?.['answers']).toMatchObject({ control: { choice: 'task_clear', probabilities: { task_clear: .97 } }, action_risk: { probabilities: { ordinary: .97 } } });
    expect((root?.['answers'] as { effort_0: { probabilities: Record<string, number> } }).effort_0.probabilities['0']).toBe(.95);
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
    const f2 = fakeEngine({ respond: answering({ control: ['task_clear', 0.85], action_risk: ['unclear', 0.5], effort: ['high', 0.85] }) });
    up.turnStart({ turnId: 't1', text: TEXT });
    const n2 = streamNext<TurnStepEvent>();
    await drain(up.turnStep(f2.engine, step({ effort: 'medium' }), n2.next));
    // Hard work asks for high, never more.
    expect(n2.calls).toEqual([step({ effort: 'high' })]);
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

  it('asks nothing when effort cannot change: pinned, numeric, or a model that takes none', async () => {
    const cases: Array<[TurnStepEvent, Partial<{ mainEffort: boolean }>]> = [
      [step(), { mainEffort: true }],
      [step({ effort: 12_000 }), {}],
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

  it('reads the key before anything optional, so a missing key never waits on a stalled read', async () => {
    const router = createRouter(configOf({ ...EFFORT_ONLY, routeMainModel: true, ...FULL_IDS }), SWITCHES);
    const f = fakeEngine({ envKey: undefined });
    let reads = 0;
    f.engine.pins = () => {
      reads++;
      return new Promise(() => {});
    };
    f.engine.availableModels = () => {
      reads++;
      return new Promise(() => {});
    };
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step(), n.next));
    expect(n.calls).toEqual([step()]);
    expect(reads).toBe(0);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', skipped: 'key_missing' }));
  });

  it('uses a key entered after a keyless turn without restarting the session', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ envKey: undefined, respond: answering({ ...CLEAR, effort: ['xhigh', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const first = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step(), first.next));
    expect(first.calls).toEqual([step()]);
    expect(f.sent).toHaveLength(0);

    f.engine.envKey = async () => FAKE_KEY;
    router.turnStart({ turnId: 't2', text: TEXT });
    const second = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ turnId: 't2' }), second.next));
    expect(second.calls).toEqual([step({ turnId: 't2', effort: 'xhigh' })]);
    expect(f.sent).toHaveLength(1);
  });

  it('retries a missing key even when its first read settles after the turn times out', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['xhigh', 0.95] }) });
    const pending = deferred<string | undefined>(); f.engine.envKey = () => pending.promise;
    router.turnStart({ turnId: 't1', text: TEXT });
    const first = streamNext<TurnStepEvent>(); const running = drain(router.turnStep(f.engine, step(), first.next));
    await settle(); f.expire(); await running;
    expect(first.calls).toEqual([step()]); expect(f.sent).toHaveLength(0);
    pending.resolve(undefined); await settle();

    f.engine.envKey = async () => FAKE_KEY;
    router.turnStart({ turnId: 't2', text: TEXT });
    const second = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ turnId: 't2' }), second.next));
    expect(second.calls).toEqual([step({ turnId: 't2', effort: 'xhigh' })]);
    expect(f.sent).toHaveLength(1);
  });

  it('forwards a step that could never be routed without waiting for the key', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine();
    f.engine.envKey = () => new Promise(() => {});
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ effort: 12_000 }), n.next));
    expect(n.calls).toEqual([step({ effort: 12_000 })]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', skipped: 'nothing_to_change' }));
  });

  it('ends a stalled pins or allowlist read when its turn is retired, at the first step or a later one', async () => {
    const stall = (): Promise<never> => new Promise(() => {});
    const cases: Array<[string, (f: ReturnType<typeof fakeEngine>) => void, number]> = [
      ['pins, assessing', (f) => void (f.engine.pins = stall), 0],
      ['allowlist, assessing', (f) => void (f.engine.availableModels = stall), 0],
      ['pins, applying', (f) => void (f.engine.pins = stall), 1],
      ['allowlist, applying', (f) => void (f.engine.availableModels = stall), 1],
    ];
    for (const [label, stalled, index] of cases) {
      const router = createRouter(configOf({ ...MODEL_ONLY, routeMainEffort: true }), SWITCHES);
      const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['low', 0.95] }) });
      router.turnStart({ turnId: 't1', text: TEXT });
      if (index === 1) await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), streamNext<TurnStepEvent>().next));
      stalled(f);
      const e = step({ model: 'claude-sonnet-5', index });
      const n = streamNext<TurnStepEvent>();
      const run = drain(router.turnStep(f.engine, e, n.next));
      await settle();
      router.turnComplete({ turnId: 't1' });
      await run;
      expect(n.calls, label).toEqual([e]);
    }
  });

  it('stops waiting for a pending key once its turn is retired, and sends nothing for it', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const key = deferred<string | undefined>();
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    f.engine.envKey = () => key.promise;
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    const run = drain(router.turnStep(f.engine, step(), n.next));
    await settle();
    router.turnComplete({ turnId: 't1' });
    await run;
    expect(n.calls).toEqual([step()]);
    key.resolve(FAKE_KEY);
    await settle();
    expect(f.sent).toHaveLength(0);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', skipped: 'turn_retired' }));
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
    // What the late reply cost is still recorded, against the turn that asked, under keys the host's debug log does not
    // redact (it blanks any key containing "token").
    expect(f.logs).toContainEqual({ event: 'late', scope: 'root', turn: 't1', usage: { input: 900, output: 40 } });
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

  it('passes a native stream error after its first chunk through, and never calls next again', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const failure = new Error('stream broke');
    const calls: TurnStepEvent[] = [];
    const next = Object.assign(
      async function* (e: TurnStepEvent): AsyncGenerator<string, { usage: null }> {
        calls.push(e);
        yield 'chunk';
        throw failure;
      },
      { signal: new AbortController().signal },
    );
    const gen = router.turnStep(f.engine, step(), next);
    expect((await gen.next()).value).toBe('chunk');
    await expect(gen.next()).rejects.toBe(failure);
    expect(calls).toEqual([{ ...step(), effort: 'low' }]);
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

  it('keeps the selected request independent of missing or mismatched response diagnostics', async () => {
    for (const observed of ['claude-haiku-4-5', 'claude-sonnet-5', null]) {
      const router = createRouter(configOf(EFFORT_ONLY));
      const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', .95] }) });
      router.turnStart({ turnId: 't1', text: TEXT });
      await drain(router.turnStep(f.engine, step(), streamNext<TurnStepEvent>(() => observed).next));
      const next = streamNext<TurnStepEvent>();
      await drain(router.turnStep(f.engine, step({ index: 1 }), next.next));
      expect(next.calls).toEqual([step({ index: 1, effort: 'low' })]);
      expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root_result', observed, observed_effort: 'unknown', confirmation: observed === null ? 'unobserved' : 'mismatch' }));
      expect(f.logs.some(l => l['event'] === 'root_stop')).toBe(false);
    }
  });

  it('never gives a root step its patch once the session has ended, wherever the end lands after the last read', async () => {
    for (let hops = 0; hops <= 12; hops++) {
      const router = createRouter(configOf(EFFORT_ONLY));
      const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
      router.turnStart({ turnId: 't1', text: TEXT });
      const n = streamNext<TurnStepEvent>();
      let endedBeforeNext: boolean | null = null;
      const pins = f.engine.pins;
      let reads = 0;
      f.engine.pins = async () => {
        const r = await pins();
        // The second pins read, in applyStored, is the last one before next.
        if (++reads === 2) later(hops, () => {
          endedBeforeNext = n.calls.length === 0;
          router.sessionEnd();
        });
        return r;
      };
      await drain(router.turnStep(f.engine, step(), n.next));
      await settle();
      expect(n.calls, `hops ${hops}`).toHaveLength(endedBeforeNext === true ? 0 : 1);
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
  it('routes the main model without requiring a manually verified switch table', async () => {
    const router = createRouter(configOf(MODEL_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.99] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), n.next));
    expect(n.calls).toEqual([step({ model: 'claude-opus-5-5' })]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.questions['model']).toBeDefined();
  });

  it('moves to a stronger configured model on the upgrade floor, and offers only the targets a switch could reach', async () => {
    const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ control: ['task_clear', 0.85], tier: ['deep', 0.85] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), n.next));
    expect(n.calls).toEqual([step({ model: 'claude-opus-5-5' })]);
    // fast is a smaller window, so it is not offered even though a switch to it is listed.
    expect(Object.keys(f.sent[0]?.questions['model']?.criteria ?? {})).toEqual(['__keep__', '__abstain__', 'claude-fable-5-1', 'claude-opus-5-5']);
  });

  it('refuses a pair the target rejects, and asks nothing when no other profile could be applied', async () => {
    // Sonnet takes no max, and no effort is offered alongside it, so the question is not worth asking.
    const modelOnly = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['standard', 0.95] }) });
    modelOnly.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(modelOnly.turnStep(f.engine, step({ effort: 'max' }), n.next));
    expect(n.calls).toEqual([step({ effort: 'max' })]);
    expect(f.sent).toHaveLength(0);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', model_withheld: 'no_applicable_target' }));

    // With efforts offered too, Sonnet is offerable; an answer that keeps max is then refused as a pair.
    const both = createRouter(configOf({ ...MODEL_ONLY, routeMainEffort: true }), SWITCHES);
    const h = fakeEngine({ respond: answering({ ...CLEAR, tier: ['standard', 0.95], effort: ['xhigh', 0.95] }) });
    both.turnStart({ turnId: 't1', text: TEXT });
    const o = streamNext<TurnStepEvent>();
    await drain(both.turnStep(h.engine, step({ effort: 'max' }), o.next));
    expect(o.calls).toEqual([step({ effort: 'max' })]);
    expect(h.sent).toHaveLength(1);
    expect(h.logs.find((l) => l['event'] === 'root')).toMatchObject({ reasons: { model: 'pair_invalid' } });

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

  it('does not consume a model patch through response observation, but a real incoming C wins', async () => {
    const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', .95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), streamNext<TurnStepEvent>(() => null).next));
    const next = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-opus-5-5', index: 1 }), next.next));
    expect(next.calls[0]!.model).toBe('claude-opus-5-5');
    const manual = step({ model: 'claude-fable-5-1', index: 2 });
    await drain(router.turnStep(f.engine, manual, next.next));
    expect(next.calls.at(-1)).toEqual(manual);
    expect(f.sent).toHaveLength(1);
  });

  it('reads the pins last, so a pin set while the allowlist is read still stops a stored override', async () => {
    const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), streamNext<TurnStepEvent>().next));
    const gate = deferred<void>();
    f.allowed.wait = gate.promise;
    const before = f.allowed.reads;
    const second = streamNext<TurnStepEvent>();
    const run = drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5', index: 1 }), second.next));
    await vi.waitFor(() => expect(f.allowed.reads).toBe(before + 1));
    f.pins.mainModel = true;
    gate.resolve();
    await run;
    expect(second.calls).toEqual([step({ model: 'claude-sonnet-5', index: 1 })]);
    expect(f.logs).toContainEqual({ event: 'root_stop', turn: 't1', index: 1, reason: 'model_pinned' });
  });

  it('drops a stored model whose pair fails once a pin suppresses its effort', async () => {
    const router = createRouter(configOf({ ...MODEL_ONLY, routeMainEffort: true }), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['standard', 0.95], effort: ['medium', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const first = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ effort: 'max' }), first.next));
    expect(first.calls).toEqual([step({ model: 'claude-sonnet-5', effort: 'medium' })]);
    // Sonnet takes no max: without the effort patch the request would keep max on a model that cannot run it.
    f.pins.mainEffort = true;
    const second = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ effort: 'max', index: 1 }), second.next));
    expect(second.calls).toEqual([step({ effort: 'max', index: 1 })]);
    expect(f.logs).toContainEqual({ event: 'root_stop', turn: 't1', index: 1, reason: 'effort_pinned' });
    expect(f.logs).toContainEqual({ event: 'root_stop', turn: 't1', index: 1, reason: 'pair_invalid' });
  });

  it('stops a stored model override the allowlist no longer holds', async () => {
    const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), streamNext<TurnStepEvent>().next));
    f.allowed.models = ['claude-sonnet-5'];
    const second = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5', index: 1 }), second.next));
    expect(second.calls).toEqual([step({ model: 'claude-sonnet-5', index: 1 })]);
    expect(f.logs).toContainEqual({ event: 'root_stop', turn: 't1', index: 1, reason: 'model_not_allowed' });
  });

  it('records an unmapped native child response once without mislabelling it as a root response', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine();
    await drain(router.turnStep(f.engine, step({ agentId: 'native-child' }), streamNext<TurnStepEvent>().next));
    expect(f.logs.filter(l => l['event'] === 'root_result')).toHaveLength(0);
    expect(f.logs.filter(l => l['event'] === 'child_result')).toEqual([expect.objectContaining({ agent_id: 'native-child', requested: 'claude-opus-5-5', observed: 'claude-opus-5-5', confirmation: 'confirmed' })]);
    expect(f.sent).toHaveLength(0);
  });
  it('records what each patched step was answered by and what it reported, counts only', async () => {
    const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const counts = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, note: 'dropped' };
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), streamNext<TurnStepEvent>(undefined, counts).next));
    expect(f.logs).toContainEqual({
      event: 'root_result',
      turn: 't1',
      index: 0,
      requested: 'claude-opus-5-5',
      requested_effort: 'high',
      observed_effort: 'unknown',
      confirmation: 'confirmed',
      applied: { model: 'claude-opus-5-5' },
      observed: 'claude-opus-5-5',
      usage: { input: 1200, output: 80, cache_read: 40000, cache_creation: 0 },
    });
  });

  it('resolves default aliases to exact root identifiers and enables the frontier tier', async () => {
    const router = createRouter(configOf({ routeMainModel: true, routeMainEffort: false, routeSubagentModel: false }));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['frontier', 0.99] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5' }), n.next));
    expect(n.calls).toEqual([step({ model: 'claude-fable-5-1' })]);
    expect(f.sent).toHaveLength(1);
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
    expect(n.calls).toEqual([{ ...spawn(), model: 'claude-haiku-4-5-20251001' }]);
    expect(result).toEqual({ model: 'claude-haiku-4-5-20251001' });
    expect(f.sent[0]?.state).toMatchObject({ task: { text: spawn().prompt, description: spawn().description, subagent_type: 'general-purpose', source: 'child_contract', truncated: false } });
    expect(Object.keys(f.sent[0]?.questions ?? {})).toContain('model');
  });

  it('stays native for every unverified case without a request', async () => {
    const cases: Array<[string, SpawnEvent, Parameters<typeof fakeEngine>[0], boolean]> = [
      ['fork', spawn({ fork: true }), {}, true],
      ['alias_remapped', spawn(), { pins: { aliasRemap: true } }, true],
      ['type_unverified', spawn({ subagentType: 'code-reviewer' }), {}, true],
      ['definition_unverified', spawn(), {}, false],
      ['definition_unverified', spawn({ provider: { plugin: 'someone', tier: 'append' } }), {}, true],
      ['host_unverified', spawn(), { hostBase: '2.1.281' }, true],
      ['host_unverified', spawn(), { hostBase: '2.2.0' }, true],
      ['host_unverified', spawn(), { hostBase: '2.1.283-dev' }, true],
      ['host_unverified', spawn(), { hostBase: undefined }, true],
      ['baseline_unknown', spawn({ subagentType: 'Explore', parentModel: 'claude-fable-5-1' }), {}, true],
      ['lean_marker', spawn({ prompt: 'Execute packet jev-lean-0123456789abcdef now.' }), {}, true],
      ['gate_routed', spawn({ subagentType: 'jev-gate:worker' }), {}, true],
      ['gate_routed', spawn({ subagentType: 'jev-gate:planner' }), {}, true],
      ['gate_routed', spawn({ prompt: 'Fix it.\n\n[Jev Gate route note] Tier: fast. Precedence: ...' }), {}, true],
    ];
    for (const [reason, e, opts, offered] of cases) {
      const router = createRouter(configOf({ ...SPAWN_ONLY, routeSubagentEffort: false }));
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
    const router = createRouter(configOf({ ...SPAWN_ONLY, routeSubagentEffort: false }));
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
    expect(a.calls[0]?.model).toBe('claude-haiku-4-5-20251001');
    expect(b.calls[0]?.model).toBe('claude-sonnet-5');
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
    expect(again.calls[0]?.model).toBe('claude-sonnet-5');
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
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn_result', reason: 'model_mismatch', requested: 'claude-haiku-4-5-20251001', observed: 'claude-sonnet-5' }));
  });

  it('stays native when a pin or the allowlist changes while Jev answers', async () => {
    const changes: Array<[string, (f: ReturnType<typeof fakeEngine>) => void]> = [
      ['subagent_model_pinned', (f) => void (f.pins.subagentModel = true)],
      ['alias_remapped', (f) => void (f.pins.aliasRemap = true)],
      ['target_not_allowed', (f) => void (f.allowed.models = ['claude-opus-5-5'])],
    ];
    for (const [reason, change] of changes) {
      const router = createRouter(configOf(SPAWN_ONLY));
      const reply = deferred<HttpReply>();
      const f = fakeEngine({ respond: () => reply.promise });
      router.agentOffer(OFFER_BUILT_IN('general-purpose'));
      const n = spawnNext();
      const run = router.agentSpawn(f.engine, spawn(), n.next);
      await vi.waitFor(() => expect(f.sent).toHaveLength(1));
      change(f);
      reply.resolve(answering({ ...CLEAR, tier: ['fast', 0.95] })(f.sent[0]!) as HttpReply);
      await run;
      expect(n.calls, reason).toEqual([spawn()]);
      expect(f.logs, reason).toContainEqual({ event: 'spawn_stop', tool_use_id: 'tu1', reason, requested: 'claude-haiku-4-5-20251001' });
    }
  });

  it('reads the pins last, so a pin set while the allowlist is read still leaves the spawn native', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const reply = deferred<HttpReply>();
    const f = fakeEngine({ respond: () => reply.promise });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const n = spawnNext();
    const run = router.agentSpawn(f.engine, spawn(), n.next);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    const gate = deferred<void>();
    f.allowed.wait = gate.promise;
    const before = f.allowed.reads;
    reply.resolve(answering({ ...CLEAR, tier: ['fast', 0.95] })(f.sent[0]!) as HttpReply);
    await vi.waitFor(() => expect(f.allowed.reads).toBe(before + 1));
    f.pins.subagentModel = true;
    gate.resolve();
    await run;
    expect(n.calls).toEqual([spawn()]);
    expect(f.logs).toContainEqual({ event: 'spawn_stop', tool_use_id: 'tu1', reason: 'subagent_model_pinned', requested: 'claude-haiku-4-5-20251001' });
  });

  it('sends nothing and routes nothing for a dispatch whose session ended during a read', async () => {
    for (const during of ['first', 'final'] as const) {
      const router = createRouter(configOf(SPAWN_ONLY));
      const reply = deferred<HttpReply>();
      const f = fakeEngine({ respond: () => reply.promise });
      router.agentOffer(OFFER_BUILT_IN('general-purpose'));
      const gate = deferred<void>();
      if (during === 'first') f.allowed.wait = gate.promise;
      const n = spawnNext();
      const run = router.agentSpawn(f.engine, spawn(), n.next);
      if (during === 'final') {
        await vi.waitFor(() => expect(f.sent).toHaveLength(1));
        f.allowed.wait = gate.promise;
        reply.resolve(answering({ ...CLEAR, tier: ['fast', 0.95] })(f.sent[0]!) as HttpReply);
      }
      await vi.waitFor(() => expect(f.allowed.reads).toBe(during === 'first' ? 1 : 2));
      router.sessionEnd();
      gate.resolve();
      await expect(run).rejects.toThrow('spawn dispatch abandoned');
      expect(n.calls, during).toEqual([]);
      expect(f.sent, during).toHaveLength(during === 'first' ? 0 : 1);
      expect(f.logs, during).toContainEqual({ event: 'spawn_stop', tool_use_id: 'tu1', reason: 'session_ended' });
    }
  });

  it('never routes a spawn to next once its session has ended, wherever the end lands after the last read', async () => {
    for (let hops = 0; hops <= 12; hops++) {
      const router = createRouter(configOf(SPAWN_ONLY));
      const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
      router.agentOffer(OFFER_BUILT_IN('general-purpose'));
      const n = spawnNext();
      let endedBeforeNext: boolean | null = null;
      const pins = f.engine.pins;
      let reads = 0;
      f.engine.pins = async () => {
        const r = await pins();
        // The second pins read is the last one before next.
        if (++reads === 2) later(hops, () => {
          endedBeforeNext = n.calls.length === 0;
          router.sessionEnd();
        });
        return r;
      };
      const result = await router.agentSpawn(f.engine, spawn(), n.next).then(() => 'sent', () => 'cancelled');
      await settle();
      expect(n.calls, `hops ${hops}`).toHaveLength(endedBeforeNext === true ? 0 : 1);
      expect(result).toBe(endedBeforeNext === true ? 'cancelled' : 'sent');
    }
  });

  it('ends a pending key read with its dispatch, reading nothing else, and a missing key never waits on a stalled read', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const key = deferred<string | undefined>();
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
    f.engine.envKey = () => key.promise;
    let reads = 0;
    const pins = f.engine.pins;
    f.engine.pins = () => {
      reads++;
      return pins();
    };
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    for (const id of ['tu1', 'tu2', 'tu3']) {
      const n = spawnNext();
      const run = router.agentSpawn(f.engine, spawn({ tool_use_id: id }), n.next);
      await settle();
      n.controller.abort();
      await expect(run).rejects.toThrow('abandoned');
      expect(n.calls).toHaveLength(0);
    }
    key.resolve(FAKE_KEY);
    await settle();
    expect(reads).toBe(0);
    expect(f.sent).toHaveLength(0);

    const bare = createRouter(configOf(SPAWN_ONLY));
    const g = fakeEngine({ envKey: undefined });
    g.engine.pins = () => new Promise(() => {});
    g.engine.hostBase = () => new Promise(() => {});
    g.engine.availableModels = () => new Promise(() => {});
    bare.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const m = spawnNext();
    await bare.agentSpawn(g.engine, spawn(), m.next);
    expect(m.calls).toEqual([spawn()]);
    expect(g.logs).toContainEqual(expect.objectContaining({ event: 'spawn', skipped: 'key_missing' }));
  });

  it('forwards a spawn that could never be routed without waiting for the key', async () => {
    const router = createRouter(configOf({ ...SPAWN_ONLY, routeSubagentEffort: false }));
    const f = fakeEngine();
    f.engine.envKey = () => new Promise(() => {});
    const n = spawnNext();
    await router.agentSpawn(f.engine, spawn({ subagentType: 'code-reviewer' }), n.next);
    expect(n.calls).toEqual([spawn({ subagentType: 'code-reviewer' })]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', skipped: 'type_unverified' }));
  });

  it('never logs a spawn type it does not route, which is caller text', async () => {
    const router = createRouter(configOf({ ...SPAWN_ONLY, routeSubagentEffort: false }));
    const f = fakeEngine();
    const type = `sk-${'b'.repeat(24)}testonlynotakey`;
    const n = spawnNext();
    await router.agentSpawn(f.engine, spawn({ subagentType: type }), n.next);
    expect(n.calls).toEqual([spawn({ subagentType: type })]);
    expect(f.logs).toContainEqual({ event: 'spawn', tool_use_id: 'tu1', type: 'other', skipped: 'type_unverified' });
    expect(JSON.stringify(f.logs)).not.toContain(type);
  });

  it('records the model and agent a routed spawn resolved to', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const n = spawnNext(() => ({ model: 'claude-haiku-4-5', agentId: 'a1' }));
    await router.agentSpawn(f.engine, spawn(), n.next);
    expect(f.logs).toContainEqual({ event: 'spawn_result', tool_use_id: 'tu1', requested: 'claude-haiku-4-5-20251001', observed: 'claude-haiku-4-5', agent_id: 'a1' });
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

  it('verifies against the host release it was read from, and accepts later 2.1 releases', () => {
    expect(VERIFIED_HOST).toBe('2.1.282');
    expect(['2.1.282', '2.1.283', '2.1.300'].map(hostSupported)).toEqual([true, true, true]);
    expect(['2.1.281', '2.2.0', '2.1.283-dev', 'local', undefined].map(hostSupported)).toEqual([false, false, false, false, false]);
  });

  it('routes on a later 2.1 release', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ hostBase: '2.1.283', respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const n = spawnNext();
    expect(await router.agentSpawn(f.engine, spawn(), n.next)).toEqual({ model: 'claude-haiku-4-5-20251001' });
  });

  it('reports a mismatched spawn without stopping subsequent independent work', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', .95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5' })).next);
    const next = spawnNext();
    await router.agentSpawn(f.engine, spawn({ tool_use_id: 'independent' }), next.next);
    expect(next.calls[0]!.model).toBe('claude-haiku-4-5-20251001');
    expect(f.sent).toHaveLength(2);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn_result', reason: 'model_mismatch' }));
    expect(f.logs.some(l => l['event'] === 'spawn_suspended')).toBe(false);
  });

  it('does not suspend for a spawn a pin set during its assessment kept native, whatever Jev answered', async () => {
    for (const pick of ['fast', 'deep'] as const) {
      const router = createRouter(configOf(SPAWN_ONLY));
      const held = deferred<HttpReply>();
      const f = fakeEngine({ respond: () => held.promise });
      router.agentOffer(OFFER_BUILT_IN('general-purpose'));
      const run = router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-haiku-4-5' })).next);
      await vi.waitFor(() => expect(f.sent).toHaveLength(1));
      f.pins.subagentModel = true;
      held.resolve(answering({ ...CLEAR, tier: [pick, 0.95] })(f.sent[0]!) as HttpReply);
      await run;
      expect(f.logs.some((l) => l['event'] === 'spawn_native_result' || l['event'] === 'spawn_suspended'), pick).toBe(false);
    }
  });

  it('does not suspend for a spawn a pin kept native, which runs on the pinned model', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }), pins: { subagentModel: true } });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-haiku-4-5' })).next);
    expect(f.logs.some((l) => l['event'] === 'spawn_native_result' || l['event'] === 'spawn_suspended')).toBe(false);
    f.pins.subagentModel = false;
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const n = spawnNext(() => ({ model: 'claude-haiku-4-5' }));
    await router.agentSpawn(f.engine, spawn({ tool_use_id: 'tu2' }), n.next);
    expect(n.calls).toEqual([spawn({ tool_use_id: 'tu2', model: 'claude-haiku-4-5-20251001' })]);
  });
});

const CHILD = { routeMainEffort: false, routeMainModel: false, routeSubagentModel: true, routeSubagentEffort: true, routeExplicitSpawnModel: true };
/** A subagent loop's step: its own agentId and turn, on the model and effort it resolved to. */
const childStep = (over: Partial<TurnStepEvent> = {}): TurnStepEvent => step({ agentId: 'a1', turnId: 'c1', effort: 'xhigh', ...over });

describe('subagent effort and named models', () => {
  it("sets a subagent's effort from its spawn's one answer, on every step of its loop", async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['low', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const s = spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' }));
    await router.agentSpawn(f.engine, spawn(), s.next);
    // Deep work keeps Opus: the spawn is left on the model it inherits.
    expect(s.calls).toEqual([spawn()]);
    expect(Object.keys(f.sent[0]?.questions ?? {})).toEqual(expect.arrayContaining(['control', 'model', 'effort_0', 'action_risk']));
    expect(f.logs.find((l) => l['event'] === 'spawn')).toMatchObject({ reasons: { model: 'same_value', effort: 'selected' } });

    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep(), n.next));
    await drain(router.turnStep(f.engine, childStep({ index: 1 }), n.next));
    expect(n.calls).toEqual([childStep({ effort: 'low' }), childStep({ index: 1, effort: 'low' })]);
    expect(f.sent).toHaveLength(1);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'child', agent_id: 'a1', patch: 'low' }));

    // Another loop, and a step of a loop no routed spawn started, go on unchanged.
    const other = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep({ agentId: 'a2' }), other.next));
    expect(other.calls).toEqual([childStep({ agentId: 'a2' })]);
  });

  it('asks only about effort when the model cannot move, and keeps an effort pin', async () => {
    const router = createRouter(configOf({ ...CHILD, routeSubagentModel: false }));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['medium', 0.95] }) });
    const s = spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' }));
    await router.agentSpawn(f.engine, spawn({ subagentType: 'my-reviewer' }), s.next);
    expect(Object.keys(f.sent[0]?.questions ?? {})).toEqual(['effort_0', 'control', 'action_risk']);
    expect(s.calls).toEqual([spawn({ subagentType: 'my-reviewer' })]);

    f.pins.mainEffort = true;
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep(), n.next));
    expect(n.calls).toEqual([childStep()]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'child_stop', reason: 'effort_pinned' }));

    // With the effort pinned before the spawn, nothing is left to ask.
    const pinned = fakeEngine({ pins: { mainEffort: true }, respond: answering({ ...CLEAR, effort: ['medium', 0.95] }) });
    await router.agentSpawn(pinned.engine, spawn({ tool_use_id: 'tu2', subagentType: 'my-reviewer' }), spawnNext().next);
    expect(pinned.sent).toHaveLength(0);
  });

  it('routes mapped A while B is still spawning, and never revives completed native B from its late callback', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['medium', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    const result = deferred<SpawnOutcome>();
    let started = false;
    const next = Object.assign(async (_e: SpawnEvent) => { started = true; return result.promise; }, { signal: new AbortController().signal });
    const b = router.agentSpawn(f.engine, spawn({ tool_use_id: 'tu2' }), next);
    while (!started) await settle();
    const aStep = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep(), aStep.next));
    expect(aStep.calls).toEqual([childStep({ effort: 'medium' })]);
    const bStep = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep({ agentId: 'a2' }), bStep.next));
    router.turnComplete({ turnId: 'b', agentId: 'a2' });
    result.resolve({ model: 'claude-opus-5-5', agentId: 'a2' });
    await b;
    await drain(router.turnStep(f.engine, childStep({ agentId: 'a2' }), bStep.next));
    expect(bStep.calls).toEqual([childStep({ agentId: 'a2' }), childStep({ agentId: 'a2' })]);
  });

  it('starts an unmapped loop immediately and ignores a late spawn mapping', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['medium', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const started = deferred<SpawnOutcome>();
    let spawned = false;
    const s = spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' }));
    const next = Object.assign(
      async (e: SpawnEvent): Promise<SpawnOutcome> => {
        s.calls.push(e);
        spawned = true;
        return started.promise;
      },
      { signal: s.controller.signal },
    );
    const run = router.agentSpawn(f.engine, spawn(), next);
    while (!spawned) await settle();
    const n = streamNext<TurnStepEvent>();
    const first = drain(router.turnStep(f.engine, childStep(), n.next));
    await settle();
    expect(n.calls).toEqual([childStep()]);
    router.turnComplete({ turnId: 'child1', agentId: 'a1' });
    started.resolve({ model: 'claude-opus-5-5', agentId: 'a1' });
    await run;
    await first;
    expect(n.calls).toEqual([childStep()]);
    await drain(router.turnStep(f.engine, childStep(), n.next));
    expect(n.calls).toEqual([childStep(), childStep()]);
    await drain(router.turnStep(f.engine, childStep({ turnId: 'later' }), n.next));
    expect(n.calls.at(-1)).toEqual(childStep({ turnId: 'later' }));
  });

  it("leaves a loop native when its first step ran before the spawn's id arrived", async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['medium', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const started = deferred<SpawnOutcome>();
    let spawned = false;
    const s = spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' }));
    const next = Object.assign(
      async (e: SpawnEvent): Promise<SpawnOutcome> => {
        s.calls.push(e);
        spawned = true;
        return started.promise;
      },
      { signal: s.controller.signal },
    );
    const run = router.agentSpawn(f.engine, spawn(), next);
    while (!spawned) await settle();
    const n = streamNext<TurnStepEvent>();
    const first = drain(router.turnStep(f.engine, childStep(), n.next));
    await settle();
    // The wait runs out: the first step goes on at the effort it resolved to.
    f.expire();
    await first;
    started.resolve({ model: 'claude-opus-5-5', agentId: 'a1' });
    await run;
    // A lower effort from here would restart the cache the first step wrote.
    await drain(router.turnStep(f.engine, childStep({ index: 1 }), n.next));
    expect(n.calls).toEqual([childStep(), childStep({ index: 1 })]);
    expect(f.sent).toHaveLength(1);
  });

  it('keeps concurrent child effort answers independent of another spawn response mismatch', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', .95], effort: ['low', .95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    await router.agentSpawn(f.engine, spawn({ tool_use_id: 'other' }), spawnNext(() => ({ model: 'claude-sonnet-5', agentId: 'a2' })).next);
    const next = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep(), next.next));
    expect(next.calls).toEqual([childStep({ effort: 'low' })]);
    expect(f.sent).toHaveLength(2);
  });

  it('leaves a loop native once a step arrives on another effort or model, or its patch is answered by another model', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['low', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    await router.agentSpawn(f.engine, spawn({ tool_use_id: 'tu2' }), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a2' })).next);
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep(), n.next));
    await drain(router.turnStep(f.engine, childStep({ index: 1, effort: 'high' }), n.next));
    await drain(router.turnStep(f.engine, childStep({ index: 2 }), n.next));
    expect(n.calls).toEqual([childStep({ effort: 'low' }), childStep({ index: 1, effort: 'high' }), childStep({ index: 2 })]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'child_stop', agent_id: 'a1', reason: 'incoming_divergence' }));

    const fallback = streamNext<TurnStepEvent>(() => 'claude-sonnet-5');
    await drain(router.turnStep(f.engine, childStep({ agentId: 'a2' }), fallback.next));
    await drain(router.turnStep(f.engine, childStep({ agentId: 'a2', index: 1 }), fallback.next));
    expect(fallback.calls).toEqual([childStep({ agentId: 'a2', effort: 'low' }), childStep({ agentId: 'a2', index: 1, effort: 'low' })]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'child_result', agent_id: 'a2', confirmation: 'mismatch' }));
  });

  it("routes the model an Agent call names as a default, unless configured not to, and never a fork's", async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95], effort: ['low', 0.95] }) });
    const s = spawnNext();
    await router.agentSpawn(f.engine, spawn({ model: 'opus', subagentType: 'my-reviewer' }), s.next);
    expect(s.calls).toEqual([spawn({ model: 'claude-haiku-4-5-20251001', subagentType: 'my-reviewer' })]);
    expect(f.logs.find((l) => l['event'] === 'spawn')).toMatchObject({ explicit: true, from: 'claude-opus-5-5', patch: { model: 'claude-haiku-4-5-20251001' } });

    const kept = createRouter(configOf({ ...CHILD, routeExplicitSpawnModel: false, routeSubagentEffort: false }));
    const k = spawnNext();
    await kept.agentSpawn(f.engine, spawn({ model: 'opus' }), k.next);
    expect(k.calls).toEqual([spawn({ model: 'opus' })]);

    const forked = spawnNext();
    await router.agentSpawn(f.engine, spawn({ tool_use_id: 'tu3', fork: true }), forked.next);
    expect(forked.calls).toEqual([spawn({ tool_use_id: 'tu3', fork: true })]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', tool_use_id: 'tu3', skipped: 'fork' }));
  });

  it("preserves a spawn when its contract needs missing context or explicitly locks it", async () => {
    const router = createRouter(configOf(CHILD));
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const moved = fakeEngine({ respond: answering({ control: ['needs_context', 0.9], action_risk: ['ordinary', 0.97], tier: ['fast', 0.95] }) });
    const m = spawnNext();
    await router.agentSpawn(moved.engine, spawn(), m.next);
    expect(m.calls).toEqual([spawn()]);

    const locked = fakeEngine({ respond: answering({ control: ['explicit_lock', 0.9], action_risk: ['ordinary', 0.97], tier: ['fast', 0.95] }) });
    const l = spawnNext();
    await router.agentSpawn(locked.engine, spawn({ tool_use_id: 'tu2' }), l.next);
    expect(l.calls).toEqual([spawn({ tool_use_id: 'tu2' })]);
  });
});

describe('root effort and the prompt cache', () => {
  it('lowers effort only on a cold cache, holds it on a warm one, and always lets it rise', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    let pick: [string, number] = ['medium', 0.95];
    const f = fakeEngine({ respond: (req) => answering({ ...CLEAR, effort: pick })(req) });
    const n = streamNext<TurnStepEvent>();
    const turn = async (id: string, effort: [string, number], afterMs: number) => {
      pick = effort;
      f.clock.ms += afterMs;
      router.turnStart({ turnId: id, text: TEXT });
      await drain(router.turnStep(f.engine, step({ turnId: id, effort: 'xhigh' }), n.next));
      router.turnComplete({ turnId: id });
      return n.calls.at(-1)?.effort;
    };
    // The session's first turn writes its cache anyway.
    expect(await turn('t1', ['medium', 0.95], 0)).toBe('medium');
    // Ten minutes on, lower work is held at the effort the cache was written at.
    expect(await turn('t2', ['low', 0.95], 10 * 60_000)).toBe('medium');
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', turn: 't2', patch: expect.objectContaining({ effort: 'medium' }), held_for_cache: 'low' }));
    // Exceptional work rises to the baseline, paying the rewrite.
    expect(await turn('t3', ['xhigh', 0.95], 60_000)).toBe('xhigh');
    // Held at the baseline, nothing is sent.
    expect(await turn('t4', ['medium', 0.95], 60_000)).toBe('xhigh');
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', turn: 't4', patch: {}, held_for_cache: 'medium' }));
    // After an hour's pause the cache is cold again.
    expect(await turn('t5', ['low', 0.95], 60 * 60_000)).toBe('low');
    // A session's end forgets the cache.
    router.sessionEnd();
    expect(await turn('t6', ['medium', 0.95], 60_000)).toBe('medium');
  });

  it('keeps the effort of a turn that arrives at another one than the turn before, which may be a change by hand (#81)', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['medium', 0.95] }) });
    const n = streamNext<TurnStepEvent>();
    const turn = async (id: string, effort: SymbolicEffort) => {
      f.clock.ms += 60 * 60_000;
      router.turnStart({ turnId: id, text: TEXT });
      await drain(router.turnStep(f.engine, step({ turnId: id, effort }), n.next));
      router.turnComplete({ turnId: id });
      return n.calls.at(-1)?.effort;
    };
    expect(await turn('t1', 'xhigh')).toBe('medium');
    expect(f.sent).toHaveLength(1);
    // The session's effort went from xhigh to high between turns: this turn keeps it, and nothing is asked.
    expect(await turn('t2', 'high')).toBe('high');
    expect(f.sent).toHaveLength(1);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', turn: 't2', effort_kept: 'incoming_changed', skipped: 'no_alternative' }));
    // At the same effort again, the next turn is routed as before.
    expect(await turn('t3', 'high')).toBe('medium');
    expect(f.sent).toHaveLength(2);
    // A session's end forgets the last turn's effort.
    router.sessionEnd();
    expect(await turn('t4', 'low')).toBe('medium');
  });

  it('takes a step that got no response, or another model, as leaving no warm cache', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step({ turnId: 't1' }), streamNext<TurnStepEvent>(null).next));
    router.turnStart({ turnId: 't2', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ turnId: 't2' }), n.next));
    expect(n.calls).toEqual([step({ turnId: 't2', effort: 'low' })]);

    router.turnStart({ turnId: 't3', text: TEXT });
    const sonnet = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ turnId: 't3', model: 'claude-sonnet-5' }), sonnet.next));
    expect(sonnet.calls).toEqual([step({ turnId: 't3', model: 'claude-sonnet-5', effort: 'low' })]);
  });
});

describe('root effort and the prompt cache: the model that answered', () => {
  it('takes a response from another model as no warm cache on the one asked', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    let pick: [string, number] = ['xhigh', 0.95];
    const f = fakeEngine({ respond: (req) => answering({ ...CLEAR, effort: pick })(req) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step({ turnId: 't1', effort: 'xhigh' }), streamNext<TurnStepEvent>(() => 'claude-sonnet-5').next));
    router.turnComplete({ turnId: 't1' });
    pick = ['low', 0.95];
    router.turnStart({ turnId: 't2', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ turnId: 't2', effort: 'xhigh' }), n.next));
    expect(n.calls).toEqual([step({ turnId: 't2', effort: 'low' })]);
    expect(f.logs.some((l) => 'held_for_cache' in l)).toBe(false);
  });
});

describe('root context', () => {
  it("sends the conversation's last visible reply with the next root turn, and forgets it when the session ends", async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['medium', 0.95] }) });
    const replying = (answer: string) =>
      Object.assign(
        async function* (e: TurnStepEvent): AsyncGenerator<string, { answer: string; usage: { model: string } }> {
          yield 'chunk';
          return { answer, usage: { model: e.model } };
        },
        { signal: new AbortController().signal },
      );
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step(), replying('Renamed. Shall I also update the docs?')));
    router.turnComplete({ turnId: 't1', reason: 'answer', answer: 'Renamed. Shall I also update the docs?' });
    router.turnStart({ turnId: 't2', text: 'ㅇㅇ' });
    await drain(router.turnStep(f.engine, step({ turnId: 't2' }), replying('')));
    expect(f.sent[0]?.state).toMatchObject({ task: { text: TEXT, source: 'current_human_request' } });
    expect(f.sent[1]?.state).toMatchObject({ task: { text: 'ㅇㅇ', previous_reply: 'Renamed. Shall I also update the docs?', previous_reply_source: 'completed_visible_assistant_reply', previous_reply_truncated: false, recent_requests: [{ text: TEXT, source: 'recent_human_request', truncated: false }] } });

    router.sessionEnd();
    router.turnStart({ turnId: 't3', text: 'ㅇㅇ' });
    await drain(router.turnStep(f.engine, step({ turnId: 't3' }), replying('')));
    expect(f.sent[2]?.state).toMatchObject({ task: { text: 'ㅇㅇ', recent_requests: [] } });
    expect((f.sent[2]?.state as { task: object }).task).not.toHaveProperty('previous_reply');
  });

  it('screens the whole reply before keeping its tail, and carries none of a screened one', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['medium', 0.95] }) });
    const replying = (answer: string) =>
      Object.assign(
        async function* (e: TurnStepEvent): AsyncGenerator<string, { answer: string; usage: { model: string } }> {
          yield 'chunk';
          return { answer, usage: { model: e.model } };
        },
        { signal: new AbortController().signal },
      );
    // The key's header falls outside the kept tail; the tail alone passes the screen.
    const key = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(2200)}\n-----END PRIVATE KEY-----`;
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step(), replying(key)));
    router.turnComplete({ turnId: 't1', reason: 'answer', answer: key });
    router.turnStart({ turnId: 't2', text: 'Continue' });
    await drain(router.turnStep(f.engine, step({ turnId: 't2' }), replying('')));
    expect(f.sent[1]?.state).toMatchObject({ task: { text: 'Continue' } });
    expect((f.sent[1]?.state as { task: object }).task).not.toHaveProperty('previous_reply');
    expect(JSON.stringify(f.sent)).not.toContain('AAAA');
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
    expect(n.calls).toEqual([]);

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
    expect(await router.agentSpawn(engine, spawn(), ok.next)).toEqual({ model: 'claude-haiku-4-5-20251001' });
    const failure = new Error('native spawn failed');
    const bad = spawnNext(() => {
      throw failure;
    });
    await expect(router.agentSpawn(engine, spawn({ tool_use_id: 'tu2' }), bad.next)).rejects.toBe(failure);
    expect(bad.calls).toEqual([{ ...spawn({ tool_use_id: 'tu2' }), model: 'claude-haiku-4-5-20251001' }]);
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

describe('#42 and #43: handler cases the issues list', () => {
  it('moves an inheriting built-in up from a verified lower baseline on the upgrade floor, below the downgrade floor', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    // 0.85 clears the upgrade floor (0.8) and not the downgrade floor (0.9), so only the upgrade floor can move it.
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.85] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const n = spawnNext();
    const e = spawn({ parentModel: 'claude-haiku-4-5' });
    await router.agentSpawn(f.engine, e, n.next);
    expect(n.calls).toEqual([{ ...e, model: 'claude-opus-5-5' }]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', from: 'claude-haiku-4-5', patch: { model: 'claude-opus-5-5' } }));
  });

  it('forwards a spawn once, natively, when its assessment times out, and a late reply changes nothing', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const reply = deferred<HttpReply>();
    // The first assessment hangs; the next dispatch gets its own, which keeps the parent's model.
    const f = fakeEngine({ respond: (req) => (f.sent.length === 1 ? reply.promise : answering({ ...CLEAR, tier: ['deep', 0.95] })(req)) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const n = spawnNext();
    const run = router.agentSpawn(f.engine, spawn(), n.next);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.expire();
    await run;
    expect(n.calls).toEqual([spawn()]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', assessment: 'timeout', sent: true }));
    expect(f.logs.some((l) => l['event'] === 'late')).toBe(false);
    reply.resolve(answering({ ...CLEAR, tier: ['fast', 0.95] })(f.sent[0]!) as HttpReply);
    await vi.waitFor(() => expect(f.logs).toContainEqual(expect.objectContaining({ event: 'late', scope: 'spawn', tool_use_id: 'tu1' })));
    expect(n.calls).toHaveLength(1);
    // The late 'fast' answer is not carried into the next dispatch: it is assessed on its own and stays on its parent's model.
    const second = spawn({ tool_use_id: 'tu2' });
    await router.agentSpawn(f.engine, second, n.next);
    expect(f.sent).toHaveLength(2);
    expect(n.calls).toEqual([spawn(), second]);
  });

  it('sends nothing for a spawn whose prompt or description carries a credential, and leaves it native', async () => {
    const secret = `sk-${'c'.repeat(24)}testonlynotakey`;
    for (const e of [spawn({ prompt: `Call the API with ${secret} and list the results.` }), spawn({ description: `use ${secret}` })]) {
      const router = createRouter(configOf(SPAWN_ONLY));
      const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
      router.agentOffer(OFFER_BUILT_IN('general-purpose'));
      const n = spawnNext();
      await router.agentSpawn(f.engine, e, n.next);
      expect(n.calls).toEqual([e]);
      expect(f.sent).toHaveLength(0);
      expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', assessment: 'input_secret', sent: false }));
      expect(JSON.stringify(f.logs)).not.toContain(secret);
    }
  });

  it('leaves a spawn native when only its description carries a Lean marker', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const n = spawnNext();
    const e = spawn({ description: 'execute jev-lean-0123456789abcdef' });
    await router.agentSpawn(f.engine, e, n.next);
    expect(n.calls).toEqual([e]);
    expect(f.sent).toHaveLength(0);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', skipped: 'lean_marker' }));
  });

  it('records an effort-only root decision with the step it came from, its Jev usage and its result', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const counts = { input_tokens: 700, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    await drain(router.turnStep(f.engine, step(), streamNext<TurnStepEvent>(() => 'claude-opus-5-5', counts).next));
    const root = f.logs.find((l) => l['event'] === 'root');
    expect(root).toMatchObject({ turn: 't1', sent: true, from: { model: 'claude-opus-5-5', effort: 'high' }, patch: { effort: 'low' } });
    // Jev's own usage, as the fake response reported it (answering's default), and the step's usage, as the stream did.
    expect(root?.['usage']).toMatchObject({ input: 900, output: 40 });
    expect(f.logs).toContainEqual(
      expect.objectContaining({ event: 'root_result', turn: 't1', index: 0, applied: expect.objectContaining({ effort: 'low' }), observed: 'claude-opus-5-5', usage: expect.objectContaining({ input: 700, output: 30 }) }),
    );
  });

  it('#42: a known model that no profile names routes its effort and withholds only the model question', async () => {
    // Opus is an exact model the table knows, so its efforts are known; no configured profile is Opus, so its rank is not.
    const router = createRouter(configOf({ routeMainEffort: true, routeMainModel: true, routeSubagentModel: false, fastModel: 'claude-haiku-4-5', standardModel: 'claude-sonnet-5', deepModel: 'claude-fable-5-1' }), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95], tier: ['fast', 0.99] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step(), n.next));
    expect(n.calls).toEqual([{ ...step(), effort: 'low' }]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.questions).toHaveProperty('model');
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', model_asked: true, patch: expect.objectContaining({ effort: 'low' }) }));
  });

  it('#42: a conditional level the model cannot take is not offered, and a lower unconditional one still applies', async () => {
    // Sonnet takes xhigh only conditionally; the step starts there, and the unconditional levels below it stay routable.
    // The handler asks about three described levels and maps them locally, so the offered set is read where it is made.
    expect(offerableEfforts({ model: 'claude-sonnet-5', effort: 'xhigh' })).toEqual(['low', 'medium', 'high']);
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    const sonnet = step({ model: 'claude-sonnet-5', effort: 'xhigh' });
    await drain(router.turnStep(f.engine, sonnet, n.next));
    expect(f.sent).toHaveLength(1);
    expect(n.calls).toEqual([{ ...sonnet, effort: 'low' }]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', sent: true, patch: expect.objectContaining({ effort: 'low' }) }));

    // The conditional level is what excludes a candidate: Opus at xhigh cannot move to Sonnet and keep xhigh, but can
    // with the lower level Sonnet takes unconditionally, answered in the same request.
    const both = createRouter(configOf({ ...MODEL_ONLY, routeMainEffort: true }), SWITCHES);
    const keep = fakeEngine({ respond: answering({ ...CLEAR, tier: ['standard', 0.95], effort: ['xhigh', 0.95] }) });
    both.turnStart({ turnId: 't1', text: TEXT });
    const k = streamNext<TurnStepEvent>();
    await drain(both.turnStep(keep.engine, step({ effort: 'xhigh' }), k.next));
    expect(k.calls).toEqual([step({ effort: 'xhigh' })]);
    expect(keep.logs.find((l) => l['event'] === 'root')).toMatchObject({ reasons: { model: 'pair_invalid' } });

    const lower = createRouter(configOf({ ...MODEL_ONLY, routeMainEffort: true }), SWITCHES);
    const low = fakeEngine({ respond: answering({ ...CLEAR, tier: ['standard', 0.95], effort: ['low', 0.95] }) });
    lower.turnStart({ turnId: 't1', text: TEXT });
    const l = streamNext<TurnStepEvent>();
    await drain(lower.turnStep(low.engine, step({ effort: 'xhigh' }), l.next));
    expect(l.calls).toEqual([step({ model: 'claude-sonnet-5', effort: 'low' })]);
  });
});

describe('#81: control correctness', () => {
  it('asks nothing for the effort of a subagent whose model is known to take none, while a pin or remap keeps it unknown', async () => {
    const cases: Array<[SpawnEvent, Record<string, boolean>]> = [
      [spawn({ model: 'claude-haiku-4-5-20251001' }), { routeExplicitSpawnModel: false }],
      [spawn({ model: 'claude-haiku-4-5' }), { routeSubagentModel: false }],
      [spawn({ parentModel: 'claude-haiku-4-5-20251001' }), { routeSubagentModel: false }],
    ];
    for (const [e, options] of cases) {
      const router = createRouter(configOf({ ...CHILD, ...options }));
      const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
      router.agentOffer(OFFER_BUILT_IN('general-purpose'));
      const s = spawnNext(() => ({ model: 'claude-haiku-4-5', agentId: 'a1' }));
      await router.agentSpawn(f.engine, e, s.next);
      expect(s.calls, JSON.stringify(e)).toEqual([e]);
      expect(f.sent, JSON.stringify(e)).toHaveLength(0);
    }
    // A remapped alias no longer names Haiku, so its effort is still asked.
    const router = createRouter(configOf({ ...CHILD, routeExplicitSpawnModel: false }));
    const remapped = fakeEngine({ pins: { aliasRemap: true }, respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    remapped.engine.modelAliases = async () => ({ haiku: 'claude-opus-5-5' });
    await router.agentSpawn(remapped.engine, spawn({ model: 'haiku' }), spawnNext().next);
    expect(Object.keys(remapped.sent[0]?.questions ?? {})).toEqual(['effort_0', 'control', 'action_risk']);
  });

  it("keeps a subagent's answer to its own run: a later run under a new turn id goes native", async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['low', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep(), n.next));
    // A SendMessage continuation: the same subagent, another task.
    await drain(router.turnStep(f.engine, childStep({ turnId: 'c2' }), n.next));
    await drain(router.turnStep(f.engine, childStep({ turnId: 'c2', index: 1 }), n.next));
    expect(n.calls).toEqual([childStep({ effort: 'low' }), childStep({ turnId: 'c2' }), childStep({ turnId: 'c2', index: 1 })]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'child_stop', agent_id: 'a1', reason: 'next_turn' }));
    expect(f.sent).toHaveLength(1);
  });

  it('never sends the override again once a patched request failed, at the root or in a subagent', async () => {
    const failing = () => {
      const calls: TurnStepEvent[] = [];
      const next = Object.assign(
        async function* (e: TurnStepEvent): AsyncGenerator<string, { usage: null }> {
          calls.push(e);
          yield 'chunk';
          throw new Error('overloaded');
        },
        { signal: new AbortController().signal },
      );
      return { calls, next };
    };
    const root = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    root.turnStart({ turnId: 't1', text: TEXT });
    const bad = failing();
    await expect(drain(root.turnStep(f.engine, step(), bad.next))).rejects.toThrow('overloaded');
    const retry = streamNext<TurnStepEvent>();
    await drain(root.turnStep(f.engine, step(), retry.next));
    await drain(root.turnStep(f.engine, step({ index: 1 }), retry.next));
    expect(bad.calls).toEqual([{ ...step(), effort: 'low' }]);
    expect(retry.calls).toEqual([step(), step({ index: 1 })]);
    expect(f.logs).toContainEqual({ event: 'root_stop', turn: 't1', index: 0, reason: 'step_failed' });

    const spawns = createRouter(configOf(CHILD));
    const g = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['low', 0.95] }) });
    spawns.agentOffer(OFFER_BUILT_IN('general-purpose'));
    await spawns.agentSpawn(g.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    const childBad = failing();
    await expect(drain(spawns.turnStep(g.engine, childStep(), childBad.next))).rejects.toThrow('overloaded');
    const childRetry = streamNext<TurnStepEvent>();
    await drain(spawns.turnStep(g.engine, childStep(), childRetry.next));
    expect(childBad.calls).toEqual([childStep({ effort: 'low' })]);
    expect(childRetry.calls).toEqual([childStep()]);
    expect(g.logs).toContainEqual(expect.objectContaining({ event: 'child_stop', agent_id: 'a1', reason: 'step_failed' }));
  });

  it("passes every chunk and the exact result through, calls next once, and lets a cancellation end the host's stream", async () => {
    const router = createRouter(configOf({ ...EFFORT_ONLY, routeSubagentModel: true }));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95], tier: ['fast', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const outcome = { usage: { model: 'claude-opus-5-5' }, answer: 'done' };
    const calls: TurnStepEvent[] = [];
    let closed = false;
    const next = Object.assign(
      async function* (e: TurnStepEvent): AsyncGenerator<string, typeof outcome> {
        calls.push(e);
        try {
          yield 'a';
          yield 'b';
          yield 'c';
          return outcome;
        } finally {
          closed = true;
        }
      },
      { signal: new AbortController().signal },
    );
    const { chunks, result } = await drain(router.turnStep(f.engine, step(), next));
    expect(chunks).toEqual(['a', 'b', 'c']);
    expect(result).toBe(outcome);
    expect(calls).toHaveLength(1);

    closed = false;
    const gen = router.turnStep(f.engine, step({ index: 1 }), next);
    expect((await gen.next()).value).toBe('a');
    expect(await gen.return(undefined)).toEqual({ done: true, value: undefined });
    expect(closed).toBe(true);
    expect(calls).toHaveLength(2);

    // A spawn's denial is returned as the host gave it.
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const denial = { deny: 'policy' };
    const denied = spawnNext(() => denial);
    expect(await router.agentSpawn(f.engine, spawn(), denied.next)).toBe(denial);
    expect(denied.calls).toHaveLength(1);
  });

  it('keeps two concurrent subagents on their own answers', async () => {
    const router = createRouter(configOf(CHILD));
    const hold = deferred<void>();
    const f = fakeEngine({
      respond: async (req) => {
        const text = (req.state as { task: { text: string } }).task.text;
        if (text === 'first') await hold.promise;
        return answering({ ...CLEAR, tier: ['deep', 0.95], effort: text === 'first' ? ['low', 0.95] : ['medium', 0.95] })(req);
      },
    });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const runA = router.agentSpawn(f.engine, spawn({ prompt: 'first' }), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    // The second spawn is answered and started while the first still waits on Jev.
    await router.agentSpawn(f.engine, spawn({ tool_use_id: 'tu2', prompt: 'second' }), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a2' })).next);
    const b = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep({ agentId: 'a2', turnId: 'c2' }), b.next));
    hold.resolve();
    await runA;
    const a = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep(), a.next));
    await drain(router.turnStep(f.engine, childStep({ agentId: 'a2', turnId: 'c2', index: 1 }), b.next));
    await drain(router.turnStep(f.engine, childStep({ index: 1 }), a.next));
    expect(a.calls).toEqual([childStep({ effort: 'low' }), childStep({ index: 1, effort: 'low' })]);
    expect(b.calls).toEqual([childStep({ agentId: 'a2', turnId: 'c2', effort: 'medium' }), childStep({ agentId: 'a2', turnId: 'c2', index: 1, effort: 'medium' })]);
  });

  it('records a requested effort as requested, and the effort it ran at as unknown', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step(), streamNext<TurnStepEvent>().next));
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root_result', applied: expect.objectContaining({ effort: 'low' }), observed: 'claude-opus-5-5', observed_effort: 'unknown' }));
  });
});

describe('complete preparation budget and cache feasibility (#111)', () => {
  it.each([
    ['xhigh', 'high', 'low', {}],
    ['xhigh', 'low', 'high', { effort: 'high' }],
    ['medium', 'high', 'low', { effort: 'medium' }],
    ['xhigh', 'xhigh', 'low', {}],
    [null, 'xhigh', 'high', { effort: 'high' }],
  ] as const)('applies warm/native/proposed %s %s %s without exceeding the native floor', (warm, native, want, expected) => {
    expect(cachePatch({ model: 'claude-opus-5-5', effort: native }, warm, { effort: want }).patch).toEqual(expected);
    expect(cachePatch({ model: 'claude-opus-5-5', effort: native }, warm, {}).patch).toEqual({});
  });
  it('forwards each timed-out dispatch once and does not start HTTP when a shared key finally arrives', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine();
    const key = deferred<string | undefined>();
    let reads = 0;
    f.engine.envKey = () => {
      reads++;
      return key.promise;
    };
    for (let i = 0; i < 10; i++) {
      const id = `budget${i}`;
      router.turnStart({ turnId: id, text: TEXT });
      const n = streamNext<TurnStepEvent>();
      const run = drain(router.turnStep(f.engine, step({ turnId: id }), n.next));
      await settle();
      f.expire();
      await run;
      expect(n.calls).toEqual([step({ turnId: id })]);
    }
    expect(reads).toBe(1);
    key.resolve(FAKE_KEY);
    await settle();
    expect(f.sent).toHaveLength(0);
    expect(f.logs.filter((x) => x.event === 'budget_timeout')).toHaveLength(10);
  });
  it('reentry into a pending turn shares its original deadline', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine();
    const key = deferred<string | undefined>();
    f.engine.envKey = () => key.promise;
    const waits: number[] = [];
    const sleep = f.engine.sleep;
    f.engine.sleep = (ms, s) => {
      waits.push(ms);
      return sleep(ms, s);
    };
    router.turnStart({ turnId: 't1', text: TEXT });
    const a = streamNext<TurnStepEvent>(),
      b = streamNext<TurnStepEvent>();
    const first = drain(router.turnStep(f.engine, step(), a.next));
    await settle();
    f.clock.ms = 400;
    const second = drain(router.turnStep(f.engine, step(), b.next));
    await settle();
    expect(waits).toEqual([800, 400]);
    f.expire();
    await Promise.all([first, second]);
    expect(a.calls).toEqual([step()]);
    expect(b.calls).toEqual([step()]);
    key.resolve(FAKE_KEY);
    await settle();
    expect(f.sent).toHaveLength(0);
  });
  it('bounds stalled pins and version reads without launching duplicate host reads', async () => {
    for (const stage of ['pins', 'version', 'settings'] as const) {
      const router = createRouter(configOf(SPAWN_ONLY));
      const f = fakeEngine();
      let reads = 0;
      if (stage === 'pins')
        f.engine.pins = () => {
          reads++;
          return new Promise(() => {});
        };
      else if (stage === 'version')
        f.engine.hostBase = () => {
          reads++;
          return new Promise(() => {});
        };
      else f.engine.availableModels = () => { reads++; return new Promise(() => {}); };
      router.agentOffer(OFFER_BUILT_IN('general-purpose'));
      for (let i = 0; i < 5; i++) {
        const n = spawnNext();
        const e = spawn({ tool_use_id: `${stage}${i}` });
        const run = router.agentSpawn(f.engine, e, n.next);
        await settle();
        f.expire();
        await run;
        expect(n.calls).toEqual([e]);
      }
      expect(reads).toBe(stage === 'settings' ? 5 : 1);
      expect(f.sent).toHaveLength(0);
    }
  });
  it('does not keep a preparation timer during the native stream', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    const gen = router.turnStep(f.engine, step(), n.next);
    expect((await gen.next()).value).toBe('chunk');
    f.expire();
    await gen.next();
    expect(n.calls).toEqual([step({ effort: 'low' })]);
    expect(f.logs.some((x) => x.event === 'budget_timeout')).toBe(false);
  });
});

describe('elapsed preparation deadline', () => {
  it('allows only the remaining 200ms after 600ms of key preparation, and records late usage without applying it', async () => {
    vi.useFakeTimers();
    try {
      const router = createRouter(configOf(EFFORT_ONLY));
      const key = deferred<string | undefined>(),
        reply = deferred<HttpReply>();
      const f = fakeEngine({ respond: () => reply.promise });
      f.engine.envKey = () => key.promise;
      f.engine.now = () => Date.now();
      f.engine.sleep = (ms, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      router.turnStart({ turnId: 't1', text: TEXT });
      const n = streamNext<TurnStepEvent>();
      const run = drain(router.turnStep(f.engine, step(), n.next));
      await vi.advanceTimersByTimeAsync(600);
      key.resolve(FAKE_KEY);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(199);
      expect(n.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await run;
      expect(n.calls).toEqual([step()]);
      expect(router.inFlight()).toBe(1);
      reply.resolve(answering({ ...CLEAR, effort: ['low', 0.95] })(f.sent[0]!) as HttpReply);
      await vi.advanceTimersByTimeAsync(0);
      expect(router.inFlight()).toBe(0);
      expect(n.calls).toHaveLength(1);
      expect(f.logs).toContainEqual(expect.objectContaining({ event: 'late', turn: 't1', usage: { input: 900, output: 40 } }));
    } finally {
      vi.useRealTimers();
    }
  });
  it('stops a stored root override permanently when its final mutable pin read exceeds the budget', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step(), streamNext<TurnStepEvent>().next));
    const pins = f.engine.pins,
      gate = deferred<Awaited<ReturnType<typeof pins>>>();
    f.engine.pins = () => gate.promise;
    const n = streamNext<TurnStepEvent>();
    const run = drain(router.turnStep(f.engine, step({ index: 1 }), n.next));
    await settle();
    f.expire();
    await run;
    gate.resolve(await pins());
    await settle();
    await drain(router.turnStep(f.engine, step({ index: 2 }), n.next));
    expect(n.calls).toEqual([step({ index: 1 }), step({ index: 2 })]);
    expect(f.sent).toHaveLength(1);
  });
});

describe('bounded child history question feasibility (#140)', () => {
  const saturate = (r: ReturnType<typeof createRouter>) => {
    for (let i = 0; i < 65; i++) r.turnComplete({ turnId: `finished-${i}`, agentId: `native-${i}` });
  };
  it('skips saturated effort-only spawn before key or host preparation', async () => {
    const router = createRouter(configOf({ ...CHILD, routeSubagentModel: false }));
    const f = fakeEngine();
    const key = vi.spyOn(f.engine, 'envKey');
    const pins = vi.spyOn(f.engine, 'pins');
    saturate(router);
    const n = spawnNext();
    await router.agentSpawn(f.engine, spawn(), n.next);
    expect(n.calls).toEqual([spawn()]);
    expect(f.sent).toHaveLength(0);
    expect(key).not.toHaveBeenCalled();
    expect(pins).not.toHaveBeenCalled();
  });
  it('keeps model routing without asking effort after saturation', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['standard', 0.95], effort: ['low', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    saturate(router);
    const n = spawnNext(e => ({ model: e.model ?? 'claude-opus-5-5', agentId: 'new-child' }));
    await router.agentSpawn(f.engine, spawn(), n.next);
    expect(f.sent).toHaveLength(1);
    expect(Object.keys(f.sent[0]!.questions)).toEqual(['model', 'control', 'action_risk']);
    expect(n.calls[0]!.model).toBe('claude-sonnet-5');
  });
  it.each(['key', 'pins'])('rechecks saturation after pending %s preparation', async phase => {
    const router = createRouter(configOf({ ...CHILD, routeSubagentModel: false }));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    const pending = deferred<void>();
    if (phase === 'key') f.engine.envKey = async () => { await pending.promise; return FAKE_KEY; };
    else { const pins = f.engine.pins; f.engine.pins = async () => { await pending.promise; return pins(); }; }
    const n = spawnNext(); const run = router.agentSpawn(f.engine, spawn(), n.next);
    await settle(); saturate(router); pending.resolve(); await run;
    expect(f.sent).toHaveLength(0); expect(n.calls).toEqual([spawn()]);
  });
  it('keeps an independently valid model after saturation during HTTP without registering effort', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: req => { saturate(router); return answering({ ...CLEAR, tier: ['standard', 0.95], effort: ['low', 0.95] })(req); } });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const n = spawnNext(e => ({ model: e.model ?? 'claude-opus-5-5', agentId: 'a1' }));
    await router.agentSpawn(f.engine, spawn(), n.next);
    expect(f.sent).toHaveLength(1); expect(n.calls[0]!.model).toBe('claude-sonnet-5');
    const stepNext = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep({ model: 'claude-haiku-4-5' }), stepNext.next));
    expect(stepNext.calls[0]!.effort).toBe('xhigh');
    expect(f.logs.some(l => l['event'] === 'spawn' && l['sent'] === true)).toBe(true);
  });
  it('keeps old mappings and resets saturation only for a new session', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['low', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    saturate(router);
    const n = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, childStep(), n.next));
    expect(n.calls[0]!.effort).toBe('low');
    router.sessionEnd(); router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    await router.agentSpawn(f.engine, spawn(), spawnNext().next);
    expect(f.sent.at(-1)!.questions).toHaveProperty('effort_0');
  });
  it('keeps necessary pin checks but sends no question when the model is pinned', async () => {
    const router = createRouter(configOf(CHILD)); const f = fakeEngine({ pins: { subagentModel: true } });
    router.agentOffer(OFFER_BUILT_IN('general-purpose')); saturate(router);
    const n = spawnNext(); await router.agentSpawn(f.engine, spawn(), n.next);
    expect(f.sent).toHaveLength(0); expect(n.calls).toEqual([spawn()]);
  });

  it('ignores an extra unasked effort answer in a valid model-only response', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: async req => {
      const response = await answering({ ...CLEAR, tier: ['standard', 0.95] })(req);
      const body = JSON.parse(response.text); body.answers.effort = { type: 'score', probabilities: { invalid: 1 } };
      return { ...response, text: JSON.stringify(body) };
    } });
    router.agentOffer(OFFER_BUILT_IN('general-purpose')); saturate(router);
    const n = spawnNext(); await router.agentSpawn(f.engine, spawn(), n.next);
    expect(n.calls[0]!.model).toBe('claude-sonnet-5');
    expect(f.sent[0]!.questions).not.toHaveProperty('effort');
    expect(f.logs.find(l => l['event'] === 'spawn')?.['assessment']).toBe('ok');
  });

});
