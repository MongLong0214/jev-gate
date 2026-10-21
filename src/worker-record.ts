import { looksSecret } from './outbound-text.js';
import { CODEX_FAILURE_CATEGORIES } from './types.js';

type Rec = Record<string, unknown>;

/** #233: the closed Codex dispatch failure category, never the raw error. */
const CODEX_FAILURE: Record<string, string> = {
  preflight_conflict: '실행 전 점검 충돌', permissions_unavailable: '부모 권한 전달 불가', worktree_unavailable: 'Worktree 생성 불가', allocation_unavailable: '배정 모델·effort 사용 불가',
  cancelled: '시작 전 취소', reservation_unavailable: '실행 예약 기록 불가', native_start_rejected: 'Codex 워커 시작 거부',
  native_failed_turn: 'Codex 워커 턴 실패', interrupted: '워커 중단', termination_unconfirmed: '워커 종료 미확인 · 예약 유지',
};
export const codexFailureReason = (r: Rec): string | null => Object.hasOwn(CODEX_FAILURE, String(r['failure_category'])) ? CODEX_FAILURE[String(r['failure_category'])]! : null;
const WORKER_REASON: Record<string, string> = {
  invalid_reply: '워커 응답 형식 오류',
  superseded: '새 작업으로 교체됨',
  generation_changed: '새 작업으로 교체됨',
  no_reply: '워커 응답 없음',
  check_contradicted: '통과 보고 검사가 실행 기록에서 실패',
  check_unobserved: '통과 보고 검사의 실행 미관측',
  check_stale: '마지막 변경 전의 통과 기록',
  worker_blocked: '워커가 차단·재계획 보고',
  check_report: '필수 검사 보고 미충족',
  worker_result_unknown: '워커 결과 사유 미분류',
  worker_check_duplicate: '검사 중복 보고',
  worker_check_failed: '보고된 검사 실패',
  worker_check_not_run: '필수 검사 미실행',
  worker_checks_missing: '변경 후 검사 보고 없음',
  worker_checks_unverified: '검사 실행 확인 불가',
  worker_no_result: '워커 결과 미반환 · 예약 해제',
  worker_failed: '워커 실행 실패',
  worker_cancelled: '사용자가 워커 취소',
};
/** #232: the closed category of a refused or unreached verdict and its label. The recorded reason is free text that can quote a
 * reply, so only the engine's own wording is matched (src/plan.ts, src/verify.ts, src/hook.ts) and never shown. */
export const verdictReason = (verdict: string, v: unknown): [string, string] | null => {
  const reason = typeof v === 'string' ? v : '';
  if (Object.hasOwn(WORKER_REASON, reason)) return [reason, WORKER_REASON[reason]!];
  if (reason === 'the task is no longer in the current plan') return ['superseded', '새 작업으로 교체됨'];
  if (verdict === 'invalid') return ['invalid_reply', '워커 응답 형식 오류'];
  if (verdict === 'unknown' && /^the call (?:reported status|failed before)/.test(reason)) return ['no_reply', '워커 응답 없음'];
  if (/^check [^,]+(?:, [^,]+)* was reported pass, but its last run in the worker's own transcript failed$/.test(reason)) return ['check_contradicted', '통과 보고 검사가 실행 기록에서 실패'];
  if (/^check [^,]+(?:, [^,]+)* was reported pass, but the (?:worker's own transcript|last [0-9.]+ MiB of the worker's transcript) shows no passing run|^check [^,]+(?:, [^,]+)* was reported pass, but the worker's transcript could not be read/.test(reason)) return ['check_unobserved', '통과 보고 검사의 실행 미관측'];
  if (/^check .+: 마지막 관측 변경 이후의 검사 결과 필요$/.test(reason)) return ['check_stale', '마지막 변경 전의 통과 기록'];
  if (/^worker reported (?:status |blockers )/.test(reason)) return ['worker_blocked', '워커가 차단·재계획 보고'];
  if (/^(?:required check |unknown check id )|reported no passing check/.test(reason)) return ['check_report', '필수 검사 보고 미충족'];
  return reason ? ['worker_result_unknown', '워커 결과 사유 미분류'] : null;
};

/** Worker/native tool records carry metadata, never report bodies, commands, notes or failure prose. Also used by
 * legacy readers: a retained record is not permission to replay the text an older writer embedded in it. */
export const workerTraceData = (phase: string, body: Record<string, unknown>): Record<string, unknown> => {
  if (!['post', 'failure', 'dispatch', 'dispatch_denied', 'background_dispatch', 'background_launch', 'background_terminal', 'worktree_start', 'worktree_result'].includes(phase)) return body;
  const strings = new Set(['phase', 'host', 'mode', 'session_id', 'prompt_id', 'tool_use_id', 'worker_isolation', 'execution_prompt_id',
    'request_id', 'invocation_id', 'recording_id', 'written_at', 'agent_id', 'agent_type', 'task_id', 'subagent_type', 'role',
    'requested_tier', 'requested_model', 'resolved_model', 'root_effort', 'selection', 'job_state', 'root_fallback_reason',
    'tool_name', 'model', 'status', 'agentId', 'resolvedModel', 'modelsUsed', 'service_tier', 'accounting_scope',
    'basis', 'revision', 'reason', 'subscription_cost', 'branch', 'baseline', 'reservation_id', 'settlement_reason',
    'dispatch_failure', 'connection_failure', 'failure_stage', 'token', 'prompt_sha256', 'control_keys', 'coverage', 'event', 'routed_model']);
  const fields = new Set([...strings, 'version', 'loss_marker', 'caller', 'rev', 'attempt', 'pinned', 'matched', 'orphaned', 'owned',
    'accepted', 'changed_files_count', 'reported_checks', 'pass', 'fail', 'not_run', 'evidence_format_only', 'root_fallback', 'tool_input', 'tool_response',
    'has_model', 'run_in_background', 'prompt_len', 'prompt_sha256', 'control_keys', 'accounting', 'cost', 'usd', 'input', 'output',
    'cache_read', 'cache_creation', 'read', 'write', 'write5m', 'write1h', 'thinking', 'provider_reported_cost', 'totalDurationMs', 'totalToolUseCount', 'totalTokens', 'usage',
    'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'ephemeral_5m_input_tokens',
    'ephemeral_1h_input_tokens', 'thinking_tokens', 'duration_ms', 'is_interrupt', 'not_executed', 'release_unconfirmed', 'host_exited', 'ok']);
  const clean = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return strings.has(key) && /^[A-Za-z0-9_.:/+@-]{1,160}(?:\[[A-Za-z0-9_-]{1,16}\])?$/.test(value) && !looksSecret(value) ? value : null;
    if (Array.isArray(value)) return value.map(item => clean(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)).map(([key, item]) => [key, clean(item, key)]));
    return value;
  };
  const out = clean(body) as Record<string, unknown>;
  if ('verdict' in body) out['verdict'] = ['accept', 'incomplete', 'invalid', 'unknown', 'rework', 'replan'].includes(String(body['verdict'])) ? body['verdict'] : 'unknown';
  if ('status' in body) out['status'] = ['completed', 'failed', 'cancelled', 'interrupted', 'async_launched', 'running'].includes(String(body['status'])) ? body['status'] : 'unknown';
  if ('verdict_reason' in body) out['verdict_reason'] = verdictReason(String(body['verdict']), body['verdict_reason'])?.[0] ?? null;
  if ('failure_category' in body) out['failure_category'] = CODEX_FAILURE_CATEGORIES.includes(body['failure_category'] as typeof CODEX_FAILURE_CATEGORIES[number]) ? body['failure_category'] : 'worker_failed';
  if ('error_first_line' in body) {
    const value = body['error_first_line'];
    out['error_first_line'] = typeof value === 'string' && ([...CODEX_FAILURE_CATEGORIES, 'worker_failed', 'worker_cancelled', 'settlement_pending'].includes(value) || /^(?:(?:dispatch|collection)_(?:rpc_(?:closed|timeout|unavailable|rejected|write)|aborted|timeout|exception)|connection_(?:state_missing|unreachable|http_error|timeout|aborted|invalid_reply))$/.test(value)) ? value : 'worker_failed';
  }
  const verification = body['verification'];
  if (verification && typeof verification === 'object') {
    const v = verification as Record<string, unknown>;
    out['verification'] = { transcript: ['read', 'truncated', 'unavailable'].includes(String(v['transcript'])) ? v['transcript'] : 'unavailable',
      ...Object.fromEntries(['contradicted', 'unobserved', 'stale'].map(key => [key, Array.isArray(v[key]) ? v[key].map((id: unknown) => typeof id === 'string' && /^#[0-9]{1,4}$/.test(id) ? id : 'unmapped') : []])) };
  }
  return out;
};

