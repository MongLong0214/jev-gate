import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildAdmissionRequest, decideAdmission, type AdmissionDecision } from './admission.js';
import {
  buildPlannerRouteRequest,
  buildResultRequest,
  buildWorkerRouteRequest,
  decidePlannerRoute,
  decideResult,
  decideWorkerRoute,
  type PlannerRouteDecision,
  type WorkerRouteDecision,
} from './allocation.js';
import {
  checkEligibility,
  DENIALS_BEFORE_STOP,
  guardDecision,
  patchAgentInput,
  renderAdditionalContext,
  renderPreToolUseOutput,
  type AgentInput,
  type Eligibility,
} from './brief.js';
import { loadConfig, type Env } from './config.js';
import {
  GUARD_DENY_REASON,
  renderDirectGuidance,
  renderDispatchDeny,
  renderOrchestrationGuidance,
  renderPlannedContext,
  renderPlannerProblem,
  renderReplanProblem,
  renderRouteNote,
  renderWorkerAccepted,
  renderWorkerIncomplete,
  renderWorkerInvalid,
  renderWorkerUnknown,
  STOP_REASON,
} from './coordinator.js';
import { callJev, MAX_REQUEST_BYTES, type JevOutcome, type JevRequest } from './jev.js';
import {
  activeDeliverables,
  activeWorkers,
  boundExhausted,
  cleanupJobs,
  countAttempt,
  emptyGeneration,
  MAX_HISTORY,
  newGeneration,
  own,
  readJob,
  release,
  reserve,
  supersedeTask,
  updateJob,
} from './job.js';
import {
  acceptedReceipt,
  composeTaskPrompt,
  contractHash,
  deterministicVerdict,
  MAX_COMPOSED_BYTES,
  parsePlannerReply,
  parseTaskMarker,
  parseWorkerReply,
  readyTaskIds,
  type PredecessorSummary,
} from './plan.js';
import { openTraceDir, type TraceWriter } from './trace.js';
import type {
  ConfigV5,
  DenyReason,
  ErrorCode,
  ExecutionShape,
  HookInput,
  JobGeneration,
  JobState,
  PlannedTask,
  Receipt,
  Tier,
} from './types.js';
import { agentForTier, OWNED_AGENTS, TIERS } from './types.js';

export const MAX_STDIN_BYTES = 256 * 1024;

export interface HookDeps {
  stdin: AsyncIterable<Uint8Array | string>;
  env: Env;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  openTrace?: typeof openTraceDir;
}

/** skip: nothing to do; preserve: a call was seen and left untouched; guidance/patch/deny/context: one JSON object on stdout. */
export type HookResult =
  | { kind: 'skip' | 'preserve'; code: ErrorCode | null; stdout: null }
  | { kind: 'guidance' | 'patch' | 'deny' | 'context'; code: ErrorCode | null; stdout: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const readAll = async (stdin: AsyncIterable<Uint8Array | string>): Promise<{ text: string } | { code: ErrorCode }> => {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stdin) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > MAX_STDIN_BYTES) return { code: 'stdin_too_large' };
      chunks.push(buf);
    }
  } catch {
    return { code: 'stdin_read_failed' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { code: 'stdin_invalid_utf8' };
  }
};

const parseInput = (text: string): HookInput | { code: ErrorCode } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { code: 'stdin_invalid_json' };
  }
  if (!isRecord(parsed) || typeof parsed['hook_event_name'] !== 'string') return { code: 'stdin_invalid_json' };
  const out: HookInput = { hook_event_name: parsed['hook_event_name'] as string };
  for (const k of ['session_id', 'prompt_id', 'cwd', 'permission_mode', 'agent_id', 'agent_type', 'effort', 'prompt', 'tool_name', 'tool_use_id', 'error'] as const) {
    const v = str(parsed[k]);
    if (v !== null) out[k] = v;
  }
  if ('tool_input' in parsed) out.tool_input = parsed['tool_input'];
  if ('tool_response' in parsed) out.tool_response = parsed['tool_response'];
  if (typeof parsed['is_interrupt'] === 'boolean') out.is_interrupt = parsed['is_interrupt'];
  const d = num(parsed['duration_ms']);
  if (d !== null) out.duration_ms = d;
  return out;
};

/** Only the documented Choice fields of the asked questions ever reach a trace; never free text from an answer. */
const whitelistAnswers = (answers: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const q of keys) {
    const a = answers[q];
    if (!isRecord(a)) {
      out[q] = null;
      continue;
    }
    const probs = isRecord(a['probabilities'])
      ? Object.fromEntries(Object.entries(a['probabilities']).filter(([, v]) => typeof v === 'number').slice(0, 8))
      : null;
    out[q] = { type: str(a['type']), choice: str(a['choice']), probabilities: probs, confidence: num(a['confidence']) };
  }
  return out;
};

const whitelistToolResponse = (r: unknown): Record<string, unknown> | null => {
  if (!isRecord(r)) return null;
  const usage = isRecord(r['usage']) ? r['usage'] : {};
  return {
    status: str(r['status']),
    agentId: str(r['agentId']),
    resolvedModel: str(r['resolvedModel']),
    modelsUsed: Array.isArray(r['modelsUsed']) ? r['modelsUsed'].filter((m): m is string => typeof m === 'string').slice(0, 16) : null,
    totalDurationMs: num(r['totalDurationMs']),
    totalToolUseCount: num(r['totalToolUseCount']),
    totalTokens: num(r['totalTokens']),
    usage: {
      input_tokens: num(usage['input_tokens']),
      output_tokens: num(usage['output_tokens']),
      cache_creation_input_tokens: num(usage['cache_creation_input_tokens']),
      cache_read_input_tokens: num(usage['cache_read_input_tokens']),
    },
  };
};

const summarizeToolInput = (input: unknown): Record<string, unknown> | null => {
  if (!isRecord(input)) return null;
  const prompt = str(input['prompt']);
  return {
    subagent_type: str(input['subagent_type']),
    has_model: Object.prototype.hasOwnProperty.call(input, 'model'),
    model: str(input['model']),
    run_in_background: typeof input['run_in_background'] === 'boolean' ? input['run_in_background'] : null,
    prompt_len: prompt === null ? null : prompt.length,
    prompt_sha256: prompt === null ? null : sha256(prompt),
    control_keys: Object.keys(input).filter((k) => ['resume', 'agentId', 'agent_id', 'name', 'team_name', 'isolation', 'fork'].includes(k)),
  };
};

/** The host delivers a child's final message as `content[].text`; nothing else in the response is parsed. */
const replyText = (toolResponse: unknown): string => {
  if (!isRecord(toolResponse)) return '';
  const content = toolResponse['content'];
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((c) => (typeof c['text'] === 'string' ? c['text'] : ''))
    .join('\n');
};

const responseStatus = (toolResponse: unknown): string | null => (isRecord(toolResponse) ? str(toolResponse['status']) : null);
const observedModel = (toolResponse: unknown): string | null => (isRecord(toolResponse) ? str(toolResponse['resolvedModel']) : null);

const isSlashCommand = (prompt: string): boolean => prompt.trimStart().startsWith('/');

/** A task that is already running is not offered again; a duplicate dispatch would only be denied. */
const readyForDispatch = (gen: JobGeneration): string[] => {
  const running = new Set(Object.values(gen.active).map((r) => r.task_id));
  return readyTaskIds(gen.plan, gen.receipts).filter((id) => !running.has(id));
};

/** The worst-case route note: every tier name is short, so one bound covers whichever tier is chosen. */
const ROUTE_NOTE_MAX_BYTES = Math.max(...TIERS.map((t) => Buffer.byteLength(renderRouteNote(t), 'utf8')));

const predecessorSummaries = (task: PlannedTask, gen: JobGeneration): PredecessorSummary[] =>
  task.depends_on.flatMap((dep) => {
    const depTask = gen.plan?.tasks.find((t) => t.id === dep);
    const receipt = depTask ? acceptedReceipt(gen.receipts, depTask) : null;
    return receipt?.reply ? [{ task_id: dep, summary: receipt.reply.summary, interfaces: receipt.reply.interfaces }] : [];
  });

/**
 * Event dispatch (V5). UserPromptSubmit: Gate A and the job generation. PreToolUse: root guard plus owned dispatch
 * validation, reservation and Gate B. PostToolUse: receipts, Gate C advisory and readiness. Stop: terminal outcome.
 * Exit code is always 0; a failure anywhere leaves the host's native behavior untouched.
 */
export const runHook = async (deps: HookDeps): Promise<HookResult> => {
  const skip = (code: ErrorCode | null = null): HookResult => ({ kind: 'skip', code, stdout: null });
  const preserve = (code: ErrorCode): HookResult => ({ kind: 'preserve', code, stdout: null });

  const read = await readAll(deps.stdin);
  if ('code' in read) return skip(read.code);
  const input = parseInput(read.text);
  if ('code' in input) return skip(input.code);
  const isAgentPre = input.hook_event_name === 'PreToolUse' && input.tool_name === 'Agent';

  if (deps.env['JEV_GATE_MODE'] === 'off') return isAgentPre ? preserve('mode_off') : skip('mode_off');
  const loaded = loadConfig(deps.env);
  if (!loaded.ok) return isAgentPre ? preserve('config_invalid') : skip('config_invalid');
  const config: ConfigV5 = loaded.config;
  if (config.mode === 'off') return isAgentPre ? preserve('mode_off') : skip('mode_off');
  const mode: 'native' | 'auto' = config.mode;

  let trace: TraceWriter | null = null;
  let traceError: string | null = null;
  const traceDir = deps.env['JEV_GATE_TRACE_DIR'];
  if (traceDir) {
    const opened = (deps.openTrace ?? openTraceDir)(traceDir);
    if (opened.ok) trace = opened.writer;
    else traceError = opened.error;
  }
  const caller = { agent_id: input.agent_id ?? null, agent_type: input.agent_type ?? null };
  /** A2: state rebuilt outside UserPromptSubmit is guarded only when the host gave this turn a prompt identity. */
  const recoveredGeneration = (): JobGeneration => emptyGeneration(input.prompt_id ?? null, input.prompt_id ? 'orchestrated' : 'direct');
  const base = {
    session_id: input.session_id ?? null,
    prompt_id: input.prompt_id ?? null,
    caller,
    tool_use_id: input.tool_use_id ?? null,
    mode,
  };
  const apiKey = deps.env['TYPESAFE_API_KEY'];

  const emitContext = (event: 'UserPromptSubmit' | 'PostToolUse', text: string, code: ErrorCode | null): HookResult => {
    const stdout = renderAdditionalContext(event, text);
    if (stdout === null) return skip('output_too_large');
    return { kind: event === 'UserPromptSubmit' ? 'guidance' : 'context', code, stdout };
  };

  const emitDeny = (reason: DenyReason, text: string, stopReason: string | null): HookResult => {
    const stdout = renderPreToolUseOutput({ kind: 'deny', reason: text, stopReason });
    if (stdout === null) return skip('output_too_large');
    return { kind: 'deny', code: reason, stdout };
  };

  const emitPatch = (original: AgentInput, patch: Parameters<typeof patchAgentInput>[1], code: ErrorCode | null): HookResult => {
    const stdout = renderPreToolUseOutput({ kind: 'update', updatedInput: patchAgentInput(original, patch) });
    if (stdout === null) return preserve('output_too_large');
    return { kind: 'patch', code, stdout };
  };

  /** One attempt, intent before the request, result after it. A trace directory that cannot be written blocks the call. */
  const callGate = async <S, Q>(
    request: JevRequest<S, Q>,
    intentPhase: 'admission_intent' | 'pre_intent' | 'result_intent',
    resultPhase: 'admission_result' | 'pre_result' | 'result_result',
    intent: Record<string, unknown>,
    questionKeys: readonly string[],
    /** Applies the gate's policy and returns the closed decision fields to record (JG5-06 accounting). */
    decide: (outcome: JevOutcome) => Record<string, unknown>,
  ): Promise<{ outcome: JevOutcome } | { blocked: ErrorCode }> => {
    const requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    if (requestBytes > MAX_REQUEST_BYTES) {
      trace?.write(resultPhase, { ...base, ...intent, attempted: false, known_not_sent: true, skip_code: 'request_too_large', request_bytes: requestBytes });
      return { blocked: 'request_too_large' };
    }
    if (deps.signal?.aborted) return { blocked: 'aborted' };
    if (traceDir) {
      if (!trace) return { blocked: 'trace_intent_failed' };
      const written = trace.write(intentPhase, { ...base, ...intent, request_bytes: requestBytes });
      if (!written.ok) return { blocked: 'trace_intent_failed' };
    }
    const outcome = await callJev(request, {
      apiKey: apiKey as string,
      deadlineMs: config.requestDeadlineMs,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    const decided = decide(outcome);
    trace?.write(resultPhase, {
      ...base,
      ...intent,
      attempted: true,
      http: { status: outcome.status, code: outcome.ok ? null : outcome.code, duration_ms: outcome.durationMs, request_bytes: requestBytes },
      jev: outcome.ok ? { model: outcome.response.model, usage: outcome.response.usage, response_bytes: outcome.response.bytes } : { model: null, usage: null, response_bytes: null },
      answers: outcome.ok ? whitelistAnswers(outcome.response.answers, questionKeys) : null,
      ...decided,
    });
    return { outcome };
  };

  // ---------------------------------------------------------------- UserPromptSubmit (Gate A)

  const handleUserPrompt = async (): Promise<HookResult> => {
    const prompt = input.prompt;
    if (typeof prompt !== 'string' || prompt.trim().length === 0 || isSlashCommand(prompt) || caller.agent_id || caller.agent_type) return skip();
    const sessionId = input.session_id;
    if (!sessionId) return skip('missing_ids');
    cleanupJobs(deps.env);
    const promptId = input.prompt_id ?? null;
    // A2: without a prompt identity there is no generation to guard, so the turn stays native.
    if (promptId === null) {
      trace?.write('admission_result', { ...base, attempted: false, known_not_sent: true, decision: 'direct', reason: 'prompt_id_absent' });
      return emitContext('UserPromptSubmit', renderDirectGuidance(mode), 'prompt_id_absent');
    }

    let shape: ExecutionShape = 'direct';
    let reason: ErrorCode | null = null;
    let confidence: number | null = null;
    // A16: the forced control arm starts an orchestrated job in either mode without asking Gate A; B and C still run.
    const forced = deps.env['JEV_GATE_EXPERIMENT_ADMISSION'] === 'orchestrated';
    if (forced) {
      shape = 'orchestrated';
      reason = mode === 'auto' ? 'admission_forced' : null;
      trace?.write('admission_result', {
        ...base,
        attempted: false,
        known_not_sent: true,
        forced: true,
        decision: shape,
        reason: mode === 'auto' ? 'admission_forced' : 'mode_native',
      });
    } else if (mode === 'native') {
      // A9: the control arm initializes the same state and guard as auto; only the Jev calls differ.
      trace?.write('admission_result', { ...base, attempted: false, known_not_sent: true, forced: false, decision: shape, reason: 'mode_native' });
    } else if (!apiKey) {
      reason = 'key_missing';
      trace?.write('admission_result', { ...base, attempted: false, known_not_sent: true, decision: 'direct', reason });
    } else {
      let admitted: AdmissionDecision | null = null;
      const gate = await callGate(
        buildAdmissionRequest(prompt, config),
        'admission_intent',
        'admission_result',
        { prompt_len: prompt.length, prompt_sha256: sha256(prompt) },
        ['execution'],
        (outcome) => {
          if (!outcome.ok) return { forced: false, decision: 'direct', decided: false, reason: outcome.code };
          admitted = decideAdmission(outcome.response.answers, config.admissionConfidenceFloor);
          return { forced: false, decision: admitted.shape, decided: admitted.decided, reason: admitted.reason };
        },
      );
      if ('blocked' in gate) reason = gate.blocked;
      else if (!gate.outcome.ok) reason = gate.outcome.code;
      else if (admitted !== null) {
        const decision: AdmissionDecision = admitted;
        shape = decision.shape;
        reason = decision.reason;
        confidence = decision.answer?.confidence ?? null;
      }
    }

    let superseded = false;
    const written = updateJob(deps.env, sessionId, (prev) => {
      const change = newGeneration(prev, sessionId, promptId, shape);
      superseded = change.superseded;
      return forced ? { ...change.state, current: { ...change.state.current, forced: true as const } } : change.state;
    });
    if (!written.ok) {
      // Without durable state there is no guard and no plan, so the turn falls back to native behavior.
      return emitContext('UserPromptSubmit', renderDirectGuidance(mode), written.code);
    }
    const text = shape === 'orchestrated' ? renderOrchestrationGuidance({ mode, confidence, superseded }) : renderDirectGuidance(mode);
    return emitContext('UserPromptSubmit', text, reason);
  };

  // ---------------------------------------------------------------- PreToolUse

  const plannerPatch = async (gen: JobGeneration, sessionId: string, eligibility: Extract<Eligibility, { eligible: true }>): Promise<HookResult> => {
    const composed = eligibility.prompt;
    let tier = config.plannerDefaultTier;
    let code: ErrorCode | null = null;
    if (apiKey) {
      let routed: PlannerRouteDecision | null = null;
      const gate = await callGate(
        buildPlannerRouteRequest(composed, config),
        'pre_intent',
        'pre_result',
        { role: 'planner', tool_input: summarizeToolInput(eligibility.input), default_tier: config.plannerDefaultTier },
        ['planning_tier'],
        (outcome) => {
          if (!outcome.ok) return { decision: { action: 'patch', tier: config.plannerDefaultTier, reason: outcome.code } };
          routed = decidePlannerRoute(outcome.response.answers, config.routeConfidenceFloor, config.plannerDefaultTier);
          return { decision: { action: routed.action, tier: routed.tier, reason: routed.reason } };
        },
      );
      if ('blocked' in gate) code = gate.blocked;
      else if (!gate.outcome.ok) code = gate.outcome.code;
      else if (routed !== null) {
        const decision: PlannerRouteDecision = routed;
        tier = decision.tier;
        code = decision.reason;
      }
    } else {
      code = 'key_missing';
    }
    // A2: a prompt that arrived during the call replaces this generation; the patch is dropped rather than applied late.
    const after = readJob(deps.env, sessionId);
    if (!after.ok || after.value === null || after.value.current.prompt_id !== gen.prompt_id) return preserve('generation_changed');
    updateJob(deps.env, sessionId, (prev) => (prev && prev.current.prompt_id === gen.prompt_id ? { ...prev, current: { ...prev.current, planner_tier: tier } } : null));
    return emitPatch(eligibility.input, { subagent_type: agentForTier('planner', tier), model: config.models[tier] }, code);
  };

  const handlePlanner = async (gen: JobGeneration, sessionId: string, eligibility: Extract<Eligibility, { eligible: true }>): Promise<HookResult> => {
    // A5: a pin bypasses tier selection only; a pin outside the configured strong models is a visible conflict.
    if (eligibility.pinned) {
      const pinned = str(eligibility.input['model']);
      if (pinned !== config.models.deep && pinned !== config.models.frontier) {
        return emitDeny('planner_pin_conflict', renderDispatchDeny('planner_pin_conflict'), null);
      }
    }
    // A3: draining first keeps a replan from racing the workers whose receipts it would invalidate.
    if (activeWorkers(gen).length > 0) return emitDeny('workers_active', renderDispatchDeny('workers_active'), null);
    const boundKind = gen.plan ? 'replan' : 'planner';
    if (boundExhausted(gen, boundKind, null)) return emitDeny('bounds_exhausted', renderDispatchDeny('bounds_exhausted', boundKind), null);
    const reserved = updateJob(deps.env, sessionId, (prev) => {
      // A planner dispatch is also the recovery path from missing or unreadable state, and the point where a
      // coordinator-initiated job becomes orchestrated. A2: a generation without a prompt identity is never guarded.
      const current = prev?.current ?? recoveredGeneration();
      const counted = countAttempt(current, boundKind, null);
      const shape: ExecutionShape = current.prompt_id === null ? 'direct' : 'orchestrated';
      const next = reserve({ ...counted, phase: 'planning', shape }, eligibility.toolUseId, {
        role: 'planner',
        taskId: null,
        rev: null,
        tier: null,
        attempt: 1,
        deliverables: [],
      });
      return { version: 5, session_id: sessionId, updated_at: '', current: next, history: prev?.history ?? [] };
    });
    if (!reserved.ok) return preserve(reserved.code);
    // A5: a pin bypasses tier selection, so the call is left exactly as the coordinator made it.
    if (eligibility.pinned) return preserve('pinned');
    if (mode === 'native') return preserve('mode_native');
    return plannerPatch(reserved.value?.current ?? gen, sessionId, eligibility);
  };

  /** A4: every reason a ready task may still not be dispatched now. Run on the pre-lock read and again under the lock. */
  const dispatchConflict = (g: JobGeneration, task: PlannedTask, rework: boolean): { reason: DenyReason; detail: string } | null => {
    const running = Object.values(g.active).filter((r) => r.task_id === task.id);
    if (!rework && running.length > 0) return { reason: 'task_active', detail: task.id };
    if (!rework && acceptedReceipt(g.receipts, task)) return { reason: 'task_accepted', detail: task.id };
    if (boundExhausted(g, 'task', task.id)) return { reason: 'bounds_exhausted', detail: task.id };
    const otherDeliverables = new Set(activeDeliverables(g, task.id));
    const overlap = task.deliverables.filter((d) => otherDeliverables.has(d));
    if (overlap.length) return { reason: 'deliverable_overlap', detail: overlap.join(', ') };
    const otherActive = activeWorkers(g).filter((r) => r.task_id !== task.id).length;
    if (otherActive >= config.maxParallelWorkers) return { reason: 'parallel_cap', detail: `${otherActive}/${config.maxParallelWorkers}` };
    return null;
  };

  const handleWorker = async (gen: JobGeneration, sessionId: string, eligibility: Extract<Eligibility, { eligible: true }>): Promise<HookResult> => {
    const plan = gen.plan;
    if (gen.phase !== 'planned' || !plan) return emitDeny('phase_not_planned', renderDispatchDeny('phase_not_planned', gen.phase), null);
    const marker = parseTaskMarker(eligibility.prompt);
    if (!marker) return emitDeny('no_marker', renderDispatchDeny('no_marker'), null);
    const task = plan.tasks.find((t) => t.id === marker.id);
    if (!task) return emitDeny('unknown_task', renderDispatchDeny('unknown_task', marker.id), null);
    if (marker.rev !== plan.rev) return emitDeny('stale_rev', renderDispatchDeny('stale_rev', `marker rev=${marker.rev}, current rev=${plan.rev}`), null);
    const missingDeps = task.depends_on.filter((dep) => {
      const depTask = plan.tasks.find((t) => t.id === dep);
      return !depTask || acceptedReceipt(gen.receipts, depTask) === null;
    });
    if (missingDeps.length) return emitDeny('deps_incomplete', renderDispatchDeny('deps_incomplete', missingDeps.join(', ')), null);
    const rework = marker.attempt !== null;
    const conflict = dispatchConflict(gen, task, rework);
    if (conflict) return emitDeny(conflict.reason, renderDispatchDeny(conflict.reason, conflict.detail), null);
    const predecessors = predecessorSummaries(task, gen);
    const composed = composeTaskPrompt(eligibility.prompt, task, plan.constraints, predecessors);
    // The route note is part of what the worker receives, so it counts against the same bound.
    const composedBytes = Buffer.byteLength(composed, 'utf8') + ROUTE_NOTE_MAX_BYTES;
    if (composedBytes > MAX_COMPOSED_BYTES) {
      return emitDeny('composed_too_large', renderDispatchDeny('composed_too_large', `${composedBytes} bytes`), null);
    }

    // A4: the reservation is taken before any HTTP call, and the conflict checks are re-run under the lock,
    // so two dispatches in one assistant message cannot both pass on the same pre-lock snapshot.
    const attempt = marker.attempt ?? 1;
    let raced: DenyReason | 'generation_changed' | null = null;
    const reserved = updateJob(deps.env, sessionId, (prev) => {
      if (!prev || prev.current.prompt_id !== gen.prompt_id || prev.current.plan?.rev !== plan.rev) {
        raced = 'generation_changed';
        return null;
      }
      const again = dispatchConflict(prev.current, task, rework);
      if (again) {
        raced = again.reason;
        return null;
      }
      const superseded = rework ? supersedeTask(prev.current, task.id) : { generation: prev.current, superseded: [] as string[] };
      const counted = countAttempt(superseded.generation, 'task', task.id);
      const next = reserve(counted, eligibility.toolUseId, {
        role: 'worker',
        taskId: task.id,
        rev: plan.rev,
        tier: eligibility.tier,
        attempt,
        deliverables: task.deliverables,
      });
      return { ...prev, current: next };
    });
    if (!reserved.ok) return preserve(reserved.code);
    if (raced === 'generation_changed') return preserve('generation_changed');
    if (raced !== null) return emitDeny(raced, renderDispatchDeny(raced), null);

    const note = (tier: Tier): string => renderRouteNote(tier);
    // A5: native, pinned, abstained and failed paths still receive the canonical contract; only the model is left alone.
    if (mode === 'native' || eligibility.pinned || !apiKey) {
      return emitPatch(eligibility.input, { prompt: composed + note(eligibility.tier) }, mode === 'native' ? 'mode_native' : eligibility.pinned ? 'pinned' : 'key_missing');
    }
    let routed: WorkerRouteDecision | null = null;
    const gate = await callGate(
      buildWorkerRouteRequest(task, plan.constraints, predecessors, eligibility.prompt, eligibility.tier, config),
      'pre_intent',
      'pre_result',
      { role: 'worker', task_id: task.id, rev: plan.rev, called_tier: eligibility.tier, tool_input: summarizeToolInput(eligibility.input) },
      ['route', 'upgrade_basis'],
      (outcome) => {
        if (!outcome.ok) return { decision: { action: 'preserve', tier: eligibility.tier, reason: outcome.code } };
        routed = decideWorkerRoute(outcome.response.answers, config.routeConfidenceFloor, eligibility.tier);
        return { decision: { action: routed.action, tier: routed.tier, reason: routed.reason } };
      },
    );
    const after = readJob(deps.env, sessionId);
    if (!after.ok || after.value === null || after.value.current.prompt_id !== gen.prompt_id || after.value.current.plan?.rev !== plan.rev) {
      return preserve('generation_changed');
    }
    if ('blocked' in gate) return emitPatch(eligibility.input, { prompt: composed + note(eligibility.tier) }, gate.blocked);
    if (!gate.outcome.ok) return emitPatch(eligibility.input, { prompt: composed + note(eligibility.tier) }, gate.outcome.code);
    if (routed === null) return emitPatch(eligibility.input, { prompt: composed + note(eligibility.tier) }, 'route_invalid');
    const decision: WorkerRouteDecision = routed;
    if (decision.action === 'preserve') return emitPatch(eligibility.input, { prompt: composed + note(decision.tier) }, decision.reason);
    return emitPatch(
      eligibility.input,
      { subagent_type: agentForTier('worker', decision.tier), model: config.models[decision.tier], prompt: composed + note(decision.tier) },
      null,
    );
  };

  /** A direct-shape owned worker call is an ad-hoc task: routed V4-style in auto, untouched in native. */
  const handleAdhocWorker = async (eligibility: Extract<Eligibility, { eligible: true }>): Promise<HookResult> => {
    if (mode === 'native') return preserve('mode_native');
    if (eligibility.pinned) return preserve('pinned');
    if (!apiKey) return preserve('key_missing');
    const task: PlannedTask = {
      id: 'adhoc',
      outcome: eligibility.description || eligibility.prompt.slice(0, 200),
      depends_on: [],
      context: '',
      constraints: [],
      deliverables: [],
      checks: [],
      replan_if: [],
      contract_hash: '',
    };
    let routed: WorkerRouteDecision | null = null;
    const gate = await callGate(
      buildWorkerRouteRequest(task, [], [], eligibility.prompt, eligibility.tier, config),
      'pre_intent',
      'pre_result',
      { role: 'worker', task_id: 'adhoc', called_tier: eligibility.tier, tool_input: summarizeToolInput(eligibility.input) },
      ['route', 'upgrade_basis'],
      (outcome) => {
        if (!outcome.ok) return { decision: { action: 'preserve', tier: eligibility.tier, reason: outcome.code } };
        routed = decideWorkerRoute(outcome.response.answers, config.routeConfidenceFloor, eligibility.tier);
        return { decision: { action: routed.action, tier: routed.tier, reason: routed.reason } };
      },
    );
    if ('blocked' in gate) return preserve(gate.blocked);
    if (!gate.outcome.ok) return preserve(gate.outcome.code);
    if (routed === null) return preserve('route_invalid');
    const decision: WorkerRouteDecision = routed;
    if (decision.action === 'preserve') return preserve(decision.reason ?? 'route_invalid');
    return emitPatch(
      eligibility.input,
      { subagent_type: agentForTier('worker', decision.tier), model: config.models[decision.tier], prompt: eligibility.prompt + renderRouteNote(decision.tier) },
      null,
    );
  };

  const handlePreToolUse = async (): Promise<HookResult> => {
    if (caller.agent_id) return skip('child_caller');
    const sessionId = input.session_id;
    if (!sessionId) return skip('missing_ids');
    const toolName = input.tool_name ?? '';
    const state = readJob(deps.env, sessionId);
    let gen: JobGeneration | null = null;
    // #25: unreadable state of any kind keeps the guard on and lets a planner recover; workers stay denied.
    // A2: without a prompt identity there is no generation to guard, so recovery stays direct.
    if (state.ok) gen = state.value?.current ?? null;
    else gen = { ...recoveredGeneration(), phase: 'blocked' };

    const orchestrated = gen !== null && gen.shape === 'orchestrated' && gen.outcome === null;
    const ownedCall = toolName === 'Agent' && isRecord(input.tool_input) && typeof input.tool_input['subagent_type'] === 'string' && input.tool_input['subagent_type'] in OWNED_AGENTS;

    if (!orchestrated) {
      if (toolName !== 'Agent') return skip(gen ? 'shape_direct' : 'no_state');
      if (!ownedCall) return skip('role_not_owned');
      const eligibility = checkEligibility(input, deps.env, config);
      if (!eligibility.eligible) return preserve(eligibility.code);
      if (eligibility.role === 'worker') return handleAdhocWorker(eligibility);
      // A coordinator may start orchestration itself by calling the planner; its reservation writes the transition,
      // so the dispatch still takes at most two locks.
      return handlePlanner(gen ?? recoveredGeneration(), sessionId, eligibility);
    }

    const generation = gen as JobGeneration;
    if (!ownedCall) {
      const decision = guardDecision(toolName, input.tool_input, config);
      if (decision.allow) {
        trace?.write('guard', { ...base, tool_name: toolName, allow: true, denials: generation.denials, stopped: false });
        return skip();
      }
      let denials = generation.denials + 1;
      const counted = updateJob(deps.env, sessionId, (prev) => {
        if (!prev) return null;
        denials = prev.current.denials + 1;
        return { ...prev, current: { ...prev.current, denials } };
      });
      if (!counted.ok) denials = generation.denials + 1;
      const stopped = denials >= DENIALS_BEFORE_STOP;
      trace?.write('guard', { ...base, tool_name: toolName, allow: false, denials, stopped });
      return emitDeny('guard_denied', GUARD_DENY_REASON, stopped ? STOP_REASON : null);
    }

    const eligibility = checkEligibility(input, deps.env, config);
    // Inside an orchestrated job an owned call that cannot be validated is denied, never waved through unvalidated.
    if (!eligibility.eligible) return emitDeny('dispatch_ineligible', renderDispatchDeny('dispatch_ineligible', eligibility.code), null);
    return eligibility.role === 'planner' ? handlePlanner(generation, sessionId, eligibility) : handleWorker(generation, sessionId, eligibility);
  };

  // ---------------------------------------------------------------- PostToolUse

  /**
   * A3: a receipt survives a replan only when the new task has the same id and contract; its dependents reset with it.
   * Reset receipts are moved to history, never deleted: the work they record happened and stays in the accounting.
   */
  const carryForward = (tasks: PlannedTask[], receipts: Receipt[]): { kept: Receipt[]; dropped: Receipt[] } => {
    const kept = new Set(tasks.filter((t) => receipts.some((r) => r.task_id === t.id && r.contract_hash === t.contract_hash)).map((t) => t.id));
    for (;;) {
      const next = new Set([...kept].filter((id) => (tasks.find((t) => t.id === id)?.depends_on ?? []).every((dep) => kept.has(dep))));
      if (next.size === kept.size) break;
      kept.clear();
      for (const id of next) kept.add(id);
    }
    const survives = (r: Receipt): boolean => kept.has(r.task_id) && tasks.some((t) => t.id === r.task_id && t.contract_hash === r.contract_hash);
    return { kept: receipts.filter(survives), dropped: receipts.filter((r) => !survives(r)) };
  };

  const handlePlannerResult = (sessionId: string, gen: JobGeneration, toolUseId: string): HookResult => {
    const status = responseStatus(input.tool_response);
    const text = replyText(input.tool_response);
    const parsed = status === 'completed' ? parsePlannerReply(text) : null;
    let context: string | null = null;
    const written = updateJob(deps.env, sessionId, (prev) => {
      if (!prev || prev.current.prompt_id !== gen.prompt_id) return null;
      let next = release(prev.current, toolUseId);
      if (status !== 'completed') {
        trace?.write('plan', { ...base, status, outcome: 'unknown' });
        return { ...prev, current: next };
      }
      if (parsed && parsed.ok && parsed.value.status === 'ready') {
        const reply = parsed.value;
        const tasks: PlannedTask[] = reply.tasks.map((t) => ({ ...t, contract_hash: contractHash(t) }));
        const rev = (next.plan?.rev ?? 0) + 1;
        const carried = carryForward(tasks, next.receipts);
        next = {
          ...next,
          phase: 'planned',
          plan: { rev, goal: reply.goal, assumptions: reply.assumptions, constraints: reply.constraints, tasks },
          receipts: carried.kept,
        };
        context = renderPlannedContext(rev, readyForDispatch(next));
        trace?.write('plan', { ...base, status, outcome: 'ready', rev, tasks: tasks.length, carried_receipts: carried.kept.length, reset_receipts: carried.dropped.length });
        const history = carried.dropped.length
          ? [{ ...prev.current, plan: null, active: {}, receipts: carried.dropped, outcome: 'superseded' as const }, ...prev.history].slice(0, MAX_HISTORY)
          : prev.history;
        return { ...prev, current: next, history };
      }
      const reply = parsed && parsed.ok ? parsed.value : null;
      const detail = reply === null ? (parsed?.ok === false ? parsed.error : 'no reply') : reply.status === 'blocked' ? reply.reason : reply.status === 'needs_context' ? reply.questions.join(' ') : '';
      const label = reply === null ? 'an invalid reply' : reply.status;
      // A failed replan leaves the plan it tried to replace in force; only a job with no valid plan is downgraded.
      const inForce = next.plan;
      if (inForce !== null) {
        next = { ...next, phase: 'planned' };
        context = renderReplanProblem(label, detail, inForce.rev);
        trace?.write('plan', { ...base, status, outcome: label, phase: next.phase, replan_failed: true });
        return { ...prev, current: next };
      }
      // A7: the first planner failure returns the job to admitted so the coordinator can retry once; the second blocks it.
      // The planner and replan bounds are separate counters, so a replan never consumes an initial planning attempt.
      const exhausted = boundExhausted(next, 'planner', null);
      next = { ...next, phase: exhausted ? 'blocked' : 'admitted' };
      context = renderPlannerProblem(label, exhausted ? `${detail} No planner attempts remain; report this to the user.` : detail);
      trace?.write('plan', { ...base, status, outcome: label, phase: next.phase });
      return { ...prev, current: next };
    });
    if (!written.ok) return skip(written.code);
    return context === null ? skip() : emitContext('PostToolUse', context, null);
  };

  const handleWorkerResult = async (sessionId: string, gen: JobGeneration, toolUseId: string, taskId: string, rev: number, attempt: number): Promise<HookResult> => {
    const task = gen.plan?.tasks.find((t) => t.id === taskId) ?? null;
    const status = responseStatus(input.tool_response);
    const parsed = status === 'completed' ? parseWorkerReply(replyText(input.tool_response)) : null;
    let finalVerdict: Receipt['verdict'] = 'unknown';
    let reason: string | null = null;
    if (parsed === null) reason = `the call reported status ${String(status)}`;
    else if (!parsed.ok) {
      finalVerdict = 'invalid';
      reason = parsed.error;
    } else if (!task) {
      finalVerdict = 'invalid';
      reason = 'the task is no longer in the current plan';
    } else {
      const deterministic = deterministicVerdict(task, parsed.value);
      finalVerdict = deterministic.verdict;
      reason = deterministic.reason;
    }

    // A1: Gate C is advisory. It runs only on a deterministic accept and never changes what is unlocked.
    let advisory: string | null = null;
    if (mode === 'auto' && apiKey && finalVerdict === 'accept' && task && parsed && parsed.ok) {
      await callGate(
        buildResultRequest(task, parsed.value, config),
        'result_intent',
        'result_result',
        { task_id: taskId, rev, deterministic: finalVerdict },
        ['result'],
        (outcome) => {
          if (!outcome.ok) return { decision: { verdict: null, reason: outcome.code, advisory_only: true } };
          const judged = decideResult(outcome.response.answers, config.resultConfidenceFloor);
          if (judged.verdict && judged.verdict !== 'accept') advisory = judged.verdict;
          return { decision: { verdict: judged.verdict, reason: judged.reason, advisory_only: true } };
        },
      );
    }

    let context: string | null = null;
    const written = updateJob(deps.env, sessionId, (prev) => {
      if (!prev || prev.current.prompt_id !== gen.prompt_id) return null;
      let next = release(prev.current, toolUseId);
      const receipt: Receipt = {
        task_id: taskId,
        contract_hash: task?.contract_hash ?? '',
        rev,
        attempt,
        tool_use_id: toolUseId,
        provenance: 'worker_reported',
        reply: parsed && parsed.ok ? parsed.value : null,
        verdict: finalVerdict,
        verdict_reason: reason,
        advisory: advisory === null ? null : (advisory as Receipt['advisory']),
        observed_model: observedModel(input.tool_response),
        root_effort: input.effort ?? null,
        recorded_at: new Date().toISOString(),
      };
      next = { ...next, receipts: [...next.receipts.filter((r) => r.tool_use_id !== toolUseId), receipt] };
      if (finalVerdict === 'accept') context = renderWorkerAccepted(taskId, readyForDispatch(next), advisory);
      else if (finalVerdict === 'unknown') context = renderWorkerUnknown(taskId);
      else if (finalVerdict === 'invalid') context = renderWorkerInvalid(taskId, reason ?? 'unparsable reply');
      else context = renderWorkerIncomplete(taskId, reason ?? 'the reported checks do not satisfy the contract');
      trace?.write('post', {
        ...base,
        task_id: taskId,
        rev,
        attempt,
        verdict: finalVerdict,
        verdict_reason: reason,
        advisory,
        tool_response: whitelistToolResponse(input.tool_response),
        root_effort: input.effort ?? null,
      });
      return { ...prev, current: next };
    });
    if (!written.ok) return skip(written.code);
    return context === null ? skip() : emitContext('PostToolUse', context, null);
  };

  const handlePostToolUse = async (): Promise<HookResult> => {
    if (caller.agent_id) return skip('child_caller');
    if (input.tool_name !== 'Agent') return skip('not_agent_tool');
    const sessionId = input.session_id;
    const toolUseId = input.tool_use_id;
    if (!sessionId || !toolUseId) return skip('missing_ids');
    const state = readJob(deps.env, sessionId);
    if (!state.ok) return skip(state.code);
    const job = state.value;
    if (!job) return skip('no_state');
    const reservation = own(job.current.active, toolUseId);
    if (!reservation) {
      // A2: a late result belongs to its own generation only; it is recorded and never advances the current plan.
      const orphaned = job.history.some((h) => own(h.active, toolUseId) !== undefined);
      trace?.write('post', { ...base, matched: false, orphaned, tool_response: whitelistToolResponse(input.tool_response) });
      return skip(orphaned ? 'generation_changed' : null);
    }
    if (reservation.role === 'planner') return handlePlannerResult(sessionId, job.current, toolUseId);
    return handleWorkerResult(sessionId, job.current, toolUseId, reservation.task_id ?? '', reservation.rev ?? 0, reservation.attempt);
  };

  const handlePostToolUseFailure = (): HookResult => {
    if (caller.agent_id) return skip('child_caller');
    if (input.tool_name !== 'Agent') return skip('not_agent_tool');
    const sessionId = input.session_id;
    const toolUseId = input.tool_use_id;
    const error = input.error ?? '';
    if (sessionId && toolUseId) {
      updateJob(deps.env, sessionId, (prev) => {
        const reservation = prev ? own(prev.current.active, toolUseId) : undefined;
        if (!prev || !reservation) return null;
        const next = release(prev.current, toolUseId);
        const receipt: Receipt = {
          task_id: reservation.task_id ?? '',
          contract_hash: '',
          rev: reservation.rev ?? 0,
          attempt: reservation.attempt,
          tool_use_id: toolUseId,
          provenance: 'worker_reported',
          reply: null,
          verdict: 'unknown',
          verdict_reason: 'the call failed before a reply was returned',
          advisory: null,
          observed_model: null,
          root_effort: input.effort ?? null,
          recorded_at: new Date().toISOString(),
        };
        return { ...prev, current: { ...next, receipts: [...next.receipts, receipt] } };
      });
    }
    trace?.write('failure', {
      ...base,
      tool_input: summarizeToolInput(input.tool_input),
      error_first_line: error.split('\n')[0]?.slice(0, 200) ?? null,
      error_len: error.length,
      is_interrupt: input.is_interrupt ?? null,
      duration_ms: input.duration_ms ?? null,
    });
    return skip();
  };

  /** A6/A7: Stop is observational. It records the terminal outcome and blocks nothing, so it cannot loop. */
  const handleStop = (): HookResult => {
    if (caller.agent_id) return skip('child_caller');
    const sessionId = input.session_id;
    if (!sessionId) return skip('missing_ids');
    let outcome: JobState['current']['outcome'] = null;
    updateJob(deps.env, sessionId, (prev) => {
      if (!prev || prev.current.outcome !== null) return null;
      const gen = prev.current;
      const allAccepted = gen.plan !== null && gen.plan.tasks.every((t) => acceptedReceipt(gen.receipts, t) !== null);
      outcome = gen.phase === 'blocked' ? 'blocked' : gen.shape === 'direct' || allAccepted ? 'completed' : 'incomplete';
      return { ...prev, current: { ...gen, outcome } };
    });
    trace?.write('stop', { ...base, outcome });
    return skip();
  };

  if (input.hook_event_name === 'UserPromptSubmit') return handleUserPrompt();
  if (input.hook_event_name === 'PreToolUse') return handlePreToolUse();
  if (input.hook_event_name === 'PostToolUse') return handlePostToolUse();
  if (input.hook_event_name === 'PostToolUseFailure') return handlePostToolUseFailure();
  if (input.hook_event_name === 'Stop') return handleStop();
  return skip();
};

const isMainModule = (): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMainModule()) {
  runHook({ stdin: process.stdin, env: process.env })
    .then((result) => {
      if (result.stdout !== null) process.stdout.write(result.stdout + '\n');
      if (result.code) process.stderr.write(`jev-gate: ${result.code}\n`);
      process.exitCode = 0;
    })
    .catch(() => {
      process.stderr.write('jev-gate: internal\n');
      process.exitCode = 0;
    });
}
