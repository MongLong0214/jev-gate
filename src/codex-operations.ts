import { createHash } from 'node:crypto';
import type { OperationRun, OperationStep } from './operations.js';
import { operationState } from './operation-state.js';
import { memo } from './memo.js';

type Rec = Record<string, unknown>;
const safeToken = memo((v: string): string | null => /^[A-Za-z0-9_.:/+@-]{1,160}$/.test(v) && !/(sk-|jv_live_)/i.test(v) ? v : null);
const token = (v: unknown): string | null => typeof v === 'string' ? safeToken(v) : null;
const hash = memo((v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12));
const at = (r: Rec): string => typeof r['written_at'] === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(r['written_at']) ? r['written_at'] : '';
const START_END: Record<string, string[]> = {
  UserPromptSubmit: ['Stop', 'Interrupt', 'SessionEnd'], PreToolUse: ['PostToolUse'],
  SubagentStart: ['SubagentStop'],
};
const TITLE: Record<string, string> = {
  SessionStart: 'Codex · 세션 시작', SessionEnd: 'Codex · 세션 종료', UserPromptSubmit: 'Codex · 턴 시작',
  PreToolUse: 'Codex · 도구 시작', PostToolUse: 'Codex · 도구 결과', SubagentStart: 'Codex · 에이전트 시작',
  SubagentStop: 'Codex · 에이전트 종료 이벤트',
  Stop: 'Codex · 턴 종료 이벤트', Interrupt: 'Codex · 사용자 중단',
};
export const codexSpanKey = (r: Rec, event: string): string | null => {
  const session = token(r['session_id']);
  if (event === 'SessionEnd') return JSON.stringify([session, 'session']);
  if (event === 'SubagentStop') return token(r['agent_id']) ? JSON.stringify([session, event, r['agent_id']]) : null;
  // Native unified-exec may deliver the receipt on a later write_stdin turn. Call IDs are session-scoped.
  if (event === 'PostToolUse') return token(r['tool_use_id']) ? JSON.stringify([session, event, r['tool_use_id']]) : null;
  return token(r['prompt_id']) ? JSON.stringify([session, event, r['prompt_id']]) : null;
};

/** The first row of each run, so runs built from separate parts can be put back in one pass's order. */
export const firstRow = new WeakMap<OperationRun, Rec>();
/** Each row's step with what it was made from: a long turn rebuilt for one new row makes only the steps whose pairing or age
 * changed, not one per row of the turn. */
const made = new WeakMap<Rec, { end: Rec | undefined; closing: Rec | undefined; stale: boolean; step: OperationStep }>();
/** A native host row this view reads. */
export const codexRow = (r: Rec): boolean => r['host'] === 'codex' && r['phase'] === 'codex_event' && !!token(r['session_id']) && !!at(r);
/** The run a native row belongs to, or null when it shows no step. */
export const codexRunKey = (r: Rec): string | null => {
  const event = token(r['event']) ?? '';
  if (!TITLE[event]) return null;
  return `codex:${r['session_id']}:${event === 'SubagentStart' || event === 'SubagentStop' ? `agent:${token(r['agent_id']) ?? 'unknown'}` : token(r['prompt_id']) ?? 'session'}`;
};

/** Native host spans are never counted as Jev requests, routed workers, or accepted contracts. `flipsAt` hears when an open
 * span stops being active, so the dashboard rebuilds then and not before. `outside` holds session ends recorded with other
 * rows of a split build: they close spans here but show no step; `position` orders them among these rows as one pass would. */
export const codexOperations = (records: Rec[], now: Date, flipsAt?: (at: number) => void, outside?: { ends: Rec[]; position: (r: Rec) => number }): OperationRun[] => {
  const own = records.filter(codexRow);
  const rows = outside?.ends.length ? [...own, ...outside.ends].sort((a, b) => at(a).localeCompare(at(b)) || outside.position(a) - outside.position(b))
    : own.sort((a, b) => at(a).localeCompare(at(b)));
  const foreign = new Set(outside?.ends);
  // Pair once in reverse order. Re-scanning the full recording for every start made live refresh quadratic.
  const terminals = new Map<string, Rec>();
  const paired = new Map<Rec, Rec>();
  const ended = new Map<Rec, Rec>();
  for (const row of [...rows].reverse()) {
    if (row['phase'] !== 'codex_event') continue;
    const event = String(row['event']);
    const candidates = (START_END[event] ?? []).flatMap(end => {
      const key = codexSpanKey(row, end);
      const terminal = key ? terminals.get(key) : undefined;
      return terminal ? [terminal] : [];
    }).sort((a, b) => at(a).localeCompare(at(b)));
    if (candidates[0]) paired.set(row, candidates[0]);
    if (START_END[event]) {
      const closing = (event === 'SubagentStart' ? ['SessionEnd'] : ['Stop', 'Interrupt', 'SessionEnd']).flatMap(end => {
        const key = codexSpanKey(row, end); const terminal = key ? terminals.get(key) : undefined;
        return terminal ? [terminal] : [];
      }).sort((a, b) => at(a).localeCompare(at(b)))[0];
      if (closing) ended.set(row, closing);
    }
    if (['PostToolUse', 'SubagentStop', 'Stop', 'Interrupt', 'SessionEnd'].includes(event)) {
      const key = codexSpanKey(row, event);
      if (key) terminals.set(key, row);
    }
  }
  const groups = new Map<string, OperationStep[]>();
  const firsts = new Map<string, Rec>();
  for (const r of rows) {
    const event = token(r['event']) ?? '';
    const key = foreign.has(r) ? null : codexRunKey(r);
    if (!key) continue;
    const end = paired.get(r);
    const closing = ended.get(r);
    const open = !!START_END[event] && !end && !closing;
    if (open) flipsAt?.(Date.parse(at(r)) + 600_001);
    const stale = open && now.getTime() - Date.parse(at(r)) > 600_000;
    let kept = made.get(r);
    if (!kept || kept.end !== end || kept.closing !== closing || kept.stale !== stale) made.set(r, kept = { end, closing, stale, step: stepOf(r, key, event, end, closing, stale) });
    const steps = groups.get(key) ?? []; steps.push(kept.step); groups.set(key, steps);
    if (!firsts.has(key)) firsts.set(key, r);
  }
  return [...groups].map(([key, steps]) => {
    const run: OperationRun = {
      id: hash(key), host: 'codex', source: 'codex', title: 'Codex 실행', mode: 'native',
      ...(!key.includes(':agent:') && key.endsWith(':session') === false ? { executionId: hash(`execution:${key}`) } : {}),
      firstAt: steps[0]!.at, lastAt: steps.at(-1)!.at, steps,
      state: operationState(steps),
    };
    firstRow.set(run, firsts.get(key)!);
    return run;
  });
};

/** A native row's step from its pairing: `end` is its result, `closing` the turn or session end after it, and `stale` marks an
 * open start older than the bound. */
const stepOf = (r: Rec, key: string, event: string, end: Rec | undefined, closing: Rec | undefined, stale: boolean): OperationStep => {
  const isStart = !!START_END[event];
  const failed = (v: Rec | undefined) => v?.['is_error'] === true || typeof v?.['exit_code'] === 'number' && v['exit_code'] !== 0;
  const state = failed(r) || failed(end) ? 'error'
    : event === 'Interrupt' || end?.['event'] === 'Interrupt' || !end && closing?.['event'] === 'Interrupt' ? 'interrupted'
    : isStart && !end ? closing || stale ? 'unconfirmed' : 'active' : 'done';
  const tool = token(r['tool_name']);
  const detail = state === 'error' ? `호스트가 실패를 보고함${typeof (end ?? r)['exit_code'] === 'number' ? ` · 종료 코드 ${(end ?? r)['exit_code']}` : ' · 도구 오류'} · Jev 정책 오류와 별도`
    : state === 'interrupted' ? '사용자 중단 관측 · 성공이나 기능 오류로 분류하지 않음'
    : state === 'unconfirmed' ? closing ? '턴 또는 세션 종료 · 이 호출의 결과 이벤트는 미관측' : '결과 이벤트 미관측 · 실행 성공·실패를 판단할 수 없음'
    : tool === 'spawn_agent' && event === 'PostToolUse' ? '에이전트 생성 응답 · 작업 완료 여부는 별도 관측'
    : event === 'SubagentStop' ? '종료 훅 관측 · Jev 계약 수락 검사 없음'
    : [tool, token(r['agent_type']), token(r['model'])].filter(Boolean).join(' · ') || 'Codex 호스트 이벤트';
  const measured = end ? Date.parse(at(end)) - Date.parse(at(r)) : undefined;
  return {
    id: hash(`${key}:${token(r['invocation_id']) ?? at(r)}:${event}`), at: at(r),
    feature: 'workers',
    lifecycle: true, ...(state === 'error' && token(r['session_id']) ? { sessionId: token(r['session_id'])! } : {}),
    state, lane: 'host', title: TITLE[event]!, summary: detail, ...(event === 'SubagentStop' && state === 'done' ? { outcome: 'host_ended' as const } : {}),
    details: [...(state === 'unconfirmed' ? ['호스트 훅이 모든 도구 경로의 종료를 보장하지 않습니다. 원래 호스트에서 해당 도구 결과를 확인하세요.'] : []), ...(token(r['tool_use_id']) ? [`call: ${hash(String(r['tool_use_id']))}`] : [])],
    ...(measured !== undefined && Number.isFinite(measured) && measured >= 0 ? { durationMs: measured } : {}),
    ...(isStart ? { startedAt: at(r) } : {}),
  };
};
