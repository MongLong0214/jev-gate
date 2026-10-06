import type { Transport, Usage } from './client.ts';
import { createClient } from './client.ts';
import type { RouterConfig } from './config.ts';
import { validKey } from './config.ts';
import type { RootSwitch, SymbolicEffort } from './models.ts';
import { aliasFamily, answeredBy, effortIndex, factsOf, isSymbolicEffort, MODEL_FACTS, sameModel } from './models.ts';
import type { Answers, Baseline, PolicyOptions, RoutedEffort, RoutingPatch } from './policy.ts';
import { choosePatch, EFFORT_LEVEL_TARGETS, offerableEfforts, pairValid } from './policy.ts';
import { looksSecret } from './secret.ts';
import { offerPairs, selectPair, pairReceipt, applyEffort, type PairOffer, type EffortEdit } from './selection.ts';
import { routingContext, type RoutingCache } from './context.ts';
import { claudeCandidates, claudeContextFits, claudeModelAllowed, resolveClaudeModel, type ModelAliases } from './candidates.ts';
import { claudeTargetAllowed } from './models.ts';

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
  dispatchPair?: (tool: string, model: string, allowFable: boolean, agent: string, eligible?: boolean, unstartedToken?: string) => Promise<{ model?: string; effort_edit?: EffortEdit; deny?: string } | null>;
  modelAliases?: () => Promise<ModelAliases>;
  currentEffort?: () => Promise<SymbolicEffort | number | undefined>;
  /** Optional current complete-request bound. A /context estimate is never this evidence. */
  currentContextBound?: (turnId: string, index: number) => Promise<{ turnId: string; index: number; inputUpperBound: number; compatible: boolean } | undefined>;
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
  answer?: string;
  reason?: string;
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
/** Identifies this loaded hook source, independently of a manifest updated on disk. */
export const ROUTER_HOOK_VERSION = '0.8.9';

/**
 * Later 2.1 releases are accepted too. Pinned to one release, spawn routing went native after every host update: the
 * owner's 2.1.283 was `host_unverified` the day it shipped, though its agent.spawn, agent.offer and turn.step
 * declarations are unchanged from 2.1.282 and its Explore was observed inheriting the parent's Opus. A later release
 * that reports a different spawn model is visible in that response's diagnostics. A development build is refused:
 * its base names no release.
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
  incomingEffort: TurnStepEvent['effort'];
  effortSource: 'event' | 'host_effective' | 'unknown';
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
  pair?: { offer: PairOffer; raw: unknown };
  allocation?: EffortEdit;
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
  nativeRequested?: string | null;
  target: string | null;
  answers: Answers | null;
  pair?: { offer: PairOffer; raw: unknown };
  allocation?: EffortEdit;
  deny?: string;
}

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
  const { effortEdit: originalEdit, ...cleanRest } = rest;
  const result = final === undefined || final === baseline.effort ? { ...cleanRest, ...(originalEdit?.kind === 'omit' ? { effortEdit: originalEdit } : {}) } : { ...rest, effort: final, ...(originalEdit ? { effortEdit: { kind: 'set' as const, value: final } } : {}) };
  return { patch: result, ...(want !== undefined && final !== want ? { held: want } : {}) };
};

/** Optional exact switch restrictions; the default routes every compatible, permitted target. */
export const createRouter = (config: RouterConfig, rootSwitches?: readonly RootSwitch[], ownedDispatch = false) => {
  const rootEnabled = config.enabled && (config.routeMainEffort || config.routeMainModel);
  const spawnEnabled = ownedDispatch || config.enabled && (config.routeSubagentModel || config.routeSubagentEffort);
  const childEnabled = ownedDispatch || config.enabled && config.routeSubagentEffort;
  const stepEnabled = rootEnabled || childEnabled;
  const children = bounded<string, ChildRouting>(MAX_CHILDREN);
  // Missing mappings never wait on another spawn. Once history fills, new unknown loops stay native.
  const nativeChildren = new Set<string>();
  let childHistoryFull = false;
  const rememberNativeChild = (id: string): void => {
    if (nativeChildren.size < MAX_CHILDREN) nativeChildren.add(id);
    else childHistoryFull = true;
  };
  /** Last completed root answer, never an intermediate tool-loop reply. */
  let lastReply: string | null = null;
  let currentRootTurn: string | null = null;
  const recentRequests: string[] = [];
  /** The last root request that got a response: when, on which model, and at which effort. */
  let lastRoot: { at: number; model: string; effort: SymbolicEffort | null; cache: RoutingCache } | null = null;
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
  const log = (engine: RouterEngine, record: Record<string, unknown>): void => {
    if (!config.logDecisions) return;
    try {
      engine.log(`jev-router ${JSON.stringify(record)}`);
    } catch {
      // A diagnostic never reaches the result.
    }
  };

  const client = createClient({ timeoutMs: config.timeoutMs });

  /** Cache a usable key for this session; retry missing input after local onboarding saves one. */
  const keyFor = (engine: RouterEngine, signal: AbortSignal): Promise<KeyState | typeof ABORTED> => {
    if (signal.aborted) return Promise.resolve(ABORTED);
    if (keyWait === null) {
      const read = (async (): Promise<KeyState> => {
        if (config.explicitKey.kind === 'valid') return { key: config.explicitKey.value };
        // An explicit value that cannot be sent never quietly selects a different account's key.
        if (config.explicitKey.kind === 'invalid') return { reason: 'key_invalid' };
        const v = await engine.envKey();
        if (v === undefined || v.trim() === '') return { reason: 'key_missing' };
        return validKey(v) ? { key: v } : { reason: 'key_invalid' };
      })().catch((): KeyState => ({ reason: 'key_missing' }));
      const waiting = sharedRead(read);
      keyWait = waiting;
      void read.then(result => {
        if ('reason' in result && result.reason === 'key_missing' && keyWait === waiting) keyWait = null;
      });
    }
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
    tiers: scope === 'root' ? Object.fromEntries(Object.entries(config.tiers).map(([tier, value]) => {
      const family = aliasFamily(value);
      if (!family) return [tier, value];
      const allowed = availableModels?.find(id => factsOf(id)?.family === family);
      return [tier, allowed ?? MODEL_FACTS.find(f => f.family === family)?.ids[0] ?? value];
    })) : config.tiers,
    minUpgradeConfidence: config.minUpgradeConfidence,
    minDowngradeConfidence: config.minDowngradeConfidence,
    availableModels,
    ...(scope === 'root' && rootSwitches !== undefined ? { rootSwitches } : {}),
  });

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

  const aliasesOf = (engine: RouterEngine): Promise<ModelAliases> => engine.modelAliases ? engine.modelAliases().catch(() => ({})) : Promise.resolve({ haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5' });

  const rootAssessment = async (engine: RouterEngine, turnId: string, t: TurnRouting, text: string, context: string | null, live: AbortSignal): Promise<void> => {
    try {
      if (!config.routeMainModel && t.incomingEffort !== undefined && (!isSymbolicEffort(t.incomingEffort) || !factsOf(t.baseline.model)?.unconditionalEffort.length)) { t.stopped = true; log(engine, { event: 'root', turn: turnId, skipped: 'nothing_to_change' }); return; }
      const key = await keyFor(engine, live); if (key === ABORTED) throw ENDED;
      if (!('key' in key)) { t.stopped = true; log(engine, { event: 'root', turn: turnId, skipped: key.reason }); return; }
      const pins = await within(pinsOf(engine, 'root', live), live);
      const aliases = await within(aliasesOf(engine), live);
      const available = config.routeMainModel && !pins.mainModel ? await within(engine.availableModels().catch(() => []), live) : undefined;
      const hostBase = await versionFor(engine, live);
      if (t.incomingEffort === undefined && engine.currentEffort) {
        const effective = await within(engine.currentEffort().catch(() => undefined), live);
        if (effective !== undefined) { t.baseline.effort = effective; t.effortSource = 'host_effective'; }
      }
      const explicitEffort = isSymbolicEffort(t.baseline.effort) || t.incomingEffort === undefined && t.baseline.effort === undefined && hostSupported(hostBase);
      const baselineFacts = { hook_version: ROUTER_HOOK_VERSION, effort_field_present: t.incomingEffort !== undefined, effective_effort: t.baseline.effort ?? null, effort_source: t.effortSource, host_version: hostBase ?? null,
        baseline_source: 'turn.step', model_pin: pins.mainModel, effort_pin: pins.mainEffort, pin_source: 'host_effective_environment', pin_origin: 'unknown', model_enabled: config.routeMainModel, effort_enabled: config.routeMainEffort };
      const effortNotAsked = pins.mainEffort ? 'effort_pinned' : !config.routeMainEffort ? 'routing_off' : typeof t.baseline.effort === 'number' ? 'numeric_effort' : !explicitEffort ? 'effort_unresolved' : 'no_alternative';
      if (!config.routeMainModel && (!explicitEffort || !factsOf(t.baseline.model)?.unconditionalEffort.length)) { t.stopped = true; log(engine, { event: 'root', turn: turnId, skipped: 'nothing_to_change', ...baselineFacts, effort_not_asked: effortNotAsked }); return; }
      const bound = await within(engine.currentContextBound?.(turnId, 0).catch(() => undefined) ?? Promise.resolve(undefined), live);
      const currentBound = bound?.turnId === turnId && bound.index === 0 ? bound : undefined;
      const excluded: Record<string, number> = {};
      const candidates = claudeCandidates({ baseline: t.baseline.model, aliases, allowFable: config.allowFable,
        ...(currentBound ? { inputUpperBound: currentBound.inputUpperBound, requestCompatible: currentBound.compatible } : {}), excluded,
        ...(available !== undefined ? { available } : {}), ...(hostBase ? { hostBase } : {}), preferences: Object.values(config.tiers), ...(rootSwitches ? { switches: rootSwitches } : {}) });
      const offer = offerPairs({ baseline: { model: resolveClaudeModel(t.baseline.model, aliases) ?? t.baseline.model, effort: t.baseline.effort ?? null }, candidates,
        model: config.routeMainModel && !pins.mainModel, effort: config.routeMainEffort && !pins.mainEffort && !t.effortChanged && explicitEffort,
        upgrade: config.minUpgradeConfidence, downgrade: config.minDowngradeConfidence });
      if (!offer) { t.stopped = true; log(engine, { event: 'root', scope: 'root', turn: turnId, skipped: !resolveClaudeModel(t.baseline.model, aliases) ? 'capability_unknown' : 'no_alternative', ...(t.effortChanged ? { effort_kept: 'incoming_changed' } : {}), ...baselineFacts, candidates: candidates.slice(0, 16).map(c => c.id), excluded, model_withheld: 'no_applicable_target', model_asked: false, effort_asked: false, effort_not_asked: effortNotAsked }); return; }
      void diagnose(engine, live);
      const started = engine.now();
      const cache = lastRoot ? { ...lastRoot.cache, ageMs: Math.max(0, engine.now() - lastRoot.at) } : undefined;
      const result = await client.assess(engine, key.key, routingContext(text, context ?? undefined, recentRequests.slice(0, -1), cache), offer.questions, live,
        usage => log(engine, { event: 'late', scope: 'root', turn: turnId, usage: loggable(usage) }), () => log(engine, { event: 'request', scope: 'root', turn: turnId, sent: true }));
      const decision = result.ok ? selectPair(offer, result.answers) : { patch: {}, reasons: { model: 'not_asked', effort: 'not_asked' }, diagnostics: null };
      const cached = cachePatch(t.baseline, t.warmEffort, decision.patch as RoutingPatch);
      if (!live.aborted && !t.stopped) t.patch = cached.patch;
      if (!Object.keys(t.patch).length) t.stopped = true;
      log(engine, { event: 'root', scope: 'root', boundary: 'host_hook', turn: turnId, context_chars: context?.length ?? 0, from: { model: t.baseline.model, effort: t.baseline.effort ?? null },
        assessment: result.ok ? 'ok' : result.reason, sent: result.ok || result.sent, duration_ms: Math.max(0, engine.now() - started), usage: loggable(result.usage),
        discovered_count: MODEL_FACTS.length, eligible_count: candidates.length, offered_count: offer.candidates.length, catalog_complete: false,
        model_asked: offer.modelAsked, effort_asked: offer.effortQuestions.size > 0, allow_fable: config.allowFable,
        ...baselineFacts,
        model_not_asked: offer.modelAsked ? null : pins.mainModel ? 'model_pinned' : !config.routeMainModel ? 'routing_off' : 'no_alternative',
        effort_not_asked: offer.effortQuestions.size ? null : effortNotAsked,
        excluded: { ...excluded, effort_incompatible: candidates.length - offer.candidates.length }, candidates: offer.candidates.slice(0, 16).map(c => c.id), host_version: hostBase ?? null,
        proposed_patch: decision.patch, patch: t.patch, ...(cached.held ? { held_for_cache: cached.held } : {}),
        reasons: { ...decision.reasons, ...(cached.held ? { effort: 'cache_preserved' } : {}) },
        selection: decision.diagnostics, answers: result.ok ? pairReceipt(offer, result.answers) : null });
    } catch (error) { t.stopped = true; log(engine, { event: 'root', turn: turnId, skipped: error === ENDED ? 'turn_retired' : 'internal_error' }); }
  };

  /**
   * The stored patch for this step, or null. Incoming values that differ from the baseline win for the rest of the
   * turn, and so does a pin set since the decision.
   */
  const applyStored = async (engine: RouterEngine, t: TurnRouting, e: TurnStepEvent, live: AbortSignal): Promise<RoutingPatch | null> => {
    if (t.stopped) return null;
    const effectiveEffort = t.patch.effortEdit?.kind === 'omit' ? undefined : t.patch.effort ?? t.baseline.effort;
    if (e.model !== t.baseline.model && e.model !== t.patch.model || e.effort !== t.incomingEffort && e.effort !== t.baseline.effort && e.effort !== effectiveEffort) {
      t.stopped = true; log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'incoming_divergence' }); return null;
    }
    const available = await within(engine.availableModels().catch(() => []), live);
    const aliases = await within(aliasesOf(engine), live);
    const pins = await within(pinsOf(engine, 'root', live), live);
    if (pins.mainModel && !t.modelStopped) { t.modelStopped = true; log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'model_pinned' }); }
    if (pins.mainEffort && !t.effortStopped) { t.effortStopped = true; log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'effort_pinned' }); }
    let model = t.modelStopped ? undefined : t.patch.model;
    if (model && (!claudeTargetAllowed(model, config.allowFable) || !claudeModelAllowed(model, available, aliases))) { model = undefined; t.modelStopped = true; log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'model_not_allowed' }); }
    // An effort selected conditionally for B can never be reused on A after B was suppressed.
    if (t.patch.model && !model) return null;
    if (model && factsOf(model)!.contextTokens < (factsOf(t.baseline.model)?.contextTokens ?? 0)) {
      const bound = await within(engine.currentContextBound?.(e.turnId, e.index).catch(() => undefined) ?? Promise.resolve(undefined), live);
      if (!bound?.compatible || bound.turnId !== e.turnId || bound.index !== e.index || !claudeContextFits(t.baseline.model, model, bound.inputUpperBound)) { t.stopped = true; log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'context_unverified' }); return null; }
    }
    const edit = !t.effortStopped ? t.patch.effortEdit : undefined;
    const effort = edit?.kind === 'set' && isSymbolicEffort(edit.value) ? edit.value : !t.effortStopped ? t.patch.effort : undefined;
    if (model && edit?.kind !== 'omit' && !pairValid(model, effort ?? e.effort)) { log(engine, { event: 'root_stop', turn: e.turnId, index: e.index, reason: 'pair_invalid' }); return null; }
    const patch: RoutingPatch = { ...(model ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(edit ? { effortEdit: edit } : {}) };
    return Object.keys(patch).length ? patch : null;
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
      incomingEffort: e.effort,
      effortSource: e.effort !== undefined ? 'event' : 'unknown',
      controller: new AbortController(),
      pending: null,
      deadline,
      patch: {},
      stopped: false,
      modelStopped: false,
      effortStopped: false,
      // Explicit zero cache usage is cold. Missing usage remains unknown; it
      // must not be converted to zero or waive the existing cache protection.
      warmEffort: lastRoot && lastRoot.model === e.model && engine.now() - lastRoot.at < WARM_MS &&
        !(lastRoot.cache.read === 0 && lastRoot.cache.write === 0) ? lastRoot.effort : null,
      effortChanged: lastIncoming !== null && lastIncoming.effort !== e.effort && (lastRoot?.effort ?? undefined) !== e.effort,
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
      if (c.pair) {
        const selected = selectPair({ ...c.pair.offer, baseline: { model: e.model, effort: e.effort ?? null }, modelAsked: false }, c.pair.raw);
        if (selected.patch.effortEdit) c.allocation = selected.patch.effortEdit;
      }
      if (c.allocation) {
        const edit = c.allocation;
        if (edit.kind === 'keep') { c.stopped = true; return null; }
        if (edit.kind === 'set' && !factsOf(e.model)?.unconditionalEffort.includes(edit.value as SymbolicEffort) || edit.kind === 'omit' && (factsOf(e.model)?.unconditionalEffort.length !== 0 || factsOf(e.model)?.conditionalEffort.length !== 0)) { c.stopped = true; return null; }
        c.effort = edit.kind === 'set' && isSymbolicEffort(edit.value) ? edit.value : null;
      }
      const efforts = c.allocation ? null : offerableEfforts(c.baseline);
      const decision = efforts ? choosePatch(c.answers, c.baseline, { tiers: null, efforts }, policy('spawn', undefined)) : null;
      if (!c.allocation) c.effort = decision?.patch.effort ?? null;
      log(engine, { event: 'child', agent_id: id, from: { model: e.model, effort: e.effort ?? null }, patch: c.effort, reason: decision ? decision.effort : 'effort_unknown' });
      if (c.effort === null && c.allocation?.kind !== 'omit') {
        c.stopped = true;
        return null;
      }
    } else if (e.turnId !== c.turnId) {
      c.stopped = true;
      log(engine, { event: 'child_stop', agent_id: id, index: e.index, reason: 'next_turn' });
      return null;
    } else if (e.model !== c.baseline.model || e.effort !== c.baseline.effort && e.effort !== c.effort && !(c.allocation?.kind === 'omit' && e.effort === undefined)) {
      c.stopped = true;
      log(engine, { event: 'child_stop', agent_id: id, index: e.index, reason: 'incoming_divergence' });
      return null;
    }
    const effort = c.effort;
    if (effort === null && c.allocation?.kind !== 'omit') return null;
    // Read last, so an effort pin set while the step waited still wins.
    const pins = await until(pinsOf(engine, 'effort', signal), signal);
    if (pins === ABORTED || c.stopped) return null;
    if (pins.mainEffort) {
      c.stopped = true;
      log(engine, { event: 'child_stop', agent_id: id, index: e.index, reason: 'effort_pinned' });
      return null;
    }
    return { patch: { ...(effort !== null ? { effort } : {}), ...(c.allocation ? { effortEdit: c.allocation } : {}) }, child: c };
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
      const requested = patch?.model ?? e.model;
      const seen = result && typeof result.usage?.model === 'string' ? result.usage.model : null;
      // `applied` is what was sent to next, not a confirmation: the host reports the model that answered, never the
      // effort it ran at.
      log(engine, {
        event: 'root_result',
        turn: e.turnId,
        index: e.index,
        requested,
        requested_effort: patch?.effortEdit?.kind === 'omit' ? null : patch?.effort ?? e.effort ?? null,
        applied: patch ?? { model: e.model, ...(e.effort !== undefined ? { effort: e.effort } : {}) },
        observed: seen,
        confirmation: seen === null ? 'unobserved' : patch?.model !== undefined ? sameModel(patch.model, seen) ? 'confirmed' : 'mismatch' : answeredBy(e.model, seen) ? 'confirmed' : 'mismatch',
        observed_effort: 'unknown',
        usage: result ? loggable(countsOf(result.usage)) : null,
      });

    } catch {
      // Observation only.
    }
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
    if (next.signal.aborted || own.aborted) {
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
      index: e.index,
      agent_id: e.agentId ?? null,
      scope: e.agentId === undefined ? 'root' : 'child',
      preparation_ms: Math.max(0, engine.now() - startedAt),
      budget_ms: config.timeoutMs,
      routed: patch !== null,
    });
    if (prepared?.child && patch) prepared.child.dispatched = true;
    // Once next starts, every chunk, the return, a refusal or an error belongs to the host: nothing here retries it.
    let result: R;
    try {
      const applied = patch ? applyEffort({ ...e, ...(patch.model ? { model: patch.model } : {}), ...(patch.effort ? { effort: patch.effort } : {}) }, patch.effortEdit) : e;
      result = yield* next(applied);
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
    if (e.agentId === undefined) observeStep(engine, e, patch, result);
    if (e.agentId !== undefined) {
      const requested = patch?.model ?? e.model;
      const observed = result?.usage?.model ?? null;
      log(engine, {
        event: 'child_result', agent_id: e.agentId, turn: e.turnId, index: e.index,
        requested, observed, requested_effort: patch?.effortEdit?.kind === 'omit' ? null : patch?.effort ?? e.effort ?? null, observed_effort: 'unknown',
        confirmation: observed === null ? 'unobserved' : answeredBy(requested, observed) ? 'confirmed' : 'mismatch',
        usage: result ? loggable(countsOf(result.usage)) : null,
      });
    }
    if (e.agentId === undefined && !own.aborted && currentRootTurn === e.turnId) {
      const sent = patch?.effortEdit?.kind === 'omit' ? undefined : patch?.effort ?? e.effort;
      const asked = patch?.model ?? e.model;
      const seen = typeof result?.usage?.model === 'string' ? result.usage.model : null;
      // Only a response the asked model gave wrote the cache a later turn on that model reads.
      if (seen !== null && answeredBy(asked, seen)) {
        const counts = countsOf(result?.usage);
        lastRoot = { at: engine.now(), model: asked, effort: isSymbolicEffort(sent) ? sent : null,
          cache: { model: asked, ageMs: 0, input: counts?.['input_tokens'] ?? null, read: counts?.['cache_read_input_tokens'] ?? null, write: counts?.['cache_creation_input_tokens'] ?? null } };
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------------- spawn

  /** A type the Router does not route is caller text: it is never logged, only named as other. */
  const typeLabel = (e: SpawnEvent): string => (INHERITING_BUILT_INS.has(e.subagentType) ? e.subagentType : 'other');

  const spawnSkip = (engine: RouterEngine, e: SpawnEvent, reason: string): null => {
    log(engine, { event: 'spawn', tool_use_id: e.tool_use_id, type: typeLabel(e), skipped: reason });
    return null;
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
    const owned = e.subagentType.startsWith(GATE_AGENT_PREFIX) || GATE_ROUTE_NOTE.test(e.prompt) || LEAN_MARKER.test(e.prompt) || LEAN_MARKER.test(e.description);
    if (owned) {
      const token = /\[JEV_DISPATCH token=([a-f0-9-]{36})\]$/.exec(e.prompt)?.[1] ?? '';
      // Eligibility and an already allocated effort only: Gate owns its single batch; Lean adds no policy call.
      let pair;
      try { pair = engine.dispatchPair ? await within(engine.dispatchPair(e.tool_use_id, e.model ?? (e.subagentType === 'jev-gate:executor' || LEAN_MARKER.test(e.prompt) ? e.parentModel : ''), config.allowFable, e.subagentType, true, token), live) : null; }
      catch { return { target: null, answers: null, deny: 'Dispatch ownership unavailable; no child started.' }; }
      if (pair?.deny) return { target: null, answers: null, deny: pair.deny };
      if (pair?.model) {
        const [aliases, available, pins, hostBase] = await Promise.all([within(aliasesOf(engine), live), within(engine.availableModels().catch(() => []), live), within(pinsOf(engine, 'spawn', live), live), versionFor(engine, live)]);
        const candidate = claudeCandidates({ baseline: pair.model, aliases, allowFable: config.allowFable, ...(available !== undefined ? { available } : {}), ...(hostBase ? { hostBase } : {}), scope: 'spawn' }).find(c => c.id === pair.model);
        if (!candidate || !claudeTargetAllowed(pair.model, config.allowFable) || !claudeModelAllowed(pair.model, available, aliases) || pins.subagentModel) {
          const cleanup = engine.dispatchPair ? await within(engine.dispatchPair(e.tool_use_id, pair.model, config.allowFable, e.subagentType, false, token), live) : null;
          return { target: null, answers: null, deny: cleanup?.deny ?? 'Automatic child unavailable; continue in the main session.' };
        }
        return { target: pair.model, answers: {}, ...(pair.effort_edit && !pins.mainEffort ? { allocation: pair.effort_edit } : {}) };
      }
      const aliases = await within(aliasesOf(engine), live);
      const id = e.model ?? e.parentModel;
      const resolved = aliases[id] ?? id;
      if (!claudeTargetAllowed(resolved, config.allowFable)) return { target: null, answers: null, deny: 'No eligible automatic child model. Continue in the main session; no child started.' };
      spawnSkip(engine, e, LEAN_MARKER.test(e.prompt) || LEAN_MARKER.test(e.description) ? 'lean_marker' : 'gate_routed');
      return { target: null, answers: null };
    }
    if (!config.enabled) return null;
    if (e.fork) return spawnSkip(engine, e, 'fork');
    if (!config.routeSubagentModel && (!config.routeSubagentEffort || childHistoryFull)) return spawnSkip(engine, e, 'nothing_to_change');
    const explicitDefault = e.model?.trim() ? e.model : null;
    const unverified = explicitDefault ? null : inheritSkip(e);
    if (unverified && (unverified === 'baseline_unknown' || !config.routeSubagentEffort || childHistoryFull)) return spawnSkip(engine, e, unverified);
    if (explicitDefault && !config.routeExplicitSpawnModel && !config.routeSubagentEffort) return spawnSkip(engine, e, 'explicit_model');
    const key = await keyFor(engine, live); if (key === ABORTED) throw ENDED;
    if (!('key' in key)) {
      const aliases = await within(aliasesOf(engine), live);
      return !claudeTargetAllowed(aliases[e.model ?? e.parentModel] ?? e.model ?? e.parentModel, config.allowFable) ? { target: null, answers: null, deny: 'Restricted automatic child disabled; continue in the main session.' } : spawnSkip(engine, e, key.reason);
    }
    const explicit = e.model?.trim() ? e.model : null;
    const inheritance = explicit ? null : inheritSkip(e);
    if (!explicit && inheritance && (!config.routeSubagentEffort || childHistoryFull)) return spawnSkip(engine, e, inheritance);
    if (!hostSupported(await versionFor(engine, live))) return spawnSkip(engine, e, 'host_unverified');
    const pins = await within(pinsOf(engine, 'spawn', live), live);
    if (pins.aliasRemap && !engine.modelAliases) return spawnSkip(engine, e, 'alias_remapped');
    const aliases = await within(aliasesOf(engine), live);
    const available = await within(engine.availableModels().catch(() => []), live);
    const baselineModel = aliases[explicit ?? e.parentModel] ?? explicit ?? e.parentModel;
    const candidates = claudeCandidates({ baseline: baselineModel, aliases, allowFable: config.allowFable,
      ...(available !== undefined ? { available } : {}), scope: 'spawn', preferences: Object.values(config.tiers) }).filter(c => claudeTargetAllowed(c.id, config.allowFable));
    if (!candidates.length) return { target: null, answers: null, deny: 'No eligible automatic child model. Continue in the main session; no child started.' };
    const inheritedEffort = engine.currentEffort ? await within(engine.currentEffort().catch(() => undefined), live) : lastRoot?.effort ?? lastIncoming?.effort;
    const offer = offerPairs({ baseline: { model: baselineModel, effort: inheritedEffort ?? null }, candidates,
      model: config.routeSubagentModel && !pins.subagentModel && (!explicit || config.routeExplicitSpawnModel) && !inheritance,
      effort: config.routeSubagentEffort && !pins.mainEffort && !childHistoryFull,
      upgrade: config.minUpgradeConfidence, downgrade: config.minDowngradeConfidence });
    if (!offer) return !claudeTargetAllowed(baselineModel, config.allowFable) ? { target: null, answers: null, deny: 'Restricted automatic child disabled; continue in the main session.' } : spawnSkip(engine, e, 'no_alternative');
    const state = routingContext(e.prompt); Object.assign(state.task, { description: e.description, subagent_type: e.subagentType, source: 'child_contract' });
    const result = await client.assess(engine, key.key, state, offer.questions, live, usage => log(engine, { event: 'late', scope: 'spawn', tool_use_id: e.tool_use_id, usage: loggable(usage) }));
    if (!result.ok) { log(engine, { event: 'spawn', tool_use_id: e.tool_use_id, type: typeLabel(e), assessment: result.reason, sent: result.sent, usage: loggable(result.usage) }); return !claudeTargetAllowed(baselineModel, config.allowFable) ? { target: null, answers: null, deny: 'Restricted automatic child disabled; continue in the main session.' } : null; }
    const selected = selectPair(offer, result.answers);
    let target = selected.patch.model ?? null;
    if (childHistoryFull && target && !candidates.find(c => c.id === target)?.efforts.includes(String(inheritedEffort))) target = null;
    if (!target && !claudeTargetAllowed(baselineModel, config.allowFable)) return { target: null, answers: null, deny: 'Restricted automatic child disabled; continue in the main session.' };
    const nowAvailable = await within(engine.availableModels().catch(() => []), live);
    const nowPins = await within(pinsOf(engine, 'spawn', live), live);
    if (target && (nowPins.subagentModel || nowPins.aliasRemap && !engine.modelAliases || !claudeTargetAllowed(target, config.allowFable) || !claudeModelAllowed(target, nowAvailable, aliases))) { log(engine, { event: 'spawn_stop', tool_use_id: e.tool_use_id, requested: target, reason: nowPins.subagentModel ? 'subagent_model_pinned' : nowPins.aliasRemap && !engine.modelAliases ? 'alias_remapped' : 'target_not_allowed' }); return null; }
    log(engine, { event: 'spawn', scope: 'subagent', boundary: 'host_hook', tool_use_id: e.tool_use_id, type: typeLabel(e), from: baselineModel, assessment: 'ok', sent: true,
      usage: loggable(result.usage), explicit: explicit !== null, patch: selected.patch, reasons: selected.reasons, model_asked: offer.modelAsked, effort_asked: offer.effortQuestions.size > 0,
      discovered_count: MODEL_FACTS.length, eligible_count: candidates.length, offered_count: offer.candidates.length, catalog_complete: false, allow_fable: config.allowFable });
    return { target, nativeRequested: nowPins.subagentModel ? null : baselineModel, answers: {}, pair: { offer, raw: result.answers } };
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
    let baselineAllowed = claudeTargetAllowed(e.model ?? e.parentModel, config.allowFable);
    try {
      const aliases = await within(aliasesOf(engine), wait.signal);
      baselineAllowed = claudeTargetAllowed(aliases[e.model ?? e.parentModel] ?? e.model ?? e.parentModel, config.allowFable);
      plan = await spawnTarget(engine, e, wait.signal, own);
    } catch {
      plan = null;
    }
    if (wait.expired.aborted || engine.now() >= deadline) {
      plan = null;
      log(engine, { event: 'budget_timeout', scope: 'spawn', tool_use_id: e.tool_use_id });
    }
    wait.dispose();
    if ((!plan && (e.subagentType.startsWith(GATE_AGENT_PREFIX) || GATE_ROUTE_NOTE.test(e.prompt) || LEAN_MARKER.test(e.prompt) || LEAN_MARKER.test(e.description))) || !baselineAllowed && !plan?.target) plan = { target: null, answers: null, deny: 'Automatic dispatch could not be verified; continue in the main session. No child started.' };
    // As on turn.step: the host has already spawned natively, so nothing here may spawn again.
    if (next.signal.aborted || own.aborted) throw new Error('jev-router: spawn dispatch abandoned before next');
    if (plan?.deny) return { deny: plan.deny } as R;
    let target = plan?.target ?? null;
    // Nothing is awaited between these checks and next: a session that ended meanwhile gets nothing from this dispatch,
    // and neither does one whose routing another spawn's result suspended while this one waited.
    if (target !== null && own.aborted) {
      log(engine, { event: 'spawn_stop', tool_use_id: e.tool_use_id, reason: 'session_ended', requested: target });
      target = null;
    }
    const answers = own.aborted ? null : (plan?.answers ?? null);
    log(engine, {
      event: 'prepared',
      tool_use_id: e.tool_use_id,
      scope: 'spawn',
      preparation_ms: Math.max(0, engine.now() - startedAt),
      budget_ms: config.timeoutMs,
      routed: target !== null,
    });
    const result = await next(target !== null ? { ...e, model: target } : e);
    if (answers && childHistoryFull) log(engine, { event: 'spawn_dimension', tool_use_id: e.tool_use_id, reason: 'child_history_full', dimension: 'effort', applied: false });
    if (
      answers &&
      result.deny === undefined &&
      result.agentId !== undefined &&
      !own.aborted &&
      !childHistoryFull &&
      !nativeChildren.has(result.agentId)
    )
      children.put(result.agentId, { answers, ...(plan?.pair ? { pair: plan.pair } : {}), ...(plan?.allocation ? { allocation: plan.allocation } : {}), baseline: null, turnId: null, effort: null, stopped: false, dispatched: false });
    try {
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
          // Response diagnostics never invalidate unrelated dispatches.
        }
      } else {
        const requested = plan?.nativeRequested ?? null;
        log(engine, result.deny !== undefined
          ? { event: 'spawn_native_result', tool_use_id: e.tool_use_id, caller_model: e.model ?? null, requested, denied: true }
          : { event: 'spawn_native_result', tool_use_id: e.tool_use_id, caller_model: e.model ?? null, requested, observed: result.model, agent_id: result.agentId ?? null,
              confirmation: requested === null ? 'unobserved' : sameModel(requested, result.model) ? 'confirmed' : 'mismatch' });
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
      if (rootEnabled) { if (currentRootTurn !== null && currentRootTurn !== e.turnId) retire(currentRootTurn); currentRootTurn = e.turnId; turnTexts.put(e.turnId, e.text); recentRequests.push(e.text); if (recentRequests.length > 4) recentRequests.shift(); }
    },
    turnStep,
    /** A child's completion carries its agentId and never retires the root's turn. */
    turnComplete: <E extends TurnEndEvent>(e: E): void => {
      if (e.agentId === undefined) {
        if (currentRootTurn === e.turnId) { lastReply = e.reason === 'answer' && e.answer?.trim() && !looksSecret(e.answer) ? e.answer : null; currentRootTurn = null; }
        retire(e.turnId);
      }
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
      lastReply = null; currentRootTurn = null; recentRequests.length = 0;
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
