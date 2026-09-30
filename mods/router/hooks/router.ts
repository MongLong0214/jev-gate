import type { ClientReason, Transport, Usage } from './client.ts';
import { createClient } from './client.ts';
import type { RouterConfig } from './config.ts';
import { validKey } from './config.ts';
import type { RootSwitch, SymbolicEffort } from './models.ts';
import { aliasFamily, answeredBy, effortIndex, factsOf, isSymbolicEffort, MODEL_FACTS, sameModel, VERIFIED_ROOT_SWITCHES } from './models.ts';
import type { Answers, Baseline, DimensionReason, ModelTier, MutableDimensions, PolicyOptions, RoutedEffort, RoutingPatch, RoutingTask } from './policy.ts';
import { allowedBy, buildQuestions, buildState, choosePatch, EFFORT_LEVEL_TARGETS, offerableEfforts, offerableTiers, pairValid, validateAnswers } from './policy.ts';
import { looksSecret } from './secret.ts';

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
  pins: (scope?: 'effort' | 'root' | 'spawn') => Promise<HostPins>;
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
/**
 * A jev-gate dispatch: Gate B already chose its model and effort (the tier's agent profile), so routing it again here
 * overrode the gate's answer with a second one. Its planner and workers are the plugin's own agents, and a worker the
 * gate patched carries its route note.
 */
const GATE_ROUTE_NOTE = /\[Jev Gate route note\] Tier: (?:fast|standard|deep|frontier)\./;
const GATE_AGENT_PREFIX = 'jev-gate:';
const MAX_TURNS = 16;
const MAX_OFFERS = 64;
/** Subagents whose spawn answer is kept for their steps. */
const MAX_CHILDREN = 64;
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
  if (signal.aborted) {
    void p.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
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
  deadline: number;
  patch: RoutingPatch;
  /** The whole turn is native from here on: skipped, diverged or retired. */
  stopped: boolean;
  modelStopped: boolean;
  effortStopped: boolean;
  /** The effort the conversation's cached prefix was last sent at, while that cache is still warm; null when cold. */
  warmEffort: SymbolicEffort | null;
  /**
   * The turn arrived at another effort than the root turn before it. The host does not say who changed it, and a
   * change the person made by hand shows only there, so this turn keeps its effort as if pinned (#81).
   */
  effortChanged: boolean;
}

/**
 * A subagent's spawn answer. Its first step reads it against the effort the loop actually runs at and decides for the
 * whole loop: a Sonnet subagent keeps one effort, since an effort change drops Sonnet's message cache.
 */
interface ChildRouting {
  answers: Answers;
  /** The first step's model and effort, once seen. A later step arriving with others leaves the loop native. */
  baseline: Baseline | null;
  /**
   * The run the first step belonged to. The answer is for the spawn's task alone: a later run of the same subagent
   * (a SendMessage continuation, which steps under a new turn id) is another task, and runs native.
   */
  turnId: string | null;
  effort: RoutedEffort | null;
  stopped: boolean;
  /** Set as a patched step goes to next: from then on the loop's cache was written at its effort. */
  dispatched: boolean;
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

/** Apply the cache floor without raising effort above the native baseline. Missing proposals stay missing. */
export const cachePatch = (
  baseline: Baseline,
  warm: SymbolicEffort | null,
  patch: RoutingPatch,
): { patch: RoutingPatch; held?: RoutedEffort } => {
  const want = patch.effort;
  let final = want;
  if (want !== undefined && warm !== null && patch.model === undefined && isSymbolicEffort(baseline.effort)) {
    const floor = effortIndex(warm) < effortIndex(baseline.effort) ? warm : baseline.effort;
    if (effortIndex(want) < effortIndex(floor)) final = floor === 'max' ? undefined : floor;
  }
  const { effort: _effort, ...rest } = patch;
  const result = final === undefined || final === baseline.effort ? rest : { ...rest, effort: final };
  return { patch: result, ...(want !== undefined && final !== want ? { held: want } : {}) };
};

/** `rootSwitches` is the verified list; tests pass their own to reach the root-model path. */
export const createRouter = (config: RouterConfig, rootSwitches: readonly RootSwitch[] = VERIFIED_ROOT_SWITCHES) => {
  const rootEnabled = config.enabled && (config.routeMainEffort || config.routeMainModel);
  const spawnEnabled = config.enabled && (config.routeSubagentModel || config.routeSubagentEffort);
  const childEnabled = config.enabled && config.routeSubagentEffort;
  const stepEnabled = rootEnabled || childEnabled;
  const children = bounded<string, ChildRouting>(MAX_CHILDREN);
  // Missing mappings never wait on another spawn. Once history fills, new unknown loops stay native.
  const nativeChildren = new Set<string>();
  let childHistoryFull = false;
  const rememberNativeChild = (id: string): void => {
    if (nativeChildren.size < MAX_CHILDREN) nativeChildren.add(id);
    else childHistoryFull = true;
  };
  /** The last root step's visible reply: the context a root turn that answers it is assessed with. */
  let lastReply: string | null = null;
  /** The last root request that got a response: when, on which model, and at which effort. */
  let lastRoot: { at: number; model: string; effort: SymbolicEffort | null } | null = null;
  /** The effort the last root turn arrived with, before any patch; null before the session's first turn. */
  let lastIncoming: { effort: TurnStepEvent['effort'] } | null = null;
  const turnTexts = bounded<string, string>(MAX_TURNS);
  const turns = bounded<string, TurnRouting>(MAX_TURNS, (t) => t.controller.abort());
  const offers = bounded<string, boolean>(MAX_OFFERS);
  let session = new AbortController();
  let keyWait: ((signal: AbortSignal) => Promise<KeyState | typeof ABORTED>) | null = null;
  let diagnosed = false;
  let versionWait: ReturnType<typeof sharedRead<string | undefined>> | null = null;
  const pinReads = new Map<string, ReturnType<typeof sharedRead<HostPins>>>();
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
    if (signal.aborted) return Promise.resolve(ABORTED);
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

  /** Deduplicate pending reads; settled pins are reread so mid-session changes still win. */
  const pinsOf = async (engine: RouterEngine, scope: 'effort' | 'root' | 'spawn', live: AbortSignal): Promise<HostPins> => {
    if (live.aborted) throw ENDED;
    let wait = pinReads.get(scope);
    if (!wait) {
      const read = engine.pins(scope).catch(() => ({ mainModel: true, mainEffort: true, subagentModel: true, aliasRemap: true }));
      wait = sharedRead(read);
      pinReads.set(scope, wait);
      const current = wait;
      void read.then(() => {
        if (pinReads.get(scope) === current) pinReads.delete(scope);
      });
    }
    const pins = await wait(live);
    if (pins === ABORTED) throw ENDED;
    return pins;
  };
  const versionFor = async (engine: RouterEngine, live: AbortSignal): Promise<string | undefined> => {
    if (live.aborted) throw ENDED;
    versionWait ??= sharedRead(engine.hostBase().catch(() => undefined));
    const v = await versionWait(live);
    if (v === ABORTED) throw ENDED;
    return v;
  };
  const diagnose = async (engine: RouterEngine, live: AbortSignal): Promise<void> => {
    if (diagnosed) return;
    diagnosed = true;
    const key = await keyFor(engine, live);
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
  /** Uses only the host clock. Disposing ends the timer, never the native dispatch. */
  const budget = (engine: RouterEngine, deadline: number, ...signals: AbortSignal[]) => {
    const timer = new AbortController();
    const expired = new AbortController();
    const live = linked(...signals, expired.signal);
    const remaining = deadline - engine.now();
    if (remaining <= 0) expired.abort();
    else
      void engine.sleep(remaining, timer.signal).then(
        () => expired.abort(),
        () => undefined,
      );
    return {
      signal: live.signal,
      expired: expired.signal,
      dispose: () => {
        timer.abort();
        live.dispose();
      },
    };
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
    const res = await client.assess(engine, key, buildState(task), questions, signal, onLate, () => log(engine, { event: 'request', ...late, sent: true }));
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

  const rootAssessment = async (
    engine: RouterEngine,
    turnId: string,
    t: TurnRouting,
    text: string,
    context: string | null,
    live: AbortSignal,
  ): Promise<void> => {
    let outcome: Assessed;
    let withheld: string | undefined;
    // Every wait here ends when the turn is retired.

    try {
      // Pins and the allowlist can only narrow what the event and configuration allow, so a turn with nothing to ask
      // even without them never waits for the key or a read.
      const ceiling = rootDims(t.baseline, t.effortChanged ? { mainModel: false, mainEffort: true } : NO_ROOT_PINS, undefined);
      const noCacheMove =
        ceiling.dims.tiers === null &&
        ceiling.dims.efforts !== null &&
        ceiling.dims.efforts.every((effort) => Object.keys(cachePatch(t.baseline, t.warmEffort, { effort }).patch).length === 0);
      if (!buildQuestions(ceiling.dims) || noCacheMove) {
        withheld = ceiling.withheld;
        outcome = { kind: 'skipped', reason: noCacheMove ? 'cache_native' : 'nothing_to_change' };
      } else {
        // The key comes next: without one nothing optional is read.
        void diagnose(engine, live);
        const key = await keyFor(engine, live);
        if (key === ABORTED) throw ENDED;
        if (!('key' in key)) outcome = { kind: 'skipped', reason: key.reason };
        else {
          const pins = await within(pinsOf(engine, config.routeMainModel ? 'root' : 'effort', live), live);
          const available = config.routeMainModel && !pins.mainModel ? await within(engine.availableModels().catch(() => []), live) : undefined;
          const r = rootDims(t.baseline, { mainModel: pins.mainModel, mainEffort: pins.mainEffort || t.effortChanged }, available);
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
    if (!live.aborted && !t.stopped && outcome.kind === 'assessed') {
      const kept = cachePatch(t.baseline, t.warmEffort, outcome.patch);
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
      ...(t.effortChanged ? { effort_kept: 'incoming_changed' } : {}),
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
    const pins = await within(pinsOf(engine, storedModel !== undefined ? 'root' : 'effort', live), live);
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

  const prepareStep = async (engine: RouterEngine, e: TurnStepEvent, signal: AbortSignal, deadline: number): Promise<Prepared | null> => {
    if (signal.aborted) return null;
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
    const t: TurnRouting = {
      baseline: { model: e.model, ...(e.effort !== undefined ? { effort: e.effort } : {}) },
      controller: new AbortController(),
      pending: null,
      deadline,
      patch: {},
      stopped: false,
      modelStopped: false,
      effortStopped: false,
      warmEffort: lastRoot && lastRoot.model === e.model && engine.now() - lastRoot.at < WARM_MS ? lastRoot.effort : null,
      effortChanged: lastIncoming !== null && lastIncoming.effort !== e.effort,
    };
    lastIncoming = { effort: e.effort };
    // sessionEnd retires every turn, which aborts its controller: no session listener is needed here.
    turns.put(e.turnId, t);
    const text = turnTexts.get(e.turnId);
    if (text === undefined || text.trim() === '') {
      t.stopped = true;
      log(engine, { event: 'root', turn: e.turnId, skipped: 'no_task_text' });
      return null;
    }
    const assessmentLive = linked(signal, t.controller.signal);
    t.pending = rootAssessment(engine, e.turnId, t, text, lastReply, assessmentLive.signal).finally(() => {
      t.pending = null;
      assessmentLive.dispose();
    });
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
    if (!c || nativeChildren.has(id) || c.stopped) {
      rememberNativeChild(id);
      return null;
    }
    if (c.baseline === null && e.index > 0) {
      // The loop's first step ran before its spawn landed and went native; a lower effort now would restart its cache.
      c.stopped = true;
      log(engine, { event: 'child_stop', agent_id: id, index: e.index, reason: 'first_step_native' });
      return null;
    }
    if (c.baseline === null) {
      c.baseline = { model: e.model, ...(e.effort !== undefined ? { effort: e.effort } : {}) };
      c.turnId = e.turnId;
      const efforts = offerableEfforts(c.baseline);
      const decision = efforts ? choosePatch(c.answers, c.baseline, { tiers: null, efforts }, policy('spawn', undefined)) : null;
      c.effort = decision?.patch.effort ?? null;
      log(engine, { event: 'child', agent_id: id, from: { model: e.model, effort: e.effort ?? null }, patch: c.effort, reason: decision ? decision.effort : 'effort_unknown' });
      if (c.effort === null) {
        c.stopped = true;
        return null;
      }
    } else if (e.turnId !== c.turnId) {
      c.stopped = true;
      log(engine, { event: 'child_stop', agent_id: id, index: e.index, reason: 'next_turn' });
      return null;
    } else if (e.model !== c.baseline.model || e.effort !== c.baseline.effort) {
      c.stopped = true;
      log(engine, { event: 'child_stop', agent_id: id, index: e.index, reason: 'incoming_divergence' });
      return null;
    }
    const effort = c.effort;
    if (effort === null) return null;
    // Read last, so an effort pin set while the step waited still wins.
    const pins = await until(pinsOf(engine, 'effort', signal), signal);
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
      // `applied` is what was sent to next, not a confirmation: the host reports the model that answered, never the
      // effort it ran at.
      log(engine, {
        event: 'root_result',
        turn: e.turnId,
        index: e.index,
        applied: patch,
        observed: seen,
        ...(patch.effort !== undefined ? { observed_effort: 'unknown' } : {}),
        usage: result ? loggable(countsOf(result.usage)) : null,
      });
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

  /**
   * Keeps the tail of a root step's visible reply for the next turn's assessment. The whole reply is screened rather
   * than the kept tail: a tail cut from a longer credential can pass the screen on its own. A screened reply is not
   * carried at all.
   */
  const remember = (result: TurnStepOutcome | void): void => {
    const answer = result?.answer;
    if (typeof answer !== 'string' || answer.trim() === '') return;
    lastReply = looksSecret(answer) ? null : answer.length > REPLY_CHARS ? answer.slice(-REPLY_CHARS) : answer;
  };

  async function* turnStep<E extends TurnStepEvent, C, R extends TurnStepOutcome | void>(
    engine: RouterEngine,
    e: E,
    next: StreamNextLike<E, C, R>,
  ): AsyncGenerator<C, R | void> {
    const startedAt = engine.now();
    const own = session.signal;
    const known = e.agentId === undefined ? turns.get(e.turnId) : undefined;
    const deadline = known?.pending ? known.deadline : startedAt + config.timeoutMs;
    const wait = budget(engine, deadline, own, next.signal, ...(known ? [known.controller.signal] : []));
    let prepared: Prepared | null = null;
    try {
      prepared = await prepareStep(engine, e, wait.signal, deadline);
    } catch {
      prepared = null;
    }
    if (wait.expired.aborted || engine.now() >= deadline) {
      abandon(engine, e);
      prepared = null;
      log(engine, { event: 'budget_timeout', scope: e.agentId === undefined ? 'root' : 'child', turn: e.turnId });
    }
    wait.dispose();
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
    log(engine, {
      event: 'prepared',
      turn: e.turnId,
      scope: e.agentId === undefined ? 'root' : 'child',
      preparation_ms: Math.max(0, engine.now() - startedAt),
      budget_ms: config.timeoutMs,
      routed: patch !== null,
    });
    if (prepared?.child && patch) prepared.child.dispatched = true;
    // Once next starts, every chunk, the return, a refusal or an error belongs to the host: nothing here retries it.
    let result: R;
    try {
      result = yield* next(patch ? { ...e, ...patch } : e);
    } catch (err) {
      // A patched request that failed leaves the rest of its turn or loop native: whatever the host sends next, a retry
      // or a fallback, it is never sent the override again.
      if (patch && prepared?.child) {
        prepared.child.stopped = true;
        log(engine, { event: 'child_stop', agent_id: e.agentId ?? null, index: e.index, reason: 'step_failed' });
      } else if (patch && prepared?.turn) {
        prepared.turn.stopped = true;
        log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'step_failed' });
      }
      throw err;
    }
    if (prepared?.child) observeChild(engine, e, prepared.child, patch, result);
    else observeStep(engine, e, patch, result);
    if (e.agentId === undefined && !own.aborted) {
      remember(result);
      const sent = patch?.effort ?? e.effort;
      const asked = patch?.model ?? e.model;
      const seen = typeof result?.usage?.model === 'string' ? result.usage.model : null;
      // Only a response the asked model gave wrote the cache a later turn on that model reads.
      if (seen !== null && answeredBy(asked, seen)) lastRoot = { at: engine.now(), model: asked, effort: isSymbolicEffort(sent) ? sent : null };
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
    // A loop that has sent no patched step yet stays native too, even one whose first step is still being prepared;
    // one already running keeps its effort rather than restarting its cache.
    for (const [id, c] of children) {
      if (c.dispatched || c.stopped) continue;
      c.stopped = true;
      log(engine, { event: 'child_stop', agent_id: id, index: null, reason: 'spawn_suspended' });
    }
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
    if (e.subagentType.startsWith(GATE_AGENT_PREFIX) || GATE_ROUTE_NOTE.test(e.prompt)) return spawnSkip(engine, e, 'gate_routed');
    if (suspended !== null) return spawnSkip(engine, e, 'spawn_suspended');
    void diagnose(engine, live);
    const explicit = e.model !== undefined && e.model.trim() !== '' ? e.model : null;
    // What the event, configuration and offer cache decide comes before any wait. Null: the model can move.
    let modelSkip: string | null = !config.routeSubagentModel
      ? 'model_not_routed'
      : explicit !== null
        ? config.routeExplicitSpawnModel
          ? null
          : 'explicit_model'
        : inheritSkip(e);
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
    const pins = await within(pinsOf(engine, 'spawn', live), live);
    if (modelSkip === null && pins.subagentModel) modelSkip = 'subagent_model_pinned';
    if (modelSkip === null && pins.aliasRemap) modelSkip = 'alias_remapped';
    if (modelSkip === null && !hostSupported(await versionFor(engine, live))) modelSkip = 'host_unverified';
    const opts = policy('spawn', modelSkip === null ? await within(engine.availableModels().catch(() => []), live) : undefined);
    let tiers: ModelTier[] | null = null;
    if (modelSkip === null) {
      const offer = offerableTiers(baseline, opts);
      if ('reason' in offer) modelSkip = offer.reason;
      else tiers = offer.tiers;
    }
    // A subagent whose model is known here and takes no effort at all (Haiku) has no effort to ask about. Known: named
    // by the call, unless a pin or a remapped alias overrides it, or inherited by a verified built-in.
    const child = pins.subagentModel
      ? null
      : explicit !== null
        ? pins.aliasRemap && aliasFamily(explicit) !== null
          ? null
          : explicit
        : inheritSkip(e) === null
          ? e.parentModel
          : null;
    const childFacts = child === null ? null : (factsOf(child) ?? MODEL_FACTS.find((f) => f.family === aliasFamily(child)) ?? null);
    const effortless = tiers === null && childFacts !== null && childFacts.unconditionalEffort.length === 0;
    const efforts = childEnabled && !pins.mainEffort && !effortless ? EFFORT_LEVEL_TARGETS : null;
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
        const now = await within(pinsOf(engine, 'spawn', live), live);
        if (now.subagentModel || now.aliasRemap) assumed.delete(e);
      }
      return { target: null, answers };
    }
    // A pin or a narrower allowlist can arrive while Jev answers, so they are read again here rather than trusted from
    // before the request: what applies is what holds when the spawn is made. The pins are read last, after the
    // allowlist, so no await separates them from next.
    const allowed = await within(engine.availableModels().catch(() => []), live);
    const now = await within(pinsOf(engine, 'spawn', live), live);
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
      if (own.aborted) log(engine, { event: 'spawn_stop', tool_use_id: e.tool_use_id, reason: 'session_ended' });
      return null;
    } finally {
      live.dispose();
    }
  };

  const agentSpawn = async <E extends SpawnEvent, R extends SpawnOutcome>(engine: RouterEngine, e: E, next: NextLike<E, R>): Promise<R> => {
    const startedAt = engine.now();
    const deadline = startedAt + config.timeoutMs;
    const own = session.signal;
    const wait = budget(engine, deadline, own, next.signal);
    let plan: SpawnPlan | null = null;
    try {
      plan = await spawnTarget(engine, e, wait.signal, own);
    } catch {
      plan = null;
    }
    if (wait.expired.aborted || engine.now() >= deadline) {
      plan = null;
      log(engine, { event: 'budget_timeout', scope: 'spawn', tool_use_id: e.tool_use_id });
    }
    wait.dispose();
    // As on turn.step: the host has already spawned natively, so nothing here may spawn again.
    if (next.signal.aborted) throw new Error('jev-router: spawn dispatch abandoned before next');
    let target = plan?.target ?? null;
    // Nothing is awaited between these checks and next: a session that ended meanwhile gets nothing from this dispatch,
    // and neither does one whose routing another spawn's result suspended while this one waited.
    if (target !== null && own.aborted) {
      log(engine, { event: 'spawn_stop', tool_use_id: e.tool_use_id, reason: 'session_ended', requested: target });
      target = null;
    }
    if ((target !== null || plan?.answers) && !own.aborted && suspended !== null) {
      log(engine, { event: 'spawn_stop', tool_use_id: e.tool_use_id, reason: 'spawn_suspended', requested: target });
      target = null;
    }
    const answers = own.aborted || suspended !== null ? null : (plan?.answers ?? null);
    log(engine, {
      event: 'prepared',
      tool_use_id: e.tool_use_id,
      scope: 'spawn',
      preparation_ms: Math.max(0, engine.now() - startedAt),
      budget_ms: config.timeoutMs,
      routed: target !== null,
    });
    const result = await next(target !== null ? { ...e, model: target } : e);
    if (
      answers &&
      result.deny === undefined &&
      result.agentId !== undefined &&
      !own.aborted &&
      suspended === null &&
      !childHistoryFull &&
      !nativeChildren.has(result.agentId)
    )
      children.put(result.agentId, { answers, baseline: null, turnId: null, effort: null, stopped: false, dispatched: false });
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
      else {
        const c = children.get(e.agentId);
        if (c) c.stopped = true;
        children.delete(e.agentId);
        rememberNativeChild(e.agentId);
      }
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
      nativeChildren.clear();
      childHistoryFull = false;
      lastReply = null;
      lastRoot = null;
      lastIncoming = null;
      keyWait = null;
      versionWait = null;
      pinReads.clear();
      diagnosed = false;
    },
    inFlight: client.inFlight,
  };
};

export type Router = ReturnType<typeof createRouter>;
