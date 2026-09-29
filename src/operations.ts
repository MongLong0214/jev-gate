import { createHash } from 'node:crypto';

/** A display model made only from named metadata fields. Raw prompts, source and debug text never leave here. */
type Rec = Record<string, unknown>;
export type FeatureId = 'admission' | 'allocation' | 'planning' | 'workers' | 'guard' | 'lean' | 'router' | 'compact' | 'output' | 'evidence';
export type StepState = 'active' | 'done' | 'skipped' | 'error' | 'unconfirmed';
export type StepLane = 'jev' | 'policy' | 'host' | 'local';

export interface OperationStep {
  id: string;
  at: string;
  feature: FeatureId;
  state: StepState;
  lane: StepLane;
  title: string;
  summary: string;
  details: string[];
  /** Timings are measured by the caller or paired recorded events, never estimated from usage. */
  durationMs?: number;
  elapsedMs?: number;
  judgements?: Array<{ question: string; value: string; confidence: number | null; probabilities: Array<{ label: string; value: number }> }>;
  graph?: Array<{ id: string; dependsOn: string[]; checks: number }>;
}

export interface OperationRun {
  id: string;
  title: string;
  source: 'gate' | 'router' | 'compact' | 'output' | 'evidence';
  mode: string;
  firstAt: string;
  lastAt: string;
  state: 'active' | 'done' | 'attention';
  steps: OperationStep[];
}

export interface FeatureView {
  id: FeatureId;
  label: string;
  source: 'trace' | 'debug';
  count: number;
  lastAt: string | null;
  state: 'observed' | 'waiting' | 'unavailable';
}

export interface OperationsView {
  runs: OperationRun[];
  features: FeatureView[];
  feed: Array<OperationStep & { runId: string; runTitle: string }>;
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
const TOKEN = /^[A-Za-z0-9_.:/+@-]{1,80}$/;
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
  if (phase.startsWith('admission_')) return 'admission';
  if (phase.startsWith('pre_')) return 'allocation';
  if (phase.startsWith('interpretation_') || phase === 'plan') return 'planning';
  if (phase === 'dispatch' || phase === 'post' || phase === 'failure' || phase === 'stop') return 'workers';
  if (phase === 'guard') return 'guard';
  if (phase.startsWith('lean_')) return 'lean';
  if (phase.startsWith('evidence_')) return 'evidence';
  return null;
};
const traceTitle = (phase: string, r: Rec): string => ({
  admission_intent: 'Gate A · Jev 요청', admission_result: 'Gate A · 실행 형태',
  pre_intent: 'Gate B · Jev 요청', pre_result: 'Gate B · 등급 결정',
  interpretation_intent: '계획 해석 · Jev 요청', interpretation_result: '계획 해석 · 자문',
  plan: '플래너 결과 · 작업 그래프', dispatch: token(r['role']) === 'planner' ? '플래너 호출' : '워커 호출',
  post: '워커 결과 · 수락 판정', failure: '호스트 호출 실패', stop: '턴 종료', guard: '루트 도구 가드',
  lean_intent: 'Lean · Jev 요청', lean_result: 'Lean · 문맥 선택', lean_dispatch: 'Lean · packet 적용', lean_post: 'Lean · executor 결과',
  evidence_start: 'Evidence · 근거 검색 시작', evidence_jev_intent: 'Evidence · Jev 판정 요청', evidence_jev_result: 'Evidence · Jev 판정 결과', evidence_cache: 'Evidence · 판정 캐시', evidence_result: 'Evidence · 근거 결과',
} as Record<string, string>)[phase] ?? phase;

const traceStep = (r: Rec, now: number, resultIds: Set<string>, intents: Map<string, string>): OperationStep | null => {
  const phase = token(r['phase']);
  if (!phase) return null;
  const feature = traceFeature(phase);
  if (!feature) return null;
  const at = iso(r['written_at']);
  if (!at) return null;
  const requestId = token(r['request_id']);
  const ownId = token(r['invocation_id']) ?? `${phase}:${at}:${requestId ?? ''}`;
  const isIntent = phase.endsWith('_intent') || phase === 'evidence_start';
  const expected = phase === 'evidence_start' ? 'evidence_result' : phase.replace(/_intent$/, '_result');
  const hasResult = requestId !== null && resultIds.has(`${requestId}:${expected}`);
  const age = now - Date.parse(at);
  const state: StepState = isIntent ? hasResult ? 'done' : age >= 0 && age < 30_000 ? 'active' : 'unconfirmed'
    : r['known_not_sent'] === true || r['attempted'] === false ? 'skipped'
      : r['is_error'] === true || phase === 'failure' ? 'error' : 'done';
  const details: string[] = [];
  let summary = '';
  let lane: StepLane = 'policy';
  let graph: OperationStep['graph'];
  if (isIntent) {
    lane = phase === 'evidence_start' ? 'local' : 'jev';
    summary = phase === 'evidence_start' ? text(token(r['kind']), token(r['mode']), r['remote_configured'] === true ? '원격 판정 허용' : '로컬만') : hasResult ? '응답 기록과 연결됨' : state === 'active' ? '응답을 기다리는 중' : '응답 기록 없음 · 진행 여부 미확인';
    if (phase === 'evidence_jev_intent') summary = text(`후보 ${n(number(r['candidates']))}개`, summary);
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
    if (phase === 'admission_result') {
      details.push(text(`세션 문맥 ${n(number(r['context_tokens']))} 토큰`, `실행 floor ${n(number(r['depth_floor']))}`, token(r['depth_floor_source']), number(r['host_window']) === null ? null : `호스트 창 ${n(number(r['host_window']))} 토큰`));
      if (number(estimate?.['turns']) !== null) details.push(`계산에 사용한 루트 턴 ${n(number(estimate?.['turns']))}회`);
    }
    if (phase === 'pre_result') details.push(text(`요청 ${token(r['called_tier']) ?? '?'}`, `적용 ${tier ?? '원래 프로필'}`, token(decision?.['model'])));
    if (estimate && number(estimate['saving_tokens']) !== null) details.push(`위임 가격 계산 ${n(number(estimate['saving_tokens']))} 토큰 · 측정된 절감 아님`);
    if (phase === 'lean_result') {
      summary = text(action, reason, number(decision?.['retained']) === null ? null : `유지 ${n(number(decision?.['retained']))}그룹`, number(decision?.['omitted']) === null ? null : `생략 ${n(number(decision?.['omitted']))}그룹`);
      const source = field(r, 'source');
      const groups = field(r, 'groups');
      if (source) details.push(text(`전사 범위 ${token(source['coverage']) ?? '미확인'}`, `미판정 ${n(number(source['unassessed']))}그룹`, `호스트 문맥 ${n(number(source['host_context']))}건`, `버린 분기 ${n(number(source['abandoned']))}건`));
      if (groups) details.push(text(`필수 ${n(number(groups['mandatory']))}그룹`, `선택 질문 ${n(number(groups['optional_asked']))}그룹`, `읽은 요청 ${n(number(groups['request_bytes']))}B`));
      details.push('packet 크기와 실제 토큰 절감은 다른 사실입니다');
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
  } else if (phase === 'dispatch') {
    lane = 'host';
    summary = text(token(r['role']), token(r['task_id']), token(r['selection']), `요청 등급 ${token(r['requested_tier']) ?? '?'}`);
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
    if (r['root_fallback'] === true) details.push('단일 워커 시도 상한 · 루트 도구 가드 해제');
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
  } else if (phase === 'stop') {
    lane = 'host'; summary = text('턴 종료', token(r['outcome']));
  } else if (phase === 'failure') {
    lane = 'host'; summary = text('호스트 호출 실패', token(r['subagent_type']));
    details.push(text(`요청 모델 ${token(r['requested_model']) ?? '미기록'}`, `실행 모델 ${token(r['resolved_model']) ?? '미관측'}`));
  }
  const http = field(r, 'http');
  const measured = number(http?.['duration_ms']);
  const duration = measured !== null && measured >= 0 ? measured : phase === 'evidence_result' ? number(r['duration_ms']) : null;
  const sentAt = requestId && phase.endsWith('_result') ? intents.get(`${requestId}:${phase.replace(/_result$/, '_intent')}`) : undefined;
  const elapsed = sentAt ? Date.parse(at) - Date.parse(sentAt) : null;
  return { id: id(ownId), at, feature, state, lane, title: traceTitle(phase, r), summary, details: details.filter(Boolean),
    ...(duration !== null && duration >= 0 ? { durationMs: duration } : {}),
    ...(elapsed !== null && elapsed >= 0 ? { elapsedMs: elapsed } : {}),
    ...(phase.endsWith('_result') && judgements(r) ? { judgements: judgements(r)! } : {}),
    ...(graph ? { graph } : {}) };
};

const debugStep = (row: DebugRecord, now: number, closed: Set<string>): OperationStep | null => {
  const r = row.rec;
  const event = token(r['event']);
  if (!event || !row.at) return null;
  const feature = row.component;
  const runId = token(r['run_id']);
  const key = row.component === 'router' ? token(r['turn']) ?? token(r['tool_use_id']) ?? '' : runId ?? '';
  const started = (row.component === 'router' && event === 'request') || r['stage'] === 'started';
  const age = now - Date.parse(row.at);
  const state: StepState = started && !closed.has(`${row.component}:${key}`) ? age >= 0 && age < 30_000 ? 'active' : 'unconfirmed' : r['skipped'] || r['deferred'] || r['disabled'] ? 'skipped' : r['coreError'] === true ? 'error' : 'done';
  const details: string[] = [];
  let summary = '';
  let lane: StepLane = 'local';
  if (feature === 'router') {
    lane = event === 'request' || r['sent'] === true ? 'jev' : 'policy';
    const from = field(r, 'from'); const patch = field(r, 'patch'); const reasons = field(r, 'reasons'); const applied = field(r, 'applied');
    summary = event === 'request' ? 'Jev 요청 전송 · 응답 대기' : text(event, r['sent'] === true ? 'Jev 응답' : r['sent'] === false ? '전송 안 함' : null, token(r['skipped']), token(r['reason']));
    details.push(text(`기존 모델 ${token(from?.['model']) ?? token(r['from']) ?? '?'}`, `기존 effort ${token(from?.['effort']) ?? '?'}`));
    details.push(text(`요청 변경 모델 ${token(patch?.['model']) ?? '?'}`, `요청 변경 effort ${token(patch?.['effort']) ?? token(r['patch']) ?? '?'}`));
    details.push(text(`모델 이유 ${token(reasons?.['model']) ?? '?'}`, `effort 이유 ${token(reasons?.['effort']) ?? '?'}`, `실제 적용 effort ${token(applied?.['effort']) ?? '?'}`, `관측 모델 ${token(r['observed']) ?? '?'}`));
    const usage = field(r, 'usage');
    if (usage) details.push(text(`입력 ${n(number(usage['input']))}`, `출력 ${n(number(usage['output']))}`));
    const answers = field(r, 'answers');
    if (answers) details.push(text(`Jev 제어 ${token(answers['control']) ?? '?'}`, number(answers['task_clear']) === null ? null : `명확도 ${Math.round(number(answers['task_clear'])! * 100)}%`, number(answers['ordinary']) === null ? null : `일반 위험 ${Math.round(number(answers['ordinary'])! * 100)}%`));
    if (answers) for (const name of ['tier', 'effort']) {
      const levels = field(answers, name);
      if (levels) details.push(text(`${name} 점수`, ...Object.entries(levels).slice(0, 8).flatMap(([level, value]) => token(level) && number(value) !== null ? [`${level} ${n(number(value))}`] : [])));
    }
  } else if (feature === 'compact') {
    summary = started ? '대화 압축 시작' : r['deferred'] ? text('호스트 압축으로 넘김', token(r['deferred'])) : r['applied'] === true ? '로컬 digest 적용 · 요약 모델 호출 대체' : text('호스트 압축 사용', token(r['fallback']), r['coreSkip'] === true ? '호스트 건너뜀' : null);
    details.push(text(`모드 ${token(r['mode']) ?? '?'}`, `트리거 ${token(r['trigger']) ?? '?'}`, r['subagent'] === true ? '서브에이전트' : '루트', `메시지 ${n(number(r['messages']))}개`));
    details.push(text(number(r['digestChars']) === null ? null : `digest ${n(number(r['digestChars']))}자`, number(r['tailChars']) === null ? null : `tail ${n(number(r['tailChars']))}자`, number(r['buildMs']) === null ? null : `빌드 ${n(number(r['buildMs']))}ms`));
    if (number(r['tokensBefore']) !== null || number(r['tokensAfter']) !== null) details.push(`호스트 보고 압축 전 ${n(number(r['tokensBefore']))} / 후 ${n(number(r['tokensAfter']))} 토큰`);
  } else {
    summary = started ? 'Vitest Bash 실행 중' : r['applied'] === true ? 'Vitest 로그 접기 적용' : text('원본 출력 유지', token(r['skipped']), token(r['disabled']));
    details.push(text(`파서 ${token(r['parser']) ?? '?'}`, number(r['runs']) === null ? null : `실행 ${n(number(r['runs']))}건`));
  }
  return { id: id(`${row.component}:${row.at}:${key}:${event}:${started ? 'start' : 'result'}`), at: row.at, feature, state, lane, title: { router: 'Router · ' + event, compact: 'Compact · 압축', output: 'Output · 로그 접기' }[feature], summary, details: details.filter(Boolean) };
};

const gateGroup = (r: Rec): string => {
  const phase = token(r['phase']) ?? '';
  if (phase.startsWith('evidence_')) return `evidence:${token(r['parent_request_id']) ?? token(r['request_id']) ?? token(r['invocation_id']) ?? 'unknown'}`;
  return `gate:${token(r['session_id']) ?? 'unknown'}:${token(r['prompt_id']) ?? 'unknown'}`;
};
const debugGroup = (row: DebugRecord): string => row.component === 'router'
  ? `router:${token(row.rec['turn']) ?? token(row.rec['tool_use_id']) ?? 'session'}`
  : `${row.component}:${token(row.rec['run_id']) ?? row.at}`;

export const buildOperations = (records: Rec[], debug: DebugRecord[], now: Date, availability: { trace: boolean; debug: boolean }): OperationsView => {
  const resultIds = new Set(records.flatMap((r) => token(r['request_id']) && token(r['phase']) ? [`${token(r['request_id'])}:${token(r['phase'])}`] : []));
  const intents = new Map(records.flatMap((r): Array<[string, string]> => {
    const phase = token(r['phase']); const requestId = token(r['request_id']); const at = iso(r['written_at']);
    return phase?.endsWith('_intent') && requestId && at ? [[`${requestId}:${phase}`, at]] : [];
  }));
  const closed = new Set(debug.flatMap((row) => {
    const key = row.component === 'router' ? token(row.rec['turn']) ?? token(row.rec['tool_use_id']) : token(row.rec['run_id']);
    if (!key) return [];
    return row.component === 'router' ? row.rec['event'] === 'request' ? [] : [`router:${key}`] : row.rec['stage'] === 'started' ? [] : [`${row.component}:${key}`];
  }));
  const grouped = new Map<string, { source: OperationRun['source']; mode: string; steps: OperationStep[] }>();
  for (const r of records) {
    const step = traceStep(r, now.getTime(), resultIds, intents);
    if (!step) continue;
    const key = gateGroup(r);
    const group = grouped.get(key) ?? { source: key.startsWith('evidence:') ? 'evidence' : 'gate', mode: token(r['mode']) ?? 'unknown', steps: [] };
    const phase = token(r['phase']);
    if (r['attempted'] === true && ['admission_result', 'pre_result', 'interpretation_result', 'lean_result'].includes(phase ?? '')) {
      const { durationMs: _duration, elapsedMs: _elapsed, judgements: _judgements, ...rest } = step;
      group.steps.push({ ...step, title: step.title.replace(/ · .+$/, ' · Jev 응답'), summary: step.judgements?.length
        ? `${step.judgements.length}개 선택형 응답 · 코드가 정책 판정에 사용`
        : '응답 기록 · 선택형 결과 미확인' });
      group.steps.push({ ...rest, id: id(`${step.id}:policy`), lane: 'policy', details: [], summary: step.summary });
    } else group.steps.push(step);
    if (group.mode === 'unknown' && token(r['mode'])) group.mode = token(r['mode'])!;
    grouped.set(key, group);
  }
  for (const row of debug) {
    const step = debugStep(row, now.getTime(), closed);
    if (!step) continue;
    const key = debugGroup(row);
    const group = grouped.get(key) ?? { source: row.component, mode: row.component, steps: [] };
    group.steps.push(step);
    grouped.set(key, group);
  }
  const allRuns: OperationRun[] = [...grouped].map(([key, group]) => {
    const steps = group.steps.sort((a, b) => a.at.localeCompare(b.at) || (a.lane === 'policy' ? 1 : 0) - (b.lane === 'policy' ? 1 : 0) || a.id.localeCompare(b.id));
    const state: OperationRun['state'] = steps.some((s) => s.state === 'active') ? 'active' : steps.some((s) => s.state === 'error' || s.state === 'unconfirmed') ? 'attention' : 'done';
    const title = ({ gate: group.mode === 'lean' ? 'Lean 세션' : '게이트 세션', router: 'Router 실행', compact: 'Compact 실행', output: 'Output 실행', evidence: 'Evidence 검색' } as const)[group.source];
    return { id: id(key), title: `${title} · ${id(key).slice(0, 6)}`, source: group.source, mode: group.mode, firstAt: steps[0]?.at ?? '', lastAt: steps.at(-1)?.at ?? '', state, steps };
  }).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const runs = allRuns.slice(0, 200);
  const all = allRuns.flatMap((run) => run.steps.map((step) => ({ ...step, runId: run.id, runTitle: run.title })));
  const features = FEATURES.map((f): FeatureView => {
    const steps = all.filter((s) => s.feature === f.id);
    return { ...f, count: steps.length, lastAt: steps.length ? steps.map((s) => s.at).sort().at(-1)! : null, state: steps.length ? 'observed' : availability[f.source] ? 'waiting' : 'unavailable' };
  });
  const jevRequests = new Set<string>();
  for (const r of records) {
    const phase = token(r['phase']) ?? '';
    if (!['admission_intent', 'pre_intent', 'interpretation_intent', 'lean_intent', 'evidence_jev_intent'].includes(phase)
      && !(r['attempted'] === true && ['admission_result', 'pre_result', 'interpretation_result', 'lean_result', 'evidence_jev_result'].includes(phase))) continue;
    const kind = phase.replace(/_(intent|result)$/, '');
    jevRequests.add(`${kind}:${token(r['request_id']) ?? token(r['invocation_id']) ?? iso(r['written_at'])}`);
  }
  for (const row of debug) {
    if (row.component !== 'router' || (row.rec['event'] !== 'request' && row.rec['sent'] !== true)) continue;
    jevRequests.add(`router:${token(row.rec['turn']) ?? token(row.rec['tool_use_id']) ?? row.at}`);
  }
  const requests = jevRequests.size;
  const durations = all.filter((s) => s.lane === 'jev' && s.durationMs !== undefined).map((s) => s.durationMs!).sort((a, b) => a - b);
  const latest = all.filter((s) => s.lane === 'jev' && s.durationMs !== undefined).sort((a, b) => b.at.localeCompare(a.at))[0]?.durationMs ?? null;
  const percentile = (p: number): number | null => durations.length ? durations[Math.ceil(p * durations.length) - 1]! : null;
  const recent = all.filter((s) => s.lane === 'jev' && s.durationMs !== undefined)
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 16).reverse().map((s) => ({ at: s.at, ms: s.durationMs! }));
  const latency = { measured: durations.length, p50: percentile(.5), p95: percentile(.95), fastest: durations[0] ?? null, latest, recent };
  const feed = all.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 160);
  const sig = createHash('sha256').update(JSON.stringify({ runs, features, requests, latency })).digest('hex').slice(0, 24);
  return { runs, features, feed, active: runs.filter((r) => r.state === 'active').length, attention: runs.filter((r) => r.state === 'attention').length, requests, latency, sig };
};
