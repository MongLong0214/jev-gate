import { createHash } from 'node:crypto';
import { allocatedTraceRecords } from './explain.js';
import { codexOperations } from './codex-operations.js';
import { operationState } from './operation-state.js';
import { CODEX_CAPABILITIES, CODEX_PLUGIN_CAPABILITIES, type HostCapability, type Host } from './host-support.js';

/** A display model made only from named metadata fields. Raw prompts, source and debug text never leave here. */
type Rec = Record<string, unknown>;
export type FeatureId = 'admission' | 'allocation' | 'planning' | 'workers' | 'guard' | 'lean' | 'router' | 'compact' | 'output' | 'evidence';
export type StepState = 'active' | 'done' | 'skipped' | 'error' | 'unconfirmed' | 'interrupted';
export type StepLane = 'jev' | 'policy' | 'host' | 'local';

export interface OperationStep {
  id: string;
  at: string;
  feature: FeatureId;
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
  issue?: 'request_model' | 'request_effort' | 'request_unconfirmed' | 'response_model' | 'jev' | 'host' | 'evidence';
  model?: { selected: string | null; observed: string | null; status: 'confirmed' | 'mismatch' | 'unobserved'; selectedEffort: string | null; observedEffort: string | null; forwardedEffort?: string | null; effortSource?: 'host_hook' | 'provider_request'; requestApplied?: boolean };
  routing?: { scope: 'root' | 'spawn' | 'child' | 'owned'; baseline: string | null; modelReason: string | null; effortReason: string | null; proposedModel?: string; probability?: number; threshold?: number };
  /** Timings are measured by the caller or paired recorded events, never estimated from usage. */
  durationMs?: number;
  elapsedMs?: number;
  /** Native host spans store their explicit start; other records are end-stamped measurements. */
  startedAt?: string;
  judgements?: Array<{ question: string; value: string; confidence: number | null; probabilities: Array<{ label: string; value: number }> }>;
  graph?: Array<{ id: string; dependsOn: string[]; checks: number }>;
}

export interface OperationRun {
  id: string;
  /** Host/session/turn correlation, hashed locally; absent when the source cannot establish it. */
  executionId?: string;
  host?: Host;
  title: string;
  source: 'gate' | 'router' | 'compact' | 'output' | 'evidence' | 'codex';
  mode: string;
  firstAt: string;
  lastAt: string;
  state: 'active' | 'done' | 'attention' | 'unconfirmed' | 'interrupted';
  steps: OperationStep[];
}

export interface FeatureView {
  id: FeatureId;
  label: string;
  source: 'trace' | 'debug';
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
  latency: { measured: number; p50: number | null; p95: number | null; fastest: number | null; latest: number | null; recent: Array<{ at: string; ms: number }> };
  sig: string;
}

export interface DebugRecord { at: string; component: 'router' | 'compact' | 'output'; rec: Rec }

const FEATURES: Array<{ id: FeatureId; label: string; source: 'trace' | 'debug' }> = [
  { id: 'admission', label: 'Gate A · 실행 형태', source: 'trace' },
  { id: 'allocation', label: 'Gate B · 등급 배정', source: 'trace' },
  { id: 'planning', label: '계획 · 의존성', source: 'trace' },
  { id: 'workers', label: '워커 · 수락 검사', source: 'trace' },
  { id: 'guard', label: '루트 도구 가드', source: 'trace' },
  { id: 'lean', label: 'Lean · 문맥 인계', source: 'trace' },
  { id: 'router', label: 'Router · 모델과 effort', source: 'debug' },
  { id: 'compact', label: 'Compact · 요약 대체', source: 'debug' },
  { id: 'output', label: 'Output · 로그 접기', source: 'debug' },
  { id: 'evidence', label: 'Evidence · 근거 판정', source: 'trace' },
];
const TOKEN = /^[A-Za-z0-9_.:/+@-]{1,80}(?:\[[A-Za-z0-9_-]{1,16}\])?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const rec = (v: unknown): Rec | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Rec : null;
const field = (r: Rec | null, key: string): Rec | null => r ? rec(r[key]) : null;
const token = (v: unknown): string | null => typeof v === 'string' && TOKEN.test(v) && !v.toLowerCase().includes('sk-') && !v.toLowerCase().includes('jv_live_') ? v : null;
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const iso = (v: unknown): string => typeof v === 'string' && ISO.test(v) ? v : '';
const list = (v: unknown, cap = 16): string[] => Array.isArray(v) ? v.slice(0, cap).map(token).filter((x): x is string => x !== null) : [];
const id = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12);
const n = (v: number | null): string => v === null ? '?' : Number(v.toFixed(2)).toLocaleString('en-US');
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
    const value = choice ?? (score !== null ? `점수 ${n(score)}` : noul !== null ? `참 확률 ${Math.round(noul * 100)}%` : '응답');
    const distribution = choices.length ? choices : noul !== null && noul >= 0 && noul <= 1 ? [{ label: '참', value: noul }, { label: '거짓', value: 1 - noul }] : [];
    return [{ question, value, confidence: number(a['confidence']), probabilities: distribution }];
  });
  return out.length ? out : undefined;
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

const traceFeature = (phase: string): FeatureId | null => {
  if (phase === 'codex_model_request' || phase === 'codex_model_failure' || phase === 'codex_router_intent' || phase === 'codex_router_result' || phase === 'codex_router_skipped' || phase === 'codex_route_applied' || phase === 'codex_router_response') return 'router';
  if (phase === 'codex_compact') return 'compact';
  if (phase.startsWith('admission_')) return 'admission';
  if (phase.startsWith('pre_')) return 'allocation';
  if (phase.startsWith('interpretation_') || phase === 'plan') return 'planning';
  if (phase.startsWith('background_') || phase.startsWith('worktree_') || phase === 'dispatch_denied' || phase === 'dispatch' || phase === 'post' || phase === 'failure' || phase === 'stop') return 'workers';
  if (phase === 'guard') return 'guard';
  if (phase.startsWith('lean_')) return 'lean';
  if (phase.startsWith('evidence_')) return 'evidence';
  return null;
};
const traceTitle = (phase: string, r: Rec): string => ({
  codex_model_request: '모델 · 응답 대기', codex_model_failure: '모델 · 요청 실패',
  codex_router_intent: 'Router · Jev 요청', codex_router_result: 'Router · 턴 설정 결정', codex_router_skipped: 'Router · Jev 호출 생략', codex_router_response: 'Router · Codex 응답 관측', codex_route_applied: 'Router · Codex 요청 전송', codex_compact: 'Compact · Codex digest',
  admission_intent: 'Gate A · Jev 요청', admission_result: 'Gate A · 실행 형태',
  pre_intent: 'Gate B · Jev 요청', pre_result: 'Gate B · 등급 결정',
  interpretation_intent: '계획 해석 · Jev 요청', interpretation_result: '계획 해석 · 자문',
  plan: '플래너 결과 · 작업 그래프', dispatch: token(r['role']) === 'planner' ? '플래너 호출' : '워커 호출',
  background_dispatch: '백그라운드 실행 준비', background_launch: '백그라운드 워커 실행', background_conversation: '메인 대화 계속', background_terminal: '백그라운드 워커 종료',
  worktree_start: 'Worktree · 생성 시작', worktree_result: 'Worktree · 생성 결과', dispatch_denied: 'Agent 호출 거절', post: '워커 결과 · 수락 판정', failure: '호스트 호출 실패', stop: '턴 종료', guard: '루트 도구 가드',
  lean_intent: 'Lean · Jev 요청', lean_result: 'Lean · 문맥 선택', lean_dispatch: 'Lean · packet 적용', lean_post: 'Lean · executor 결과',
  evidence_start: 'Evidence · 근거 검색 시작', evidence_jev_intent: 'Evidence · Jev 판정 요청', evidence_jev_result: 'Evidence · Jev 판정 결과', evidence_cache: 'Evidence · 판정 캐시', evidence_result: 'Evidence · 근거 결과',
} as Record<string, string>)[phase] ?? phase;

const compactSelectionReason = (value: unknown): string | null => ({
  current_dependencies: '현재 작업에 필요한 근거 선택', recency_kept: '기존 최근순 유지', no_candidates: '선별할 과거 결과 없음',
  no_key: 'Jev API 키 없음', disabled: 'Jev 선별 꺼짐', not_eligible: '로컬 추출 조건 미충족 · Jev 선별 미실행', input_secret: '민감정보 감지 · 로컬 유지', input_too_large: '판정 입력 한도 초과 · 로컬 유지',
  timeout: 'Jev 응답 시간 초과 · 로컬 유지', invalid_answers: '유효하지 않은 판정 · 로컬 유지', aborted: '중단 · 판정 미적용',
  superseded: '새 턴으로 변경 · 판정 미적용', unauthorized: 'Jev 인증 실패 · 로컬 유지', credential_refused: 'Jev 인증 확인 필요 · 로컬 유지',
  error: '선별 오류 · 로컬 유지', network: 'Jev 연결 오류 · 로컬 유지', saturated: '실행 중인 Jev 요청 한도 · 로컬 유지',
} as Record<string, string>)[String(value)] ?? token(value);
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
const traceStep = (r: Rec, now: number, resultIds: Set<string>, intents: Map<string, string>, modelTerminals: Map<string, string>): OperationStep | null => {
  const phase = token(r['phase']);
  if (!phase) return null;
  const feature = phase === 'dispatch' && r['role'] === 'planner' ? 'planning' : traceFeature(phase);
  if (!feature) return null;
  const at = iso(r['written_at']);
  if (!at) return null;
  const requestId = token(r['request_id']);
  const ownId = token(r['invocation_id']) ?? `${phase}:${at}:${requestId ?? ''}`;
  const isIntent = phase.endsWith('_intent') || phase === 'evidence_start' || phase === 'worktree_start';
  const expected = phase.endsWith('_start') ? phase.replace(/_start$/, '_result') : phase.replace(/_intent$/, '_result');
  const hasResult = requestId !== null && resultIds.has(`${requestId}:${expected}`);
  const age = now - Date.parse(at);
  const compactWaiting = phase === 'codex_compact' && r['stage'] === 'selected' && !resultIds.has(`codex_compact:${token(r['run_id'])}`);
  const http = field(r, 'http');
  const failedAssessment = r['attempted'] === true && token(http?.['code']) !== null && http?.['code'] !== 'ok';
  let state: StepState = compactWaiting ? age >= 0 && age < 30_000 ? 'active' : 'unconfirmed'
    : isIntent ? hasResult ? 'done' : age >= 0 && age < 30_000 ? 'active' : 'unconfirmed'
    : r['known_not_sent'] === true || r['attempted'] === false ? 'skipped'
      : r['is_error'] === true || r['ok'] === false || failedAssessment || phase === 'failure' ? 'error' : 'done';
  const details: string[] = [];
  let issue: OperationStep['issue'];
  let summary = '';
  let lane: StepLane = 'policy';
  let graph: OperationStep['graph'];
  if (isIntent) {
    lane = phase.endsWith('_start') ? 'local' : 'jev';
    summary = phase === 'evidence_start' ? text(token(r['kind']), token(r['mode']), r['remote_configured'] === true ? '원격 판정 허용' : '로컬만') : hasResult ? '응답 기록과 연결됨' : state === 'active' ? '응답을 기다리는 중' : '응답 기록 없음 · 진행 여부 미확인';
    if (phase === 'evidence_jev_intent') summary = text(`후보 ${n(number(r['candidates']))}개`, summary);
  } else if (phase === 'worktree_result') {
    lane = 'local'; summary = r['ok'] === true ? '워커 격리 작업 공간 생성 완료' : '워커 격리 작업 공간 생성 실패';
    details.push(text(token(r['branch']), token(r['baseline']), token(r['reason'])));
  } else if (phase.endsWith('_result') && phase !== 'evidence_result') {
    lane = r['attempted'] === false || r['known_not_sent'] === true ? 'policy' : 'jev';
    details.push(...callDetails(r), ...relation(r));
    const decision = field(r, 'decision');
    const shape = token(decision?.['shape']);
    const action = token(decision?.['action']);
    const tier = token(decision?.['tier']);
    const reason = token(decision?.['reason']);
    const estimate = field(r, 'estimate');
    summary = text(shape, action, tier, reason) || (state === 'skipped' ? '전송 없이 원래 경로 유지' : '응답 기록됨');
    if (phase === 'codex_router_result') {
      summary = text(token(r['selected_model']), token(r['selected_effort']), token(r['reason']));
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
        summary = text(`선택 모델 ${selected}`, edit?.['kind'] === 'set' ? `effort ${token(edit['value']) ?? '미관측'}` : edit?.['kind'] === 'omit' ? 'effort 필드 생략' : 'effort 유지');
        details.push(summary, '최종 배정 선택 · 실제 전송과 응답 모델은 별도 관측');
      } else details.push(text(`요청 ${token(r['called_tier']) ?? '?'}`, `적용 ${tier ?? '원래 프로필'}`, token(decision?.['model'])));
    }
    if (estimate && number(estimate['saving_tokens']) !== null) details.push(`위임 가격 계산 ${n(number(estimate['saving_tokens']))} 토큰 · 측정된 절감 아님`);
    if (phase === 'lean_result') {
      summary = text(action, reason, number(decision?.['retained']) === null ? null : `유지 ${n(number(decision?.['retained']))}그룹`, number(decision?.['omitted']) === null ? null : `생략 ${n(number(decision?.['omitted']))}그룹`);
      const source = field(r, 'source');
      const groups = field(r, 'groups');
      if (source) details.push(text(`전사 범위 ${token(source['coverage']) ?? '미확인'}`, `미판정 ${n(number(source['unassessed']))}그룹`, `호스트 문맥 ${n(number(source['host_context']))}건`, `버린 분기 ${n(number(source['abandoned']))}건`));
      if (groups) details.push(text(`필수 ${n(number(groups['mandatory']))}그룹`, `선택 질문 ${n(number(groups['optional_asked']))}그룹`, `읽은 요청 ${n(number(groups['request_bytes']))}B`));
      details.push('packet 크기와 실제 토큰 절감은 다른 사실입니다');
    }
  } else if (phase === 'codex_router_skipped') {
    lane = 'policy';
    summary = ({ disabled: 'Jev 기능이 꺼져 있음', router_disabled: 'Router가 꺼져 있음', key_missing: 'Jev API 키 없음', aborted: '턴 중단으로 판단 생략', model_catalog_missing: '호스트 모델 목록에서 현재 모델을 확인할 수 없음', nothing_to_change: '변경 가능한 모델·effort 없음' } as Record<string, string>)[String(r['reason'])] ?? '원래 호스트 설정 유지';
    details.push('Jev 전송 없음 · 원래 모델·effort 유지');
  } else if (phase === 'codex_route_applied') {
    lane = 'host'; summary = text('Codex 요청에 설정 제출', token(r['submitted_model'] ?? r['observed_model']), token(r['submitted_effort']));
    details.push('요청 전송 관측 · 응답 모델과 실제 effort는 아직 미확인');
  } else if (phase === 'codex_router_response') {
    lane = 'host'; summary = text('Codex 응답 관측', token(r['observed_model']) ?? '모델 미확인', r['observed_effort'] === 'unknown' ? 'effort 미확인' : token(r['observed_effort']));
    details.push('응답이 보고한 값만 표시');
  } else if (phase === 'codex_compact') {
    lane = r['applied'] === true ? 'host' : r['jev_sent'] === true ? 'jev' : 'local';
    summary = r['stage'] === 'deferred' ? text('호스트 압축으로 넘김', compactSelectionReason(r['fallback'])) : r['applied'] === true ? '추출형 digest 설치 확인 · 요약 모델 호출 대체' : '추출형 digest 생성 · 호스트 설치 대기';
    if (r['stage'] === 'deferred') state = 'skipped';
    if ('jev_sent' in r) details.push(text(r['jev_sent'] === true ? 'Jev 작업 의존 근거 선택' : r['jev_sent'] === false ? 'Jev 전송 없음' : 'Jev 전송 여부 미확인', compactSelectionReason(r['selection']), `후보 ${n(number(r['candidates']))}/${n(number(r['available']))}`, `필수 근거 ${n(number(r['dependencies']))}`));
    if (r['jev_sent'] === true) details.push(compactUsage(r));
    details.push(text(`압축 전 ${n(number(r['before_bytes']))}B`, `digest ${n(number(r['after_bytes']))}B`, '바이트 크기 · 측정된 토큰 절감 아님'));
    if (r['stage'] === 'native_submitted') {
      lane = 'host'; state = 'unconfirmed';
      summary = text('호스트 요약 모델에 압축 요청 전송', token(r['submitted_model']), token(r['submitted_effort']));
      details.length = 0;
      details.push('Compact 전용 요청 · 일반 실행 Router 선택과 비교하지 않음', '요약 응답·호스트 설치 미관측');
    }
  } else if (phase === 'evidence_result') {
    lane = 'local';
    summary = text(token(r['status']), token(r['backend']), `근거 ${n(number(r['items']))}건`, `Jev 호출 ${n(number(r['remote_calls']))}건`, `캐시 ${n(number(r['cache_hits']))}건`);
    details.push(text(...list(r['reason_codes'])));
    const coverage = field(r, 'coverage');
    if (coverage) details.push(text(`읽은 파일 ${n(number(coverage['read_files']))}`, `후보 ${n(number(coverage['candidates']))}`, `판정 안 된 항목 ${n(number(coverage['unjudged_on_page']))}`));
    if (number(r['duration_ms']) !== null) details.push(`전체 ${n(number(r['duration_ms']))}ms`);
  } else if (phase === 'evidence_cache') {
    lane = 'local'; summary = `저장된 판정 재사용 · 후보 ${n(number(r['candidates']))}개`;
  } else if (phase === 'plan') {
    lane = 'host';
    summary = text(token(r['status']), token(r['outcome']), `작업 ${n(number(r['tasks']))}개`, number(r['chain_depth']) === null ? null : `의존 깊이 ${n(number(r['chain_depth']))}`);
    graph = Array.isArray(r['graph']) ? r['graph'].slice(0, 16).flatMap((raw) => {
      const task = rec(raw); const taskId = token(task?.['id']);
      return task && taskId ? [{ id: taskId, dependsOn: list(task['depends_on']), checks: number(task['required_checks']) ?? 0 }] : [];
    }) : undefined;
    if (graph?.length) details.push(`의존 그래프 ${graph.length}개 작업`);
    const capabilities = list(r['main_session_capabilities']);
    if (capabilities.length) details.push(`메인 세션에 남긴 기능: ${capabilities.join(', ')}`);
    const planner = field(r, 'planner_model');
    if (planner) details.push(text(`요청 모델 ${token(planner['requested']) ?? '?'}`, `실행 모델 ${token(planner['observed']) ?? '?'}`, token(planner['agreement'])));
    if (token(r['worker_isolation'])) details.push(`워커 격리 ${token(r['worker_isolation'])}`);
  } else if (phase.startsWith('background_')) {
    lane = phase === 'background_dispatch' || phase === 'background_conversation' ? 'policy' : 'host';
    const closed = resultIds.has(`background:${token(r['session_id'])}:${token(r['execution_prompt_id']) ?? token(r['prompt_id'])}:${token(r['tool_use_id'])}`);
    if (phase === 'background_dispatch') { summary = '원래 작업에 실행 예약 연결 · 시작 확인 대기'; state = closed ? 'done' : 'unconfirmed'; }
    if (phase === 'background_launch') { state = closed ? 'done' : age >= 0 && age < 30_000 ? 'active' : 'unconfirmed'; summary = closed ? '시작과 실제 종료 연결됨' : state === 'active' ? '워커 실행 중 · 메인에서 질문 가능' : '시작 기록 있음 · 종료 결과 미관측'; details.push('시작 알림은 완료·수락 결과가 아닙니다'); }
    if (phase === 'background_conversation') summary = `원래 작업 유지 · 종료 결과 대기 ${n(number(r['active']))}개`;
    if (phase === 'background_terminal') { summary = token(r['status']) === 'completed' ? '호스트에서 실제 종료 확인 · 계약 수락은 별도 검사' : '호스트에서 중단·실패 확인 · 성공 수락 없음'; state = token(r['status']) === 'completed' ? 'done' : 'interrupted'; if (r['orphaned'] === true) details.push('이전 작업 결과 · 현재 계획 미진행'); }
  } else if (phase === 'dispatch_denied') {
    lane = 'policy'; state = 'skipped';
    summary = ({ workers_active: '기존 워커 종료 대기 · 재계획 거절', planner_active: '기존 플래너 실행 중 · 중복 호출 거절' } as Record<string, string>)[String(r['reason'])] ?? text('호출 거절', token(r['reason']));
    details.push(text(token(r['tool_name']), token(r['reason'])), '이 호출은 실행되지 않았습니다');
  } else if (phase === 'dispatch') {
    lane = 'host';
    summary = text(token(r['role']), token(r['task_id']), compactSelectionReason(r['selection']), `요청 등급 ${token(r['requested_tier']) ?? '?'}`);
    details.push(text(`호출 모델 ${token(r['requested_model']) ?? '미기록'}`, r['pinned'] === true ? '모델 고정' : null, list(r['depends_on']).length ? `선행 작업 ${list(r['depends_on']).join(', ')}` : null));
    if (token(r['worker_isolation'])) details.push(`워커 격리 ${token(r['worker_isolation'])}`);
  } else if (phase === 'post') {
    lane = 'host';
    summary = text(token(r['task_id']), token(r['verdict']) ?? (r['matched'] === false ? '예약과 일치하지 않는 호출' : '결과 기록'), token(r['verdict_reason']));
    details.push(text(`요청 모델 ${token(r['requested_model']) ?? '미기록'}`, `실행 모델 ${token(r['resolved_model']) ?? '미관측'}`, token(r['subagent_type'])));
    const checks = field(r, 'reported_checks');
    if (checks) details.push(text(`worker 보고 pass ${n(number(checks['pass']))}`, `fail ${n(number(checks['fail']))}`, `미실행 ${n(number(checks['not_run']))}`));
    const verification = field(r, 'verification');
    if (verification) details.push(text(`실행 기록 ${token(verification['transcript']) ?? '미확인'}`, list(verification['contradicted']).length ? `모순 ${list(verification['contradicted']).join(', ')}` : null, list(verification['unobserved']).length ? `미관측 ${list(verification['unobserved']).join(', ')}` : null));
    if (list(r['ready_task_ids']).length) details.push(`다음 실행 가능: ${list(r['ready_task_ids']).join(', ')}`);
    if (r['plan_complete'] === true) details.push('계획의 모든 작업 수락');
    if (r['evidence_format_only'] === true) details.push('검사 명령 형식만 불일치 · 한 번의 무료 재검증 가능');
    if (r['root_fallback'] === true) details.push(r['root_fallback_reason'] === 'accepted' ? '종료된 작업 수락 · 루트에서 남은 확인 가능 · 전체 요구사항 검증과는 다름' : r['root_fallback_reason'] === 'delivery_failed' ? '필수 원문 전달 불가 · 루트 복귀' : '단일 워커 시도 상한 · 루트 도구 가드 해제');
    if (r['orphaned'] === true) details.push('이전 세대의 늦은 결과 · 현재 계획 미진행');
  } else if (phase === 'lean_dispatch') {
    lane = 'policy';
    summary = r['applied'] === true ? 'executor에 packet 적용' : token(r['reason']) === 'packet_proposed' ? 'packet 제안 · 아직 적용 전' : text('packet 미적용', token(r['reason']));
    details.push(text(`유지 ${n(number(r['retained_groups']))}그룹`, `생략 ${n(number(r['omitted_groups']))}그룹`, number(r['composed_bytes']) === null ? null : `${n(number(r['composed_bytes']))}B 합성`));
  } else if (phase === 'lean_post') {
    lane = 'host';
    summary = text(token(r['status']), r['released'] === true ? 'executor 예약 해제' : r['release_unconfirmed'] === true ? '종료 미확인 · 예약 유지' : '일치하는 예약 없음');
    details.push(text(`실행 모델 ${token(r['observed_model']) ?? '미관측'}`, token(r['failure'])));
  } else if (phase === 'guard') {
    lane = 'policy';
    summary = text(token(r['tool_name']) ?? '도구', r['allow'] === false ? '거절' : '가드 통과', r['stopped'] === true ? '예산 소진 · 턴 중단' : null);
    details.push(`누적 거절 ${n(number(r['denials']))}회`);
    if (r['reason'] === 'admission_delivery_failed') details.push(r['root_fallback'] === true ? '필수 원문 전달 불가 · 워커 미실행 · 루트에서 계속 진행' : '필수 원문 전달 불가 · 루트 복귀 저장 실패');
  } else if (phase === 'stop') {
    lane = 'host'; summary = text('턴 종료', token(r['outcome']));
  } else if (phase === 'failure') {
    lane = 'host'; summary = text('호스트 호출 실패', token(r['subagent_type']));
    details.push(text(`요청 모델 ${token(r['requested_model']) ?? '미기록'}`, `실행 모델 ${token(r['resolved_model']) ?? '미관측'}`));
  }
  const measured = number(http?.['duration_ms']);
  const duration = measured !== null && measured >= 0 ? measured : phase === 'evidence_result' ? number(r['duration_ms']) : phase === 'codex_compact' && lane === 'jev' ? number(r['jev_ms']) : null;
  const sentAt = requestId && phase.endsWith('_result') ? intents.get(`${requestId}:${phase.replace(/_result$/, '_intent')}`) : undefined;
  const elapsed = sentAt ? Date.parse(at) - Date.parse(sentAt) : null;
  const model = phase === 'codex_router_response' ? modelObservation(r['selected_model'], r['observed_model'], r['selected_effort'], r['observed_effort'], undefined, 'submitted_effort' in r ? { value: r['submitted_effort'], source: 'provider_request' } : undefined)
    : phase === 'codex_route_applied' ? modelObservation(r['selected_model'], r['observed_model'], r['selected_effort'], r['observed_effort'], undefined, 'submitted_effort' in r ? { value: r['submitted_effort'], source: 'provider_request' } : undefined)
    : phase === 'pre_result' && field(r, 'allocation') ? modelObservation(field(r, 'allocation')?.['selected_model'], null, field(field(r, 'allocation'), 'effort_edit')?.['value'])
    : phase === 'plan' && field(r, 'planner_model') ? modelObservation(field(r, 'planner_model')?.['requested'], field(r, 'planner_model')?.['observed'])
    : phase === 'post' || phase === 'failure' || phase === 'background_launch' ? modelObservation(r['requested_model'], r['resolved_model']) : undefined;
  if (model && phase === 'codex_route_applied' && r['request_kind'] === 'root_response' && typeof r['applied'] === 'boolean') model.requestApplied = r['applied'];
  const routing: OperationStep['routing'] = phase.startsWith('codex_router_') || phase === 'codex_route_applied' ? { scope: 'root', baseline: token(r['baseline_model']), modelReason: token(field(r, 'reasons')?.['model']), effortReason: token(field(r, 'reasons')?.['effort']) } : phase === 'pre_result' && field(r, 'allocation') ? { scope: 'owned', baseline: token(field(r, 'allocation')?.['baseline_model']), modelReason: 'gate_allocated', effortReason: 'gate_allocated' } : undefined;
  const proposal = field(field(r, 'answers'), 'model');
  const proposedModel = token(proposal?.['choice']);
  if (routing && proposedModel && !['__keep__', '__abstain__'].includes(proposedModel)) {
    routing.proposedModel = proposedModel;
    const selection = field(r, 'selection');
    const probability = number(selection?.['probability']) ?? number(field(proposal, 'probabilities')?.[proposedModel]);
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
    const binding = modelRequestKey(r), terminalAt = binding ? modelTerminals.get(binding) : undefined;
    const settled = terminalAt !== undefined && terminalAt >= at;
    lane = 'host'; state = settled ? 'done' : 'active';
    summary = settled ? '모델 요청 종료 기록 확인' : '모델 응답 대기';
    details.push(`전달 모델 ${token(r['submitted_model']) ?? '?'}`);
  }
  if (phase === 'codex_model_failure') { state = 'error'; lane = 'host'; summary = '호스트 모델 요청 실패'; }
  if (state === 'error' && !issue) issue = lane === 'jev' ? 'jev' : feature === 'evidence' ? 'evidence' : 'host';
  return { id: id(ownId), at, feature, state, lane, ...(token(r['session_id']) ? { sessionId: token(r['session_id'])! } : {}), ...(token(r['agent_id']) ? { agentId: token(r['agent_id'])! } : {}), ...(token(r['tool_use_id']) ? { callId: token(r['tool_use_id'])! } : {}), title: traceTitle(phase, r), summary, details: details.filter(Boolean), ...(routing ? { routing } : {}), ...(model ? { model } : {}),
    ...(issue ? { issue } : {}),
    ...(['stop', 'background_conversation', 'codex_model_request', 'codex_model_failure'].includes(phase) ? { lifecycle: true } : {}),
    ...(phase === 'admission_result' && ['direct', 'orchestrated'].includes(String(field(r, 'decision')?.['shape'])) ? { executionPath: field(r, 'decision')!['shape'] as 'direct' | 'orchestrated' } : {}),
    ...(duration !== null && duration >= 0 ? { durationMs: duration } : {}),
    ...(elapsed !== null && elapsed >= 0 ? { elapsedMs: elapsed } : {}),
    ...(phase === 'codex_model_request' && state === 'active' ? { startedAt: at, elapsedMs: Math.max(0, age) } : {}),
    ...(phase.endsWith('_result') && judgements(r) ? { judgements: judgements(r)! } : {}),
    ...(graph ? { graph } : {}) };
};

/** Join decisions to responses only within the recorded session and execution identity. */
const routedDebugRecords = (debug: DebugRecord[], records: Rec[]): DebugRecord[] => {
  const identity = (r: Rec, key: string): string | null => token(r[key]) ? JSON.stringify([r['session_id'] ?? 'legacy', r[key]]) : null;
  const owned = new Map<string, Rec>();
  for (const r of records) {
    const key = identity(r, 'tool_use_id');
    if (r['host'] !== 'codex' && r['phase'] === 'pre_result' && key && field(r, 'allocation')) owned.set(key, r);
  }
  const turns = new Map<string, Rec>(), spawns = new Map<string, Rec>(), childSteps = new Map<string, Rec>(), children = new Map<string, NonNullable<OperationStep['routing']>>();
  return [...debug].sort((a, b) => a.at.localeCompare(b.at)).map(row => {
    if (row.component !== 'router') return row;
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
    if (event === 'root' && turn && (field(r, 'reasons') || field(r, 'from'))) turns.set(turn, r);
    if (event === 'spawn' && tool) spawns.set(tool, r);
    if (event === 'child_route' && agent) childSteps.set(routerResponseKey(r), r);
    if (['spawn_result', 'spawn_native_result'].includes(String(event)) && agent && routing) children.set(agent, routing);
    if (event === 'child_result' && agent) {
      const origin = children.get(agent);
      if (origin && !childDecision) routing = { ...origin, scope: 'child' };
    }
    return routing ? { ...row, rec: { ...r, routing_decision: routing } } : row;
  });
};

const routerResponseKey = (r: Rec, index: unknown = r['index'] ?? null): string =>
  JSON.stringify([r['session_id'] ?? 'legacy', r['tool_use_id'] ?? r['turn'], token(r['tool_use_id']) ? null : r['agent_id'] ?? (r['scope'] === 'child' ? 'unknown-child' : null), index]);

const routerDecisionKey = (r: Rec): string => JSON.stringify([r['session_id'] ?? 'legacy', r['turn'] ?? r['tool_use_id'] ?? '', r['agent_id'] ?? null, r['agent_id'] ? r['index'] ?? null : null]);

const debugStep = (row: DebugRecord, now: number, closed: Set<string>, responses: Map<string, string>): OperationStep | null => {
  const r = row.rec;
  const route = field(r, 'routing_decision'), scope = token(route?.['scope']);
  const routing: OperationStep['routing'] = scope && ['root', 'spawn', 'child', 'owned'].includes(scope) ? { scope: scope as NonNullable<OperationStep['routing']>['scope'], baseline: token(route?.['baseline']), modelReason: token(route?.['modelReason']), effortReason: token(route?.['effortReason']) } : undefined;
  const event = token(r['event']);
  if (!event || !row.at) return null;
  const feature = row.component;
  const runId = token(r['run_id']);
  const key = row.component === 'router' ? routerDecisionKey(r) : `${token(r['session_id']) ?? 'legacy'}:${runId ?? ''}`;
  const started = (row.component === 'router' && event === 'request') || r['stage'] === 'started';
  const failedAssessment = row.component === 'router' && r['sent'] === true && token(r['assessment']) !== null && r['assessment'] !== 'ok';
  const age = now - Date.parse(row.at);
  let state: StepState = started && !closed.has(`${row.component}:${key}`) ? age >= 0 && age < 30_000 ? 'active' : 'unconfirmed' : failedAssessment || r['confirmation'] === 'mismatch' || r['reason'] === 'model_mismatch' || r['coreError'] === true ? 'error' : r['confirmation'] === 'unobserved' ? 'unconfirmed' : r['skipped'] || r['deferred'] || r['disabled'] ? 'skipped' : 'done';
  const details: string[] = [];
  let summary = '';
  let lane: StepLane = 'local';
  if (feature === 'router') {
    lane = event === 'request' || r['sent'] === true ? 'jev' : 'policy';
    const from = field(r, 'from'); const patch = field(r, 'patch'); const reasons = field(r, 'reasons'); const applied = field(r, 'applied');
    summary = event === 'request' ? 'Jev 요청 전송 · 응답 대기' : text(event, r['sent'] === true ? 'Jev 응답' : r['sent'] === false ? '전송 안 함' : null, token(r['skipped']), token(r['reason']));
    if (failedAssessment) summary = text('Jev 판정 실패 · 원래 호스트 설정 유지', token(r['assessment']));
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
    const answers = field(r, 'answers');
    if (answers) details.push(text(`Jev 제어 ${token(answers['control']) ?? '?'}`, number(answers['task_clear']) === null ? null : `명확도 ${Math.round(number(answers['task_clear'])! * 100)}%`, number(answers['ordinary']) === null ? null : `일반 위험 ${Math.round(number(answers['ordinary'])! * 100)}%`));
    if (answers) for (const name of ['tier', 'effort']) {
      const levels = field(answers, name);
      if (levels) details.push(text(`${name} 점수`, ...Object.entries(levels).slice(0, 8).flatMap(([level, value]) => token(level) && number(value) !== null ? [`${level} ${n(number(value))}`] : [])));
    }
  } else if (feature === 'compact') {
    if (r['stage'] === 'jev') {
      lane = r['jev_sent'] === true ? 'jev' : 'local';
      summary = text(r['jev_sent'] === true ? 'Jev 작업 의존 근거 선택' : r['jev_sent'] === false ? 'Jev 전송 없음' : 'Jev 전송 여부 미확인', compactSelectionReason(r['selection']));
      if (r['jev_sent'] === true) details.push(compactUsage(r));
      details.push(text(`후보 ${n(number(r['candidates']))}/${n(number(r['available']))}`, `필수 근거 ${n(number(r['dependencies']))}`, number(r['jev_ms']) === null ? null : `${n(number(r['jev_ms']))}ms`));
    } else summary = started ? '대화 압축 시작' : r['deferred'] ? text('호스트 압축으로 넘김', token(r['deferred'])) : r['applied'] === true ? '로컬 digest 적용 · 요약 모델 호출 대체' : text('호스트 압축 사용', token(r['fallback']), r['coreSkip'] === true ? '호스트 건너뜀' : null);
    details.push(text(`모드 ${token(r['mode']) ?? '?'}`, `트리거 ${token(r['trigger']) ?? '?'}`, r['subagent'] === true ? '서브에이전트' : '루트', `메시지 ${n(number(r['messages']))}개`));
    details.push(text(number(r['digestChars']) === null ? null : `digest ${n(number(r['digestChars']))}자`, number(r['tailChars']) === null ? null : `tail ${n(number(r['tailChars']))}자`, number(r['buildMs']) === null ? null : `빌드 ${n(number(r['buildMs']))}ms`));
    if (number(r['tokensBefore']) !== null || number(r['tokensAfter']) !== null) details.push(`호스트 보고 압축 전 ${n(number(r['tokensBefore']))} / 후 ${n(number(r['tokensAfter']))} 토큰`);
  } else {
    summary = started ? 'Vitest Bash 실행 중' : r['applied'] === true ? 'Vitest 로그 접기 적용' : text('원본 출력 유지', token(r['skipped']), token(r['disabled']));
    details.push(text(`파서 ${token(r['parser']) ?? '?'}`, number(r['runs']) === null ? null : `실행 ${n(number(r['runs']))}건`));
  }
  const model = feature === 'router' && ['root_result', 'spawn_result', 'spawn_native_result', 'child_result', 'model_request'].includes(event)
    ? modelObservation(r['requested'] ?? field(r, 'applied')?.['model'] ?? r['assumed'], r['observed'], r['requested_effort'] ?? field(r, 'applied')?.['effort'], r['observed_effort'], r['confirmation'], 'requested_effort' in r ? { value: r['requested_effort'], source: 'host_hook' } : undefined) : undefined;
  if (model) {
    if (model.status === 'mismatch') state = 'error';
    lane = 'host'; summary = text(model.status === 'confirmed' ? '선택 모델과 실제 모델 일치' : model.status === 'mismatch' ? '선택 모델과 실제 모델 불일치' : model.observed ? '실제 모델 관측 · 요청 모델 미확인' : '실제 응답 모델 미관측', model.selected, model.observed);
  }
  if (event === 'prepared') {
    const responseKey = routerResponseKey(r);
    state = (responses.get(responseKey) ?? '') >= row.at ? 'done' : 'unconfirmed';
    summary = r['routed'] === true ? '변경 설정 전달 준비 · 실행 응답 확인은 별도' : '기존 설정 전달 준비 · 실행 응답 확인은 별도';
    details.push('요청 전 점검만 기록됨 · Jev 새 호출이나 실제 모델 응답 완료를 뜻하지 않음');
  }
  if (event === 'model_request') {
    const responseAt = responses.get(routerResponseKey(r));
    const settled = responseAt !== undefined && responseAt >= row.at;
    // A slow host response is still in flight; elapsed time alone is not a failure.
    state = settled ? 'done' : 'active';
    lane = 'host';
    summary = settled ? '모델 요청 종료 기록 확인' : state === 'active' ? '모델 응답 대기' : '모델 요청 시작됨 · 종료 결과 미관측';
    details.push(text(`전달 모델 ${token(r['requested']) ?? '?'}`, `전달 effort ${token(r['requested_effort']) ?? '호스트 기본값'}`), '호스트 호출 시작 관측 · 실제 모델과 effort 확인은 응답 기록과 별도');
  }
  if (event === 'model_failure') { state = 'error'; lane = 'host'; summary = '호스트 모델 요청 실패'; }
  if (r['denied'] === true) { state = 'skipped'; summary = '호스트가 에이전트 생성을 거부함 · 실행되지 않음'; }
  const duration = number(r['duration_ms'] ?? (lane === 'jev' ? r['jev_ms'] : undefined));
  return { id: id(`${row.component}:${row.at}:${key}:${event}:${started ? 'start' : 'result'}`), at: row.at, feature, state, lane, ...(token(r['agent_id']) ? { agentId: token(r['agent_id'])!, ...(token(r['session_id']) ? { sessionId: token(r['session_id'])! } : {}) } : {}), ...(['prepared', 'model_request', 'model_failure'].includes(event) ? { lifecycle: true as const } : {}), title: { router: event === 'prepared' ? 'Router · 요청 전달 준비' : event === 'model_request' ? '모델 · 응답 대기' : event === 'model_failure' ? '모델 · 요청 실패' : 'Router · ' + event, compact: 'Compact · 압축', output: 'Output · 로그 접기' }[feature], summary, details: details.filter(Boolean), ...(routing ? { routing } : {}), ...(model ? { model } : {}), ...(lane === 'jev' && duration !== null && duration >= 0 ? { durationMs: duration } : {}), ...(event === 'model_request' && state === 'active' ? { startedAt: row.at, elapsedMs: Math.max(0, age) } : {}) };
};

const gateGroup = (r: Rec): string => {
  const phase = token(r['phase']) ?? '';
  if (phase.startsWith('evidence_')) return `evidence:${token(r['parent_request_id']) ?? token(r['request_id']) ?? token(r['invocation_id']) ?? 'unknown'}`;
  if (phase.startsWith('codex_router_') || phase.startsWith('codex_model_') || phase === 'codex_route_applied') return `router:${token(r['session_id']) ?? 'unknown'}:${token(r['prompt_id']) ?? 'unknown'}`;
  if (phase === 'codex_compact') return `compact:${token(r['session_id']) ?? 'unknown'}:${token(r['run_id']) ?? 'unknown'}`;
  return `gate:${token(r['session_id']) ?? 'unknown'}:${token(r['execution_prompt_id']) ?? token(r['prompt_id']) ?? 'unknown'}`;
};
const debugGroup = (row: DebugRecord): string => row.component === 'router'
  ? `router:${token(row.rec['session_id']) ?? 'legacy'}:${token(row.rec['turn']) ?? token(row.rec['tool_use_id']) ?? 'session'}`
  : `${row.component}:${token(row.rec['session_id']) ?? 'legacy'}:${token(row.rec['run_id']) ?? row.at}`;

export const buildOperations = (records: Rec[], debug: DebugRecord[], now: Date, availability: { trace: boolean; debug: boolean; host?: Host }): OperationsView => {
  records = allocatedTraceRecords(records);
  const codexDecisions = new Map<string, Rec>();
  const codexKey = (r: Rec): string | null => r['host'] === 'codex' && token(r['session_id']) && token(r['prompt_id']) ? JSON.stringify([r['session_id'], r['prompt_id']]) : null;
  for (const r of records) { const key = codexKey(r); if (key && r['phase'] === 'codex_router_result') codexDecisions.set(key, r); }
  records = records.map(r => {
    const key = codexKey(r), decision = key ? codexDecisions.get(key) : undefined;
    return decision && iso(decision['written_at']) <= iso(r['written_at']) && ['codex_route_applied', 'codex_router_response'].includes(String(r['phase'])) ? { ...r, reasons: decision['reasons'], baseline_model: r['baseline_model'] ?? decision['baseline_model'], answers: decision['answers'], selection: decision['selection'] } : r;
  });
  // A request row can display the actual response only when its exact binding has a later response.
  const responseBindings = new Map<string, Rec>();
  const modelTerminals = new Map<string, string>();
  for (const r of records) {
    const key = modelRequestKey(r); if (!key) continue;
    const at = iso(r['written_at']);
    if (['codex_router_response', 'codex_model_failure'].includes(String(r['phase'])) && at && at >= (modelTerminals.get(key) ?? '')) modelTerminals.set(key, at);
    if (r['phase'] === 'codex_router_response' && at && at >= iso(responseBindings.get(key)?.['written_at'])) responseBindings.set(key, r);
  }
  records = records.map(r => {
    const key = modelRequestKey(r);
    const response = r['phase'] === 'codex_route_applied' && key ? responseBindings.get(key) : undefined;
    return response && iso(response['written_at']) >= iso(r['written_at']) ? { ...r, observed_model: response['observed_model'], observed_effort: response['observed_effort'] } : r;
  });
  debug = routedDebugRecords(debug, records);
  const resultIds = new Set(records.flatMap((r) => token(r['request_id']) && token(r['phase']) ? [`${token(r['request_id'])}:${token(r['phase'])}`] : []));
  for (const r of records) if (r['phase'] === 'background_terminal') resultIds.add(`background:${token(r['session_id'])}:${token(r['execution_prompt_id']) ?? token(r['prompt_id'])}:${token(r['tool_use_id'])}`);
  for (const r of records) if (r['phase'] === 'codex_compact' && r['applied'] === true && token(r['run_id'])) resultIds.add(`codex_compact:${token(r['run_id'])}`);
  const intents = new Map(records.flatMap((r): Array<[string, string]> => {
    const phase = token(r['phase']); const requestId = token(r['request_id']); const at = iso(r['written_at']);
    return phase?.endsWith('_intent') && requestId && at ? [[`${requestId}:${phase}`, at]] : [];
  }));
  const closed = new Set(debug.flatMap((row) => {
    const own = row.component === 'router' ? token(row.rec['turn']) ?? token(row.rec['tool_use_id']) : token(row.rec['run_id']);
    if (!own) return [];
    const key = row.component === 'router' ? routerDecisionKey(row.rec) : `${token(row.rec['session_id']) ?? 'legacy'}:${own}`;
    return row.component === 'router' ? ['root', 'spawn', 'child_route'].includes(String(row.rec['event'])) ? [`router:${key}`] : [] : row.rec['stage'] === 'started' ? [] : [`${row.component}:${key}`];
  }));
  const responses = new Map<string, string>();
  for (const row of debug) if (['root_result', 'child_result', 'spawn_result', 'spawn_native_result', 'model_failure'].includes(String(row.rec['event']))) {
    // Older prepared records have no loop index. A later response in that exact turn still closes them.
    for (const index of [row.rec['index'] ?? null, null]) {
      const key = routerResponseKey(row.rec, index);
      if ((responses.get(key) ?? '') < row.at) responses.set(key, row.at);
    }
  }
  const grouped = new Map<string, { source: OperationRun['source']; host: Host; mode: string; executionId?: string; steps: OperationStep[] }>();
  for (const r of records) {
    const step = traceStep(r, now.getTime(), resultIds, intents, modelTerminals);
    if (!step) continue;
    const host = r['host'] === 'codex' ? 'codex' : 'claude';
    const source = gateGroup(r).split(':')[0] as OperationRun['source'];
    const key = `${host}:${gateGroup(r)}`;
    const session = token(r['session_id']); const prompt = token(r['execution_prompt_id']) ?? token(r['prompt_id']);
    const group = grouped.get(key) ?? { source, host, mode: token(r['mode']) ?? 'unknown',
      ...(session && prompt && source !== 'evidence' ? { executionId: id(`execution:${host}:${session}:${prompt}`) } : {}), steps: [] };
    const phase = token(r['phase']);
    if (r['attempted'] === true && ['admission_result', 'pre_result', 'interpretation_result', 'lean_result', 'codex_router_result'].includes(phase ?? '')) {
      const { durationMs: _duration, elapsedMs: _elapsed, judgements: _judgements, ...rest } = step;
      const { executionPath: _executionPath, ...response } = step;
      group.steps.push({ ...response, title: step.title.replace(/ · .+$/, ' · Jev 응답'), summary: step.state === 'error' ? 'Jev 판정 실패 · 원래 호출 유지' : step.judgements?.length
        ? `${step.judgements.length}개 선택형 응답 · 코드가 정책 판정에 사용`
        : '응답 기록 · 선택형 결과 미확인' });
      group.steps.push({ ...rest, id: id(`${step.id}:policy`), state: step.state === 'error' ? 'done' : step.state, lane: 'policy', details: phase === 'admission_result' ? step.details : [], summary: step.summary });
    } else group.steps.push(step);
    if (group.mode === 'unknown' && token(r['mode'])) group.mode = token(r['mode'])!;
    grouped.set(key, group);
  }
  for (const row of debug) {
    const step = debugStep(row, now.getTime(), closed, responses);
    if (!step) continue;
    const key = debugGroup(row);
    const group = grouped.get(key) ?? { source: row.component, host: 'claude' as const, mode: row.component, steps: [] };
    group.steps.push(step);
    grouped.set(key, group);
  }
  const separate: OperationRun[] = [...grouped].map(([key, group]): OperationRun => {
    const steps = group.steps.sort((a, b) => a.at.localeCompare(b.at) || (a.lane === 'policy' ? 1 : 0) - (b.lane === 'policy' ? 1 : 0) || a.id.localeCompare(b.id));
    const state = operationState(steps);
    const title = ({ gate: group.mode === 'lean' ? 'Lean 세션' : '게이트 세션', router: 'Router 실행', compact: 'Compact 실행', output: 'Output 실행', evidence: 'Evidence 검색', codex: 'Codex 실행' } as const)[group.source];
    return { id: id(key), ...(group.executionId ? { executionId: group.executionId } : {}), host: group.host, title, source: group.source, mode: group.mode, firstAt: steps[0]?.at ?? '', lastAt: steps.at(-1)?.at ?? '', state, steps };
  }).concat(codexOperations(records, now));
  // Display the whole known turn rather than three unrelated Router/Gate/native cards.
  const executions = new Map<string, OperationRun>();
  for (const run of separate) {
    const key = run.executionId ?? run.id; const existing = executions.get(key);
    if (!existing) { executions.set(key, { ...run, id: key }); continue; }
    const primary = existing.source === 'gate' ? existing : run.source === 'gate' ? run : existing.source !== 'codex' ? existing : run;
    const steps = [...existing.steps, ...run.steps].sort((a, b) => a.at.localeCompare(b.at) || (a.lane === 'policy' ? 1 : 0) - (b.lane === 'policy' ? 1 : 0) || a.id.localeCompare(b.id));
    executions.set(key, { ...primary, id: key, steps, firstAt: steps[0]!.at, lastAt: steps.at(-1)!.at, state: operationState(steps) });
  }
  const allRuns = [...executions.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  // A busy, older execution must remain visible even when newer completed turns fill the recent window.
  const recentIds = new Set(allRuns.slice(0, 200).map(run => run.id));
  const runs = allRuns.filter(run => recentIds.has(run.id) || run.steps.some(step => step.state === 'active'));
  const all = allRuns.flatMap((run) => run.steps.map((step) => ({ ...step, runId: run.id, runTitle: run.title, host: run.host })));
  const features = FEATURES.map((f): FeatureView => {
    const steps = all.filter((s) => s.feature === f.id && !s.lifecycle);
    if (availability.host === 'codex') {
      const managed = records.some(r => r['host'] === 'codex' && (r['managed'] === true || traceFeature(String(r['phase'])) !== null && r['phase'] !== 'evidence_result' && !String(r['phase']).startsWith('evidence_')));
      const capability = (managed ? CODEX_CAPABILITIES : CODEX_PLUGIN_CAPABILITIES)[f.id];
      return { ...f, source: 'trace', capability,
        count: steps.length, lastAt: steps.length ? steps.map(s => s.at).sort().at(-1)! : null,
        state: capability.mode === 'unsupported' ? 'unsupported' : steps.length ? 'observed' : availability.trace ? 'waiting' : 'unavailable' };
    }
    return { ...f, count: steps.length, lastAt: steps.length ? steps.map((s) => s.at).sort().at(-1)! : null, state: steps.length ? 'observed' : availability[f.source] ? 'waiting' : 'unavailable' };
  });
  const jevRequests = new Set<string>();
  for (const r of records) {
    const phase = token(r['phase']) ?? '';
    if (phase === 'codex_compact' && r['jev_sent'] === true) { jevRequests.add(`compact:codex:${token(r['session_id'])}:${token(r['run_id'])}`); continue; }
    if (!['admission_intent', 'pre_intent', 'interpretation_intent', 'lean_intent', 'evidence_jev_intent', 'codex_router_intent'].includes(phase)
      && !(r['attempted'] === true && ['admission_result', 'pre_result', 'interpretation_result', 'lean_result', 'evidence_jev_result', 'codex_router_result'].includes(phase))) continue;
    const kind = phase.replace(/_(intent|result)$/, '');
    jevRequests.add(`${kind}:${token(r['request_id']) ?? token(r['invocation_id']) ?? iso(r['written_at'])}`);
  }
  for (const row of debug) {
    if (row.component === 'compact' && row.rec['jev_sent'] === true) { jevRequests.add(`compact:claude:${token(row.rec['session_id']) ?? 'legacy'}:${token(row.rec['run_id']) ?? row.at}`); continue; }
    if (row.component !== 'router' || (row.rec['event'] !== 'request' && row.rec['sent'] !== true)) continue;
    jevRequests.add(`router:${routerDecisionKey(row.rec)}`);
  }
  const requests = jevRequests.size;
  const durations = all.filter((s) => s.lane === 'jev' && s.durationMs !== undefined).map((s) => s.durationMs!).sort((a, b) => a - b);
  const latest = all.filter((s) => s.lane === 'jev' && s.durationMs !== undefined).sort((a, b) => b.at.localeCompare(a.at))[0]?.durationMs ?? null;
  const percentile = (p: number): number | null => durations.length ? durations[Math.ceil(p * durations.length) - 1]! : null;
  const recent = all.filter((s) => s.lane === 'jev' && s.durationMs !== undefined)
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 16).reverse().map((s) => ({ at: s.at, ms: s.durationMs! }));
  const latency = { measured: durations.length, p50: percentile(.5), p95: percentile(.95), fastest: durations[0] ?? null, latest, recent };
  const newestFirst = (a: typeof all[number], b: typeof all[number]) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
  // Tool and policy loops must not evict the most recent recorded Jev call for either host/feature.
  const latestJev = new Map<string, typeof all[number]>();
  for (const step of all.filter(s => s.lane === 'jev' && s.state !== 'active').sort(newestFirst)) {
    const key = `${step.host}:${step.feature}`;
    if (!latestJev.has(key)) latestJev.set(key, step);
  }
  const feed = [...new Set([...all.filter(s => !s.lifecycle).sort(newestFirst).slice(0, 120),
    ...all.filter(s => s.lifecycle).sort(newestFirst).slice(0, 20), ...latestJev.values()])].sort(newestFirst);
  const sig = createHash('sha256').update(JSON.stringify({ runs, features, requests, latency })).digest('hex').slice(0, 24);
  return { runs, features, feed, active: runs.filter((r) => r.state === 'active').length, attention: runs.filter((r) => r.state === 'attention').length, requests, latency, sig };
};
