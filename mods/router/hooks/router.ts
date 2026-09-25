import type { ClientReason, Transport, Usage } from './client.ts';
import { createClient } from './client.ts';
import type { RouterConfig } from './config.ts';
import { validKey } from './config.ts';
import type { SymbolicEffort } from './models.ts';
import { factsOf, sameModel } from './models.ts';
import type { Baseline, DimensionReason, MutableDimensions, PolicyOptions, RoutingPatch, RoutingTask } from './policy.ts';
import { buildQuestions, buildState, choosePatch, offerableEfforts, offerableTiers, validateAnswers } from './policy.ts';

/**
 * The Router's handlers over a structural engine. register.ts adapts the host's `$` to RouterEngine (the environment
 * names must be literals there); tests pass a fake. Every optional step catches its own failure before `next`, and
 * nothing after `next` can throw: a hook that fails is skipped by the host, and a skipped hook must never mean a
 * second native call.
 */
export interface HostPins {
  /** ANTHROPIC_MODEL: the root model was chosen outside this plugin. */
  mainModel: boolean;
  /** CLAUDE_CODE_EFFORT_LEVEL: the root effort was chosen outside this plugin. */
  mainEffort: boolean;
  /** CLAUDE_CODE_SUBAGENT_MODEL or its _FORCE form: the host overrides every child model anyway. */
  subagentModel: boolean;
  /** ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL: an alias no longer names the model this table describes. */
  aliasRemap: boolean;
}

export interface RouterEngine extends Transport {
  envKey: () => Promise<string | undefined>;
  pins: () => Promise<HostPins>;
  /** The settings allowlist when one is set. */
  availableModels: () => Promise<readonly string[] | undefined>;
  /** The host's release (`SessionVersion.base`), or undefined when it is not spelled as one. */
  hostBase: () => Promise<string | undefined>;
  log: (line: string) => void;
}

export interface TurnStartEvent {
  text: string;
  turnId: string;
}
export interface TurnStepEvent {
  turnId: string;
  index: number;
  model: string;
  effort?: SymbolicEffort | number;
  agentId?: string;
}
export interface TurnStepOutcome {
  usage: { model: string } | null;
}
export interface TurnEndEvent {
  turnId: string;
  agentId?: string;
}
export interface OfferEvent {
  agent: string;
  source: string;
  provider: { plugin: string; tier: string };
}
export interface SpawnEvent {
  tool_use_id: string;
  prompt: string;
  description: string;
  subagentType: string;
  provider: { plugin: string; tier: string };
  model?: string;
  parentModel: string;
  fork: boolean;
}
export type SpawnOutcome = { model: string; deny?: undefined } | { deny: string; model?: undefined };

type StreamNextLike<E, C, R> = ((e: E) => AsyncGenerator<C, R>) & { readonly signal: AbortSignal };
type NextLike<E, R> = ((e: E) => Promise<R>) & { readonly signal: AbortSignal };

/**
 * The host release whose built-in agent definitions were read for this contract: general-purpose and claude carry no
 * model, Plan is `inherit`, Explore is `inherit` capped at opus outside haiku..opus. Another release may differ, so
 * its spawns stay native until someone reads its definitions again.
 */
export const VERIFIED_HOST = '2.1.282';
const INHERITING_BUILT_INS = new Set(['general-purpose', 'claude', 'Plan', 'Explore']);
const EXPLORE_FAMILIES = new Set(['haiku', 'sonnet', 'opus']);
/** A Lean executor prompt: its packet is not visible here, so its model is Lean's and native's to decide (#44). */
const LEAN_MARKER = /jev-lean-[0-9a-f]{16}/;
const MAX_TURNS = 16;
const MAX_OFFERS = 64;

const ABORTED = Symbol('aborted');
/** Waits for `p` unless `signal` ends the wait first. `p` itself is never cancelled by this. */
const until = <T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> => {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(ABORTED);
      },
    );
  });
};

/** Insertion-ordered and bounded: past `max` the oldest entry goes, through `onEvict`. */
const bounded = <K, V>(max: number, onEvict?: (v: V) => void): Map<K, V> & { put: (k: K, v: V) => void } => {
  const m = new Map<K, V>();
  return Object.assign(m, {
    put: (k: K, v: V): void => {
      m.delete(k);
      m.set(k, v);
      while (m.size > max) {
        const oldest = m.keys().next();
        if (oldest.done) break;
        const evicted = m.get(oldest.value);
        m.delete(oldest.value);
        if (evicted !== undefined) onEvict?.(evicted);
      }
    },
  });
};

type KeyState = { key: string } | { reason: 'key_missing' | 'key_invalid' };

interface TurnRouting {
  baseline: Baseline;
  controller: AbortController;
  pending: Promise<void> | null;
  patch: RoutingPatch;
  /** The whole turn is native from here on: skipped, diverged or retired. */
  stopped: boolean;
  modelStopped: boolean;
  effortStopped: boolean;
}

type Assessed =
  | { kind: 'skipped'; reason: string }
  | { kind: 'assessed'; assessment: 'ok' | ClientReason; usage: Usage | null; sent: boolean; patch: RoutingPatch; model: DimensionReason; effort: DimensionReason };

export const createRouter = (config: RouterConfig) => {
  const rootEnabled = config.enabled && (config.routeMainEffort || config.routeMainModel);
  const spawnEnabled = config.enabled && config.routeSubagentModel;
  const turnTexts = bounded<string, string>(MAX_TURNS);
  const turns = bounded<string, TurnRouting>(MAX_TURNS, (t) => t.controller.abort());
  const offers = bounded<string, boolean>(MAX_OFFERS);
  const spawnsPending = new Map<string, Promise<string | null>>();
  let session = new AbortController();
  let keyState: Promise<KeyState> | null = null;
  let pinState: Promise<HostPins> | null = null;
  let diagnosed = false;

  const log = (engine: RouterEngine, record: Record<string, unknown>): void => {
    if (!config.logDecisions) return;
    try {
      engine.log(`jev-router ${JSON.stringify(record)}`);
    } catch {
      // A diagnostic never reaches the result.
    }
  };

  const client = createClient({ timeoutMs: config.timeoutMs });

  const resolveKey = (engine: RouterEngine): Promise<KeyState> => {
    keyState ??= (async (): Promise<KeyState> => {
      if (config.explicitKey.kind === 'valid') return { key: config.explicitKey.value };
      // An explicit value that cannot be sent never quietly selects a different account's key.
      if (config.explicitKey.kind === 'invalid') return { reason: 'key_invalid' };
      const v = await engine.envKey();
      if (v === undefined || v.trim() === '') return { reason: 'key_missing' };
      return validKey(v) ? { key: v } : { reason: 'key_invalid' };
    })().catch((): KeyState => ({ reason: 'key_missing' }));
    return keyState;
  };

  const pinsOf = (engine: RouterEngine): Promise<HostPins> => {
    // An unreadable environment is treated as pinned everywhere: nothing is changed on a guess.
    pinState ??= engine.pins().catch(() => ({ mainModel: true, mainEffort: true, subagentModel: true, aliasRemap: true }));
    return pinState;
  };

  const diagnose = async (engine: RouterEngine): Promise<void> => {
    if (diagnosed) return;
    diagnosed = true;
    const key = await resolveKey(engine);
    log(engine, {
      event: 'router',
      root_effort: config.routeMainEffort,
      root_model: config.routeMainModel,
      spawn_model: config.routeSubagentModel,
      key: 'key' in key ? 'present' : key.reason,
      tiers: config.tiers,
      tier_issues: config.tierIssues,
    });
  };

  const policy = (scope: 'root' | 'spawn', availableModels: readonly string[] | undefined): PolicyOptions => ({
    scope,
    tiers: config.tiers,
    minUpgradeConfidence: config.minUpgradeConfidence,
    minDowngradeConfidence: config.minDowngradeConfidence,
    availableModels,
  });

  /** One request for one task. Never throws. */
  const assess = async (engine: RouterEngine, task: RoutingTask, baseline: Baseline, dims: MutableDimensions, opts: PolicyOptions, signal: AbortSignal): Promise<Assessed> => {
    const questions = buildQuestions(dims);
    if (!questions) return { kind: 'skipped', reason: 'nothing_to_change' };
    const key = await resolveKey(engine);
    if (!('key' in key)) return { kind: 'skipped', reason: key.reason };
    const res = await client.assess(engine, key.key, buildState(task), questions, signal);
    if (!res.ok) return { kind: 'assessed', assessment: res.reason, usage: res.usage, sent: res.sent, patch: {}, model: 'not_asked', effort: 'not_asked' };
    const decision = choosePatch(validateAnswers(res.answers, questions), baseline, dims, opts);
    return { kind: 'assessed', assessment: 'ok', usage: res.usage, sent: true, ...decision };
  };

  // ---------------------------------------------------------------------------------------------- root

  const retire = (turnId: string): void => {
    const t = turns.get(turnId);
    if (t) {
      t.stopped = true;
      t.controller.abort();
      turns.delete(turnId);
    }
    turnTexts.delete(turnId);
  };

  const rootAssessment = async (engine: RouterEngine, turnId: string, t: TurnRouting, text: string): Promise<void> => {
    let outcome: Assessed;
    try {
      const pins = await pinsOf(engine);
      const available = config.routeMainModel && !pins.mainModel ? await engine.availableModels().catch(() => []) : undefined;
      const opts = policy('root', available);
      const dims: MutableDimensions = {
        tiers: config.routeMainModel && !pins.mainModel ? offerableTiers(t.baseline, opts) : null,
        efforts: config.routeMainEffort && !pins.mainEffort ? offerableEfforts(t.baseline, 'root') : null,
      };
      outcome = await assess(engine, { scope: 'root', text }, t.baseline, dims, opts, t.controller.signal);
    } catch {
      outcome = { kind: 'skipped', reason: 'internal_error' };
    }
    // A turn retired while this was in flight keeps its native parameters; a late answer reaches no other turn.
    if (!t.stopped && outcome.kind === 'assessed') t.patch = outcome.patch;
    if (Object.keys(t.patch).length === 0) t.stopped = true;
    log(engine, {
      event: 'root',
      turn: turnId,
      from: { model: t.baseline.model, effort: t.baseline.effort ?? null },
      ...(outcome.kind === 'skipped'
        ? { skipped: outcome.reason }
        : { assessment: outcome.assessment, sent: outcome.sent, usage: outcome.usage, patch: outcome.patch, reasons: { model: outcome.model, effort: outcome.effort } }),
    });
  };

  /** The stored patch for this step, or null. Incoming values that differ from the baseline win for the rest of the turn. */
  const applyStored = (engine: RouterEngine, t: TurnRouting, e: TurnStepEvent): RoutingPatch | null => {
    if (t.stopped) return null;
    if (e.model !== t.baseline.model || e.effort !== t.baseline.effort) {
      t.stopped = true;
      log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'incoming_divergence' });
      return null;
    }
    const model = !t.modelStopped ? t.patch.model : undefined;
    const finalModel = model ?? e.model;
    const effort = !t.effortStopped && t.patch.effort !== undefined && factsOf(finalModel)?.unconditionalEffort.includes(t.patch.effort) ? t.patch.effort : undefined;
    const patch: RoutingPatch = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
    return Object.keys(patch).length > 0 ? patch : null;
  };

  const prepareStep = async (engine: RouterEngine, e: TurnStepEvent, signal: AbortSignal): Promise<RoutingPatch | null> => {
    if (!rootEnabled || e.agentId !== undefined) return null;
    const known = turns.get(e.turnId);
    if (known) {
      // A later step of this turn, or the same first step dispatched again while its assessment is pending.
      if (known.pending && (await until(known.pending, signal)) === ABORTED) return null;
      return turns.get(e.turnId) === known ? applyStored(engine, known, e) : null;
    }
    // Routing never starts halfway through a turn.
    if (e.index !== 0) return null;
    void diagnose(engine);
    const t: TurnRouting = {
      baseline: { model: e.model, ...(e.effort !== undefined ? { effort: e.effort } : {}) },
      controller: new AbortController(),
      pending: null,
      patch: {},
      stopped: false,
      modelStopped: false,
      effortStopped: false,
    };
    turns.put(e.turnId, t);
    const onSessionEnd = (): void => t.controller.abort();
    session.signal.addEventListener('abort', onSessionEnd, { once: true });
    const text = turnTexts.get(e.turnId);
    if (text === undefined || text.trim() === '') {
      t.stopped = true;
      log(engine, { event: 'root', turn: e.turnId, skipped: 'no_task_text' });
      return null;
    }
    t.pending = rootAssessment(engine, e.turnId, t, text).finally(() => session.signal.removeEventListener('abort', onSessionEnd));
    if ((await until(t.pending, signal)) === ABORTED) return null;
    return turns.get(e.turnId) === t ? applyStored(engine, t, e) : null;
  };

  const observeStep = (engine: RouterEngine, e: TurnStepEvent, patch: RoutingPatch | null, result: TurnStepOutcome | void): void => {
    try {
      if (!patch?.model) return;
      const t = turns.get(e.turnId);
      if (!t) return;
      const seen = result && typeof result.usage?.model === 'string' ? result.usage.model : null;
      // Missing is unknown, not confirmation: the override is not reapplied on a guess.
      if (seen === null || !sameModel(patch.model, seen)) {
        t.modelStopped = true;
        const facts = seen === null ? null : factsOf(seen);
        if (patch.effort !== undefined && !facts?.unconditionalEffort.includes(patch.effort)) t.effortStopped = true;
        log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: seen === null ? 'model_unobserved' : 'model_mismatch', requested: patch.model, observed: seen });
      }
    } catch {
      // Observation only.
    }
  };

  async function* turnStep<E extends TurnStepEvent, C, R extends TurnStepOutcome | void>(engine: RouterEngine, e: E, next: StreamNextLike<E, C, R>): AsyncGenerator<C, R | void> {
    let patch: RoutingPatch | null = null;
    try {
      patch = await prepareStep(engine, e, next.signal);
    } catch {
      patch = null;
    }
    // An aborted signal means the dispatch already went on without this hook; a next() now would open a second request.
    if (next.signal.aborted) return;
    // Once next starts, every chunk, the return, a refusal or an error belongs to the host: nothing here retries it.
    const result = yield* next(patch ? { ...e, ...patch } : e);
    observeStep(engine, e, patch, result);
    return result;
  }

  // ---------------------------------------------------------------------------------------------- spawn

  const spawnSkip = (engine: RouterEngine, e: SpawnEvent, reason: string): null => {
    log(engine, { event: 'spawn', tool_use_id: e.tool_use_id, type: e.subagentType, skipped: reason });
    return null;
  };

  const spawnAssessment = async (engine: RouterEngine, e: SpawnEvent, baseline: Baseline, opts: PolicyOptions, tiers: MutableDimensions['tiers']): Promise<string | null> => {
    const task: RoutingTask = { scope: 'spawn', text: e.prompt, description: e.description, subagentType: e.subagentType };
    const outcome = await assess(engine, task, baseline, { tiers, efforts: null }, opts, session.signal);
    if (outcome.kind === 'skipped') return spawnSkip(engine, e, outcome.reason);
    log(engine, {
      event: 'spawn',
      tool_use_id: e.tool_use_id,
      type: e.subagentType,
      from: baseline.model,
      assessment: outcome.assessment,
      sent: outcome.sent,
      usage: outcome.usage,
      patch: outcome.patch,
      reasons: { model: outcome.model },
    });
    return outcome.patch.model ?? null;
  };

  const spawnTarget = async (engine: RouterEngine, e: SpawnEvent, signal: AbortSignal): Promise<string | null> => {
    if (!spawnEnabled) return null;
    // Native ignores a fork's model and inherits the parent's context and model.
    if (e.fork) return spawnSkip(engine, e, 'fork');
    if (e.model !== undefined && e.model.trim() !== '') return spawnSkip(engine, e, 'explicit_model');
    void diagnose(engine);
    const pins = await pinsOf(engine);
    if (pins.subagentModel) return spawnSkip(engine, e, 'subagent_model_pinned');
    if (pins.aliasRemap) return spawnSkip(engine, e, 'alias_remapped');
    if (!INHERITING_BUILT_INS.has(e.subagentType)) return spawnSkip(engine, e, 'type_unverified');
    // A user's or a plugin's agent can carry a built-in's name; only the listing's own source says which one runs.
    if (offers.get(e.subagentType) !== true || e.provider.plugin !== 'engine' || e.provider.tier !== 'core') return spawnSkip(engine, e, 'definition_unverified');
    if ((await engine.hostBase().catch(() => undefined)) !== VERIFIED_HOST) return spawnSkip(engine, e, 'host_unverified');
    const family = factsOf(e.parentModel)?.family;
    if (e.subagentType === 'Explore' && (family === undefined || !EXPLORE_FAMILIES.has(family))) return spawnSkip(engine, e, 'baseline_unknown');
    if (LEAN_MARKER.test(e.prompt) || LEAN_MARKER.test(e.description)) return spawnSkip(engine, e, 'lean_marker');
    const baseline: Baseline = { model: e.parentModel };
    const opts = policy('spawn', await engine.availableModels().catch(() => []));
    const tiers = offerableTiers(baseline, opts);
    if (!tiers) return spawnSkip(engine, e, 'rank_unknown');

    // Only the engine's own identity for this dispatch shares a pending answer; equal text never does.
    let pending = spawnsPending.get(e.tool_use_id);
    if (!pending) {
      pending = spawnAssessment(engine, e, baseline, opts, tiers).catch(() => null);
      spawnsPending.set(e.tool_use_id, pending);
      const settled = pending;
      void settled.finally(() => {
        if (spawnsPending.get(e.tool_use_id) === settled) spawnsPending.delete(e.tool_use_id);
      });
    }
    const target = await until(pending, signal);
    return target === ABORTED ? null : target;
  };

  const agentSpawn = async <E extends SpawnEvent, R extends SpawnOutcome>(engine: RouterEngine, e: E, next: NextLike<E, R>): Promise<R> => {
    let target: string | null = null;
    try {
      target = await spawnTarget(engine, e, next.signal);
    } catch {
      target = null;
    }
    // As on turn.step: the host has already spawned natively, so nothing here may spawn again.
    if (next.signal.aborted) throw new Error('jev-router: spawn dispatch abandoned before next');
    const result = await next(target !== null ? { ...e, model: target } : e);
    try {
      if (target !== null) {
        if (result.deny !== undefined) log(engine, { event: 'spawn_result', tool_use_id: e.tool_use_id, denied: true });
        else if (!sameModel(target, result.model)) log(engine, { event: 'spawn_result', tool_use_id: e.tool_use_id, reason: 'model_mismatch', requested: target, observed: result.model });
      }
    } catch {
      // Observation only.
    }
    return result;
  };

  // ---------------------------------------------------------------------------------------------- lifecycle

  return {
    rootEnabled,
    spawnEnabled,
    turnStart: <E extends TurnStartEvent>(e: E): void => {
      if (rootEnabled) turnTexts.put(e.turnId, e.text);
    },
    turnStep,
    /** A child's completion carries its agentId and never retires the root's turn. */
    turnComplete: <E extends TurnEndEvent>(e: E): void => {
      if (e.agentId === undefined) retire(e.turnId);
    },
    agentOffer: <E extends OfferEvent>(e: E): void => {
      if (spawnEnabled) offers.put(e.agent, e.source === 'built-in' && e.provider.plugin === 'engine' && e.provider.tier === 'core');
    },
    agentSpawn,
    sessionEnd: (): void => {
      session.abort();
      session = new AbortController();
      for (const id of [...turns.keys()]) retire(id);
      turnTexts.clear();
      offers.clear();
      spawnsPending.clear();
      keyState = null;
      pinState = null;
      diagnosed = false;
    },
    inFlight: client.inFlight,
  };
};

export type Router = ReturnType<typeof createRouter>;
