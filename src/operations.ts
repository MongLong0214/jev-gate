import { createHash } from 'node:crypto';
import { codexConnectionFailure, codexFailureReason, verdictReason } from './worker-record.js';
import { allocatedTraceRecords } from './explain.js';
import { codexOperations, codexRow, codexRunKey, codexSpanKey, firstRow } from './codex-operations.js';
import { failed, operationState } from './operation-state.js';
import { looksSecret } from './outbound-text.js';
import { memo } from './memo.js';
import { estimateJevCostUsd } from './bench/usage.js';
import { CODEX_CAPABILITIES, CODEX_PLUGIN_CAPABILITIES, type HostCapability, type Host } from './host-support.js';

/** A display model made only from named metadata fields. Raw prompts and source text never leave here. */
type Rec = Record<string, unknown>;
export type FeatureId = 'admission' | 'allocation' | 'workers' | 'router' | 'compact';
export type StepState = 'active' | 'done' | 'skipped' | 'error' | 'unconfirmed' | 'interrupted';
export type StepLane = 'jev' | 'policy' | 'host' | 'local';

export interface OperationStep {
  id: string;
  at: string;
  feature: FeatureId | 'connection';
  /** Lifecycle and preparation-only records do not establish a Jev decision or host response. */
  lifecycle?: boolean;
  /** Exact native child identity, when the lifecycle record supplies it. */
  agentId?: string;
  sessionId?: string;
  callId?: string;
  /** Recorded Gate A policy path, independent of request transmission and host completion. */
  executionPath?: 'direct' | 'orchestrated';
  state: StepState;
  lane: StepLane;
  title: string;
  summary: string;
  details: string[];
  /** Concrete recorded failure category; an effort mismatch is not a response-model mismatch. */
  issue?: 'request_model' | 'request_effort' | 'request_unconfirmed' | 'response_model' | 'jev' | 'host' | 'contract';
  /** The failure reason code the record names, such as `invalid_input` or `timeout`. */
  cause?: string;
  /** On a failure only: what later settled records of the same operation on the same host show now. The failure itself stays
   * recorded as it was; a later success never turns it into one, and nothing here claims a recovery. */
  impact?: { now: 'ongoing' | 'unknown' | 'later_ok'; lastAt: string; lastState: StepState };
  /** Worker results only (#232). Only an accept receipt is `accepted`; an incomplete, invalid, rework or replan receipt is `rejected`;
   * a receipt that reached no verdict is `unknown`; the host's own end of a call, which judges no contract, is `host_ended`. */
  outcome?: 'host_ended' | 'accepted' | 'rejected' | 'unknown';
  /** The task a contract receipt judged. A later accept of it in the same execution settles an earlier refusal. */
  task?: string;
  model?: { selected: string | null; observed: string | null; status: 'confirmed' | 'mismatch' | 'unobserved'; selectedEffort: string | null; observedEffort: string | null; forwardedEffort?: string | null; effortSource?: 'host_hook' | 'provider_request'; requestApplied?: boolean };
  routing?: { scope: 'root' | 'spawn' | 'child' | 'owned'; baseline: string | null; modelReason: string | null; effortReason: string | null; proposedModel?: string; probability?: number; threshold?: number };
  /** Timings are measured by the caller or paired recorded events, never estimated from usage. */
  durationMs?: number;
  /** Time between two settled records. A running step carries `startedAt` instead, and the page counts from it. */
  elapsedMs?: number;
  /** Native host spans store their explicit start; other records are end-stamped measurements. */
  startedAt?: string;
  judgements?: Array<{ question: string; value: string; confidence: number | null; probabilities: Array<{ label: string; value: number }> }>;
  /** The recorded exchange behind one measured Jev response. Every absent value stays null; cost is a list-price estimate, never a billed amount. */
  receipt?: JevReceipt;
}

export interface JevReceipt { status: number | null; code: string | null; model: string | null; input: number | null; output: number | null; costUsd: number | null; choice: string | null; confidence: number | null; threshold: number | null; direction: string | null }

export interface OperationRun {
  id: string;
  /** Host/session/turn correlation, hashed locally; absent when the source cannot establish it. */
  executionId?: string;
  host?: Host;
  title: string;
  source: 'gate' | 'router' | 'compact' | 'codex';
  mode: string;
  firstAt: string;
  lastAt: string;
  /** `attention` holds a failure that may still affect work; `past_error` only failures later records or their own cause settled. */
  state: 'active' | 'done' | 'attention' | 'past_error' | 'unconfirmed' | 'interrupted';
  steps: OperationStep[];
}

export interface FeatureView {
  id: FeatureId;
  label: string;
  count: number;
  lastAt: string | null;
  state: 'observed' | 'waiting' | 'unavailable' | 'unsupported';
  capability?: HostCapability;
}

export interface OperationsView {
  runs: OperationRun[];
  features: FeatureView[];
  feed: Array<OperationStep & { runId: string; runTitle: string; host?: Host | undefined }>;
  active: number;
  attention: number;
  /** Derived from recorded intent or explicit attempted result, not from an absent usage field. */
  requests: number;
  latency: { measured: number; p50: number | null; p95: number | null; fastest: number | null; latest: number | null; recent: Array<{ at: string; ms: number }>;
    /** Measured Jev responses whose record date is the local today, per host. Cost sums only responses with a recorded, priced model. */
    today: Partial<Record<Host, { calls: number; input: number; costUsd: number; unpriced: number }>> };
}

export interface ModRecord { at: string; component: 'router' | 'compact'; rec: Rec }

const FEATURES: Array<{ id: FeatureId; label: string }> = [
  { id: 'admission', label: 'Gate A · 실행 형태' },
  { id: 'allocation', label: 'Gate B · 등급 배정' },
  { id: 'workers', label: '워커 · 수락 검사' },
  { id: 'router', label: 'Router · 모델과 effort' },
  { id: 'compact', label: 'Compact · 문맥 압축' },
];
const TOKEN = /^[A-Za-z0-9_.:/+@-]{1,80}(?:\[[A-Za-z0-9_-]{1,16}\])?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const rec = (v: unknown): Rec | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Rec : null;
const field = (r: Rec | null, key: string): Rec | null => r ? rec(r[key]) : null;
// Metadata identifiers reject even truncated/embedded sk- fragments. Prose screening keeps prefix mentions and task-id usable.
const safeToken = memo((v: string): string | null => TOKEN.test(v) && !looksSecret(v) && !v.toLowerCase().includes('sk-') ? v : null);
const token = (v: unknown): string | null => typeof v === 'string' ? safeToken(v) : null;
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const iso = (v: unknown): string => typeof v === 'string' && ISO.test(v) ? v : '';
const list = (v: unknown, cap = 16): string[] => Array.isArray(v) ? v.slice(0, cap).map(token).filter((x): x is string => x !== null) : [];
const id = memo((v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12));
// Step texts repeat across the history; the kept builds share one copy of each.
const intern = memo((v: string): string => v);
// Same output as toLocaleString('en-US'), without building a formatter per call.
const EN = new Intl.NumberFormat('en-US');
const n = (v: number | null): string => v === null ? '?' : EN.format(Number(v.toFixed(2)));
const text = (...parts: Array<string | null | undefined | false>): string => parts.filter((x): x is string => typeof x === 'string' && x.length > 0).join(' · ');
const modelObservation = (selected: unknown, observed: unknown, selectedEffort?: unknown, observedEffort?: unknown, confirmation?: unknown, submission?: { value: unknown; source: 'host_hook' | 'provider_request' }): OperationStep['model'] => {
  const wanted = token(selected); const actual = token(observed);
  if (!wanted && !actual) return undefined;
  const family = (value: string) => /^(haiku|sonnet|opus)$/.test(value) ? value : /^claude-(haiku|sonnet|opus)(?:-|$)/.exec(value)?.[1];
  const matches = wanted && actual && (wanted === actual || /^(haiku|sonnet|opus)$/.test(wanted) && family(wanted) === family(actual));
  // Router owns exact variant and dated-alias identity checks. Older receipts fall back to literal/family matching.
  const status = !wanted || !actual || confirmation === 'unobserved' ? 'unobserved'
    : confirmation === 'confirmed' || confirmation === 'mismatch' ? confirmation : matches ? 'confirmed' : 'mismatch';
  return { selected: wanted, observed: actual, status, selectedEffort: token(selectedEffort), observedEffort: observedEffort === 'unknown' ? null : token(observedEffort), ...(submission ? { forwardedEffort: token(submission.value), effortSource: submission.source } : {}) };
};
const relation = (r: Rec): string[] => {
  const answers = field(r, 'answers');
  if (!answers) return [];
  return Object.entries(answers).slice(0, 10).flatMap(([key, raw]) => {
    const a = rec(raw);
    const name = token(key);
    if (!a || !name) return [];
    const choice = token(a['choice']);
    const score = number(a['score']);
    const noul = number(a['noul']);
    const conf = number(a['confidence']);
    const probs = field(a, 'probabilities');
    const distribution = probs ? Object.entries(probs).slice(0, 6).flatMap(([k, v]) => token(k) && number(v) !== null ? [`${k} ${Math.round((v as number) * 100)}%`] : []) : [];
    return [text(`${name}: ${choice ?? (score !== null ? `점수 ${n(score)}` : noul !== null ? `참 확률 ${Math.round(noul * 100)}%` : '응답')}`, conf === null ? null : `확신 ${Math.round(conf * 100)}%`, distribution.length ? distribution.join(' / ') : null)];
  });
};
const judgements = (r: Rec): OperationStep['judgements'] => {
  const answers = field(r, 'answers');
  if (!answers) return undefined;
  const out = Object.entries(answers).slice(0, 12).flatMap(([key, raw]) => {
    const a = rec(raw);
    const question = token(key);
    if (!question || !a) return [];
    const probabilities = field(a, 'probabilities');
    const choices = probabilities ? Object.entries(probabilities).slice(0, 10).flatMap(([label, value]) => {
      const safeLabel = token(label); const p = number(value);
      return safeLabel && p !== null && p >= 0 && p <= 1 ? [{ label: safeLabel, value: p }] : [];
    }) : [];
    const choice = token(a['choice']);
    const score = number(a['score']);
    const noul = number(a['noul']);
    const top = choices.reduce<{ label: string; value: number } | null>((a, c) => a && a.value >= c.value ? a : c, null);
    const value = choice ?? (score !== null ? `점수 ${n(score)}` : noul !== null ? `참 확률 ${Math.round(noul * 100)}%` : top?.label ?? '응답');
    const distribution = choices.length ? choices : noul !== null && noul >= 0 && noul <= 1 ? [{ label: '참', value: noul }, { label: '거짓', value: 1 - noul }] : [];
    return [{ question, value, confidence: number(a['confidence']), probabilities: distribution }];
  });
  return out.length ? out : undefined;
};
const jevReceipt = (status: number | null, code: string | null, model: string | null, usage: Rec | null, choice: string | null, confidence: number | null, threshold: number | null, direction: string | null): JevReceipt => {
  const input = number(usage?.['input_tokens'] ?? usage?.['input']); const output = number(usage?.['output_tokens'] ?? usage?.['output']);
  return { status, code, model, input, output, costUsd: estimateJevCostUsd(model, input), choice, confidence, threshold, direction };
};
const callDetails = (r: Rec): string[] => {
  if (r['known_not_sent'] === true || r['attempted'] === false) return [text('Jev 전송 없음', token(r['skip_code']))];
  if (r['attempted'] !== true && !String(r['phase']).endsWith('_intent')) return ['전송 여부 기록 없음'];
  const http = field(r, 'http');
  const jev = field(r, 'jev');
  const usage = field(jev, 'usage');
  const input = number(usage?.['input_tokens']);
  const output = number(usage?.['output_tokens']);
  return [text(
    'Jev 요청',
    http && number(http['status']) !== null ? `HTTP ${n(number(http['status']))}` : null,
    token(http?.['code']),
    http && number(http['duration_ms']) !== null ? `${n(number(http['duration_ms']))}ms` : null,
    token(jev?.['model']),
    input !== null || output !== null ? `입력 ${n(input)} / 출력 ${n(output)}` : '사용량 미기록',
  )];
};

export const traceFeature = (phase: string): FeatureId | null => {
  if (phase === 'codex_compact') return 'compact';
  if (phase === 'codex_model_request' || phase === 'codex_model_failure' || phase === 'codex_router_intent' || phase === 'codex_router_result' || phase === 'codex_router_skipped' || phase === 'codex_route_applied' || phase === 'codex_router_response') return 'router';
  if (phase.startsWith('admission_')) return 'admission';
  if (phase.startsWith('pre_')) return 'allocation';
  if (phase.startsWith('background_') || phase.startsWith('worktree_') || phase === 'dispatch_denied' || phase === 'dispatch' || phase === 'post' || phase === 'failure' || phase === 'stop') return 'workers';
  return null;
};
const traceTitle = (phase: string, r: Rec): string => ({
  codex_model_request: '모델 · 응답 대기', codex_model_failure: '모델 · 요청 실패',
  codex_router_intent: 'Router · Jev 요청', codex_router_result: 'Router · 턴 설정 결정', codex_router_skipped: 'Router · Jev 호출 생략', codex_router_response: 'Router · Codex 응답 관측', codex_route_applied: 'Router · Codex 요청 전송',
  admission_intent: 'Gate A · Jev 요청', admission_result: 'Gate A · 실행 형태',
  pre_intent: 'Gate B · Jev 요청', pre_result: 'Gate B · 등급 결정',
  dispatch: '워커 호출',
  background_dispatch: '백그라운드 실행 준비', background_launch: '백그라운드 워커 실행', background_conversation: '메인 대화 계속', background_terminal: '백그라운드 워커 종료', background_policy_delivery: '종료 정책 전달',
  worktree_start: 'Worktree · 생성 시작', worktree_result: 'Worktree · 생성 결과', dispatch_denied: 'Agent 호출 거절', post: token(r['verdict']) ? '워커 결과 · 수락 판정' : 'Agent 호출 결과 · 계약 판정 없음', failure: '호스트 호출 실패', stop: '턴 종료',
} as Record<string, string>)[phase] ?? phase;

const compactSelectionReason = (value: unknown): string | null => ({
  assessment_not_amortized: '판정 비용 회수 여지 부족 · 원본 유지',
  current_dependencies: '현재 작업에 필요한 근거 선택', recency_kept: '기존 최근순 유지', no_candidates: '선별할 과거 결과 없음',
  no_current_task: '사람이 입력한 현재 작업 없음', no_prior_assistant: '이전 assistant 메시지 없음',
  no_key: 'Jev API 키 없음', disabled: 'Jev 선별 꺼짐', not_eligible: '로컬 추출 조건 미충족 · Jev 선별 미실행', input_secret: '민감정보 감지 · 로컬 유지', input_too_large: '판정 입력 한도 초과 · 로컬 유지', context_exceeded: 'Jev 컨텍스트 길이 초과 · 로컬 유지', rejected_input: 'Jev가 입력을 거절 · 로컬 유지',
  timeout: 'Jev 응답 시간 초과 · 로컬 유지', invalid_answers: '유효하지 않은 판정 · 로컬 유지', aborted: '중단 · 판정 미적용',
  superseded: '새 턴으로 변경 · 판정 미적용', unauthorized: 'Jev 인증 실패 · 로컬 유지', payment_required: 'Jev 크레딧 소진 · 로컬 유지', credential_refused: 'Jev 인증 확인 필요 · 로컬 유지',
  error: '선별 오류 · 로컬 유지', network: 'Jev 연결 오류 · 로컬 유지', saturated: '실행 중인 Jev 요청 한도 · 로컬 유지',
} as Record<string, string>)[String(value)] ?? token(value);
const REFUSED = new Set(['incomplete', 'invalid', 'rework', 'replan']);
/** Check ids named by their place in the reply (`#1`) are shown; any other id, a planned one included, only by count. */
const checkIds = (v: unknown): string => {
  const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return ids.every(x => /^#[0-9]{1,4}$/.test(x)) ? ids.slice(0, 16).join(', ') : `${n(ids.length)}개`;
};
const compactUsage = (r: Rec): string => {
  const usage = field(r, 'usage');
  const count = (key: string) => number(usage?.[key]) === null ? '미확인' : n(number(usage?.[key]));
  return `Jev 입력 ${count('input_tokens')} / 출력 ${count('output_tokens')} 토큰`;
};

const modelRequestKey = (r: Rec): string | null => {
  const values = [token(r['session_id']), token(r['prompt_id']), token(r['request_id'])];
  // Native requests can have no prompt identity. Their exact session/request pair
  // still binds a response; null remains distinct from every known prompt.
  return values[0] && values[2] ? JSON.stringify(values) : null;
};
type Ends = Map<string, Array<{ at: string; interrupted: boolean }>>;
/** Latest record and recorded turn/child ends per exact loop, and session ends per session; never a sibling's, the root's or
 * another session's. `read` collects the sessions whose ends an answer used. */
interface Liveness { now: number; seen: Map<string, string>; ends: Ends; sessions: Ends; read: Set<string>; until: number }
/** Notes the next time an age test's answer flips, so a part is rebuilt then and not at every record's age (`sync`). */
const flipsAt = (live: Liveness, at: number): void => { if (at > live.now && at < live.until) live.until = at; };
/** A step waiting for its result is active from its record time for 30 seconds. */
const young = (live: Liveness, at: string): boolean => {
  const t = Date.parse(at), age = live.now - t;
  flipsAt(live, t); flipsAt(live, t + 30_000);
  return age >= 0 && age < 30_000;
};
// Same bound as an unclosed native Codex span: a quiet loop is no longer asserted live, and nothing is concluded.
const MODEL_IDLE_MS = 600_000;
/** Elapsed time is never terminal evidence. Only an exact response or failure settles a request. */
const modelRequestState = (at: string, settledAt: string | undefined, loop: string, session: string, live: Liveness): Pick<OperationStep, 'state' | 'summary'> => {
  if (settledAt !== undefined && settledAt >= at) return { state: 'done', summary: '모델 요청 종료 기록 확인' };
  live.read.add(session);
  const end = [...live.ends.get(loop) ?? [], ...live.sessions.get(session) ?? []].filter(e => e.at >= at).sort((a, b) => a.at.localeCompare(b.at))[0];
  if (end) return end.interrupted ? { state: 'interrupted', summary: '사용자 중단 관측 · 성공이나 기능 오류로 분류하지 않음' } : { state: 'unconfirmed', summary: '턴 또는 세션 종료 · 이 호출의 결과 이벤트는 미관측' };
  const seen = Date.parse(live.seen.get(loop) ?? at);
  flipsAt(live, seen + MODEL_IDLE_MS);
  return live.now - seen < MODEL_IDLE_MS ? { state: 'active', summary: '모델 응답 대기' } : { state: 'unconfirmed', summary: '모델 응답 기록 없음 · 현재 활동 미관측' };
};
const codexLoop = (r: Rec): string => JSON.stringify(['codex', r['session_id'], token(r['prompt_id'])]);
// #269: why Gate A kept or changed the execution path, as a reader names it.
const ADMISSION_REASON: Record<string, string> = {
  admission_context_unclear: '요청 문맥 불명확',
  admission_context_low_confidence: '독립 요청 근거 부족',
  route_not_fast: '빠른 등급 요건 불충족',

  admission_not_worth: '위임 이득 부족', admission_needs_context: '앞선 대화 문맥 필요', admission_low_confidence: '판정 확신 부족', admission_invalid: '응답 검증 실패',
  admission_tie: '판정 동률', admission_abstain: 'Jev 판단 보류', admission_forced: '실험 설정으로 고정', admission_forbids_delegation: '요청이 위임을 금지',
  admission_shape_unknown: '실행 형태 미확인', admission_delivery_failed: '필수 원문 전달 불가', prompt_id_absent: '프롬프트 식별자 없음',
  depth_unknown: '세션 깊이 미확인', depth_below_floor: '세션이 위임 기준보다 얕음', task_notification: '작업 알림 턴',
};
const ROUTER_EVENT: Record<string, string> = {
  router: '세션 설정', request: 'Jev 요청', root: '루트 턴 판단', root_result: '루트 응답 모델 확인', root_stop: '루트 판단 중단', spawn: 'Agent 생성 판단',
  spawn_result: 'Agent 응답 모델 확인', spawn_native_result: 'Agent 응답 모델 확인', spawn_stop: 'Agent 판단 중단', spawn_denied: 'Agent 생성 거부', spawn_dimension: 'Agent 항목 미적용',
  child: '하위 실행 등록', child_route: '하위 단계 판단', child_result: '하위 단계 응답 모델 확인', child_stop: '하위 단계 판단 중단', cache_restored: '캐시 기준 복원',
  cache_restore_skipped: '캐시 기준 복원 생략', context_restored: '대화 문맥 복원', context_restore_skipped: '대화 문맥 복원 생략', effort_cache: 'effort 캐시 유지', context_reset: '문맥 초기화', budget_timeout: '판단 시간 초과', late: '늦은 응답',
};
const traceStep = (r: Rec, resultIds: Set<string>, intents: Map<string, string>, modelTerminals: Map<string, string>, live: Liveness): OperationStep | null => {
  const phase = token(r['phase']);
  if (!phase) return null;
  const connection = phase === 'failure' ? codexConnectionFailure(r) : null;
  if (connection) {
    const at = iso(r['written_at']); if (!at) return null;
    const event = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd', 'Interrupt', 'PreCompact', 'PostCompact'].includes(String(r['event'])) ? String(r['event']) : '훅 종류 미확인';
    return { id: id(token(r['invocation_id']) ?? `connection:${at}:${event}:${connection[0]}`), at, feature: 'connection', lifecycle: true, state: 'error', lane: 'host', issue: 'host', cause: connection[0],
      ...(token(r['session_id']) ? { sessionId: token(r['session_id'])! } : {}),
      title: 'Codex 훅 · 연결 실패', summary: text(event, token(r['tool_name']), connection[1]),
      details: [connection[0], '훅과 로컬 Jev 연결 사이의 오류 · 도구 실행 실패나 워커 실패를 뜻하지 않음', 'HTTP 상태·내부 원인·프로세스 종료 코드는 이 기록만으로 확인 불가'] };
  }
  // #289: a legacy planner dispatch is not worker execution, and its feature is gone like the plan and guard records.
  const feature = phase === 'dispatch' && r['role'] === 'planner' ? null : traceFeature(phase);
  if (!feature) return null;
  const at = iso(r['written_at']);
  if (!at) return null;
  if (phase === 'codex_compact') {
    const stage = token(r['stage']), reason = token(r['reason']);
    if (!['selection_intent', 'selection_result', 'prepared', 'submitted', 'result'].includes(stage ?? '')) return null;
    const selection = stage === 'selection_result', prepared = stage === 'prepared', submitted = stage === 'submitted';
    const jev = field(r, 'jev'), usage = field(jev ?? {}, 'usage');
    const failed = selection && !['assessed', 'stale'].includes(reason ?? '') || stage === 'result' && r['outcome'] === 'failed';
    const unknown = stage === 'result' && r['outcome'] !== 'completed' && !failed;
    const selectionIds = Array.isArray(r['selection_ids']) ? r['selection_ids'].flatMap(v => token(v) ? [token(v)!] : []) : [];
    return { id: id(`codex-compact:${token(r['invocation_id']) ?? at}:${token(r['request_id'])}:${stage}`), at, feature: 'compact',
      ...(stage === 'selection_intent' || prepared && reason !== 'assessment_not_amortized' ? { lifecycle: true } : {}),
      ...(token(r['selection_id']) || selectionIds.length === 1 ? { callId: token(r['selection_id']) ?? selectionIds[0]! } : {}),
      state: failed ? 'error' : unknown ? 'unconfirmed' : prepared && !r['applied'] ? 'skipped' : 'done',
      lane: selection || stage === 'selection_intent' ? 'jev' : submitted || stage === 'result' ? 'host' : 'policy',
      title: selection ? 'Compact · Jev 선별' : submitted ? 'Compact · 실제 전송' : stage === 'result' ? 'Compact · 모델 응답' : prepared ? 'Compact · 입력 준비' : 'Compact · Jev 요청',
      summary: selection ? `선별 후보 ${n(number(r['candidates']))} · 제외 선택 ${n(number(r['selected']))} · ${reason ?? '미확인'}`
        : r['applied'] === true ? `오래된 도구 텍스트 ${n(number(r['removed_chars']))}자 제외 · ${r['path'] === 'native' ? '네이티브 압축' : '일반 추론'}${stage === 'result' ? ` · ${token(r['outcome']) ?? '미확인'}` : ''}` : `네이티브 문맥 유지 · ${compactSelectionReason(reason) ?? token(r['outcome']) ?? stage}`,
      details: ['암호화 문맥·최근 도구 결과·호출 연결 보존', '제외 문자 수는 총 토큰 절감이 아닙니다. Jev·재시도·재조회 포함 총 절감 미측정.'],
      ...(selection && number(r['duration_ms']) !== null ? { durationMs: number(r['duration_ms'])! } : {}),
      ...(selection ? { receipt: { status: null, code: reason, model: token(jev?.['model']), input: number(usage?.['input_tokens']), output: number(usage?.['output_tokens']), costUsd: null, choice: number(r['selected']) !== null ? `제외 선택 ${n(number(r['selected']))}` : null, confidence: null, threshold: .9, direction: null } } : {}),
    };
  }
  const requestId = token(r['request_id']);
  const ownId = token(r['invocation_id']) ?? `${phase}:${at}:${requestId ?? ''}`;
  const isIntent = phase.endsWith('_intent') || phase === 'worktree_start';
  const expected = phase.endsWith('_start') ? phase.replace(/_start$/, '_result') : phase.replace(/_intent$/, '_result');
  const hasResult = requestId !== null && resultIds.has(`${requestId}:${expected}`);
  const http = field(r, 'http');
  const failedAssessment = r['attempted'] === true && token(http?.['code']) !== null && http?.['code'] !== 'ok';
  let state: StepState = isIntent ? hasResult ? 'done' : young(live, at) ? 'active' : 'unconfirmed'
    : r['known_not_sent'] === true || r['attempted'] === false ? 'skipped'
      : r['is_error'] === true || r['ok'] === false || failedAssessment || phase === 'failure' ? 'error' : 'done';
  const details: string[] = [];
  let issue: OperationStep['issue'];
  let summary = '';
  let lane: StepLane = 'policy';
  let outcome: OperationStep['outcome'], refusal: [string, string] | null = null;
  if (isIntent) {
    lane = phase.endsWith('_start') ? 'local' : 'jev';
    summary = hasResult ? '응답 기록과 연결됨' : state === 'active' ? '응답을 기다리는 중' : '응답 기록 없음 · 진행 여부 미확인';
  } else if (phase === 'worktree_result') {
    lane = 'local'; summary = r['ok'] === true ? '워커 격리 작업 공간 생성 완료' : '워커 격리 작업 공간 생성 실패';
    details.push(text(token(r['branch']), token(r['baseline']), token(r['reason'])));
  } else if (phase.endsWith('_result')) {
    lane = r['attempted'] === false || r['known_not_sent'] === true ? 'policy' : 'jev';
    details.push(...callDetails(r), ...relation(r));
    const decision = field(r, 'decision');
    const shape = token(decision?.['shape']);
    const action = token(decision?.['action']);
    const tier = token(decision?.['tier']);
    const reason = token(decision?.['reason']);
    const estimate = field(r, 'estimate');
    summary = (phase === 'admission_result' && shape ? ADMISSION_REASON[reason ?? ''] ?? (reason ? text(shape, reason) : shape === 'orchestrated' ? '위임 이득 충분' : null) : null)
      ?? (text(shape, action, tier, ADMISSION_REASON[reason ?? ''] ?? reason) || (state === 'skipped' ? '전송 없이 원래 경로 유지' : '응답 기록됨'));
    if (phase === 'codex_router_result') {
      summary = text(token(r['selected_model']), token(r['selected_effort']), token(r['reason']));
      if (r['scope'] === 'child') details.push(`워커 다음 추론 · 단계 ${n(number(r['index']))}`);
      const costs = field(r, 'cost'); if (costs) details.push(`전환 비용 ${token(costs['reason']) ?? 'unknown'} · 미래 출력 미확인`);
      const reasons = field(r, 'reasons');
      details.push(text(`모델 ${token(reasons?.['model']) ?? token(reasons?.['tier']) ?? '유지'}`, `effort ${token(reasons?.['effort']) ?? '유지'}`, '선택 결과 · 전송과 응답 확인은 별도 기록'));
    }
    if (phase === 'admission_result') {
      details.push(text(`세션 문맥 ${n(number(r['context_tokens']))} 토큰`, `실행 floor ${n(number(r['depth_floor']))}`, token(r['depth_floor_source']), number(r['host_window']) === null ? null : `호스트 창 ${n(number(r['host_window']))} 토큰`));
      const selected = token(r['selected_execution']);
      if (selected) details.push(`선택한 실행 형태 ${selected} · 실제 적용 전 정책 결정`);
      if (r['policy_basis'] === 'bounded_tool_worker') details.push('범위가 명확한 도구 작업 · 빠른 워커 우선 정책 · 비용 절감 판정과 별개');
      if (number(estimate?.['cost_support']) !== null) details.push(`비용 정책 지지 ${(number(estimate?.['cost_support'])! * 100).toFixed(1)}% · 실제 절감 확률 아님`);
      if (number(estimate?.['turns']) !== null) details.push(`계산에 사용한 루트 턴 ${n(number(estimate?.['turns']))}회`);
    }
    if (phase === 'pre_result') {
      const allocation = field(r, 'allocation');
      const selected = token(allocation?.['selected_model']);
      if (selected) {
        const edit = field(allocation, 'effort_edit');
        const baseline = token(allocation?.['baseline_model']);
        summary = text(!baseline ? '최종 배정' : baseline !== selected ? `${baseline}에서 변경` : '기존 모델 유지', edit?.['kind'] === 'omit' ? 'effort 필드 생략' : edit?.['kind'] === 'set' ? null : 'effort 유지');
        details.push('최종 배정 선택 · 실제 전송과 응답 모델은 별도 관측');
      } else details.push(text(`요청 ${token(r['called_tier']) ?? '?'}`, `적용 ${tier ?? '원래 프로필'}`, token(decision?.['model'])));
    }
    if (estimate && number(estimate['saving_tokens']) !== null) details.push(`위임 가격 계산 ${n(number(estimate['saving_tokens']))} 토큰 · 측정된 절감 아님`);
  } else if (phase === 'codex_router_skipped') {
    lane = 'policy';
    summary = ({ disabled: 'Jev 기능이 꺼져 있음', router_disabled: 'Router가 꺼져 있음', key_missing: 'Jev API 키 없음', aborted: '턴 중단으로 판단 생략', model_catalog_missing: '호스트 모델 목록에서 현재 모델을 확인할 수 없음', nothing_to_change: '변경 가능한 모델·effort 없음', pinned: 'codex exec 실행 · 모델·effort 고정' } as Record<string, string>)[String(r['reason'])] ?? token(r['reason']) ?? '원래 호스트 설정 유지';
    const moved = field(r, 'superseded_baseline');
    details.push(moved ? text('Jev 전송 없음', `${token(moved['from']) ?? '?'}에서 후속 모델 ${token(moved['to']) ?? '?'}로 변경`, 'effort 유지') : 'Jev 전송 없음 · 원래 모델·effort 유지');
  } else if (phase === 'codex_route_applied') {
    lane = 'host'; summary = text('Codex 요청에 설정 제출', token(r['submitted_model'] ?? r['observed_model']), token(r['submitted_effort']));
    details.push('요청 전송 관측 · 응답 모델과 실제 effort는 아직 미확인');
  } else if (phase === 'codex_router_response') {
    lane = 'host'; summary = text('Codex 응답 관측', token(r['observed_model']) ?? '모델 미확인', r['observed_effort'] === 'unknown' ? 'effort 미확인' : token(r['observed_effort']));
    details.push('응답이 보고한 값만 표시');
  } else if (phase.startsWith('background_')) {
    lane = phase === 'background_dispatch' || phase === 'background_conversation' || phase === 'background_policy_delivery' ? 'policy' : 'host';
    const closed = resultIds.has(`background:${token(r['session_id'])}:${token(r['execution_prompt_id']) ?? token(r['prompt_id'])}:${token(r['tool_use_id'])}`);
    if (phase === 'background_dispatch') { summary = '원래 작업에 실행 예약 연결 · 시작 확인 대기'; state = closed ? 'done' : 'unconfirmed'; }
    if (phase === 'background_launch') { state = closed ? 'done' : young(live, at) ? 'active' : 'unconfirmed'; summary = closed ? '시작과 실제 종료 연결됨' : state === 'active' ? '워커 실행 중 · 메인에서 질문 가능' : '시작 기록 있음 · 종료 결과 미관측'; details.push('시작 알림은 완료·수락 결과가 아닙니다'); }
    if (phase === 'background_conversation') summary = `원래 작업 유지 · 종료 결과 대기 ${n(number(r['active']))}개`;
    if (phase === 'background_policy_delivery') { summary = '종료 정책 한 번 전달 · 다음 일반 요청은 Gate A 재개'; state = 'done'; }
    if (phase === 'background_terminal') { summary = token(r['status']) === 'completed' ? '호스트에서 실제 종료 확인 · 계약 수락은 별도 검사' : codexFailureReason(r) ?? verdictReason('', r['verdict_reason'])?.[1] ?? '호스트에서 중단·실패 확인 · 성공 수락 없음'; state = token(r['status']) === 'completed' ? 'done' : r['not_executed'] === true ? 'error' : 'interrupted'; if (state === 'done') outcome = 'host_ended'; if (r['not_executed'] === true) details.push('워커 미실행 · 완료 주장 없음'); if (r['orphaned'] === true) details.push('이전 작업 결과 · 현재 작업 미진행'); }
  } else if (phase === 'dispatch_denied') {
    lane = 'policy'; state = 'skipped';
    summary = text('호출 거절', token(r['reason']));
    details.push(text(token(r['tool_name']), token(r['reason'])), '이 호출은 실행되지 않았습니다');
  } else if (phase === 'dispatch') {
    lane = 'host';
    summary = text(token(r['role']), token(r['task_id']), compactSelectionReason(r['selection']), `요청 등급 ${token(r['requested_tier']) ?? '?'}`);
    details.push(text(`호출 모델 ${token(r['requested_model']) ?? '미기록'}`, r['pinned'] === true ? '모델 고정' : null));
  } else if (phase === 'post') {
    lane = 'host';
    // #232: only an accept receipt accepts a contract, and a refused one fails that worker's result. A row with no verdict is the host's own outcome.
    const verdict = token(r['verdict']);
    outcome = !verdict ? field(r, 'tool_response')?.['status'] === 'completed' ? 'host_ended' : undefined : verdict === 'accept' ? 'accepted' : REFUSED.has(verdict) ? 'rejected' : 'unknown';
    refusal = verdict ? verdictReason(verdict, r['verdict_reason']) : null;
    if (outcome === 'rejected') { state = 'error'; issue = 'contract'; } else if (outcome === 'unknown') state = 'unconfirmed';
    summary = verdict ? text(token(r['task_id']), { accepted: '계약 수락', rejected: '계약 미충족', unknown: '판정 미확인' }[outcome as string], outcome === 'rejected' && verdict, refusal?.[1])
      : text(token(r['task_id']), r['matched'] === false ? '예약과 일치하지 않는 호출' : '결과 기록', '계약 판정 없음');
    details.push(text(`요청 모델 ${token(r['requested_model']) ?? '미기록'}`, token(r['routed_model']) && `Router 변경 ${token(r['routed_model'])}`, `실행 모델 ${token(r['resolved_model']) ?? '미관측'}`, token(r['subagent_type'])));
    const checks = field(r, 'reported_checks');
    if (checks) details.push(text(`worker 보고 pass ${n(number(checks['pass']))}`, `fail ${n(number(checks['fail']))}`, `미실행 ${n(number(checks['not_run']))}`));
    const verification = field(r, 'verification');
    if (verification) details.push(text(`실행 기록 ${token(verification['transcript']) ?? '미확인'}`, ...([['contradicted', '모순'], ['unobserved', '미관측'], ['stale', '변경 전 통과']] as const).map(([k, name]) => { const ids = checkIds(verification[k]); return ids && `${name} ${ids}`; })));
    if (r['evidence_format_only'] === true) details.push('검사 명령 형식만 불일치 · 한 번의 무료 재검증 가능');
    if (r['root_fallback'] === true) details.push(r['root_fallback_reason'] === 'accepted' ? '종료된 작업 수락 · 루트에서 남은 확인 가능 · 전체 요구사항 검증과는 다름' : r['root_fallback_reason'] === 'delivery_failed' ? '필수 원문 전달 불가 · 루트 복귀' : '단일 워커 시도 상한 · 루트 복귀');
    if (r['orphaned'] === true) details.push('이전 세대의 늦은 결과 · 현재 작업 미진행');
  } else if (phase === 'stop') {
    lane = 'host'; summary = text('턴 종료', token(r['outcome']));
  } else if (phase === 'failure') {
    lane = 'host'; summary = text(codexFailureReason(r) ?? verdictReason('', r['verdict_reason'])?.[1] ?? '호스트 호출 실패', token(r['subagent_type']));
    if (r['not_executed'] === true) details.push('워커 미실행 · 완료 주장 없음');
    if (r['failure_category'] === 'interrupted' || r['failure_category'] === 'cancelled') state = 'interrupted';
    if (r['failure_category'] === 'termination_unconfirmed') state = 'unconfirmed';
    details.push(text(`요청 모델 ${token(r['requested_model']) ?? '미기록'}`, token(r['routed_model']) && `Router 변경 ${token(r['routed_model'])}`, `실행 모델 ${token(r['resolved_model']) ?? '미관측'}`));
  }
  const measured = number(http?.['duration_ms']);
  const duration = measured !== null && measured >= 0 ? measured : null;
  const sentAt = requestId && phase.endsWith('_result') ? intents.get(`${requestId}:${phase.replace(/_result$/, '_intent')}`) : undefined;
  const elapsed = sentAt ? Date.parse(at) - Date.parse(sentAt) : null;
  const model = phase === 'codex_router_response' ? modelObservation(r['selected_model'], r['observed_model'], r['selected_effort'], r['observed_effort'], undefined, 'submitted_effort' in r ? { value: r['submitted_effort'], source: 'provider_request' } : undefined)
    : phase === 'codex_route_applied' ? modelObservation(r['selected_model'], r['observed_model'], r['selected_effort'], r['observed_effort'], undefined, 'submitted_effort' in r ? { value: r['submitted_effort'], source: 'provider_request' } : undefined)
    : phase === 'pre_result' && field(r, 'allocation') ? modelObservation(field(r, 'allocation')?.['selected_model'], null, field(field(r, 'allocation'), 'effort_edit')?.['value'])
    : phase === 'post' || phase === 'failure' || phase === 'background_launch' ? modelObservation(r['routed_model'] ?? r['requested_model'], r['resolved_model']) : undefined;
  if (model && phase === 'codex_route_applied' && r['request_kind'] === 'root_response' && typeof r['applied'] === 'boolean') model.requestApplied = r['applied'];
  const routing: OperationStep['routing'] = phase.startsWith('codex_router_') || phase === 'codex_route_applied' ? { scope: r['scope'] === 'child' ? 'child' : 'root', baseline: token(r['baseline_model']), modelReason: token(field(r, 'reasons')?.['model']), effortReason: token(field(r, 'reasons')?.['effort']) } : phase === 'pre_result' && field(r, 'allocation') ? { scope: 'owned', baseline: token(field(r, 'allocation')?.['baseline_model']), modelReason: 'gate_allocated', effortReason: 'gate_allocated' } : undefined;
  const routerAnswers = field(r, 'answers');
  const proposal = field(routerAnswers, 'model') ?? field(routerAnswers, 'capability');
  const option = token(proposal?.['choice']);
  const roles = field(r, 'selection')?.['roles'];
  // A capability answer names a kind of work; the selection's role map names the one model that served it.
  const proposedModel = field(routerAnswers, 'model') ? option : Array.isArray(roles) ? token(roles.map(rec).find((x) => x?.['option'] === option)?.['model']) : null;
  if (routing && proposedModel && option && !['__keep__', '__abstain__'].includes(proposedModel)) {
    routing.proposedModel = proposedModel;
    const selection = field(r, 'selection');
    const probability = number(selection?.['probability']) ?? number(field(proposal, 'probabilities')?.[option]);
    const threshold = number(selection?.['threshold']);
    if (probability !== null && probability >= 0 && probability <= 1) routing.probability = probability;
    if (threshold !== null && threshold >= 0 && threshold <= 1) routing.threshold = threshold;
  }
  if (phase.startsWith('codex_router_')) {
    details.push(text(`baseline ${token(r['baseline_model']) ?? '?'}`, token(r['baseline_effort'])));
    if (number(r['discovered_count']) !== null) details.push(text(`발견 ${n(number(r['discovered_count']))}`, `적격 ${n(number(r['eligible_count']))}`, `제시 ${n(number(r['offered_count']))}`, r['catalog_complete'] === true ? '목록 완전' : '목록 부분/미확인'));
    details.push(text(`model 질문 ${r['model_asked'] === true ? '함' : token(r['model_not_asked']) ?? '미확인'}`, `effort 질문 ${r['effort_asked'] === true ? '함' : token(r['effort_not_asked']) ?? '미확인'}`));
    if (typeof r['allow_astra'] === 'boolean') details.push(`Astra 자동 선택 ${r['allow_astra'] ? 'ON' : 'OFF'}`);
    const exclusions = field(r, 'excluded');
    if (exclusions) details.push(text(...Object.entries(exclusions).flatMap(([reason, value]) => number(value) ? [`제외 ${reason} ${n(number(value))}`] : [])));
  }
  if (model?.status === 'mismatch') { state = 'error'; issue = 'response_model'; }
  if (phase === 'codex_route_applied' && r['applied'] === false) {
    const submittedModel = token(r['submitted_model']), submittedEffort = token(r['submitted_effort']);
    const selectedModel = token(r['selected_model']);
    if (r['request_kind'] !== 'root_response') {
      state = 'unconfirmed'; issue = 'request_unconfirmed';
      summary = text('API 설정 관측 · 요청 종류 미확인', selectedModel, submittedModel, r['submitted_effort'] === null ? '전송 effort 생략' : submittedEffort);
      details.push('루트 실행 요청인지 호스트 요약 요청인지 기록이 없어 선택값 적용 실패로 단정할 수 없음', '실제 응답 모델·effort 미관측');
    } else {
    state = 'error';
    issue = submittedModel && selectedModel && submittedModel !== selectedModel ? 'request_model'
      : submittedModel && selectedModel && submittedModel === selectedModel && 'submitted_effort' in r ? 'request_effort' : 'request_unconfirmed';
    summary = issue === 'request_effort' ? text('선택 effort와 API 전송 effort 불일치', `선택 ${token(r['selected_effort']) ?? '생략'}`, `전송 ${submittedEffort ?? '생략'}`)
      : issue === 'request_model' ? text('선택 모델과 API 전송 모델 불일치', selectedModel, submittedModel) : '선택 설정 적용 실패 기록 · 불일치 항목 미확인';
    details.push('API 요청 설정의 비교 · 실제 응답 모델이나 실행 실패를 뜻하지 않음');
    }
  }
  if (phase === 'codex_model_request') {
    const binding = modelRequestKey(r);
    ({ state, summary } = modelRequestState(at, binding ? modelTerminals.get(binding) : undefined, codexLoop(r), JSON.stringify(['codex', r['session_id']]), live));
    lane = 'host';
    details.push(`전달 모델 ${token(r['submitted_model']) ?? '?'}`);
  }
  if (phase === 'codex_model_failure') { state = 'error'; lane = 'host'; summary = '호스트 모델 요청 실패'; }
  if (state === 'error' && !issue) issue = lane === 'jev' ? 'jev' : 'host';
  const cause = state !== 'error' ? null : phase === 'post' ? refusal?.[0] ?? null : token(http?.['code']) ?? token(r['reason']);
  const decided = field(r, 'decision'), selection = field(r, 'selection'), answered = judgements(r)?.find(j => j.confidence !== null);
  const receipt = lane === 'jev' && duration !== null && duration >= 0 && !isIntent ? jevReceipt(number(http?.['status']), token(http?.['code']), token(field(r, 'jev')?.['model']), field(field(r, 'jev'), 'usage') ?? field(r, 'usage'),
    phase === 'codex_router_result' ? text(token(r['selected_model']), token(r['selected_effort'])) || null : token(decided?.['shape']) ?? token(field(r, 'allocation')?.['selected_model']) ?? token(decided?.['tier']) ?? token(decided?.['action']),
    routing?.probability ?? answered?.confidence ?? null, routing?.threshold ?? null, token(selection?.['direction'])) : undefined;
  return { id: id(ownId), at, feature, state, lane, ...(token(r['session_id']) ? { sessionId: token(r['session_id'])! } : {}), ...(token(r['agent_id']) ? { agentId: token(r['agent_id'])! } : {}), ...(token(r['request_id']) ?? token(r['tool_use_id']) ? { callId: (token(r['request_id']) ?? token(r['tool_use_id']))! } : {}), title: traceTitle(phase, r), summary, details: details.filter(Boolean), ...(routing ? { routing } : {}), ...(model ? { model } : {}),
    ...(issue ? { issue } : {}), ...(cause ? { cause } : {}),
    ...(outcome ? { outcome } : {}), ...((outcome === 'accepted' || outcome === 'rejected') && token(r['task_id']) ? { task: token(r['task_id'])! } : {}),
    // A host end and a policy delivery decide nothing, so a later one never stands in for the contract verdict before it.
    // #269: a Jev request whose response is recorded is that response's start, which the response row already times.
    ...(['stop', 'background_conversation', 'background_policy_delivery', 'codex_model_request', 'codex_model_failure'].includes(phase) || outcome === 'host_ended' && phase === 'background_terminal' || isIntent && hasResult && lane === 'jev' ? { lifecycle: true } : {}),
    ...(phase === 'admission_result' && ['direct', 'orchestrated'].includes(String(field(r, 'decision')?.['shape'])) ? { executionPath: field(r, 'decision')!['shape'] as 'direct' | 'orchestrated' } : {}),
    ...(duration !== null && duration >= 0 ? { durationMs: duration } : {}),
    ...(elapsed !== null && elapsed >= 0 ? { elapsedMs: elapsed } : {}),
    ...(phase === 'codex_model_request' && state === 'active' ? { startedAt: at } : {}),
    ...(phase.endsWith('_result') && judgements(r) ? { judgements: judgements(r)! } : {}),
    ...(receipt ? { receipt } : {}) };
};

type Routing = NonNullable<OperationStep['routing']>;
/** A Router spawn's routing for a child agent; the child's results take the last one before them. */
interface Origin { at: string; pos: number; routing: Routing }
/** In a split build a child's origin can be recorded in another part: the later of this part's last one and the other parts'
 * last one before the row, in one pass's order. */
const latestOrigin = (own: { routing: Routing; row: ModRecord } | undefined, row: ModRecord, agent: string, context: PartContext): Routing | undefined => {
  context.read.add(`agent:${agent}`);
  const list = context.children(agent), pos = context.position(row);
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1, c = list[mid]!.at.localeCompare(row.at); if (c < 0 || c === 0 && list[mid]!.pos < pos) lo = mid + 1; else hi = mid; }
  const other = list[lo - 1];
  if (!other || !own) return other?.routing ?? own?.routing;
  const c = own.row.at.localeCompare(other.at);
  return c > 0 || c === 0 && context.position(own.row) > other.pos ? own.routing : other.routing;
};

/** Join decisions to responses only within the recorded session and execution identity. `exported` collects the child origins
 * this part records, for the parts that read them. */
const routedModRecords = (mods: ModRecord[], records: Rec[], context?: PartContext, exported?: Part['origins']): ModRecord[] => {
  const identity = (r: Rec, key: string): string | null => token(r[key]) ? JSON.stringify([r['session_id'] ?? 'legacy', r[key]]) : null;
  const owned = new Map<string, Rec>();
  for (const r of records) {
    const key = identity(r, 'tool_use_id');
    if (r['host'] !== 'codex' && r['phase'] === 'pre_result' && key && field(r, 'allocation')) owned.set(key, r);
  }
  const classicCompacts = new Map<string, Rec>();
  const turns = new Map<string, Rec>(), spawns = new Map<string, Rec>(), childSteps = new Map<string, Rec>(), children = new Map<string, { routing: Routing; row: ModRecord }>();
  return [...mods].sort((a, b) => a.at.localeCompare(b.at)).map(row => {
    if (row.component !== 'router') {
      const r = row.rec, session = String(r['session_id'] ?? 'legacy');
      if (r['stage'] === 'pre' && !r['deferred']) classicCompacts.set(session, r);
      const start = classicCompacts.get(session);
      return start && ['restore', 'post'].includes(String(r['stage'])) ? { ...row, rec: { ...r, run_id: r['run_id'] ?? start['run_id'], mode: r['mode'] ?? start['mode'] } } : row;
    }
    const r = row.rec, event = r['event'], turn = identity(r, 'turn'), tool = identity(r, 'tool_use_id'), agent = identity(r, 'agent_id');
    let routing: OperationStep['routing'];
    const gate = tool ? owned.get(tool) : undefined;
    const childDecision = agent ? childSteps.get(routerResponseKey(r)) : undefined;
    const decision = childDecision ?? (['root_result', 'model_request', 'model_failure'].includes(String(event)) && !agent && turn ? turns.get(turn) : ['spawn_result', 'spawn_native_result'].includes(String(event)) && tool ? spawns.get(tool) : undefined);
    if (gate) {
      const allocation = field(gate, 'allocation');
      const edit = field(allocation, 'effort_edit');
      routing = { scope: 'owned', baseline: token(allocation?.['baseline_model']), modelReason: 'gate_allocated', effortReason: token(edit?.['kind']) === 'keep' ? 'same_value' : 'gate_allocated' };
    } else if (decision || event === 'root' || event === 'spawn' || event === 'child_route') {
      const d = decision ?? r, reasons = field(d, 'reasons');
      routing = { scope: agent ? 'child' : ['root_result', 'root', 'model_request', 'model_failure'].includes(String(event)) ? 'root' : 'spawn', baseline: token(field(d, 'from')?.['model']) ?? token(d['from']), modelReason: token(reasons?.['model']) ?? token(d['skipped']) ?? token(d['assessment']), effortReason: token(reasons?.['effort']) };
    }
    // A selection the dispatch did not carry (budget expired, turn retired, the host ran another model) is not a change.
    if (routing && decision && event === 'root_result') {
      const want = field(decision, 'patch'), sent = field(r, 'applied');
      if (want && token(want['model']) && token(want['model']) !== token(sent?.['model'])) routing = { ...routing, modelReason: 'not_applied' };
      if (want && token(want['effort']) && token(want['effort']) !== token(sent?.['effort'])) routing = { ...routing, effortReason: 'not_applied' };
    }
    if (routing && event === 'spawn_result' && r['reason'] === 'model_mismatch') routing = { ...routing, modelReason: 'not_applied' };
    if (event === 'root' && turn && (field(r, 'reasons') || field(r, 'from'))) turns.set(turn, r);
    if (event === 'spawn' && tool) spawns.set(tool, r);
    if (event === 'child_route' && agent) childSteps.set(routerResponseKey(r), r);
    if (['spawn_result', 'spawn_native_result'].includes(String(event)) && agent && routing) { children.set(agent, { routing, row }); exported?.push({ agent, row, routing }); }
    if (event === 'child_result' && agent) {
      const origin = context ? latestOrigin(children.get(agent), row, agent, context) : children.get(agent)?.routing;
      if (origin && !childDecision) routing = { ...origin, scope: 'child' };
    }
    return routing ? { ...row, rec: { ...r, routing_decision: routing } } : row;
  });
};

const routerResponseKey = (r: Rec, index: unknown = r['index'] ?? null): string =>
  JSON.stringify([r['session_id'] ?? 'legacy', r['tool_use_id'] ?? r['turn'], token(r['tool_use_id']) ? null : r['agent_id'] ?? (r['scope'] === 'child' ? 'unknown-child' : null), index]);

export const routerDecisionKey = (r: Rec): string => JSON.stringify([r['session_id'] ?? 'legacy', r['turn'] ?? r['tool_use_id'] ?? '', r['agent_id'] ?? null, r['agent_id'] ? r['index'] ?? null : null]);

const modStep = (row: ModRecord, closed: Set<string>, responses: Map<string, string>, live: Liveness): OperationStep | null => {
  const r = row.rec;
  const route = field(r, 'routing_decision'), scope = token(route?.['scope']);
  const routing: OperationStep['routing'] = scope && ['root', 'spawn', 'child', 'owned'].includes(scope) ? { scope: scope as NonNullable<OperationStep['routing']>['scope'], baseline: token(route?.['baseline']), modelReason: token(route?.['modelReason']), effortReason: token(route?.['effortReason']) } : undefined;
  const event = token(r['event']);
  // Turn and session ends only bound the requests of their own loop; they are not routing steps.
  if (!event || !row.at || event === 'turn_end' || event === 'session_end') return null;
  const feature = row.component;
  const runId = token(r['run_id']);
  const key = row.component === 'router' ? routerDecisionKey(r) : `${token(r['session_id']) ?? 'legacy'}:${runId ?? ''}`;
  const started = (row.component === 'router' && event === 'request') || r['stage'] === 'started';
  const failedAssessment = row.component === 'router' && r['sent'] === true && token(r['assessment']) !== null && r['assessment'] !== 'ok';
  let state: StepState = started && !closed.has(`${row.component}:${key}`) ? young(live, row.at) ? 'active' : 'unconfirmed' : failedAssessment || r['confirmation'] === 'mismatch' || r['reason'] === 'model_mismatch' || r['coreError'] === true || r['within_budget'] === false ? 'error' : r['confirmation'] === 'unobserved' ? 'unconfirmed' : r['skipped'] || r['deferred'] || r['disabled'] ? 'skipped' : 'done';
  const details: string[] = [];
  let summary = '';
  let lane: StepLane = 'local';
  let choice: string | null = null;
  if (feature === 'router') {
    lane = event === 'request' || r['sent'] === true ? 'jev' : 'policy';
    const from = field(r, 'from'); const patch = field(r, 'patch'); const reasons = field(r, 'reasons'); const applied = field(r, 'applied');
    if (r['sent'] === true && !failedAssessment) choice = text(token(patch?.['model']) ?? token(from?.['model']) ?? token(r['from']), token(patch?.['effort']) ?? token(from?.['effort'])) || null;
    const skip = ({ child_unregistered: '등록되지 않은 하위 실행 · 원래 설정 유지', child_stopped: '라우팅이 멈춘 하위 실행 · 원래 설정 유지' } as Record<string, string>)[String(r['skipped'])];
    // #269: a decision's outcome is the setting it sent or kept; the title already names the event.
    const changed = [token(patch?.['model']) !== (token(from?.['model']) ?? token(r['from'])) && token(patch?.['model']), token(patch?.['effort']) !== token(from?.['effort']) && token(patch?.['effort'])];
    summary = event === 'request' ? 'Jev 요청 전송 · 응답 대기' : skip ?? (r['sent'] === true ? changed.some(Boolean) ? text('설정 변경', changed[0] || null, changed[1] || null) : '기존 설정 유지'
      : text(r['sent'] === false ? '전송 안 함' : null, token(r['skipped']), token(r['reason'])));
    if (failedAssessment) summary = r['assessment'] === 'payment_required' ? 'Jev 크레딧 소진 · 원래 호스트 설정 유지' : text('Jev 판정 실패 · 원래 호스트 설정 유지', token(r['assessment']));
    details.push(text(`기존 모델 ${token(from?.['model']) ?? token(r['from']) ?? '?'}`, `기존 effort ${token(from?.['effort']) ?? '?'}`));
    if (r['scope'] === 'child') details.push(text('워커 단계별 Jev 라우팅', `단계 ${n(number(r['index']))}`, `워커 ${token(r['agent_id']) ?? '?'}`));
    if (number(r['preparation_ms']) !== null) details.push(`Router 준비 ${n(number(r['preparation_ms']))}ms · Jev 응답 시간과 별도 · 예산 ${n(number(r['budget_ms']))}ms`);
    if (number(r['discovered_count']) !== null) details.push(text(`발견 ${n(number(r['discovered_count']))}`, `적격 ${n(number(r['eligible_count']))}`, `제시 ${n(number(r['offered_count']))}`, r['catalog_complete'] === true ? '목록 완전' : '목록 부분/미확인'));
    if (typeof r['allow_fable'] === 'boolean') details.push(`Fable 자동 선택 ${r['allow_fable'] ? 'ON' : 'OFF'}`);
    if (typeof r['model_pin'] === 'boolean' || typeof r['effort_pin'] === 'boolean') details.push(text(`model pin ${r['model_pin'] === true ? 'ON' : 'OFF'}`, `effort pin ${r['effort_pin'] === true ? 'ON' : 'OFF'}`));
    if (token(r['hook_version']) || token(r['host_version'])) details.push(text(`loaded hook ${token(r['hook_version']) ?? '?'}`, `host ${token(r['host_version']) ?? '?'}`));
    if ('effort_source' in r) details.push(text(`effort source ${token(r['effort_source']) ?? '?'}`, `effective effort ${token(r['effective_effort']) ?? '?'}`, `incoming field ${r['effort_field_present'] === true ? 'present' : 'absent'}`));
    const selection = field(r, 'selection');
    if (selection) details.push(text(`direction ${token(selection['direction']) ?? '?'}`, `threshold ${n(number(selection['threshold']))}`, `p ${n(number(selection['probability']))}`, `effort policy ${token(selection['effort_policy']) ?? '?'}`));
    const exclusions = field(r, 'excluded');
    if (exclusions) details.push(text(...Object.entries(exclusions).flatMap(([reason, value]) => number(value) ? [`excluded ${token(reason) ?? '?'} ${n(number(value))}`] : [])));
    details.push(text(`요청 변경 모델 ${token(patch?.['model']) ?? '?'}`, `요청 변경 effort ${token(patch?.['effort']) ?? token(r['patch']) ?? '?'}`));
    const heldEffort = token(r['held_for_cache']);
    if (heldEffort) details.push(text('캐시 재사용을 위해 effort 유지', `Jev 제안 ${heldEffort}`, `요청 설정 ${token(patch?.['effort']) ?? token(from?.['effort']) ?? '?'}`));
    details.push(text(`모델 이유 ${token(reasons?.['model']) ?? '?'}`, `effort 이유 ${token(reasons?.['effort']) ?? '?'}`, `실제 적용 effort ${token(applied?.['effort']) ?? '?'}`, `관측 모델 ${token(r['observed']) ?? '?'}`));
    const usage = field(r, 'usage');
    if (usage) details.push(text(`입력 ${n(number(usage['input']))}`, `출력 ${n(number(usage['output']))}`, `cache read ${n(number(usage['cache_read']))}`, `cache write ${n(number(usage['cache_creation']))}`));
    // #269: typed answers are the step's judgements; only a legacy flat record keeps them as text.
    const answers = judgements(r) ? null : field(r, 'answers');
    if (answers) details.push(text(`Jev 제어 ${token(answers['control']) ?? token(field(answers, 'control')?.['choice']) ?? '?'}`, number(answers['task_clear']) === null ? null : `명확도 ${Math.round(number(answers['task_clear'])! * 100)}%`, number(answers['ordinary']) === null ? null : `일반 위험 ${Math.round(number(answers['ordinary'])! * 100)}%`));
    const capability = field(answers, 'capability');
    if (capability) details.push(text(`필요 역량 ${token(capability['choice']) ?? '?'}`, ...Object.entries(field(capability, 'probabilities') ?? {}).flatMap(([option, value]) => token(option) && number(value) !== null ? [`${option} ${n(number(value))}`] : [])));
    if (answers) for (const name of ['tier', 'effort']) {
      const levels = field(answers, name);
      if (levels) details.push(text(`${name} 점수`, ...Object.entries(levels).slice(0, 8).flatMap(([level, value]) => token(level) && number(value) !== null ? [`${level} ${n(number(value))}`] : [])));
    }
  } else {
    if (r['stage'] === 'jev') {
      lane = r['jev_sent'] === true ? 'jev' : 'local';
      summary = text(r['jev_sent'] === true ? 'Jev 작업 의존 근거 선택' : r['jev_sent'] === false ? 'Jev 전송 없음' : 'Jev 전송 여부 미확인', compactSelectionReason(r['selection']));
      if (r['jev_sent'] === true) details.push(compactUsage(r));
      if (number(r['dependencies']) !== null) choice = `${n(number(r['dependencies']))} / ${n(number(r['candidates']))}`;
      details.push(text(`후보 ${n(number(r['candidates']))}/${n(number(r['available']))}`, `필수 근거 ${n(number(r['dependencies']))}`, number(r['jev_ms']) === null ? null : `${n(number(r['jev_ms']))}ms`));
    } else summary = r['stage'] === 'pre' ? r['guided'] === true ? '호스트 요약 지침 적용' : '호스트 압축 준비' : r['stage'] === 'restore' ? '보존 문맥 복원' : r['stage'] === 'post' ? '호스트 압축 완료 · 예산 관측' : started ? '대화 압축 시작' : r['deferred'] ? text('호스트 압축으로 넘김', token(r['deferred'])) : r['skipped'] ? text('호스트 사전 요약 생략 · 이 시점 대화로 로컬 digest 구성 가능', token(r['skipped'])) : r['applied'] === true ? '로컬 digest 적용 · 요약 모델 호출 대체' : text('호스트 압축 사용', token(r['fallback']), r['coreSkip'] === true ? '호스트 건너뜀' : null);
    if (['restore', 'post'].includes(String(r['stage']))) details.push(text(number(r['summary_chars']) === null ? null : `summary ${n(number(r['summary_chars']))}자`, number(r['restore_chars'] ?? r['restored_chars']) === null ? null : `restore ${n(number(r['restore_chars'] ?? r['restored_chars']))}자`, number(r['budget']) === null ? null : `budget ${n(number(r['budget']))}자`));
    if (r['stage'] !== 'jev' && r['selection']) details.push(text('Jev 선별', compactSelectionReason(r['selection'])));
    details.push(text(`모드 ${token(r['mode']) ?? '?'}`, `트리거 ${token(r['trigger']) ?? '?'}`, r['subagent'] === true ? '서브에이전트' : '루트', `메시지 ${n(number(r['messages']))}개`));
    details.push(text(number(r['digestChars']) === null ? null : `digest ${n(number(r['digestChars']))}자`, number(r['tailChars']) === null ? null : `tail ${n(number(r['tailChars']))}자`, number(r['buildMs']) === null ? null : `빌드 ${n(number(r['buildMs']))}ms`));
    if (number(r['tokensBefore']) !== null || number(r['tokensAfter']) !== null) details.push(`호스트 보고 압축 전 ${n(number(r['tokensBefore']))} / 후 ${n(number(r['tokensAfter']))} 토큰`);
  }
  const model = feature === 'router' && ['root_result', 'spawn_result', 'spawn_native_result', 'child_result', 'model_request'].includes(event)
    ? modelObservation(r['requested'] ?? field(r, 'applied')?.['model'] ?? r['assumed'], r['observed'], r['requested_effort'] ?? field(r, 'applied')?.['effort'], r['observed_effort'], r['confirmation'], 'requested_effort' in r ? { value: r['requested_effort'], source: 'host_hook' } : undefined) : undefined;
  if (model) {
    if (model.status === 'mismatch') state = 'error';
    lane = 'host'; summary = text(model.status === 'confirmed' ? '선택 모델과 실제 모델 일치' : model.status === 'mismatch' ? '선택 모델과 실제 모델 불일치' : model.observed ? '실제 모델 관측 · 요청 모델 미확인' : '실제 응답 모델 미관측');
  }
  if (event === 'prepared') {
    const responseKey = routerResponseKey(r);
    state = (responses.get(responseKey) ?? '') >= row.at ? 'done' : 'unconfirmed';
    summary = r['routed'] === true ? '변경 설정 전달 준비 · 실행 응답 확인은 별도' : '기존 설정 전달 준비 · 실행 응답 확인은 별도';
    details.push('요청 전 점검만 기록됨 · Jev 새 호출이나 실제 모델 응답 완료를 뜻하지 않음');
  }
  if (event === 'model_request') {
    ({ state, summary } = modelRequestState(row.at, responses.get(routerResponseKey(r)), routerResponseKey(r, 'loop'), JSON.stringify(['claude', r['session_id']]), live));
    lane = 'host';
    details.push(text(`전달 모델 ${token(r['requested']) ?? '?'}`, `전달 effort ${token(r['requested_effort']) ?? '호스트 기본값'}`), '호스트 호출 시작 관측 · 실제 모델과 effort 확인은 응답 기록과 별도');
  }
  if (event === 'model_failure') { state = 'error'; lane = 'host'; summary = '호스트 모델 요청 실패'; }
  if (r['denied'] === true) { state = 'skipped'; summary = '호스트가 에이전트 생성을 거부함 · 실행되지 않음'; }
  const duration = number(r['duration_ms'] ?? (lane === 'jev' ? r['jev_ms'] : undefined));
  const selection = field(r, 'selection');
  const receipt = lane === 'jev' && !started && duration !== null && duration >= 0 ? jevReceipt(null, token(r['assessment'] ?? (r['stage'] === 'jev' ? r['selection'] : null)), token(r['jev_model']), field(r, 'usage'), choice,
    number(selection?.['probability']), number(selection?.['threshold']), token(selection?.['direction'])) : undefined;
  return { id: id(`${row.component}:${row.at}:${key}:${event}:${started ? 'start' : token(r['stage']) ?? 'result'}`), at: row.at, feature, state, lane, callId: `${row.component}:${key}`,  ...(token(r['agent_id']) ? { agentId: token(r['agent_id'])! } : {}), ...((token(r['agent_id']) || state === 'error') && token(r['session_id']) ? { sessionId: token(r['session_id'])! } : {}),
    ...(failedAssessment && state === 'error' && token(r['assessment']) ? { cause: token(r['assessment'])! } : {}), ...(['prepared', 'model_request', 'model_failure'].includes(event) || event === 'request' && state === 'done' ? { lifecycle: true as const } : {}), title: { router: event === 'prepared' ? 'Router · 요청 전달 준비' : event === 'model_request' ? '모델 · 응답 대기' : event === 'model_failure' ? '모델 · 요청 실패' : 'Router · ' + (ROUTER_EVENT[event] ?? event), compact: 'Compact · 압축' }[feature], summary, details: details.filter(Boolean), ...(routing ? { routing } : {}), ...(model ? { model } : {}), ...(lane === 'jev' && duration !== null && duration >= 0 ? { durationMs: duration } : {}), ...(event === 'model_request' && state === 'active' ? { startedAt: row.at } : {}), ...(receipt ? { receipt } : {}), ...(receipt && feature === 'router' && judgements(r) ? { judgements: judgements(r)! } : {}) };
};

const gateGroup = (r: Rec): string => {
  const phase = token(r['phase']) ?? '';
  if (phase.startsWith('codex_router_') || phase.startsWith('codex_model_') || phase === 'codex_route_applied') return `router:${token(r['session_id']) ?? 'unknown'}:${token(r['prompt_id']) ?? 'unknown'}`;
  return `gate:${token(r['session_id']) ?? 'unknown'}:${token(r['execution_prompt_id']) ?? token(r['prompt_id']) ?? 'unknown'}`;
};
const modGroup = (row: ModRecord): string => row.component === 'router'
  ? `router:${token(row.rec['session_id']) ?? 'legacy'}:${token(row.rec['turn']) ?? token(row.rec['tool_use_id']) ?? 'session'}`
  : `${row.component}:${token(row.rec['session_id']) ?? 'legacy'}:${token(row.rec['run_id']) ?? row.at}`;

/** The dashboard's activity strips and per-minute rates read the last minute of records, so no cut below may drop one of them. */
const ACTIVITY_WINDOW_MS = 60_000, ACTIVITY_CAP = 1000;

/** The first `k` of a stable sort by `order`, without sorting everything. */
const firstSorted = <T>(items: T[], k: number, order: (a: T, b: T) => number): T[] => {
  const top: T[] = [];
  for (const item of items) {
    if (top.length === k && order(item, top[k - 1]!) >= 0) continue;
    let i = top.length;
    while (i > 0 && order(item, top[i - 1]!) < 0) i--;
    top.splice(i, 0, item);
    if (top.length > k) top.pop();
  }
  return top;
};

/** Where one pass over the whole recording first inserts a run: records in order, then Router and Compact rows by time, then native Codex rows by time. */
type Rank = { cls: 0 | 1 | 2; at: string; index: number };
/** `until`: the first time an age test in it answers differently; it is the same output until then. */
interface Part { runs: OperationRun[]; ranks: Rank[]; requests: string[]; managed: boolean; until: number; origins: Array<{ agent: string; row: ModRecord; routing: Routing }> }

/** The session a record or row ends: [session key, time]. */
const sessionEnd = (item: Rec | ModRecord, mod: boolean): [string, string] | null => {
  if (mod) {
    const row = item as ModRecord;
    return row.component === 'router' && row.at && row.rec['event'] === 'session_end' && token(row.rec['session_id']) ? [JSON.stringify(['claude', row.rec['session_id']]), row.at] : null;
  }
  const r = item as Rec, at = iso(r['written_at']);
  return r['host'] === 'codex' && token(r['session_id']) && at && r['phase'] === 'codex_event' && r['event'] === 'SessionEnd' ? [JSON.stringify(['codex', r['session_id']]), at] : null;
};
/** A split build hands each part the session ends recorded anywhere, and the native session ends and child origins recorded in
 * other parts. `position` is an item's place in one pass's order of its kind; `read` collects the sessions and agents read. */
interface PartContext { sessions: Ends; read: Set<string>; position: (item: Rec | ModRecord) => number; codexEnds: Rec[]; children: (agent: string) => Origin[] }

/** The executions of records that join nothing outside them (see `sync`). */
const buildPart = (records: Rec[], mods: ModRecord[], now: Date, context?: PartContext): Part => {
  // A native child skips routing on every model step; one row per step would bury the run list. Each part drops its own,
  // so a rebuild does not pass over every row of the history for them.
  mods = mods.filter(m => !(m.component === 'router' && m.rec['event'] === 'child_route' && m.rec['skipped'] === 'native_child'));
  let sessions = context?.sessions;
  if (!sessions) {
    const own: Ends = sessions = new Map();
    const note = (end: [string, string] | null): void => { if (end) own.set(end[0], [...own.get(end[0]) ?? [], { at: end[1], interrupted: false }]); };
    for (const r of records) note(sessionEnd(r, false));
    for (const row of mods) note(sessionEnd(row, true));
  }
  records = allocatedTraceRecords(records);
  const codexDecisions = new Map<string, Rec>();
  const codexKey = (r: Rec): string | null => r['host'] === 'codex' && token(r['session_id']) && token(r['prompt_id']) ? JSON.stringify([r['session_id'], r['prompt_id'], r['scope'] === 'child' ? r['agent_id'] : null, r['scope'] === 'child' ? r['index'] ?? null : null]) : null;
  // Only a decision's own rows read a key; the other rows of a long turn need none.
  for (const r of records) if (r['phase'] === 'codex_router_result') { const key = codexKey(r); if (key) codexDecisions.set(key, r); }
  if (codexDecisions.size) records = records.map(r => {
    const decision = ['codex_route_applied', 'codex_router_response'].includes(String(r['phase'])) ? codexDecisions.get(codexKey(r) ?? '') : undefined;
    return decision && iso(decision['written_at']) <= iso(r['written_at']) ? { ...r, reasons: decision['reasons'], baseline_model: r['baseline_model'] ?? decision['baseline_model'], answers: decision['answers'], selection: decision['selection'] } : r;
  });
  // A request row can display the actual response only when its exact binding has a later response.
  const responseBindings = new Map<string, Rec>();
  const modelTerminals = new Map<string, string>();
  for (const r of records) {
    if (!['codex_router_response', 'codex_model_failure'].includes(String(r['phase']))) continue;
    const key = modelRequestKey(r); if (!key) continue;
    const at = iso(r['written_at']);
    if (at && at >= (modelTerminals.get(key) ?? '')) modelTerminals.set(key, at);
    if (r['phase'] === 'codex_router_response' && at && at >= iso(responseBindings.get(key)?.['written_at'])) responseBindings.set(key, r);
  }
  const live: Liveness = { now: now.getTime(), seen: new Map(), ends: new Map(), sessions, read: context?.read ?? new Set(), until: Infinity };
  const observe = (loop: string, at: string, end?: { key: string; interrupted: boolean }) => {
    if (at > (live.seen.get(loop) ?? '')) live.seen.set(loop, at);
    if (end) live.ends.set(end.key, [...live.ends.get(end.key) ?? [], { at, interrupted: end.interrupted }]);
  };
  for (const r of records) {
    const at = iso(r['written_at']), event = r['phase'] === 'codex_event' ? r['event'] : null;
    if (r['host'] !== 'codex' || !token(r['session_id']) || !at) continue;
    observe(codexLoop(r), at, (event === 'Stop' || event === 'Interrupt') && token(r['prompt_id']) ? { key: codexLoop(r), interrupted: event === 'Interrupt' } : undefined);
  }
  for (const row of mods) if (row.component === 'router' && row.at) {
    const r = row.rec, loop = routerResponseKey(r, 'loop');
    // Recorded Router rows may carry no session; an unidentified session end cannot end anything (`sessionEnd`).
    observe(loop, row.at, r['event'] === 'turn_end' && token(r['turn']) ? { key: loop, interrupted: r['reason'] === 'aborted' } : undefined);
  }
  if (responseBindings.size) records = records.map(r => {
    const response = r['phase'] === 'codex_route_applied' ? responseBindings.get(modelRequestKey(r) ?? '') : undefined;
    return response && iso(response['written_at']) >= iso(r['written_at']) ? { ...r, observed_model: response['observed_model'], observed_effort: response['observed_effort'] } : r;
  });
  // #268: a Router spawn patch changes the model the host runs, so the caller's argument is only what it asked for.
  const routedSpawns = new Map<string, string>();
  for (const row of mods) if (row.component === 'router' && row.rec['event'] === 'spawn_result' && row.rec['denied'] !== true && token(row.rec['tool_use_id']) && token(row.rec['requested'])) routedSpawns.set(JSON.stringify([row.rec['session_id'] ?? 'legacy', row.rec['tool_use_id']]), token(row.rec['requested'])!);
  if (routedSpawns.size) records = records.map(r => {
    const routed = ['post', 'failure', 'background_launch'].includes(String(r['phase'])) ? routedSpawns.get(JSON.stringify([r['session_id'] ?? 'legacy', r['tool_use_id']])) : undefined;
    return routed && routed !== r['requested_model'] ? { ...r, routed_model: routed } : r;
  });
  // routedModRecords visits rows in this stable time order.
  const order = mods.map((_, i) => i).sort((a, b) => mods[a]!.at.localeCompare(mods[b]!.at));
  const origins: Part['origins'] = [];
  mods = routedModRecords(mods, records, context, origins);
  const resultIds = new Set(records.flatMap((r) => token(r['request_id']) && token(r['phase']) ? [`${token(r['request_id'])}:${token(r['phase'])}`] : []));
  for (const r of records) if (r['phase'] === 'background_terminal') resultIds.add(`background:${token(r['session_id'])}:${token(r['execution_prompt_id']) ?? token(r['prompt_id'])}:${token(r['tool_use_id'])}`);
  const intents = new Map(records.flatMap((r): Array<[string, string]> => {
    const phase = token(r['phase']); if (!phase?.endsWith('_intent')) return [];
    const requestId = token(r['request_id']); const at = iso(r['written_at']);
    return requestId && at ? [[`${requestId}:${phase}`, at]] : [];
  }));
  const closed = new Set(mods.flatMap((row) => {
    const own = row.component === 'router' ? token(row.rec['turn']) ?? token(row.rec['tool_use_id']) : token(row.rec['run_id']);
    if (!own) return [];
    const key = row.component === 'router' ? routerDecisionKey(row.rec) : `${token(row.rec['session_id']) ?? 'legacy'}:${own}`;
    return row.component === 'router' ? ['root', 'spawn', 'spawn_stop', 'spawn_denied', 'child_route'].includes(String(row.rec['event'])) ? [`router:${key}`] : [] : row.rec['stage'] === 'post' || typeof row.rec['applied'] === 'boolean' ? [`${row.component}:${key}`] : [];
  }));
  const responses = new Map<string, string>();
  for (const row of mods) if (['root_result', 'child_result', 'spawn_result', 'spawn_native_result', 'model_failure'].includes(String(row.rec['event']))) {
    // Older prepared records have no loop index. A later response in that exact turn still closes them.
    for (const index of [row.rec['index'] ?? null, null]) {
      const key = routerResponseKey(row.rec, index);
      if ((responses.get(key) ?? '') < row.at) responses.set(key, row.at);
    }
  }
  const grouped = new Map<string, { source: OperationRun['source']; host: Host; mode: string; executionId?: string; steps: OperationStep[]; rank: Rank }>();
  for (const [index, r] of records.entries()) {
    const step = traceStep(r, resultIds, intents, modelTerminals, live);
    if (!step) continue;
    const host = r['host'] === 'codex' ? 'codex' : 'claude';
    const source = gateGroup(r).split(':')[0] as OperationRun['source'];
    const key = `${host}:${gateGroup(r)}`;
    const session = token(r['session_id']); const prompt = token(r['execution_prompt_id']) ?? token(r['prompt_id']);
    const group = grouped.get(key) ?? { source, host, mode: token(r['mode']) ?? 'unknown',
      ...(session && prompt ? { executionId: id(`execution:${host}:${session}:${prompt}`) } : {}), steps: [], rank: { cls: 0, at: '', index } };
    const phase = token(r['phase']);
    if (r['attempted'] === true && ['admission_result', 'pre_result', 'codex_router_result'].includes(phase ?? '')) {
      const { durationMs: _duration, elapsedMs: _elapsed, judgements: _judgements, receipt: _receipt, ...rest } = step;
      const { executionPath: _executionPath, ...response } = step;
      group.steps.push({ ...response, title: step.title.replace(/ · .+$/, ' · Jev 응답'), summary: step.state === 'error' ? 'Jev 판정 실패 · 원래 호출 유지' : step.judgements?.length
        ? `${step.judgements.length}개 선택형 응답 · 코드가 정책 판정에 사용`
        : '응답 기록 · 선택형 결과 미확인' });
      group.steps.push({ ...rest, id: id(`${step.id}:policy`), state: step.state === 'error' ? 'done' : step.state, lane: 'policy', details: phase === 'admission_result' ? step.details : [], summary: step.summary });
    } else group.steps.push(step);
    if (group.mode === 'unknown' && token(r['mode'])) group.mode = token(r['mode'])!;
    grouped.set(key, group);
  }
  for (const [position, row] of mods.entries()) {
    const step = modStep(row, closed, responses, live);
    if (!step) continue;
    const key = modGroup(row);
    const group = grouped.get(key) ?? { source: row.component, host: 'claude' as const, mode: row.component, steps: [], rank: { cls: 1, at: row.at, index: order[position]! } };
    group.steps.push(step);
    grouped.set(key, group);
  }
  const separate = [...grouped].map(([key, group]): { run: OperationRun; rank: Rank } => {
    const steps = group.steps.sort((a, b) => a.at.localeCompare(b.at) || (a.lane === 'policy' ? 1 : 0) - (b.lane === 'policy' ? 1 : 0) || a.id.localeCompare(b.id));
    const state = operationState(steps);
    const title = ({ gate: '게이트 세션', router: 'Router 실행', compact: 'Compact 실행', codex: 'Codex 실행' } as const)[group.source];
    return { run: { id: id(key), ...(group.executionId ? { executionId: group.executionId } : {}), host: group.host, title, source: group.source, mode: group.mode, firstAt: steps[0]?.at ?? '', lastAt: steps.at(-1)?.at ?? '', state, steps }, rank: group.rank };
  });
  const native = codexOperations(records, now, at => flipsAt(live, at), context?.codexEnds.length ? { ends: context.codexEnds, position: context.position } : undefined);
  const position = new Map<Rec, number>(native.length ? records.map((r, i) => [r, i]) : []);
  for (const run of native) separate.push({ run, rank: { cls: 2, at: run.firstAt, index: position.get(firstRow.get(run)!)! } });
  // Display the whole known turn rather than three unrelated Router/Gate/native cards.
  const executions = new Map<string, { run: OperationRun; rank: Rank }>();
  for (const { run, rank } of separate) {
    const key = run.executionId ?? run.id; const entry = executions.get(key);
    if (!entry) { executions.set(key, { run: { ...run, id: key }, rank }); continue; }
    const existing = entry.run;
    const primary = existing.source === 'gate' ? existing : run.source === 'gate' ? run : existing.source !== 'codex' ? existing : run;
    const steps = [...existing.steps, ...run.steps].sort((a, b) => a.at.localeCompare(b.at) || (a.lane === 'policy' ? 1 : 0) - (b.lane === 'policy' ? 1 : 0) || a.id.localeCompare(b.id));
    entry.run = { ...primary, id: key, steps, firstAt: steps[0]!.at, lastAt: steps.at(-1)!.at, state: operationState(steps) };
  }
  const requests = new Set<string>();
  for (const r of records) {
    const phase = token(r['phase']) ?? '';
    if (phase === 'codex_compact' && r['stage'] === 'selection_intent' && token(r['selection_id'])) { requests.add(`codex-compact:${token(r['selection_id'])}`); continue; }
    if (!['admission_intent', 'pre_intent', 'codex_router_intent'].includes(phase)
      && !(r['attempted'] === true && ['admission_result', 'pre_result', 'codex_router_result'].includes(phase))) continue;
    const kind = phase.replace(/_(intent|result)$/, '');
    requests.add(`${kind}:${token(r['request_id']) ?? token(r['invocation_id']) ?? iso(r['written_at'])}`);
  }
  for (const row of mods) {
    if (row.component === 'compact' && row.rec['jev_sent'] === true) { requests.add(`compact:claude:${token(row.rec['session_id']) ?? 'legacy'}:${token(row.rec['run_id']) ?? row.at}`); continue; }
    if (row.component !== 'router' || (row.rec['event'] !== 'request' && row.rec['sent'] !== true)) continue;
    requests.add(`router:${routerDecisionKey(row.rec)}`);
  }
  const managed = records.some(r => r['host'] === 'codex' && (r['managed'] === true || traceFeature(String(r['phase'])) !== null));
  return { runs: [...executions.values()].map(e => e.run), ranks: [...executions.values()].map(e => e.rank), requests: [...requests], managed, until: live.until, origins };
};

/** One item of the recording: a trace record or a Router/Compact row. */
type Item = Rec | ModRecord;
/** Every value through which buildPart relates an item to another: its run, execution, request and run ids, its Router
 * decision, response and turn keys, its Codex loop and native spans. Items that share none build apart (`sync`). A session or
 * a child agent joins nothing by itself: its ends and its origins reach every part (`PartContext`). */
const relations = (item: Item, mod: boolean): string[] => {
  if (mod) {
    const row = item as ModRecord, r = row.rec, keys = [`group:${modGroup(row)}`];
    if (row.component !== 'router') return keys;
    const session = r['session_id'] ?? 'legacy';
    for (const [name, key] of [['rtool', 'tool_use_id'], ['rturn', 'turn']] as const) if (token(r[key])) keys.push(`${name}:${JSON.stringify([session, r[key]])}`);
    keys.push(`rresp:${routerResponseKey(r)}`, `rresp:${routerResponseKey(r, null)}`, `rresp:${routerResponseKey(r, 'loop')}`, `rdec:${routerDecisionKey(r)}`);
    return keys;
  }
  const r = item as Rec, phase = token(r['phase']), host = r['host'] === 'codex' ? 'codex' : 'claude', session = token(r['session_id']), keys: string[] = [];
  if (phase && traceFeature(phase)) {
    const group = gateGroup(r), prompt = token(r['execution_prompt_id']) ?? token(r['prompt_id']);
    keys.push(`group:${host}:${group}`);
    if (session && prompt) keys.push(`exec:execution:${host}:${session}:${prompt}`);
  }
  for (const name of ['request_id', 'run_id']) if (typeof r[name] === 'string') keys.push(`${name}:${r[name]}`);
  if (typeof r['session_id'] === 'string' && typeof r['tool_use_id'] === 'string') keys.push(`alloc:${JSON.stringify([r['host'] ?? 'claude', r['session_id'], r['tool_use_id']])}`);
  if (r['host'] !== 'codex' && ['pre_result', 'post', 'failure', 'background_launch'].includes(phase ?? '') && token(r['tool_use_id'])) keys.push(`rtool:${JSON.stringify([r['session_id'] ?? 'legacy', r['tool_use_id']])}`);
  if (phase?.startsWith('background_')) keys.push(`bg:${session}:${token(r['execution_prompt_id']) ?? token(r['prompt_id'])}:${token(r['tool_use_id'])}`);
  if (r['host'] === 'codex' && session || phase === 'codex_model_request') keys.push(`cloop:${codexLoop(r)}`);
  if (codexRow(r)) {
    const run = codexRunKey(r);
    if (run) keys.push(`cgroup:${run}`);
    if (run && !run.includes(':agent:') && !run.endsWith(':session')) keys.push(`exec:execution:${run}`);
    for (const end of ['PostToolUse', 'SubagentStop', 'Stop', 'Interrupt']) { const span = codexSpanKey(r, end); if (span) keys.push(`span:${span}`); }
  }
  return keys;
};

/** `pos` is the item's index in its own list (records or rows): records keep their order across reads, so it moves with the
 * others and the sorted lists below stay sorted. */
interface Node { item: Item; mod: boolean; parent: Node | null; size: number; pos: number; stamp: number; group: Group | null }
/** Items joined by their relations; `reads` names the session ends its build used. */
interface Group { nodes: Node[]; built: Built | null; reads: string[]; alive: boolean }
/** A run with where one pass would put it: `node` is its rank item, `ord` its place within its build. */
interface Entry { run: OperationRun; cls: Rank['cls']; at: string; node: Node; built: Built; ord: number; failed: boolean; active: boolean }
interface Ref { e: Entry; i: number; s: OperationStep }
/** The last observation of an operation in one build, and its last success. */
interface Observed { at: string; ok: boolean; ref: Ref; okAt: string }
/** One group's build and what it adds to the view's totals. `regular`: every step time has one fixed format, so text and
 * locale order agree and the totals below can be read from sorted lists. `seq` orders builds with the same newest step. */
interface Built { group: Group; part: Part; seq: number; entries: Entry[]; maxAt: string; regular: boolean; features: Map<FeatureId, { count: number; maxAt: string }>;
  durations: number[]; latest: Map<string, Ref>; obs: Map<string, Observed>; origins: Exported[]; lists: { nonLife: Ref[]; life: Ref[]; timed: Ref[] } | null }
/** A child origin a build records; `sig` is what its readers see of it. */
interface Exported { agent: string; at: string; node: Node; routing: Routing; sig: string }
/** What one sync changes besides the builds: durations added and dropped, and each touched agent's origins as they were. */
interface Pending { add: number[]; drop: number[]; origins: Map<string, string> }
const REGULAR = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
type SessionEnds = Map<string, Array<{ at: string; interrupted: boolean; item: Item }>>;
const fresh = () => ({
  nodes: new Map<Item, Node>(), owner: new Map<string, Node>(), stamp: 0, seq: 0, at: -Infinity,
  // The nodes of the last records and rows in order, so a sync looks up only the items that changed between reads.
  lists: [[], []] as Node[][],
  ends: new Map() as SessionEnds, codexEnds: new Map<string, Rec[]>(), readers: new Map<string, Set<Group>>(), finite: new Set<Built>(),
  runs: [] as Entry[], active: new Set<Entry>(), requests: new Map<string, number>(), managed: 0, irregular: 0,
  featureCount: new Map<FeatureId, number>(), featureAts: new Map<FeatureId, string[]>(), newest: [] as Built[], durations: [] as number[],
  latest: new Map<string, Ref[]>(), obsLast: new Map<string, Observed[]>(), obsOk: new Map<string, string[]>(), origins: new Map<string, Exported[]>(),
});
let split = fresh();
let viewUntil = Infinity;
/** The earliest time the last buildOperations output can change without a new record: a build's next age flip or a
 * last-minute or today total moving on (`viewUntil`). */
export const operationsStableUntil = (): number => {
  let next = viewUntil;
  for (const b of split.finite) if (b.part.until < next) next = b.part.until;
  return next;
};

/** The index after the last item of `list` (sorted by `cmp`) that does not sort after `item`. */
const upper = <T>(list: T[], item: T, cmp: (a: T, b: T) => number): number => {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cmp(list[mid]!, item) <= 0) lo = mid + 1; else hi = mid; }
  return lo;
};
const insert = <T>(list: T[], item: T, cmp: (a: T, b: T) => number): void => { list.splice(upper(list, item, cmp), 0, item); };
const remove = <T>(list: T[], item: T, cmp: (a: T, b: T) => number): void => {
  let i = upper(list, item, cmp) - 1;
  while (i >= 0 && list[i] !== item && cmp(list[i]!, item) === 0) i--;
  if (list[i] !== item) i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
};
const listOf = <K, T>(map: Map<K, T[]>, key: K): T[] => { let list = map.get(key); if (!list) map.set(key, list = []); return list; };
const byNumber = (a: number, b: number): number => a - b;
const byText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** One pass's run order: newest last step first, then where the pass first inserted the run (`Rank`). */
const order = (a: Entry, b: Entry): number => b.run.lastAt.localeCompare(a.run.lastAt) || a.cls - b.cls || a.at.localeCompare(b.at) || a.node.pos - b.node.pos;
const runOrder = (a: Entry, b: Entry): number => a.built === b.built ? a.ord - b.ord : order(a, b);
/** The order of one pass's flat step list: runs in order, steps in run order. */
const allOrder = (a: Ref, b: Ref): number => a.e === b.e ? a.i - b.i : runOrder(a.e, b.e);
const newestFirst = (a: OperationStep, b: OperationStep): number => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
// A stable sort of the flat list by these equals a sort by these and then `allOrder`.
const newestRef = (a: Ref, b: Ref): number => newestFirst(a.s, b.s) || allOrder(a, b);
const timedRef = (a: Ref, b: Ref): number => b.s.at.localeCompare(a.s.at) || allOrder(a, b);
// One pass keeps the later of two observations at the same time.
const lastFirst = (a: Observed, b: Observed): number => a.at === b.at ? allOrder(b.ref, a.ref) : a.at > b.at ? -1 : 1;
// A total order: many builds without a step share an empty maxAt, and a removal must not scan them all.
const byMaxAt = (a: Built, b: Built): number => b.maxAt.localeCompare(a.maxAt) || a.seq - b.seq;
const byOrigin = (a: Exported, b: Exported): number => a.at.localeCompare(b.at) || a.node.pos - b.node.pos;
const originsSig = (list: Exported[] | undefined): string => list?.map(o => o.sig).join('\n') ?? '';
const timed = (s: OperationStep): boolean => s.lane === 'jev' && s.durationMs !== undefined;
const lists = (b: Built): NonNullable<Built['lists']> => {
  if (b.lists) return b.lists;
  const nonLife: Ref[] = [], life: Ref[] = [], measured: Ref[] = [];
  for (const e of b.entries) e.run.steps.forEach((s, i) => { const ref = { e, i, s }; (s.lifecycle ? life : nonLife).push(ref); if (timed(s)) measured.push(ref); });
  return b.lists = { nonLife: nonLife.sort(newestRef), life: life.sort(newestRef), timed: measured.sort(timedRef) };
};

const summarize = (group: Group, part: Part, records: Node[], mods: Node[]): Built => {
  const origins = part.origins.map(({ agent, row, routing }) => ({ agent, at: row.at, node: split.nodes.get(row)!, routing, sig: `${row.at}\t${JSON.stringify(routing)}` }));
  const b: Built = { group, part, seq: ++split.seq, entries: [], maxAt: '', regular: true, features: new Map(), durations: [], latest: new Map(), obs: new Map(), origins, lists: null };
  part.runs.forEach((run, i) => {
    const rank = part.ranks[i]!;
    b.entries.push({ run, cls: rank.cls, at: rank.at, node: (rank.cls === 1 ? mods : records)[rank.index]!, built: b, ord: 0, failed: run.steps.some(failed), active: run.steps.some(s => s.state === 'active') });
  });
  b.entries.sort(order).forEach((e, ord) => { e.ord = ord; });
  for (const e of b.entries) e.run.steps.forEach((s, i) => {
    s.summary = intern(s.summary);
    for (let k = 0; k < s.details.length; k++) s.details[k] = intern(s.details[k]!);
    if (!REGULAR.test(s.at)) b.regular = false;
    if (s.at > b.maxAt) b.maxAt = s.at;
    if (!s.lifecycle && s.feature !== 'connection') { const f = b.features.get(s.feature); if (!f) b.features.set(s.feature, { count: 1, maxAt: s.at }); else { f.count++; if (s.at > f.maxAt) f.maxAt = s.at; } }
    const ref = { e, i, s };
    if (timed(s)) b.durations.push(s.durationMs!);
    if (s.lane === 'jev' && s.state !== 'active') { const key = `${e.run.host}:${s.feature}`, best = b.latest.get(key); if (!best || newestRef(ref, best) < 0) b.latest.set(key, ref); }
    for (const [key, ok] of observations(e.run.host ?? 'claude', e.run.id, s)) {
      const known = b.obs.get(key);
      if (!known) { b.obs.set(key, { at: s.at, ok, ref, okAt: ok ? s.at : '' }); continue; }
      if (s.at >= known.at) { known.at = s.at; known.ok = ok; known.ref = ref; }
      if (ok && s.at > known.okAt) known.okAt = s.at;
    }
  });
  return b;
};

/** Adds a build to the view's totals, or takes it out. Durations change once per sync, and readers of a changed origin are
 * built again after it (`sync`). */
const account = (b: Built, add: boolean, pending: Pending): void => {
  const s = split, sign = add ? 1 : -1, put = <T>(list: T[], item: T, cmp: (a: T, b: T) => number): void => { if (add) insert(list, item, cmp); else remove(list, item, cmp); };
  for (const e of b.entries) { put(s.runs, e, order); if (e.active) { if (add) s.active.add(e); else s.active.delete(e); } }
  for (const key of b.part.requests) { const count = (s.requests.get(key) ?? 0) + sign; if (count) s.requests.set(key, count); else s.requests.delete(key); }
  if (b.part.managed) s.managed += sign;
  if (!b.regular) s.irregular += sign;
  for (const [f, { count, maxAt }] of b.features) { s.featureCount.set(f, (s.featureCount.get(f) ?? 0) + sign * count); put(listOf(s.featureAts, f), maxAt, byText); }
  for (const ms of b.durations) (add ? pending.add : pending.drop).push(ms);
  for (const o of b.origins) {
    const list = listOf(s.origins, o.agent);
    if (!pending.origins.has(o.agent)) pending.origins.set(o.agent, originsSig(list));
    put(list, o, byOrigin);
    if (!list.length) s.origins.delete(o.agent);
  }
  put(s.newest, b, byMaxAt);
  for (const [key, ref] of b.latest) put(listOf(s.latest, key), ref, newestRef);
  // A contract is checked only within its own execution, which one build holds whole.
  for (const [key, o] of b.obs) if (!key.includes('\ncontract\n')) { put(listOf(s.obsLast, key), o, lastFirst); if (o.okAt) put(listOf(s.obsOk, key), o.okAt, (x, y) => byText(y, x)); }
  if (b.part.until < Infinity) { if (add) s.finite.add(b); else s.finite.delete(b); }
};

const find = (node: Node): Node => { while (node.parent) node = node.parent = node.parent.parent ?? node.parent; return node; };
const union = (a: Node, b: Node): void => {
  let x = find(a), y = find(b);
  if (x === y) return;
  if (x.size < y.size) [x, y] = [y, x];
  y.parent = x; x.size += y.size;
};

/** Brings the groups up to the recording: new items join the groups they relate to, a removed item dissolves its group, and
 * groups whose items, read session ends or next age edge changed are built again. False when an item appears twice. */
const sync = (records: Rec[], mods: ModRecord[], now: Date, retry = true): boolean => {
  const t = now.getTime();
  if (t < split.at) split = fresh();
  const s = split, stamp = ++s.stamp, added: Node[] = [], dirty = new Set<Group>(), pending: Pending = { add: [], drop: [], origins: new Map() };
  s.at = t;
  let known = 0;
  const walk = (items: Item[], mod: boolean): boolean => {
    // New records land between a kept head and tail (another host's records follow), which keep their nodes.
    const before = s.lists[+mod]!, m = before.length, n = items.length, nodes = new Array<Node>(n);
    let head = 0, tail = 0;
    while (head < n && head < m && items[head] === before[head]!.item) head++;
    while (tail < n - head && tail < m - head && items[n - 1 - tail] === before[m - 1 - tail]!.item) tail++;
    for (let pos = 0; pos < head; pos++) (nodes[pos] = before[pos]!).stamp = stamp;
    for (let pos = n - tail; pos < n; pos++) { const node = nodes[pos] = before[pos - n + m]!; node.pos = pos; node.stamp = stamp; }
    known += head + tail;
    let last = head - 1;
    for (let pos = head; pos < n - tail; pos++) {
      const item = items[pos]!, node = s.nodes.get(item);
      if (!node) { const created: Node = nodes[pos] = { item, mod, parent: null, size: 1, pos, stamp, group: null }; s.nodes.set(item, created); added.push(created); continue; }
      // Records keep their relative order across reads; anything else starts over.
      if (node.stamp === stamp || node.mod !== mod || node.pos <= last || node.pos >= m - tail) return false;
      last = node.pos; node.pos = pos; node.stamp = stamp; known++; nodes[pos] = node;
    }
    s.lists[+mod] = nodes;
    return true;
  };
  if (!walk(records, false) || !walk(mods, true)) { split = fresh(); return retry && sync(records, mods, now, false); }
  const touch = (key: string): void => { for (const g of s.readers.get(key) ?? []) dirty.add(g); };
  const unread = (g: Group): void => { for (const key of g.reads) { const set = s.readers.get(key); set?.delete(g); if (set?.size === 0) s.readers.delete(key); } g.reads = []; };
  const drop = (g: Group): void => { if (g.built) account(g.built, false, pending); g.built = null; unread(g); };
  const noteEnd = (node: Node, add: boolean): void => {
    const end = sessionEnd(node.item, node.mod), r = node.item as Rec;
    if (end) {
      const list = listOf(s.ends, end[0]);
      if (add) list.push({ at: end[1], interrupted: false, item: node.item }); else list.splice(list.findIndex(x => x.item === node.item) >>> 0, 1);
      if (!list.length) s.ends.delete(end[0]);
      touch(end[0]);
    }
    if (!node.mod && codexRow(r) && r['event'] === 'SessionEnd') {
      const session = String(r['session_id']), list = listOf(s.codexEnds, session);
      if (add) list.push(r); else list.splice(list.indexOf(r) >>> 0, 1);
      if (!list.length) s.codexEnds.delete(session);
      touch(`cx:${session}`);
    }
  };
  const regroup: Node[] = [];
  if (known + added.length < s.nodes.size) {
    const gone = new Set<Group>();
    for (const node of s.nodes.values()) if (node.stamp !== stamp) { s.nodes.delete(node.item); noteEnd(node, false); if (node.group) gone.add(node.group); }
    for (const g of gone) {
      drop(g); g.alive = false;
      for (const node of g.nodes) {
        for (const key of relations(node.item, node.mod)) if (s.owner.get(key)?.group === g) s.owner.delete(key);
        if (node.stamp === stamp) { node.parent = null; node.size = 1; node.group = null; regroup.push(node); }
      }
    }
  }
  for (const node of added) noteEnd(node, true);
  const olds = new Set<Group>(), touched = [...regroup, ...added];
  for (const node of touched) for (const key of relations(node.item, node.mod)) {
    const owner = s.owner.get(key);
    if (!owner) { s.owner.set(key, node); continue; }
    if (owner.group) olds.add(owner.group);
    union(node, owner);
  }
  const joined = new Map<Node, Node[]>();
  for (const g of olds) { drop(g); g.alive = false; const nodes = listOf(joined, find(g.nodes[0]!)); for (const node of g.nodes) nodes.push(node); }
  for (const node of touched) listOf(joined, find(node)).push(node);
  for (const nodes of joined.values()) {
    const g: Group = { nodes: nodes.sort((a, b) => +a.mod - +b.mod || a.pos - b.pos), built: null, reads: [], alive: true };
    for (const node of nodes) node.group = g;
    dirty.add(g);
  }
  for (const b of s.finite) if (t >= b.part.until) dirty.add(b.group);
  // An origin's routing depends only on its own group, so a second round finds no further change.
  while (dirty.size) {
    const round = [...dirty]; dirty.clear();
    for (const g of round) if (g.alive) { drop(g); build(g, now); account(g.built!, true, pending); }
    for (const [agent, before] of pending.origins) {
      const after = originsSig(s.origins.get(agent));
      if (after !== before) { touch(`agent:${agent}`); pending.origins.set(agent, after); }
    }
  }
  // A duration list changes by what the builds added and dropped, net; a large change sorts it again.
  const net = new Map<number, number>();
  for (const ms of pending.add) net.set(ms, (net.get(ms) ?? 0) + 1);
  for (const ms of pending.drop) net.set(ms, (net.get(ms) ?? 0) - 1);
  let changes = 0;
  for (const count of net.values()) changes += Math.abs(count);
  if (changes > 256) s.durations = s.newest.flatMap(b => b.durations).sort(byNumber);
  else for (const [ms, count] of net) for (let k = 0; k < Math.abs(count); k++) { if (count > 0) insert(s.durations, ms, byNumber); else remove(s.durations, ms, byNumber); }
  return true;
};

const build = (g: Group, now: Date): void => {
  const s = split, records: Node[] = [], mods: Node[] = [], sessions = new Set<string>();
  for (const node of g.nodes) {
    if (node.mod) { mods.push(node); continue; }
    records.push(node);
    if (codexRow(node.item as Rec)) sessions.add(String((node.item as Rec)['session_id']));
  }
  const ends: Rec[] = [];
  for (const session of sessions) for (const r of s.codexEnds.get(session) ?? []) if (s.nodes.get(r)?.group !== g) ends.push(r);
  const read = new Set<string>(), position = (item: Item): number => s.nodes.get(item)?.pos ?? -1;
  // The group's own origins are out of the list while it builds (`drop`).
  const children = (agent: string): Origin[] => s.origins.get(agent)?.map(o => ({ at: o.at, pos: o.node.pos, routing: o.routing })) ?? [];
  const part = buildPart(records.map(n => n.item as Rec), mods.map(n => n.item as ModRecord), now, { sessions: s.ends, read, position, codexEnds: ends, children });
  g.reads = [...read, ...[...sessions].map(session => `cx:${session}`)];
  for (const key of g.reads) { let set = s.readers.get(key); if (!set) s.readers.set(key, set = new Set()); set.add(g); }
  g.built = summarize(g, part, records, mods);
};

const MODEL_ISSUES = new Set(['response_model', 'request_model', 'request_effort', 'request_unconfirmed']);
const modelCheck = (s: OperationStep): 'model' | 'request' | null => s.issue === 'response_model' || !s.issue && s.model?.status === 'mismatch' ? 'model' : s.issue && MODEL_ISSUES.has(s.issue) ? 'request' : null;
/** The operation a step belongs to on its host. A model is checked only by an observed model and a request setting only by
 * its recorded application; a worker contract only by a later receipt for the same task in the same execution (#232); any other
 * step by later records of its own kind. */
const operationKey = (host: string, run: string, s: OperationStep, check = modelCheck(s)): string => check ? `${host}\n${s.feature}\n${check}`
  : s.outcome === 'accepted' || s.outcome === 'rejected' ? `${host}\n${run}\ncontract\n${s.task ?? ''}` : `${host}\n${s.feature}\n${s.lane}\n${s.title}`;
/** What one settled step shows: [operation, worked]. */
const observations = (host: string, run: string, s: OperationStep): Array<[string, boolean]> => {
  const seen: Array<[string, boolean]> = [];
  if (s.model && s.model.status !== 'unobserved') seen.push([operationKey(host, run, s, 'model'), s.model.status === 'confirmed']);
  if (s.model?.requestApplied !== undefined) seen.push([operationKey(host, run, s, 'request'), s.model.requestApplied]);
  if ((s.state === 'done' || s.state === 'error') && !modelCheck(s)) seen.push([operationKey(host, run, s, null), s.state === 'done']);
  return seen;
};
type Known = { at: string; ok: boolean; okAt: string } | undefined;
/** What later records of a failure's operation show now, from its last observation and last success. */
const impact = (s: OperationStep, known: Known): NonNullable<OperationStep['impact']> => {
  const last = known && known.at > s.at ? known : undefined;
  // A refused contract is about that worker's result, never a service: another refusal of the task is not an ongoing incident.
  return { now: known && known.okAt > s.at ? 'later_ok' : last && s.issue !== 'contract' ? 'ongoing' : 'unknown',
    lastAt: last?.at ?? s.at, lastState: last ? last.ok ? 'done' : 'error' : s.state };
};
const impacts = new WeakMap<OperationRun, { sig: string; run: OperationRun }>();
/** Marks each failure with what later records of its operation on the same host show now, across sessions. The failure itself
 * stays as recorded. An unchanged run keeps its object, so a live patch skips it. */
const marked = (run: OperationRun, known: (s: OperationStep) => Known): OperationRun => {
  if (!run.steps.some(failed)) return run;
  const steps = run.steps.map((s): OperationStep => failed(s) ? { ...s, impact: impact(s, known(s)) } : s);
  const sig = JSON.stringify(steps.map(s => s.impact ?? null)), cached = impacts.get(run);
  if (cached?.sig === sig) return cached.run;
  const next = { ...run, steps, state: operationState(steps) };
  impacts.set(run, { sig, run: next });
  return next;
};
const withImpact = (runs: OperationRun[]): OperationRun[] => {
  // Per operation only its last observation and its last success matter: a failure compares its own time with them.
  const seen = new Map<string, NonNullable<Known>>();
  for (const run of runs) for (const s of run.steps) for (const [key, ok] of observations(run.host ?? 'claude', run.id, s)) {
    const known = seen.get(key);
    if (!known) { seen.set(key, { at: s.at, ok, okAt: ok ? s.at : '' }); continue; }
    if (s.at >= known.at) { known.at = s.at; known.ok = ok; }
    if (ok && s.at > known.okAt) known.okAt = s.at;
  }
  return runs.map(run => marked(run, s => seen.get(operationKey(run.host ?? 'claude', run.id, s))));
};

const featureView = (f: { id: FeatureId; label: string }, count: number, lastAt: string | null, managed: boolean, availability: { trace: boolean; host?: Host }): FeatureView => {
  if (availability.host === 'codex') {
    const capability = (managed ? CODEX_CAPABILITIES : CODEX_PLUGIN_CAPABILITIES)[f.id];
    return { ...f, capability, count, lastAt, state: capability.mode === 'unsupported' ? 'unsupported' : count ? 'observed' : availability.trace ? 'waiting' : 'unavailable' };
  }
  return { ...f, count, lastAt, state: count ? 'observed' : availability.trace ? 'waiting' : 'unavailable' };
};
const addToday = (today: OperationsView['latency']['today'], s: OperationStep, host: Host | undefined): void => {
  const sum = today[host ?? 'claude'] ??= { calls: 0, input: 0, costUsd: 0, unpriced: 0 };
  sum.calls++; sum.input += s.receipt?.input ?? 0;
  if (s.receipt?.costUsd != null) sum.costUsd += s.receipt.costUsd; else sum.unpriced++;
};
const midnight = (now: Date): number => { const next = new Date(now); next.setHours(24, 0, 0, 0); return next.getTime(); };

/** One pass's view of runs in run order. `noteUntil` also notes when it next changes without a new record (`viewUntil`). */
const viewOf = (sorted: OperationRun[], requests: number, managed: boolean, now: Date, availability: { trace: boolean; host?: Host }, noteUntil: boolean): OperationsView => {
  const allRuns = withImpact(sorted);
  // A busy, older execution must remain visible even when newer completed turns fill the recent window.
  const recentIds = new Set(allRuns.slice(0, 200).map(run => run.id));
  const runs = allRuns.filter(run => recentIds.has(run.id) || run.steps.some(step => step.state === 'active'));
  const all = allRuns.flatMap((run) => run.steps.map((step) => ({ ...step, runId: run.id, runTitle: run.title, host: run.host })));
  const features = FEATURES.map((f): FeatureView => {
    const steps = all.filter((s) => s.feature === f.id && !s.lifecycle);
    return featureView(f, steps.length, steps.length ? steps.map((s) => s.at).sort().at(-1)! : null, managed, availability);
  });
  const durations = all.filter((s) => s.lane === 'jev' && s.durationMs !== undefined).map((s) => s.durationMs!).sort((a, b) => a - b);
  const latest = all.filter((s) => s.lane === 'jev' && s.durationMs !== undefined).sort((a, b) => b.at.localeCompare(a.at))[0]?.durationMs ?? null;
  const percentile = (p: number): number | null => durations.length ? durations[Math.ceil(p * durations.length) - 1]! : null;
  const sinceMs = now.getTime() - ACTIVITY_WINDOW_MS;
  // ponytail: past ACTIVITY_CAP records in one minute only the newest ones are kept, so a burst that large would under-count.
  const timed = all.filter((s) => s.lane === 'jev' && s.durationMs !== undefined).sort((a, b) => b.at.localeCompare(a.at));
  const recent = timed.filter((s, i) => i < 16 || Date.parse(s.at) >= sinceMs).slice(0, ACTIVITY_CAP).reverse().map((s) => ({ at: s.at, ms: s.durationMs! }));
  const today: OperationsView['latency']['today'] = {}, day = now.toDateString();
  for (const s of all) if (s.lane === 'jev' && s.durationMs !== undefined && new Date(s.at).toDateString() === day) addToday(today, s, s.host);
  const latency = { measured: durations.length, p50: percentile(.5), p95: percentile(.95), fastest: durations[0] ?? null, latest, recent, today };
  // Tool and policy loops must not evict the most recent recorded Jev call for either host/feature.
  const latestJev = new Map<string, typeof all[number]>();
  for (const step of all.filter(s => s.lane === 'jev' && s.state !== 'active').sort(newestFirst)) {
    const key = `${step.host}:${step.feature}`;
    if (!latestJev.has(key)) latestJev.set(key, step);
  }
  // The newest-120 cut must not drop a record of the last minute; the same cap as `latency.recent` applies.
  const newest = firstSorted(all.filter(s => !s.lifecycle), 120, newestFirst);
  const feed = [...new Set([...newest,
    ...firstSorted(all.filter(s => !s.lifecycle && Date.parse(s.at) >= sinceMs), ACTIVITY_CAP, newestFirst),
    ...firstSorted(all.filter(s => s.lifecycle), 20, newestFirst), ...latestJev.values()])].sort(newestFirst);
  if (noteUntil) {
    // Today's totals restart at local midnight. A step leaves the last-minute lists just past a minute after it, which
    // changes them only for a step past their newest 16 calls or 120 steps.
    viewUntil = midnight(now);
    const leaves = (s: { at: string }): void => { const left = Date.parse(s.at) + ACTIVITY_WINDOW_MS + 1; if (left > now.getTime() && left < viewUntil) viewUntil = left; };
    for (const s of timed.slice(16)) leaves(s);
    if (newest.length === 120) for (const s of all) if (!s.lifecycle && newestFirst(s, newest.at(-1)!) > 0) leaves(s);
  }
  return { runs, features, feed, active: runs.filter((r) => r.state === 'active').length, attention: runs.filter((r) => r.state === 'attention').length, requests, latency };
};

/** The first `k` steps of one kind by `cmp`, read from the builds with the newest steps until no older build can reach them. */
const top = (kind: keyof NonNullable<Built['lists']>, k: number, cmp: (a: Ref, b: Ref) => number): Ref[] => {
  const out: Ref[] = [];
  for (const b of split.newest) {
    if (out.length === k && b.maxAt < out[k - 1]!.s.at) break;
    for (const ref of lists(b)[kind]) {
      if (out.length === k && cmp(ref, out[k - 1]!) >= 0) break;
      insert(out, ref, cmp);
      if (out.length > k) out.pop();
    }
  }
  return out;
};
/** Every step of one kind at or after `since`. */
const since = (kind: keyof NonNullable<Built['lists']>, from: string): Ref[] => {
  const out: Ref[] = [];
  for (const b of split.newest) {
    if (b.maxAt < from) break;
    for (const ref of lists(b)[kind]) { if (ref.s.at < from) break; out.push(ref); }
  }
  return out;
};

/** The view `viewOf` draws from the same runs, read from the totals the builds keep instead of a pass over every step. */
const splitView = (now: Date, availability: { trace: boolean; host?: Host }): OperationsView => {
  const s = split, t = now.getTime();
  if (s.irregular > 0) return viewOf(s.runs.map(e => e.run), s.requests.size, s.managed > 0, now, availability, true);
  const shown = new Map<Entry, OperationRun>();
  const known = (e: Entry) => (step: OperationStep): Known => {
    const key = operationKey(e.run.host ?? 'claude', e.run.id, step);
    if (key.includes('\ncontract\n')) return e.built.obs.get(key);
    const last = s.obsLast.get(key)?.[0];
    return last && { at: last.at, ok: last.ok, okAt: s.obsOk.get(key)?.[0] ?? '' };
  };
  const mark = (e: Entry): OperationRun => { let run = shown.get(e); if (!run) shown.set(e, run = marked(e.run, known(e))); return run; };
  // A busy, older execution must remain visible even when newer completed turns fill the recent window.
  const head = s.runs.slice(0, 200), cut = head[199];
  const runs = [...head, ...cut ? [...s.active].filter(e => order(e, cut) > 0).sort(order) : []].map(mark);
  const from = new Date(t - ACTIVITY_WINDOW_MS).toISOString();
  const newest = top('nonLife', 120, newestRef), window = since('nonLife', from).sort(newestRef);
  const latestJev = [...s.latest.values()].flatMap(list => list.slice(0, 1)).sort(newestRef);
  const picked = new Set<OperationStep>(), refs: Ref[] = [];
  for (const ref of [...newest, ...window.slice(0, ACTIVITY_CAP), ...top('life', 20, newestRef), ...latestJev]) if (!picked.has(ref.s)) { picked.add(ref.s); refs.push(ref); }
  const feed = refs.sort((a, b) => newestFirst(a.s, b.s)).map(({ e, i }) => { const run = mark(e); return { ...run.steps[i]!, runId: run.id, runTitle: run.title, host: run.host }; });
  const recentTimed = top('timed', 16, timedRef), first = new Set(recentTimed.map(ref => ref.s));
  const timedRefs = [...recentTimed, ...since('timed', from).filter(ref => !first.has(ref.s))].sort(timedRef);
  const recent = timedRefs.slice(0, ACTIVITY_CAP).reverse().map(({ s: step }) => ({ at: step.at, ms: step.durationMs! }));
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today: OperationsView['latency']['today'] = {}, day = now.toDateString();
  for (const { e, s: step } of since('timed', start.toISOString()).filter(ref => new Date(ref.s.at).toDateString() === day).sort(allOrder)) addToday(today, step, e.run.host);
  const durations = s.durations, percentile = (p: number): number | null => durations.length ? durations[Math.ceil(p * durations.length) - 1]! : null;
  const latency = { measured: durations.length, p50: percentile(.5), p95: percentile(.95), fastest: durations[0] ?? null, latest: recentTimed[0]?.s.durationMs ?? null, recent, today };
  const features = FEATURES.map(f => featureView(f, s.featureCount.get(f.id) ?? 0, s.featureAts.get(f.id)?.at(-1) ?? null, s.managed > 0, availability));
  viewUntil = midnight(now);
  const leaves = (step: OperationStep): void => { const left = Date.parse(step.at) + ACTIVITY_WINDOW_MS + 1; if (left > t && left < viewUntil) viewUntil = left; };
  for (const ref of timedRefs.slice(16)) leaves(ref.s);
  if (newest.length === 120) for (const ref of window) if (newestFirst(ref.s, newest[119]!.s) > 0) leaves(ref.s);
  return { runs, features, feed, active: runs.filter((r) => r.state === 'active').length, attention: runs.filter((r) => r.state === 'attention').length, requests: s.requests.size, latency };
};

/** `whole` builds the recording in one pass with no reuse: the reference the split build must equal. */
export const buildOperations = (records: Rec[], mods: ModRecord[], now: Date, availability: { trace: boolean; host?: Host }, whole = false): OperationsView => {
  if (whole || !sync(records, mods, now)) {
    const part = buildPart(records, mods, now);
    // An item listed twice cannot be split; the next rebuild builds the whole recording again.
    if (!whole) viewUntil = now.getTime();
    return viewOf([...part.runs].sort((a, b) => b.lastAt.localeCompare(a.lastAt)), part.requests.length, part.managed, now, availability, false);
  }
  return splitView(now, availability);
};
