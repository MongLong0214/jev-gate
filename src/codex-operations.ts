import { createHash } from 'node:crypto';
import type { OperationRun, OperationStep } from './operations.js';
import { operationState } from './operation-state.js';

type Rec = Record<string, unknown>;
const token = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9_.:/+@-]{1,160}$/.test(v) && !/(sk-|jv_live_)/i.test(v) ? v : null;
const hash = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12);
const at = (r: Rec): string => typeof r['written_at'] === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(r['written_at']) ? r['written_at'] : '';
const START_END: Record<string, string[]> = {
  UserPromptSubmit: ['Stop', 'Interrupt', 'SessionEnd'], PreToolUse: ['PostToolUse'],
  SubagentStart: ['SubagentStop'], PreCompact: ['PostCompact'],
};
const TITLE: Record<string, string> = {
  SessionStart: 'Codex · 세션 시작', SessionEnd: 'Codex · 세션 종료', UserPromptSubmit: 'Codex · 턴 시작',
  PreToolUse: 'Codex · 도구 시작', PostToolUse: 'Codex · 도구 결과', SubagentStart: 'Codex · 에이전트 시작',
  SubagentStop: 'Codex · 에이전트 종료 이벤트', PreCompact: 'Codex · 압축 시작', PostCompact: 'Codex · 압축 종료',
  Stop: 'Codex · 턴 종료 이벤트', Interrupt: 'Codex · 사용자 중단',
};
const spanKey = (r: Rec, event: string): string | null => {
  const session = token(r['session_id']);
  if (event === 'SessionEnd') return JSON.stringify([session, 'session']);
  if (event === 'SubagentStop') return token(r['agent_id']) ? JSON.stringify([session, event, r['agent_id']]) : null;
  // Native unified-exec may deliver the receipt on a later write_stdin turn. Call IDs are session-scoped.
  if (event === 'PostToolUse') return token(r['tool_use_id']) ? JSON.stringify([session, event, r['tool_use_id']]) : null;
  return token(r['prompt_id']) ? JSON.stringify([session, event, r['prompt_id']]) : null;
};

/** Native host spans are never counted as Jev requests, routed workers, or accepted contracts. */
export const codexOperations = (records: Rec[], now: Date): OperationRun[] => {
  const rows = records.filter(r => r['host'] === 'codex' && ['codex_event', 'codex_output'].includes(String(r['phase'])) && token(r['session_id']) && at(r))
    .sort((a, b) => at(a).localeCompare(at(b)));
  // Pair once in reverse order. Re-scanning the full recording for every start made live refresh quadratic.
  const terminals = new Map<string, Rec>();
  const paired = new Map<Rec, Rec>();
  const ended = new Map<Rec, Rec>();
  for (const row of [...rows].reverse()) {
    if (row['phase'] !== 'codex_event') continue;
    const event = String(row['event']);
    const candidates = (START_END[event] ?? []).flatMap(end => {
      const key = spanKey(row, end);
      const terminal = key ? terminals.get(key) : undefined;
      return terminal ? [terminal] : [];
    }).sort((a, b) => at(a).localeCompare(at(b)));
    if (candidates[0]) paired.set(row, candidates[0]);
    if (START_END[event]) {
      const closing = (event === 'SubagentStart' ? ['SessionEnd'] : ['Stop', 'Interrupt', 'SessionEnd']).flatMap(end => {
        const key = spanKey(row, end); const terminal = key ? terminals.get(key) : undefined;
        return terminal ? [terminal] : [];
      }).sort((a, b) => at(a).localeCompare(at(b)))[0];
      if (closing) ended.set(row, closing);
    }
    if (['PostToolUse', 'SubagentStop', 'PostCompact', 'Stop', 'Interrupt', 'SessionEnd'].includes(event)) {
      const key = spanKey(row, event);
      if (key) terminals.set(key, row);
    }
  }
  const groups = new Map<string, OperationStep[]>();
  for (const r of rows) {
    const event = token(r['event']) ?? '';
    const output = r['phase'] === 'codex_output';
    if (!output && !TITLE[event]) continue;
    const isAgent = event === 'SubagentStart' || event === 'SubagentStop';
    const key = `codex:${r['session_id']}:${isAgent ? `agent:${token(r['agent_id']) ?? 'unknown'}` : token(r['prompt_id']) ?? 'session'}`;
    const ends = START_END[event];
    const end = !output ? paired.get(r) : undefined;
    const closing = ended.get(r);
    const isStart = !!ends && !output;
    const elapsed = Math.max(0, now.getTime() - Date.parse(at(r)));
    const failed = (v: Rec | undefined) => v?.['is_error'] === true || typeof v?.['exit_code'] === 'number' && v['exit_code'] !== 0;
    const state = output ? r['applied'] === true ? 'done' : 'skipped'
      : failed(r) || failed(end) ? 'error'
      : event === 'Interrupt' || end?.['event'] === 'Interrupt' || !end && closing?.['event'] === 'Interrupt' ? 'interrupted'
      : isStart && !end ? closing || elapsed > 600_000 ? 'unconfirmed' : 'active' : 'done';
    const tool = token(r['tool_name']);
    const detail = state === 'error' ? `호스트가 실패를 보고함${typeof (end ?? r)['exit_code'] === 'number' ? ` · 종료 코드 ${(end ?? r)['exit_code']}` : ' · 도구 오류'} · Jev 정책 오류와 별도`
      : state === 'interrupted' ? '사용자 중단 관측 · 성공이나 기능 오류로 분류하지 않음'
      : state === 'unconfirmed' ? closing ? '턴 또는 세션 종료 · 이 호출의 결과 이벤트는 미관측' : '결과 이벤트 미관측 · 실행 성공·실패를 판단할 수 없음'
      : output ? r['applied'] === true ? '동일한 연속 줄을 접어 모델에 전달' : `원본 출력 보존 · ${token(r['reason']) ?? 'unknown'}`
      : tool === 'spawn_agent' && event === 'PostToolUse' ? '에이전트 생성 응답 · 작업 완료 여부는 별도 관측'
      : event === 'SubagentStop' ? '종료 훅 관측 · Jev 계약 수락 검사 없음'
      : event === 'PreCompact' || event === 'PostCompact' ? r['managed'] === true ? 'Codex 압축 절차 · digest 설치는 별도 적용 기록에서 확인' : 'Codex 기본 압축 · 연결 세션에서 digest 적용 가능'
      : [tool, token(r['agent_type']), token(r['model'])].filter(Boolean).join(' · ') || 'Codex 호스트 이벤트';
    const measured = end ? Date.parse(at(end)) - Date.parse(at(r)) : undefined;
    const numbers = output && r['applied'] === true ? ['before_bytes', 'after_bytes', 'runs'].flatMap(k => typeof r[k] === 'number' && Number.isSafeInteger(r[k]) && r[k] >= 0 ? [`${k}: ${r[k]}`] : []) : [];
    const step: OperationStep = {
      id: hash(`${key}:${token(r['invocation_id']) ?? at(r)}:${event}:${output}`), at: at(r),
      feature: output ? 'output' : event.includes('Compact') ? 'compact' : 'workers',
      ...(!output ? { lifecycle: true } : {}),
      state, lane: output ? 'local' : 'host', title: output ? 'Output · 로그 접기' : TITLE[event]!, summary: detail,
      details: [...numbers, ...(state === 'unconfirmed' ? ['호스트 훅이 모든 도구 경로의 종료를 보장하지 않습니다. 원래 호스트에서 해당 도구 결과를 확인하세요.'] : []), ...(token(r['tool_use_id']) ? [`call: ${hash(String(r['tool_use_id']))}`] : [])],
      ...(measured !== undefined && Number.isFinite(measured) && measured >= 0 ? { durationMs: measured } : {}),
      ...(state === 'active' ? { elapsedMs: elapsed } : {}),
      ...(isStart ? { startedAt: at(r) } : {}),
    };
    const steps = groups.get(key) ?? []; steps.push(step); groups.set(key, steps);
  }
  return [...groups].map(([key, steps]) => ({
    id: hash(key), host: 'codex', source: 'codex', title: 'Codex 실행', mode: 'native',
    ...(!key.includes(':agent:') && key.endsWith(':session') === false ? { executionId: hash(`execution:${key}`) } : {}),
    firstAt: steps[0]!.at, lastAt: steps.at(-1)!.at, steps,
    state: operationState(steps),
  }));
};
