import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ADMISSION_FACT_QUESTIONS,
  buildAdmissionRequest,
  buildAtomicAdmissionRequest,
  decideAdmission,
  decideAdmissionAtomic,
  shapeRecommendation,
  type AdmissionDecision,
  type AdmissionState,
} from './admission.js';
import {
  buildAtomicWorkerRouteRequest,
  buildPlannerRouteRequest,
  buildWorkerRouteRequest,
  decidePlannerRoute,
  decideWorkerRoute,
  decideWorkerRouteAtomic,
  PRIOR_FAILURE_FACT_QUESTIONS,
  priorFailureClassification,
  WORKER_FACT_QUESTIONS,
  type PlannerRouteDecision,
  type WorkerRouteDecision,
  type WorkerRouteState,
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
import { readSessionDepth, type DepthReading } from './depth.js';
import {
  GUARD_DENY_REASON,
  renderDirectGuidance,
  renderDispatchDeny,
  renderReplanBoundExhausted,
  renderOrchestrationGuidance,
  renderSingleGuidance,
  renderSingleResult,
  renderSingleRouteNote,
  renderPlannedContext,
  renderPlannerModelNote,
  renderPlannerProblem,
  renderReplanProblem,
  renderRouteNote,
  renderWorkerAccepted,
  renderWorkerIncomplete,
  renderWorkerInvalid,
  renderWorkerReported,
  renderWorkerUnknown,
  STOP_REASON,
} from './coordinator.js';
import { buildPlanInterpretationRequest, classifyInterpretation, type PlanInterpretation } from './interpretation.js';
import { callJev, MAX_REQUEST_BYTES, type JevOutcome, type JevRequest } from './jev.js';
import type { BoundKind } from './job.js';
import {
  activeDeliverables,
  activePlanners,
  activeTaskIds,
  activeWorkers,
  boundExhausted,
  REQUEST_MAX_BYTES,
  cleanupJobs,
  countAttempt,
  emptyGeneration,
  MAX_HISTORY,
  newGeneration,
  own,
  readJob,
  release,
  reserve,
  updateJob,
} from './job.js';
import {
  acceptedReceipt,
  chainDepth,
  composePlannerPrompt,
  composeSingleWorkerPrompt,
  composeTaskPrompt,
  contractHash,
  deliverableOverlap,
  deterministicVerdict,
  MAX_COMPOSED_BYTES,
  normalizeDeliverable,
  parsePlannerReply,
  parseTaskMarker,
  parseWorkerReply,
  planInForceSummary,
  priorAttemptSummary,
  readyTaskIds,
  reportedRecovery,
  reportedSingleVerdict,
  SINGLE_TASK_ID,
  type PlanInForceSummary,
  type PredecessorSummary,
  type PriorAttemptSummary,
} from './plan.js';
import { openTraceDir, type TraceWriter } from './trace.js';
import type { ConfigV5, DenyReason, ErrorCode, ExecutionShape, HookInput, JobGeneration, JobState, ModelAgreement, Plan, PlannedTask, Receipt, Reservation, RoutingMode, Tier } from './types.js';
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
  for (const k of ['session_id', 'prompt_id', 'transcript_path', 'cwd', 'permission_mode', 'agent_id', 'agent_type', 'prompt', 'tool_name', 'tool_use_id', 'error'] as const) {
    const v = str(parsed[k]);
    if (v !== null) out[k] = v;
  }
  if ('tool_input' in parsed) out.tool_input = parsed['tool_input'];
  if ('tool_response' in parsed) out.tool_response = parsed['tool_response'];
  // Host finding (v5-host-1): effort arrives as { level: "high" }, not a string; a string form is accepted too.
  const effort = parsed['effort'];
  if (typeof effort === 'string') out.effort = effort;
  else if (isRecord(effort) && typeof effort['level'] === 'string') out.effort = effort['level'];
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
    // Both atomic gates decide on `noul` and `score`, and neither is a choice, so a trace carrying only the choice
    // fields recorded the question and not the answer: the shipped Gate A was unauditable from its own observations.
    out[q] = { type: str(a['type']), choice: str(a['choice']), noul: num(a['noul']), score: num(a['score']), probabilities: probs, confidence: num(a['confidence']) };
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

/** T1: the tasks that would be built on this one's result, directly or through a chain of dependencies. */
const dependentsOf = (plan: Plan, taskId: string): Set<string> => {
  const out = new Set<string>();
  for (;;) {
    const before = out.size;
    for (const t of plan.tasks) if (t.depends_on.some((d) => d === taskId || out.has(d))) out.add(t.id);
    if (out.size === before) return out;
  }
};

/** T1: a task that is running, or whose predecessor is, is not offered; running means no settled result, not a value. */
const readyForDispatch = (gen: JobGeneration): string[] => readyTaskIds(gen.plan, gen.receipts, activeTaskIds(gen));

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
 * validation, reservation and Gate B. PostToolUse: receipts and readiness, decided by code alone (T11). Stop: terminal outcome.
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
  const mode: RoutingMode = config.mode;

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
    intentPhase: 'admission_intent' | 'pre_intent' | 'interpretation_intent',
    resultPhase: 'admission_result' | 'pre_result' | 'interpretation_result',
    intent: Record<string, unknown>,
    questionKeys: readonly string[],
    /** Applies the gate's policy and returns the closed decision fields to record (JG5-06 accounting). */
    decide: (outcome: JevOutcome) => Record<string, unknown>,
  ): Promise<{ outcome: JevOutcome } | { blocked: ErrorCode }> => {
    const requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    // B2/T7: one id per gate call, written to both records, so accounting joins an intent to its own result. Gate A
    // has no tool_use_id and `invocation_id` is per record, so neither of those can carry the pairing.
    const requestId = randomUUID();
    if (requestBytes > MAX_REQUEST_BYTES) {
      trace?.write(resultPhase, { ...base, ...intent, request_id: requestId, attempted: false, known_not_sent: true, skip_code: 'request_too_large', request_bytes: requestBytes });
      return { blocked: 'request_too_large' };
    }
    if (deps.signal?.aborted) return { blocked: 'aborted' };
    if (traceDir) {
      if (!trace) return { blocked: 'trace_intent_failed' };
      const written = trace.write(intentPhase, { ...base, ...intent, request_id: requestId, request_bytes: requestBytes });
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
      request_id: requestId,
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
      trace?.write('admission_result', { ...base, attempted: false, known_not_sent: true, decision: { shape: 'direct', decided: false, reason: 'prompt_id_absent', changed_default: false } });
      return emitContext('UserPromptSubmit', renderDirectGuidance(mode), 'prompt_id_absent');
    }

    let shape: ExecutionShape = 'direct';
    let reason: ErrorCode | null = null;
    let confidence: number | null = null;
    // A16: the forced control arm starts an orchestrated job in either mode without asking Gate A; B still runs.
    const forced = deps.env['JEV_GATE_EXPERIMENT_ADMISSION'] === 'orchestrated';

    /**
     * T2: this turn's identity is registered before any network call, and the shape is written back afterwards only
     * while it is still the current turn. A slow admission that finishes after a newer prompt arrived therefore has
     * nothing left to overwrite. Until it is written back the generation is direct, which guards nothing.
     */
    let superseded = false;
    const registered = updateJob(deps.env, sessionId, (prev) => {
      const change = newGeneration(prev, sessionId, promptId, 'direct');
      superseded = change.superseded;
      return forced ? { ...change.state, current: { ...change.state.current, forced: true as const } } : change.state;
    });
    // Without durable state there is no guard and no plan, so the turn falls back to native behavior.
    if (!registered.ok) return emitContext('UserPromptSubmit', renderDirectGuidance(mode), registered.code);

    /**
     * Decision 1 of the depth gate: how deep the session already is is read from the host's transcript, never asked of
     * Jev, and it is read before Gate A rather than after, so a shallow prompt costs no request at all. The same
     * number is written to every admission_result record below, which is how a bench case proves it primed the
     * session before the job prompt.
     */
    const depth: DepthReading = readSessionDepth(input.transcript_path);
    const contextTokens = depth.ok ? depth.tokens : null;
    const depthFacts = { context_tokens: contextTokens, context_depth_read: { bytes: depth.bytesRead, duration_ms: depth.durationMs } };
    // The forced arm is the bench control variable and is deliberately not floored: it is the only evidence that
    // exists for what orchestration costs at a given depth, and flooring it would erase the shallow half.
    const belowFloor = !forced && config.delegationDepthFloor > 0 && depth.ok && depth.tokens < config.delegationDepthFloor;
    const depthUnreadable = !forced && config.delegationDepthFloor > 0 && !depth.ok;

    if (forced) {
      shape = 'orchestrated';
      reason = mode === 'auto' ? 'admission_forced' : null;
      trace?.write('admission_result', {
        ...base,
        ...depthFacts,
        attempted: false,
        known_not_sent: true,
        forced: true,
        // A16: a forced generation is the bench control variable, not a Jev decision, so it never counts as influence.
        decision: { shape, decided: false, reason: mode === 'auto' ? 'admission_forced' : 'mode_native', changed_default: false },
      });
    } else if (mode === 'native') {
      // A9: the control arm initializes the same state and guard as auto; only the Jev calls differ.
      trace?.write('admission_result', { ...base, ...depthFacts, attempted: false, known_not_sent: true, forced: false, decision: { shape, decided: false, reason: 'mode_native', changed_default: false } });
    } else if (!apiKey) {
      reason = 'key_missing';
      trace?.write('admission_result', { ...base, ...depthFacts, attempted: false, known_not_sent: true, decision: { shape: 'direct', decided: false, reason, changed_default: false } });
    } else if (depthUnreadable || belowFloor) {
      // Not knowing the depth is treated as being below it: without the number, the cheaper shape is the native one.
      reason = belowFloor ? 'depth_below_floor' : 'depth_unknown';
      trace?.write('admission_result', {
        ...base,
        ...depthFacts,
        attempted: false,
        known_not_sent: true,
        forced: false,
        depth_floor: config.delegationDepthFloor,
        decision: { shape: 'direct', decided: false, reason, changed_default: false },
      });
    } else {
      /**
       * Decision 2: the atomic shape asks read-offs and composes them here as vetoes. It never consults
       * `admissionConfidenceFloor`, as atomic Gate B never consults `routeConfidenceFloor`; the depth test it applies
       * is the same one the branch above already passed, so on this path it can only agree.
       */
      const atomicAdmission = config.admissionQuestionShape === 'atomic';
      const admissionKeys: string[] = atomicAdmission ? Object.keys(ADMISSION_FACT_QUESTIONS) : ['execution'];
      // The explicit return type is what lets one call site carry both shapes: callGate cannot infer Q from a union.
      const admissionRequest = (): JevRequest<AdmissionState, Record<string, unknown>> =>
        atomicAdmission ? buildAtomicAdmissionRequest(prompt, config) : buildAdmissionRequest(prompt, config);
      let admitted: AdmissionDecision | null = null;
      const gate = await callGate(
        admissionRequest(),
        'admission_intent',
        'admission_result',
        { prompt_len: prompt.length, prompt_sha256: sha256(prompt), ...depthFacts, depth_floor: config.delegationDepthFloor },
        admissionKeys,
        (outcome) => {
          if (!outcome.ok) return { forced: false, decision: { shape: 'direct', decided: false, reason: outcome.code, changed_default: false } };
          admitted = atomicAdmission
            ? decideAdmissionAtomic(outcome.response.answers, contextTokens, config.delegationDepthFloor)
            : decideAdmission(outcome.response.answers, config.admissionConfidenceFloor);
          // A17 item 7: without Jev this turn would have been one native conversation.
          return {
            forced: false,
            decision: { shape: admitted.shape, decided: admitted.decided, reason: admitted.reason, changed_default: admitted.decided && admitted.shape === 'orchestrated' },
            // A21: recorded beside the decision, never inside it. `applied: false` is the whole point of the field:
            // the configured `admittedShape` still decides, and this says what the request asked for so that a later
            // run can ask whether following it would have been better.
            ...(atomicAdmission ? { recommendation: shapeRecommendation(outcome.response.answers) } : {}),
          };
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

    if (shape === 'direct') return emitContext('UserPromptSubmit', renderDirectGuidance(mode), reason);
    // A17: an orchestrated turn keeps its request, because every worker contract downstream is a paraphrase of it and
    // the worker is told the user's own words come first. Stored whole or not at all -- never truncated into a
    // half-specification that reads as complete.
    const carriedRequest = Buffer.byteLength(prompt, 'utf8') <= REQUEST_MAX_BYTES ? prompt : null;
    let stale = false;
    const applied = updateJob(deps.env, sessionId, (prev) => {
      if (!prev || prev.current.prompt_id !== promptId) {
        stale = true;
        return null;
      }
      // A19: the execution shape is fixed at admission from the config this turn loaded, so a config edit mid-job
      // cannot change what a running generation is.
      const next = { ...prev.current, shape, request: carriedRequest };
      return { ...prev, current: config.admittedShape === 'single' ? { ...next, execution: 'single' as const } : next };
    });
    // A newer prompt owns the session now; this turn does not get to turn orchestration on behind it.
    if (stale) return emitContext('UserPromptSubmit', renderDirectGuidance(mode), 'generation_changed');
    if (!applied.ok) return emitContext('UserPromptSubmit', renderDirectGuidance(mode), applied.code);
    if (config.admittedShape === 'single') return emitContext('UserPromptSubmit', renderSingleGuidance({ mode, confidence, superseded }), reason);
    return emitContext('UserPromptSubmit', renderOrchestrationGuidance({ mode, confidence, superseded, maxParallelWorkers: config.maxParallelWorkers }), reason);
  };

  // ---------------------------------------------------------------- PreToolUse

  /**
   * T2: after an await, the turn, the plan revision and this call's own reservation are re-checked inside the lock.
   * A read taken before the network call proves nothing about the state that exists when the answer arrives, and a
   * lock this process could not take is not a confirmation either, so both fail closed.
   */
  const confirmOwnership = (sessionId: string, gen: JobGeneration, rev: number | null, toolUseId: string): boolean => {
    let mine = false;
    updateJob(deps.env, sessionId, (prev) => {
      mine =
        prev !== null &&
        prev.current.prompt_id === gen.prompt_id &&
        (prev.current.plan?.rev ?? null) === rev &&
        own(prev.current.active, toolUseId) !== undefined;
      return null;
    });
    return mine;
  };

  const plannerPatch = async (gen: JobGeneration, sessionId: string, eligibility: Extract<Eligibility, { eligible: true }>): Promise<HookResult> => {
    const composed = eligibility.prompt;
    // A18: the planner call gets the request the plan is written from, and on a replan the revision it is revising.
    // Observed 2026-09-19 (`v5-job2-orbit` r1): the coordinator's replan brief was 771 characters of fix instruction,
    // and the fresh planner read the repository's existing tests as the specification. The drop order is A17's: the
    // plan in force goes first, the request last, and each leaves a visible marker rather than reading as absent.
    let carriedRequest: string | 'omitted' | null = gen.request ?? (gen.shape === 'orchestrated' ? 'omitted' : null);
    let carriedPlan: PlanInForceSummary | 'omitted' | null = gen.plan === null || gen.plan === undefined ? null : planInForceSummary(gen.plan);
    let plannerPrompt = composePlannerPrompt(composed, carriedRequest, carriedPlan);
    if (Buffer.byteLength(plannerPrompt, 'utf8') > MAX_COMPOSED_BYTES && carriedPlan !== null) {
      carriedPlan = 'omitted';
      plannerPrompt = composePlannerPrompt(composed, carriedRequest, carriedPlan);
    }
    if (Buffer.byteLength(plannerPrompt, 'utf8') > MAX_COMPOSED_BYTES && carriedRequest !== null && carriedRequest !== 'omitted') {
      carriedRequest = 'omitted';
      plannerPrompt = composePlannerPrompt(composed, carriedRequest, carriedPlan);
    }
    let tier = config.plannerDefaultTier;
    let code: ErrorCode | null = null;
    if (apiKey) {
      let routed: PlannerRouteDecision | null = null;
      // A18: the state field this fills is named `request`, and it was being given the coordinator's brief. What
      // decides a planning tier is how hard the job is, and the job is the request the plan is written from -- the
      // same correction the single path needed. Observed 2026-09-19 (`v5-job2-orbit` r1): the replan brief was 771
      // characters of fix instruction, so the tier for replanning a whole job was chosen from a patch note.
      const routedRequest = carriedRequest !== null && carriedRequest !== 'omitted' ? carriedRequest : composed;
      const gate = await callGate(
        buildPlannerRouteRequest(routedRequest, config),
        'pre_intent',
        'pre_result',
        { role: 'planner', tool_input: summarizeToolInput(eligibility.input), default_tier: config.plannerDefaultTier },
        ['planning_tier'],
        (outcome) => {
          // The model is recorded, not left to be reconstructed from the tier: a reader of a stored trace has no way
          // to know which `models` map was in force when it was written, and the hook knows exactly what it asked for.
          if (!outcome.ok) return { decision: { action: 'patch', tier: config.plannerDefaultTier, reason: outcome.code, changed_default: false, model: config.models[config.plannerDefaultTier] } };
          routed = decidePlannerRoute(outcome.response.answers, config.routeConfidenceFloor, config.plannerDefaultTier);
          return { decision: { action: routed.action, tier: routed.tier, reason: routed.reason, changed_default: routed.tier !== config.plannerDefaultTier, model: config.models[routed.tier] } };
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
    // T2: a prompt that arrived during the call replaces this generation. The call is refused outright rather than
    // passed through unpatched: it belongs to a plan that is no longer in force.
    if (!confirmOwnership(sessionId, gen, gen.plan?.rev ?? null, eligibility.toolUseId)) {
      return emitDeny('stale_generation', renderDispatchDeny('stale_generation'), null);
    }
    updateJob(deps.env, sessionId, (prev) => (prev && prev.current.prompt_id === gen.prompt_id ? { ...prev, current: { ...prev.current, planner_tier: tier } } : null));
    return emitPatch(eligibility.input, { subagent_type: agentForTier('planner', tier), model: config.models[tier], prompt: plannerPrompt }, code);
  };

  /** A4/T4: every reason a planner call may not start now. Run on the pre-lock read and again under the reservation lock. */
  const plannerConflict = (g: JobGeneration): { reason: DenyReason; text: string } | null => {
    // T4: one planner per generation. A second one would race the first over the same plan revision.
    if (activePlanners(g).length > 0) return { reason: 'planner_active', text: renderDispatchDeny('planner_active') };
    // A3: draining first keeps a replan from racing the workers whose receipts it would invalidate.
    if (activeWorkers(g).length > 0) return { reason: 'workers_active', text: renderDispatchDeny('workers_active') };
    const kind: BoundKind = g.plan ? 'replan' : 'planner';
    if (!boundExhausted(g, kind, null)) return null;
    // A7: an exhausted replan bound leaves an accepted revision in force, so the text says what can still be dispatched.
    // Only an exhausted planner bound leaves nothing to dispatch, and there reporting the blocker is all that is left.
    const text = g.plan
      ? renderReplanBoundExhausted(g.plan.rev, readyForDispatch(g), config.maxParallelWorkers)
      : renderDispatchDeny('bounds_exhausted', kind);
    return { reason: 'bounds_exhausted', text };
  };

  const handlePlanner = async (gen: JobGeneration, sessionId: string, eligibility: Extract<Eligibility, { eligible: true }>): Promise<HookResult> => {
    // A5: a pin bypasses tier selection only; a pin outside the configured strong models is a visible conflict.
    if (eligibility.pinned) {
      const pinned = str(eligibility.input['model']);
      if (pinned !== config.models.deep && pinned !== config.models.frontier) {
        return emitDeny('planner_pin_conflict', renderDispatchDeny('planner_pin_conflict'), null);
      }
    }
    const conflict = plannerConflict(gen);
    if (conflict) return emitDeny(conflict.reason, conflict.text, null);
    // Narrowing sees only the initial null, so the reason and its text are held apart rather than read off one object.
    let raced: DenyReason | null = null;
    let racedText = '';
    const reserved = updateJob(deps.env, sessionId, (prev) => {
      // A planner dispatch is also the recovery path from missing or unreadable state, and the point where a
      // coordinator-initiated job becomes orchestrated. A2: a generation without a prompt identity is never guarded.
      const current = prev?.current ?? recoveredGeneration();
      // T4: the counts, the phase, the active workers and any other planner are re-checked here, not only pre-lock.
      const again = plannerConflict(current);
      if (again) {
        raced = again.reason;
        racedText = again.text;
        return null;
      }
      const boundKind: BoundKind = current.plan ? 'replan' : 'planner';
      const counted = countAttempt(current, boundKind, null);
      const shape: ExecutionShape = current.prompt_id === null ? 'direct' : 'orchestrated';
      const next = reserve({ ...counted, phase: 'planning', shape }, eligibility.toolUseId, {
        role: 'planner',
        taskId: null,
        contractHash: null,
        rev: null,
        tier: null,
        attempt: 1,
        deliverables: [],
      });
      return { version: 5, session_id: sessionId, updated_at: '', current: next, history: prev?.history ?? [] };
    });
    if (!reserved.ok) return preserve(reserved.code);
    if (raced !== null) return emitDeny(raced, racedText, null);
    // A5: a pin bypasses tier selection, so the call is left exactly as the coordinator made it.
    if (eligibility.pinned) return preserve('pinned');
    if (mode === 'native') return preserve('mode_native');
    return plannerPatch(reserved.value?.current ?? gen, sessionId, eligibility);
  };

  /** A4/T1/T2/T5: every reason a ready task may still not be dispatched now. Run pre-lock and again under the lock. */
  const dispatchConflict = (g: JobGeneration, plan: Plan, task: PlannedTask, attempt: number | null): { reason: DenyReason; detail: string } | null => {
    const running = activeTaskIds(g);
    // T1: a dependency that is accepted but running again has no settled result, so a past accept does not cover it.
    const missingDeps = task.depends_on.filter((dep) => {
      const depTask = plan.tasks.find((t) => t.id === dep);
      return !depTask || running.has(dep) || acceptedReceipt(g.receipts, depTask) === null;
    });
    if (missingDeps.length) return { reason: 'deps_incomplete', detail: missingDeps.join(', ') };
    // T2: an active writer whose termination was never observed is refused a replacement, rework or not. Deleting a
    // reservation is bookkeeping, not a stopped process, and this hook cannot stop one.
    if (running.has(task.id)) return { reason: 'task_active', detail: task.id };
    if (attempt === null && acceptedReceipt(g.receipts, task)) return { reason: 'task_accepted', detail: task.id };
    // T1: attempt=<n> is text the coordinator wrote. The counted attempts decide which attempt this really is.
    const next = (own(g.attempts.tasks, task.id) ?? 0) + 1;
    if (attempt !== null && attempt !== next) return { reason: 'attempt_mismatch', detail: `marker attempt=${attempt}, next attempt=${next}` };
    if (boundExhausted(g, 'task', task.id)) return { reason: 'bounds_exhausted', detail: task.id };
    // T1: reworking a predecessor under a running dependent moves the contract that dependent is already working to.
    if (attempt !== null) {
      const busy = [...dependentsOf(plan, task.id)].filter((id) => running.has(id));
      if (busy.length) return { reason: 'dependent_active', detail: busy.join(', ') };
    }
    // T5: paths are compared normalized, so src/t1.ts and src/./t1.ts are one file and an unresolvable path is shared.
    const claimed = new Set(activeDeliverables(g, task.id).map(normalizeDeliverable));
    const overlap = deliverableOverlap(task.deliverables, claimed);
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
    const conflict = dispatchConflict(gen, plan, task, marker.attempt);
    if (conflict) return emitDeny(conflict.reason, renderDispatchDeny(conflict.reason, conflict.detail), null);

    const predecessors = predecessorSummaries(task, gen);
    // A17/T9: a rework carries this task's own failed attempt, under the contract now in force, so the upgrade gate
    // and the worker both see the observed failure instead of the same text twice.
    const priorAttempt = marker.attempt !== null ? priorAttemptSummary(gen.receipts, task) : null;
    // The route note is part of what the worker receives, so it counts against the same bound.
    const totalBytes = (text: string): number => Buffer.byteLength(text, 'utf8') + ROUTE_NOTE_MAX_BYTES;
    let carried: PriorAttemptSummary | 'omitted' | null = priorAttempt;
    // A17: the request outranks the contract, so it is the last thing dropped -- this task's own failed attempt goes
    // first. Both leave a visible marker; neither is passed off as absent.
    // An orchestrated generation was started by a request, so a missing one was not carried rather than absent: it is
    // marked, not left to read as though the contract were the whole of what was asked. State written before A17 lands
    // here too, and says the same true thing.
    let carriedRequest: string | 'omitted' | null = gen.request ?? (gen.shape === 'orchestrated' ? 'omitted' : null);
    let composed = composeTaskPrompt(eligibility.prompt, task, plan.constraints, predecessors, carried, carriedRequest);
    if (totalBytes(composed) > MAX_COMPOSED_BYTES && priorAttempt !== null) {
      // T9: evidence that does not fit is dropped with a visible marker, never passed off as a complete input.
      carried = 'omitted';
      composed = composeTaskPrompt(eligibility.prompt, task, plan.constraints, predecessors, carried, carriedRequest);
    }
    if (totalBytes(composed) > MAX_COMPOSED_BYTES && carriedRequest !== null && carriedRequest !== 'omitted') {
      carriedRequest = 'omitted';
      composed = composeTaskPrompt(eligibility.prompt, task, plan.constraints, predecessors, carried, carriedRequest);
    }
    if (totalBytes(composed) > MAX_COMPOSED_BYTES) {
      return emitDeny('composed_too_large', renderDispatchDeny('composed_too_large', `${totalBytes(composed)} bytes`), null);
    }

    // A4: the reservation is taken before any HTTP call, and the conflict checks are re-run under the lock,
    // so two dispatches in one assistant message cannot both pass on the same pre-lock snapshot.
    const attempt = marker.attempt ?? 1;
    let raced: DenyReason | null = null;
    const reserved = updateJob(deps.env, sessionId, (prev) => {
      if (!prev || prev.current.prompt_id !== gen.prompt_id || prev.current.plan?.rev !== plan.rev) {
        raced = 'stale_generation';
        return null;
      }
      const again = dispatchConflict(prev.current, plan, task, marker.attempt);
      if (again) {
        raced = again.reason;
        return null;
      }
      const counted = countAttempt(prev.current, 'task', task.id);
      const next = reserve(counted, eligibility.toolUseId, {
        role: 'worker',
        taskId: task.id,
        contractHash: task.contract_hash,
        rev: plan.rev,
        tier: eligibility.tier,
        attempt,
        deliverables: task.deliverables,
      });
      return { ...prev, current: next };
    });
    if (!reserved.ok) return preserve(reserved.code);
    if (raced !== null) return emitDeny(raced, renderDispatchDeny(raced), null);

    const note = (tier: Tier): string => renderRouteNote(tier);
    // A5: native, pinned, abstained and failed paths still receive the canonical contract; only the model is left alone.
    if (mode === 'native' || eligibility.pinned || !apiKey) {
      return emitPatch(eligibility.input, { prompt: composed + note(eligibility.tier) }, mode === 'native' ? 'mode_native' : eligibility.pinned ? 'pinned' : 'key_missing');
    }
    let routed: WorkerRouteDecision | null = null;
    const gate = await callGate(
      // A20: the worker will read the brief, the request, the contract and any prior attempt. Every one of those is a
      // field of this state except the request, which was the one that says what the work is for.
      routeRequest(task, plan.constraints, predecessors, eligibility.prompt, eligibility.tier, priorAttempt, carriedRequest),
      'pre_intent',
      'pre_result',
      {
        role: 'worker',
        task_id: task.id,
        rev: plan.rev,
        called_tier: eligibility.tier,
        attempt,
        has_prior_attempt: priorAttempt !== null,
        prior_attempt_omitted: carried === 'omitted',
        tool_input: summarizeToolInput(eligibility.input),
      },
      routeAnswerKeys(priorAttempt !== null),
      (outcome) => {
        // A preserve keeps the model the coordinator called, which the hook never names, so the recorded model is
        // null there rather than the tier's model -- the two are not the same claim.
        if (!outcome.ok) return { decision: { action: 'preserve', tier: eligibility.tier, reason: outcome.code, changed_default: false, model: null } };
        routed = routeDecision(outcome.response.answers, eligibility.tier);
        // A17 item 7: without Jev this dispatch would have run on the profile the coordinator called.
        return {
          decision: { action: routed.action, tier: routed.tier, reason: routed.reason, changed_default: routed.action === 'patch' && routed.tier !== eligibility.tier, model: routed.action === 'patch' ? config.models[routed.tier] : null },
          // A22: recorded on a rework only, and read by no policy. The tier this dispatch got was decided by the
          // facts above; this says what the previous attempt reported was wrong with it.
          ...(atomicRoute && priorAttempt !== null ? { prior_failure: priorFailureClassification(outcome.response.answers) } : {}),
        };
      },
    );
    // T2: the router failing is a valid call that keeps its profile; the turn moving on is a call that must not run.
    if (!confirmOwnership(sessionId, gen, plan.rev, eligibility.toolUseId)) {
      return emitDeny('stale_generation', renderDispatchDeny('stale_generation'), null);
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

  /**
   * Gate B in whichever shape the config selects. `composite` is the shipped five-way choice; `atomic` fans the same
   * judgement into read-off questions and composes them in code. The answer keys the trace records differ with the
   * shape, so an observation says which questions were actually asked.
   */
  const atomicRoute = config.routeQuestionShape === 'atomic';
  /** A22: the prior-failure facts exist only on a rework, so the whitelist that records answers has to follow. */
  const routeAnswerKeys = (hasPrior: boolean): string[] =>
    atomicRoute ? [...Object.keys(WORKER_FACT_QUESTIONS), ...(hasPrior ? Object.keys(PRIOR_FAILURE_FACT_QUESTIONS) : [])] : ['route', 'upgrade_basis'];
  const routeRequest = (
    task: PlannedTask,
    constraints: string[],
    predecessors: Parameters<typeof buildWorkerRouteRequest>[2],
    prompt: string,
    tier: Tier,
    prior: Parameters<typeof buildWorkerRouteRequest>[6] = null,
    request: string | 'omitted' | null = null,
    // Widened on purpose: the two shapes carry different question sets, and callGate is indifferent to which.
  ): JevRequest<WorkerRouteState, Record<string, unknown>> => {
    const build = (req: string | 'omitted' | null): JevRequest<WorkerRouteState, Record<string, unknown>> =>
      atomicRoute
        ? buildAtomicWorkerRouteRequest(task, constraints, predecessors, prompt, tier, config, prior, req)
        : buildWorkerRouteRequest(task, constraints, predecessors, prompt, tier, config, prior, req);
    const built = build(request);
    /**
     * A20/T9: carrying the request can push a dispatch over the gate's own bound, where `callGate` would refuse the
     * call outright and the dispatch would keep the coordinator's tier. Dropping the request with its marker leaves a
     * gate that still routes on the contract, which is what it had before this field existed, and says that it is
     * reading a packet the worker is not. The size that decides this is the gate's, not the worker's: the worker's
     * copy has already been composed under its own bound.
     */
    if (typeof request !== 'string' || Buffer.byteLength(JSON.stringify(built), 'utf8') <= MAX_REQUEST_BYTES) return built;
    return build('omitted');
  };
  const routeDecision = (answers: Record<string, unknown>, tier: Tier): WorkerRouteDecision =>
    atomicRoute ? decideWorkerRouteAtomic(answers, tier) : decideWorkerRoute(answers, config.routeConfidenceFloor, tier);

  /** A direct-shape owned worker call is an ad-hoc task: routed V4-style in auto, untouched in native. */
  const handleAdhocWorker = async (
    eligibility: Extract<Eligibility, { eligible: true }>,
    // A19: set only on the single-executor path, where the request is the task rather than the source of a contract.
    carriedRequest: string | 'omitted' | null = null,
    // A19: present on that same path, so the one dispatch this shape makes is reserved and leaves a receipt behind it.
    single: { sessionId: string; gen: JobGeneration } | null = null,
  ): Promise<HookResult> => {
    /**
     * A19/T9: the worker packet is prepared before anything on this path can return, so a routing outcome decides the
     * model and nothing else. `carriedRequest` is set exactly on the single-executor path, where the request is the
     * task rather than the source of a contract, and the coordinator is told the hook appends it verbatim. Composing
     * after the routing checks meant every preserve reason -- native mode, a pin, a missing key, a blocked or failed
     * gate, an unreadable answer -- dispatched a worker with the brief alone and no statement of the work.
     */
    let carried: string | 'omitted' | null = carriedRequest;
    let composed = composeSingleWorkerPrompt(eligibility.prompt, carried);
    if (Buffer.byteLength(composed, 'utf8') + ROUTE_NOTE_MAX_BYTES > MAX_COMPOSED_BYTES && carried !== null && carried !== 'omitted') {
      // T9: a request that does not fit is dropped with a visible marker, never truncated into a half-specification.
      carried = 'omitted';
      composed = composeSingleWorkerPrompt(eligibility.prompt, carried);
    }
    // The note cannot point at a contract on a shape that has none, and the ad-hoc shape keeps the contract wording.
    const note = (tier: Tier): string => (carriedRequest === null ? renderRouteNote(tier) : renderSingleRouteNote(tier));
    /** A preserve leaves the model exactly as the coordinator called it. That is all it leaves alone. */
    const preserveAdhoc = (code: ErrorCode, tier: Tier = eligibility.tier): HookResult =>
      carriedRequest === null ? preserve(code) : emitPatch(eligibility.input, { prompt: composed + note(tier) }, code);
    if (single !== null) {
      // A4: reserved before any HTTP call, and before the routing outcome, so every single dispatch is recorded --
      // reserving only the patched dispatches was rejected: a preserved call still runs a worker, and would leave
      // the same gap this repairs for every preserve reason (native mode, a pinned call, a missing key, a failed gate).
      let stale = false;
      // A7/A19: the per-job task bound already governs how many times one task may be dispatched; the single path
      // counted its attempts without ever consulting it, so a reply this shape could not parse could be retried
      // without end. Reading the existing bound here applies the cap the hierarchy path already has rather than
      // introducing a second one, and the attempt that repaired a discarded reply on 2026-09-19 is still the
      // second, which this admits.
      let exhausted = false;
      // A4/T2: the hierarchy re-runs every dispatch conflict under the lock; this path ran none, so two Agent calls
      // in one assistant message both reserved and both dispatched. The single shape has one task, so the two that
      // can apply to it are the ones below: a writer already running it, and the configured worker cap.
      let conflict: { reason: DenyReason; detail: string } | null = null;
      const reserved = updateJob(deps.env, single.sessionId, (prev) => {
        if (!prev || prev.current.prompt_id !== single.gen.prompt_id || prev.current.execution !== 'single') {
          stale = true;
          return null;
        }
        if (boundExhausted(prev.current, 'task', SINGLE_TASK_ID)) {
          exhausted = true;
          return null;
        }
        // T2: deleting a reservation is bookkeeping, not a stopped process, so an unobserved writer blocks a second.
        const running = activeWorkers(prev.current);
        if (running.some((r) => r.task_id === SINGLE_TASK_ID)) {
          conflict = { reason: 'task_active', detail: SINGLE_TASK_ID };
          return null;
        }
        if (running.length >= config.maxParallelWorkers) {
          conflict = { reason: 'parallel_cap', detail: `${running.length}/${config.maxParallelWorkers}` };
          return null;
        }
        const counted = countAttempt(prev.current, 'task', SINGLE_TASK_ID);
        return {
          ...prev,
          current: reserve(counted, eligibility.toolUseId, {
            role: 'worker',
            taskId: SINGLE_TASK_ID,
            // A19: this shape has no contract, so the key its receipt closes on is the empty one, fixed at dispatch.
            contractHash: '',
            rev: null,
            tier: eligibility.tier,
            attempt: (own(prev.current.attempts.tasks, SINGLE_TASK_ID) ?? 0) + 1,
            deliverables: [],
          }),
        };
      });
      if (!reserved.ok) return preserveAdhoc(reserved.code);
      if (stale) return emitDeny('stale_generation', renderDispatchDeny('stale_generation'), null);
      if (exhausted) return emitDeny('bounds_exhausted', renderDispatchDeny('bounds_exhausted', SINGLE_TASK_ID), null);
      if (conflict !== null) {
        const c: { reason: DenyReason; detail: string } = conflict;
        return emitDeny(c.reason, renderDispatchDeny(c.reason, c.detail), null);
      }
    }
    if (mode === 'native') return preserveAdhoc('mode_native');
    if (eligibility.pinned) return preserveAdhoc('pinned');
    if (!apiKey) return preserveAdhoc('key_missing');
    // Document §7: an ad-hoc call has no plan, so spec, uncertainty and fully_specified are absent, which is unknown.
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
    // A19/A20: the brief is not the work on this shape -- the request is -- and the adhoc contract above is empty, so
    // without the request the gate classifies a covering note. It is sent as the field the worker receives it as
    // rather than in place of the brief: substituting one for the other hid half of the packet either way.
    const gate = await callGate(
      routeRequest(task, [], [], eligibility.prompt, eligibility.tier, null, carried),
      'pre_intent',
      'pre_result',
      { role: 'worker', task_id: 'adhoc', called_tier: eligibility.tier, tool_input: summarizeToolInput(eligibility.input) },
      routeAnswerKeys(false),
      (outcome) => {
        // A preserve keeps the model the coordinator called, which the hook never names, so the recorded model is
        // null there rather than the tier's model -- the two are not the same claim.
        if (!outcome.ok) return { decision: { action: 'preserve', tier: eligibility.tier, reason: outcome.code, changed_default: false, model: null } };
        routed = routeDecision(outcome.response.answers, eligibility.tier);
        return { decision: { action: routed.action, tier: routed.tier, reason: routed.reason, changed_default: routed.action === 'patch' && routed.tier !== eligibility.tier, model: routed.action === 'patch' ? config.models[routed.tier] : null } };
      },
    );
    // T2: the router failing is a valid call that keeps its profile; the turn moving on is a call that must not run.
    // The lock is not held across the HTTP call, so the generation this dispatch belongs to is re-confirmed here.
    if (single !== null && !confirmOwnership(single.sessionId, single.gen, null, eligibility.toolUseId)) {
      return emitDeny('stale_generation', renderDispatchDeny('stale_generation'), null);
    }
    if ('blocked' in gate) return preserveAdhoc(gate.blocked);
    if (!gate.outcome.ok) return preserveAdhoc(gate.outcome.code);
    if (routed === null) return preserveAdhoc('route_invalid');
    const decision: WorkerRouteDecision = routed;
    if (decision.action === 'preserve') return preserveAdhoc(decision.reason ?? 'route_invalid', decision.tier);
    return emitPatch(
      eligibility.input,
      { subagent_type: agentForTier('worker', decision.tier), model: config.models[decision.tier], prompt: composed + note(decision.tier) },
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
    // A19: the single-executor shape has no planner and no plan, so the planner is refused and the worker call is an
    // ad-hoc dispatch carrying the request this turn was admitted with.
    if (generation.execution === 'single') {
      if (eligibility.role === 'planner') return emitDeny('single_shape', renderDispatchDeny('single_shape'), null);
      return handleAdhocWorker(eligibility, generation.request ?? 'omitted', { sessionId, gen: generation });
    }
    return eligibility.role === 'planner' ? handlePlanner(generation, sessionId, eligibility) : handleWorker(generation, sessionId, eligibility);
  };

  // ---------------------------------------------------------------- PostToolUse

  /**
   * T4: the planner profile this job asked for and the model the host reports running are different facts. The
   * configured id is an alias, the host reports a concrete id, and an id this plugin does not recognize settles
   * nothing: it is recorded as unverified rather than counted as a strong planner that ran.
   */
  const plannerModelAgreement = (tier: JobGeneration['planner_tier'], observed: string | null): ModelAgreement => {
    if (tier === null || observed === null || observed.length === 0) return 'unverified';
    const seen = observed.toLowerCase();
    const named = Object.values(config.models).filter((id) => seen.includes(id.toLowerCase()));
    if (named.length !== 1) return 'unverified';
    return named[0] === config.models[tier] ? 'match' : 'mismatch';
  };

  const handlePlannerResult = async (sessionId: string, gen: JobGeneration, toolUseId: string): Promise<HookResult> => {
    const status = responseStatus(input.tool_response);
    const text = replyText(input.tool_response);
    const parsed = status === 'completed' ? parsePlannerReply(text, config.maxTasksPerPlan) : null;
    const agreement = plannerModelAgreement(gen.planner_tier, observedModel(input.tool_response));
    /**
     * A23: the one place a semantic discrepancy is still visible. Everything downstream -- the contract, the checks,
     * the receipt -- is derived from this plan, so a plan that quietly answers a different request than the user's is
     * confirmed by every later stage. The comparison happens here, between the reply parsing and the plan being
     * adopted, and it rejects nothing: a false objection that blocks a correct plan costs more than a missed one.
     *
     * It is the only extra HTTP call in the product, and it is in the one hook that made none. The plugin's hook
     * declarations give PostToolUse the same 5 s as PreToolUse, which is why the review's "two serial full-budget
     * calls do not fit one hook" does not apply here: this hook's budget is otherwise entirely unspent.
     */
    const candidate = parsed && parsed.ok && parsed.value.status === 'ready' ? parsed.value : null;
    let interpretation: PlanInterpretation | null = null;
    let interpreted = false;
    if (config.planInterpretation && candidate !== null && candidate.constraints.length > 0 && gen.request !== null && mode !== 'native' && apiKey) {
      interpreted = true;
      const built = buildPlanInterpretationRequest(gen.request, candidate.goal, candidate.constraints, candidate.tasks, config);
      await callGate(
        built.request,
        'interpretation_intent',
        'interpretation_result',
        { role: 'planner', planner_tier: gen.planner_tier, clauses: built.clauses.length, constraints: candidate.constraints.length, tasks: candidate.tasks.length },
        built.clauses.map((c) => c.id),
        (outcome) => {
          // A failed call leaves the plan unexamined, which is what every plan before this option existed had.
          if (!outcome.ok) return { interpretation: null, skip_code: outcome.code };
          interpretation = classifyInterpretation(outcome.response.answers, built.clauses, candidate.constraints.length);
          return { interpretation };
        },
      );
    }
    let context: string | null = null;
    const written = updateJob(deps.env, sessionId, (prev) => {
      if (!prev || prev.current.prompt_id !== gen.prompt_id) return null;
      // T2/A23: an await happened before this lock only when the plan was interpreted, so the reservation this result
      // closes is re-confirmed on that path alone. Without the call there is no window, and no recheck to pay for.
      if (interpreted && own(prev.current.active, toolUseId) === undefined) return null;
      let next = release(prev.current, toolUseId);
      next = { ...next, planner_model: agreement };
      const reply = parsed && parsed.ok ? parsed.value : null;
      if (reply !== null && reply.status === 'ready') {
        // The revision is taken under the lock, so a plan numbered during a race is still numbered correctly.
        const rev = (next.plan?.rev ?? 0) + 1;
        const tasks = reply.tasks.map((t) => ({ ...t, contract_hash: contractHash(t) }));
        const plan: Plan = {
          rev,
          goal: reply.goal,
          assumptions: reply.assumptions,
          constraints: reply.constraints,
          tasks,
          // T11: the graph is the fact; the planner's own number is recorded beside it and never rejects a plan.
          chain_depth: chainDepth(tasks),
          chain_depth_claimed: reply.chain_depth_claimed,
        };
        /**
         * T3: no completion receipt is reused for readiness across a plan revision. `contract_hash` identifies the
         * scheduling contract but not the implementation context a worker was actually given, and the plan's global
         * constraints are outside it entirely, so an identical hash under a changed plan is not evidence that the
         * previous result still satisfies the new contract. The trade-off is explicit: a replan redoes accepted work.
         * The receipts themselves are kept as history, never deleted.
         */
        const retired = next.receipts;
        next = { ...next, phase: 'planned', plan, receipts: [] };
        context =
          renderPlannedContext(rev, readyForDispatch(next), config.maxParallelWorkers) +
          (agreement === 'match' ? '' : renderPlannerModelNote(agreement));
        trace?.write('plan', {
          ...base,
          status,
          outcome: 'ready',
          rev,
          tasks: tasks.length,
          chain_depth: plan.chain_depth,
          chain_depth_claimed: plan.chain_depth_claimed,
          planner_tier: gen.planner_tier,
          planner_model: { requested: gen.planner_tier === null ? null : config.models[gen.planner_tier], observed: observedModel(input.tool_response), agreement },
          retired_receipts: retired.length,
          // A23: recorded beside the adopted plan, and read by nothing. `applied: false` is inside the value.
          ...(interpretation === null ? {} : { interpretation }),
        });
        const history = retired.length ? [{ ...prev.current, plan: null, active: {}, receipts: retired, outcome: 'superseded' as const }, ...prev.history].slice(0, MAX_HISTORY) : prev.history;
        return { ...prev, current: next, history };
      }
      /**
       * T4: a terminal planner result that is not a usable plan never leaves the job sitting in `planning` with only
       * the reservation cleared. It returns to a state the coordinator can act on: the revision already in force, a
       * retry while an attempt remains, or blocked with the reason.
       */
      const detail =
        reply === null
          ? parsed === null
            ? `the call reported status ${String(status)}`
            : parsed.ok === false
              ? parsed.error
              : 'no reply'
          : reply.status === 'blocked'
            ? reply.reason
            : reply.questions.join(' ');
      const label = parsed === null ? `status ${String(status)}` : reply === null ? 'an invalid reply' : reply.status;
      // A failed replan leaves the plan it tried to replace in force; only a job with no valid plan is downgraded.
      const inForce = next.plan;
      if (inForce !== null) {
        next = { ...next, phase: 'planned' };
        context = renderReplanProblem(label, detail, inForce.rev);
        trace?.write('plan', { ...base, status, outcome: label, phase: next.phase, replan_failed: true, planner_model: agreement });
        return { ...prev, current: next };
      }
      // A7: the first planner failure returns the job to admitted so the coordinator can retry once; the second blocks it.
      // The planner and replan bounds are separate counters, so a replan never consumes an initial planning attempt.
      const exhausted = boundExhausted(next, 'planner', null);
      next = { ...next, phase: exhausted ? 'blocked' : 'admitted' };
      context = renderPlannerProblem(label, exhausted ? `${detail} No planner attempts remain; report this to the user.` : detail);
      trace?.write('plan', { ...base, status, outcome: label, phase: next.phase, planner_model: agreement });
      return { ...prev, current: next };
    });
    if (!written.ok) return skip(written.code);
    return context === null ? skip() : emitContext('PostToolUse', context, null);
  };

  /**
   * A4/T1: a receipt is selected by the task id *and* the contract hash of the dispatch it closes, so the hash must be
   * the one the dispatch was reserved under rather than one the closing path picks. A reservation written before
   * `contract_hash` existed carries none; the plan in force is then the fallback, because an empty string there would
   * leave an in-flight hierarchy dispatch unclosable across an upgrade.
   */
  const closingHash = (reservation: Reservation, task: PlannedTask | null): string =>
    reservation.contract_hash ?? task?.contract_hash ?? '';

  const handleWorkerResult = (sessionId: string, gen: JobGeneration, toolUseId: string, reservation: Reservation): HookResult => {
    const taskId = reservation.task_id ?? '';
    const rev = reservation.rev ?? 0;
    const attempt = reservation.attempt;
    const task = gen.plan?.tasks.find((t) => t.id === taskId) ?? null;
    // A19: the single shape has no plan, so a missing task is what this path expects rather than a stale reference.
    const isSingle = gen.execution === 'single';
    const status = responseStatus(input.tool_response);
    const parsed = status === 'completed' ? parseWorkerReply(replyText(input.tool_response), { freeCheckIds: isSingle }) : null;
    let finalVerdict: Receipt['verdict'] = 'unknown';
    let reason: string | null = null;
    if (parsed === null) reason = `the call reported status ${String(status)}`;
    else if (!parsed.ok) {
      finalVerdict = 'invalid';
      reason = parsed.error;
    } else if (isSingle) {
      const reported = reportedSingleVerdict(parsed.value);
      finalVerdict = reported.verdict;
      reason = reported.reason;
    } else if (!task) {
      finalVerdict = 'invalid';
      reason = 'the task is no longer in the current plan';
    } else {
      const deterministic = deterministicVerdict(task, parsed.value);
      finalVerdict = deterministic.verdict;
      reason = deterministic.reason;
      // T11: no request is made here. A result past plain incompleteness comes from what the worker itself reported.
      if (deterministic.verdict === 'incomplete') finalVerdict = reportedRecovery(task, parsed.value) ?? 'incomplete';
    }

    let context: string | null = null;
    const written = updateJob(deps.env, sessionId, (prev) => {
      // A2: both the generation and the plan revision must still be the ones this result belongs to.
      if (!prev || prev.current.prompt_id !== gen.prompt_id || (prev.current.plan?.rev ?? null) !== (gen.plan?.rev ?? null)) return null;
      let next = release(prev.current, toolUseId);
      const receipt: Receipt = {
        task_id: taskId,
        contract_hash: closingHash(reservation, task),
        rev,
        attempt,
        tool_use_id: toolUseId,
        provenance: 'worker_reported',
        reply: parsed && parsed.ok ? parsed.value : null,
        verdict: finalVerdict,
        verdict_reason: reason,
        // T11: Gate C is not called, so nothing advises on a receipt any more; stored records may still carry one.
        advisory: null,
        observed_model: observedModel(input.tool_response),
        root_effort: input.effort ?? null,
        recorded_at: new Date().toISOString(),
      };
      // T1: the receipt is appended, so the latest attempt is the one that decides; earlier ones stay in the array.
      next = { ...next, receipts: [...next.receipts.filter((r) => r.tool_use_id !== toolUseId), receipt] };
      if (isSingle) {
        // A19: rework and replan are hierarchy verdicts; this path only ever produces the four below.
        const shown = finalVerdict === 'accept' || finalVerdict === 'invalid' || finalVerdict === 'unknown' ? finalVerdict : 'incomplete';
        context = renderSingleResult(shown, reason ?? '');
      } else if (finalVerdict === 'accept') context = renderWorkerAccepted(taskId, readyForDispatch(next), config.maxParallelWorkers);
      else if (finalVerdict === 'rework' || finalVerdict === 'replan') context = renderWorkerReported(taskId, finalVerdict, reason ?? '');
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
        advisory: null,
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
    if (reservation.role === 'planner') return await handlePlannerResult(sessionId, job.current, toolUseId);
    return handleWorkerResult(sessionId, job.current, toolUseId, reservation);
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
        const task = prev.current.plan?.tasks.find((t) => t.id === reservation.task_id) ?? null;
        const receipt: Receipt = {
          task_id: reservation.task_id ?? '',
          // T1: a rework that failed has to cover the accept it replaced, and `currentReceipt` matches on this hash.
          // Writing '' here left the failed attempt unselectable, so the old accept still read as the task's result.
          contract_hash: closingHash(reservation, task),
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
      // T1: completion needs every task accepted by its current attempt AND nothing still running. A worker that was
      // never observed to finish is not a finished job, whatever the receipt of an earlier attempt says.
      const allAccepted = gen.plan !== null && activeWorkers(gen).length === 0 && gen.plan.tasks.every((t) => acceptedReceipt(gen.receipts, t) !== null);
      // A19: the single shape has no plan to complete, so its completion is the latest receipt of the one dispatch it
      // makes. That receipt is the worker's own report (reportedSingleVerdict), so `completed` is a weaker statement
      // here than under a plan -- the difference lives in the receipt, which records what it was decided from.
      const singleDone =
        gen.execution === 'single' &&
        activeWorkers(gen).length === 0 &&
        (gen.receipts.filter((r) => r.task_id === SINGLE_TASK_ID).at(-1)?.verdict ?? null) === 'accept';
      outcome = gen.phase === 'blocked' ? 'blocked' : gen.shape === 'direct' || allAccepted || singleDone ? 'completed' : 'incomplete';
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
