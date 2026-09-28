import type { ClientReason, Transport, Usage } from './client.ts';
import { createClient } from './client.ts';
import type { RouterConfig } from './config.ts';
import { validKey } from './config.ts';
import type { RootSwitch, SymbolicEffort } from './models.ts';
import { answeredBy, effortIndex, factsOf, isSymbolicEffort, sameModel, VERIFIED_ROOT_SWITCHES } from './models.ts';
import type { Answers, Baseline, DimensionReason, ModelTier, MutableDimensions, PolicyOptions, RoutedEffort, RoutingPatch, RoutingTask } from './policy.ts';
import { allowedBy, buildQuestions, buildState, choosePatch, EFFORT_LEVEL_TARGETS, offerableEfforts, offerableTiers, pairValid, validateAnswers } from './policy.ts';

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
  /** Milliseconds since the epoch. */
  now: () => number;
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
  /** The response's visible text, "" when it only called tools or thought. */
  answer?: string;
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
 * The first host release whose built-in agent definitions were read for this contract: general-purpose and claude
 * carry no model, Plan is `inherit`, Explore is `inherit` capped at opus outside haiku..opus.
 */
export const VERIFIED_HOST = '2.1.282';

/**
 * Later 2.1 releases are accepted too. Pinned to one release, spawn routing went native after every host update: the
 * owner's 2.1.283 was `host_unverified` the day it shipped, though its agent.spawn, agent.offer and turn.step
 * declarations are unchanged from 2.1.282 and its Explore was observed inheriting the parent's Opus. A later release
 * that resolves a spawn differently is caught where it shows, in the spawn's own result, and ends spawn routing for
 * the activation (`suspended`). A development build is still refused: its base names no release.
 */
export const hostSupported = (base: string | undefined): boolean => {
  const m = /^2\.1\.(\d+)$/.exec(base ?? '');
  return m !== null && Number(m[1]) >= 282;
};
const INHERITING_BUILT_INS = new Set(['general-purpose', 'claude', 'Plan', 'Explore']);
const EXPLORE_FAMILIES = new Set(['haiku', 'sonnet', 'opus']);
/** A Lean executor prompt: its packet is not visible here, so its model is Lean's and native's to decide (#44). */
const LEAN_MARKER = /jev-lean-[0-9a-f]{16}/;
const MAX_TURNS = 16;
const MAX_OFFERS = 64;
/** Subagents whose spawn answer is kept for their steps. */
const MAX_CHILDREN = 64;
/**
 * How long a subagent's first step waits for its spawn's id: `agent.spawn` resolves once the subagent started, which
 * can come after that loop dispatched its first step. Past this the step, and so the loop, stays native.
 */
const CHILD_WAIT_MS = 1500;
/** The tail of the last root reply a root turn is assessed with; replies end on what they ask or announce next. */
const REPLY_CHARS = 2000;
/**
 * How long a root request's cached prefix is taken as still warm: under the host's one-hour cache lifetime (every cache
 * write in the owner's transcripts, 2026-09-26..28, was `ephemeral_1h`), with a margin.
 */
const WARM_MS = 55 * 60_000;

/** The four counts a response reports, and nothing else of it. Per step; overlapping totals are #45's to normalize. */
const COUNTS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
const countsOf = (usage: unknown): Record<string, number> | null => {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  return Object.fromEntries(COUNTS.flatMap((k) => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? [[k, u[k]]] : [])));
};

/**
 * Usage under key names the host's debug log keeps: it redacts the value of any key containing "token", so on 2.1.283
 * every `input_tokens` reached the log as a bare [REDACTED] and neither Jev's nor a step's usage could be read back.
 * `input_tokens` → `input`, `cache_read_input_tokens` → `cache_read`.
 */
const loggable = (counts: object | null): Record<string, unknown> | null =>
  counts === null ? null : Object.fromEntries(Object.entries(counts).map(([k, v]) => [k.replace(/(_input)?_tokens$/, ''), v]));

/**
 * What Jev answered, beside what was done with it, so the floors can be checked against outcomes later: the control
 * label and its task_clear probability, the ordinary-risk probability, and each score's levels. Numbers and closed
 * labels only.
 */
const receiptOf = (a: Answers): Record<string, unknown> => ({
  ...(a.control ? { control: a.control.choice, task_clear: a.control.probabilities['task_clear'] ?? null } : {}),
  ...(a.action_risk ? { ordinary: a.action_risk.probabilities['ordinary'] ?? null } : {}),
  ...(a.tier ? { tier: a.tier.levels } : {}),
  ...(a.effort ? { effort: a.effort.levels } : {}),
});

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
  /** The effort the conversation's cached prefix was last sent at, while that cache is still warm; null when cold. */
  warmEffort: SymbolicEffort | null;
}

/**
 * A subagent's spawn answer. Its first step reads it against the effort the loop actually runs at and decides for the
 * whole loop: a Sonnet subagent keeps one effort, since an effort change drops Sonnet's message cache.
 */
interface ChildRouting {
  answers: Answers;
  /** The first step's model and effort, once seen. A later step arriving with others leaves the loop native. */
  baseline: Baseline | null;
  effort: RoutedEffort | null;
  stopped: boolean;
}

/** What a spawn's assessment decided: its model, and the answer its subagent's steps read their effort from. */
interface SpawnPlan {
  target: string | null;
  answers: Answers | null;
}

type Assessed =
  | { kind: 'skipped'; reason: string }
  | {
      kind: 'assessed';
      assessment: 'ok' | ClientReason;
      usage: Usage | null;
      sent: boolean;
      answers: Record<string, unknown> | null;
      validated: Answers | null;
      patch: RoutingPatch;
      model: DimensionReason;
      effort: DimensionReason;
    };

/** `rootSwitches` is the verified list; tests pass their own to reach the root-model path. */
export const createRouter = (config: RouterConfig, rootSwitches: readonly RootSwitch[] = VERIFIED_ROOT_SWITCHES) => {
  const rootEnabled = config.enabled && (config.routeMainEffort || config.routeMainModel);
  const spawnEnabled = config.enabled && (config.routeSubagentModel || config.routeSubagentEffort);
  const childEnabled = config.enabled && config.routeSubagentEffort;
  const stepEnabled = rootEnabled || childEnabled;
  const children = bounded<string, ChildRouting>(MAX_CHILDREN);
  /** Spawns between next and its result; a subagent step with no answer yet waits on these. */
  const landing = new Set<Promise<void>>();
  /** The last root step's visible reply: the context a root turn that answers it is assessed with. */
  let lastReply: string | null = null;
  /** The last root request that got a response: when, on which model, and at which effort. */
  let lastRoot: { at: number; model: string; effort: SymbolicEffort | null } | null = null;
  const turnTexts = bounded<string, string>(MAX_TURNS);
  const turns = bounded<string, TurnRouting>(MAX_TURNS, (t) => t.controller.abort());
  const offers = bounded<string, boolean>(MAX_OFFERS);
  let session = new AbortController();
  let keyWait: ((signal: AbortSignal) => Promise<KeyState | typeof ABORTED>) | null = null;
  let diagnosed = false;
  /**
   * Why spawn routing stopped for this activation, once a spawn's own result contradicted the contract: a routed
   * spawn that ran on another model than requested, or an unrouted one that did not run on the baseline this Router
   * assumed. Either means the host resolves spawns differently from what every other decision here relies on. It
   * outlives a session end, because a host's resolution does not change within one process.
   */
  let suspended: string | null = null;
  /** The baseline each eligible dispatch was judged against, so its result can be checked whether or not it moved. */
  const assumed = new WeakMap<object, string>();

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
      spawn_model_explicit: config.routeExplicitSpawnModel,
      spawn_effort: config.routeSubagentEffort,
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
    const onLate = (usage: Usage | null): void => log(engine, { event: 'late', ...late, usage: loggable(usage) });
    const res = await client.assess(engine, key, buildState(task), questions, signal, onLate);
    if (!res.ok)
      return { kind: 'assessed', assessment: res.reason, usage: res.usage, sent: res.sent, answers: null, validated: null, patch: {}, model: 'not_asked', effort: 'not_asked' };
    const answers = validateAnswers(res.answers, questions);
    const decision = choosePatch(answers, baseline, dims, opts);
    return { kind: 'assessed', assessment: 'ok', usage: res.usage, sent: true, answers: receiptOf(answers), validated: answers, ...decision };
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
    const efforts = config.routeMainEffort && !pins.mainEffort ? offerableEfforts(baseline) : null;
    const offer = config.routeMainModel && !pins.mainModel ? offerableTiers(baseline, opts, efforts) : null;
    return { dims: { tiers: offer && 'tiers' in offer ? offer.tiers : null, efforts }, opts, ...(offer && 'reason' in offer ? { withheld: offer.reason } : {}) };
  };

  const rootAssessment = async (engine: RouterEngine, turnId: string, t: TurnRouting, text: string, context: string | null): Promise<void> => {
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
          const task: RoutingTask = { scope: 'root', text, ...(context ? { previousReply: context } : {}) };
          outcome = await assess(engine, key.key, task, t.baseline, r.dims, r.opts, live, { scope: 'root', turn: turnId });
        }
      }
    } catch (err) {
      outcome = { kind: 'skipped', reason: err === ENDED ? 'turn_retired' : 'internal_error' };
    }
    // A turn retired while this was in flight keeps its native parameters; a late answer reaches no other turn.
    let held: RoutedEffort | undefined;
    if (!t.stopped && outcome.kind === 'assessed') {
      const kept = holdForCache(t, outcome.patch);
      t.patch = kept.patch;
      held = kept.held;
    }
    if (Object.keys(t.patch).length === 0) t.stopped = true;
    log(engine, {
      event: 'root',
      turn: turnId,
      context_chars: context?.length ?? 0,
      from: { model: t.baseline.model, effort: t.baseline.effort ?? null },
      ...(withheld !== undefined ? { model_withheld: withheld } : {}),
      ...(outcome.kind === 'skipped'
        ? { skipped: outcome.reason }
        : {
            assessment: outcome.assessment,
            sent: outcome.sent,
            usage: loggable(outcome.usage),
            answers: outcome.answers,
            patch: t.patch,
            ...(held !== undefined ? { held_for_cache: held } : {}),
            reasons: { model: outcome.model, effort: outcome.effort },
          }),
    });
  };

  /**
   * Changing the top-level effort restarts the conversation's prompt cache, so on a warm cache a lower effort is held
   * at the one the cache was written at rather than paying a rewrite, and only a rise, which quality asks for, pays it.
   * Lowering waits for a cold cache: a session's first turn, a model change, or an hour's pause. The host sends each
   * turn's effort both as a per-message change and as the top-level value (2.1.283, observed on a local fake API), and
   * the per-message form alone would keep the cache. Replayed on 245 root turns of the owner's week (2026-09-21..28;
   * first requests re-read a median 185K tokens), lowering freely moved effort at 71 warm turns, and with rewrites
   * priced cost 2.7 % more than it saved; held, 12 warm turns moved and it saved on either cache reading. The savings
   * in that replay are assumed shares of each turn's cost, not measured ones.
   */
  const holdForCache = (t: TurnRouting, patch: RoutingPatch): { patch: RoutingPatch; held?: RoutedEffort } => {
    const want = patch.effort;
    const warm = t.warmEffort;
    // A model change starts the cache over whatever the effort does.
    if (want === undefined || warm === null || patch.model !== undefined || effortIndex(want) >= effortIndex(warm)) return { patch };
    const { effort: _dropped, ...rest } = patch;
    // Held at the baseline, nothing is sent; held below it, the cache's own effort is.
    if (warm === t.baseline.effort || warm === 'max') return { patch: rest, held: want };
    return { patch: { ...rest, effort: warm }, held: want };
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

  /**
   * A patch, with the turn or subagent it was stored on: next is given it only while that turn is still the live one,
   * or that subagent's routing still stands.
   */
  type Prepared = { patch: RoutingPatch; turn: TurnRouting; child?: undefined } | { patch: RoutingPatch; turn?: undefined; child: ChildRouting };
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
    if (e.agentId !== undefined) return childEnabled ? await childStep(engine, e, e.agentId, signal) : null;
    if (!rootEnabled) return null;
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
      warmEffort: lastRoot && lastRoot.model === e.model && engine.now() - lastRoot.at < WARM_MS ? lastRoot.effort : null,
    };
    // sessionEnd retires every turn, which aborts its controller: no session listener is needed here.
    turns.put(e.turnId, t);
    const text = turnTexts.get(e.turnId);
    if (text === undefined || text.trim() === '') {
      t.stopped = true;
      log(engine, { event: 'root', turn: e.turnId, skipped: 'no_task_text' });
      return null;
    }
    t.pending = rootAssessment(engine, e.turnId, t, text, lastReply);
    if ((await until(t.pending, signal)) === ABORTED) return null;
    return await stored(engine, t, e, signal);
  };

  /**
   * A subagent's step: the effort its spawn's answer asks for, read against the effort and model this loop runs at.
   * The first step decides for the loop and every later step repeats it; one that arrives with another model or
   * effort, or after an effort pin, leaves the loop native from then on.
   */
  const childStep = async (engine: RouterEngine, e: TurnStepEvent, id: string, signal: AbortSignal): Promise<Prepared | null> => {
    let c = children.get(id);
    if (!c && e.index === 0 && landing.size > 0) {
      // The spawn that started this loop may still be returning its id.
      const wait = linked(signal, session.signal);
      try {
        const landed = Promise.allSettled([...landing]).then(() => undefined);
        await until(Promise.race([landed, engine.sleep(CHILD_WAIT_MS, wait.signal).catch(() => undefined)]), wait.signal);
      } finally {
        wait.dispose();
      }
      c = children.get(id);
    }
    if (!c || c.stopped) return null;
    if (c.baseline === null) {
      c.baseline = { model: e.model, ...(e.effort !== undefined ? { effort: e.effort } : {}) };
      const efforts = offerableEfforts(c.baseline);
      const decision = efforts ? choosePatch(c.answers, c.baseline, { tiers: null, efforts }, policy('spawn', undefined)) : null;
      c.effort = decision?.patch.effort ?? null;
      log(engine, { event: 'child', agent_id: id, from: { model: e.model, effort: e.effort ?? null }, patch: c.effort, reason: decision ? decision.effort : 'effort_unknown' });
      if (c.effort === null) {
        c.stopped = true;
        return null;
      }
    } else if (e.model !== c.baseline.model || e.effort !== c.baseline.effort) {
      c.stopped = true;
      log(engine, { event: 'child_stop', agent_id: id, index: e.index, reason: 'incoming_divergence' });
      return null;
    }
    const effort = c.effort;
    if (effort === null) return null;
    // Read last, so an effort pin set while the step waited still wins.
    const pins = await until(pinsOf(engine), signal);
    if (pins === ABORTED || c.stopped) return null;
    if (pins.mainEffort) {
      c.stopped = true;
      log(engine, { event: 'child_stop', agent_id: id, index: e.index, reason: 'effort_pinned' });
      return null;
    }
    return { patch: { effort }, child: c };
  };

  /**
   * The host dispatched this step natively without waiting for the hook. The turn stays native from here, so a later
   * step never switches away from what the abandoned one ran on; so does a subagent's loop.
   */
  const abandon = (engine: RouterEngine, e: TurnStepEvent): void => {
    if (e.agentId !== undefined) {
      const c = children.get(e.agentId);
      if (c && !c.stopped) {
        c.stopped = true;
        log(engine, { event: 'child_stop', agent_id: e.agentId, index: e.index, reason: 'step_abandoned' });
      }
      return;
    }
    if (!rootEnabled) return;
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
      log(engine, { event: 'root_result', turn: e.turnId, index: e.index, applied: patch, observed: seen, usage: result ? loggable(countsOf(result.usage)) : null });
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

  /** A patched subagent step answered by another model, or none, ends that loop's routing, as a root turn's does. */
  const observeChild = (engine: RouterEngine, e: TurnStepEvent, c: ChildRouting, patch: RoutingPatch | null, result: TurnStepOutcome | void): void => {
    try {
      if (!patch || patch.effort === undefined) return;
      const seen = result && typeof result.usage?.model === 'string' ? result.usage.model : null;
      if (seen !== null && answeredBy(e.model, seen) && factsOf(seen)?.unconditionalEffort.includes(patch.effort)) return;
      c.stopped = true;
      log(engine, { event: 'child_stop', agent_id: e.agentId ?? null, index: e.index, reason: seen === null ? 'model_unobserved' : 'model_mismatch', observed: seen });
    } catch {
      // Observation only.
    }
  };

  /** Keeps the tail of a root step's visible reply for the next turn's assessment. */
  const remember = (result: TurnStepOutcome | void): void => {
    const answer = result?.answer;
    if (typeof answer === 'string' && answer.trim() !== '') lastReply = answer.length > REPLY_CHARS ? answer.slice(-REPLY_CHARS) : answer;
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
    if (prepared?.turn && (own.aborted || prepared.turn.stopped || turns.get(e.turnId) !== prepared.turn)) {
      patch = null;
      log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: own.aborted ? 'session_ended' : 'turn_stopped' });
    }
    if (prepared?.child && (own.aborted || prepared.child.stopped)) {
      patch = null;
      log(engine, { event: 'child_stop', agent_id: e.agentId ?? null, index: e.index, reason: own.aborted ? 'session_ended' : 'child_stopped' });
    }
    // Once next starts, every chunk, the return, a refusal or an error belongs to the host: nothing here retries it.
    const result = yield* next(patch ? { ...e, ...patch } : e);
    if (prepared?.child) observeChild(engine, e, prepared.child, patch, result);
    else observeStep(engine, e, patch, result);
    if (e.agentId === undefined && !own.aborted) {
      remember(result);
      const sent = patch?.effort ?? e.effort;
      if (result?.usage) lastRoot = { at: engine.now(), model: patch?.model ?? e.model, effort: isSymbolicEffort(sent) ? sent : null };
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------------- spawn

  /** A type the Router does not route is caller text: it is never logged, only named as other. */
  const typeLabel = (e: SpawnEvent): string => (INHERITING_BUILT_INS.has(e.subagentType) ? e.subagentType : 'other');

  const suspend = (engine: RouterEngine, reason: string): void => {
    if (suspended !== null) return;
    suspended = reason;
    log(engine, { event: 'spawn_suspended', reason });
  };

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
    dims: MutableDimensions,
    modelSkip: string | null,
    signal: AbortSignal,
  ): Promise<SpawnPlan> => {
    const task: RoutingTask = { scope: 'spawn', text: e.prompt, description: e.description, subagentType: e.subagentType };
    const outcome = await assess(engine, key, task, baseline, dims, opts, signal, { scope: 'spawn', tool_use_id: e.tool_use_id });
    if (outcome.kind === 'skipped') {
      spawnSkip(engine, e, outcome.reason);
      return { target: null, answers: null };
    }
    log(engine, {
      event: 'spawn',
      tool_use_id: e.tool_use_id,
      type: typeLabel(e),
      from: baseline.model,
      explicit: e.model !== undefined && e.model.trim() !== '',
      assessment: outcome.assessment,
      sent: outcome.sent,
      usage: loggable(outcome.usage),
      answers: outcome.answers,
      patch: outcome.patch,
      reasons: { model: modelSkip ?? outcome.model, effort: dims.efforts ? 'per_step' : 'not_asked' },
    });
    return { target: outcome.patch.model ?? null, answers: outcome.validated };
  };

  /** Why an inheriting spawn's model is left as resolved, read from the event and offers alone; null: it can move. */
  const inheritSkip = (e: SpawnEvent): string | null => {
    if (!INHERITING_BUILT_INS.has(e.subagentType)) return 'type_unverified';
    // A user's or a plugin's agent can carry a built-in's name; only the listing's own source says which one runs.
    if (offers.get(e.subagentType) !== true || e.provider.plugin !== 'engine' || e.provider.tier !== 'core') return 'definition_unverified';
    const family = factsOf(e.parentModel)?.family;
    if (e.subagentType === 'Explore' && (family === undefined || !EXPLORE_FAMILIES.has(family))) return 'baseline_unknown';
    return null;
  };

  /**
   * A spawn is asked about its model, its subagent's effort, or both. The model moves for an inheriting built-in and,
   * unless configured otherwise, for any call that names one: `model: "opus"` on an Agent call is the caller's default,
   * and in a week of the owner's traffic 161 of 174 routable spawns named it. Effort is asked for every spawn but a
   * fork, whose loop shares the parent's context.
   */
  const spawnDecision = async (engine: RouterEngine, e: SpawnEvent, live: AbortSignal): Promise<SpawnPlan | null> => {
    if (!spawnEnabled) return null;
    // Native ignores a fork's model and inherits the parent's context and model.
    if (e.fork) return spawnSkip(engine, e, 'fork');
    if (LEAN_MARKER.test(e.prompt) || LEAN_MARKER.test(e.description)) return spawnSkip(engine, e, 'lean_marker');
    void diagnose(engine);
    const explicit = e.model !== undefined && e.model.trim() !== '' ? e.model : null;
    // What the event, configuration and offer cache decide comes before any wait. Null: the model can move.
    let modelSkip: string | null = !config.routeSubagentModel
      ? 'model_not_routed'
      : explicit !== null
        ? config.routeExplicitSpawnModel
          ? null
          : 'explicit_model'
        : inheritSkip(e);
    if (modelSkip === null && suspended !== null) modelSkip = 'spawn_suspended';
    const baseline: Baseline = { model: explicit ?? e.parentModel };
    if (modelSkip === null) {
      // The allowlist can only narrow this.
      const ceiling = offerableTiers(baseline, policy('spawn', undefined));
      if ('reason' in ceiling) modelSkip = ceiling.reason;
    }
    if (modelSkip !== null && !childEnabled) return spawnSkip(engine, e, modelSkip);
    // The key comes next: without one nothing optional is read.
    const key = await keyFor(engine, live);
    if (key === ABORTED) throw ENDED;
    if (!('key' in key)) return spawnSkip(engine, e, key.reason);
    const pins = await within(pinsOf(engine), live);
    if (modelSkip === null && pins.subagentModel) modelSkip = 'subagent_model_pinned';
    if (modelSkip === null && pins.aliasRemap) modelSkip = 'alias_remapped';
    if (modelSkip === null && !hostSupported(await within(engine.hostBase().catch(() => undefined), live))) modelSkip = 'host_unverified';
    const opts = policy('spawn', modelSkip === null ? await within(engine.availableModels().catch(() => []), live) : undefined);
    let tiers: ModelTier[] | null = null;
    if (modelSkip === null) {
      const offer = offerableTiers(baseline, opts);
      if ('reason' in offer) modelSkip = offer.reason;
      else tiers = offer.tiers;
    }
    const efforts = childEnabled && !pins.mainEffort ? EFFORT_LEVEL_TARGETS : null;
    if (tiers === null && efforts === null) return spawnSkip(engine, e, modelSkip ?? 'effort_pinned');
    // Recorded only once every gate passed: a spawn left native by a pin runs on the pinned model, which says nothing
    // about how the host resolves an inheriting one.
    if (tiers !== null) assumed.set(e, baseline.model);

    // Each dispatch is assessed on its own text rather than sharing one answer per tool_use_id: a redispatch under
    // that id can carry another prompt, which would then run on a tier earned by different text.
    let plan: SpawnPlan;
    try {
      plan = await spawnAssessment(engine, key.key, e, baseline, opts, { tiers, efforts }, modelSkip, live);
    } catch {
      plan = { target: null, answers: null };
    }
    const answers = efforts !== null ? plan.answers : null;
    const target = tiers !== null ? plan.target : null;
    if (target === null) {
      if (tiers !== null) {
        // A pin that arrived while Jev answered puts this native spawn on the pinned model, which says nothing about how
        // the host resolves an inheriting one.
        const now = await within(pinsOf(engine), live);
        if (now.subagentModel || now.aliasRemap) assumed.delete(e);
      }
      return { target: null, answers };
    }
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
      // Left native by a pin, the spawn runs on the pinned model; left native by the allowlist, it still inherits.
      if (stop !== 'target_not_allowed') assumed.delete(e);
      log(engine, { event: 'spawn_stop', tool_use_id: e.tool_use_id, reason: stop, requested: target });
      return { target: null, answers };
    }
    return { target, answers };
  };

  /**
   * Every wait of a dispatch ends with it or with `own`, the session it began in, rather than the one current when a
   * wait ends: a session that ends meanwhile gets nothing from this dispatch, and no request is sent for it.
   */
  const spawnTarget = async (engine: RouterEngine, e: SpawnEvent, signal: AbortSignal, own: AbortSignal): Promise<SpawnPlan | null> => {
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
    let plan: SpawnPlan | null = null;
    try {
      plan = await spawnTarget(engine, e, next.signal, own);
    } catch {
      plan = null;
    }
    // As on turn.step: the host has already spawned natively, so nothing here may spawn again.
    if (next.signal.aborted) throw new Error('jev-router: spawn dispatch abandoned before next');
    let target = plan?.target ?? null;
    // Nothing is awaited between these checks and next: a session that ended meanwhile gets nothing from this dispatch,
    // and neither does one whose routing another spawn's result suspended while this one waited.
    if (target !== null && own.aborted) {
      log(engine, { event: 'spawn_stop', tool_use_id: e.tool_use_id, reason: 'session_ended', requested: target });
      target = null;
    }
    if (target !== null && suspended !== null) {
      log(engine, { event: 'spawn_stop', tool_use_id: e.tool_use_id, reason: 'spawn_suspended', requested: target });
      target = null;
    }
    const answers = own.aborted ? null : (plan?.answers ?? null);
    // The subagent's first step can be dispatched before next returns its id; it waits on this, never past next.
    let land = (): void => {};
    const landed = new Promise<void>((resolve) => {
      land = resolve;
    });
    if (answers) landing.add(landed);
    let result: R;
    try {
      result = await next(target !== null ? { ...e, model: target } : e);
      if (answers && result.deny === undefined && result.agentId !== undefined && !own.aborted)
        children.put(result.agentId, { answers, baseline: null, effort: null, stopped: false });
    } finally {
      landing.delete(landed);
      land();
    }
    try {
      const baseline = assumed.get(e);
      if (target !== null) {
        if (result.deny !== undefined) log(engine, { event: 'spawn_result', tool_use_id: e.tool_use_id, requested: target, denied: true });
        else {
          const matched = sameModel(target, result.model);
          log(engine, {
            event: 'spawn_result',
            tool_use_id: e.tool_use_id,
            requested: target,
            observed: result.model,
            agent_id: result.agentId ?? null,
            ...(matched ? {} : { reason: 'model_mismatch' }),
          });
          if (!matched) suspend(engine, 'model_mismatch');
        }
      } else if (baseline !== undefined && result.deny === undefined && !answeredBy(baseline, result.model)) {
        log(engine, { event: 'spawn_native_result', tool_use_id: e.tool_use_id, assumed: baseline, observed: result.model, reason: 'baseline_mismatch' });
        suspend(engine, 'baseline_mismatch');
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
    stepEnabled,
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
      children.clear();
      lastReply = null;
      lastRoot = null;
      keyWait = null;
      diagnosed = false;
    },
    inFlight: client.inFlight,
  };
};

export type Router = ReturnType<typeof createRouter>;
