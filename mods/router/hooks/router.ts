import type { ClientReason, Transport, Usage } from './client.ts';
import { createClient } from './client.ts';
import type { RouterConfig } from './config.ts';
import { validKey } from './config.ts';
import type { RootSwitch, SymbolicEffort } from './models.ts';
import { answeredBy, factsOf, sameModel, VERIFIED_ROOT_SWITCHES } from './models.ts';
import type { Baseline, DimensionReason, MutableDimensions, PolicyOptions, RoutedEffort, RoutingPatch, RoutingTask } from './policy.ts';
import { allowedBy, buildQuestions, buildState, choosePatch, offerableEfforts, offerableTiers, pairValid, validateAnswers } from './policy.ts';

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
export type SpawnOutcome = { model: string; agentId?: string; deny?: undefined } | { deny: string; model?: undefined };

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

/** The four counts a response reports, and nothing else of it. Per step; overlapping totals are #45's to normalize. */
const COUNTS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
const countsOf = (usage: unknown): Record<string, number> | null => {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  return Object.fromEntries(COUNTS.flatMap((k) => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? [[k, u[k]]] : [])));
};

const ABORTED = Symbol('aborted');
/** Waits for `p` unless `signal` ends the wait first. `p` itself is never cancelled by this. */
/**
 * One read that any number of callers wait on, each until its own signal aborts. `p` must not reject. An aborted
 * waiter is dropped at once rather than held until a read that may never end.
 */
const sharedRead = <T>(p: Promise<T>): ((signal: AbortSignal) => Promise<T | typeof ABORTED>) => {
  const waiters = new Set<(v: T) => void>();
  let done: { v: T } | null = null;
  void p.then((v) => {
    done = { v };
    for (const w of waiters) w(v);
    waiters.clear();
  });
  return (signal) => {
    if (done) return Promise.resolve(done.v);
    if (signal.aborted) return Promise.resolve(ABORTED);
    return new Promise((resolve) => {
      const onAbort = (): void => {
        waiters.delete(settle);
        resolve(ABORTED);
      };
      const settle = (v: T): void => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      };
      waiters.add(settle);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
};

/** Thrown when a wait ends with its turn, dispatch or session; the call then stays native. */
const ENDED = Symbol('ended');

const NO_ROOT_PINS = { mainModel: false, mainEffort: false } as const;

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

const within = async <T>(p: Promise<T>, live: AbortSignal): Promise<T> => {
  const r = await until(p, live);
  if (r === ABORTED) throw ENDED;
  return r;
};

/** A signal that aborts when any of `signals` does. `dispose` detaches it once the wait it served is over. */
const linked = (...signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } => {
  const c = new AbortController();
  const onAbort = (): void => c.abort();
  for (const s of signals) {
    if (s.aborted) c.abort();
    else s.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: c.signal, dispose: () => signals.forEach((s) => s.removeEventListener('abort', onAbort)) };
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

/** `rootSwitches` is the verified list; tests pass their own to reach the root-model path. */
export const createRouter = (config: RouterConfig, rootSwitches: readonly RootSwitch[] = VERIFIED_ROOT_SWITCHES) => {
  const rootEnabled = config.enabled && (config.routeMainEffort || config.routeMainModel);
  const spawnEnabled = config.enabled && config.routeSubagentModel;
  const turnTexts = bounded<string, string>(MAX_TURNS);
  const turns = bounded<string, TurnRouting>(MAX_TURNS, (t) => t.controller.abort());
  const offers = bounded<string, boolean>(MAX_OFFERS);
  let session = new AbortController();
  let keyWait: ((signal: AbortSignal) => Promise<KeyState | typeof ABORTED>) | null = null;
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

  /** Read once per session; each caller waits only as long as its own signal allows. */
  const keyFor = (engine: RouterEngine, signal: AbortSignal): Promise<KeyState | typeof ABORTED> => {
    keyWait ??= sharedRead(
      (async (): Promise<KeyState> => {
        if (config.explicitKey.kind === 'valid') return { key: config.explicitKey.value };
        // An explicit value that cannot be sent never quietly selects a different account's key.
        if (config.explicitKey.kind === 'invalid') return { reason: 'key_invalid' };
        const v = await engine.envKey();
        if (v === undefined || v.trim() === '') return { reason: 'key_missing' };
        return validKey(v) ? { key: v } : { reason: 'key_invalid' };
      })().catch((): KeyState => ({ reason: 'key_missing' })),
    );
    return keyWait(signal);
  };

  /** Read on every use: another Mod can set a pin mid-session, and a pin set after a decision still wins. */
  const pinsOf = (engine: RouterEngine): Promise<HostPins> =>
    // An unreadable environment is treated as pinned everywhere: nothing is changed on a guess.
    engine.pins().catch(() => ({ mainModel: true, mainEffort: true, subagentModel: true, aliasRemap: true }));

  const diagnose = async (engine: RouterEngine): Promise<void> => {
    if (diagnosed) return;
    diagnosed = true;
    const key = await keyFor(engine, session.signal);
    if (key === ABORTED) return;
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
    ...(scope === 'root' ? { rootSwitches } : {}),
  });

  /** One request for one task. Never throws. A reply after the wait ended is logged against `late`, never applied. */
  const assess = async (
    engine: RouterEngine,
    key: string,
    task: RoutingTask,
    baseline: Baseline,
    dims: MutableDimensions,
    opts: PolicyOptions,
    signal: AbortSignal,
    late: Record<string, unknown>,
  ): Promise<Assessed> => {
    const questions = buildQuestions(dims);
    if (!questions) return { kind: 'skipped', reason: 'nothing_to_change' };
    const onLate = (usage: Usage | null): void => log(engine, { event: 'late', ...late, usage });
    const res = await client.assess(engine, key, buildState(task), questions, signal, onLate);
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

  /** What a root turn could be asked, under these pins and allowlist. */
  const rootDims = (
    baseline: Baseline,
    pins: { mainModel: boolean; mainEffort: boolean },
    available: readonly string[] | undefined,
  ): { dims: MutableDimensions; opts: PolicyOptions; withheld?: string } => {
    const opts = policy('root', available);
    const efforts = config.routeMainEffort && !pins.mainEffort ? offerableEfforts(baseline, 'root') : null;
    const offer = config.routeMainModel && !pins.mainModel ? offerableTiers(baseline, opts, efforts) : null;
    return { dims: { tiers: offer && 'tiers' in offer ? offer.tiers : null, efforts }, opts, ...(offer && 'reason' in offer ? { withheld: offer.reason } : {}) };
  };

  const rootAssessment = async (engine: RouterEngine, turnId: string, t: TurnRouting, text: string): Promise<void> => {
    let outcome: Assessed;
    let withheld: string | undefined;
    // Every wait here ends when the turn is retired.
    const live = t.controller.signal;
    try {
      // Pins and the allowlist can only narrow what the event and configuration allow, so a turn with nothing to ask
      // even without them never waits for the key or a read.
      const ceiling = rootDims(t.baseline, NO_ROOT_PINS, undefined);
      if (!buildQuestions(ceiling.dims)) {
        withheld = ceiling.withheld;
        outcome = { kind: 'skipped', reason: 'nothing_to_change' };
      } else {
        // The key comes next: without one nothing optional is read.
        const key = await keyFor(engine, live);
        if (key === ABORTED) throw ENDED;
        if (!('key' in key)) outcome = { kind: 'skipped', reason: key.reason };
        else {
          const pins = await within(pinsOf(engine), live);
          const available = config.routeMainModel && !pins.mainModel ? await within(engine.availableModels().catch(() => []), live) : undefined;
          const r = rootDims(t.baseline, pins, available);
          withheld = r.withheld;
          outcome = await assess(engine, key.key, { scope: 'root', text }, t.baseline, r.dims, r.opts, live, { scope: 'root', turn: turnId });
        }
      }
    } catch (err) {
      outcome = { kind: 'skipped', reason: err === ENDED ? 'turn_retired' : 'internal_error' };
    }
    // A turn retired while this was in flight keeps its native parameters; a late answer reaches no other turn.
    if (!t.stopped && outcome.kind === 'assessed') t.patch = outcome.patch;
    if (Object.keys(t.patch).length === 0) t.stopped = true;
    log(engine, {
      event: 'root',
      turn: turnId,
      from: { model: t.baseline.model, effort: t.baseline.effort ?? null },
      ...(withheld !== undefined ? { model_withheld: withheld } : {}),
      ...(outcome.kind === 'skipped'
        ? { skipped: outcome.reason }
        : { assessment: outcome.assessment, sent: outcome.sent, usage: outcome.usage, patch: outcome.patch, reasons: { model: outcome.model, effort: outcome.effort } }),
    });
  };

  /**
   * The stored patch for this step, or null. Incoming values that differ from the baseline win for the rest of the
   * turn, and so does a pin set since the decision.
   */
  const applyStored = async (engine: RouterEngine, t: TurnRouting, e: TurnStepEvent, live: AbortSignal): Promise<RoutingPatch | null> => {
    if (t.stopped) return null;
    if (e.model !== t.baseline.model || e.effort !== t.baseline.effort) {
      t.stopped = true;
      log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'incoming_divergence' });
      return null;
    }
    // The allowlist is read before the pins, so a pin is the last thing read before next: one set during an earlier
    // await still takes effect.
    const storedModel = !t.modelStopped ? t.patch.model : undefined;
    const allowed = storedModel !== undefined ? await within(engine.availableModels().catch(() => []), live) : undefined;
    const pins = await within(pinsOf(engine), live);
    if (t.stopped) return null;
    if (pins.mainModel && !t.modelStopped && t.patch.model !== undefined) {
      t.modelStopped = true;
      log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'model_pinned' });
    }
    if (pins.mainEffort && !t.effortStopped && t.patch.effort !== undefined) {
      t.effortStopped = true;
      log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'effort_pinned' });
    }
    if (!t.modelStopped && storedModel !== undefined && !allowedBy(storedModel, allowed)) {
      t.modelStopped = true;
      log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'model_not_allowed' });
    }
    const effortOn = (m: string): RoutedEffort | undefined =>
      !t.effortStopped && t.patch.effort !== undefined && factsOf(m)?.unconditionalEffort.includes(t.patch.effort) ? t.patch.effort : undefined;
    let model = !t.modelStopped ? t.patch.model : undefined;
    // The pair was checked when it was chosen. Once its effort is suppressed the request keeps its own, and the model
    // goes only if it takes that one too, rather than sending a pair nothing approved.
    if (model !== undefined && !pairValid(model, effortOn(model) ?? e.effort)) {
      t.modelStopped = true;
      model = undefined;
      log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'pair_invalid' });
    }
    const effort = effortOn(model ?? e.model);
    const patch: RoutingPatch = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
    return Object.keys(patch).length > 0 ? patch : null;
  };

  /** A patch, with the turn it was stored on: next is given it only while that turn is still the live one. */
  type Prepared = { patch: RoutingPatch; turn: TurnRouting };
  /** Its reads end with the turn or the dispatch, and then the step goes on native. */
  const stored = async (engine: RouterEngine, t: TurnRouting, e: TurnStepEvent, signal: AbortSignal): Promise<Prepared | null> => {
    if (turns.get(e.turnId) !== t) return null;
    const live = linked(signal, t.controller.signal);
    try {
      const patch = await applyStored(engine, t, e, live.signal);
      return patch ? { patch, turn: t } : null;
    } catch (err) {
      if (err === ENDED) return null;
      throw err;
    } finally {
      live.dispose();
    }
  };

  const prepareStep = async (engine: RouterEngine, e: TurnStepEvent, signal: AbortSignal): Promise<Prepared | null> => {
    if (!rootEnabled || e.agentId !== undefined) return null;
    const known = turns.get(e.turnId);
    if (known) {
      // A later step of this turn, or the same first step dispatched again while its assessment is pending.
      if (known.pending && (await until(known.pending, signal)) === ABORTED) return null;
      return await stored(engine, known, e, signal);
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
    // sessionEnd retires every turn, which aborts its controller: no session listener is needed here.
    turns.put(e.turnId, t);
    const text = turnTexts.get(e.turnId);
    if (text === undefined || text.trim() === '') {
      t.stopped = true;
      log(engine, { event: 'root', turn: e.turnId, skipped: 'no_task_text' });
      return null;
    }
    t.pending = rootAssessment(engine, e.turnId, t, text);
    if ((await until(t.pending, signal)) === ABORTED) return null;
    return await stored(engine, t, e, signal);
  };

  /**
   * The host dispatched this step natively without waiting for the hook. The turn stays native from here, so a later
   * step never switches away from what the abandoned one ran on.
   */
  const abandon = (engine: RouterEngine, e: TurnStepEvent): void => {
    if (!rootEnabled || e.agentId !== undefined) return;
    const t = turns.get(e.turnId);
    if (!t || t.stopped) return;
    t.stopped = true;
    t.controller.abort();
    log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'step_abandoned' });
  };

  const observeStep = (engine: RouterEngine, e: TurnStepEvent, patch: RoutingPatch | null, result: TurnStepOutcome | void): void => {
    try {
      if (!patch) return;
      const t = turns.get(e.turnId);
      if (!t) return;
      const requested = patch.model ?? e.model;
      const seen = result && typeof result.usage?.model === 'string' ? result.usage.model : null;
      log(engine, { event: 'root_result', turn: e.turnId, index: e.index, applied: patch, observed: seen, usage: result ? countsOf(result.usage) : null });
      // Missing is unknown, not confirmation: the override is not reapplied on a guess. A model override needs its own
      // variant reported back, so a bare id does not confirm a requested [1m]. An effort-only patch is checked too, since
      // the host can answer from a fallback; effort depends only on the model, so there the variant is not asked for.
      const confirmed = seen !== null && (patch.model !== undefined ? sameModel(patch.model, seen) : answeredBy(e.model, seen));
      if (!confirmed) {
        if (patch.model !== undefined) t.modelStopped = true;
        const facts = seen === null ? null : factsOf(seen);
        if (patch.effort !== undefined && !facts?.unconditionalEffort.includes(patch.effort)) t.effortStopped = true;
        log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: seen === null ? 'model_unobserved' : 'model_mismatch', requested, observed: seen });
      }
    } catch {
      // Observation only.
    }
  };

  async function* turnStep<E extends TurnStepEvent, C, R extends TurnStepOutcome | void>(engine: RouterEngine, e: E, next: StreamNextLike<E, C, R>): AsyncGenerator<C, R | void> {
    const own = session.signal;
    let prepared: Prepared | null = null;
    try {
      prepared = await prepareStep(engine, e, next.signal);
    } catch {
      prepared = null;
    }
    // An aborted signal means the dispatch already went on without this hook; a next() now would open a second request.
    if (next.signal.aborted) {
      abandon(engine, e);
      return;
    }
    // Checked here, in the handler, rather than where the patch was made: nothing is awaited between this and next, so
    // a session that ended or a turn retired or stopped while the step was prepared gives it no patch.
    let patch = prepared?.patch ?? null;
    if (prepared && (own.aborted || prepared.turn.stopped || turns.get(e.turnId) !== prepared.turn)) {
      patch = null;
      log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: own.aborted ? 'session_ended' : 'turn_stopped' });
    }
    // Once next starts, every chunk, the return, a refusal or an error belongs to the host: nothing here retries it.
    const result = yield* next(patch ? { ...e, ...patch } : e);
    observeStep(engine, e, patch, result);
    return result;
  }

  // ---------------------------------------------------------------------------------------------- spawn

  /** A type the Router does not route is caller text: it is never logged, only named as other. */
  const typeLabel = (e: SpawnEvent): string => (INHERITING_BUILT_INS.has(e.subagentType) ? e.subagentType : 'other');

  const spawnSkip = (engine: RouterEngine, e: SpawnEvent, reason: string): null => {
    log(engine, { event: 'spawn', tool_use_id: e.tool_use_id, type: typeLabel(e), skipped: reason });
    return null;
  };

  const spawnAssessment = async (
    engine: RouterEngine,
    key: string,
    e: SpawnEvent,
    baseline: Baseline,
    opts: PolicyOptions,
    tiers: MutableDimensions['tiers'],
    signal: AbortSignal,
  ): Promise<string | null> => {
    const task: RoutingTask = { scope: 'spawn', text: e.prompt, description: e.description, subagentType: e.subagentType };
    const outcome = await assess(engine, key, task, baseline, { tiers, efforts: null }, opts, signal, { scope: 'spawn', tool_use_id: e.tool_use_id });
    if (outcome.kind === 'skipped') return spawnSkip(engine, e, outcome.reason);
    log(engine, {
      event: 'spawn',
      tool_use_id: e.tool_use_id,
      type: typeLabel(e),
      from: baseline.model,
      assessment: outcome.assessment,
      sent: outcome.sent,
      usage: outcome.usage,
      patch: outcome.patch,
      reasons: { model: outcome.model },
    });
    return outcome.patch.model ?? null;
  };

  const spawnDecision = async (engine: RouterEngine, e: SpawnEvent, live: AbortSignal): Promise<string | null> => {
    if (!spawnEnabled) return null;
    // Native ignores a fork's model and inherits the parent's context and model.
    if (e.fork) return spawnSkip(engine, e, 'fork');
    if (e.model !== undefined && e.model.trim() !== '') return spawnSkip(engine, e, 'explicit_model');
    void diagnose(engine);
    // What the event, configuration and offer cache decide comes before any wait.
    if (!INHERITING_BUILT_INS.has(e.subagentType)) return spawnSkip(engine, e, 'type_unverified');
    // A user's or a plugin's agent can carry a built-in's name; only the listing's own source says which one runs.
    if (offers.get(e.subagentType) !== true || e.provider.plugin !== 'engine' || e.provider.tier !== 'core') return spawnSkip(engine, e, 'definition_unverified');
    const family = factsOf(e.parentModel)?.family;
    if (e.subagentType === 'Explore' && (family === undefined || !EXPLORE_FAMILIES.has(family))) return spawnSkip(engine, e, 'baseline_unknown');
    if (LEAN_MARKER.test(e.prompt) || LEAN_MARKER.test(e.description)) return spawnSkip(engine, e, 'lean_marker');
    const baseline: Baseline = { model: e.parentModel };
    // The allowlist can only narrow this.
    const ceiling = offerableTiers(baseline, policy('spawn', undefined));
    if ('reason' in ceiling) return spawnSkip(engine, e, ceiling.reason);
    // The key comes next: without one nothing optional is read.
    const key = await keyFor(engine, live);
    if (key === ABORTED) throw ENDED;
    if (!('key' in key)) return spawnSkip(engine, e, key.reason);
    const pins = await within(pinsOf(engine), live);
    if (pins.subagentModel) return spawnSkip(engine, e, 'subagent_model_pinned');
    if (pins.aliasRemap) return spawnSkip(engine, e, 'alias_remapped');
    if ((await within(engine.hostBase().catch(() => undefined), live)) !== VERIFIED_HOST) return spawnSkip(engine, e, 'host_unverified');
    const opts = policy('spawn', await within(engine.availableModels().catch(() => []), live));
    const offer = offerableTiers(baseline, opts);
    if ('reason' in offer) return spawnSkip(engine, e, offer.reason);

    // Each dispatch is assessed on its own text rather than sharing one answer per tool_use_id: a redispatch under
    // that id can carry another prompt, which would then run on a tier earned by different text.
    let target: string | null;
    try {
      target = await spawnAssessment(engine, key.key, e, baseline, opts, offer.tiers, live);
    } catch {
      target = null;
    }
    if (target === null) return null;
    // A pin or a narrower allowlist can arrive while Jev answers, so they are read again here rather than trusted from
    // before the request: what applies is what holds when the spawn is made. The pins are read last, after the
    // allowlist, so no await separates them from next.
    const allowed = await within(engine.availableModels().catch(() => []), live);
    const now = await within(pinsOf(engine), live);
    const stop = now.subagentModel
      ? 'subagent_model_pinned'
      : now.aliasRemap
        ? 'alias_remapped'
        : !allowedBy(target, allowed)
          ? 'target_not_allowed'
          : null;
    if (stop) {
      log(engine, { event: 'spawn_stop', tool_use_id: e.tool_use_id, reason: stop, requested: target });
      return null;
    }
    return target;
  };

  /**
   * Every wait of a dispatch ends with it or with `own`, the session it began in, rather than the one current when a
   * wait ends: a session that ends meanwhile gets nothing from this dispatch, and no request is sent for it.
   */
  const spawnTarget = async (engine: RouterEngine, e: SpawnEvent, signal: AbortSignal, own: AbortSignal): Promise<string | null> => {
    const live = linked(signal, own);
    try {
      return await spawnDecision(engine, e, live.signal);
    } catch (err) {
      if (err !== ENDED) throw err;
      if (own.aborted && !signal.aborted) log(engine, { event: 'spawn_stop', tool_use_id: e.tool_use_id, reason: 'session_ended' });
      return null;
    } finally {
      live.dispose();
    }
  };

  const agentSpawn = async <E extends SpawnEvent, R extends SpawnOutcome>(engine: RouterEngine, e: E, next: NextLike<E, R>): Promise<R> => {
    const own = session.signal;
    let target: string | null = null;
    try {
      target = await spawnTarget(engine, e, next.signal, own);
    } catch {
      target = null;
    }
    // As on turn.step: the host has already spawned natively, so nothing here may spawn again.
    if (next.signal.aborted) throw new Error('jev-router: spawn dispatch abandoned before next');
    // Nothing is awaited between this check and next: a session that ended meanwhile gets nothing from this dispatch.
    if (target !== null && own.aborted) {
      log(engine, { event: 'spawn_stop', tool_use_id: e.tool_use_id, reason: 'session_ended', requested: target });
      target = null;
    }
    const result = await next(target !== null ? { ...e, model: target } : e);
    try {
      if (target !== null) {
        if (result.deny !== undefined) log(engine, { event: 'spawn_result', tool_use_id: e.tool_use_id, requested: target, denied: true });
        else {
          log(engine, {
            event: 'spawn_result',
            tool_use_id: e.tool_use_id,
            requested: target,
            observed: result.model,
            agent_id: result.agentId ?? null,
            ...(sameModel(target, result.model) ? {} : { reason: 'model_mismatch' }),
          });
        }
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
      keyWait = null;
      diagnosed = false;
    },
    inFlight: client.inFlight,
  };
};

export type Router = ReturnType<typeof createRouter>;
