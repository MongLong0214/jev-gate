import { randomUUID, createHash } from 'node:crypto';
import { join, isAbsolute, resolve } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkerWorktree, type WorkerWorktree } from '../worktree.js';
import { looksSecret } from '../outbound-text.js';
import { parseWorkerReply } from '../plan.js';
import { renderWorkerDelivery } from '../coordinator.js';
import { runHook, type HookDeps } from '../hook.js';
import { stateRoot, readJob, updateJob, own, codexExecutions, hostExited, pendingBackgroundPolicy } from '../job.js';
import { OWNED_AGENTS, agentForTier, type CodexFailure, type HookInput, type Reservation } from '../types.js';
import { OWNED_AGENT_PROFILES } from '../agents.js';
import type { Env } from '../config.js';
import { codexTraceDir } from '../codex-paths.js';
import { openTraceDir, type TraceWriter } from '../trace.js';
import { CodexRpc, RpcRequestError } from './rpc.js';
import { runtimeCodexPolicy, type CodexPolicyConfig } from './config.js';
import { codexObservation, textInput, obj, type Obj } from './source.js';
import { AGENT_TOOL, CODEX_PROFILES, codexGuidance } from './profiles.js';
import { routeCodex, codexCandidates, type CodexModel } from './router.js';
import type { CodexBilling } from './route-cost.js';
import { capturedPermissions } from './permissions.js';
import { codexCallerWorkspace } from './workspace.js';
import { writesInto } from './write-scope.js';
import { selectRecentPrompts } from '../recent-prompts.js';
import { wireSource } from './wire.js';
import { normalizeUsage, usageCost, ModelCache } from '../cost.js';
import { providerPrice, providerContextLimit } from '../provider-prices.js';
import { workerStepContext, rootStepContext, requestStepKey } from './worker-step.js';
import { requestedUpdateEffort } from './effort-update.js';
import { cacheDiagnostics, requestChange, requestShape, type RequestShape } from './cache-reuse.js';
import { compactScope, newCompactState, prepareCodexCompact, type CompactReceipt, type CompactState } from './compact.js';
import { observedDelegationPrices } from '../delegation-prices.js';
import { normalizeCatalog, codexTargetAllowed, generalCodexModel } from './catalog.js';
import { applyEffort, type PairPatch } from '../../mods/router/hooks/selection.ts';
import type { RoutingCache } from '../../mods/router/hooks/context.ts';

export interface CodexSubmission { prompt: string | null; model: string; effort: string | null; requestId: string; epoch: string; index: number | null; scope: 'root' | 'child'; parent: string | null; defaultCachePolicy: boolean; billing: CodexBilling; cacheInput?: RequestShape }
export interface CodexRequestFailure { stage: 'connect' | 'stream' | 'http' | 'sse' | 'eof'; elapsed_ms: number; status?: number }
interface WorkerDispatch {
  parent: Session; prompt: string; tool: string; input: Obj; signal: AbortSignal;
  worktree: WorkerWorktree | null; startedAt: number; attempted: boolean;
  ended?: Obj; settling?: Promise<string>; settled?: boolean; output?: string; interruptSent?: boolean; cancel?: () => void;
  background?: boolean;
  /** Definite pre-send evidence; a native terminal turn has none. */
  failure?: CodexFailure; unconfirmed?: string;
  pendingReason?: string;
}
interface InferenceRoute {
  index: number; model: string; effort: string | null; patch: PairPatch;
  config?: string; catalogEpoch?: number; settingsEpoch?: number; pending?: Promise<void>;
}
interface Session {
  id: string; settings: Obj; baseline: { model: string; effort: string | null }; policy: CodexPolicyConfig;
  prompt: string | null; turn: string | null; items: Obj[]; complete: boolean; epoch: string;
  tokens: number | null; window: number | null; controller: AbortController | null;
  commands: Map<string, string>;
  requestModel?: string; requestEffort?: string;
  requestKind?: 'root_response' | 'child_response';
  eligible?: boolean; terminal?: boolean;
  role?: string; parent?: string; done?: (turn: Obj) => void; route?: PairPatch; routePending?: Promise<void>; routeDeadline?: number; routeConfig?: string;
  managedRoute?: { prompt: string; config: string; catalogEpoch: number };
  previousReply?: string; completedReply?: string; turnReply?: string; lastSubmitted?: CodexSubmission;
  starting?: { prompt: string; controller: AbortController };
  external?: boolean; task?: string; routed?: string;
  wire?: unknown[];
  wirePending?: boolean;
  requests?: string[];
  recentRequests?: string[];
  dispatch?: WorkerDispatch;
  cache?: RoutingCache & { at: number };
  modelCache?: ModelCache;
  stepRoutes?: Map<string, InferenceRoute>;
  stepIndex?: number;
  rootRoutes?: Map<string, InferenceRoute>;
  rootInput?: string;
  rootNativeChanged?: boolean;
  settingsEpoch?: number;
  compact?: CompactState;
  cacheInput?: { shape: RequestShape; epoch: string; billing: CodexBilling };
}
const contextOf = (result: { stdout: string | null }): string => {
  if (!result.stdout) return '';
  return String(obj(obj(JSON.parse(result.stdout))?.['hookSpecificOutput'])?.['additionalContext'] ?? '');
};
const deny = (reason: string): Obj => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const safeGitEnv = (env: Env): Env => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_')));
// Fixed text per closed category: the original exception can carry paths, prompts or host payloads.
const FAILURE_ADVICE: Record<CodexFailure['category'], string> = {
  preflight_conflict: 'Another managed worker still holds this write scope. Retry after that worker settles, or continue in the main session.',
  permissions_unavailable: 'Its parent permission profile could not be carried to a worker unchanged. Continue in the main session; native permissions are unchanged.',
  worktree_unavailable: 'Its isolated worktree could not be created. Continue in the main session, or retry after checking the repository.',
  allocation_unavailable: 'Its allocated model or effort is no longer available. Retry the dispatch, or continue in the main session.',
  cancelled: 'The dispatch was cancelled before the worker started.',
  reservation_unavailable: 'Job state could not record its execution reservation. Retry the dispatch, or continue in the main session.',
  native_start_rejected: 'Codex did not start the worker. Retry the dispatch, or continue in the main session.',
  native_failed_turn: 'Codex reported the worker turn as failed. Inspect its files before retrying.',
  interrupted: 'The worker turn was interrupted.',
  termination_unconfirmed: 'Its reservation and files remain. A duplicate managed dispatch is prevented; native tools remain available. No replacement execution is claimed.',
};
const failureHead = (f: CodexFailure): string => `Worker ${f.not_executed ? 'not started' : f.category === 'termination_unconfirmed' ? 'termination unconfirmed' : 'did not complete'}: ${f.category} at ${f.stage}`;
const preflight = (category: CodexFailure['category']): CodexFailure => ({ category, stage: 'preflight', not_executed: true });
/** Fixed: a thrown dispatch can carry paths, prompts or host payloads. */
export const DISPATCH_FAILED = 'Jev dispatch failed or was interrupted. No completion is claimed. Continue in the main session or inspect the current job.';

/** A Codex execution adapter over the existing Gate state machine. No policy decisions are delegated to prose. */
export class CodexPolicy {
  readonly sessions = new Map<string, Session>();
  hasActiveWorkers(): boolean { return [...this.sessions.values()].some(s => s.dispatch && !s.dispatch.settled); }
  catalog: CodexModel[] = [];
  catalogComplete = false;
  catalogExcluded: Record<string, number> = {};
  private catalogEpoch = 0;
  private catalogReady: Promise<void> = Promise.resolve();
  private trace: TraceWriter | undefined;
  private env: Env;
  private hooked = new Set<string>();
  private backgroundResults = new Map<string, { parent: string; output: string }>();
  private settlingOrphans = new Set<string>();
  /** #239: the app-server process that runs this policy's workers, recorded so a later process can tell they ended with it. */
  hostPid: number | undefined;
  private workerStarts = new Map<string, { range: [number, number]; writeRate: number }>();
  constructor(readonly rpc: CodexRpc, env: Env, private fetchImpl?: typeof fetch, private profiles = CODEX_PROFILES, private bypassHookTrust = false) {
    // Claude launch settings cannot pin or alter a Codex thread.
    this.env = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('CLAUDE_')));
    this.env['JEV_GATE_TRACE_DIR'] = codexTraceDir(env);
    this.env['JEV_GATE_STATE_DIR'] = join(stateRoot(env), 'codex');
    const trace = openTraceDir(this.env['JEV_GATE_TRACE_DIR'], this.env);
    if (trace.ok) this.trace = { write: (phase, data) => { try { return trace.writer.write(phase, data); } catch { return { ok: false, error: 'recording_failed' }; } } };
    rpc.onResponse = (r, m, p) => this.response(r, m, p);
    rpc.onClose = () => this.close();
    rpc.onNotification = m => this.notification(m);
    rpc.onRequest = async m => {
      if (m['method'] !== 'item/tool/call' || obj(m['params'])?.['tool'] !== 'jev_agent') return false;
      const p = obj(m['params'])!;
      let output: string;
      try { output = await this.agent(p); }
      catch (e) { output = this.failedDispatch(p['threadId'], e); }
      try { rpc.send({ id: m['id'], result: { contentItems: [{ type: 'inputText', text: output }], success: true } }); }
      catch { /* A closed local transport cannot deliver output and does not prove remote termination. */ }
      return true;
    };
  }
  private async response(result: Obj, method: string, params: Obj): Promise<Obj> {
    if (method === 'initialize') {
      this.catalogReady = this.loadCatalog();
      return result;
    }
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) {
      const thread = obj(result['thread']); const id = thread?.['id'];
      if (typeof id !== 'string' || typeof result['model'] !== 'string') return result;
      if (!this.sessions.has(id)) {
        const items = Array.isArray(thread?.['turns']) ? thread!['turns'].flatMap((t: unknown) => Array.isArray(obj(t)?.['items']) ? obj(t)!['items'] as Obj[] : []) : [];
        this.sessions.set(id, { id, settings: { ...result, sandboxPolicy: result['sandbox'], effort: result['reasoningEffort'] }, baseline: { model: result['model'], effort: typeof result['reasoningEffort'] === 'string' ? result['reasoningEffort'] : null },
          policy: runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: result['model'] }, this.catalog), prompt: null, turn: null, items, complete: method === 'thread/start', epoch: 'initial', tokens: method === 'thread/start' ? 0 : null, window: null, controller: null, commands: new Map() });
        if (method !== 'thread/start') await this.hydrate(id);
      }
    }
    if (method === 'turn/start') {
      const session = this.sessions.get(String(params['threadId'])); const turn = obj(result['turn']);
      if (session && typeof turn?.['id'] === 'string') session.turn = turn['id'];
    }
    if (method === 'thread/settings/update') {
      const session = this.sessions.get(String(params['threadId']));
      if (session) {
        delete session.managedRoute;
        session.settingsEpoch = (session.settingsEpoch ?? 0) + 1;
        if (typeof params['model'] === 'string') session.baseline.model = params['model'];
        if (typeof params['effort'] === 'string' || params['effort'] === null) session.baseline.effort = params['effort'] as string | null;
      }
    }
    return result;
  }
  private async loadCatalog(): Promise<void> {
    const epoch = ++this.catalogEpoch; const raw: unknown[] = []; const cursors = new Set<string>();
    this.catalog = []; this.catalogComplete = false;
    let complete = false;
    try {
      let cursor: string | null = null; const deadline = Date.now() + 3000;
      for (let page = 0; page < 20 && Date.now() < deadline; page++) {
        const r = await this.rpc.request('model/list', { ...(cursor ? { cursor } : {}), includeHidden: true }, Math.max(1, deadline - Date.now()));
        if (!Array.isArray(r['data'])) break;
        raw.push(...r['data']);
        const next = r['nextCursor'];
        if (next === null || next === undefined || next === '') { complete = true; break; }
        if (typeof next !== 'string' || cursors.has(next)) break;
        cursors.add(next); cursor = next;
      }
    } catch { /* Retain compatible candidates from completed pages without claiming a complete catalog. */ }
    if (epoch !== this.catalogEpoch) return;
    const result = normalizeCatalog(raw, complete);
    this.catalog = result.models; this.catalogComplete = result.complete; this.catalogExcluded = result.excluded;
    for (const session of this.sessions.values()) delete session.route;
  }
  async initialize(): Promise<void> { this.catalogReady = this.loadCatalog(); await this.catalogReady; }
  private async waitCatalog(deadline: number): Promise<void> {
    const remaining = deadline - Date.now(); if (remaining <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.catalogReady, new Promise<void>(resolve => { timer = setTimeout(resolve, remaining); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  supplyKey(key: string): void { if (key.length > 0 && key.length <= 8192 && !/[\r\n\0]/.test(key)) this.env['TYPESAFE_API_KEY'] = key; }

  /** Native plugin hooks register ordinary app/CLI/IDE roots. The sidecar owns only its child App Server. */
  async externalHook(input: Obj, signal?: AbortSignal): Promise<Obj> {
    const id = input['session_id']; const event = input['hook_event_name'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) return {};
    let session = this.sessions.get(id);
    if (input['agent_id'] && (!session || session.external)) return {};
    if (!session && event === 'SessionStart' && typeof input['cwd'] === 'string' && isAbsolute(input['cwd']) && typeof input['model'] === 'string' && this.sessions.size < 256) {
      const model = input['model'];
      session = { id, external: true, settings: { cwd: input['cwd'], model, approvalPolicy: 'never' }, baseline: { model, effort: null }, policy: runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: model }, this.catalog), prompt: null, turn: null, items: [], complete: false, epoch: 'native-wire', tokens: null, window: null, controller: null, commands: new Map() };
      this.sessions.set(id, session);
    }
    if (!session?.external) return this.nativeHook(input, signal);
    if (event === 'PostCompact') { delete session.compact; delete session.cacheInput; session.epoch = randomUUID(); session.modelCache?.clear(); delete session.cache; }
    if (event === 'UserPromptSubmit' && typeof input['prompt'] === 'string') {
      if (session.wirePending) session.complete = false;
      session.items = session.items.map(({ clientId: _previousPrompt, ...item }) => item);
      session.controller?.abort(); session.controller = new AbortController();
      session.prompt = typeof input['turn_id'] === 'string' && input['turn_id'] !== session.prompt ? input['turn_id'] : randomUUID();
      session.turn = session.prompt; session.task = input['prompt']; session.eligible = true;
      if (session.completedReply) session.previousReply = session.completedReply; else delete session.previousReply;
      delete session.routePending; delete session.routeDeadline;
      delete session.routed; delete session.route;
      delete session.rootRoutes; delete session.rootInput; delete session.rootNativeChanged;
    }
    if (event === 'Interrupt' || event === 'SessionEnd') {
      session.controller?.abort(); await this.interruptChildren(session, event === 'SessionEnd');
      if (event === 'SessionEnd') { this.sessions.delete(id); this.hooked.delete(id); }
      return {};
    }
    const result = await this.nativeHook(input, signal);
    if (event === 'Stop') session.turn = null;
    return result;
  }

  /** Select optional tool text from the actual wire only; no transcript or history file is edited. */
  async compactRequest(id: string, request: Obj, signal: AbortSignal, path: 'inference' | 'native', billing: CodexBilling = 'unknown', nativeRequest: Obj = request): Promise<{ request: Obj; receipt?: CompactReceipt }> {
    const session = this.sessions.get(id);
    if (!session?.prompt || !session.task || !this.hooked.has(id) || requestedUpdateEffort(request).present) return { request };
    const prompt = session.prompt; const controller = session.controller;
    const config = runtimeCodexPolicy(this.env, this.catalog);
    const key = compactScope(nativeRequest, session.task, prompt) + JSON.stringify([config.compact, billing]);
    const state = session.compact?.key === key ? session.compact : newCompactState(key);
    session.compact = state;
    try { return await prepareCodexCompact({ request, task: session.task, recentRequests: session.recentRequests ?? [], state,
      session: id, prompt, config: config.compact, jevModel: config.gate.jevModel, env: this.env, path, billing,
      ...(session.cacheInput?.epoch === session.epoch && session.cacheInput.billing === billing ? { previous: session.cacheInput.shape } : {}),
      signal: controller ? AbortSignal.any([signal, controller.signal]) : signal,
      current: () => this.sessions.get(id) === session && session.prompt === prompt && session.compact === state && JSON.stringify(runtimeCodexPolicy(this.env, this.catalog).compact) === JSON.stringify(config.compact),
      ...(this.trace ? { trace: this.trace } : {}), ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
    } catch {
      // An optional context optimization must never turn a valid native request into a gateway error.
      try { this.trace?.write('codex_compact', { host: 'codex', session_id: id, prompt_id: prompt, path, stage: 'prepared', reason: 'internal_error', applied: false, sent: false }); } catch { /* Optional metadata. */ }
      return { request };
    }
  }
  recordCompact(id: string, receipt: CompactReceipt, stage: 'submitted' | 'result', facts: Obj): void {
    try { this.trace?.write('codex_compact', { host: 'codex', session_id: id, ...receipt, stage, ...facts }); } catch { /* Optional metadata. */ }
  }

  /** The original contract is judged once; observable tool continuations may get their own bounded decision. */
  async externalRequest(id: string, request: Obj, signal: AbortSignal, originator?: unknown, billing: CodexBilling = 'unknown'): Promise<{ request: Obj; preRouted?: boolean }> {
    const session = this.sessions.get(id);
    if (requestedUpdateEffort(request).present) {
      this.trace?.write('codex_router_skipped', { host: 'codex', session_id: id, prompt_id: session?.prompt ?? null, reason: 'configuration_update_native_history', known_not_sent: true, effective_effort: 'unknown' });
      return { request }; // Preserve opaque native updates, their positions and top-level values.
    }
    if (session?.role && session.dispatch) return this.workerRequest(session, request, signal, billing);
    // App Server has already applied this route in turn/start. A wire delta cannot prove it.
    if (session && !session.external && !session.role) return { request, preRouted: this.managedExecution(session, request, signal) };
    if (!session?.external || !session.prompt || !session.task || !this.hooked.has(id)) return { request };
    const requestPrompt = session.prompt;
    session.requestKind = 'root_response';
    const requestController = session.controller;
    const source = wireSource(request['input'], session.task, requestPrompt);
    // Capture completed context before replacing the previous source with current-turn wire items.
    if (session.routed !== session.prompt && !session.routePending) {
      const current = source.items.findIndex(i => i['type'] === 'userMessage' && i['clientId'] === session.prompt);
      const prefix = current >= 0 ? source.items.slice(0, current) : [];
      const prior = prefix.findLast(i => i['type'] === 'agentMessage' && ['final', 'final_answer'].includes(String(i['phase'])) && typeof i['text'] === 'string');
      if (!session.previousReply && prior) session.previousReply = String(prior['text']);
    }
    session.items = source.items; session.complete = source.complete && !request['previous_response_id'];
    if (session.complete && Array.isArray(request['input'])) session.wire = request['input']; else delete session.wire;
    const model = request['model']; const effort = obj(request['reasoning'])?.['effort'];
    if (typeof model !== 'string') return { request };
    const cachePolicy = request['prompt_cache_options'] !== undefined || request['prompt_cache_retention'] !== undefined ? [request['prompt_cache_options'], request['prompt_cache_retention']] : undefined;
    const key = createHash('sha256').update(JSON.stringify([session.epoch, requestStepKey(request)])).digest('hex');
    if (session.routed !== session.prompt && !session.routePending) {
      session.baseline = { model, effort: typeof effort === 'string' ? effort : null };
      session.rootInput = key;
      session.rootRoutes = new Map([[key, { index: 0, ...session.baseline, patch: {} }]]);
      const prompt = session.prompt;
      session.routed = prompt;
      session.routeDeadline = Date.now() + session.policy.router.timeoutMs;
      const deadline = session.routeDeadline;
      const task = session.task; const previousReply = session.previousReply; const baseline = { ...session.baseline };
      // #282: no request field tells `-m`/`-c model_reasoning_effort` from configuration defaults, so a scripted
      // `codex exec` caller (Codex's own originator header) keeps both. An interactive `--model` stays a baseline.
      const pinned = originator === 'codex_exec';
      const pending = (async () => {
        await this.waitCatalog(deadline);
        const epoch = this.catalogEpoch;
        const config = runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: model }, this.catalog);
        session.policy = config; session.routeConfig = JSON.stringify(config.router);
        const remaining = deadline - Date.now();
        if (remaining <= 0) { if (session.prompt === prompt) session.routed = prompt; return; }
        // Host control modes are not raw Responses API efforts.
        const catalog = this.catalog.map(m => { const out = { ...m, supportedReasoningEfforts: m.supportedReasoningEfforts.filter(e => !['ultra', 'ultracode', 'auto', 'ultrafast'].includes(e.reasoningEffort)) };
          if (out.defaultReasoningEffort && !out.supportedReasoningEfforts.some(e => e.reasoningEffort === out.defaultReasoningEffort)) delete out.defaultReasoningEffort; return out; });
        const patch = await routeCodex({ ...baseline, task, ...(previousReply ? { previousReply } : {}), modelPinned: pinned, effortPinned: pinned,
          billing, serviceTier: request['service_tier'], cachePolicy,
          recentRequests: session.recentRequests ?? [], session: id, prompt, ...(session.modelCache ? { modelCache: session.modelCache, epoch: session.epoch } : {}), catalog, catalogComplete: this.catalogComplete, catalogExcluded: this.catalogExcluded,
          ...(session.cache ? { cache: { ...session.cache, ageMs: Math.max(0, Date.now() - session.cache.at) } } : {}),
          config: { ...config, router: { ...config.router, timeoutMs: remaining } }, env: this.env,
          ...(this.trace ? { trace: this.trace } : {}), signal: requestController ? AbortSignal.any([signal, requestController.signal]) : signal,
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
        if (!signal.aborted && !requestController?.signal.aborted && session.prompt === prompt && this.catalogEpoch === epoch) { session.route = patch; session.routed = prompt; }
      })().finally(() => { if (session.routePending === pending) delete session.routePending; });
      session.routePending = pending;
    }
    if (session.routePending) await session.routePending;
    if (signal.aborted || requestController?.signal.aborted || session.prompt !== requestPrompt) throw new Error('interrupted policy');
    if (key !== session.rootInput) return this.rootContinuation(session, request, signal, originator, billing, cachePolicy);
    const current = runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: model }, this.catalog);
    if (session.routeConfig !== JSON.stringify(current.router)) delete session.route;
    const nativeEffort = typeof effort === 'string' ? effort : null;
    // A plugin-applied value is not a manual edit. A genuinely new native value wins for this turn.
    if (model !== session.baseline.model && model !== session.route?.model || nativeEffort !== session.baseline.effort && nativeEffort !== session.route?.effort && !(session.route?.effortEdit?.kind === 'omit' && nativeEffort === null)) {
      delete session.route; session.rootNativeChanged = true;
    }
    if (session.route?.model && (!codexTargetAllowed(session.route.model, current.router.allowAstra) || !this.catalog.some(m => m.model === session.route!.model && generalCodexModel(m)))) delete session.route;
    const reasoning = applyEffort(obj(request['reasoning']) ?? {}, session.route?.effortEdit);
    const selected = { ...request, ...(session.route?.model ? { model: session.route.model } : {}), ...(session.route?.effortEdit && session.route.effortEdit.kind !== 'keep' ? { reasoning } : {}) };
    const first = session.rootRoutes?.get(key); if (first) first.patch = session.route ?? {};
    return { request: selected };
  }
  private managedExecution(session: Session, request: Obj, signal: AbortSignal): boolean {
    const receipt = session.managedRoute, patch = session.route;
    if (!receipt || !patch) return false;
    const config = runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: session.baseline.model }, this.catalog);
    const model = patch.model ?? session.baseline.model;
    const effort = patch.effortEdit?.kind === 'omit' ? null : patch.effort ?? session.baseline.effort;
    const nativeEffort = obj(request['reasoning'])?.['effort'] ?? null;
    if (signal.aborted || session.controller?.signal.aborted || session.terminal || !session.eligible ||
      this.env['JEV_CODEX_ENABLED'] === '0' || receipt.prompt !== session.prompt ||
      receipt.catalogEpoch !== this.catalogEpoch ||
      receipt.config !== JSON.stringify(config.router) || request['model'] !== model || nativeEffort !== effort) {
      delete session.managedRoute;
      return false;
    }
    return model !== session.baseline.model || effort !== session.baseline.effort;
  }
  private async rootContinuation(session: Session, request: Obj, signal: AbortSignal, originator: unknown, billing: CodexBilling, cachePolicy: unknown): Promise<{ request: Obj }> {
    const model = String(request['model']), effort = obj(request['reasoning'])?.['effort'];
    const nativeEffort = typeof effort === 'string' ? effort : null;
    const prompt = session.prompt!, controller = session.controller, sourceEpoch = session.epoch;
    const key = createHash('sha256').update(JSON.stringify([sourceEpoch, requestStepKey(request)])).digest('hex');
    const steps = session.rootRoutes!;
    const nativePair = (s: { model: string; effort: string | null }): boolean => model === s.model && nativeEffort === s.effort;
    const selectedPair = (s: InferenceRoute): boolean => nativePair({ model: s.patch.model ?? s.model, effort: s.patch.effortEdit?.kind === 'omit' ? null : s.patch.effort ?? s.effort });
    if (!nativePair(session.baseline) && ![...steps.values()].some(selectedPair)) session.rootNativeChanged = true;
    let step = steps.get(key);
    if (!step) {
      // Keep retry identities for the entire prompt; never evict one into another paid judgment.
      if (steps.size >= 128) {
        this.trace?.write('codex_router_skipped', { host: 'codex', session_id: session.id, prompt_id: prompt, scope: 'root', index: null, reason: 'root_step_limit', known_not_sent: true });
        return { request };
      }
      const config = runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: model }, this.catalog), epoch = this.catalogEpoch;
      const compatible = !session.rootNativeChanged && session.routeConfig === JSON.stringify(config.router);
      // The first decision covers the whole contract. Never carry a next-inference-only patch into another step.
      step = { index: steps.size, model, effort: nativeEffort, patch: compatible ? session.route ?? {} : {},
        config: JSON.stringify(config.router), catalogEpoch: epoch, settingsEpoch: session.settingsEpoch ?? 0 };
      steps.set(key, step);
      const context = !request['previous_response_id'] ? rootStepContext(request['input'], session.task!) : null;
      if (compatible && context) {
        const owned = step, task = session.task!, pinned = originator === 'codex_exec';
        owned.pending = (async () => {
          const catalog = this.catalog.map(m => ({ ...m, supportedReasoningEfforts: m.supportedReasoningEfforts.filter(e => !['ultra', 'ultracode', 'auto', 'ultrafast'].includes(e.reasoningEffort)) }));
          const patch = await routeCodex({ model, effort: nativeEffort, task, session: session.id, prompt,
            modelPinned: pinned, effortPinned: pinned, billing, serviceTier: request['service_tier'], cachePolicy,
            ...(session.previousReply ? { previousReply: session.previousReply } : {}), recentRequests: session.recentRequests ?? [], continuation: { step: owned.index, context },
            catalog, catalogComplete: this.catalogComplete, catalogExcluded: this.catalogExcluded, config, env: this.env,
            epoch: sourceEpoch, ...(session.modelCache ? { modelCache: session.modelCache } : {}),
            ...(session.cache ? { cache: { ...session.cache, ageMs: Math.max(0, Date.now() - session.cache.at) } } : {}),
            ...(this.trace ? { trace: this.trace } : {}), signal: controller ? AbortSignal.any([signal, controller.signal]) : signal,
            ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
          if (!signal.aborted && !controller?.signal.aborted && session.prompt === prompt && session.epoch === sourceEpoch && this.sessions.get(session.id) === session && this.catalogEpoch === epoch) owned.patch = patch;
        })().catch(() => { owned.patch = {}; }).finally(() => { delete owned.pending; });
      } else this.trace?.write('codex_router_skipped', { host: 'codex', session_id: session.id, prompt_id: prompt, scope: 'root', index: step.index, reason: 'root_continuation_context_unavailable', known_not_sent: true });
    }
    if (step.pending) await step.pending;
    if (signal.aborted || controller?.signal.aborted || session.prompt !== prompt || session.epoch !== sourceEpoch || this.sessions.get(session.id) !== session) throw new Error('interrupted policy');
    const current = runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: model }, this.catalog);
    const target = step.patch.model ?? model, candidate = codexCandidates(this.catalog, current.router.allowAstra, model).find(c => c.id === target);
    const selectedEffort = step.patch.effortEdit?.kind === 'omit' ? null : step.patch.effort ?? nativeEffort;
    const valid = !session.rootNativeChanged && (nativePair(step) || selectedPair(step)) &&
      this.env['JEV_CODEX_ENABLED'] !== '0' && current.router.enabled && step.config === JSON.stringify(current.router) &&
      step.catalogEpoch === this.catalogEpoch && step.settingsEpoch === (session.settingsEpoch ?? 0) && candidate &&
      (!step.patch.model || codexTargetAllowed(target, current.router.allowAstra) && this.catalog.some(m => m.model === target && generalCodexModel(m)) &&
        providerContextLimit('codex', target) !== null && Buffer.byteLength(JSON.stringify(request)) <= providerContextLimit('codex', target)!) &&
      (selectedEffort === null ? candidate.omitEffort : candidate.efforts.includes(selectedEffort));
    if (!valid) step.patch = {};
    const reasoning = applyEffort(obj(request['reasoning']) ?? {}, step.patch.effortEdit);
    return { request: { ...request, ...(step.patch.model ? { model: step.patch.model } : {}), ...(step.patch.effortEdit && step.patch.effortEdit.kind !== 'keep' ? { reasoning } : {}) } };
  }
  /** Gate B owns the first inference; each new observed native continuation gets one batched decision. */
  private async workerRequest(session: Session, request: Obj, signal: AbortSignal, billing: CodexBilling): Promise<{ request: Obj }> {
    const d = session.dispatch!;
    if (d.ended || session.controller?.signal.aborted || signal.aborted || typeof request['model'] !== 'string') return { request };
    const model = request['model'], effort = obj(request['reasoning'])?.['effort'];
    const nativeEffort = typeof effort === 'string' ? effort : null;
    const cachePolicy = request['prompt_cache_options'] !== undefined || request['prompt_cache_retention'] !== undefined ? [request['prompt_cache_options'], request['prompt_cache_retention']] : undefined;
    const key = createHash('sha256').update(JSON.stringify([session.epoch, requestStepKey(request)])).digest('hex');
    const steps = session.stepRoutes ??= new Map();
    let step = steps.get(key);
    if (!step) {
      // Never evict identities into another paid assessment. A filled execution stays native.
      if (steps.size >= 128) {
        this.trace?.write('codex_router_skipped', { host: 'codex', session_id: session.id, prompt_id: session.prompt, scope: 'child', agent_id: session.id, index: null, reason: 'child_step_limit', known_not_sent: true });
        return { request };
      }
      step = { index: session.stepIndex === undefined ? 0 : session.stepIndex + 1, model, effort: nativeEffort, patch: {} }; steps.set(key, step); session.stepIndex = step.index;
      if (step.index > 0) {
        const context = workerStepContext(request['input']);
        const opaque = !!request['previous_response_id'] || Array.isArray(request['input']) && request['input'].some((raw: unknown) => { const item = obj(raw); return item?.['type'] === 'reasoning' && typeof item['encrypted_content'] === 'string'; });
        if (context && context.pending === 0 && typeof d.input['prompt'] === 'string') {
          const owned = step;
          const epoch = this.catalogEpoch, sourceEpoch = session.epoch;
          owned.pending = (async () => {
            const config = runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: model }, this.catalog);
            owned.config = JSON.stringify(config.router); owned.catalogEpoch = epoch; owned.settingsEpoch = session.settingsEpoch ?? 0;
            const catalog = this.catalog.map(m => ({ ...m, supportedReasoningEfforts: m.supportedReasoningEfforts.filter(e => !['ultra', 'ultracode', 'auto', 'ultrafast'].includes(e.reasoningEffort)) }));
            const bound = Buffer.byteLength(JSON.stringify(request));
            const patch = await routeCodex({ model, effort: nativeEffort, task: d.input['prompt'] as string, session: session.id, prompt: session.prompt ?? d.prompt,
              billing, serviceTier: request['service_tier'], cachePolicy,
              child: { agentId: session.id, step: owned.index, context }, catalog, catalogComplete: this.catalogComplete, config: opaque ? { ...config, router: { ...config.router, model: false } } : config, env: this.env,
              epoch: session.epoch, ...(session.modelCache ? { modelCache: session.modelCache } : {}),
              ...(session.cache ? { cache: { ...session.cache, ageMs: Math.max(0, Date.now() - session.cache.at) } } : {}),
              ...(this.trace ? { trace: this.trace } : {}), signal: AbortSignal.any([signal, d.signal]), ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
            // Exact owner, catalog and source epoch must still match after HTTP; permissions stay native.
            const target = patch.model;
            if (!d.ended && !signal.aborted && !d.signal.aborted && this.sessions.get(session.id) === session && this.catalogEpoch === epoch && session.epoch === sourceEpoch &&
              (!target || providerContextLimit('codex', target) !== null && bound <= providerContextLimit('codex', target)! && this.catalog.some(m => m.model === target && generalCodexModel(m)) && codexTargetAllowed(target, config.router.allowAstra))) owned.patch = patch;
          })().catch(() => undefined).finally(() => { delete owned.pending; });
        } else this.trace?.write('codex_router_skipped', { host: 'codex', session_id: session.id, prompt_id: session.prompt, scope: 'child', agent_id: session.id, index: step.index, reason: 'child_context_unavailable', known_not_sent: true });
      }
    }
    if (step.pending) await step.pending;
    if (signal.aborted || d.signal.aborted || d.ended || session.controller?.signal.aborted || this.sessions.get(session.id) !== session || model !== step.model || nativeEffort !== step.effort) return { request };
    if (Object.keys(step.patch).length) {
      const current = runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: model }, this.catalog);
      const target = step.patch.model ?? model;
      const candidate = codexCandidates(this.catalog, current.router.allowAstra, model).find(c => c.id === target);
      const selectedEffort = step.patch.effortEdit?.kind === 'omit' ? null : step.patch.effort ?? nativeEffort;
      const valid = this.env['JEV_CODEX_ENABLED'] !== '0' && current.router.enabled && step.config === JSON.stringify(current.router) &&
        step.catalogEpoch === this.catalogEpoch && step.settingsEpoch === (session.settingsEpoch ?? 0) && candidate &&
        (!step.patch.model || codexTargetAllowed(target, current.router.allowAstra) && this.catalog.some(m => m.model === target && generalCodexModel(m)) &&
          providerContextLimit('codex', target) !== null && Buffer.byteLength(JSON.stringify(request)) <= providerContextLimit('codex', target)!) &&
        (selectedEffort === null ? candidate.omitEffort : !['ultra', 'ultracode', 'auto', 'ultrafast'].includes(selectedEffort) && candidate.efforts.includes(selectedEffort));
      if (!valid) {
        step.patch = {};
        this.trace?.write('codex_router_skipped', { host: 'codex', session_id: session.id, prompt_id: session.prompt, scope: 'child', agent_id: session.id, index: step.index, reason: 'child_pair_changed_before_submission', known_not_sent: false });
      }
    }
    session.requestKind = 'child_response'; session.route = step.patch;
    session.baseline = { model, effort: nativeEffort };
    const reasoning = applyEffort(obj(request['reasoning']) ?? {}, step.patch.effortEdit);
    return { request: { ...request, ...(step.patch.model ? { model: step.patch.model } : {}), ...(step.patch.effortEdit && step.patch.effortEdit.kind !== 'keep' ? { reasoning } : {}) } };
  }
  observeRequestFailure(id: string, submitted: CodexSubmission | undefined, failure?: CodexRequestFailure): void {
    if (!submitted) return;
    this.trace?.write('codex_model_failure', { host: 'codex', session_id: id, prompt_id: submitted.prompt, request_id: submitted.requestId, reason: failure?.stage === 'eof' ? 'response_terminal_not_observed' : 'host_request_failed', ...(failure?.stage === 'eof' ? { usage: null } : {}), ...(failure ? { failure_stage: failure.stage, elapsed_ms: failure.elapsed_ms, ...(failure.status !== undefined ? { http_status: failure.status } : {}) } : {}) });
  }
  observeRequestCancellation(id: string, submitted: CodexSubmission | undefined): void {
    if (!submitted) return;
    this.trace?.write('codex_model_cancelled', { host: 'codex', session_id: id, prompt_id: submitted.prompt, request_id: submitted.requestId, reason: 'client_disconnected', usage: null });
  }
  observeUsage(id: string, response: Obj, submitted?: CodexSubmission): void {
    const session = this.sessions.get(id); const input = obj(response['usage'])?.['input_tokens'];
    const binding = submitted; // A later response is never joined to the nearest submission.
    if (!binding) {
      const model = typeof response['model'] === 'string' ? response['model'] : null;
      const usage = normalizeUsage('codex', response['usage']);
      const tier = typeof response['service_tier'] === 'string' ? response['service_tier'] : null;
      this.trace?.write('codex_router_response', { host: 'codex', session_id: id, prompt_id: null, request_id: null, scope: 'unknown',
        response_id: typeof response['id'] === 'string' ? response['id'] : null, observed_model: model, observed_effort: 'unknown', effective_effort: 'unknown',
        usage, cost: usageCost(usage, model && usage.write === 0 ? providerPrice('codex', model, typeof input === 'number' ? input : null, tier) : null),
        reason: 'request_identity_unknown', subscription_cost: 'unknown' });
    }
    if (binding) {
      const model = typeof response['model'] === 'string' ? response['model'] : null;
      const effort = obj(response['reasoning'])?.['effort'];
      const usage = normalizeUsage('codex', response['usage']);
      // The static API table establishes default writes only. Do not price extended/mixed policies as default.
      const price = binding.defaultCachePolicy || usage.write === 0 ? providerPrice('codex', model ?? binding.model, typeof input === 'number' ? input : null, typeof response['service_tier'] === 'string' ? response['service_tier'] : null) : null;
      if (binding.scope === 'child' && binding.index === 0 && model === binding.model && usage.coverage === 'complete' && typeof input === 'number' && price?.write !== undefined) {
        const previous = this.workerStarts.get(model);
        this.workerStarts.set(model, { range: [Math.min(previous?.range[0] ?? input, input), Math.max(previous?.range[1] ?? input, input)], writeRate: price.write });
        while (this.workerStarts.size > 16) this.workerStarts.delete(this.workerStarts.keys().next().value!);
      }
      if (session && binding.prompt === session.prompt && binding.epoch === session.epoch && session.lastSubmitted?.requestId === binding.requestId && model === binding.model) {
        if (binding.cacheInput && response['status'] === 'completed' && usage.coverage === 'complete') session.cacheInput = { shape: binding.cacheInput, epoch: binding.epoch, billing: binding.billing };
        session.cache = { model, input: usage.input, read: usage.read, write: usage.write, ageMs: 0, at: Date.now(), source: 'provider_response_usage' };
        (session.modelCache ??= new ModelCache()).observe({ model, epoch: session.epoch, at: Date.now(), input: usage.input, ttlIsMinimum: true, ttlMs: binding.billing === 'api' && binding.defaultCachePolicy && usage.write !== null && usage.write > 0 ? 1_800_000 : null, read: usage.read, write: usage.write, output: usage.output });
      }
      this.trace?.write('codex_router_response', { host: 'codex', session_id: id, prompt_id: binding.prompt, request_id: binding.requestId, stage: 'response',
        scope: binding.scope, agent_id: binding.scope === 'child' ? id : null, parent_session_id: binding.parent, index: binding.index,
        selected_model: binding.model, selected_effort: binding.effort, submitted_effort: binding.effort, observed_model: model, observed_effort: typeof effort === 'string' ? effort : 'unknown',
        response_id: typeof response['id'] === 'string' ? response['id'] : null, cache_diagnostics: cacheDiagnostics(response['prompt_cache_diagnostics']), usage, cost: usageCost(usage, price), provider_reported_cost: typeof response['cost_usd'] === 'number' && Number.isFinite(response['cost_usd']) && response['cost_usd'] >= 0 ? response['cost_usd'] : null, billing: binding.billing, subscription_cost: 'unknown', service_tier: response['service_tier'] ?? null, effective_effort: 'unknown',
        reason: model === null ? 'response_unconfirmed' : model !== binding.model ? 'mismatch' : 'response_model_confirmed' });
    }
    if (session?.external && binding && binding.prompt === session.prompt && binding.epoch === session.epoch && session.lastSubmitted?.requestId === binding.requestId) {
      session.tokens = Number.isSafeInteger(input) && Number(input) >= 0 ? Number(input) : null;
      if (session.wire && session.task && session.prompt && Array.isArray(response['output'])) {
        const source = wireSource([...session.wire, ...response['output']], session.task, session.prompt);
        session.wirePending = !source.complete;
        // A just-issued current-turn tool call leaves the source pending; a subsequent prompt must not use it.
        if (source.complete) { session.items = source.items; session.complete = true;
          if (response['status'] === 'completed' && !response['output'].some((i: unknown) => ['function_call', 'custom_tool_call'].includes(String(obj(i)?.['type'])))) {
            const final = wireSource(response['output'], '', '').items.findLast(i => i['type'] === 'agentMessage' && i['phase'] !== 'commentary' && typeof i['text'] === 'string');
            if (final) session.completedReply = String(final['text']);
          }
        }
      } else session.complete = false;
    }
  }
  async dispatch(arguments_: unknown, meta: unknown): Promise<string> {
    const caller = codexCallerWorkspace(meta); const session = caller && this.sessions.get(caller.session);
    if (!caller || !session?.external) return 'No connected native root. No worker was started.';
    try { if (realpathSync(String(session.settings['cwd'])) !== realpathSync(caller.cwd)) return 'Native workspace changed. No worker was started.'; }
    catch { return 'Native workspace unavailable. No worker was started.'; }
    return this.agent({ threadId: caller.session, callId: obj(meta)?.['callId'] ?? randomUUID(), arguments: arguments_, nativeMeta: meta });
  }
  /** #287: a thrown dispatch is recorded where it is caught, by a closed category; the exception can carry paths, prompts or host payloads. */
  failedDispatch(session: unknown, e: unknown): string {
    const category = e instanceof RpcRequestError ? `rpc_${e.kind}` : (e as Error | null)?.name === 'AbortError' ? 'aborted' : (e as Error | null)?.name === 'TimeoutError' ? 'timeout' : 'exception';
    this.trace?.write('failure', { host: 'codex', ...(typeof session === 'string' ? { session_id: session } : {}), tool_name: 'jev_agent', error_first_line: `dispatch_${category}`, dispatch_failure: category });
    return DISPATCH_FAILED;
  }
  cancelCaller(meta: unknown): void {
    const caller = codexCallerWorkspace(meta); const session = caller && this.sessions.get(caller.session);
    if (session?.external) { session.controller?.abort(); void this.interruptChildren(session); }
  }
  private async hydrate(id: string): Promise<void> {
    const session = this.sessions.get(id)!;
    try {
      const items: Obj[] = []; let cursor: unknown = null;
      for (let page = 0; page < 100; page++) {
        const r = await this.rpc.request('thread/items/list', { threadId: id, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(r['data'])) return;
        items.push(...r['data'].flatMap((e: unknown) => obj(obj(e)?.['item']) ? [obj(obj(e)?.['item'])!] : []));
        if (Buffer.byteLength(JSON.stringify(items)) > 8 * 1024 * 1024) return;
        cursor = r['nextCursor']; if (!cursor) { session.items = items; session.complete = !items.some(i => i['type'] === 'contextCompaction'); return; }
      }
    } catch { /* Resume without a complete source still supports native execution. */ }
  }
  private hook(session: Session, input: HookInput, signal?: AbortSignal): ReturnType<typeof runHook> {
    const host: NonNullable<HookDeps['host']> = {
      id: 'codex', config: session.policy.gate, compactWindow: session.window,
      depth: () => session.tokens === null ? { ok: false, reason: 'depth_unknown', bytesRead: 0, durationMs: 0 }
        : { ok: true, tokens: session.tokens, model: session.requestModel ?? String(session.settings['model'] ?? session.baseline.model), modelSwitched: false, bytesRead: 0, durationMs: 0 },
      terminal: id => !!this.sessions.get(id)?.dispatch?.ended,
      observation: id => { const worker = id ? this.sessions.get(id) : undefined; return worker ? codexObservation(worker.items, worker.complete, worker.commands) : null; },
    };
    return runHook({ stdin: (async function* () { yield JSON.stringify(input); })(), env: this.env, host,
      delegationPrices: () => session.tokens === null ? undefined : observedDelegationPrices('codex', session.requestModel ?? session.baseline.model, session.policy.gate.models.standard, session.tokens, this.workerStarts.get(session.policy.gate.models.standard) ?? null),
      allocation: { candidates: baseline => codexCandidates(this.catalog, session.policy.router.allowAstra, baseline).filter(c => codexTargetAllowed(c.id, session.policy.router.allowAstra)),
        allowed: model => this.catalog.some(m => m.model === model && generalCodexModel(m)) && codexTargetAllowed(model, session.policy.router.allowAstra), inheritedModel: session.requestModel ?? session.baseline.model },
      ...((signal || session.controller) ? { signal: signal && session.controller ? AbortSignal.any([signal, session.controller.signal]) : signal ?? session.controller!.signal } : {}), ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
  }
  async client(message: Obj): Promise<void> {
    const method = message['method']; const params = obj(message['params']) ?? {};
    if (method === 'initialize') {
      this.rpc.forward({ ...message, params: { ...params, capabilities: { ...(obj(params['capabilities']) ?? {}), experimentalApi: true } } }); return;
    }
    if (['thread/start', 'thread/fork', 'thread/resume'].includes(String(method))) {
      const hookConfig = await this.hookConfig(String(params['cwd'] ?? process.cwd()), obj(params['config']) ?? {});
      const tools = Array.isArray(params['dynamicTools']) ? params['dynamicTools'] : [];
      if (tools.some(t => obj(t)?.['name'] === 'jev_agent')) throw new Error('jev_agent already registered');
      const instructions = typeof params['developerInstructions'] === 'string' ? params['developerInstructions'] + '\n\n' : '';
      this.rpc.forward({ ...message, params: { ...params, config: { ...(obj(params['config']) ?? {}), ...hookConfig }, dynamicTools: [...tools, AGENT_TOOL], developerInstructions: instructions + 'If Jev Gate guidance asks for an Agent dispatch, call jev_agent with that owned profile as subagent_type and the task as prompt. Do not substitute native spawn_agent or implement an admitted contract in the root. Jev failures keep native execution available. Native permissions and user constraints remain authoritative.' } }); return;
    }
    const session = this.sessions.get(String(params['threadId']));
    if (session && method === 'turn/interrupt') { session.controller?.abort(); await this.interruptChildren(session); }
    if (session && method === 'turn/start' && Array.isArray(params['input']) && params['input'].length) {
      // An active turn is steering, not a fresh policy generation. Preserve that host contract.
      if (session.turn) { this.rpc.forward(message); return; }
      if (session.starting && params['clientUserMessageId'] === session.starting.prompt) {
        if ('id' in message) this.rpc.emit({ id: message['id'], error: { code: -32800, message: 'This turn is already being prepared. No duplicate turn started.' } });
        return;
      }
      // Codex runs SessionStart when the first turn starts, not when thread/start returns.
      session.controller?.abort(); session.controller = new AbortController();
      const controller = session.controller;
      const prompt = typeof params['clientUserMessageId'] === 'string' ? params['clientUserMessageId'] : randomUUID();
      const starting = { prompt, controller }; session.starting = starting;
      try {
      session.prompt = prompt; session.terminal = false; delete session.turnReply; session.requestKind = 'root_response';
      delete session.route; delete session.managedRoute;
      const deadline = Date.now() + session.policy.router.timeoutMs;
      const collaboration = obj(params['collaborationMode']);
      const modeSettings = obj(collaboration?.['settings']);
      const selectedModel = typeof modeSettings?.['model'] === 'string' ? modeSettings['model'] : typeof params['model'] === 'string' ? params['model'] : session.baseline.model;
      const selectedEffort = modeSettings && 'reasoning_effort' in modeSettings ? modeSettings['reasoning_effort'] : 'effort' in params ? params['effort'] : session.baseline.effort;
      session.baseline = { model: selectedModel, effort: typeof selectedEffort === 'string' ? selectedEffort : null };
      const baseline = { ...session.baseline };
      session.policy = runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: session.baseline.model }, this.catalog);
      const task = textInput(params['input']);
      session.eligible = task !== null;
      if (task !== null) session.task = task;
      // Non-text and malformed input is preserved. No image or attachment is silently dropped to enable Jev.
      if (task === null || this.env['JEV_CODEX_ENABLED'] === '0' || collaboration && collaboration['mode'] !== 'default') { session.eligible = false; this.rpc.forward(message); return; }
      await this.waitCatalog(deadline);
      session.policy = runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: session.baseline.model }, this.catalog);
      const previousReply = session.completedReply;
      const recentRequests = selectRecentPrompts(session.items.filter(i => i['type'] === 'userMessage').flatMap(i => { const t = textInput(i['content']); return t ? [t] : []; }));
      session.recentRequests = recentRequests;
      const catalogEpoch = this.catalogEpoch;
      const patch = Date.now() >= deadline ? {} : await routeCodex({ model: session.baseline.model, effort: session.baseline.effort,
        task, recentRequests, catalogComplete: this.catalogComplete, catalogExcluded: this.catalogExcluded, ...(typeof previousReply === 'string' ? { previousReply } : {}), session: session.id, prompt, catalog: this.catalog, config: { ...session.policy, router: { ...session.policy.router, timeoutMs: Math.max(1, deadline - Date.now()) } }, env: this.env,
        ...(session.cache ? { cache: { ...session.cache, ageMs: Math.max(0, Date.now() - session.cache.at) } } : {}),
        ...(this.trace ? { trace: this.trace } : {}), signal: controller.signal, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
      if (controller.signal.aborted || session.controller !== controller || session.prompt !== prompt) {
        if ('id' in message) this.rpc.emit({ id: message['id'], error: { code: -32800, message: 'Turn interrupted before Jev policy completed.' } });
        return;
      }
      const current = runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: session.baseline.model }, this.catalog);
      if (session.baseline.model !== baseline.model || session.baseline.effort !== baseline.effort) {
        delete session.route;
        const ownerEffort = session.baseline.effort === null ? { kind: 'omit' as const } : { kind: 'set' as const, value: session.baseline.effort };
        this.rpc.forward({ ...message, params: { ...applyEffort({ ...params, model: session.baseline.model }, ownerEffort),
          ...(collaboration && modeSettings ? { collaborationMode: { ...collaboration, settings: applyEffort({ ...modeSettings, model: session.baseline.model }, ownerEffort, 'reasoning_effort') } } : {}), clientUserMessageId: prompt } });
        return;
      }
      if (this.catalogEpoch !== catalogEpoch || JSON.stringify(current.router) !== JSON.stringify(session.policy.router) || Date.now() >= deadline) { this.rpc.forward({ ...message, params: { ...params, clientUserMessageId: prompt } }); return; }
      session.route = patch;
      session.managedRoute = { prompt, config: JSON.stringify(current.router), catalogEpoch };
      // The hook gets the exact submitted request later, from Codex itself. Its policy uses the assigned client id.
      const routedParams = applyEffort({ ...params, ...(patch.model ? { model: patch.model } : {}) }, patch.effortEdit);
      this.rpc.forward({ ...message, params: { ...routedParams,
        ...(collaboration && modeSettings ? { collaborationMode: { ...collaboration, settings: applyEffort({ ...modeSettings, ...(patch.model ? { model: patch.model } : {}) }, patch.effortEdit, 'reasoning_effort') } } : {}), clientUserMessageId: prompt } }); return;
      } finally { if (session.starting === starting) delete session.starting; }
    }
    this.rpc.forward(message);
  }
  private notification(message: Obj): void {
    if (['account/updated', 'account/login/completed'].includes(String(message['method']))) {
      for (const session of this.sessions.values()) {
        session.epoch = randomUUID(); delete session.cacheInput; delete session.compact;
        session.modelCache?.clear(); delete session.cache; delete session.route;
        session.stepRoutes?.forEach(step => { step.patch = {}; });
        session.rootNativeChanged = true;
      }
      this.catalogReady = this.loadCatalog();
    }
    const p = obj(message['params']) ?? {}; const session = this.sessions.get(String(p['threadId']));
    if (!session) return;
    if (message['method'] === 'thread/settings/updated') {
      const settings = obj(p['threadSettings']);
      if (settings) {
        session.settingsEpoch = (session.settingsEpoch ?? 0) + 1;
        session.settings = { ...session.settings, ...settings };
      }
    }
    if (message['method'] === 'turn/started' && !session.terminal) {
      session.turn = String(obj(p['turn'])?.['id'] ?? '');
      if (session.dispatch) { this.persistWorkerTurn(session); if (session.dispatch.signal.aborted) this.interruptWorker(session); }
    }
    if (message['method'] === 'thread/tokenUsage/updated') {
      const usage = obj(p['tokenUsage']); const last = obj(usage?.['last']);
      session.tokens = typeof last?.['inputTokens'] === 'number' ? last['inputTokens'] : null;
      session.window = typeof usage?.['modelContextWindow'] === 'number' ? usage['modelContextWindow'] : null;
      if (session.turn && p['turnId'] === session.turn && !session.parent) {
        const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
        session.cache = { model: session.route?.model ?? session.baseline.model, input: count(last?.['inputTokens']), read: count(last?.['cachedInputTokens']), write: null, ageMs: 0, at: Date.now(), source: 'host_usage' };
      }
    }
    if (message['method'] === 'item/started' || message['method'] === 'item/completed') {
      const item = obj(p['item']); if (!item) return;
      if (message['method'] === 'item/completed' && item['type'] === 'agentMessage' && item['phase'] !== 'commentary' && typeof item['text'] === 'string' && p['turnId'] === session.turn) session.turnReply = item['text'];
      const ix = session.items.findIndex(i => i['id'] === item['id']);
      if (ix < 0) session.items.push(item); else session.items[ix] = item;
      if (Buffer.byteLength(JSON.stringify(session.items)) > 8 * 1024 * 1024) { session.complete = false; session.items = session.items.slice(-100); }
      if (item['type'] === 'contextCompaction') { session.complete = false; session.epoch = String(item['id']); delete session.cacheInput; delete session.compact; session.tokens = null; session.modelCache?.clear(); delete session.cache; session.stepRoutes?.forEach(v => { v.patch = {}; }); }
    }
    if (message['method'] === 'turn/completed') {
      const turn = obj(p['turn']) ?? {};
      if (session.dispatch && (session.dispatch.ended || session.turn && turn['id'] !== session.turn || !['completed', 'interrupted', 'failed'].includes(String(turn['status'])))) return;
      session.turn = null; session.terminal = true;
      if (!session.parent && turn['status'] === 'completed') {
        if (session.turnReply) session.completedReply = session.turnReply; else delete session.completedReply;
      }
      if (session.dispatch) { session.dispatch.ended = turn; session.done?.(turn); void this.settleWorker(session).catch(() => undefined); }
      else session.done?.(turn);
      if (!session.parent && turn['status'] !== 'completed') { session.controller?.abort(); void this.interruptChildren(session); }
    }
  }
  /** Called only by this session's authenticated native hook. The host still owns permissions and execution. */
  async nativeHook(input: Obj, signal?: AbortSignal): Promise<Obj> {
    if (signal?.aborted) return {};
    if (input['hook_event_name'] === 'SessionStart' && typeof input['session_id'] === 'string') this.hooked.add(input['session_id']);
    const session = this.sessions.get(String(input['session_id']));
    if (!session) return {};
    const event = input['hook_event_name'];
    const emitDeny = (reason: string, text: string, metadata: Obj = {}): Obj => {
      this.trace?.write('dispatch_denied', { host: 'codex', session_id: session.id, prompt_id: session.prompt,
        caller: { agent_id: input['agent_id'] ?? null, agent_type: session.role ?? null }, tool_use_id: input['tool_use_id'] ?? null,
        tool_name: input['tool_name'] ?? null, reason, ...metadata });
      return deny(text);
    };
    await this.retrySettlements();
    if (!session.role) await this.settleOrphans(session);
    if (event === 'PreToolUse' && input['tool_name'] === 'Bash' && typeof input['tool_use_id'] === 'string' && typeof obj(input['tool_input'])?.['command'] === 'string') {
      session.commands.set(input['tool_use_id'], String(obj(input['tool_input'])!['command']));
    }
    if (this.env['JEV_CODEX_ENABLED'] === '0') return {};
    if (session.role) {
      if (event === 'PreToolUse') {
        const name = String(input['tool_name']);
        if (/^(Agent|spawn_agent|send_input|SendMessage|jev_agent)$/.test(name)) return emitDeny('owned_child_dispatch', 'Jev owned workers cannot create or coordinate child agents.');
      }
      return {};
    }
    if (!session.prompt || session.eligible === false || !['UserPromptSubmit', 'PreToolUse', 'Stop'].includes(String(event))) return {};
    const normalized: HookInput = { hook_event_name: String(event), session_id: session.id, prompt_id: session.prompt, cwd: String(session.settings['cwd']),
      ...(typeof input['prompt'] === 'string' ? { prompt: input['prompt'] } : {}),
      ...(typeof input['tool_name'] === 'string' ? { tool_name: input['tool_name'] } : {}),
      ...(typeof input['tool_use_id'] === 'string' ? { tool_use_id: input['tool_use_id'] } : {}), ...(input['tool_input'] ? { tool_input: input['tool_input'] } : {}) };
    // This custom tool owns its execution and consumes the patch in-process. Never return native updatedInput/allow.
    if (event === 'PreToolUse' && (normalized.tool_name === 'jev_agent' || normalized.tool_name?.endsWith('__jev_agent'))) return {};
    if (event === 'UserPromptSubmit' && typeof input['prompt'] === 'string') {
      session.recentRequests = selectRecentPrompts(session.requests ?? []);
      session.requests = selectRecentPrompts([...(session.requests ?? []), input['prompt']]);
    }
    const result = await this.hook(session, normalized, signal);
    if (signal?.aborted || !result.stdout) return {};
    const output = obj(JSON.parse(result.stdout)) ?? {};
    if (result.kind === 'patch') return {}; // Only jev_agent consumes input replacements.
    // Shared coordinator guidance is host neutral. Rewriting the whole context would alter functional worker text.
    return output;
  }
  private async interruptChildren(parent: Session, includeBackground = false): Promise<void> {
    await Promise.all([...this.sessions.values()].filter(s => s.parent === parent.id && s.turn && (includeBackground || !s.dispatch?.background)).map(async s => {
      try { if (s.dispatch) this.interruptWorker(s); else await this.rpc.request('turn/interrupt', { threadId: s.id, turnId: s.turn }, 1000); } catch { /* No terminal event means no successful release. */ }
    }));
  }
  private async hookConfig(cwd: string, overrides: Obj = {}): Promise<Obj> {
    if (this.env['JEV_CODEX_ENABLED'] === '0') return {};
    const listed = await this.rpc.request('hooks/list', { cwds: [cwd] });
    const loaded = await this.rpc.request('config/read', { includeLayers: false, cwd });
    const inherited = { ...(obj(obj(obj(loaded['config'])?.['hooks'])?.['state']) ?? {}), ...(obj(obj(overrides['hooks'])?.['state']) ?? {}), ...(obj(overrides['hooks.state']) ?? {}) };
    const hooks = Array.isArray(listed['data']) ? listed['data'].flatMap(e => Array.isArray(obj(e)?.['hooks']) ? obj(e)!['hooks'] as Obj[] : []) : [];
    const jev = hooks.filter(h => h['source'] === 'plugin' && String(h['pluginId']).startsWith('jev-gate@') && h['enabled'] === true && obj(inherited[String(h['key'])])?.['enabled'] !== false);
    if (new Set(jev.map(h => h['pluginId'])).size > 1) throw new Error('Enable only one Jev Gate installation in Codex /plugins before connecting.');
    for (const event of ['sessionStart', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop']) {
      if (jev.filter(h => h['eventName'] === event && (this.bypassHookTrust || ['trusted', 'managed'].includes(String(h['trustStatus'])))).length !== 1) {
        throw new Error('Trust and enable the installed Jev Gate hooks in native Codex /hooks, then restart this session.');
      }
    }
    if (!this.bypassHookTrust) return {};
    // This grant is scoped to this process and only exists when the user explicitly passes Codex's trust bypass flag.
    const state = Object.fromEntries(jev.filter(h => h['enabled'] === true && obj(inherited[String(h['key'])])?.['enabled'] !== false).map(h => {
      // Native hooks/list now combines declaration/content hashes, but config
      // still stores them separately. Older hosts return only the declaration.
      const hash = h['currentHash'];
      const hashes = typeof hash === 'string' && /^sha256:[a-f0-9]{64}\/sha256:[a-f0-9]{64}$/.test(hash) ? hash.split('/') : null;
      return [String(h['key']), { ...(obj(inherited[String(h['key'])]) ?? {}), trusted_hash: hashes?.[0] ?? hash, ...(hashes ? { trusted_content_hash: hashes[1] } : {}) }];
    }));
    return { 'hooks.state': { ...inherited, ...state } };
  }
  private async agent(p: Obj): Promise<string> {
    const session = this.sessions.get(String(p['threadId'])); const original = obj(p['arguments']);
    if (session && !session.role && original && (original['action'] === 'status' || original['action'] === 'cancel')) {
      if (Object.keys(original).some(k => !['action', 'agent_id'].includes(k)) || typeof original['agent_id'] !== 'string') return 'Invalid background operation.';
      const id = original['agent_id']; const worker = this.sessions.get(id);
      const result = this.backgroundResults.get(id);
      if (!worker?.dispatch || worker.parent !== session.id) {
        if (result?.parent !== session.id) await this.settleOrphans(session, original['action'] === 'cancel' ? id : undefined);
        const settled = this.backgroundResults.get(id);
        return settled?.parent === session.id ? settled.output : this.heldElsewhere(session.id, id) ?? 'No owned execution with this identity.';
      }
      if (original['action'] === 'cancel') { this.interruptWorker(worker); return 'Cancellation requested. Acceptance and release still require an observed terminal event.'; }
      if (!worker.dispatch.ended) await this.collectWorkerTurn(worker, 1000);
      return worker.dispatch.ended ? this.settleWorker(worker) : `${worker.dispatch.unconfirmed ?? 'Worker execution is unconfirmed: no native terminal result or acceptance has been observed. Collection failure does not establish execution failure. Answer the user here; do not duplicate its work.'} Reservation ${worker.id}: ${worker.dispatch.pendingReason ?? 'terminal_not_observed'}.`;
    }
    if (!session || session.role || session.eligible === false || this.env['JEV_CODEX_ENABLED'] === '0' || !session.prompt || !session.controller || session.controller.signal.aborted || !original) return 'No active root Jev job.';
    if (typeof original['subagent_type'] !== 'string' || !this.profiles[original['subagent_type']] || typeof original['prompt'] !== 'string' || original['run_in_background'] !== undefined && typeof original['run_in_background'] !== 'boolean' || Object.keys(original).some(k => !['subagent_type', 'prompt', 'description', 'model', 'run_in_background'].includes(k))) return `Invalid owned Agent input. Pass subagent_type (one of ${Object.keys(this.profiles).join(', ')}) and prompt (the task); optional: description, model, run_in_background. action is only status|cancel with agent_id.`;
    const background = original['run_in_background'] !== false;
    const parentSignal = session.controller.signal;
    const parent: Session = { ...session, settings: { ...session.settings }, controller: null };
    const state = readJob(this.env, session.id);
    const promptId = state.ok && state.value?.current.background_job && state.value.current.outcome === null ? state.value.current.prompt_id ?? session.prompt : session.prompt;
    const conversationPrompt = session.prompt;
    const toolId = String(p['callId']);
    const input = { ...original, run_in_background: background };
    const dispatchEpoch = this.catalogEpoch;
    const dispatchConfig = JSON.stringify(runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: parent.requestModel ?? parent.baseline.model }, this.catalog).router);
    const pre = await this.hook(parent, { hook_event_name: 'PreToolUse', session_id: parent.id, prompt_id: promptId, tool_name: 'Agent', tool_use_id: toolId, tool_input: input, cwd: String(parent.settings['cwd']) }, parentSignal);
    if (pre.kind === 'deny') return codexGuidance(String(obj(obj(JSON.parse(pre.stdout))?.['hookSpecificOutput'])?.['permissionDecisionReason'] ?? 'Dispatch denied'));
    if (parentSignal.aborted || session.prompt !== conversationPrompt) { await this.failure(parent, promptId, toolId, input, preflight('cancelled'), 'dispatch_cancelled'); return 'Dispatch cancelled; no worker started.'; }
    const updated = pre.kind === 'patch' ? obj(obj(JSON.parse(pre.stdout))?.['hookSpecificOutput'])?.['updatedInput'] : input;
    const applied = obj(updated); if (!applied) return 'Dispatch input unavailable.';
    const role = String(applied['subagent_type']); const profile = OWNED_AGENTS[role];
    const model = typeof applied['model'] === 'string' ? applied['model'] : parent.policy.gate.models[profile?.tier ?? 'standard'];
    if (!this.catalog.some(m => m.model === model)) { await this.failure(parent, promptId, toolId, applied, preflight('allocation_unavailable'), 'requested_model_unavailable'); return 'The requested worker model is absent from Codex model/list. Native execution remains available; configure accessible tier models.'; }
    let cwd = String(parent.settings['cwd']); let worktree: WorkerWorktree | null = null;
    let worker: Session | null = null;
    let dispatch: WorkerDispatch | undefined;
    // The stage in progress when anything below throws; the exception itself is never reported.
    let failed = preflight('permissions_unavailable');
    const t0 = Date.now();
    try {
      const captured = parent.external ? capturedPermissions(p['nativeMeta']) : null;
      if (parent.external && !captured) throw new Error('parent permissions unavailable');
      if (applied['isolation'] === 'worktree') {
        failed = preflight('worktree_unavailable');
        const root = parent.external ? join(cwd, '.jev-gate-worktrees') : join(stateRoot(this.env), 'jev-gate', 'worktrees');
        if (!parent.external) mkdirSync(root, { recursive: true, mode: 0o700 });
        if (parent.external) {
          const added = spawnSync('codex', ['sandbox', '--sandbox-state-json', JSON.stringify(obj(p['nativeMeta'])?.['codex/sandbox-state-meta']), '--', process.execPath, fileURLToPath(new URL('./worktree.mjs', import.meta.url)), '--codex', cwd, root], { cwd, env: safeGitEnv(this.env), encoding: 'utf8', timeout: 120_000 });
          if (added.status !== 0) throw new Error('worktree unavailable');
          worktree = JSON.parse(added.stdout) as WorkerWorktree;
        } else worktree = createWorkerWorktree(cwd, root, this.env);
        cwd = worktree.path;
      }
      const sandbox = obj(parent.settings['sandboxPolicy']);
      const permissions = obj(parent.settings['activePermissionProfile'])?.['id'];
      const customPermissions = typeof permissions === 'string' && !permissions.startsWith(':');
      failed = preflight('permissions_unavailable');
      if (parent.external ? !captured : typeof permissions !== 'string' && !['dangerFullAccess', 'readOnly', 'workspaceWrite'].includes(String(sandbox?.['type']))) throw new Error('parent permissions unavailable');
      failed = preflight('allocation_unavailable');
      const currentPolicy = runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: parent.requestModel ?? parent.baseline.model }, this.catalog);
      if (this.catalogEpoch !== dispatchEpoch || JSON.stringify(currentPolicy.router) !== dispatchConfig || !codexTargetAllowed(model, currentPolicy.router.allowAstra) || !this.catalog.some(m => m.model === model && generalCodexModel(m))) {
        updateJob(this.env, parent.id, prev => {
          const r = prev ? own(prev.current.active, toolId) : undefined;
          if (!prev || !r || r.codex_execution || r.background_execution?.agent_id) return null;
          const { [toolId]: _removed, ...active } = prev.current.active;
          return { ...prev, current: { ...prev.current, active, root_fallback: true, root_fallback_reason: 'delivery_failed', background_context: 'No eligible automatic child model. Continue in the main session; no child started.' } };
        });
        throw new Error('automatic child unavailable');
      }
      failed = { category: 'native_start_rejected', stage: 'thread_start', not_executed: true };
      const hooks = await this.hookConfig(cwd);
      // Native ephemeral threads reject thread/read(includeTurns). Use native history so
      // status can recover this exact turn after a missed completion notification.
      const child = await this.rpc.request('thread/start', { model, modelProvider: parent.settings['modelProvider'], cwd, ephemeral: false,
        approvalPolicy: parent.settings['approvalPolicy'], approvalsReviewer: parent.settings['approvalsReviewer'],
        ...(captured ? { permissions: captured.permissions } : typeof permissions === 'string' ? { permissions } : { sandbox: sandbox?.['type'] === 'dangerFullAccess' ? 'danger-full-access' : sandbox?.['type'] === 'readOnly' ? 'read-only' : 'workspace-write' }),
        developerInstructions: this.profiles[role], config: { 'features.multi_agent': false, ...captured?.config, ...hooks }, dynamicTools: [] });
      await this.response(child, 'thread/start', {});
      worker = this.sessions.get(String(obj(child['thread'])?.['id'])) ?? null;
      if (!worker) throw new Error('worker unavailable');
      worker.role = role; worker.parent = session.id; worker.prompt = promptId;
      const terminal = new Promise<Obj>(resolve => { worker!.done = resolve; });
      dispatch = { parent, prompt: promptId, tool: toolId, input: { ...applied }, signal: background ? new AbortController().signal : parentSignal, worktree, startedAt: t0, attempted: false, background };
      worker.dispatch = dispatch;
      failed = preflight('cancelled');
      if (parentSignal.aborted || session.prompt !== conversationPrompt) throw new Error('cancelled');
      failed = preflight('allocation_unavailable');
      const pairState = readJob(this.env, parent.id);
      const pair = pairState.ok ? own(pairState.value?.current.active ?? {}, toolId)?.allocation_pair : null;
      const desired = pair?.effort_edit.kind === 'set' ? pair.effort_edit.value : OWNED_AGENT_PROFILES.find(p => p.name === role)?.effort ?? parent.requestEffort ?? parent.settings['effort'];
      const offered = this.catalog.find(m => m.model === model)?.supportedReasoningEfforts.map(e => e.reasoningEffort) ?? [];
      const effort = pair?.effort_edit.kind === 'omit' ? null : typeof desired === 'string' && offered.includes(desired) ? desired : typeof parent.baseline.effort === 'string' && offered.includes(parent.baseline.effort) ? parent.baseline.effort : null;
      if (this.catalogEpoch !== dispatchEpoch || JSON.stringify(runtimeCodexPolicy({ ...this.env, JEV_CODEX_MODEL: parent.requestModel ?? parent.baseline.model }, this.catalog).router) !== dispatchConfig || pair?.effort_edit.kind === 'set' && effort !== pair.effort_edit.value) throw new Error('allocated pair unavailable before turn/start');
      // Reserve before execution to prevent another managed dispatch over the same files.
      let registered = false;
      failed = { category: 'reservation_unavailable', stage: 'reservation', not_executed: true };
      const saved = updateJob(this.env, parent.id, prev => {
        const r = prev?.current.prompt_id === promptId ? own(prev.current.active, toolId) : undefined;
        if (!prev || !r) return null;
        if (this.writeConflict(String(parent.settings['cwd']), r.deliverables)) { failed = { category: 'preflight_conflict', stage: 'reservation', not_executed: true }; throw new Error('worker write conflict'); }
        registered = true;
        return { ...prev, current: { ...pendingBackgroundPolicy(prev.current), ...(background ? { background_job: true as const } : {}), active: { ...prev.current.active, [toolId]: { ...r, codex_execution: { thread_id: worker!.id, turn_id: null, cwd, root_cwd: String(parent.settings['cwd']), ...(this.hostPid ? { host_pid: this.hostPid } : {}) } } } } };
      }, { refuseUnreadable: true });
      if (!saved.ok || !registered) throw new Error('execution reservation unavailable');
      failed = { category: 'native_start_rejected', stage: 'turn_start', not_executed: true };
      const cancel = (): void => this.interruptWorker(worker!);
      dispatch.cancel = cancel;
      if (!background) parentSignal.addEventListener('abort', cancel, { once: true });
      try {
        dispatch.attempted = true;
        try {
          const turn = await this.rpc.request('turn/start', { threadId: worker.id, input: [{ type: 'text', text: String(applied['prompt']), text_elements: [] }], model,
            ...(effort ? { effort } : {}),
            ...(sandbox && !customPermissions && (typeof permissions !== 'string' || worktree) ? { sandboxPolicy: worktree && sandbox['type'] === 'workspaceWrite' ? { ...sandbox, writableRoots: [cwd] } : sandbox } : {}) });
          if (!worker.terminal) { worker.turn = String(obj(turn['turn'])?.['id'] ?? worker.turn ?? ''); this.persistWorkerTurn(worker); }
        } catch (error) {
          if (error instanceof RpcRequestError && !error.attempted && !worker.turn && !dispatch.ended) { dispatch.attempted = false; throw error; }
          if (!dispatch.ended) await this.recoverWorker(worker, terminal);
          if (!dispatch.ended) return this.unconfirmed(worker, 'turn_start');
        }
        if (background && !dispatch.ended) {
          this.trace?.write('background_launch', { host: 'codex', session_id: parent.id, prompt_id: promptId, tool_use_id: toolId, agent_id: worker.id, status: 'running', role: profile?.role ?? null });
          return `Worker started in the background. Internal execution identity: ${worker.id}. This is a launch receipt, not a completed result. Answer new user messages in the main session while it works; do not duplicate its files or work. Use jev_agent with action=status and agent_id to collect its result without waiting. Use action=cancel only for explicit user cancellation.`;
        }
        if (!background && parentSignal.aborted) cancel();
        if (!dispatch.ended) {
          const ended = await terminal;
          if (ended['localClose']) return this.unconfirmed(worker, 'turn');
        }
        return await this.settleWorker(worker);
      } finally {
        // Keep cancellation and terminal ownership while an uncertain execution still exists.
        if (dispatch.settled || !dispatch.attempted) parentSignal.removeEventListener('abort', cancel);
      }
    } catch {
      if (dispatch?.attempted) return this.unconfirmed(worker!, 'turn');
      if (worker && dispatch) {
        // Definite pre-send failure is non-execution evidence, even if its first state write fails.
        dispatch.failure = failed; dispatch.ended = { status: 'failed', notExecuted: true };
        return await this.settleWorker(worker);
      }
      await this.failure(parent, promptId, toolId, applied, failed, failed.category, t0);
      if (worker) await this.cleanupWorker(worker);
      return `${failureHead(failed)}. ${FAILURE_ADVICE[failed.category]} Its files are preserved. No completion or acceptance is claimed.`;
    }
  }
  private persistWorkerTurn(worker: Session): void {
    const d = worker.dispatch; if (!d) return;
    updateJob(this.env, d.parent.id, prev => {
      if (!prev) return null;
      const change = (g: import('../types.js').JobGeneration) => {
        const r = own(g.active, d.tool);
        return g.prompt_id === d.prompt && r?.codex_execution?.thread_id === worker.id
          ? { ...g, active: { ...g.active, [d.tool]: { ...r, codex_execution: { ...r.codex_execution, turn_id: worker.turn } } } } : g;
      };
      return { ...prev, current: change(prev.current), history: prev.history.map(change) };
    }, { refuseUnreadable: true });
  }
  private interruptWorker(worker: Session, timeoutMs = 1000): void {
    const d = worker.dispatch;
    if (!d || d.ended || d.interruptSent || !worker.turn) return;
    d.interruptSent = true;
    void this.rpc.request('turn/interrupt', { threadId: worker.id, turnId: worker.turn }, timeoutMs).catch(() => undefined);
  }
  private async recoverWorker(worker: Session, terminal: Promise<Obj>): Promise<void> {
    const deadline = Date.now() + 1000;
    const left = () => Math.max(1, deadline - Date.now());
    // Read only the exact known turn; never infer a latest turn when start identity is unknown.
    if (worker.turn && !worker.dispatch?.ended) await this.collectWorkerTurn(worker, left());
    if (worker.dispatch?.ended || Date.now() >= deadline) return;
    this.interruptWorker(worker, left());
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([terminal, new Promise<void>(resolve => { timer = setTimeout(resolve, left()); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  /** Status collection shares start recovery's exact native turn lookup, without interrupting a live worker. */
  private async collectWorkerTurn(worker: Session, timeoutMs: number): Promise<void> {
    const d = worker.dispatch; if (!d || d.ended) return;
    if (!worker.turn) { d.pendingReason = 'turn_identity_unavailable'; return; }
    try {
      const read = await this.rpc.request('thread/read', { threadId: worker.id, includeTurns: true }, timeoutMs);
      if (d.ended) return;
      const thread = obj(read['thread']); const turns = thread?.['turns'];
      const turn = thread?.['id'] === worker.id && Array.isArray(turns) ? turns.map(obj).find(t => t?.['id'] === worker.turn && ['completed', 'interrupted', 'failed'].includes(String(t['status']))) : null;
      if (!turn) { d.pendingReason = 'terminal_not_observed'; return; }
      if (Array.isArray(turn['items'])) for (const item of turn['items']) this.notification({ method: 'item/completed', params: { threadId: worker.id, turnId: worker.turn, item } });
      delete d.pendingReason;
      this.notification({ method: 'turn/completed', params: { threadId: worker.id, turn } });
    } catch (error) {
      if (!d.ended) {
        d.pendingReason = `collection_${error instanceof RpcRequestError ? `rpc_${error.kind}` : 'exception'}`;
        this.trace?.write('failure', { host: 'codex', session_id: d.parent.id, prompt_id: d.prompt,
          tool_use_id: d.tool, agent_id: worker.id, error_first_line: d.pendingReason, release_unconfirmed: true });
      }
    }
  }
  private async settleWorker(worker: Session): Promise<string> {
    const d = worker.dispatch;
    if (!d?.ended) return 'Worker termination unconfirmed.';
    if (d.settled) return d.output ?? 'Worker already settled.';
    if (d.settling) return d.settling;
    d.settling = (async () => {
      const texts = worker.items.filter(i => i['type'] === 'agentMessage' && typeof i['text'] === 'string');
      const final = texts.filter(i => i['phase'] === 'final_answer').at(-1) ?? texts.at(-1);
      const status = d.ended!['status'];
      const failure: CodexFailure | null = status === 'completed' ? null : d.failure ?? { category: status === 'interrupted' ? 'interrupted' : 'native_failed_turn', stage: 'turn', not_executed: false };
      let report = String(final?.['text'] ?? '');
      if (!failure && d.worktree) {
        const status = spawnSync('git', ['status', '--porcelain'], { cwd: d.worktree.path, env: safeGitEnv(this.env), encoding: 'utf8', timeout: 10_000 });
        if (status.status !== 0 || status.stdout.trim()) {
          const parsed = parseWorkerReply(report);
          if (parsed.ok) report = JSON.stringify({ ...parsed.value, status: 'blocked', blockers: [...parsed.value.blockers, 'Isolated worker edits are uncommitted or could not be inspected. Commit the worker changes on its worktree branch before applying the baseline-to-branch diff.'] });
        }
      }
      const response = { status: 'completed', agentId: worker.id, resolvedModel: worker.requestModel ?? worker.settings['model'], content: [{ type: 'text', text: report }], totalDurationMs: Date.now() - d.startedAt };
      const post = !failure
        ? await this.hook(d.parent, { hook_event_name: 'PostToolUse', session_id: d.parent.id, prompt_id: d.prompt, tool_name: 'Agent', tool_use_id: d.tool, tool_input: d.input, tool_response: response, cwd: String(d.parent.settings['cwd']) })
        : await this.failure(d.parent, d.prompt, d.tool, d.input, failure, failure.category, d.startedAt);
      if (post.code) d.pendingReason = post.code; else delete d.pendingReason;
      if (d.worktree) updateJob(this.env, d.parent.id, prev => {
        if (!prev) return null;
        const change = (g: import('../types.js').JobGeneration) => g.prompt_id === d.prompt ? { ...g, receipts: g.receipts.map(r => r.tool_use_id === d.tool ? { ...r, worker_worktree: d.worktree! } : r) } : g;
        return { ...prev, current: change(prev.current), history: prev.history.map(change) };
      });
      const state = readJob(this.env, d.parent.id);
      const gen = state.ok && state.value ? [state.value.current, ...state.value.history].find(g => g.prompt_id === d.prompt) : null;
      const receipt = gen?.receipts.find(r => r.tool_use_id === d.tool);
      const committed = receipt !== undefined;
      if (!gen || own(gen.active, d.tool) || !committed) {
        d.pendingReason ??= !state.ok ? state.code : !gen ? 'generation_unavailable' : own(gen.active, d.tool) ? 'reservation_active' : 'receipt_uncommitted';
        this.trace?.write('failure', { host: 'codex', session_id: d.parent.id, prompt_id: d.prompt, tool_use_id: d.tool, agent_id: worker.id,
          reservation_id: worker.id, error_first_line: 'settlement_pending', settlement_reason: d.pendingReason, release_unconfirmed: true });
        return `${failure ? failureHead(failure) : 'Worker terminal observed'}; settlement pending. Internal execution identity: ${worker.id}. Reservation ${worker.id}: ${d.pendingReason}. Reservation and files remain protected. Retry jev_agent with action=status and agent_id=${worker.id} without restarting execution.`;
      }
      d.output = !failure
        ? renderWorkerDelivery(receipt!, { single: gen.execution === 'single', rootFallback: !!gen.root_fallback,
          ...(gen.root_fallback_reason === 'accepted' || gen.root_fallback_reason === 'attempt_cap' ? { rootFallbackReason: gen.root_fallback_reason } : {}) })
        : `${failureHead(failure)}. ${FAILURE_ADVICE[failure.category]} No completion or acceptance is claimed.`;
      d.settled = true;
      // An uncertain foreground call also needs its terminal output available by the returned identity.
      this.backgroundResults.set(worker.id, { parent: d.parent.id, output: d.output });
      while (this.backgroundResults.size > 64) this.backgroundResults.delete(this.backgroundResults.keys().next().value!);
      if (d.background) {
        // Replayed coordinator context uses the stored positional report, never raw check commands or invalid JSON.
        const context = d.output!;
        updateJob(this.env, d.parent.id, prev => prev?.current.prompt_id === d.prompt ? { ...prev, current: { ...pendingBackgroundPolicy(prev.current), background_context: context, ...(d.interruptSent && d.ended!['status'] !== 'completed' && Object.keys(prev.current.active).length === 0 ? { outcome: 'incomplete' as const } : {}) } } : null);
        this.trace?.write('background_terminal', { host: 'codex', session_id: d.parent.id, prompt_id: d.prompt, tool_use_id: d.tool, agent_id: worker.id, status: String(d.ended!['status']),
          ...(failure ? { failure_category: failure.category, failure_stage: failure.stage, not_executed: failure.not_executed } : {}) });
      }
      if (d.cancel) d.signal.removeEventListener('abort', d.cancel);
      await this.cleanupWorker(worker);
      return d.output;
    })();
    try { return await d.settling; } finally { delete d.settling; }
  }
  /**
   * #239: settles this session's reservations whose app-server has exited, and at an explicit cancel one written before
   * hosts were recorded. Settlement happens in the process that sees it; the original process kept only memory.
   */
  private async settleOrphans(session: Session, cancelled?: string): Promise<void> {
    const state = readJob(this.env, session.id);
    if (!state.ok || !state.value) return;
    for (const g of [state.value.current, ...state.value.history]) for (const [tool, r] of Object.entries(g.active)) {
      const e = r.codex_execution; const exited = hostExited(r);
      if (!e || g.prompt_id === null || this.settlingOrphans.has(e.thread_id) || !(exited || e.host_pid === undefined && e.thread_id === cancelled)) continue;
      this.settlingOrphans.add(e.thread_id);
      try {
        const f: CodexFailure = { category: 'interrupted', stage: 'turn', not_executed: false };
        await this.failure({ ...session, controller: null }, g.prompt_id, tool, { subagent_type: agentForTier(r.role, r.tier ?? 'standard') }, f, exited ? 'host_exited' : 'cancelled', Date.parse(r.started_at));
        const after = readJob(this.env, session.id);
        if (!after.ok || !after.value || [after.value.current, ...after.value.history].some(x => x.prompt_id === g.prompt_id && own(x.active, tool))) continue;
        const output = `${failureHead(f)}. ${exited ? 'Its Codex app-server exited, so it is no longer running.' : 'Released at explicit user cancellation; its earlier host was not recorded, so its end was not observed.'} Inspect its files before retrying. No completion or acceptance is claimed.`;
        this.backgroundResults.set(e.thread_id, { parent: session.id, output });
        while (this.backgroundResults.size > 64) this.backgroundResults.delete(this.backgroundResults.keys().next().value!);
        if (g.background_job) {
          updateJob(this.env, session.id, prev => prev?.current.prompt_id === g.prompt_id ? { ...prev, current: { ...pendingBackgroundPolicy(prev.current), background_context: output, ...(cancelled && Object.keys(prev.current.active).length === 0 ? { outcome: 'incomplete' as const } : {}) } } : null);
          this.trace?.write('background_terminal', { host: 'codex', session_id: session.id, prompt_id: g.prompt_id, tool_use_id: tool, agent_id: e.thread_id, status: 'interrupted',
            failure_category: f.category, failure_stage: f.stage, not_executed: false, host_exited: exited });
        }
      } finally { this.settlingOrphans.delete(e.thread_id); }
    }
  }
  /** #239: a durable reservation this process cannot observe or settle keeps protection; say why instead of denying it exists. */
  private heldElsewhere(session: string, id: string): string | null {
    const state = readJob(this.env, session);
    const e = state.ok && state.value ? [state.value.current, ...state.value.history].flatMap(g => Object.values(g.active)).find(r => r.codex_execution?.thread_id === id)?.codex_execution : undefined;
    if (!e) return null;
    return e.host_pid !== undefined
      ? 'The worker belongs to an earlier Codex app-server that is still running, so its result cannot be collected here. Its reservation prevents duplicate managed dispatches; native tools remain available.'
      : 'This worker was started by an earlier Jev Gate version that did not record its Codex host, so its end cannot be observed here. Its reservation prevents duplicate managed dispatches; native tools remain available. Only if the user explicitly cancels it, use action=cancel with this agent_id to release it.';
  }
  private async retrySettlements(): Promise<void> {
    await Promise.all([...this.sessions.values()].filter(s => s.dispatch?.ended && !s.dispatch.settled).map(s => this.settleWorker(s).catch(() => 'settlement pending')));
  }
  private async cleanupWorker(worker: Session): Promise<void> {
    // Observations remain accessible until receipt/state commit, above.
    this.sessions.delete(worker.id); this.hooked.delete(worker.id);
    try { await this.rpc.request('thread/archive', { threadId: worker.id }, 1000); } catch { /* Files are preserved. */ }
  }
  private writeConflict(cwd: string, deliverables: string[]): Reservation | undefined {
    const targets = deliverables.length ? deliverables.map(p => resolve(cwd, p)) : [cwd];
    return codexExecutions(this.env).find(r => {
      if (hostExited(r)) return false;
      const e = r.codex_execution!;
      // A worktree worker writes its deliverables in its own checkout and later into the root, so both copies are its scope.
      const bases = [...new Set([e.root_cwd, e.cwd])];
      return writesInto(targets, r.deliverables.length ? bases.flatMap(b => r.deliverables.map(q => resolve(b, q))) : bases);
    });
  }
  private failure(session: Session, prompt: string, tool: string, input: Obj, failure: CodexFailure, error: string = failure.category, startedAt?: number): ReturnType<typeof runHook> {
    return this.hook(session, { hook_event_name: 'PostToolUseFailure', session_id: session.id, prompt_id: prompt, tool_name: 'Agent', tool_use_id: tool, tool_input: input, error,
      codex_failure: failure, is_interrupt: failure.category === 'interrupted', ...(startedAt === undefined ? {} : { duration_ms: Date.now() - startedAt }) });
  }
  /** Possibly still running: recorded without PostToolUseFailure, whose release would drop write protection. */
  private unconfirmed(worker: Session, stage: CodexFailure['stage']): string {
    const d = worker.dispatch!; const f: CodexFailure = { category: 'termination_unconfirmed', stage, not_executed: false };
    this.trace?.write('failure', { host: 'codex', session_id: d.parent.id, prompt_id: d.prompt, tool_use_id: d.tool, agent_id: worker.id, subagent_type: String(d.input['subagent_type']),
      error_first_line: f.category, is_interrupt: false, duration_ms: Date.now() - d.startedAt, failure_category: f.category, failure_stage: stage, not_executed: false, release_unconfirmed: true });
    return d.unconfirmed = `${failureHead(f)}. Internal execution identity: ${worker.id}. ${FAILURE_ADVICE[f.category]} No completion or acceptance is claimed. Use jev_agent with action=status and agent_id=${worker.id} to collect its outcome without restarting execution.`;
  }
  hooksReady(session: string): boolean { return this.env['JEV_CODEX_ENABLED'] === '0' || this.hooked.has(session); }
  requestSession(metadata: unknown, affinity: unknown): string | null {
    if (typeof metadata === 'string') {
      try {
        const parsed = obj(JSON.parse(metadata));
        // Native memory extraction deliberately omits thread identity and shares
        // session affinity with its startup caller. Prewarm and future internal
        // operations likewise belong to Codex, not the root routing/cache state.
        const kind = parsed?.['request_kind'];
        if (kind !== undefined && kind !== 'turn' && kind !== 'compaction' || parsed?.['thread_source'] === 'memory_consolidation') return null;
        const id = parsed?.['thread_id'] ?? parsed?.['session_id'];
        if (typeof id === 'string' && this.sessions.has(id)) return id;
        // A native spawn_agent child carries the root's session-id; it never binds to root state.
        if (parsed?.['thread_source'] === 'subagent' || typeof parsed?.['parent_thread_id'] === 'string' && parsed['parent_thread_id'] !== id) return null;
      } catch { /* No invented identity. */ }
    }
    return typeof affinity === 'string' && this.sessions.has(affinity) ? affinity : null;
  }
  observeRequest(sessionId: string, request: Obj, billing: CodexBilling = 'unknown', routedInput?: Obj, transformation?: { native: Obj; guidance: boolean; compact?: CompactReceipt }): CodexSubmission | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Compact may rewrite the submitted history after Router selected this inference.
    // Bind its pre-Compact identity, but always report the actual submitted model/effort.
    const key = createHash('sha256').update(JSON.stringify([session.epoch, requestStepKey(routedInput ?? request)])).digest('hex');
    const step = (session.role ? session.stepRoutes : session.rootRoutes)?.get(key);
    const route = requestedUpdateEffort(request).present ? undefined : session.role || session.rootRoutes ? step?.patch : session.route;
    const baseline = step ?? session.baseline;
    const effort = obj(request['reasoning'])?.['effort'];
    if (typeof request['model'] === 'string') session.requestModel = request['model'];
    if (typeof effort === 'string') session.requestEffort = effort; else delete session.requestEffort;
    const submitted = { prompt: session.prompt, model: String(request['model']), effort: typeof effort === 'string' ? effort : null, requestId: randomUUID(), epoch: session.epoch, index: step?.index ?? null, scope: session.role ? 'child' as const : 'root' as const, parent: session.parent ?? null,
      defaultCachePolicy: request['prompt_cache_options'] === undefined && request['prompt_cache_retention'] === undefined, billing };
    const shape = requestShape(request);
    const binding: CodexSubmission = { ...submitted, ...(shape ? { cacheInput: shape } : {}) };
    session.lastSubmitted = binding;
    this.trace?.write('codex_model_request', { host: 'codex', session_id: session.id, prompt_id: session.prompt, request_id: submitted.requestId,
      requested_update_effort: requestedUpdateEffort(request).effort, effective_effort: 'unknown', effort_cache: 'native_configuration_update_unverified',
      context_epoch: submitted.epoch,
      ...(transformation ? { input_change: { ...requestChange(transformation.native, request), execution_guidance_added: transformation.guidance,
        compact_applied: transformation.compact?.applied ?? false, compact_receipt_id: transformation.compact?.request_id ?? null } } : {}),
      submitted_model: submitted.model, submitted_effort: submitted.effort, scope: session.role ? 'child' : 'root', agent_id: session.role ? session.id : null, parent_session_id: session.parent ?? null, index: submitted.index });
    if (!route || !Object.keys(route).length) return binding;
    const selectedModel = route.model ?? baseline.model;
    const selectedEffort = route.effortEdit?.kind === 'omit' ? null : route.effort ?? baseline.effort;
    // Ultra is a native host selection, resolved by the model to an inference effort.
    // Confirm the official host selection and observe its wire value; never rewrite it.
    const nativeUltra = selectedEffort === 'ultra' && session.settings['effort'] === 'ultra'
      && typeof effort === 'string' && effort !== 'ultra'
      && this.catalog.find(m => m.model === selectedModel)?.supportedReasoningEfforts.some(e => e.reasoningEffort === effort) === true;
    this.trace?.write('codex_route_applied', { host: 'codex', session_id: session.id, prompt_id: session.prompt, stage: 'submitted',
      request_id: submitted.requestId, scope: session.role ? 'child' : 'root', agent_id: session.role ? session.id : null, index: submitted.index, submitted_model: request['model'], submitted_effort: effort ?? null, observed_model: null, observed_effort: 'unknown', observed_host_effort: session.settings['effort'] ?? null,
      boundary: 'provider_request',
      selected_model: selectedModel, selected_effort: selectedEffort, effort_resolution: nativeUltra ? 'native_ultra' : 'direct',
      request_kind: session.requestKind ?? 'unknown',
      reason: 'request_applied', applied: request['model'] === selectedModel && (route.effortEdit?.kind === 'omit' ? effort === undefined : !route.effort || effort === selectedEffort || nativeUltra) });
    return binding;
  }
  close(): void { for (const s of this.sessions.values()) { s.controller?.abort(); s.done?.({localClose:true}); } }
}
