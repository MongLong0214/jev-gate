import { randomUUID } from 'node:crypto';
import { join, isAbsolute, resolve, relative } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkerWorktree, type WorkerWorktree } from '../worktree.js';
import { runHook, type HookDeps } from '../hook.js';
import { stateRoot, readJob, updateJob, own, codexExecutions } from '../job.js';
import { OWNED_AGENTS, LEAN_EXECUTOR_AGENT, type HookInput } from '../types.js';
import { OWNED_AGENT_PROFILES } from '../agents.js';
import type { Env } from '../config.js';
import { codexTraceDir } from '../codex-paths.js';
import { openTraceDir, type TraceWriter } from '../trace.js';
import { CodexRpc, RpcRequestError } from './rpc.js';
import { loadCodexPolicy, type CodexPolicyConfig } from './config.js';
import { codexSource, codexObservation, textInput, obj, type Obj } from './source.js';
import { AGENT_TOOL, CODEX_PROFILES, codexGuidance } from './profiles.js';
import { routeCodex, type CodexModel } from './router.js';
import { capturedPermissions } from './permissions.js';
import { codexCallerWorkspace } from './workspace.js';
import { selectRecentPrompts } from '../recent-prompts.js';
import { wireSource } from './wire.js';

interface WorkerDispatch {
  parent: Session; prompt: string; tool: string; input: Obj; signal: AbortSignal;
  worktree: WorkerWorktree | null; startedAt: number; attempted: boolean;
  ended?: Obj; settling?: Promise<string>; settled?: boolean; output?: string; interruptSent?: boolean; cancel?: () => void;
  background?: boolean;
}
interface Session {
  id: string; settings: Obj; baseline: { model: string; effort: string | null }; policy: CodexPolicyConfig;
  prompt: string | null; turn: string | null; items: Obj[]; complete: boolean; epoch: string;
  tokens: number | null; window: number | null; controller: AbortController | null;
  commands: Map<string, string>;
  requestModel?: string; requestEffort?: string;
  compactAllowed?: boolean; eligible?: boolean; terminal?: boolean;
  role?: string; parent?: string; done?: (turn: Obj) => void; route?: { model?: string; effort?: string };
  external?: boolean; task?: string; routed?: string; stop?: string;
  wire?: unknown[];
  wirePending?: boolean;
  requests?: string[];
  recentRequests?: string[];
  dispatch?: WorkerDispatch;
  lastCompactSummary?: string;
}
const contextOf = (result: { stdout: string | null }): string => {
  if (!result.stdout) return '';
  return String(obj(obj(JSON.parse(result.stdout))?.['hookSpecificOutput'])?.['additionalContext'] ?? '');
};
const deny = (reason: string): Obj => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const safeGitEnv = (env: Env): Env => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_')));

/** A Codex execution adapter over the existing Gate/Lean state machine. No policy decisions are delegated to prose. */
export class CodexPolicy {
  readonly sessions = new Map<string, Session>();
  catalog: CodexModel[] = [];
  private catalogReady: Promise<void> = Promise.resolve();
  private trace: TraceWriter | undefined;
  private env: Env;
  private hooked = new Set<string>();
  private compactPending = new Map<string, { summary: string; run: string; before: number; after: number }>();
  private backgroundResults = new Map<string, { parent: string; output: string }>();
  constructor(readonly rpc: CodexRpc, env: Env, private fetchImpl?: typeof fetch, private profiles = CODEX_PROFILES, private bypassHookTrust = false) {
    // Claude launch settings cannot pin or alter a Codex thread.
    this.env = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('CLAUDE_')));
    this.env['JEV_GATE_TRACE_DIR'] = codexTraceDir(env);
    this.env['JEV_GATE_STATE_DIR'] = join(stateRoot(env), 'codex');
    const trace = openTraceDir(this.env['JEV_GATE_TRACE_DIR'], this.env);
    if (trace.ok) this.trace = trace.writer;
    rpc.onResponse = (r, m, p) => this.response(r, m, p);
    rpc.onClose = () => this.close();
    rpc.onNotification = m => this.notification(m);
    rpc.onRequest = async m => {
      if (m['method'] !== 'item/tool/call' || obj(m['params'])?.['tool'] !== 'jev_agent') return false;
      const p = obj(m['params'])!;
      let output: string;
      try { output = await this.agent(p); }
      catch { output = 'Jev dispatch failed or was interrupted. No completion is claimed. Continue in the main session or inspect the current job.'; }
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
          policy: loadCodexPolicy({ ...this.env, JEV_CODEX_MODEL: result['model'] }, this.catalog), prompt: null, turn: null, items, complete: method === 'thread/start', epoch: 'initial', tokens: method === 'thread/start' ? 0 : null, window: null, controller: null, commands: new Map() });
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
        if (typeof params['model'] === 'string') session.baseline.model = params['model'];
        if (typeof params['effort'] === 'string' || params['effort'] === null) session.baseline.effort = params['effort'] as string | null;
      }
    }
    return result;
  }
  private async loadCatalog(): Promise<void> {
    try {
      const catalog: CodexModel[] = []; let cursor: unknown = null;
      const deadline = Date.now() + 3000;
      for (let page = 0; page < 20 && Date.now() < deadline; page++) {
        const r = await this.rpc.request('model/list', { ...(cursor ? { cursor } : {}), includeHidden: true }, Math.max(1, deadline - Date.now()));
        if (!Array.isArray(r['data'])) return;
        for (const m of r['data']) if (obj(m) && typeof m['model'] === 'string' && Array.isArray(m['supportedReasoningEfforts'])) catalog.push(m as CodexModel);
        cursor = r['nextCursor']; if (!cursor) { this.catalog = catalog; return; }
      }
    } catch { /* Unknown catalog preserves the original model and effort. */ }
  }
  async initialize(): Promise<void> { this.catalogReady = this.loadCatalog(); await this.catalogReady; }
  supplyKey(key: string): void { if (key.length > 0 && key.length <= 8192 && !/[\r\n\0]/.test(key)) this.env['TYPESAFE_API_KEY'] = key; }

  /** Native plugin hooks register ordinary app/CLI/IDE roots. The sidecar owns only its child App Server. */
  async externalHook(input: Obj, signal?: AbortSignal): Promise<Obj> {
    const id = input['session_id']; const event = input['hook_event_name'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) return {};
    let session = this.sessions.get(id);
    if (input['agent_id'] && (!session || session.external)) return {};
    if (!session && event === 'SessionStart' && typeof input['cwd'] === 'string' && isAbsolute(input['cwd']) && typeof input['model'] === 'string' && this.sessions.size < 256) {
      const model = input['model'];
      session = { id, external: true, settings: { cwd: input['cwd'], model, approvalPolicy: 'never' }, baseline: { model, effort: null }, policy: loadCodexPolicy({ ...this.env, JEV_CODEX_MODEL: model }, this.catalog), prompt: null, turn: null, items: [], complete: false, epoch: 'native-wire', tokens: null, window: null, controller: null, commands: new Map() };
      this.sessions.set(id, session);
    }
    if (!session?.external) return this.nativeHook(input, signal);
    if (event === 'UserPromptSubmit' && typeof input['prompt'] === 'string') {
      if (session.wirePending) session.complete = false;
      session.items = session.items.map(({ clientId: _previousPrompt, ...item }) => item);
      session.controller?.abort(); session.controller = new AbortController();
      session.prompt = typeof input['turn_id'] === 'string' && input['turn_id'] !== session.prompt ? input['turn_id'] : randomUUID();
      session.turn = session.prompt; session.task = input['prompt']; session.eligible = true;
      delete session.stop; delete session.routed; delete session.route;
    }
    if (event === 'Interrupt' || event === 'SessionEnd') {
      session.controller?.abort(); await this.interruptChildren(session, event === 'SessionEnd');
      if (event === 'SessionEnd') { this.sessions.delete(id); this.hooked.delete(id); this.compactPending.delete(id); }
      return {};
    }
    const result = await this.nativeHook(input, signal);
    if (event === 'Stop') session.turn = null;
    return result;
  }

  /** Selection is made once from the actual submitted prompt; every original Responses field is preserved. */
  async externalRequest(id: string, request: Obj, signal: AbortSignal): Promise<{ request: Obj; stop?: string }> {
    const session = this.sessions.get(id);
    if (!session?.external || !session.prompt || !session.task || !this.hooked.has(id)) return { request };
    if (session.stop) return { request, stop: session.stop };
    const source = wireSource(request['input'], session.task, session.prompt);
    session.items = source.items; session.complete = source.complete && !request['previous_response_id'];
    if (session.complete && Array.isArray(request['input'])) session.wire = request['input']; else delete session.wire;
    const model = request['model']; const effort = obj(request['reasoning'])?.['effort'];
    if (typeof model !== 'string') return { request };
    if (session.routed !== session.prompt) {
      session.baseline = { model, effort: typeof effort === 'string' ? effort : null };
      session.policy = loadCodexPolicy({ ...this.env, JEV_CODEX_MODEL: model }, this.catalog);
      const prompt = session.prompt; session.routed = prompt;
      await this.catalogReady;
      session.policy = loadCodexPolicy({ ...this.env, JEV_CODEX_MODEL: model }, this.catalog);
      // Ultra is a native selection that Codex resolves before the provider request. A proxy cannot invent that mapping.
      const catalog = this.catalog.map(m => ({ ...m, supportedReasoningEfforts: m.supportedReasoningEfforts.filter(e => e.reasoningEffort !== 'ultra') }));
      const patch = await routeCodex({ ...session.baseline, task: session.task, session: id, prompt, catalog, config: session.policy, env: this.env, ...(this.trace ? { trace: this.trace } : {}), signal: session.controller ? AbortSignal.any([signal, session.controller.signal]) : signal, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
      if (signal.aborted || session.controller?.signal.aborted || session.prompt !== prompt) throw new Error('interrupted policy');
      session.route = patch;
    }
    // A native settings change during the turn takes precedence over a previous route.
    if (model !== session.baseline.model || (typeof effort === 'string' ? effort : null) !== session.baseline.effort) delete session.route;
    const selected = { ...request, ...(session.route?.model ? { model: session.route.model } : {}), ...(session.route?.effort ? { reasoning: { ...obj(request['reasoning']), effort: session.route.effort } } : {}) };
    session.requestModel = String(selected['model']); session.requestEffort = String(obj(selected['reasoning'])?.['effort'] ?? '');
    if (session.route && Object.keys(session.route).length) this.trace?.write('codex_route_applied', { host: 'codex', session_id: id, prompt_id: session.prompt, stage: 'model_request', observed_model: selected['model'], observed_effort: obj(selected['reasoning'])?.['effort'] ?? null, observed_host_effort: effort ?? null, selected_model: selected['model'], selected_effort: obj(selected['reasoning'])?.['effort'] ?? null, effort_resolution: 'provider_request', applied: true });
    return { request: selected };
  }
  observeUsage(id: string, response: Obj): void {
    const session = this.sessions.get(id); const input = obj(response['usage'])?.['input_tokens'];
    if (session?.external) {
      session.tokens = Number.isSafeInteger(input) && Number(input) >= 0 ? Number(input) : null;
      if (session.wire && session.task && session.prompt && Array.isArray(response['output'])) {
        const source = wireSource([...session.wire, ...response['output']], session.task, session.prompt);
        session.wirePending = !source.complete;
        // A just-issued current-turn tool call does not alter the prefix a Lean packet references.
        // Keep that prefix for dispatch, but forbid using a pending source for a subsequent prompt.
        if (source.complete) { session.items = source.items; session.complete = true; }
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
      recentRequests: () => session.recentRequests ?? [],
      terminal: id => !!this.sessions.get(id)?.dispatch?.ended,
      source: b => codexSource(session.items, b, session.epoch, session.complete),
      observation: id => { const worker = id ? this.sessions.get(id) : undefined; return worker ? codexObservation(worker.items, worker.complete, worker.commands) : null; },
    };
    return runHook({ stdin: (async function* () { yield JSON.stringify(input); })(), env: this.env, host,
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
      this.rpc.forward({ ...message, params: { ...params, config: { ...(obj(params['config']) ?? {}), ...hookConfig }, dynamicTools: [...tools, AGENT_TOOL], developerInstructions: instructions + 'Jev Gate supplies automatic policy guidance in UserPromptSubmit. When it asks for an Agent dispatch, call jev_agent with that exact owned profile and marker. Do not substitute native spawn_agent or implement an admitted contract in the root. Jev failures keep native execution available. Native permissions and user constraints remain authoritative.' } }); return;
    }
    const session = this.sessions.get(String(params['threadId']));
    if (session && method === 'turn/interrupt') { session.controller?.abort(); await this.interruptChildren(session); }
    if (session && method === 'turn/start' && Array.isArray(params['input']) && params['input'].length) {
      // An active turn is steering, not a fresh policy generation. Preserve that host contract.
      if (session.turn) { this.rpc.forward(message); return; }
      // Codex runs SessionStart when the first turn starts, not when thread/start returns.
      session.controller?.abort(); session.controller = new AbortController();
      const prompt = typeof params['clientUserMessageId'] === 'string' ? params['clientUserMessageId'] : randomUUID();
      session.prompt = prompt;
      const collaboration = obj(params['collaborationMode']);
      const modeSettings = obj(collaboration?.['settings']);
      const selectedModel = typeof modeSettings?.['model'] === 'string' ? modeSettings['model'] : typeof params['model'] === 'string' ? params['model'] : session.baseline.model;
      const selectedEffort = modeSettings && 'reasoning_effort' in modeSettings ? modeSettings['reasoning_effort'] : 'effort' in params ? params['effort'] : session.baseline.effort;
      session.baseline = { model: selectedModel, effort: typeof selectedEffort === 'string' ? selectedEffort : null };
      session.policy = loadCodexPolicy({ ...this.env, JEV_CODEX_MODEL: session.baseline.model }, this.catalog);
      const task = textInput(params['input']);
      session.eligible = task !== null;
      // Non-text and malformed input is preserved. No image or attachment is silently dropped to enable Jev.
      if (task === null || this.env['JEV_CODEX_ENABLED'] === '0' || collaboration && collaboration['mode'] !== 'default') { session.eligible = false; this.rpc.forward(message); return; }
      await this.catalogReady;
      session.policy = loadCodexPolicy({ ...this.env, JEV_CODEX_MODEL: session.baseline.model }, this.catalog);
      const previousReply = [...session.items].reverse().find(i => i['type'] === 'agentMessage' && typeof i['text'] === 'string')?.['text'];
      const patch = await routeCodex({ model: session.baseline.model, effort: session.baseline.effort,
        task, ...(typeof previousReply === 'string' ? { previousReply } : {}), session: session.id, prompt, catalog: this.catalog, config: session.policy, env: this.env,
        ...(this.trace ? { trace: this.trace } : {}), signal: session.controller.signal, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
      if (session.controller.signal.aborted || session.prompt !== prompt) {
        if ('id' in message) this.rpc.emit({ id: message['id'], error: { code: -32800, message: 'Turn interrupted before Jev policy completed.' } });
        return;
      }
      session.route = patch;
      // The hook gets the exact submitted request later, from Codex itself. Its policy uses the assigned client id.
      this.rpc.forward({ ...message, params: { ...params, ...patch,
        ...(collaboration && modeSettings ? { collaborationMode: { ...collaboration, settings: { ...modeSettings, ...(patch.model ? { model: patch.model } : {}), ...(patch.effort ? { reasoning_effort: patch.effort } : {}) } } } : {}), clientUserMessageId: prompt } }); return;
    }
    this.rpc.forward(message);
  }
  private notification(message: Obj): void {
    const p = obj(message['params']) ?? {}; const session = this.sessions.get(String(p['threadId']));
    if (!session) return;
    if (message['method'] === 'thread/settings/updated') {
      const settings = obj(p['threadSettings']); if (settings) session.settings = { ...session.settings, ...settings };
    }
    if (message['method'] === 'turn/started' && !session.terminal) {
      session.turn = String(obj(p['turn'])?.['id'] ?? '');
      if (session.dispatch) { this.persistWorkerTurn(session); if (session.dispatch.signal.aborted) this.interruptWorker(session); }
    }
    if (message['method'] === 'thread/tokenUsage/updated') {
      const usage = obj(p['tokenUsage']); const last = obj(usage?.['last']);
      session.tokens = typeof last?.['inputTokens'] === 'number' ? last['inputTokens'] : null;
      session.window = typeof usage?.['modelContextWindow'] === 'number' ? usage['modelContextWindow'] : null;
    }
    if (message['method'] === 'item/started' || message['method'] === 'item/completed') {
      const item = obj(p['item']); if (!item) return;
      const ix = session.items.findIndex(i => i['id'] === item['id']);
      if (ix < 0) session.items.push(item); else session.items[ix] = item;
      if (Buffer.byteLength(JSON.stringify(session.items)) > 8 * 1024 * 1024) { session.complete = false; session.items = session.items.slice(-100); }
      if (item['type'] === 'contextCompaction') { session.complete = false; session.epoch = String(item['id']); session.tokens = null; }
    }
    if (message['method'] === 'turn/completed') {
      const turn = obj(p['turn']) ?? {};
      if (session.dispatch && (session.dispatch.ended || session.turn && turn['id'] !== session.turn || !['completed', 'interrupted', 'failed'].includes(String(turn['status'])))) return;
      session.turn = null; session.terminal = true;
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
    await this.retrySettlements();
    if (!session.role && event === 'PreToolUse' && this.writeConflict(String(input['cwd'] ?? session.settings['cwd']), String(input['tool_name']), obj(input['tool_input']) ?? {})) return deny('A managed Codex worker in this write scope has not completed terminal settlement. Read/status tools and unrelated paths remain available.');
    if (event === 'PreCompact') { session.compactAllowed = session.policy.compact.enabled && (input['trigger'] === 'auto' || input['trigger'] === 'manual' && session.policy.compact.manual); return {}; }
    if (event === 'PreToolUse' && input['tool_name'] === 'Bash' && typeof input['tool_use_id'] === 'string' && typeof obj(input['tool_input'])?.['command'] === 'string') {
      session.commands.set(input['tool_use_id'], String(obj(input['tool_input'])!['command']));
    }
    if (event === 'PostCompact') {
      const compact = this.compactPending.get(session.id);
      if (compact) {
        this.compactPending.delete(session.id);
        session.lastCompactSummary = compact.summary;
        session.items = [{ type: 'jevCompact', id: compact.run, text: compact.summary }]; session.complete = true; session.epoch = compact.run;
        this.trace?.write('codex_compact', { host: 'codex', session_id: session.id, run_id: compact.run, stage: 'installed', applied: true, before_bytes: compact.before, after_bytes: compact.after, summarizer_request: false });
      }
      return {};
    }
    if (this.env['JEV_CODEX_ENABLED'] === '0') return {};
    if (session.role) {
      if (event === 'PreToolUse') {
        const name = String(input['tool_name']);
        if (/^(Agent|spawn_agent|send_input|SendMessage|jev_agent)$/.test(name)) return deny('Jev owned workers and planners cannot create or coordinate child agents.');
        if (OWNED_AGENTS[session.role]?.role === 'planner' && /^(apply_patch|Edit|Write)$/.test(name)) return deny('The Jev planner is read-only. Return a plan; do not implement.');
        if (OWNED_AGENTS[session.role]?.role === 'planner' && !String(obj(session.settings['activePermissionProfile'])?.['id'] ?? '').startsWith(':') && name === 'Bash') return deny('A planner under a custom permission profile cannot run shell commands. Use read-only source or Evidence tools; the parent permission profile remains in force.');
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
    const specific = obj(output['hookSpecificOutput']);
    if (specific && typeof specific['additionalContext'] === 'string') specific['additionalContext'] = codexGuidance(specific['additionalContext']);
    // A native deny does not end the whole turn. Translate the shared exhausted-denial budget to the official
    // interruption API instead of silently removing the stop instruction or approving a tool.
    if (event === 'PreToolUse') {
      if (output['continue'] === false && session.turn) {
        if (session.external) session.stop = String(output['stopReason'] ?? 'Jev Gate stopped the turn after its denial budget was exhausted. No completion is claimed.');
        else {
          session.controller?.abort();
          void this.rpc.request('turn/interrupt', { threadId: session.id, turnId: session.turn }).catch(() => undefined);
        }
      }
      delete output['continue']; delete output['stopReason'];
    }
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
    for (const event of ['sessionStart', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'preCompact', 'postCompact', 'stop']) {
      if (jev.filter(h => h['eventName'] === event && (this.bypassHookTrust || ['trusted', 'managed'].includes(String(h['trustStatus'])))).length !== 1) {
        throw new Error('Trust and enable the installed Jev Gate hooks in native Codex /hooks, then restart this session.');
      }
    }
    if (!this.bypassHookTrust) return {};
    // This grant is scoped to this process and only exists when the user explicitly passes Codex's trust bypass flag.
    const state = Object.fromEntries(jev.filter(h => h['enabled'] === true && obj(inherited[String(h['key'])])?.['enabled'] !== false).map(h => [String(h['key']), { ...(obj(inherited[String(h['key'])]) ?? {}), trusted_hash: h['currentHash'] }]));
    return { 'hooks.state': { ...inherited, ...state } };
  }
  private async agent(p: Obj): Promise<string> {
    const session = this.sessions.get(String(p['threadId'])); const original = obj(p['arguments']);
    if (session && !session.role && original && (original['action'] === 'status' || original['action'] === 'cancel')) {
      if (Object.keys(original).some(k => !['action', 'agent_id'].includes(k)) || typeof original['agent_id'] !== 'string') return 'Invalid background operation.';
      const id = original['agent_id']; const worker = this.sessions.get(id);
      const result = this.backgroundResults.get(id);
      if (!worker?.dispatch?.background || worker.parent !== session.id) return result?.parent === session.id ? result.output : 'No owned background execution with this identity.';
      if (original['action'] === 'cancel') { this.interruptWorker(worker); return 'Cancellation requested. Acceptance and release still require an observed terminal event.'; }
      return worker.dispatch.ended ? this.settleWorker(worker) : 'The original worker is still running. No terminal result or acceptance is available. Answer the user here; do not wait synchronously or duplicate its work.';
    }
    if (!session || session.role || session.eligible === false || this.env['JEV_CODEX_ENABLED'] === '0' || !session.prompt || !session.controller || session.controller.signal.aborted || !original) return 'No active root Jev job.';
    if (typeof original['subagent_type'] !== 'string' || !this.profiles[original['subagent_type']] || typeof original['prompt'] !== 'string' || original['run_in_background'] !== undefined && typeof original['run_in_background'] !== 'boolean' || Object.keys(original).some(k => !['subagent_type', 'prompt', 'description', 'model', 'run_in_background'].includes(k))) return 'Invalid owned Agent input. Use the exact current Jev profile and marker.';
    const background = original['run_in_background'] !== false;
    const parentSignal = session.controller.signal;
    const parent: Session = { ...session, settings: { ...session.settings }, controller: null };
    const state = readJob(this.env, session.id);
    const promptId = state.ok && state.value?.current.background_job && state.value.current.outcome === null ? state.value.current.prompt_id ?? session.prompt : session.prompt;
    const conversationPrompt = session.prompt;
    const toolId = String(p['callId']);
    const input = { ...original, run_in_background: background };
    const pre = await this.hook(parent, { hook_event_name: 'PreToolUse', session_id: parent.id, prompt_id: promptId, tool_name: 'Agent', tool_use_id: toolId, tool_input: input, cwd: String(parent.settings['cwd']) }, parentSignal);
    if (pre.kind === 'deny') return codexGuidance(String(obj(obj(JSON.parse(pre.stdout))?.['hookSpecificOutput'])?.['permissionDecisionReason'] ?? 'Dispatch denied'));
    if (parentSignal.aborted || session.prompt !== conversationPrompt) { await this.failure(parent, promptId, toolId, input, 'dispatch_cancelled'); return 'Dispatch cancelled; no worker started.'; }
    const updated = pre.kind === 'patch' ? obj(obj(JSON.parse(pre.stdout))?.['hookSpecificOutput'])?.['updatedInput'] : input;
    const applied = obj(updated); if (!applied) return 'Dispatch input unavailable.';
    const role = String(applied['subagent_type']); const profile = OWNED_AGENTS[role];
    const model = typeof applied['model'] === 'string' ? applied['model'] : role === LEAN_EXECUTOR_AGENT ? parent.requestModel ?? String(parent.settings['model'] ?? parent.baseline.model) : parent.policy.gate.models[profile?.tier ?? 'standard'];
    if (!this.catalog.some(m => m.model === model)) { await this.failure(parent, promptId, toolId, applied, 'requested_model_unavailable'); return 'The requested worker model is absent from Codex model/list. Native execution remains available; configure accessible tier models.'; }
    let cwd = String(parent.settings['cwd']); let worktree: WorkerWorktree | null = null;
    let worker: Session | null = null;
    let dispatch: WorkerDispatch | undefined;
    const t0 = Date.now();
    try {
      const planner = profile?.role === 'planner';
      const captured = parent.external ? capturedPermissions(p['nativeMeta'], planner) : null;
      if (parent.external && !captured) throw new Error('parent permissions unavailable');
      if (applied['isolation'] === 'worktree') {
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
      if (parent.external ? !captured : typeof permissions !== 'string' && !['dangerFullAccess', 'readOnly', 'workspaceWrite'].includes(String(sandbox?.['type']))) throw new Error('parent permissions unavailable');
      const child = await this.rpc.request('thread/start', { model, modelProvider: parent.settings['modelProvider'], cwd, ephemeral: true,
        approvalPolicy: parent.settings['approvalPolicy'], approvalsReviewer: parent.settings['approvalsReviewer'],
        ...(captured ? { permissions: captured.permissions } : planner && !customPermissions ? { sandbox: 'read-only' } : typeof permissions === 'string' ? { permissions } : { sandbox: sandbox?.['type'] === 'dangerFullAccess' ? 'danger-full-access' : sandbox?.['type'] === 'readOnly' ? 'read-only' : 'workspace-write' }),
        developerInstructions: this.profiles[role], config: { 'features.multi_agent': false, ...captured?.config, ...await this.hookConfig(cwd) }, dynamicTools: [] });
      await this.response(child, 'thread/start', {});
      worker = this.sessions.get(String(obj(child['thread'])?.['id'])) ?? null;
      if (!worker) throw new Error('worker unavailable');
      worker.role = role; worker.parent = session.id;
      const terminal = new Promise<Obj>(resolve => { worker!.done = resolve; });
      dispatch = { parent, prompt: promptId, tool: toolId, input: { ...applied }, signal: background ? new AbortController().signal : parentSignal, worktree, startedAt: t0, attempted: false, background };
      worker.dispatch = dispatch;
      if (parentSignal.aborted || session.prompt !== conversationPrompt) throw new Error('cancelled');
      const desired = OWNED_AGENT_PROFILES.find(p => p.name === role)?.effort ?? parent.requestEffort ?? parent.settings['effort'];
      const offered = this.catalog.find(m => m.model === model)?.supportedReasoningEfforts.map(e => e.reasoningEffort) ?? [];
      const effort = typeof desired === 'string' && offered.includes(desired) ? desired : typeof parent.baseline.effort === 'string' && offered.includes(parent.baseline.effort) ? parent.baseline.effort : null;
      // The durable reservation owns write protection before any user execution can be attempted.
      let registered = false;
      const saved = updateJob(this.env, parent.id, prev => {
        const r = prev?.current.prompt_id === promptId ? own(prev.current.active, toolId) : undefined;
        if (!prev || !r) return null;
        if (this.writeConflict(String(parent.settings['cwd']), 'Agent', {}, r.deliverables)) throw new Error('worker write conflict');
        registered = true;
        return { ...prev, current: { ...prev.current, ...(background ? { background_job: true as const } : {}), active: { ...prev.current.active, [toolId]: { ...r, codex_execution: { thread_id: worker!.id, turn_id: null, cwd, root_cwd: String(parent.settings['cwd']) } } } } };
      }, { refuseUnreadable: true });
      if (!saved.ok || !registered) throw new Error('execution reservation unavailable');
      const cancel = (): void => this.interruptWorker(worker!);
      dispatch.cancel = cancel;
      if (!background) parentSignal.addEventListener('abort', cancel, { once: true });
      try {
        dispatch.attempted = true;
        try {
          const turn = await this.rpc.request('turn/start', { threadId: worker.id, input: [{ type: 'text', text: String(applied['prompt']), text_elements: [] }], model,
            ...(effort ? { effort } : {}),
            ...(sandbox && !planner && !customPermissions && (typeof permissions !== 'string' || worktree) ? { sandboxPolicy: worktree && sandbox['type'] === 'workspaceWrite' ? { ...sandbox, writableRoots: [cwd] } : sandbox } : {}) });
          if (!worker.terminal) { worker.turn = String(obj(turn['turn'])?.['id'] ?? worker.turn ?? ''); this.persistWorkerTurn(worker); }
        } catch (error) {
          if (error instanceof RpcRequestError && !error.attempted && !worker.turn && !dispatch.ended) { dispatch.attempted = false; throw error; }
          if (!dispatch.ended) await this.recoverWorker(worker, terminal);
          if (!dispatch.ended) return 'Worker termination unconfirmed. Its reservation, files and write-scope protection remain active. No replacement execution or acceptance is claimed.';
        }
        if (background && !dispatch.ended) {
          this.trace?.write('background_launch', { host: 'codex', session_id: parent.id, prompt_id: promptId, tool_use_id: toolId, agent_id: worker.id, status: 'running', role: profile?.role ?? 'executor' });
          return `Worker started in the background. Internal execution identity: ${worker.id}. This is a launch receipt, not a completed result. Answer new user messages in the main session while it works; do not duplicate its files or work. Use jev_agent with action=status and agent_id to collect its result without waiting. Use action=cancel only for explicit user cancellation.`;
        }
        if (!background && parentSignal.aborted) cancel();
        if (!dispatch.ended) {
          const ended = await terminal;
          if (ended['localClose']) return 'Worker termination unconfirmed after local connection close. Reservation and files remain protected.';
        }
        return await this.settleWorker(worker);
      } finally {
        // Keep cancellation and terminal ownership while an uncertain execution still exists.
        if (dispatch.settled || !dispatch.attempted) parentSignal.removeEventListener('abort', cancel);
      }
    } catch {
      if (dispatch?.attempted) return 'Worker termination or settlement unconfirmed. Its reservation and files are preserved.';
      if (worker && dispatch) {
        // Definite pre-send failure is non-execution evidence, even if its first state write fails.
        dispatch.ended = { status: 'failed', notExecuted: true };
        return await this.settleWorker(worker);
      }
      await this.failure(parent, promptId, toolId, applied, 'worker_dispatch_failed');
      if (worker) await this.cleanupWorker(worker);
      return 'Worker could not start. Its files and any worktree are preserved. No acceptance is claimed.';
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
    if (worker.turn && !worker.dispatch?.ended) {
      try {
        const read = await this.rpc.request('thread/read', { threadId: worker.id, includeTurns: true }, left());
        const turns = obj(read['thread'])?.['turns'];
        const turn = Array.isArray(turns) ? turns.map(obj).find(t => t?.['id'] === worker.turn && ['completed', 'interrupted', 'failed'].includes(String(t['status']))) : null;
        if (turn) this.notification({ method: 'turn/completed', params: { threadId: worker.id, turn } });
      } catch { /* The single recovery deadline still owns the following wait. */ }
    }
    if (worker.dispatch?.ended || Date.now() >= deadline) return;
    this.interruptWorker(worker, left());
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([terminal, new Promise<void>(resolve => { timer = setTimeout(resolve, left()); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async settleWorker(worker: Session): Promise<string> {
    const d = worker.dispatch;
    if (!d?.ended) return 'Worker termination unconfirmed.';
    if (d.settled) return d.output ?? 'Worker already settled.';
    if (d.settling) return d.settling;
    d.settling = (async () => {
      const texts = worker.items.filter(i => i['type'] === 'agentMessage' && typeof i['text'] === 'string');
      const final = texts.filter(i => i['phase'] === 'final_answer').at(-1) ?? texts.at(-1);
      let guidance = '';
      if (d.ended!['status'] === 'completed') {
        const response = { status: 'completed', agentId: worker.id, resolvedModel: worker.requestModel ?? worker.settings['model'], content: [{ type: 'text', text: String(final?.['text'] ?? '') }], totalDurationMs: Date.now() - d.startedAt };
        const post = await this.hook(d.parent, { hook_event_name: 'PostToolUse', session_id: d.parent.id, prompt_id: d.prompt, tool_name: 'Agent', tool_use_id: d.tool, tool_input: d.input, tool_response: response, cwd: String(d.parent.settings['cwd']) });
        guidance = codexGuidance(contextOf(post));
      } else await this.failure(d.parent, d.prompt, d.tool, d.input, 'worker_not_completed');
      const state = readJob(this.env, d.parent.id);
      const gen = state.ok && state.value ? [state.value.current, ...state.value.history].find(g => g.prompt_id === d.prompt) : null;
      const committed = gen && (gen.receipts.some(r => r.tool_use_id === d.tool) || (d.input['subagent_type'] === 'jev-gate:executor' ? gen.lean?.outcome === 'dispatched' : OWNED_AGENTS[String(d.input['subagent_type'])]?.role === 'planner' && guidance.length > 0));
      if (!gen || own(gen.active, d.tool) || !committed) return 'Worker terminal observed; settlement pending. Reservation and files remain protected. Retry status/settlement without restarting execution.';
      d.output = d.ended!['status'] === 'completed'
        ? `${final?.['text'] ?? 'No worker final output.'}\n\n${guidance}${d.worktree ? `\nWorker worktree: ${d.worktree.path}\nBranch: ${d.worktree.branch}\nSnapshot baseline: ${d.worktree.baseline}. Apply only the diff from this baseline to the worker branch in the root; this result does not integrate it.` : ''}`
        : 'Worker interrupted or failed. No completion or acceptance is claimed.';
      d.settled = true;
      if (d.background) {
        this.backgroundResults.set(worker.id, { parent: d.parent.id, output: d.output });
        while (this.backgroundResults.size > 64) this.backgroundResults.delete(this.backgroundResults.keys().next().value!);
        updateJob(this.env, d.parent.id, prev => prev?.current.prompt_id === d.prompt ? { ...prev, current: { ...prev.current, background_context: d.output!, ...(d.interruptSent && d.ended!['status'] !== 'completed' && Object.keys(prev.current.active).length === 0 ? { outcome: 'incomplete' as const } : {}) } } : null);
        this.trace?.write('background_terminal', { host: 'codex', session_id: d.parent.id, prompt_id: d.prompt, tool_use_id: d.tool, agent_id: worker.id, status: String(d.ended!['status']) });
      }
      if (d.cancel) d.signal.removeEventListener('abort', d.cancel);
      await this.cleanupWorker(worker);
      return d.output;
    })();
    try { return await d.settling; } finally { delete d.settling; }
  }
  private async retrySettlements(): Promise<void> {
    await Promise.all([...this.sessions.values()].filter(s => s.dispatch?.ended && !s.dispatch.settled).map(s => this.settleWorker(s).catch(() => 'settlement pending')));
  }
  private async cleanupWorker(worker: Session): Promise<void> {
    // Observations remain accessible until receipt/state commit, above.
    this.sessions.delete(worker.id); this.hooked.delete(worker.id); this.compactPending.delete(worker.id);
    try { await this.rpc.request('thread/archive', { threadId: worker.id }, 1000); } catch { /* Files are preserved. */ }
  }
  private writeConflict(cwd: string, tool: string, input: Obj, deliverables?: string[]): boolean {
    if (!/^(Agent|Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch|exec_command|write_stdin)$/.test(tool)) return false;
    if (tool === 'Bash' && /^(?:git (?:status|diff|log|show)|(?:pwd|ls|cat|rg|head|tail)\b)[^;&|`]*$/.test(String(input['command'] ?? ''))) return false;
    const paths = deliverables ?? [input['file_path'], input['path']].filter((p): p is string => typeof p === 'string');
    const contains = (base: string, path: string) => { const r = relative(resolve(base), resolve(path)); return r === '' || !r.startsWith('..') && !isAbsolute(r); };
    return codexExecutions(this.env).some(r => {
      const e = r.codex_execution!;
      if (!contains(e.root_cwd, cwd) && !contains(e.cwd, cwd)) return false;
      if (!paths.length) return true;
      if (!r.deliverables.length) return paths.some(p => contains(e.root_cwd, resolve(cwd, p)) || contains(e.cwd, resolve(cwd, p)));
      return paths.some(p => r.deliverables.some(q => contains(resolve(e.root_cwd, q), resolve(cwd, p)) || contains(resolve(cwd, p), resolve(e.root_cwd, q))));
    });
  }
  private async failure(session: Session, prompt: string, tool: string, input: Obj, error: string): Promise<void> {
    await this.hook(session, { hook_event_name: 'PostToolUseFailure', session_id: session.id, prompt_id: prompt, tool_name: 'Agent', tool_use_id: tool, tool_input: input, error });
  }
  selectedCompact(session: string, summary: string, run: string, before: number, after: number): void { this.compactPending.set(session, { summary, run, before, after }); }
  hooksReady(session: string): boolean { return this.env['JEV_CODEX_ENABLED'] === '0' || this.hooked.has(session); }
  requestSession(metadata: unknown, affinity: unknown): string | null {
    if (typeof metadata === 'string') {
      try {
        const parsed = obj(JSON.parse(metadata));
        const id = parsed?.['thread_id'] ?? parsed?.['session_id'];
        if (typeof id === 'string' && this.sessions.has(id)) return id;
      } catch { /* No invented identity. */ }
    }
    return typeof affinity === 'string' && this.sessions.has(affinity) ? affinity : null;
  }
  observeRequest(sessionId: string, request: Obj): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const effort = obj(request['reasoning'])?.['effort'];
    if (typeof request['model'] === 'string') session.requestModel = request['model'];
    if (typeof effort === 'string') session.requestEffort = effort;
    if (!session.route || !Object.keys(session.route).length) return;
    const selectedModel = session.route.model ?? session.baseline.model;
    const selectedEffort = session.route.effort ?? session.baseline.effort;
    // Ultra is a native host selection, resolved by the model to an inference effort.
    // Confirm the official host selection and observe its wire value; never rewrite it.
    const nativeUltra = selectedEffort === 'ultra' && session.settings['effort'] === 'ultra'
      && typeof effort === 'string' && effort !== 'ultra'
      && this.catalog.find(m => m.model === selectedModel)?.supportedReasoningEfforts.some(e => e.reasoningEffort === effort) === true;
    this.trace?.write('codex_route_applied', { host: 'codex', session_id: session.id, prompt_id: session.prompt, stage: 'model_request',
      observed_model: request['model'], observed_effort: effort ?? null, observed_host_effort: session.settings['effort'] ?? null,
      selected_model: selectedModel, selected_effort: selectedEffort, effort_resolution: nativeUltra ? 'native_ultra' : 'direct',
      applied: request['model'] === selectedModel && (!session.route.effort || effort === selectedEffort || nativeUltra) });
    delete session.route;
  }
  previousCompact(session: string): string | undefined { return this.sessions.get(session)?.lastCompactSummary; }
  canCompact(session: string): boolean { return this.sessions.get(session)?.compactAllowed === true; }
  close(): void { for (const s of this.sessions.values()) { s.controller?.abort(); s.done?.({localClose:true}); } }
}
