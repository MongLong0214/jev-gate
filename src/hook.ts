import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { splitLossless } from './blocks.js';
import { checkEligibility, patchAgentInput, renderPreToolUseOutput, renderTaskSuffix, type AgentInput } from './brief.js';
import { loadConfig, type Env } from './config.js';
import { renderCoordinatorGuidance } from './coordinator.js';
import { buildTaskRequest, callJev, decideTask, MAX_REQUEST_BYTES } from './jev.js';
import { openTraceDir, type TraceWriter } from './trace.js';
import type { ChoiceAnswer, ErrorCode, HookInput, SkipCode } from './types.js';

export const MAX_STDIN_BYTES = 256 * 1024;

export interface HookDeps {
  stdin: AsyncIterable<Uint8Array | string>;
  env: Env;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  openTrace?: typeof openTraceDir;
}

/** skip: nothing to do; preserve: an Agent call was seen and left untouched; guidance/patch: one JSON object on stdout. */
export type HookResult =
  | { kind: 'skip' | 'preserve'; code: ErrorCode | null; stdout: null }
  | { kind: 'guidance' | 'patch'; code: null; stdout: string };

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
  for (const k of ['session_id', 'cwd', 'permission_mode', 'agent_id', 'agent_type', 'prompt', 'tool_name', 'tool_use_id', 'error'] as const) {
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

/** Only the documented Choice fields for the three known questions ever reach a trace. */
const whitelistAnswers = (answers: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const q of ['context', 'route', 'kind']) {
    const a = answers[q];
    if (!isRecord(a)) {
      out[q] = null;
      continue;
    }
    const probs = isRecord(a['probabilities']) ? Object.fromEntries(Object.entries(a['probabilities']).filter(([, v]) => typeof v === 'number').slice(0, 8)) : null;
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
    has_hint_marker: prompt !== null && prompt.includes('[Jev Gate task hint]'),
    control_keys: Object.keys(input).filter((k) => ['resume', 'agentId', 'agent_id', 'name', 'team_name', 'isolation', 'fork'].includes(k)),
  };
};

const isSlashCommand = (prompt: string): boolean => prompt.trimStart().startsWith('/');

/**
 * Event dispatch (#11). UserPromptSubmit: fixed guidance, Jev 0. PreToolUse(Agent): eligibility → at most one Jev
 * attempt → full-input patch or preserve. PostToolUse/Failure(Agent): opt-in observations only. Exit 0 always.
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
  const config = loaded.config;
  if (config.mode === 'off') return isAgentPre ? preserve('mode_off') : skip('mode_off');

  let trace: TraceWriter | null = null;
  let traceError: string | null = null;
  const traceDir = deps.env['JEV_GATE_TRACE_DIR'];
  if (traceDir) {
    const opened = (deps.openTrace ?? openTraceDir)(traceDir);
    if (opened.ok) trace = opened.writer;
    else traceError = opened.error;
  }
  const caller = { agent_id: input.agent_id ?? null, agent_type: input.agent_type ?? null };
  const base = { session_id: input.session_id ?? null, caller, tool_use_id: input.tool_use_id ?? null, mode: config.mode };

  if (input.hook_event_name === 'UserPromptSubmit') {
    const prompt = input.prompt;
    if (typeof prompt !== 'string' || prompt.trim().length === 0 || isSlashCommand(prompt) || caller.agent_id || caller.agent_type) return skip();
    const guidance = renderCoordinatorGuidance(config.mode, deps.env['JEV_GATE_EXPERIMENT_ALLOCATION']);
    trace?.write('prompt', { ...base, injected: true, experimental_allocation: Boolean(deps.env['JEV_GATE_EXPERIMENT_ALLOCATION']) && config.mode === 'native' });
    return { kind: 'guidance', code: null, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: guidance } }) };
  }

  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'Agent') {
    trace?.write('post', { ...base, tool_input: summarizeToolInput(input.tool_input), tool_response: whitelistToolResponse(input.tool_response), duration_ms: input.duration_ms ?? null });
    return skip();
  }
  if (input.hook_event_name === 'PostToolUseFailure' && input.tool_name === 'Agent') {
    const error = input.error ?? '';
    trace?.write('failure', { ...base, tool_input: summarizeToolInput(input.tool_input), error_first_line: error.split('\n')[0]?.slice(0, 200) ?? null, error_len: error.length, is_interrupt: input.is_interrupt ?? null, duration_ms: input.duration_ms ?? null });
    return skip();
  }
  if (!isAgentPre) return skip();

  // PreToolUse:Agent — everything below either patches or preserves the original input.
  const eligibility = checkEligibility(input, deps.env, config);
  const known = (code: SkipCode, extra: Record<string, unknown> = {}): HookResult => {
    trace?.write('pre_result', { ...base, tool_input: summarizeToolInput(input.tool_input), attempted: false, known_not_sent: true, skip_code: code, ...extra });
    return preserve(code);
  };
  if (!eligibility.eligible) return known(eligibility.code);
  const apiKey = deps.env['TYPESAFE_API_KEY'];
  if (!apiKey) return known('key_missing');
  const blocks = splitLossless(eligibility.prompt);
  const request = buildTaskRequest(eligibility.role, eligibility.description, blocks, config);
  const requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  if (requestBytes > MAX_REQUEST_BYTES) return known('request_too_large', { request_bytes: requestBytes });
  if (deps.signal?.aborted) return known('aborted');
  if (traceDir) {
    if (!trace) return known('trace_intent_failed', { trace_error: traceError });
    const intent = trace.write('pre_intent', { ...base, role: eligibility.role, tool_input: summarizeToolInput(eligibility.input), request_bytes: requestBytes, blocks: blocks.length });
    if (!intent.ok) return preserve('trace_intent_failed');
  }

  const outcome = await callJev(request, { apiKey, deadlineMs: config.requestDeadlineMs, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.signal ? { signal: deps.signal } : {}) });
  const result: Record<string, unknown> = {
    ...base,
    role: eligibility.role,
    tool_input: summarizeToolInput(eligibility.input),
    attempted: outcome.ok || outcome.code !== 'aborted' || outcome.durationMs > 0,
    http: { status: outcome.status, code: outcome.ok ? null : outcome.code, duration_ms: outcome.durationMs, request_bytes: requestBytes },
    jev: outcome.ok ? { model: outcome.response.model, usage: outcome.response.usage, response_bytes: outcome.response.bytes } : { model: null, usage: null, response_bytes: null },
    answers: outcome.ok ? whitelistAnswers(outcome.response.answers) : null,
    decision: null,
    patch: null,
  };
  if (!outcome.ok) {
    trace?.write('pre_result', result);
    return preserve(outcome.code);
  }
  const decision = decideTask(outcome.response.answers, config.routeConfidenceFloor);
  result['decision'] = { action: decision.action, tier: decision.tier, kind: decision.kind, reason: decision.reason };
  if (decision.action === 'preserve' || decision.tier === null) {
    trace?.write('pre_result', result);
    return preserve(decision.reason ?? 'route_invalid');
  }
  const model = config.models[decision.tier];
  const suffix = renderTaskSuffix(decision.kind);
  const updated: AgentInput = patchAgentInput(eligibility.input, model, suffix);
  const stdout = renderPreToolUseOutput(updated);
  result['patch'] = { model, suffix_bytes: Buffer.byteLength(suffix, 'utf8'), output_bytes: stdout === null ? null : Buffer.byteLength(stdout, 'utf8'), emitted: stdout !== null, prompt_sha256: sha256(String(updated['prompt'])) };
  trace?.write('pre_result', result);
  if (stdout === null) return preserve('output_too_large');
  return { kind: 'patch', code: null, stdout };
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
