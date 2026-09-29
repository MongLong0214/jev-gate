import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Env } from './config.js';
import { readTraceRecords } from './explain.js';
import { readLiveness } from './liveness.js';
import { buildOperations, type DebugRecord, type OperationsView } from './operations.js';

/**
 * A local view of calls the gate and the router already recorded. It whitelists short tokens from those records.
 * Prompt text, job files and anything that looks like a key never become a field of the snapshot.
 */

const MAX_DEBUG_BYTES = 2_000_000;
const MAX_EVENTS = 120;
const TOKEN = /^[A-Za-z0-9_.:/+@-]{1,80}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DEBUG_PREFIX = /jev-(router|compact|output) /;

const REASON: Record<string, string> = {
  admission_not_worth: '위임해도 계산상 이득이 없어 이 세션이 직접 처리합니다',
  admission_forbids_delegation: '요청이 위임을 금해서 직접 처리합니다',
  admission_external_tools: '커넥터가 필요해서 워커에게 넘기지 않습니다',
  admission_needs_context: '요청만으로 범위를 정할 수 없어 직접 처리합니다',
  admission_abstain: 'Jev가 판단을 보류해서 직접 처리합니다',
  admission_low_confidence: '확신이 낮아서 더 강한 모델로 올리지 않고 직접 처리합니다',
  admission_invalid: '응답을 읽을 수 없어 직접 처리합니다',
  admission_tie: '답이 갈려서 직접 처리합니다',
  admission_forced: '벤치가 오케스트레이션을 강제했습니다',
  admission_answer_only: '예전 규칙으로 직접 처리했습니다',
  admission_too_small: '예전 규칙으로 일이 작아 직접 처리했습니다',
  depth_below_floor: '컨텍스트가 floor보다 얕아서 묻지 않고 직접 처리합니다',
  depth_unknown: '컨텍스트 깊이를 읽지 못해 묻지 않고 직접 처리합니다',
  key_missing: 'TypeSafe 키가 없어 묻지 않습니다',
  prompt_id_absent: '프롬프트 id가 없어 게이트가 동작하지 않습니다',
  host_unsupported: '이 호스트에서는 오케스트레이션을 시작하지 않습니다',
  mode_native: 'native 모드라 등급을 바꾸지 않습니다',
  mode_off: '게이트가 꺼져 있습니다',
  pinned: '모델이 고정되어 바꾸지 않습니다',
  model_pinned: '모델이 고정되어 바꾸지 않습니다',
  effort_pinned: 'effort가 고정되어 바꾸지 않습니다',
  incoming_divergence: '들어온 값이 예상과 달라 바꾸지 않습니다',
  no_task_text: '맡길 문장이 없어 묻지 않습니다',
  model_mismatch: '요청한 모델과 실제로 돈 모델이 다릅니다',
  model_unobserved: '끝난 뒤 모델을 확인하지 못했습니다',
  not_asked: '묻지 않았습니다',
  applied: '적용했습니다',
};

export interface ActivityEvent {
  at: string;
  kind: 'asked' | 'skipped' | 'follow';
  title: string;
  call: string;
  used: string;
}

export interface ActivitySnapshot {
  at: string;
  traceDir: string | null;
  debugDir: string | null;
  traceFiles: number;
  unreadable: number;
  liveness: { recorded: number; attempted: number; lastReason: string | null } | null;
  jevCalls: number;
  direct: number;
  orchestrated: number;
  routerChanges: number;
  events: ActivityEvent[];
  operations: OperationsView;
  /** The turn on screen. An intent with no result yet is `working` until the result file appears. */
  live: LiveBoard;
  notes: string[];
}

export interface LiveStep {
  id: string;
  at: string;
  state: 'active' | 'done';
  title: string;
  line: string;
}

export interface LiveBoard {
  mode: 'working' | 'waiting';
  /** When `working`, the open step's timestamp. The page ticks elapsed time from this. */
  since: string | null;
  /** Newest step anywhere. The page ticks idle time from this while waiting. */
  lastAt: string | null;
  /** Which call is open, such as 게이트 A. Null while waiting. */
  stage: string | null;
  headline: string;
  detail: string;
  /** Chronological steps of the turn being shown. */
  steps: LiveStep[];
  earlier: Array<{ at: string; title: string; detail: string }>;
  sig: string;
}

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const sub = (r: Rec, k: string): Rec | null => (isRecord(r[k]) ? r[k] : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A recorded token. Spaces and long text stay out, so a prompt cannot ride along in a reason field. */
const token = (v: unknown): string | null => {
  if (typeof v !== 'string' || !TOKEN.test(v)) return null;
  if (v.toLowerCase().includes('sk-')) return null;
  return v;
};

const iso = (v: unknown): string => (typeof v === 'string' && ISO.test(v) ? v : '');

const reasonText = (v: unknown): string | null => {
  const code = token(v);
  if (code === null) return null;
  return REASON[code] ?? code;
};

const thousands = (n: number): string => Math.round(n).toLocaleString('en-US');

const isSymlink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

const readableDir = (path: string | null): boolean => {
  if (path === null || isSymlink(path)) return false;
  try {
    if (!statSync(path).isDirectory()) return false;
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
};

const jevCall = (r: Rec): { kind: 'asked' | 'skipped'; call: string } => {
  if (r['known_not_sent'] === true || r['attempted'] === false) {
    const why = reasonText(sub(r, 'decision')?.['reason'] ?? r['skip_code']);
    return { kind: 'skipped', call: why ? `Jev에 보내지 않음. ${why}` : 'Jev에 보내지 않음' };
  }
  const http = sub(r, 'http');
  const jev = sub(r, 'jev');
  const usage = jev ? sub(jev, 'usage') : null;
  const model = jev ? token(jev['model']) : null;
  const status = http ? num(http['status']) : null;
  const ms = http ? num(http['duration_ms']) : null;
  const input = usage ? num(usage['input_tokens']) : null;
  const output = usage ? num(usage['output_tokens']) : null;
  const parts = ['Jev에 물어봄'];
  if (model) parts.push(model);
  if (status !== null) parts.push(`HTTP ${status}`);
  if (ms !== null) parts.push(`${Math.round(ms)}ms`);
  if (input !== null || output !== null) parts.push(`입력 ${input ?? '?'} / 출력 ${output ?? '?'}`);
  else if (r['attempted'] === true) parts.push('사용량은 기록되지 않음');
  return { kind: 'asked', call: parts.join(' · ') };
};

const priceText = (r: Rec): string | null => {
  const est = sub(r, 'estimate');
  if (!est) return null;
  const turns = num(est['turns']);
  const saving = num(est['saving_tokens']);
  if (turns === null || saving === null) return null;
  return `가격 계산 ${Number(turns.toFixed(1))}턴, ${thousands(saving)}토큰. 측정된 절감이 아닙니다`;
};

const gateEvent = (r: Rec): ActivityEvent | null => {
  const phase = token(r['phase']);
  const at = iso(r['written_at']);
  if (phase === 'admission_result') {
    const call = jevCall(r);
    const decision = sub(r, 'decision');
    const shape = decision ? token(decision['shape']) : null;
    const why = decision ? reasonText(decision['reason']) : null;
    const shapeText = shape === 'orchestrated' ? '플래너에게 작업을 나눠 맡깁니다' : shape === 'direct' ? '이 세션이 이어서 처리합니다' : null;
    const price = priceText(r);
    // The skip line already carries the reason, so the second line only says what the session did.
    const used = call.kind === 'skipped' ? '원래 호출을 유지합니다' : [why ?? shapeText, why && shape === 'orchestrated' ? shapeText : null, price].filter((x): x is string => x !== null).join(' · ');
    return { at, kind: call.kind, title: '게이트 A', call: call.call, used: used || '기록된 결정이 없습니다' };
  }
  if (phase === 'pre_result') {
    const call = jevCall(r);
    const decision = sub(r, 'decision');
    const action = decision ? token(decision['action']) : null;
    const tier = decision ? token(decision['tier']) : null;
    const model = decision ? token(decision['model']) : null;
    const called = token(r['called_tier']);
    const role = token(r['role']) === 'planner' ? '플래너' : `작업 ${token(r['task_id']) ?? '?'}`;
    const why = decision ? reasonText(decision['reason']) : null;
    let used: string;
    if (action === 'preserve') used = `${role}: 호출된 ${called ?? tier ?? '?'} 등급을 유지합니다`;
    else if (action === 'patch' && tier && called && tier !== called) used = `${role}: ${called}에서 ${tier}로 바꿉니다${model ? ` (${model})` : ''}`;
    else if (action === 'patch') used = `${role}: ${tier ?? '?'} 등급으로 호출합니다${model ? ` (${model})` : ''}`;
    else used = `${role}: ${action ?? '결정 없음'} ${tier ?? ''}`.trim();
    if (why) used = `${used}. ${why}`;
    return { at, kind: call.kind, title: token(r['role']) === 'planner' ? '플래너 등급' : '워커 등급', call: call.call, used };
  }
  if (phase === 'plan') {
    const outcome = token(r['outcome']);
    const tasks = num(r['tasks']);
    const pm = sub(r, 'planner_model');
    const observed = pm ? token(pm['observed']) : null;
    return {
      at,
      kind: 'follow',
      title: '계획',
      call: 'Jev 호출이 아닙니다. 플래너가 끝난 뒤의 기록입니다',
      used: `계획 ${token(r['status']) ?? '?'}${outcome ? ` → ${outcome}` : ''}${tasks === null ? '' : `, 작업 ${tasks}개`}${observed ? `. 플래너 모델 ${observed}` : ''}`,
    };
  }
  if (phase === 'post') {
    const verdict = token(r['verdict']) ?? '판정 없음';
    const resolved = token(r['resolved_model']);
    const v = sub(r, 'verification');
    const transcript = v ? token(v['transcript']) : null;
    const blocks = ['contradicted', 'unobserved', 'stale'].filter((k) => Array.isArray(v?.[k]) && (v[k] as unknown[]).length > 0);
    return {
      at,
      kind: 'follow',
      title: '워커 결과',
      call: 'Jev 호출이 아닙니다. 워커가 끝난 뒤의 기록입니다',
      used: `워커 보고 ${verdict}${resolved ? `. 호스트 모델 ${resolved}` : ''}${transcript ? `. 검사 기록 ${transcript}` : ''}${blocks.length ? `. 막힌 검사 ${blocks.join(', ')}` : ''}`,
    };
  }
  if (phase === 'stop') {
    const outcome = token(r['outcome']);
    // A normal completion is one line per prompt and hides the decision above it. Keep only an ending that is not done.
    if (outcome === null || outcome === 'completed' || outcome === 'done') return null;
    return { at, kind: 'follow', title: '턴 종료', call: 'Jev 호출이 아닙니다', used: `게이트가 이 턴을 끝내지 못했습니다 (${outcome})` };
  }
  if (phase === 'failure') {
    const line = token(r['error_first_line']);
    return { at, kind: 'follow', title: '실패', call: 'Jev 호출이 아닙니다', used: line ? `호스트가 실패를 보고했습니다 (${line})` : '호스트가 실패를 보고했습니다' };
  }
  if (phase === 'guard' && r['allow'] === false) {
    return { at, kind: 'follow', title: '도구 거절', call: 'Jev 호출이 아닙니다', used: `${token(r['tool_name']) ?? '도구'} 호출을 거절했습니다` };
  }
  if (phase === 'lean_result') {
    const call = jevCall(r);
    const decision = sub(r, 'decision');
    const action = decision ? token(decision['action']) : null;
    const why = decision ? reasonText(decision['reason']) : null;
    return { at, kind: call.kind, title: 'lean', call: call.call, used: [action ? `선택 ${action}` : null, why].filter((x): x is string => x !== null).join('. ') || '기록된 선택이 없습니다' };
  }
  return null;
};

const ROUTER_TITLE: Record<string, string> = {
  router: '라우터 준비',
  root: '라우터 · 루트 턴',
  root_result: '라우터 · 루트 턴 결과',
  root_stop: '라우터 · 루트 턴 유지',
  child: '라우터 · 서브에이전트',
  child_stop: '라우터 · 서브에이전트 유지',
  spawn: '라우터 · 스폰',
  spawn_stop: '라우터 · 스폰 유지',
  spawn_result: '라우터 · 스폰 결과',
  late: '라우터 · 늦은 응답',
};

const routerEvent = (r: Rec, at: string): ActivityEvent | null => {
  const event = token(r['event']);
  if (event === null) return null;
  const usage = sub(r, 'usage');
  const input = usage ? num(usage['input'] ?? usage['input_tokens']) : null;
  const output = usage ? num(usage['output'] ?? usage['output_tokens']) : null;
  const spent = input !== null || output !== null ? `입력 ${input ?? '?'} / 출력 ${output ?? '?'}` : null;
  const skipped = token(r['skipped']);
  let kind: ActivityEvent['kind'] = 'follow';
  let call: string;
  if (r['sent'] === true) {
    kind = 'asked';
    call = spent ? `Jev에 물어봄 · ${spent}` : 'Jev에 물어봄 · 사용량은 기록되지 않음';
  } else if (r['sent'] === false || skipped) {
    kind = 'skipped';
    call = skipped ? `Jev에 보내지 않음 (${skipped})` : 'Jev에 보내지 않음';
  } else if (event === 'router') {
    const key = r['key'];
    const keyText = key === 'present' ? '키가 있습니다' : key === 'absent' || key === 'missing' || key === 'invalid' ? '키가 없습니다' : '키 상태는 기록되지 않았습니다';
    call = `호출 전 준비. ${keyText}`;
  } else {
    call = '이 줄은 호출이 아니라 그 다음 기록입니다';
  }
  const from = sub(r, 'from');
  const patch = sub(r, 'patch');
  const reasons = sub(r, 'reasons');
  const applied = isRecord(r['applied']) ? r['applied'] : null;
  const bits: string[] = [];
  const fromModel = from ? token(from['model']) : null;
  const fromEffort = from ? token(from['effort']) : null;
  if (fromModel || fromEffort) bits.push(`들어오기 전 ${[fromModel, fromEffort].filter((x): x is string => x !== null).join(' · ')}`);
  const patchEffort = patch ? token(patch['effort']) : token(r['patch']);
  if (patchEffort) bits.push(`effort를 ${patchEffort}로 바꿉니다`);
  const effortReason = reasons ? token(reasons['effort']) : null;
  const modelReason = reasons ? token(reasons['model']) : null;
  if (modelReason === 'not_asked') bits.push('모델은 묻지 않습니다');
  else if (modelReason) bits.push(reasonText(modelReason) ?? modelReason);
  if (effortReason && effortReason !== 'applied') bits.push(reasonText(effortReason) ?? effortReason);
  const appliedEffort = applied ? token(applied['effort']) : null;
  if (appliedEffort) bits.push(`적용된 effort ${appliedEffort}`);
  const observed = token(r['observed']);
  if (observed) bits.push(`호스트가 보고한 모델 ${observed}`);
  const why = reasonText(r['reason']);
  if (why) bits.push(why);
  return { at, kind, title: ROUTER_TITLE[event] ?? `라우터 · ${event}`, call, used: bits.join(' · ') || '기록된 변경이 없습니다' };
};

const routerChanged = (r: Rec): boolean => {
  const reasons = sub(r, 'reasons');
  if (reasons && (reasons['effort'] === 'applied' || reasons['model'] === 'applied')) return true;
  const patch = sub(r, 'patch');
  if (patch && token(patch['effort'])) return true;
  if (token(r['patch'])) return true;
  return false;
};

const readRouter = (dir: string): { rows: Array<{ at: string; rec: Rec }>; all: DebugRecord[]; notes: string[] } => {
  const notes: string[] = [];
  if (isSymlink(dir)) return { rows: [], all: [], notes: ['호스트 디버그 디렉터리가 심볼릭 링크라 읽지 않습니다'] };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { rows: [], all: [], notes: ['호스트 디버그 디렉터리를 열 수 없습니다'] };
  }
  const rows: Array<{ at: string; rec: Rec }> = [];
  const all: DebugRecord[] = [];
  let unparsed = 0;
  let skippedLarge = 0;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    if (isSymlink(path)) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_DEBUG_BYTES) {
      skippedLarge++;
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const atMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(line);
      const at = atMatch?.[1] ?? '';
      const match = DEBUG_PREFIX.exec(line);
      if (!match || !match[1]) continue;
      const component = match[1] as DebugRecord['component'];
      try {
        const parsed: unknown = JSON.parse(line.slice(match.index + match[0].length));
        if (isRecord(parsed)) {
          all.push({ at, component, rec: parsed });
          if (component === 'router') rows.push({ at, rec: parsed });
        }
        else unparsed++;
      } catch {
        unparsed++;
      }
    }
  }
  if (skippedLarge > 0) notes.push(`라우터 디버그 ${skippedLarge}개는 ${MAX_DEBUG_BYTES}바이트를 넘겨 건너뛰었습니다`);
  if (unparsed > 0) notes.push(`라우터 줄 ${unparsed}개는 JSON으로 읽지 못했습니다`);
  return { rows, all, notes };
};

const NOTES = [
  '프롬프트 원문, API 키, 작업 파일은 읽지 않습니다.',
  '가격의 토큰 수는 게이트가 위임을 고를 때 쓴 계산이고, 측정된 절감이나 청구액이 아닙니다.',
  'Evidence는 같은 JEV_GATE_TRACE_DIR을 받은 새 서버의 호출부터 기록됩니다. Compact·Output·Router는 호스트 디버그 로그를 사용합니다.',
];

/** A result file is written after the HTTP call. Past this, an intent with no result is not still in flight. */
const OPEN_FOR_MS = 8_000;

const INTENT_RESULT: Record<string, string> = {
  admission_intent: 'admission_result',
  pre_intent: 'pre_result',
  interpretation_intent: 'interpretation_result',
  lean_intent: 'lean_result',
};

const ROUTER_OPEN = new Set(['root', 'child', 'spawn']);
const ROUTER_CLOSE = new Set(['root_result', 'root_stop', 'child_stop', 'spawn_result', 'spawn_stop', 'spawn_native_result', 'late']);

const turnKey = (r: Rec): string => {
  const session = token(r['session_id']);
  const prompt = token(r['prompt_id']);
  if (session && prompt) return `${session}/${prompt}`;
  const id = token(r['request_id']);
  if (id) return `request:${id}`;
  return `lone:${iso(r['written_at'])}:${token(r['phase']) ?? ''}`;
};

const phaseTitle = (r: Rec): string => {
  const phase = token(r['phase']);
  if (phase === 'admission_intent' || phase === 'admission_result') return '게이트 A';
  if (phase === 'pre_intent' || phase === 'pre_result') return token(r['role']) === 'planner' ? '플래너 등급' : '워커 등급';
  if (phase?.startsWith('lean')) return 'lean';
  if (phase?.startsWith('interpretation')) return '계획 해석';
  return phase ?? '기록';
};

const fresh = (at: string, now: number): boolean => {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return false;
  const age = now - t;
  return age < OPEN_FOR_MS && age > -2_000;
};

const stepLine = (ev: ActivityEvent): string => (ev.call ? `${ev.call}. ${ev.used}` : ev.used);

/**
 * One turn, as stages. An intent stays active until its result file arrives, which is the gap while Jev is in flight.
 * A result replaces that stage instead of adding a second card.
 */
const buildLive = (records: Rec[], routerRows: Array<{ at: string; rec: Rec }>, now: number): LiveBoard => {
  const resultByRequest = new Map<string, Rec>();
  for (const r of records) {
    const phase = token(r['phase']);
    const id = token(r['request_id']);
    if (phase && id && phase.endsWith('_result')) resultByRequest.set(`${id}:${phase}`, r);
  }
  const steps: Array<LiveStep & { turn: string }> = [];
  for (const r of records) {
    const phase = token(r['phase']);
    if (!phase || INTENT_RESULT[phase]) continue;
    const ev = gateEvent(r);
    const at = ev?.at || iso(r['written_at']);
    if (ev) {
      steps.push({ id: token(r['request_id']) ?? token(r['invocation_id']) ?? `${phase}:${at}`, at, state: 'done', title: ev.title, line: stepLine(ev), turn: turnKey(r) });
    } else if (phase.endsWith('_result')) {
      const call = jevCall(r);
      steps.push({ id: token(r['request_id']) ?? `${phase}:${at}`, at, state: 'done', title: phaseTitle(r), line: call.call, turn: turnKey(r) });
    }
  }
  for (const r of records) {
    const phase = token(r['phase']);
    const expect = phase ? INTENT_RESULT[phase] : undefined;
    if (!phase || !expect) continue;
    const id = token(r['request_id']);
    const at = iso(r['written_at']);
    if (id && resultByRequest.has(`${id}:${expect}`)) continue;
    const open = fresh(at, now);
    steps.push({
      id: id ?? `intent:${phase}:${at}`,
      at,
      state: open ? 'active' : 'done',
      title: phaseTitle(r),
      line: open ? 'Jev에 보냈습니다. 응답을 기다리는 중입니다' : '응답 기록이 없습니다',
      turn: turnKey(r),
    });
  }
  for (const row of routerRows) {
    const event = token(row.rec['event']);
    const ev = event ? routerEvent(row.rec, row.at) : null;
    if (!event || !ev) continue;
    const turnToken = token(row.rec['turn']);
    const turnId = turnToken ?? row.at;
    const closed = turnToken !== null && ROUTER_OPEN.has(event) && routerRows.some((other) => token(other.rec['turn']) === turnToken && other.at >= row.at && ROUTER_CLOSE.has(token(other.rec['event']) ?? ''));
    const open = ROUTER_OPEN.has(event) && row.rec['sent'] === true && !closed && fresh(row.at, now);
    steps.push({
      id: `router:${turnId}:${event}:${row.at}`,
      at: row.at,
      state: open ? 'active' : 'done',
      title: ev.title,
      line: open ? 'Jev에 보냈습니다. 응답을 기다리는 중입니다' : stepLine(ev),
      turn: `router:${turnId}`,
    });
  }

  const idle = (detail: string): LiveBoard => ({
    mode: 'waiting',
    since: null,
    lastAt: null,
    stage: null,
    headline: '다음 호출을 기다리는 중',
    detail,
    steps: [],
    earlier: [],
    sig: `waiting\n${detail}`,
  });
  if (steps.length === 0) return idle('아직 기록이 없습니다');

  const newest = [...steps].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))[0];
  if (!newest) return idle('아직 기록이 없습니다');
  const active = steps.filter((s) => s.state === 'active').sort((a, b) => b.at.localeCompare(a.at));
  const turn = active[0]?.turn ?? newest.turn;
  const mine = steps.filter((s) => s.turn === turn).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const working = mine.some((s) => s.state === 'active');
  const focus = [...mine].reverse().find((s) => s.state === 'active') ?? mine[mine.length - 1];
  const lastOf = new Map<string, LiveStep & { turn: string }>();
  for (const s of steps) {
    const prev = lastOf.get(s.turn);
    if (!prev || prev.at < s.at || (prev.at === s.at && prev.id < s.id)) lastOf.set(s.turn, s);
  }
  const earlier = [...lastOf.values()]
    .filter((s) => s.turn !== turn)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 6)
    .map((s) => ({ at: s.at, title: s.title, detail: s.line }));
  const extra = new Set(active.map((s) => s.turn)).size - (working ? 1 : 0);
  const detail = `${focus?.line ?? ''}${extra > 0 ? ` 다른 호출 ${extra}건도 진행 중입니다` : ''}`;
  const boardSteps = mine.map(({ id, at, state, title, line }) => ({ id, at, state, title, line }));
  const sig = [working ? 'working' : 'waiting', ...boardSteps.map((s) => `${s.id}\t${s.state}\t${s.line}`), ...earlier.map((e) => `${e.at}\t${e.title}`)].join('\n');
  return {
    mode: working ? 'working' : 'waiting',
    since: working ? (focus?.at ?? null) : null,
    lastAt: newest.at || null,
    stage: working ? (focus?.title ?? null) : null,
    headline: working ? 'Jev에 묻는 중' : '다음 호출을 기다리는 중',
    detail,
    steps: boardSteps,
    earlier,
    sig,
  };
};

export const loadActivity = (opts: { traceDir: string | null; debugDir: string | null; env: Env; now?: Date }): ActivitySnapshot => {
  const notes = [...NOTES];
  const events: ActivityEvent[] = [];
  const gateRecords: Rec[] = [];
  const routerRows: Array<{ at: string; rec: Rec }> = [];
  const debugRows: DebugRecord[] = [];
  let traceFiles = 0;
  let unreadable = 0;
  let jevCalls = 0;
  let direct = 0;
  let orchestrated = 0;
  let routerChanges = 0;
  const traceAvailable = readableDir(opts.traceDir);
  const debugAvailable = readableDir(opts.debugDir);

  if (opts.traceDir === null) notes.push('게이트 추적 디렉터리가 없습니다. 최근 50건의 시도 여부만 liveness에 있습니다.');
  else if (isSymlink(opts.traceDir)) notes.push('게이트 추적 디렉터리가 심볼릭 링크라 읽지 않습니다.');
  else {
    const read = readTraceRecords(opts.traceDir);
    traceFiles = read.records.length;
    unreadable = read.unreadable;
    if (read.unreadable > 0) notes.push(`추적 파일 ${read.unreadable}개는 읽지 못했습니다.`);
    for (const r of read.records) {
      gateRecords.push(r);
      const phase = token(r['phase']);
      if (phase === 'admission_result') {
        if (r['attempted'] === true) jevCalls++;
        const shape = token(sub(r, 'decision')?.['shape']);
        if (shape === 'direct') direct++;
        else if (shape === 'orchestrated') orchestrated++;
      } else if ((phase === 'pre_result' || phase === 'lean_result') && r['attempted'] === true) jevCalls++;
      const event = gateEvent(r);
      if (event) events.push(event);
    }
  }

  if (opts.debugDir !== null) {
    const router = readRouter(opts.debugDir);
    notes.push(...router.notes);
    debugRows.push(...router.all);
    for (const row of router.rows) {
      routerRows.push(row);
      if (row.rec['sent'] === true) jevCalls++;
      if (routerChanged(row.rec)) routerChanges++;
      const event = routerEvent(row.rec, row.at);
      if (event) events.push(event);
    }
  } else notes.push('라우터 디버그 디렉터리가 없습니다. 라우터 결정은 그 로그가 있을 때만 보입니다.');

  events.sort((a, b) => b.at.localeCompare(a.at));
  const now = opts.now ?? new Date();
  const liveness = readLiveness(opts.env);
  const operations = buildOperations(gateRecords, debugRows, now, {
    trace: traceAvailable,
    debug: debugAvailable,
  });
  return {
    at: now.toISOString(),
    traceDir: opts.traceDir,
    debugDir: opts.debugDir,
    traceFiles,
    unreadable,
    liveness: liveness ? { recorded: liveness.recent.length, attempted: liveness.recent.filter((e) => e.attempted).length, lastReason: token(liveness.recent.at(-1)?.reason ?? null) } : null,
    jevCalls,
    direct,
    orchestrated,
    routerChanges,
    events: events.slice(0, MAX_EVENTS),
    operations,
    live: buildLive(gateRecords, routerRows, now.getTime()),
    notes,
  };
};
