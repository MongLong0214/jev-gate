import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { HttpReply } from '../../mods/router/hooks/client.ts';
import { JEV_ENDPOINT, JEV_MODEL } from '../../mods/router/hooks/client.ts';
import { resolveConfig } from '../../mods/router/hooks/config.ts';
import type { SymbolicEffort } from '../../mods/router/hooks/models.ts';
import { offerableEfforts, TIER_LEVELS } from '../../mods/router/hooks/policy.ts';
import type { RootRecord, SpawnEvent, SpawnOutcome, TurnStepEvent } from '../../mods/router/hooks/router.ts';
import { cachePatch, createRouter, hostSupported, ROUTER_HOOK_VERSION, VERIFIED_HOST } from '../../mods/router/hooks/router.ts';
import { sessionFacts } from '../../src/bench/ab.js';
import { buildOperations } from '../../src/operations.js';
import type { Responder } from './fake-engine.ts';
import { answering, choice, CLEAR, deferred, drain, FAKE_KEY, fakeEngine, streamNext, warmRoot } from './fake-engine.ts';

const configOf = (options: Record<string, string | number | boolean>) => {
  const r = resolveConfig({ enabled: true, allowFable: true, ...options });
  if (!r.ok) throw new Error(`invalid option ${r.field}`);
  return r.config;
};

/** Each switch alone; the subagent-effort and named-model switches, on by default, get their own cases below. */
const SUBAGENT_OFF = { routeSubagentEffort: false, routeExplicitSpawnModel: false };
const EFFORT_ONLY = { routeMainEffort: true, routeMainModel: false, routeSubagentModel: false, ...SUBAGENT_OFF };
const FULL_IDS = { fastModel: 'claude-haiku-5-5', standardModel: 'claude-sonnet-5-5', deepModel: 'claude-opus-5-5', frontierModel: 'claude-fable-5-1' };
const MODEL_ONLY = { routeMainEffort: false, routeMainModel: true, routeSubagentModel: false, ...SUBAGENT_OFF, ...FULL_IDS };
const SPAWN_ONLY = { routeMainEffort: false, routeMainModel: false, routeSubagentModel: true, ...SUBAGENT_OFF, routeSubagentEffort: true };
/** Explicit switch overrides used by tests that constrain the root-model path. */
const SWITCHES = ([
  ['claude-sonnet-5-5', 'claude-opus-5-5'],
  ['claude-opus-5-5', 'claude-sonnet-5-5'],
  ['claude-sonnet-5-5', 'claude-fable-5-1'],
  ['claude-sonnet-5-5', 'claude-haiku-5-5'],
] as const).map(([from, to]) => ({ from, to }));

const TEXT = 'Rename the helper parseRow to parseRecord in src/rows.ts and update its two callers.';
const step = (over: Partial<TurnStepEvent> = {}): TurnStepEvent => ({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', ...over });

const settle = () => new Promise((r) => setTimeout(r, 0));
describe('root window compatibility at the current request', () => {
  it.each(['native_default', 'native_echo', 'conditional_haiku_echo', 'conditional_haiku_default'] as const)('reassesses three root turns and reuses only the current turn: %s', async mode => {
    let phase = 0;
    // An echoed pair mid-session is the person's own /model: the host moves its main loop by itself only on a resume.
    const targets = ['claude-sonnet-5-5', mode.startsWith('conditional') ? 'claude-haiku-5-5' : 'claude-sonnet-5-5', 'claude-opus-5-5'];
    const router = createRouter(configOf({ routeMainModel: true, routeMainEffort: true, ...SUBAGENT_OFF }));
    const roles = ['standard', mode.startsWith('conditional') ? 'fast' : 'standard', 'deep'];
    const f = fakeEngine({ hostBase: '2.1.293', respond: req => answering({ control: ['task_clear', .99], action_risk: ['ordinary', .99], tier: [roles[phase]!, .99], effort: [phase < 2 ? 'low' : 'high', .99] })(req) });
    // A complete current-request bound and compatible transform are synthetic capabilities, not Claude host evidence.
    f.engine.currentContextBound = async (turnId, index) => ({ turnId, index, inputUpperBound: 20_000, compatible: true });
    f.engine.currentEffort = async () => undefined;
    await warmRoot(router, f, 'claude-sonnet-5-5', 'high');
    const counts = { input_tokens: 900, output_tokens: 50, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 1000 };
    const echoed: string[] = [];
    for (phase = 0; phase < 3; phase++) {
      const turnId = `turn-${phase}`;
      const model = phase === 0 || mode.endsWith('default') ? 'claude-opus-5-5' : echoed[phase - 1]!;
      const e = { turnId, index: 0, model, effort: phase === 0 || mode.endsWith('default') ? 'high' as const : 'low' as const };
      router.turnStart({ turnId, text: phase === 0 ? 'Find the exact helper file.' : phase === 1 ? 'Find the exact caller file.' : 'Continue: diagnose the concurrency failure and fix it without changing the API.' });
      // From the person's warm Sonnet, a cold Haiku repays its cache write within a turn's requests (#271).
      const expected = { ...e, model: targets[phase]!, effort: phase < 2 ? 'low' : 'high' };
      echoed.push(expected.model);
      const first = streamNext<TurnStepEvent>(undefined, counts);
      await drain(router.turnStep(f.engine, e, first.next));
      expect(first.calls).toEqual([expected]);
      const later = streamNext<TurnStepEvent>(undefined, counts);
      await drain(router.turnStep(f.engine, { ...e, index: 1 }, later.next));
      expect(later.calls).toEqual([{ ...expected, index: 1 }]);
      expect(f.sent).toHaveLength(phase + 1);
      router.turnComplete({ turnId, reason: 'answer', answer: 'Observed result.' });
    }
    expect(f.logs.filter(l => l.event === 'root').map(l => l.turn)).toEqual(['turn-0', 'turn-1', 'turn-2']);
    const roots = f.logs.filter(l => l.event === 'root');
    if (mode === 'conditional_haiku_default') expect(roots[1]).toMatchObject({ from: { model: 'claude-opus-5-5' }, cost_reason: 'cost_allows', cost: { evidence: { target: 'not_observed_in_epoch' } } });
    if (mode === 'conditional_haiku_echo') expect(roots[1]).toMatchObject({ from: { model: 'claude-sonnet-5-5' }, cost_reason: 'cost_allows', cost: { horizon: 5, scope: 'turn_horizon' } });
    for (const [i, r] of roots.entries()) expect(r).toMatchObject({ baseline_source: 'turn.step', from: i > 0 && mode.endsWith('echo') ? { model: echoed[i - 1], effort: 'low' } : { model: 'claude-opus-5-5', effort: 'high' } });
    // Opus never answered, so no default turn's baseline holds an observed cache; the echoed Sonnet's is warm.
    if (mode.endsWith('default')) expect(f.sent[1]?.state).not.toHaveProperty('execution');
    else expect(f.sent[1]?.state).toMatchObject({ execution: { cache: { source: 'provider_response_usage', cross_model_reuse_proven: false, current_fit_proven: false } } });
    expect(roots[2]).toMatchObject(mode.endsWith('default') ? { selection: { direction: 'unknown' }, reasons: { model: 'same_value' }, cost_reason: 'not_checked' }
      : { selection: { direction: 'upgrade' }, reasons: { model: 'selected' }, cost_reason: 'upgrade_allowed' });
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
    const f = fakeEngine({ hostBase: '2.1.293', pins: { mainEffort: scenario === 'pinned' }, respond: answering({ ...CLEAR, tier: ['standard', .95], effort: ['high', .95] }) });
    f.engine.currentEffort = async () => scenario === 'effective' || scenario === 'pinned' ? 'high' : scenario === 'numeric' ? 12000 : undefined;
    await warmRoot(router, f, 'claude-sonnet-5-5');
    router.turnStart({ turnId: 't1', text: TEXT }); const first = streamNext<TurnStepEvent>();
    const e = { turnId: 't1', index: 0, model: 'claude-opus-5-5' };
    await drain(router.turnStep(f.engine, e, first.next));
    if (scenario === 'numeric') expect(first.calls).toEqual([e]);
    else expect(first.calls[0]?.model).toBe('claude-sonnet-5-5');
    if (scenario === 'unknown' || scenario === 'auto') expect(first.calls[0]?.effort).toBe('high');
    const metadata = f.logs.find(l => l.event === 'root'); if (metadata) expect(metadata.effort_source).toBe(scenario === 'effective' || scenario === 'numeric' || scenario === 'pinned' ? 'host_effective' : 'unknown');
  });
  it.each(['fit', 'large', 'unknown', 'failure', 'grows', 'estimate_only', 'stale', 'incompatible'] as const)('never offers legacy Haiku even when a complete request bound fits: %s', async scenario => {
    const router = createRouter(configOf({ routeMainEffort: true, routeMainModel: true, ...SUBAGENT_OFF }));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', .99], effort: ['low', .99] }) });
    if (scenario !== 'estimate_only') f.engine.currentContextBound = async (turnId, index) => { if (scenario === 'failure') throw new Error('bound unavailable'); return scenario === 'unknown' ? undefined : { turnId: scenario === 'stale' ? 'old-turn' : turnId, index, inputUpperBound: scenario === 'large' ? 180_000 : 22_000, compatible: scenario !== 'incompatible' }; };
    await warmRoot(router, f, 'claude-haiku-5-5', 'xhigh');
    router.turnStart({ turnId: 't1', text: TEXT }); const first = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ effort: 'xhigh' }), first.next));
    expect(first.calls).toEqual([step({ model: 'claude-haiku-5-5', effort: 'low' })]);
    const later = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, step({ index: 1, effort: 'xhigh' }), later.next));
    expect(later.calls).toEqual([step({ index: 1, model: 'claude-haiku-5-5', effort: 'low' })]); expect(f.sent).toHaveLength(1);
    expect(f.logs.find(l => l.event === 'root')?.['selection']).toMatchObject({ roles: expect.arrayContaining([{ role: 'fast', option: 'mechanical', model: 'claude-haiku-5-5' }]) });
    expect(JSON.stringify(f.logs)).not.toContain('claude-haiku-4-5');
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
    expect(root).toMatchObject({ assessment: 'ok', sent: true, jev_model: JEV_MODEL, patch: { effort: 'low' }, reasons: { effort: 'selected', model: 'not_asked' } });
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
      [step({ model: 'claude-haiku-4-5' }), {}],
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
      if (index === 1) await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5' }), streamNext<TurnStepEvent>().next));
      stalled(f);
      const e = step({ model: 'claude-sonnet-5-5', index });
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
    // What the late reply cost is still recorded, against the turn that asked, under the short trace keys (`input`, not
    // `input_tokens`).
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
    for (const observed of ['claude-haiku-5-5', 'claude-sonnet-5-5', null]) {
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
    router.turnComplete({ turnId: 't1', agentId: 'child' }, f.engine);
    const kept = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ index: 1 }), kept.next));
    expect(kept.calls[0]?.effort).toBe('low');
    router.turnComplete({ turnId: 't1', reason: 'answer', answer: 'SECRET ANSWER' }, f.engine);
    const gone = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ index: 2 }), gone.next));
    expect(gone.calls).toEqual([step({ index: 2 })]);
    router.sessionEnd(f.engine);
    // Ends are recorded with their exact loop so an unanswered request can be bounded; the answer itself never is.
    expect(f.logs.filter(l => ['turn_end', 'session_end'].includes(String(l.event)))).toEqual([{ event: 'turn_end', turn: 't1', agent_id: 'child', scope: 'child', reason: null }, { event: 'turn_end', turn: 't1', agent_id: null, scope: 'root', reason: 'answer' }, { event: 'session_end' }]);
    expect(JSON.stringify(f.logs)).not.toContain('SECRET ANSWER');
  });
});

describe('root model', () => {
  it('routes the main model without requiring a manually verified switch table', async () => {
    const router = createRouter(configOf(MODEL_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.99] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5' }), n.next));
    expect(n.calls).toEqual([step({ model: 'claude-opus-5-5' })]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.questions['capability']).toBeDefined();
  });

  it('moves to a stronger configured model on the upgrade floor, and offers only the targets a switch could reach', async () => {
    const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ control: ['task_clear', 0.85], tier: ['deep', 0.85] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5' }), n.next));
    expect(n.calls).toEqual([step({ model: 'claude-opus-5-5' })]);
    // Current Haiku has the same 1M window, so it is a valid alternative too.
    expect(f.logs.find(l => l.event === 'root')?.['selection']).toMatchObject({ roles: [{ role: 'fast', model: 'claude-haiku-5-5' }, { role: 'standard', model: 'claude-sonnet-5-5' }, { role: 'deep', model: 'claude-opus-5-5' }, { role: 'frontier', model: 'claude-fable-5-1' }] });
    expect(JSON.stringify(f.sent[0]?.questions['capability'])).not.toMatch(/claude|haiku|sonnet|opus|fable/i);
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
      ['only a legacy target is verified', [{ from: 'claude-sonnet-5-5', to: 'claude-haiku-4-5' }], undefined],
      ['every other target is outside availableModels', SWITCHES, ['claude-sonnet-5-5', 'sonnet']],
    ];
    for (const [label, switches, availableModels] of cases) {
      const router = createRouter(configOf(MODEL_ONLY), switches);
      const g = fakeEngine({ availableModels, respond: answering({ ...CLEAR, tier: ['deep', 0.95] }) });
      router.turnStart({ turnId: 't1', text: TEXT });
      const m = streamNext<TurnStepEvent>();
      await drain(router.turnStep(g.engine, step({ model: 'claude-sonnet-5-5' }), m.next));
      expect(m.calls, label).toEqual([step({ model: 'claude-sonnet-5-5' })]);
      expect(g.sent, label).toHaveLength(0);
      expect(g.logs, label).toContainEqual(expect.objectContaining({ event: 'root', model_withheld: 'no_applicable_target' }));
    }
  });

  it('stops the model override when a pin appears after the decision', async () => {
    const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const first = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5' }), first.next));
    expect(first.calls[0]?.model).toBe('claude-opus-5-5');
    f.pins.mainModel = true;
    const second = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5', index: 1 }), second.next));
    expect(second.calls).toEqual([step({ model: 'claude-sonnet-5-5', index: 1 })]);
    expect(f.logs).toContainEqual({ event: 'root_stop', turn: 't1', index: 1, reason: 'model_pinned' });
  });

  it('does not consume a model patch through response observation, but a real incoming C wins', async () => {
    const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', .95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5' }), streamNext<TurnStepEvent>(() => null).next));
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
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5' }), streamNext<TurnStepEvent>().next));
    const gate = deferred<void>();
    f.allowed.wait = gate.promise;
    const before = f.allowed.reads;
    const second = streamNext<TurnStepEvent>();
    const run = drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5', index: 1 }), second.next));
    await vi.waitFor(() => expect(f.allowed.reads).toBe(before + 1));
    f.pins.mainModel = true;
    gate.resolve();
    await run;
    expect(second.calls).toEqual([step({ model: 'claude-sonnet-5-5', index: 1 })]);
    expect(f.logs).toContainEqual({ event: 'root_stop', turn: 't1', index: 1, reason: 'model_pinned' });
  });

  it('drops a stored model whose pair fails once a pin suppresses its effort', async () => {
    const router = createRouter(configOf({ ...MODEL_ONLY, routeMainEffort: true }), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['standard', 0.95], effort: ['medium', 0.95] }) });
    await warmRoot(router, f, 'claude-sonnet-5-5', 'max');
    router.turnStart({ turnId: 't1', text: TEXT });
    const first = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ effort: 'max' }), first.next));
    expect(first.calls).toEqual([step({ model: 'claude-sonnet-5-5', effort: 'medium' })]);
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
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5' }), streamNext<TurnStepEvent>().next));
    f.allowed.models = ['claude-sonnet-5-5'];
    const second = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5', index: 1 }), second.next));
    expect(second.calls).toEqual([step({ model: 'claude-sonnet-5-5', index: 1 })]);
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
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5' }), streamNext<TurnStepEvent>(undefined, counts).next));
    expect(f.logs).toContainEqual(expect.objectContaining({
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
    }));
  });

  it('resolves default aliases to exact root identifiers and enables the frontier tier', async () => {
    const router = createRouter(configOf({ routeMainModel: true, routeMainEffort: false, routeSubagentModel: false }));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['frontier', 0.99] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ model: 'claude-sonnet-5-5' }), n.next));
    expect(n.calls).toEqual([step({ model: 'claude-fable-5-1' })]);
    expect(f.sent).toHaveLength(1);
  });
});

const spawn = (over: Partial<SpawnEvent> = {}): SpawnEvent => ({
  tool_use_id: 'tu1',
  prompt: 'List every file under src/ that imports from ./config and report the import lines.',
  description: 'find config imports',
  subagentType: 'Explore',
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
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    const n = spawnNext();
    const result = await router.agentSpawn(f.engine, spawn(), n.next);
    expect(n.calls).toEqual([{ ...spawn(), model: 'claude-haiku-5-5' }]);
    expect(result).toEqual({ model: 'claude-haiku-5-5' });
    expect(f.sent[0]?.state).toMatchObject({ task: { text: spawn().prompt, description: spawn().description, subagent_type: 'Explore', source: 'child_contract', truncated: false } });
    expect(Object.keys(f.sent[0]?.questions ?? {})).toContain('capability');
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
      ['gate_routed', spawn({ subagentType: 'jev-gate:worker' }), {}, true],
      ['gate_routed', spawn({ subagentType: 'jev-gate:planner' }), {}, true],
      ['gate_routed', spawn({ prompt: 'Fix it.\n\n[Jev Gate route note] Tier: fast. Precedence: ...' }), {}, true],
    ];
    for (const [reason, e, opts, offered] of cases) {
      const router = createRouter(configOf({ ...SPAWN_ONLY, routeSubagentEffort: false }));
      const f = fakeEngine({ ...opts, respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
      if (offered) {
        router.agentOffer(OFFER_BUILT_IN('Explore'));
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
      respond: (req) => answering({ ...CLEAR, tier: [(req.state as { task: { text: string } }).task.text === QUICK ? 'fast' : 'deep', 0.95] })(req),
    });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    const a = spawnNext();
    const b = spawnNext();
    await Promise.all([router.agentSpawn(f.engine, spawn({ prompt: QUICK }), a.next), router.agentSpawn(f.engine, spawn(), b.next)]);
    expect(f.sent).toHaveLength(2);
    expect(a.calls[0]?.model).toBe('claude-haiku-5-5');
    expect(b.calls[0]?.model).toBeUndefined();
  });

  it('lets an abandoned dispatch decide nothing for a later one, and records what its reply cost', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const first = deferred<HttpReply>();
    let calls = 0;
    const f = fakeEngine({ respond: (req) => (calls++ === 0 ? first.promise : answering({ ...CLEAR, tier: ['standard', 0.95] })(req)) });
    router.agentOffer(OFFER_BUILT_IN('general-purpose'));
    const abandoned = spawnNext();
    const run = router.agentSpawn(f.engine, spawn({ subagentType: 'general-purpose' }), abandoned.next);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    abandoned.controller.abort();
    await expect(run).rejects.toThrow('abandoned');

    const again = spawnNext();
    const pending = router.agentSpawn(f.engine, spawn({ subagentType: 'general-purpose' }), again.next);
    first.resolve(answering({ ...CLEAR, tier: ['fast', 0.95] })(f.sent[0]!) as HttpReply);
    await pending;
    expect(f.sent).toHaveLength(2);
    expect(again.calls[0]?.model).toBe('claude-sonnet-5-5');
    await vi.waitFor(() => expect(f.logs).toContainEqual(expect.objectContaining({ event: 'late', scope: 'spawn', tool_use_id: 'tu1' })));
  });

  it('logs a denial and a resolved model outside the requested family, and changes neither', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    const denied = spawnNext(() => ({ deny: 'policy' }));
    expect(await router.agentSpawn(f.engine, spawn(), denied.next)).toEqual({ deny: 'policy' });
    const other = spawnNext(() => ({ model: 'claude-sonnet-5-5' }));
    expect(await router.agentSpawn(f.engine, spawn({ tool_use_id: 'tu2' }), other.next)).toEqual({ model: 'claude-sonnet-5-5' });
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn_result', denied: true }));
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn_result', reason: 'model_mismatch', requested: 'claude-haiku-5-5', observed: 'claude-sonnet-5-5' }));
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
      router.agentOffer(OFFER_BUILT_IN('Explore'));
      const n = spawnNext();
      const run = router.agentSpawn(f.engine, spawn(), n.next);
      await vi.waitFor(() => expect(f.sent).toHaveLength(1));
      change(f);
      reply.resolve(answering({ ...CLEAR, tier: ['fast', 0.95] })(f.sent[0]!) as HttpReply);
      await run;
      expect(n.calls, reason).toEqual([spawn()]);
      expect(f.logs, reason).toContainEqual({ event: 'spawn_stop', tool_use_id: 'tu1', reason, requested: 'claude-haiku-5-5' });
      // The `spawn` receipt is the applied route, so a stop writes none: the dashboard shows no change, and the sent
      // intent leaves the bench's Jev cost unknown rather than 0.
      expect(f.logs.some(r => r['event'] === 'spawn'), reason).toBe(false);
      const at = '2026-10-20T00:00:00.000Z';
      const view = buildOperations([], f.logs.map(rec => ({ at, component: 'router' as const, rec: { ...rec, session_id: 's' } })), new Date(at), { trace: true });
      const steps = view.runs.flatMap(r => r.steps);
      expect(steps.find(s => s.title === 'Router · Agent 판단 중단')?.summary, reason).toBe(reason);
      expect(JSON.stringify(steps), reason).not.toMatch(/설정 변경|claude-haiku-5-5/);
      // The decision closes its request: it is not left waiting for an answer.
      expect(steps.filter(s => s.state === 'active' || s.state === 'unconfirmed'), reason).toEqual([]);
      const dir = mkdtempSync(join(tmpdir(), 'router-receipt-'));
      f.logs.forEach((r, i) => writeFileSync(join(dir, `${i}.json`), JSON.stringify({ ...r, phase: 'mod_router', session_id: 's', invocation_id: String(i) })));
      expect(sessionFacts(dir, 's'), reason).toMatchObject({ jevRequests: 1, jevInput: null, jevCost: null });
      rmSync(dir, { recursive: true });
    }
  });

  it('reads the pins last, so a pin set while the allowlist is read still leaves the spawn native', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const reply = deferred<HttpReply>();
    const f = fakeEngine({ respond: () => reply.promise });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
    expect(f.logs).toContainEqual({ event: 'spawn_stop', tool_use_id: 'tu1', reason: 'subagent_model_pinned', requested: 'claude-haiku-5-5' });
  });

  it('sends nothing and routes nothing for a dispatch whose session ended during a read', async () => {
    for (const during of ['first', 'final'] as const) {
      const router = createRouter(configOf(SPAWN_ONLY));
      const reply = deferred<HttpReply>();
      const f = fakeEngine({ respond: () => reply.promise });
      router.agentOffer(OFFER_BUILT_IN('Explore'));
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
      router.agentOffer(OFFER_BUILT_IN('Explore'));
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
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
    bare.agentOffer(OFFER_BUILT_IN('Explore'));
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

  describe('a custom agent\'s file model', () => {
    const custom = (declared: string | null, over: Partial<SpawnEvent> = {}, tier = 'standard', edits = true) => {
      const router = createRouter(configOf(SPAWN_ONLY));
      const f = fakeEngine({ respond: answering({ ...CLEAR, tier: [tier, 0.95], effort: ['high', 0.95] }) });
      const read: string[] = [];
      f.engine.agentModel = async type => { read.push(type); return declared; };
      f.engine.agentEdits = async () => edits;
      return { router, f, read, e: spawn({ subagentType: 'guardian', provider: { plugin: 'user', tier: 'local' }, ...over }) };
    };
    it('asks about a frontmatter opus agent and can move it down', async () => {
      const { router, f, read, e } = custom('opus');
      const n = spawnNext();
      await router.agentSpawn(f.engine, e, n.next);
      expect(read).toEqual(['guardian']);
      expect(n.calls).toEqual([{ ...e, model: 'claude-sonnet-5-5' }]);
      expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', from: 'claude-opus-5-5', model_asked: true }));
    });
    it('times a spawn\'s Jev call, answered or failed, so the dashboard counts it (#267)', async () => {
      const { router, f, e } = custom('opus');
      await router.agentSpawn(f.engine, e, spawnNext().next);
      const failed = custom('opus');
      failed.f.engine.fetch = async () => { throw new Error('offline'); };
      await failed.router.agentSpawn(failed.f.engine, failed.e, spawnNext().next);
      for (const logs of [f.logs, failed.f.logs]) expect(logs).toContainEqual(expect.objectContaining({ event: 'spawn', hook_version: ROUTER_HOOK_VERSION, duration_ms: expect.any(Number) }));
      expect(failed.f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', assessment: expect.not.stringMatching(/^ok$/) }));
    });
    it('never moves a frontmatter haiku agent up, whatever the answer', async () => {
      const { router, f, e } = custom('haiku', {}, 'deep');
      const n = spawnNext();
      await router.agentSpawn(f.engine, e, n.next);
      expect(n.calls).toEqual([e]);
      expect(JSON.stringify(f.sent[0]?.questions['capability'] ?? {})).not.toContain('complex');
    });
    it('reads inherit as the parent\'s model', async () => {
      const { router, f, e } = custom('inherit', { parentModel: 'claude-sonnet-5-5' }, 'fast', false);
      const n = spawnNext();
      await router.agentSpawn(f.engine, e, n.next);
      expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', from: 'claude-sonnet-5-5' }));
      expect(n.calls).toEqual([{ ...e, model: 'claude-haiku-5-5' }]);
    });
    it('leaves an unread definition native, as before', async () => {
      const { router, f, e } = custom(null);
      const n = spawnNext();
      await router.agentSpawn(f.engine, e, n.next);
      expect(n.calls).toEqual([e]);
      expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', from: 'claude-opus-5-5', model_asked: false }));
    });
    it('sends nothing for a SendMessage resumption, and asks no model when resumption cannot be read', async () => {
      for (const resumes of [async () => true, async () => { throw new Error('list unavailable'); }]) {
        const { router, f, e } = custom('opus', { name: 'aaabb33b14b57a515' });
        f.engine.resumes = resumes;
        const n = spawnNext();
        await router.agentSpawn(f.engine, e, n.next);
        expect(n.calls).toEqual([e]);
        expect(f.sent).toHaveLength(0);
        expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', skipped: 'resumed' }));
      }
    });
  });

  describe('a spawn\'s tools bound its model', () => {
    type Picks = Parameters<typeof answering>[0];
    const run = async (picks: Picks, e: SpawnEvent, file?: { model: string; edits: boolean | null }) => {
      const router = createRouter(configOf({ ...SPAWN_ONLY, routeExplicitSpawnModel: true }));
      const f = fakeEngine({ respond: answering(picks) });
      if (file) { f.engine.agentModel = async () => file.model; f.engine.agentEdits = async () => file.edits; }
      router.agentOffer(OFFER_BUILT_IN(e.subagentType));
      const n = spawnNext();
      await router.agentSpawn(f.engine, e, n.next);
      return { model: n.calls[0]?.model, log: f.logs.find(l => l.event === 'spawn' && l.assessment === 'ok') };
    };
    const explore = spawn({ subagentType: 'Explore' });

    it('moves a read-only agent on routine work to the cheapest role', async () => {
      const { model, log } = await run({ ...CLEAR, tier: ['standard', 0.95] }, explore);
      expect(model).toBe('claude-haiku-5-5');
      expect(log).toMatchObject({ spawn_tool_class: 'read_only', reasons: { model: 'tool_read_only' } });
    });

    it('stops an editing agent at the standard role, even on a mechanical answer; a baseline below standard stays', async () => {
      const { model, log } = await run({ ...CLEAR, tier: ['fast', 0.95] }, spawn({ subagentType: 'general-purpose', model: 'opus' }));
      expect(model).toBe('claude-sonnet-5-5');
      expect(log).toMatchObject({ spawn_tool_class: 'editing', reasons: { model: 'tool_editing_floor' } });
      // The ceiling wins over the floor: an editing agent on Haiku is never lifted to the standard role.
      expect((await run({ ...CLEAR, tier: ['fast', 0.95] }, spawn({ subagentType: 'general-purpose', model: 'haiku' }))).model).toBe('haiku');
      const lifted = await run({ ...CLEAR, tier: ['standard', 0.97] }, spawn({ subagentType: 'general-purpose', model: 'haiku' }));
      expect(lifted.model).toBe('haiku');
      expect(lifted.log).toMatchObject({ spawn_tool_class: 'editing', reasons: { model: 'tool_ceiling' } });
    });

    it('never runs a read-only or editing built-in above its inherited model, even on an upgrade answer', async () => {
      for (const subagentType of ['Explore', 'general-purpose']) {
        const { model, log } = await run({ ...CLEAR, tier: ['deep', 0.97] }, spawn({ subagentType, parentModel: 'claude-sonnet-5-5' }));
        expect(model, subagentType).toBeUndefined();
        expect(log, subagentType).toMatchObject({ from: 'claude-sonnet-5-5', reasons: { model: 'tool_ceiling' } });
      }
    });

    it('passes an allowed move off a restricted baseline at or below its rank, and never one above it', async () => {
      // A legacy Sonnet to the current one (same role), and a legacy Fable down to Sonnet.
      for (const parentModel of ['claude-sonnet-5', 'claude-fable-5']) expect((await run({ ...CLEAR, tier: ['standard', 0.97] }, spawn({ subagentType: 'general-purpose', parentModel }))).model, parentModel).toBe('claude-sonnet-5-5');
      const above = await run({ ...CLEAR, tier: ['deep', 0.97] }, spawn({ subagentType: 'general-purpose', parentModel: 'claude-sonnet-5' }));
      expect(above.model).toBeUndefined();
    });

    it('keeps the baseline of an agent whose tools are unknown, in either direction', async () => {
      const custom = spawn({ subagentType: 'guardian', provider: { plugin: 'user', tier: 'local' } });
      const down = await run({ ...CLEAR, tier: ['fast', 0.97] }, custom, { model: 'opus', edits: null });
      expect(down.model).toBeUndefined();
      expect(down.log).toMatchObject({ spawn_tool_class: null, reasons: { model: 'tool_unknown' } });
      const up = await run({ ...CLEAR, tier: ['deep', 0.97] }, spawn({ subagentType: 'guardian', provider: { plugin: 'user', tier: 'local' }, parentModel: 'claude-sonnet-5-5' }), { model: 'inherit', edits: null });
      expect(up.model).toBeUndefined();
      expect(up.log).toMatchObject({ spawn_tool_class: null, reasons: { model: 'tool_unknown' } });
    });

    it.each([['complex', { ...CLEAR, tier: ['deep', 0.95] }], ['unclear', { ...CLEAR, tier: ['unclear', 0.95] }], ['consequential', { control: CLEAR.control, action_risk: ['consequential', 0.97], tier: ['standard', 0.95] }]] as Array<[string, Picks]>)(
      'keeps the baseline of a read-only agent on a %s answer', async (_, picks) => {
        const { model, log } = await run(picks, explore);
        expect(model).toBeUndefined();
        expect(log).toMatchObject({ spawn_tool_class: 'read_only' });
        expect((log?.['reasons'] as Record<string, unknown>)['model']).not.toMatch(/^tool_/);
      });

    it('keeps an explicitly locked model', async () => {
      const { model, log } = await run({ control: ['explicit_lock', 0.97], action_risk: ['ordinary', 0.97], tier: ['fast', 0.95] }, spawn({ subagentType: 'Explore', model: 'opus' }));
      expect(model).toBe('opus');
      expect(log).toMatchObject({ spawn_tool_class: 'read_only', reasons: { model: 'control_lock' } });
    });


    it('moves a declared-opus read-only agent down, and never a declared model up', async () => {
      const guardian = spawn({ subagentType: 'guardian', provider: { plugin: 'user', tier: 'local' } });
      expect((await run({ ...CLEAR, tier: ['standard', 0.95] }, guardian, { model: 'opus', edits: false })).model).toBe('claude-haiku-5-5');
      // Complex work on a declared Sonnet is never lifted, and an editing one stays on its file's model, not below.
      expect((await run({ ...CLEAR, tier: ['deep', 0.95] }, guardian, { model: 'sonnet', edits: false })).model).toBeUndefined();
      const editing = await run({ ...CLEAR, tier: ['fast', 0.95] }, guardian, { model: 'sonnet', edits: true });
      expect(editing.model).toBeUndefined();
      expect(editing.log).toMatchObject({ spawn_tool_class: 'editing', reasons: { model: 'tool_editing_floor' } });
    });
  });

  it('records the model and agent a routed spawn resolved to', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    const n = spawnNext(() => ({ model: 'claude-haiku-5-5', agentId: 'a1' }));
    await router.agentSpawn(f.engine, spawn(), n.next);
    expect(f.logs).toContainEqual({ event: 'spawn_result', tool_use_id: 'tu1', requested: 'claude-haiku-5-5', observed: 'claude-haiku-5-5', agent_id: 'a1' });
  });

  it('moves a spawn off a restricted parent model without a cost check: staying would be a denial', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['standard', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    expect(await router.agentSpawn(f.engine, spawn({ parentModel: 'claude-sonnet-5' }), spawnNext().next)).toEqual({ model: 'claude-sonnet-5-5' });
    expect(f.logs.find(r => r.event === 'spawn')).toMatchObject({ cost: null, cost_reason: 'not_checked' });
  });

  it('throws instead of calling next once its dispatch was abandoned', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const reply = deferred<HttpReply>();
    const f = fakeEngine({ respond: () => reply.promise });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
    const f = fakeEngine({ hostBase: '2.1.293', respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    const n = spawnNext();
    expect(await router.agentSpawn(f.engine, spawn(), n.next)).toEqual({ model: 'claude-haiku-5-5' });
  });

  it('reports a mismatched spawn without stopping subsequent independent work', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', .95] }) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5' })).next);
    const next = spawnNext();
    await router.agentSpawn(f.engine, spawn({ tool_use_id: 'independent' }), next.next);
    expect(next.calls[0]!.model).toBe('claude-haiku-5-5');
    expect(f.sent).toHaveLength(2);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn_result', reason: 'model_mismatch' }));
    expect(f.logs.some(l => l['event'] === 'spawn_suspended')).toBe(false);
  });

  it('does not suspend for a spawn a pin set during its assessment kept native, whatever Jev answered', async () => {
    for (const pick of ['fast', 'deep'] as const) {
      const router = createRouter(configOf(SPAWN_ONLY));
      const held = deferred<HttpReply>();
      const f = fakeEngine({ respond: () => held.promise });
      router.agentOffer(OFFER_BUILT_IN('Explore'));
      const run = router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-haiku-5-5' })).next);
      await vi.waitFor(() => expect(f.sent).toHaveLength(1));
      f.pins.subagentModel = true;
      held.resolve(answering({ ...CLEAR, tier: [pick, 0.95] })(f.sent[0]!) as HttpReply);
      await run;
      expect(f.logs.some(l => l['event'] === 'spawn_suspended'), pick).toBe(false);
      expect(f.logs.find(l => l['event'] === 'spawn_native_result')).toMatchObject({ requested: null, observed: 'claude-haiku-5-5', confirmation: 'unobserved' });
    }
  });

  it('does not suspend for a spawn a pin kept native, which runs on the pinned model', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }), pins: { subagentModel: true } });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-haiku-5-5' })).next);
    expect(f.logs.some(l => l['event'] === 'spawn_suspended')).toBe(false);
    expect(f.logs.find(l => l['event'] === 'spawn_native_result')).toMatchObject({ requested: null, observed: 'claude-haiku-5-5', confirmation: 'unobserved' });
    f.pins.subagentModel = false;
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    const n = spawnNext(() => ({ model: 'claude-haiku-5-5' }));
    await router.agentSpawn(f.engine, spawn({ tool_use_id: 'tu2' }), n.next);
    expect(n.calls).toEqual([spawn({ tool_use_id: 'tu2', model: 'claude-haiku-5-5' })]);
  });
});

const CHILD = { routeMainEffort: false, routeMainModel: false, routeSubagentModel: true, routeSubagentEffort: true, routeExplicitSpawnModel: true };
/** A subagent loop's step: its own agentId and turn, on the model and effort it resolved to. */
const childStep = (over: Partial<TurnStepEvent> = {}): TurnStepEvent => step({ agentId: 'a1', turnId: 'c1', effort: 'xhigh', ...over });

describe('child routing gap diagnostics (#219)', () => {
  it('records an unregistered child and its later native steps without changing or repeating requests', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine();
    const n = streamNext<TurnStepEvent>();
    const first = childStep({ index: 26 });
    const later = childStep({ index: 27 });
    await drain(router.turnStep(f.engine, first, n.next));
    await drain(router.turnStep(f.engine, later, n.next));
    expect(n.calls).toEqual([first, later]);
    expect(f.sent).toHaveLength(0);
    expect(f.logs.filter(l => l.event === 'child_route')).toEqual([
      { event: 'child_route', scope: 'child', agent_id: 'a1', turn: 'c1', index: 26,
        hook_version: ROUTER_HOOK_VERSION, sent: false, skipped: 'child_unregistered' },
      { event: 'child_route', scope: 'child', agent_id: 'a1', turn: 'c1', index: 27,
        hook_version: ROUTER_HOOK_VERSION, sent: false, skipped: 'native_child' },
    ]);
    expect(f.logs.filter(l => l.event === 'prepared' || l.event === 'model_request')).toHaveLength(4);
    for (const record of f.logs.filter(l => l.event === 'prepared' || l.event === 'model_request')) {
      expect(record).toMatchObject({ hook_version: ROUTER_HOOK_VERSION, agent_id: 'a1', turn: 'c1' });
    }
    expect(JSON.stringify(f.logs)).not.toContain(FAKE_KEY);
  });

  it('exposes registration loss after session teardown without reusing the old child allocation', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', .95], effort: ['low', .95] }) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    const first = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep(), first.next));
    expect(first.calls).toEqual([childStep({ effort: 'low' })]);
    expect(f.sent).toHaveLength(1);
    router.sessionEnd();
    const continuation = childStep({ index: 1 });
    const after = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, continuation, after.next));
    expect(after.calls).toEqual([continuation]);
    expect(f.sent).toHaveLength(1);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'child_route', agent_id: 'a1', index: 1,
      hook_version: ROUTER_HOOK_VERSION, skipped: 'child_unregistered', sent: false }));
    expect(JSON.stringify(f.logs)).not.toContain(TEXT);
  });

  it('distinguishes a stopped registration from a missing one and tolerates a broken recorder', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', .95], effort: ['low', .95] }) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep(), n.next));
    await drain(router.turnStep(f.engine, childStep({ turnId: 'c2' }), n.next));
    await drain(router.turnStep(f.engine, childStep({ turnId: 'c2', index: 1 }), n.next));
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'child_route', skipped: 'child_stopped', sent: false }));
    f.engine.log = () => { throw new Error('recorder unavailable'); };
    const unchanged = childStep({ turnId: 'c2', index: 2 });
    await drain(router.turnStep(f.engine, unchanged, n.next));
    expect(n.calls).toEqual([childStep({ effort: 'low' }), childStep({ turnId: 'c2' }),
      childStep({ turnId: 'c2', index: 1 }), unchanged]);
    expect(f.sent).toHaveLength(1);
  });
});

describe('subagent effort and named models', () => {
  it("sets a subagent's effort from its spawn's one answer, on every step of its loop", async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['low', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    const s = spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' }));
    await router.agentSpawn(f.engine, spawn(), s.next);
    // Deep work keeps Opus: the spawn is left on the model it inherits.
    expect(s.calls).toEqual([spawn()]);
    expect(Object.keys(f.sent[0]?.questions ?? {})).toEqual(expect.arrayContaining(['control', 'capability', 'effort_0', 'action_risk']));
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

  it("records the spawn's answers and labels its child's kept effort with the pair's own reason", async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['high', 0.95] }) });
    f.engine.currentEffort = async () => 'high';
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    const record = f.logs.find((l) => l['event'] === 'spawn');
    expect(record).toMatchObject({ reasons: { effort: 'same_value' }, selection: expect.objectContaining({ effort_policy: 'ordered_move' }), answers: expect.objectContaining({ control: expect.anything(), capability: expect.anything() }) });
    // The child runs at the effort the pair kept, so its first step is left as it is.
    const kept = childStep({ effort: 'high' });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, kept, n.next));
    expect(n.calls).toEqual([kept]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'child', agent_id: 'a1', patch: null, reason: 'same_value' }));
    expect(f.logs.some((l) => l['event'] === 'child' && l['reason'] === 'answer_invalid')).toBe(false);
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
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    await router.agentSpawn(f.engine, spawn({ tool_use_id: 'other' }), spawnNext(() => ({ model: 'claude-sonnet-5-5', agentId: 'a2' })).next);
    const next = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep(), next.next));
    expect(next.calls).toEqual([childStep({ effort: 'low' })]);
    expect(f.sent).toHaveLength(2);
  });

  it('leaves a loop native once a step arrives on another effort or model, or its patch is answered by another model', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['low', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    await router.agentSpawn(f.engine, spawn({ tool_use_id: 'tu2' }), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a2' })).next);
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep(), n.next));
    await drain(router.turnStep(f.engine, childStep({ index: 1, effort: 'high' }), n.next));
    await drain(router.turnStep(f.engine, childStep({ index: 2 }), n.next));
    expect(n.calls).toEqual([childStep({ effort: 'low' }), childStep({ index: 1, effort: 'high' }), childStep({ index: 2 })]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'child_stop', agent_id: 'a1', reason: 'incoming_divergence' }));

    const fallback = streamNext<TurnStepEvent>(() => 'claude-sonnet-5-5');
    await drain(router.turnStep(f.engine, childStep({ agentId: 'a2' }), fallback.next));
    await drain(router.turnStep(f.engine, childStep({ agentId: 'a2', index: 1 }), fallback.next));
    expect(fallback.calls).toEqual([childStep({ agentId: 'a2', effort: 'low' }), childStep({ agentId: 'a2', index: 1, effort: 'low' })]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'child_result', agent_id: 'a2', confirmation: 'mismatch' }));
  });

  it("routes the model an Agent call names as a default, unless configured not to, and never a fork's", async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95], effort: ['low', 0.95] }) });
    f.engine.agentEdits = async () => false;
    const s = spawnNext();
    await router.agentSpawn(f.engine, spawn({ model: 'opus', subagentType: 'my-reviewer' }), s.next);
    expect(s.calls).toEqual([spawn({ model: 'claude-haiku-5-5', subagentType: 'my-reviewer' })]);
    expect(f.logs.find((l) => l['event'] === 'spawn')).toMatchObject({ explicit: true, from: 'claude-opus-5-5', patch: { model: 'claude-haiku-5-5' } });

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
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
  // #274: a request reads a cache entry only within reach of its last request; 6847d1 ran Haiku 11 requests and the
  // return to Opus read 29,836 and wrote 123,451.
  it('returns a switched root to its baseline while the baseline cache is still in reach', async () => {
    const router = createRouter(configOf({ routeMainModel: true, routeMainEffort: true, ...SUBAGENT_OFF }));
    const f = fakeEngine({ hostBase: '2.1.293', respond: answering({ control: ['task_clear', .99], action_risk: ['ordinary', .99], tier: ['fast', .99], effort: ['low', .99] }) });
    f.engine.currentContextBound = async (turnId, index) => ({ turnId, index, inputUpperBound: 20_000, compatible: true });
    f.engine.currentEffort = async () => undefined;
    await warmRoot(router, f, 'claude-sonnet-5-5', 'high');
    const turn = async (turnId: string, steps: number) => {
      router.turnStart({ turnId, text: 'Find the exact helper file.' });
      const n = streamNext<TurnStepEvent>(undefined, { input_tokens: 900, output_tokens: 50, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 1000 });
      for (let index = 0; index < steps; index++) await drain(router.turnStep(f.engine, { turnId, index, model: 'claude-sonnet-5-5', effort: 'high' }, n.next));
      router.turnComplete({ turnId, reason: 'answer', answer: 'Done.' });
      return n.calls.map(c => c.model === 'claude-haiku-5-5' ? 'h' : 's').join('');
    };
    expect(await turn('long', 7)).toBe('hhhhhss');
    expect(f.logs).toContainEqual({ event: 'root_stop', turn: 'long', index: 5, reason: 'baseline_reach' });
    // Five switched requests leave no room: the next turn stays on the baseline, and the one after may switch again.
    expect(await turn('short', 5)).toBe('hhhhh');
    expect(await turn('after', 2)).toBe('ss');
    expect(f.logs.find(l => l.event === 'root' && l.turn === 'after')).toMatchObject({ reasons: { model: 'baseline_reach' }, proposed_patch: expect.objectContaining({ model: 'claude-haiku-5-5' }), cost: null });
    expect(await turn('again', 1)).toBe('h');
    expect(f.logs.find(l => l.event === 'root' && l.turn === 'again')).toMatchObject({ cost: { horizon: 5, evidence: { target: { requests_since: 2 } } } });
  });
  it('keeps the original model pair when an observed priced switch has a strictly positive cost floor', async () => {
    let tier = 'standard'; const router = createRouter(configOf(MODEL_ONLY), SWITCHES);
    const f = fakeEngine({ respond: req => answering({ ...CLEAR, tier: [tier, .99] })(req) });
    const turn = async (id: string, model: string, ttl: 'ephemeral_5m_input_tokens' | 'ephemeral_1h_input_tokens') => {
      router.turnStart({ turnId: id, text: TEXT });
      const n = streamNext<TurnStepEvent>(undefined, { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: 99000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0, [ttl]: 1000 } });
      await drain(router.turnStep(f.engine, step({ turnId: id, model }), n.next)); router.turnComplete({ turnId: id }); return n.calls[0];
    };
    await turn('target-write', 'claude-sonnet-5-5', 'ephemeral_5m_input_tokens');
    f.clock.ms += 300001; tier = 'deep'; await turn('baseline-write', 'claude-opus-5-5', 'ephemeral_1h_input_tokens');
    tier = 'standard'; expect((await turn('held', 'claude-opus-5-5', 'ephemeral_1h_input_tokens'))?.model).toBe('claude-opus-5-5');
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', turn: 'held', cost_reason: 'cost_hold', proposed_patch: expect.objectContaining({ model: 'claude-sonnet-5-5' }), patch: {} }));
  });
  it('does not suppress an effort downgrade after the host explicitly reports no cache read or creation', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    let effort: [string, number] = ['xhigh', .95];
    const f = fakeEngine({ respond: req => answering({ ...CLEAR, effort })(req) });
    router.turnStart({ turnId: 'uncached-first', text: TEXT });
    await drain(router.turnStep(f.engine, step({ turnId: 'uncached-first', effort: 'xhigh' }), streamNext<TurnStepEvent>(e => e.model, { input_tokens: 123, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }).next));
    router.turnComplete({ turnId: 'uncached-first' });
    effort = ['low', .95];
    router.turnStart({ turnId: 'uncached-followup', text: TEXT });
    const next = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step({ turnId: 'uncached-followup', effort: 'xhigh' }), next.next));
    expect(next.calls[0]?.effort).toBe('low');
    expect(f.logs.some(r => r.turn === 'uncached-followup' && r.reasons && (r.reasons as Record<string, unknown>).effort === 'cache_preserved')).toBe(false);
    expect(f.sent).toHaveLength(2);
  });

  it.each(['hit', 'miss', 'unknown'] as const)('checks capability-preserving effort changes and restores the warm floor only on a known miss (%s)', async outcome => {
    const router = createRouter(configOf(EFFORT_ONLY)); let wanted = 'high';
    const f = fakeEngine({ respond: req => answering({ ...CLEAR, effort: [wanted, .99] })(req) });
    f.engine.cacheCapability = async () => ({ host: '2.1.288', connection: 'api-key', excluded: false, hipaa: false });
    const turn = async (id: string, effort: string, usage: Record<string, unknown>) => {
      wanted = effort; router.turnStart({ turnId: id, text: TEXT });
      const next = streamNext<TurnStepEvent>(undefined, usage); await drain(router.turnStep(f.engine, step({ turnId: id, effort: 'xhigh' }), next.next)); router.turnComplete({ turnId: id }); return next.calls[0]?.effort;
    };
    const writes = { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 10000 };
    await turn('warm', 'high', writes);
    expect(await turn('change', 'low', outcome === 'unknown' ? {} : { ...writes, cache_read_input_tokens: outcome === 'hit' ? 9800 : 0 })).toBe('low');
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'effort_cache', turn: 'change', hit: outcome === 'unknown' ? null : outcome === 'hit', floor_restored: outcome === 'miss' }));
    await turn('upgrade', 'high', { ...writes, cache_read_input_tokens: 30000 });
    const final = await turn('again', 'low', writes);
    expect(final).toBe(outcome === 'miss' ? 'high' : 'low');
    router.contextChanged(); expect(await turn('compacted', 'low', writes)).toBe('low');
  });
  it.each(['claude-opus-5-5', 'claude-opus-5-5[1m]'])('restores the floor after a native four-counter hit followed by a miss (%s)', async model => {
    const router = createRouter(configOf(EFFORT_ONLY)); let wanted = 'high';
    const f = fakeEngine({ respond: req => answering({ ...CLEAR, effort: [wanted, .99] })(req) });
    f.engine.cacheCapability = async () => ({ host: '2.1.288', connection: 'bearer', excluded: false, hipaa: null });
    const turn = async (id: string, effort: string, read: number) => {
      wanted = effort; router.turnStart({ turnId: id, text: TEXT });
      const n = streamNext<TurnStepEvent>(undefined, { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: 10000 });
      await drain(router.turnStep(f.engine, step({ turnId: id, effort: 'xhigh', model }), n.next)); router.turnComplete({ turnId: id }); return n.calls[0]?.effort;
    };
    await turn('warm', 'medium', 0);
    expect(await turn('hit', 'xhigh', 10000)).toBe('xhigh');
    await turn('miss', 'high', 0);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'effort_cache', turn: 'miss', hit: false, floor_restored: true }));
    expect(await turn('after-miss', 'low', 0)).toBe('high');
    expect(f.sent.at(-1)?.state).toMatchObject({ execution: { cache: { cache_write_tokens: 10000 } } });
  });
  it('starts a session from an earlier session\'s observed effort-change hit, and a miss ends it (#277)', async () => {
    const stored = new Map<string, boolean>(); let wanted = 'high';
    const session = () => {
      const router = createRouter(configOf(EFFORT_ONLY));
      const f = fakeEngine({ respond: req => answering({ ...CLEAR, effort: [wanted, .99] })(req) });
      f.engine.cacheCapability = async () => ({ host: '2.1.304', connection: 'bearer', excluded: false, hipaa: null });
      f.engine.effortCacheHits = async () => [...stored].filter(([, hit]) => hit).map(([id]) => id);
      f.engine.saveEffortCache = async (id, hit) => { stored.set(id, hit); };
      const turn = async (id: string, effort: string, read: number) => {
        wanted = effort; router.turnStart({ turnId: id, text: TEXT });
        const n = streamNext<TurnStepEvent>(undefined, { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: 10000 });
        await drain(router.turnStep(f.engine, step({ turnId: id, effort: 'xhigh' }), n.next)); router.turnComplete({ turnId: id }); return n.calls[0]?.effort;
      };
      return { f, turn };
    };
    const first = session();
    await first.turn('warm', 'high', 0);
    expect(await first.turn('held', 'low', 10000)).toBe('high');
    expect(stored.size).toBe(0);
    expect(await first.turn('rise', 'xhigh', 20000)).toBe('xhigh');
    expect(stored.get('claude-opus-5-5')).toBe(true);
    const second = session();
    await second.turn('warm', 'high', 0);
    expect(await second.turn('lower', 'low', 10000)).toBe('low');
    expect(second.f.logs).toContainEqual(expect.objectContaining({ event: 'root', turn: 'lower', effort_cache: 'cache_preserved', effort_cache_basis: 'earlier_session' }));
    await second.turn('miss', 'medium', 0);
    expect(stored.get('claude-opus-5-5')).toBe(false);
    expect(await second.turn('after-miss', 'low', 0)).toBe('medium');
    const third = session();
    await third.turn('warm', 'high', 0);
    expect(await third.turn('held', 'low', 10000)).toBe('high');
  });
  it('judges an effort change only on a request right after the same model\'s own (#277)', async () => {
    const router = createRouter(configOf(EFFORT_ONLY)); let wanted = 'medium';
    const f = fakeEngine({ respond: req => answering({ ...CLEAR, effort: [wanted, .99] })(req) });
    const saved: boolean[] = []; f.engine.saveEffortCache = async (_id, hit) => { saved.push(hit); };
    const turn = async (id: string, model: string, effort: string, read: number) => {
      wanted = effort; router.turnStart({ turnId: id, text: TEXT });
      const n = streamNext<TurnStepEvent>(undefined, { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: 10000 });
      await drain(router.turnStep(f.engine, step({ turnId: id, effort: 'xhigh', model }), n.next)); router.turnComplete({ turnId: id }); return n.calls[0]?.effort;
    };
    await turn('opus', 'claude-opus-5-5', 'medium', 0);
    await turn('sonnet', 'claude-sonnet-5-5', 'medium', 0);
    // Back on Opus after another model's request: its cache may be out of reach, whatever the effort.
    expect(await turn('back', 'claude-opus-5-5', 'high', 0)).toBe('high');
    expect(f.logs.filter(l => l.event === 'effort_cache')).toEqual([]);
    expect(saved).toEqual([]);
  });
  it('bounds the legacy floor when native usage does not expose TTL, without claiming a known cache expiry', async () => {
    const router = createRouter(configOf(EFFORT_ONLY)); let wanted = 'high';
    const f = fakeEngine({ respond: req => answering({ ...CLEAR, effort: [wanted, .99] })(req) });
    const turn = async (id: string) => {
      router.turnStart({ turnId: id, text: TEXT }); const n = streamNext<TurnStepEvent>(undefined, { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 10000 });
      await drain(router.turnStep(f.engine, step({ turnId: id, effort: 'xhigh' }), n.next)); router.turnComplete({ turnId: id }); return n.calls[0]?.effort;
    };
    await turn('warm'); wanted = 'low'; f.clock.ms += 60 * 60_000;
    expect(await turn('expired-guard')).toBe('low');
    expect(f.sent.at(-1)?.state).toMatchObject({ execution: { cache: { ttl_ms: null } } });
  });
  it('drops the cache floor when a request carries fewer messages and no session.compact announced it', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    let pick: [string, number] = ['medium', 0.95];
    const f = fakeEngine({ respond: (req) => answering({ ...CLEAR, effort: pick })(req) });
    const n = streamNext<TurnStepEvent>(undefined, { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000 });
    const turn = async (id: string, effort: [string, number], messageCount: number) => {
      pick = effort; f.clock.ms += 60_000;
      router.turnStart({ turnId: id, text: TEXT });
      await drain(router.turnStep(f.engine, step({ turnId: id, effort: 'xhigh', messageCount }), n.next));
      router.turnComplete({ turnId: id });
      return n.calls.at(-1)?.effort;
    };
    expect(await turn('t1', ['medium', 0.95], 40)).toBe('medium');
    expect(await turn('t2', ['low', 0.95], 42)).toBe('medium');
    expect(await turn('compacted', ['low', 0.95], 6)).toBe('low');
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'context_reset', scope: 'root', turn: 'compacted', messages_before: 42, messages_after: 6, announced: false }));
    router.contextChanged();
    expect(await turn('announced', ['low', 0.95], 3)).toBe('low');
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'context_reset', turn: 'announced', announced: true }));
  });
  it('routes a background task notification as the last request and never sends or remembers the notice', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: (req) => answering({ ...CLEAR, effort: ['medium', 0.95] })(req) });
    const NOTICE = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background agent finished</summary>\n</task-notification>';
    const turn = async (id: string, text: string) => {
      router.turnStart({ turnId: id, text });
      await drain(router.turnStep(f.engine, step({ turnId: id, effort: 'xhigh' }), streamNext<TurnStepEvent>().next));
      router.turnComplete({ turnId: id });
    };
    await turn('notice-first', NOTICE);
    expect(f.sent).toHaveLength(0);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', turn: 'notice-first', skipped: 'task_notification_without_request' }));
    await turn('human', TEXT);
    await turn('notice', NOTICE);
    expect(f.sent).toHaveLength(2);
    expect(f.sent.at(-1)?.state).toMatchObject({ task: { text: TEXT, recent_requests: [] } });
    expect(JSON.stringify(f.sent)).not.toContain('task-notification');
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', turn: 'notice', turn_source: 'task_notification' }));
    await turn('next', 'Now add a test for parseRecord.');
    expect(f.sent.at(-1)?.state).toMatchObject({ task: { text: 'Now add a test for parseRecord.', recent_requests: [{ text: TEXT }] } });
  });
  it('lowers effort only on a cold cache, holds it on a warm one, and always lets it rise', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    let pick: [string, number] = ['medium', 0.95];
    const f = fakeEngine({ respond: (req) => answering({ ...CLEAR, effort: pick })(req) });
    const n = streamNext<TurnStepEvent>(undefined, { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 } });
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
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', turn: 't2', proposed_patch: expect.objectContaining({ effort: 'low' }), patch: expect.objectContaining({ effort: 'medium' }), held_for_cache: 'low', reasons: expect.objectContaining({ effort: 'cache_preserved' }) }));
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
    const n = streamNext<TurnStepEvent>(undefined, { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 } });
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
    await drain(router.turnStep(f.engine, step({ turnId: 't3', model: 'claude-sonnet-5-5' }), sonnet.next));
    expect(sonnet.calls).toEqual([step({ turnId: 't3', model: 'claude-sonnet-5-5', effort: 'low' })]);
  });
});

describe('root effort and the prompt cache: the model that answered', () => {
  it('takes a response from another model as no warm cache on the one asked', async () => {
    const router = createRouter(configOf(EFFORT_ONLY));
    let pick: [string, number] = ['xhigh', 0.95];
    const f = fakeEngine({ respond: (req) => answering({ ...CLEAR, effort: pick })(req) });
    router.turnStart({ turnId: 't1', text: TEXT });
    await drain(router.turnStep(f.engine, step({ turnId: 't1', effort: 'xhigh' }), streamNext<TurnStepEvent>(() => 'claude-sonnet-5-5').next));
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
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
    await warmRoot(router, f, 'claude-haiku-5-5', 'high');
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    expect((await drain(router.turnStep(engine, step(), n.next))).chunks).toEqual(['chunk']);
    expect(n.calls).toEqual([{ ...step(), model: 'claude-haiku-5-5', effort: 'low' }]);

    router.agentOffer(OFFER_BUILT_IN('Explore'));
    const ok = spawnNext();
    expect(await router.agentSpawn(engine, spawn(), ok.next)).toEqual({ model: 'claude-haiku-5-5' });
    const failure = new Error('native spawn failed');
    const bad = spawnNext(() => {
      throw failure;
    });
    await expect(router.agentSpawn(engine, spawn({ tool_use_id: 'tu2' }), bad.next)).rejects.toBe(failure);
    expect(bad.calls).toEqual([{ ...spawn({ tool_use_id: 'tu2' }), model: 'claude-haiku-5-5' }]);
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
  it('never moves an inheriting built-in above its verified lower baseline, even on an upgrade answer past the upgrade floor', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    // 0.85 clears the upgrade floor (0.8); a spawn still never runs above the model it inherits.
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.85] }) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    const n = spawnNext();
    const e = spawn({ parentModel: 'claude-haiku-5-5' });
    await router.agentSpawn(f.engine, e, n.next);
    expect(n.calls).toEqual([e]);
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', from: 'claude-haiku-5-5', reasons: expect.objectContaining({ model: 'tool_ceiling' }) }));
  });

  it('forwards a spawn once, natively, when its assessment times out, and a late reply changes nothing', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const reply = deferred<HttpReply>();
    // The first assessment hangs; the next dispatch gets its own, which keeps the parent's model.
    const f = fakeEngine({ respond: (req) => (f.sent.length === 1 ? reply.promise : answering({ ...CLEAR, tier: ['deep', 0.95] })(req)) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
      router.agentOffer(OFFER_BUILT_IN('Explore'));
      const n = spawnNext();
      await router.agentSpawn(f.engine, e, n.next);
      expect(n.calls).toEqual([e]);
      expect(f.sent).toHaveLength(0);
      expect(f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', assessment: 'input_secret', sent: false }));
      expect(JSON.stringify(f.logs)).not.toContain(secret);
    }
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

  it('#42: a known model that no profile names is still placed by its documented role and routed to a reachable target', async () => {
    // Opus is an exact model the table knows, so its efforts and role are known; no configured profile needs to name it.
    const router = createRouter(configOf({ routeMainEffort: true, routeMainModel: true, routeSubagentModel: false, fastModel: 'claude-haiku-5-5', standardModel: 'claude-sonnet-5-5', deepModel: 'claude-fable-5-1' }), SWITCHES);
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95], tier: ['fast', 0.99] }) });
    await warmRoot(router, f, 'claude-sonnet-5-5', 'high');
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, step(), n.next));
    // Fast work, and the switch table reaches only Sonnet: the least capable offered role serves it.
    expect(n.calls).toEqual([{ ...step(), model: 'claude-sonnet-5-5', effort: 'low' }]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.questions).toHaveProperty('capability');
    expect(f.logs).toContainEqual(expect.objectContaining({ event: 'root', model_asked: true, patch: expect.objectContaining({ effort: 'low' }) }));
  });

  it('#42: a conditional level the model cannot take is not offered, and a lower unconditional one still applies', async () => {
    // Sonnet takes xhigh only conditionally; the step starts there, and the unconditional levels below it stay routable.
    // The handler asks about three described levels and maps them locally, so the offered set is read where it is made.
    expect(offerableEfforts({ model: 'claude-sonnet-5-5', effort: 'xhigh' })).toEqual(['low', 'medium', 'high']);
    const router = createRouter(configOf(EFFORT_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
    router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>();
    const sonnet = step({ model: 'claude-sonnet-5-5', effort: 'xhigh' });
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
    await warmRoot(lower, low, 'claude-sonnet-5-5', 'xhigh');
    lower.turnStart({ turnId: 't1', text: TEXT });
    const l = streamNext<TurnStepEvent>();
    await drain(lower.turnStep(low.engine, step({ effort: 'xhigh' }), l.next));
    expect(l.calls).toEqual([step({ model: 'claude-sonnet-5-5', effort: 'low' })]);
  });
});

describe('#81: control correctness', () => {
  it('routes current Haiku effort while preserving independent model locks and alias mappings', async () => {
    const cases: Array<[SpawnEvent, Record<string, boolean>]> = [
      [spawn({ model: 'claude-haiku-5-5' }), { routeExplicitSpawnModel: false }],
      [spawn({ model: 'claude-haiku-5-5' }), { routeSubagentModel: false }],
      [spawn({ parentModel: 'claude-haiku-5-5' }), { routeSubagentModel: false }],
    ];
    for (const [e, options] of cases) {
      const router = createRouter(configOf({ ...CHILD, ...options }));
      const f = fakeEngine({ respond: answering({ ...CLEAR, effort: ['low', 0.95] }) });
      router.agentOffer(OFFER_BUILT_IN('Explore'));
      const s = spawnNext(() => ({ model: 'claude-haiku-5-5', agentId: 'a1' }));
      await router.agentSpawn(f.engine, e, s.next);
      expect(s.calls, JSON.stringify(e)).toEqual([e]);
      expect(f.sent, JSON.stringify(e)).toHaveLength(1);
      expect(f.sent[0]?.questions).toHaveProperty('effort_0');
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
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
    spawns.agentOffer(OFFER_BUILT_IN('Explore'));
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
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
    router.agentOffer(OFFER_BUILT_IN('Explore'));
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
      router.agentOffer(OFFER_BUILT_IN('Explore'));
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
    await router.agentSpawn(f.engine, spawn({ subagentType: 'general-purpose' }), n.next);
    expect(f.sent).toHaveLength(1);
    expect(Object.keys(f.sent[0]!.questions)).toEqual(['capability', 'control', 'action_risk']);
    expect(n.calls[0]!.model).toBe('claude-sonnet-5-5');
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
    await router.agentSpawn(f.engine, spawn({ subagentType: 'general-purpose' }), n.next);
    expect(f.sent).toHaveLength(1); expect(n.calls[0]!.model).toBe('claude-sonnet-5-5');
    const stepNext = streamNext<TurnStepEvent>();
    await drain(router.turnStep(f.engine, childStep({ model: 'claude-haiku-5-5' }), stepNext.next));
    expect(stepNext.calls[0]!.effort).toBe('xhigh');
    expect(f.logs.some(l => l['event'] === 'spawn' && l['sent'] === true)).toBe(true);
  });
  it('keeps old mappings and resets saturation only for a new session', async () => {
    const router = createRouter(configOf(CHILD));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['deep', 0.95], effort: ['low', 0.95] }) });
    router.agentOffer(OFFER_BUILT_IN('Explore'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-opus-5-5', agentId: 'a1' })).next);
    saturate(router);
    const n = streamNext<TurnStepEvent>(); await drain(router.turnStep(f.engine, childStep(), n.next));
    expect(n.calls[0]!.effort).toBe('low');
    router.sessionEnd(); router.agentOffer(OFFER_BUILT_IN('Explore'));
    await router.agentSpawn(f.engine, spawn(), spawnNext().next);
    expect(f.sent.at(-1)!.questions).toHaveProperty('effort_0');
  });
  it('keeps necessary pin checks but sends no question when the model is pinned', async () => {
    const router = createRouter(configOf(CHILD)); const f = fakeEngine({ pins: { subagentModel: true } });
    router.agentOffer(OFFER_BUILT_IN('Explore')); saturate(router);
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
    const n = spawnNext(); await router.agentSpawn(f.engine, spawn({ subagentType: 'general-purpose' }), n.next);
    expect(n.calls[0]!.model).toBe('claude-sonnet-5-5');
    expect(f.sent[0]!.questions).not.toHaveProperty('effort');
    expect(f.logs.find(l => l['event'] === 'spawn')?.['assessment']).toBe('ok');
  });

});


describe('native spawn outcome observability', () => {
  const NATIVE = { ...SPAWN_ONLY, routeExplicitSpawnModel: false, routeSubagentEffort: false };
  const nativeRecord = async (e: SpawnEvent, observed: string, over: { pins?: Record<string, boolean>; offer?: string; cfg?: Partial<typeof NATIVE> } = {}) => {
    const router = createRouter(configOf({ ...NATIVE, ...over.cfg }));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['standard', 0.95] }), ...(over.pins ? { pins: over.pins } : {}) }); router.agentOffer(OFFER_BUILT_IN(over.offer ?? 'general-purpose'));
    const n = spawnNext(() => ({ model: observed, agentId: 'child' }));
    await router.agentSpawn(f.engine, e, n.next);
    expect(n.calls).toEqual([e]);
    return f.logs.find(r => r.event === 'spawn_native_result');
  };

  it('records a denial without changing the input or spawning twice', async () => {
    const router = createRouter(configOf(NATIVE));
    const f = fakeEngine(); router.agentOffer(OFFER_BUILT_IN('Explore'));
    const e = spawn({ model: 'claude-opus-5-5' }); const outcome: SpawnOutcome = { deny: 'native refusal' };
    const n = spawnNext(() => outcome);
    expect(await router.agentSpawn(f.engine, e, n.next)).toBe(outcome);
    expect(n.calls).toEqual([e]); expect(f.sent).toHaveLength(0);
    expect(f.logs.find(r => r.event === 'spawn_native_result')).toMatchObject({ denied: true });
  });

  it('confirms an explicit model, alias or id, against what the host ran', async () => {
    expect(await nativeRecord(spawn({ model: 'claude-opus-5-5' }), 'claude-opus-5-5')).toMatchObject({ requested: 'claude-opus-5-5', confirmation: 'confirmed' });
    expect(await nativeRecord(spawn({ model: 'sonnet' }), 'claude-sonnet-5-5')).toMatchObject({ confirmation: 'confirmed' });
  });

  it('flags a real mismatch of an explicit model', async () => {
    expect(await nativeRecord(spawn({ model: 'claude-opus-5-5' }), 'claude-sonnet-5-5')).toMatchObject({ requested: 'claude-opus-5-5', observed: 'claude-sonnet-5-5', confirmation: 'mismatch' });
  });

  it('expects the parent for an inheriting built-in and for a fork', async () => {
    expect(await nativeRecord(spawn({ subagentType: 'Plan' }), 'claude-opus-5-5', { offer: 'Plan', cfg: { routeSubagentModel: false, routeSubagentEffort: true } })).toMatchObject({ requested: 'claude-opus-5-5', confirmation: 'confirmed' });
    expect(await nativeRecord(spawn({ subagentType: 'Plan' }), 'claude-sonnet-5-5', { offer: 'Plan', cfg: { routeSubagentModel: false, routeSubagentEffort: true } })).toMatchObject({ requested: 'claude-opus-5-5', confirmation: 'mismatch' });
    expect(await nativeRecord(spawn({ fork: true }), 'claude-opus-5-5')).toMatchObject({ requested: 'claude-opus-5-5', confirmation: 'confirmed' });
  });

  it('does not read the parent as the request of an agent whose profile model is not known (#224)', async () => {
    // A sonnet-profile agent under an opus parent with no model argument: the host ran its own profile's model.
    const e = spawn({ subagentType: 'tester', provider: { plugin: 'user', tier: 'local' } });
    for (const cfg of [{}, { routeSubagentEffort: true }]) {
      const record = await nativeRecord(e, 'claude-sonnet-5-5', { cfg });
      expect(record).toMatchObject({ requested: null, observed: 'claude-sonnet-5-5', confirmation: 'unobserved' });
      expect(record).not.toHaveProperty('reason');
    }
  });

  it('leaves a model pin unconfirmed whatever the call named', async () => {
    expect(await nativeRecord(spawn({ model: 'claude-opus-5-5' }), 'claude-haiku-5-5', { pins: { subagentModel: true } })).toMatchObject({ requested: null, confirmation: 'unobserved' });
  });

  it('never holds the spawn result on a stalled pin read behind a mismatch', async () => {
    const router = createRouter(configOf(NATIVE));
    const f = fakeEngine(); f.engine.pins = () => new Promise(() => {}); router.agentOffer(OFFER_BUILT_IN('Explore'));
    const run = router.agentSpawn(f.engine, spawn({ model: 'claude-opus-5-5' }), spawnNext(() => ({ model: 'claude-sonnet-5-5' })).next);
    await settle(); f.expire(); await run;
    expect(f.logs.find(r => r.event === 'spawn_native_result')).toMatchObject({ requested: null, observed: 'claude-sonnet-5-5', confirmation: 'unobserved' });
  });

  it('records a Router patch as a spawn result against the patched model, not as a native one', async () => {
    const router = createRouter(configOf(SPAWN_ONLY));
    const f = fakeEngine({ respond: answering({ ...CLEAR, tier: ['fast', 0.95] }) }); router.agentOffer(OFFER_BUILT_IN('Explore'));
    await router.agentSpawn(f.engine, spawn(), spawnNext(() => ({ model: 'claude-sonnet-5-5' })).next);
    expect(f.logs.some(r => r.event === 'spawn_native_result')).toBe(false);
    expect(f.logs.find(r => r.event === 'spawn_result')).toMatchObject({ requested: 'claude-haiku-5-5', observed: 'claude-sonnet-5-5', reason: 'model_mismatch' });
  });
});


it('rechecks the common frontier switch before delivering a prepared Fable root patch', async () => {
  const router=createRouter(configOf({routeMainModel:true,routeMainEffort:false,routeSubagentModel:false}));
  const f=fakeEngine({respond:answering({...CLEAR,tier:['frontier',.99]})});
  let reads=0;f.engine.frontierEnabled=async()=>++reads===1;
  router.turnStart({turnId:'t1',text:TEXT});const n=streamNext<TurnStepEvent>();
  await drain(router.turnStep(f.engine,step({model:'claude-sonnet-5-5'}),n.next));
  expect(f.sent[0]?.questions.capability?.criteria).toHaveProperty('open_problem');
  expect(n.calls[0]?.model).toBe('claude-sonnet-5-5');
  expect(f.logs).toContainEqual(expect.objectContaining({event:'root_stop',reason:'model_not_allowed'}));
});

describe('root baseline across a resume', () => {
  const ROOT = { routeMainModel: true, routeMainEffort: true, ...SUBAGENT_OFF, ...FULL_IDS };
  const COUNTS = { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 1000 };
  /** One process of a session: a router and its engine over the plugin store `store`, which outlives the process. */
  const processOf = (store: Map<string, unknown>, respond: Responder, host?: { model?: string; effort?: SymbolicEffort }, extra = {}) => {
    const router = createRouter(configOf({ ...ROOT, ...extra }));
    const f = fakeEngine({ respond });
    f.engine.loadRoot = async () => store.get('session');
    f.engine.sessionId = async () => 'session';
    f.engine.saveRoot = async record => { store.set('session', JSON.parse(JSON.stringify(record))); };
    if (host?.model) f.engine.hostModel = async () => host.model;
    f.engine.currentEffort = async () => host?.effort;
    return { router, f };
  };
  const turn = async ({ router, f }: ReturnType<typeof processOf>, turnId: string, model: string, effort: SymbolicEffort, messageCount: number) => {
    router.turnStart({ turnId, text: TEXT });
    const n = streamNext<TurnStepEvent>(undefined, COUNTS);
    await drain(router.turnStep(f.engine, { turnId, index: 0, model, effort, messageCount }, n.next));
    await drain(router.turnStep(f.engine, { turnId, index: 1, model, effort, messageCount: messageCount + 2 }, n.next));
    router.turnComplete({ turnId, reason: 'answer', answer: 'Done.' });
    await settle();
    return n.calls.map(c => [c.model, c.effort]);
  };
  const KEEP = answering({ ...CLEAR, tier: ['deep', 0.99], effort: ['xhigh', 0.99] });
  const FAIL = () => ({ status: 503, text: '{}' });
  const DRIFTED = () => new Map<string, unknown>([['session', { native: { model: 'claude-opus-5-5', effort: 'xhigh' }, routed: { model: 'claude-haiku-5-5', effort: 'low' }, drift: null, origin: 'turn.step' }]]);

  it('resumes after its own downgrade on the native pair, not the restored one', async () => {
    const store = new Map<string, unknown>();
    const first = processOf(store, answering({ ...CLEAR, tier: ['fast', 0.99], effort: ['low', 0.99] }));
    await warmRoot(first.router, first.f, 'claude-haiku-5-5', 'xhigh');
    expect(await turn(first, 't1', 'claude-opus-5-5', 'xhigh', 3)).toEqual([['claude-haiku-5-5', 'low'], ['claude-haiku-5-5', 'low']]);
    expect(store.get('session')).toMatchObject({ native: { model: 'claude-opus-5-5', effort: 'xhigh' }, routed: { model: 'claude-haiku-5-5', effort: 'low' } });
    first.router.sessionEnd();
    // The host resumes the main loop on the model of the last answer, Haiku, at Haiku's own effort.
    const resumed = processOf(store, KEEP);
    expect(await turn(resumed, 't2', 'claude-haiku-5-5', 'medium', 40)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    expect(await turn(resumed, 't3', 'claude-haiku-5-5', 'medium', 44)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    expect(resumed.f.logs.filter(l => l.event === 'root')).toEqual([0, 1].map(() => expect.objectContaining({
      baseline_source: 'stored_native', from: { model: 'claude-opus-5-5', effort: 'xhigh' }, incoming: { model: 'claude-haiku-5-5', effort: 'medium' }, proposed_patch: {} })));
  });

  // A cold process holds every downgrade (no prefix observed yet), so the model stays native; the effort is still routed.
  it.each([
    ['a held downgrade', answering({ ...CLEAR, tier: ['fast', 0.99], effort: ['low', 0.99] }), 'low'],
    ['an unclear request', answering({ control: ['needs_context', 0.9], action_risk: ['ordinary', 0.97], tier: ['fast', 0.95] }), 'xhigh'],
    ['a failed assessment', () => ({ status: 503, text: '{}' }), 'xhigh'],
  ] as const)('runs a resumed drift on the native model after %s', async (_, respond, effort) => {
    const resumed = processOf(DRIFTED(), respond);
    expect(await turn(resumed, 't1', 'claude-haiku-5-5', 'medium', 40)).toEqual([['claude-opus-5-5', effort], ['claude-opus-5-5', effort]]);
  });

  // #258: a resumed process judged its first downgrade with no prefix, so the guard held it as cost_unknown_hold.
  it.each([
    ['restores the last process cache observation for a resumed request', 40, 'cost_allows', 'claude-haiku-5-5'],
    ['restores nothing for a request shorter than the observed one (a compaction since)', 2, 'cost_unknown_hold', 'claude-opus-5-5'],
  ] as const)('%s', async (_, messageCount, reason, model) => {
    const store = new Map<string, unknown>();
    const first = processOf(store, KEEP);
    await turn(first, 't1', 'claude-opus-5-5', 'xhigh', 3);
    expect(store.get('session')).toMatchObject({ cache: { messages: 5, seen: [expect.objectContaining({ model: 'claude-opus-5-5', read: 20_000 })] } });
    first.router.sessionEnd();
    const resumed = processOf(store, answering({ ...CLEAR, tier: ['fast', 0.99], effort: ['low', 0.99] }));
    expect((await turn(resumed, 't2', 'claude-opus-5-5', 'xhigh', messageCount))[0]?.[0]).toBe(model);
    expect(resumed.f.logs.find(l => l.event === 'root')).toMatchObject({ cost_reason: reason, proposed_patch: expect.objectContaining({ model: 'claude-haiku-5-5' }) });
    expect(resumed.f.logs.some(l => l.event === 'cache_restored')).toBe(reason === 'cost_allows');
    // #263: a skipped restore names its cause and both counts.
    expect(resumed.f.logs.find(l => l.event === 'cache_restore_skipped')).toEqual(reason === 'cost_allows' ? undefined
      : expect.objectContaining({ reason: 'shorter_request', request_messages: messageCount, stored_messages: 5 }));
  });

  // #263: after two task notifications the last request carried 44 messages and the resumed one 39, so the count read the
  // resume as a compaction; the host transcript was 11 at the save and 12 resumed.
  it.each([
    ['restores across a resume whose request is shorter than the saved one while the transcript is not', 12, true],
    ['restores nothing for a transcript shorter than the saved one (a compaction since)', 3, false],
  ] as const)('%s', async (_, resumedLength, restored) => {
    const store = new Map<string, unknown>();
    const first = processOf(store, KEEP);
    first.f.engine.transcript = async () => ({ length: 11, answered: true });
    await turn(first, 't1', 'claude-opus-5-5', 'xhigh', 42);
    await settle();
    expect(store.get('session')).toMatchObject({ cache: { messages: 44, transcript: 11 } });
    first.router.sessionEnd();
    const resumed = processOf(store, answering({ ...CLEAR, tier: ['fast', 0.99], effort: ['low', 0.99] }));
    resumed.f.engine.transcript = async () => ({ length: resumedLength, answered: true });
    await turn(resumed, 't2', 'claude-opus-5-5', 'xhigh', 39);
    expect(resumed.f.logs.some(l => l.event === 'cache_restored')).toBe(restored);
    expect(resumed.f.logs.find(l => l.event === 'cache_restore_skipped')).toEqual(restored ? undefined
      : expect.objectContaining({ reason: 'shorter_request', request_messages: 39, stored_messages: 44, transcript: 3, stored_transcript: 11 }));
  });

  it('never restores over an environment pin', async () => {
    const resumed = processOf(DRIFTED(), KEEP);
    Object.assign(resumed.f.pins, { mainModel: true, mainEffort: true });
    expect(await turn(resumed, 't1', 'claude-haiku-5-5', 'medium', 40)).toEqual([['claude-haiku-5-5', 'medium'], ['claude-haiku-5-5', 'medium']]);
  });

  it("honours a person's /model after the drift, in the same process and the next", async () => {
    const store = DRIFTED();
    const resumed = processOf(store, answering({ ...CLEAR, tier: ['standard', 0.99], effort: ['high', 0.99] }));
    expect(await turn(resumed, 't1', 'claude-haiku-5-5', 'medium', 40)).toEqual([['claude-opus-5-5', 'high'], ['claude-opus-5-5', 'high']]);
    // /model sonnet at medium: neither the drift nor the Router's last request, so it is the person's.
    expect(await turn(resumed, 't2', 'claude-sonnet-5-5', 'medium', 44)).toEqual([['claude-sonnet-5-5', 'high'], ['claude-sonnet-5-5', 'high']]);
    expect(resumed.f.logs.filter(l => l.event === 'root').at(-1)).toMatchObject({ baseline_source: 'turn.step', from: { model: 'claude-sonnet-5-5', effort: 'medium' } });
    expect(store.get('session')).toMatchObject({ native: { model: 'claude-sonnet-5-5', effort: 'medium' }, drift: null });
    resumed.router.sessionEnd();
    const again = processOf(store, KEEP);
    expect(await turn(again, 't3', 'claude-sonnet-5-5', 'medium', 50)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    expect(again.f.logs.filter(l => l.event === 'root').at(-1)).toMatchObject({ from: { model: 'claude-sonnet-5-5' }, cost_reason: 'upgrade_allowed' });
  });

  it("starts a main-loop subagent on the native model while the main loop is the drift; a subagent's own child keeps its parent", async () => {
    const resumed = processOf(DRIFTED(), KEEP, undefined, { routeSubagentModel: true });
    await turn(resumed, 't1', 'claude-haiku-5-5', 'medium', 40);
    resumed.router.agentOffer(OFFER_BUILT_IN('Explore'));
    const main = spawnNext();
    await resumed.router.agentSpawn(resumed.f.engine, spawn({ parentModel: 'claude-haiku-5-5' }), main.next);
    expect(main.calls.map(c => [c.model, c.parentModel])).toEqual([['claude-opus-5-5', 'claude-haiku-5-5']]);
    expect(resumed.f.logs).toContainEqual(expect.objectContaining({ event: 'spawn_result', tool_use_id: 'tu1', requested: 'claude-opus-5-5', observed: 'claude-opus-5-5' }));
    const nested = spawnNext();
    await resumed.router.agentSpawn(resumed.f.engine, spawn({ tool_use_id: 'tu2', parentModel: 'claude-haiku-5-5', parentAgentId: 'a1' }), nested.next);
    expect(nested.calls[0]?.model).toBeUndefined();
  });

  it("takes a new conversation's own model when a session has no record, and the host's settings for one under way", async () => {
    // Settings name Sonnet; a new conversation starts on Opus: that is the person's own choice.
    const fresh = processOf(new Map(), FAIL, { model: 'sonnet', effort: 'xhigh' });
    expect(await turn(fresh, 't1', 'claude-opus-5-5', 'high', 1)).toEqual([['claude-opus-5-5', 'high'], ['claude-opus-5-5', 'high']]);
    expect(fresh.f.logs.filter(l => l.event === 'root')).toEqual([expect.objectContaining({ baseline_source: 'turn.step', from: { model: 'claude-opus-5-5', effort: 'high' } })]);
    // #259: a conversation under way with no record (one from before it was kept) may have resumed on the Router's own
    // last pair, as a 0.8.23 session last routed to Sonnet resumed there under 0.8.24 and stayed: the settings model is native.
    const resumed = processOf(new Map(), FAIL, { model: 'opus', effort: 'xhigh' });
    await turn(resumed, 't1', 'claude-sonnet-5-5', 'xhigh', 40);
    expect(resumed.f.logs.filter(l => l.event === 'root')).toEqual([expect.objectContaining({ baseline_source: 'host_environment', from: { model: 'claude-opus-5-5', effort: 'xhigh' } })]);
    const same = processOf(new Map(), FAIL, { model: 'sonnet', effort: 'xhigh' });
    await turn(same, 't1', 'claude-sonnet-5-5', 'xhigh', 40);
    expect(same.f.logs.filter(l => l.event === 'root')).toEqual([expect.objectContaining({ baseline_source: 'turn.step' })]);
    const unnamed = processOf(new Map(), KEEP, { model: 'opus', effort: 'xhigh' });
    expect(await turn(unnamed, 't1', '', 'medium', 40)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    expect(unnamed.f.logs.filter(l => l.event === 'root')).toEqual([expect.objectContaining({ baseline_source: 'host_environment', from: { model: 'claude-opus-5-5', effort: 'xhigh' } })]);
  });

  // #263: the host's first request of a new session carries its context messages (17 on 2.1.303), so the count read it as a
  // conversation under way and ran a new `--model opus` session on the settings model. A prior assistant message decides.
  it.each([
    ['a new session whose first request carries the host context', false, 'claude-opus-5-5', 'turn.step'],
    ['a resumed session with no record', true, 'claude-sonnet-5-5', 'host_environment'],
  ] as const)('reads %s by its prior assistant message, not its message count', async (_, answered, model, source) => {
    const s = processOf(new Map(), FAIL, { model: 'sonnet', effort: 'high' });
    s.f.engine.transcript = async () => ({ length: answered ? 12 : 1, answered });
    expect((await turn(s, 't1', 'claude-opus-5-5', 'high', 17))[0]?.[0]).toBe(model);
    expect(s.f.logs.find(l => l.event === 'root')).toMatchObject({ baseline_source: source });
    expect(s.f.logs.find(l => l.event === 'cache_restore_skipped')).toEqual(answered ? expect.objectContaining({ reason: 'no_record', request_messages: 17, stored_messages: null, transcript: 12 }) : undefined);
  });

  it('reads a failed assistant-message read as a new conversation', async () => {
    const s = processOf(new Map(), FAIL, { model: 'sonnet', effort: 'high' });
    s.f.engine.transcript = async () => { throw new Error('unreadable'); };
    expect((await turn(s, 't1', 'claude-opus-5-5', 'high', 17))[0]?.[0]).toBe('claude-opus-5-5');
  });

  it("honours a person's /model to the Router's last model later in the session", async () => {
    const store = new Map<string, unknown>();
    let failing = false;
    const s = processOf(store, req => failing ? FAIL() : KEEP(req));
    expect(await turn(s, 't1', 'claude-haiku-5-5', 'medium', 1)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    failing = true;
    // /model opus: the host never moves its main loop mid-session, so Opus is the person's even though the Router last asked for it.
    expect(await turn(s, 't2', 'claude-opus-5-5', 'high', 5)).toEqual([['claude-opus-5-5', 'high'], ['claude-opus-5-5', 'high']]);
    expect(store.get('session')).toMatchObject({ native: { model: 'claude-opus-5-5', effort: 'high' }, drift: null });
  });

  it("honours a resumed pair the host's settings name, though it equals the Router's last request", async () => {
    const store = new Map<string, unknown>([['session', { native: { model: 'claude-haiku-5-5', effort: 'medium' }, routed: { model: 'claude-opus-5-5', effort: 'xhigh' }, drift: null, origin: 'turn.step' }]]);
    const resumed = processOf(store, FAIL, { model: 'opus' });
    expect(await turn(resumed, 't1', 'claude-opus-5-5', 'high', 40)).toEqual([['claude-opus-5-5', 'high'], ['claude-opus-5-5', 'high']]);
    expect(store.get('session')).toMatchObject({ native: { model: 'claude-opus-5-5', effort: 'high' }, drift: null });
  });

  it("never carries one session's native pair into the next session of the same process", async () => {
    const sessions = { a: DRIFTED(), b: new Map<string, unknown>() };
    let current = sessions.a;
    const s = processOf(current, FAIL);
    s.f.engine.loadRoot = async () => current.get('session');
    s.f.engine.saveRoot = async record => { current.set('session', JSON.parse(JSON.stringify(record))); };
    expect(await turn(s, 't1', 'claude-haiku-5-5', 'medium', 40)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    s.router.sessionEnd();
    current = sessions.b;
    expect(await turn(s, 't2', 'claude-haiku-5-5', 'medium', 1)).toEqual([['claude-haiku-5-5', 'medium'], ['claude-haiku-5-5', 'medium']]);
    expect(sessions.b.get('session')).toMatchObject({ native: { model: 'claude-haiku-5-5', effort: 'medium' }, drift: null });
  });

  it('never writes a save queued in one session under the next', async () => {
    const sessions: Record<string, Map<string, unknown>> = { a: DRIFTED(), b: new Map() };
    let current = 'a';
    let release = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const s = processOf(sessions.a!, FAIL);
    s.f.engine.loadRoot = async () => sessions[current]!.get('session');
    s.f.engine.sessionId = async () => current;
    // The first save is slow, so the next waits behind it; a store that is not told the session writes the live one.
    let saves = 0;
    s.f.engine.saveRoot = async (record: RootRecord, id?: string) => {
      const key = id ?? current;
      if (saves++ === 0) await gate;
      sessions[key]!.set('session', JSON.parse(JSON.stringify(record)));
    };
    await turn(s, 't1', 'claude-haiku-5-5', 'medium', 40);
    await turn(s, 't2', 'claude-haiku-5-5', 'high', 44);
    s.router.sessionEnd();
    current = 'b';
    release();
    await settle();
    expect(await turn(s, 't3', 'claude-haiku-5-5', 'medium', 1)).toEqual([['claude-haiku-5-5', 'medium'], ['claude-haiku-5-5', 'medium']]);
    expect(sessions.b!.get('session')).toMatchObject({ native: { model: 'claude-haiku-5-5', effort: 'medium' }, drift: null });
  });

  it("drops a drift once the host's settings model changes, so a failed assessment keeps the turn's own model", async () => {
    const host = { model: 'opus' };
    const resumed = processOf(DRIFTED(), FAIL, host);
    expect(await turn(resumed, 't1', 'claude-haiku-5-5', 'medium', 40)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    expect(await turn(resumed, 't2', 'claude-haiku-5-5', 'medium', 44)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    host.model = 'haiku';
    expect(await turn(resumed, 't3', 'claude-haiku-5-5', 'medium', 48)).toEqual([['claude-haiku-5-5', 'medium'], ['claude-haiku-5-5', 'medium']]);
  });

  it("goes on unrouted when the settings re-read during a drift outlasts the budget", async () => {
    const s = processOf(DRIFTED(), FAIL, { model: 'opus' });
    expect(await turn(s, 't1', 'claude-haiku-5-5', 'medium', 40)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    const read = deferred<string | undefined>();
    s.f.engine.hostModel = () => read.promise;
    s.router.turnStart({ turnId: 't2', text: TEXT });
    const n = streamNext<TurnStepEvent>(undefined, COUNTS);
    let done = false;
    const run = drain(s.router.turnStep(s.f.engine, { turnId: 't2', index: 0, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 44 }, n.next)).then(() => { done = true; });
    await settle();
    s.f.expire();
    await settle();
    expect(done).toBe(true);
    expect(n.calls.map(c => [c.model, c.effort])).toEqual([['claude-haiku-5-5', 'medium']]);
    expect(s.f.logs).toContainEqual(expect.objectContaining({ event: 'budget_timeout', turn: 't2' }));
    read.resolve('opus');
    await run;
  });

  it('never applies a first read of the record once a newer root turn began', async () => {
    const store = DRIFTED();
    const saved = store.get('session');
    const s = processOf(store, FAIL);
    const read = deferred<unknown>();
    s.f.engine.loadRoot = () => read.promise;
    s.router.turnStart({ turnId: 't1', text: TEXT });
    const late = streamNext<TurnStepEvent>(undefined, COUNTS);
    const first = drain(s.router.turnStep(s.f.engine, { turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 40 }, late.next));
    await settle();
    expect(await turn(s, 't2', 'claude-sonnet-5-5', 'medium', 44)).toEqual([['claude-sonnet-5-5', 'medium'], ['claude-sonnet-5-5', 'medium']]);
    read.resolve(saved);
    await first;
    expect(late.calls.map(c => [c.model, c.effort])).toEqual([['claude-haiku-5-5', 'medium']]);
    expect(await turn(s, 't3', 'claude-haiku-5-5', 'medium', 48)).toEqual([['claude-haiku-5-5', 'medium'], ['claude-haiku-5-5', 'medium']]);
  });

  it("drops a drift when the settings re-read fails, even after a first read that named no model", async () => {
    const s = processOf(DRIFTED(), FAIL);
    let failing = false;
    s.f.engine.hostModel = async () => { if (failing) throw new Error('settings unreadable'); return undefined; };
    expect(await turn(s, 't1', 'claude-haiku-5-5', 'medium', 40)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    expect(await turn(s, 't2', 'claude-haiku-5-5', 'medium', 44)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    failing = true;
    expect(await turn(s, 't3', 'claude-haiku-5-5', 'medium', 48)).toEqual([['claude-haiku-5-5', 'medium'], ['claude-haiku-5-5', 'medium']]);
  });

  it.each([
    ['Fable is off', { allowFable: false }, undefined],
    ['Fable is not in the allowlist', {}, ['claude-opus-5-5']],
  ] as const)('never restores a stored native model that may not be sent: %s', async (_, extra, available) => {
    const store = new Map<string, unknown>([['session', { native: { model: 'claude-fable-5-1', effort: 'high' }, routed: { model: 'claude-opus-5-5', effort: 'high' }, drift: null, origin: 'turn.step' }]]);
    const resumed = processOf(store, FAIL, undefined, extra);
    resumed.f.allowed.models = available;
    expect(await turn(resumed, 't1', 'claude-opus-5-5', 'high', 40)).toEqual([['claude-opus-5-5', 'high'], ['claude-opus-5-5', 'high']]);
  });

  it.each([
    ['the allowlist names only Haiku', 'claude-opus-5-5', KEEP],
    ['Fable is turned off while Jev answers', 'claude-fable-5-1', answering({ ...CLEAR, tier: ['frontier', 0.99], effort: ['xhigh', 0.99] })],
  ] as const)('never starts a main-loop subagent on a native model that may not be sent: %s', async (_, native, answer) => {
    const store = new Map<string, unknown>([['session', { native: { model: native, effort: 'xhigh' }, routed: { model: 'claude-haiku-5-5', effort: 'low' }, drift: null, origin: 'turn.step' }]]);
    let spawning = false;
    let reads = 0;
    const resumed = processOf(store, answer, undefined, { routeSubagentModel: true });
    // Fable is on for the spawn's first two reads, its baseline and its decision, and off once the decision is made.
    resumed.f.engine.frontierEnabled = async () => !spawning || ++reads <= 2;
    expect(await turn(resumed, 't1', 'claude-haiku-5-5', 'medium', 40)).toEqual([[native, 'xhigh'], [native, 'xhigh']]);
    if (native === 'claude-opus-5-5') resumed.f.allowed.models = ['claude-haiku-5-5'];
    spawning = true;
    resumed.router.agentOffer(OFFER_BUILT_IN('Explore'));
    const main = spawnNext();
    await resumed.router.agentSpawn(resumed.f.engine, spawn({ parentModel: 'claude-haiku-5-5' }), main.next);
    expect(main.calls).toHaveLength(1);
    expect(main.calls[0]?.model).toBeUndefined();
  });

  it("never lets an earlier turn's late settings re-read overwrite a newer turn's record", async () => {
    const store = DRIFTED();
    const s = processOf(store, FAIL, { model: 'opus' });
    expect(await turn(s, 't1', 'claude-haiku-5-5', 'medium', 40)).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    const read = deferred<string | undefined>();
    s.f.engine.hostModel = () => read.promise;
    s.router.turnStart({ turnId: 't2', text: TEXT });
    const late = drain(s.router.turnStep(s.f.engine, { turnId: 't2', index: 0, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 44 }, streamNext<TurnStepEvent>(undefined, COUNTS).next));
    await settle();
    s.f.engine.hostModel = async () => 'opus';
    // /model sonnet in the next turn: the person's own pair, stored as native.
    expect(await turn(s, 't3', 'claude-sonnet-5-5', 'medium', 48)).toEqual([['claude-sonnet-5-5', 'medium'], ['claude-sonnet-5-5', 'medium']]);
    expect(store.get('session')).toMatchObject({ native: { model: 'claude-sonnet-5-5', effort: 'medium' }, drift: null });
    read.resolve('haiku');
    await late;
    await settle();
    expect(store.get('session')).toMatchObject({ native: { model: 'claude-sonnet-5-5', effort: 'medium' }, drift: null });
    expect(await turn(s, 't4', 'claude-sonnet-5-5', 'medium', 52)).toEqual([['claude-sonnet-5-5', 'medium'], ['claude-sonnet-5-5', 'medium']]);
  });

  it('runs a first step dispatched again while the record is read on the stored record, once', async () => {
    const store = DRIFTED();
    const saved = store.get('session');
    const s = processOf(store, KEEP);
    const read = deferred<unknown>();
    s.f.engine.loadRoot = () => read.promise;
    s.router.turnStart({ turnId: 't1', text: TEXT });
    const n = streamNext<TurnStepEvent>(undefined, COUNTS);
    const first: TurnStepEvent = { turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 40 };
    const runs = [drain(s.router.turnStep(s.f.engine, first, n.next)), drain(s.router.turnStep(s.f.engine, { ...first }, n.next))];
    await settle();
    read.resolve(saved);
    await Promise.all(runs);
    await settle();
    expect(n.calls.map(c => [c.model, c.effort])).toEqual([['claude-opus-5-5', 'xhigh'], ['claude-opus-5-5', 'xhigh']]);
    expect(store.get('session')).toMatchObject({ native: { model: 'claude-opus-5-5', effort: 'xhigh' }, drift: { model: 'claude-haiku-5-5' } });
    expect(s.f.sent).toHaveLength(1);
  });

  it("keeps a custom agent's declared model while the main loop drifts; only an inheriting agent takes the native one", async () => {
    const store = new Map<string, unknown>([['session', { native: { model: 'claude-sonnet-5-5', effort: 'high' }, routed: { model: 'claude-haiku-5-5', effort: 'low' }, drift: null, origin: 'turn.step' }]]);
    let failing = false;
    const resumed = processOf(store, req => failing ? FAIL() : KEEP(req), undefined, { routeSubagentModel: true, routeSubagentEffort: true });
    await turn(resumed, 't1', 'claude-haiku-5-5', 'medium', 40);
    const custom = (declared: string, id: string) => {
      resumed.f.engine.agentModel = async () => declared;
      return spawn({ tool_use_id: id, subagentType: 'guardian', provider: { plugin: 'user', tier: 'local' }, parentModel: 'claude-haiku-5-5' });
    };
    // A complex task on an agent declaring Opus: deep keeps Opus, and the host runs the agent's own model.
    const declared = spawnNext();
    await resumed.router.agentSpawn(resumed.f.engine, custom('opus', 'tu1'), declared.next);
    expect(declared.calls[0]?.model).toBeUndefined();
    expect(resumed.f.logs).toContainEqual(expect.objectContaining({ event: 'spawn', tool_use_id: 'tu1', from: 'claude-opus-5-5' }));
    failing = true;
    const unanswered = spawnNext();
    await resumed.router.agentSpawn(resumed.f.engine, custom('opus', 'tu2'), unanswered.next);
    expect(unanswered.calls[0]?.model).toBeUndefined();
    const inheriting = spawnNext();
    await resumed.router.agentSpawn(resumed.f.engine, custom('inherit', 'tu3'), inheriting.next);
    expect(inheriting.calls[0]?.model).toBe('claude-sonnet-5-5');
  });
});
