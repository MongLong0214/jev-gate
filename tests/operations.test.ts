import { describe, expect, it } from 'vitest';

import { buildOperations, operationsStableUntil, type ModRecord } from '../src/operations.js';
import { deterministicVerdict, parseWorkerReply, reportedSingleVerdict } from '../src/plan.js';
import { refusalReason } from '../src/verify.js';
import type { PlannedTask, WorkerReply } from '../src/types.js';

const at = '2026-09-29T06:00:00.000Z';
const later = '2026-09-29T06:00:01.000Z';
const base = { written_at: at, session_id: 's1', prompt_id: 'p1', mode: 'auto', prompt: 'PRIVATE_PROMPT', api_key: 'sk-private-value' };
const row = (component: ModRecord['component'], rec: Record<string, unknown>, time = at): ModRecord => ({ at: time, component, rec });

describe('operations display model', () => {
  it('identifies a request effort mismatch without inventing a response model mismatch', () => {
    const rows = [
      { ...base, host: 'codex', phase: 'codex_route_applied', request_kind: 'root_response', selected_model: 'gpt-6.1-sol', submitted_model: 'gpt-6.1-sol', selected_effort: 'high', submitted_effort: 'xhigh', applied: false },
      { ...base, host: 'codex', prompt_id: 'model', phase: 'codex_route_applied', request_kind: 'root_response', selected_model: 'gpt-6-luna', submitted_model: 'gpt-6.1-sol', selected_effort: 'low', submitted_effort: 'low', applied: false },
      { ...base, host: 'codex', prompt_id: 'legacy', phase: 'codex_route_applied', selected_model: 'gpt-6.1-sol', applied: false },
    ];
    const view = buildOperations(rows, [], new Date(later), { trace: true });
    expect(view.feed.find(s => s.issue === 'request_effort')).toMatchObject({ state: 'error', summary: '선택 effort와 API 전송 effort 불일치 · 선택 high · 전송 xhigh', model: { status: 'unobserved', observed: null } });
    expect(view.feed.some(s => s.issue === 'request_model')).toBe(true);
    expect(view.feed.some(s => s.issue === 'request_unconfirmed')).toBe(true);
    expect(view.attention).toBe(2);
  });
  it('keeps legacy request discrepancies unconfirmed when the request purpose was not recorded', () => {
    const view = buildOperations([{ ...base, host: 'codex', phase: 'codex_route_applied', selected_model: 'gpt-6.1-sol', submitted_model: 'gpt-6.1-sol', selected_effort: 'high', submitted_effort: 'xhigh', applied: false }], [], new Date(later), { trace: true });
    expect(view.feed[0]).toMatchObject({ state: 'unconfirmed', issue: 'request_unconfirmed', summary: 'API 설정 관측 · 요청 종류 미확인 · gpt-6.1-sol · gpt-6.1-sol · xhigh' });
    expect(view.attention).toBe(0);
  });
  it('shows a proposed effort downgrade held by the cache separately from the final request setting', () => {
    const view = buildOperations([], [row('router', { event: 'root', turn: 'warm', from: { model: 'claude-opus-5-5', effort: 'xhigh' }, proposed_patch: { effort: 'low' }, patch: {}, held_for_cache: 'low', reasons: { model: 'same_value', effort: 'cache_preserved' } })], new Date(later), { trace: true });
    expect(view.feed[0]?.details.join(' ')).toContain('캐시 재사용을 위해 effort 유지 · Jev 제안 low · 요청 설정 xhigh');
    expect(view.feed[0]?.model?.forwardedEffort).not.toBe('low');
  });
  it('keeps host dispatch effort, wire request effort and missing response effort as different facts', () => {
    const report = buildOperations([
      { phase: 'codex_router_response', host: 'codex', session_id: 'codex', prompt_id: 'p1', written_at: at, selected_model: 'gpt-6.1-sol', observed_model: 'gpt-6.1-sol', selected_effort: 'low', submitted_effort: 'low', observed_effort: 'unknown' },
    ], [row('router', { event: 'root_result', turn: 't1', requested: 'claude-opus-5-5', requested_effort: 'high', observed: 'claude-opus-5-5', observed_effort: 'unknown', confirmation: 'confirmed' })], new Date(at), { trace: true });
    const models = report.runs.flatMap(r => r.steps).filter(s => s.model).map(s => s.model!);
    expect(models).toContainEqual(expect.objectContaining({ effortSource: 'host_hook', forwardedEffort: 'high', observedEffort: null }));
    expect(models).toContainEqual(expect.objectContaining({ effortSource: 'provider_request', forwardedEffort: 'low', observedEffort: null }));
  });
  it('connects background launches, questions and terminals to the original job without treating launch as completion', () => {
    const launch = { ...base, phase: 'background_launch', tool_use_id: 'd', status: 'running' };
    const question = { ...base, phase: 'background_conversation', prompt_id: 'q', execution_prompt_id: 'p1', active: 1 };
    const active = buildOperations([launch, question], [], new Date(later), { trace: true });
    expect(active.runs).toHaveLength(1); expect(active.runs[0]?.state).toBe('active');
    expect(active.feed.some(s => s.summary.includes('질문 가능'))).toBe(true);
    const stale = buildOperations([launch], [], new Date(Date.parse(at) + 31_000), { trace: true });
    expect(stale.feed[0]?.summary).toBe('시작 기록 있음 · 종료 결과 미관측'); expect(stale.runs[0]?.state).toBe('unconfirmed');
    const terminal = { ...base, written_at: later, phase: 'background_terminal', tool_use_id: 'd', prompt_id: 'q', execution_prompt_id: 'p1', status: 'completed' };
    const done = buildOperations([launch, question, terminal], [], new Date(later), { trace: true });
    expect(done.runs).toHaveLength(1); expect(done.runs[0]?.state).toBe('done');
    expect(done.feed.some(s => s.summary.includes('별도 검사'))).toBe(true);
  });
  it('preserves native variant IDs and the Router identity confirmation without reclassifying dated aliases', () => {
    const view = buildOperations([], [
      row('router', { event: 'root_result', turn: 'variant', requested: 'claude-opus-5-5[1m]', observed: 'claude-opus-5-5[1m]', confirmation: 'confirmed' }),
      row('router', { event: 'spawn_result', tool_use_id: 'dated', requested: 'claude-haiku-4-5', observed: 'claude-haiku-4-5-20251001', confirmation: 'confirmed' }),
      row('router', { event: 'root_result', turn: 'mismatch', requested: 'claude-opus-5-5[1m]', observed: 'claude-opus-5-5', confirmation: 'mismatch' }),
    ], new Date(later), { trace: true });
    expect(view.feed.find(s => s.model?.selected === 'claude-haiku-4-5')?.model?.status).toBe('confirmed');
    expect(view.feed.filter(s => s.model?.selected === 'claude-opus-5-5[1m]').map(s => s.model?.status).sort()).toEqual(['confirmed', 'mismatch']);
  });
  it('reports a failed Jev Router assessment separately from preserving native execution', () => {
    const view = buildOperations([{ ...base, host: 'codex', phase: 'codex_router_result', attempted: true, ok: false, reason: 'timeout', http: { code: 'timeout', duration_ms: 500 } }], [], new Date(later), { trace: true });
    expect(view.runs[0]?.state).toBe('attention');
    expect(view.feed.find(s => s.lane === 'jev')?.state).toBe('error');
    const claude = buildOperations([], [row('router', { event: 'root', turn: 'failed', sent: true, assessment: 'timeout' })], new Date(later), { trace: true });
    expect(claude.runs[0]?.state).toBe('attention');
    const gate = buildOperations([{ ...base, phase: 'admission_result', attempted: true, http: { code: 'deadline', duration_ms: 500 }, decision: { shape: 'direct' } }], [], new Date(later), { trace: true });
    expect(gate.feed.find(s => s.lane === 'jev')?.state).toBe('error');
  });
  it('does not present a direct turn ending or a planner dispatch as observed worker execution', () => {
    const view = buildOperations([{ ...base, phase: 'stop', outcome: 'completed' }, { ...base, phase: 'dispatch', role: 'planner' }], [], new Date(later), { trace: true, host: 'codex' });
    expect(view.features.find(f => f.id === 'workers')).toMatchObject({ count: 0, state: 'waiting' });
    expect(view.features.find(f => f.id === 'planning')).toMatchObject({ count: 1, state: 'observed' });
    expect(view.feed.some(s => s.title === '턴 종료' && s.lifecycle === true)).toBe(true);
  });
  it('exposes the applied admission path even when a Jev result or a local fallback owns it', () => {
    const view = buildOperations([
      { ...base, phase: 'admission_result', attempted: true, decision: { shape: 'direct' } },
      { ...base, prompt_id: 'p2', request_id: 'second', phase: 'admission_result', attempted: false, decision: { shape: 'orchestrated' } },
      { ...base, prompt_id: 'p3', request_id: 'third', phase: 'admission_result', decision: { shape: 'abstain' } },
    ], [], new Date(later), { trace: true });
    expect(view.feed.map(s => s.executionPath).filter(Boolean).sort()).toEqual(['direct', 'orchestrated']);
  });
  it('shows every installed runtime feature and keeps Jev, policy and host facts separate', () => {
    const records = [
      { ...base, phase: 'admission_intent', request_id: 'a1' },
      { ...base, phase: 'admission_result', request_id: 'a1', attempted: true, decision: { shape: 'orchestrated', reason: 'selected' }, jev: { usage: { input_tokens: 10, output_tokens: 2 } } },
      { ...base, phase: 'pre_intent', request_id: 'b1' },
      { ...base, phase: 'pre_result', request_id: 'b1', attempted: true, decision: { action: 'preserve', tier: 'standard' } },
      { ...base, phase: 'plan', status: 'accepted', tasks: 2, graph: [{ id: 't1', depends_on: [], required_checks: 1 }, { id: 't2', depends_on: ['t1'], required_checks: 2 }] },
      { ...base, phase: 'dispatch', role: 'worker', task_id: 't1', requested_tier: 'standard', requested_model: 'sonnet' },
      { ...base, phase: 'guard', tool_name: 'Read', allow: false, denials: 1 },
      { ...base, phase: 'post', task_id: 't1', verdict: 'accept', requested_model: 'sonnet', resolved_model: 'claude-sonnet-5', reported_checks: { pass: 1, fail: 0, not_run: 0 } },
      { written_at: at, phase: 'evidence_start', request_id: 'e1', kind: 'search', mode: 'locate' },
      { written_at: at, phase: 'evidence_jev_intent', request_id: 'e1:1', parent_request_id: 'e1', candidates: 4 },
      { written_at: later, phase: 'evidence_jev_result', request_id: 'e1:1', parent_request_id: 'e1', attempted: true, http: { status: 200 }, jev: { usage: { input_tokens: 20, output_tokens: 3 } } },
      { written_at: later, phase: 'evidence_result', request_id: 'e1', status: 'ok', backend: 'jev', items: 4, remote_calls: 1, cache_hits: 0 },
    ];
    const mods = [
      row('router', { event: 'request', turn: 'r1', sent: true }),
      row('router', { event: 'root', turn: 'r1', sent: true, patch: { effort: 'low' }, applied: { effort: 'low' } }, later),
      row('compact', { event: 'compact', run_id: 'c1', stage: 'started', mode: 'active' }),
      row('compact', { event: 'compact', run_id: 'c1', applied: true, digestChars: 100 }, later),
    ];
    const view = buildOperations(records, mods, new Date('2026-09-29T06:00:02.000Z'), { trace: true });
    expect(view.features.map((f) => f.id)).toEqual(['admission', 'allocation', 'planning', 'workers', 'guard', 'router', 'compact', 'evidence']);
    expect(view.features.every((f) => f.state === 'observed')).toBe(true);
    expect(view.requests).toBe(4);
    expect(view.runs.map((r) => r.source).sort()).toEqual(['compact', 'evidence', 'gate', 'router']);
    const gate = view.runs.find((r) => r.source === 'gate')!;
    expect(gate.steps.find((s) => s.feature === 'planning')?.graph).toEqual([
      { id: 't1', dependsOn: [], checks: 1 }, { id: 't2', dependsOn: ['t1'], checks: 2 },
    ]);
    expect(gate.steps.find((s) => s.title.includes('워커 결과'))?.details.join(' ')).toContain('claude-sonnet-5');
    expect(JSON.stringify(view)).not.toContain('PRIVATE_PROMPT');
    expect(JSON.stringify(view)).not.toContain('sk-private-value');
  });

  it('marks a sent request without a receipt as unconfirmed, never as zero usage', () => {
    const records = [{ ...base, phase: 'admission_intent', request_id: 'lost' }];
    const view = buildOperations(records, [], new Date('2026-09-29T06:01:00.000Z'), { trace: true });
    expect(view.requests).toBe(1);
    expect(view.runs[0]?.state).toBe('unconfirmed');
    expect(view.runs[0]?.steps[0]?.state).toBe('unconfirmed');
    expect(view.features.find((f) => f.id === 'router')?.state).toBe('waiting');
    expect(JSON.stringify(view)).not.toContain('입력 0');
  });

  it('counts an old attempted result when the intent record is missing', () => {
    const records = [{ ...base, phase: 'admission_result', request_id: 'old', attempted: true, decision: { shape: 'direct' } }];
    const view = buildOperations(records, [], new Date(at), { trace: true });
    expect(view.requests).toBe(1);
  });

  it('shows actual model mismatch even while another step awaits a response', () => {
    const view = buildOperations([
      { ...base, phase: 'admission_intent', request_id: 'pending' },
      { ...base, phase: 'post', requested_model: 'opus', resolved_model: 'claude-sonnet-5' },
    ], [], new Date(later), { trace: true });
    expect(view.runs[0]?.state).toBe('attention');
    expect(view.feed.find(s => s.model)?.state).toBe('error');
  });

  it('uses root_result applied.model as the selected model and keeps missing response evidence unknown', () => {
    const mods = [row('router', { event: 'root_result', turn: 'r', applied: { model: 'sonnet', effort: 'low' }, observed: 'claude-sonnet-5' })];
    const view = buildOperations([], mods, new Date(later), { trace: true });
    expect(view.feed[0]?.model).toMatchObject({ selected: 'sonnet', observed: 'claude-sonnet-5', status: 'confirmed', selectedEffort: 'low' });
  });

  it.each(['codex_event', 'guard'])('keeps a Jev judgment visible after a busy %s loop and correlates the known turn', phase => {
    const records: Array<Record<string, unknown>> = [
      { ...base, host: 'codex', phase: 'admission_result', request_id: 'a', attempted: true, decision: { shape: 'direct' } },
      ...Array.from({ length: 200 }, (_, i) => ({ ...base, written_at: later, host: 'codex', phase, event: 'PostToolUse', allow: true, tool_use_id: `c${i}`, invocation_id: `i${i}` })),
    ];
    const view = buildOperations(records, [], new Date(later), { trace: true });
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]?.steps).toHaveLength(202);
    expect(view.feed.some(s => s.lane === 'jev')).toBe(true);
  });

  it('separates measured Jev response, typed answer and code policy without treating a guard denial as an error', () => {
    const records = [
      { ...base, phase: 'admission_intent', request_id: 'typed' },
      { ...base, written_at: later, phase: 'admission_result', request_id: 'typed', attempted: true,
        http: { duration_ms: 247 }, answers: { need_worker: { noul: 0.81, confidence: 0.72 } },
        decision: { shape: 'orchestrated' }, policy_basis: 'bounded_tool_worker', estimate: { saving_tokens: -245000, cost_support: 0 } },
      { ...base, written_at: later, phase: 'guard', tool_name: 'Bash', allow: false, denials: 1 },
    ];
    const view = buildOperations(records, [], new Date(later), { trace: true });
    const steps = view.runs[0]!.steps;
    const response = steps.find((s) => s.lane === 'jev' && s.durationMs === 247)!;
    expect(response.judgements?.[0]).toMatchObject({ question: 'need_worker', value: '참 확률 81%' });
    expect(response.judgements?.[0]?.probabilities?.[0]).toEqual({ label: '참', value: 0.81 });
    expect(response.judgements?.[0]?.probabilities?.[1]?.value).toBeCloseTo(0.19);
    expect(steps.find((s) => s.lane === 'policy' && s.feature === 'admission')?.summary).toContain('orchestrated');
    expect(steps.find((s) => s.lane === 'policy' && s.feature === 'admission')?.details.join(' ')).toContain('빠른 워커 우선 정책');
    expect(steps.find((s) => s.lane === 'policy' && s.feature === 'admission')?.details.join(' ')).toContain('-245,000');
    expect(steps.find((s) => s.feature === 'guard')?.state).toBe('done');
    expect(view.latency).toMatchObject({ measured: 1, p50: 247, p95: 247 });
  });
});


it.each(['claude', 'codex'])('renders the final Gate B selection and keeps real mismatches and unobserved execution (%s)', host => {
  const selected = host === 'claude' ? 'claude-sonnet-5-5' : 'gpt-6.1-sol';
  const pre = { ...base, host, phase: 'pre_result', tool_use_id: 't', attempted: true, called_tier: 'standard', decision: { tier: 'deep', model: 'opus', action: 'patch' }, allocation: { selected_model: selected, effort_edit: { kind: 'set', value: 'high' } } };
  const result = { ...base, host, phase: 'post', tool_use_id: 't', requested_model: 'opus', resolved_model: selected };
  const view = buildOperations([pre, result], [], new Date(at), { trace: true });
  const steps = view.runs.flatMap(r => r.steps);
  expect(steps.some(s => s.model?.status === 'mismatch')).toBe(false);
  expect(steps.find(s => s.lane === 'policy')?.summary).toContain(selected);
  expect(steps.find(s => s.model?.status === 'confirmed')?.model).toMatchObject({ selected, observed: selected });
  expect(steps.find(s => s.model?.status === 'unobserved')?.model).toMatchObject({ selected, observed: null, selectedEffort: 'high' });
  const mismatch = buildOperations([pre, { ...result, resolved_model: 'claude-opus-5-5' }], [], new Date(at), { trace: true });
  expect(mismatch.feed.some(s => s.model?.status === 'mismatch')).toBe(true);
});


it('links Router keep/change reasons to the exact root response and preserves cache-held effort', () => {
  const decision = { event: 'root', session_id: 's', turn: 't', from: { model: 'claude-opus-5-5', effort: 'xhigh' }, patch: {}, held_for_cache: 'high', reasons: { model: 'same_value', effort: 'cache_preserved' } };
  const response = { event: 'root_result', session_id: 's', turn: 't', requested: 'claude-opus-5-5', requested_effort: 'xhigh', observed: 'claude-opus-5-5', confirmation: 'confirmed', observed_effort: 'unknown' };
  const view = buildOperations([], [row('router', decision), { ...row('router', response), at: later }, { ...row('router', { ...response, session_id: 'other' }), at: later }], new Date(later), { trace: true });
  const responses = view.runs.flatMap(r => r.steps).filter(s => s.model);
  expect(responses.filter(s => s.routing)).toHaveLength(1);
  expect(responses.find(s => s.routing)?.routing).toEqual({ scope: 'root', baseline: 'claude-opus-5-5', modelReason: 'same_value', effortReason: 'cache_preserved' });
  expect(responses.find(s => s.routing)?.model).toMatchObject({ selectedEffort: 'xhigh', forwardedEffort: 'xhigh', observedEffort: null });
});

it('identifies Gate-owned spawn and child decisions using recorded tool and agent identities', () => {
  const gate = { ...base, phase: 'pre_result', tool_use_id: 'tool', allocation: { selected_model: 'claude-sonnet-5-5', effort_edit: { kind: 'set', value: 'high' } } };
  const spawn = { event: 'spawn_result', session_id: base.session_id, tool_use_id: 'tool', agent_id: 'child', requested: 'claude-sonnet-5-5', observed: 'claude-sonnet-5-5' };
  const response = { event: 'child_result', session_id: base.session_id, agent_id: 'child', turn: 'ct', requested: 'claude-sonnet-5-5', observed: 'claude-sonnet-5-5' };
  const view = buildOperations([gate], [row('router', spawn), { ...row('router', response), at: later }], new Date(later), { trace: true });
  const steps = view.runs.flatMap(r => r.steps);
  expect(steps.find(s => s.title.endsWith('spawn_result'))?.routing).toMatchObject({ scope: 'owned', modelReason: 'gate_allocated' });
  expect(steps.find(s => s.title.endsWith('child_result'))?.routing).toMatchObject({ scope: 'child', modelReason: 'gate_allocated' });
});


it('joins Codex Router reasons to matching provider responses without inferring reported effort', () => {
  const decision = { ...base, host: 'codex', phase: 'codex_router_result', baseline_model: 'gpt-6.1-sol', reasons: { model: 'same_value', effort: 'cache_preserved' } };
  const response = { ...base, host: 'codex', phase: 'codex_router_response', written_at: later, selected_model: 'gpt-6.1-sol', observed_model: 'gpt-6.1-sol', selected_effort: 'high', observed_effort: 'unknown' };
  const view = buildOperations([decision, response, { ...response, session_id: 'other' }], [], new Date(later), { trace: true });
  const responses = view.runs.flatMap(r => r.steps).filter(s => s.model?.observed);
  expect(responses.filter(s => s.routing?.modelReason === 'same_value')).toHaveLength(1);
  expect(responses.find(s => s.routing?.modelReason)?.model?.observedEffort).toBeNull();
});

it('shows a rejected Codex model proposal separately from the final model and only on its matching response', () => {
  const decision = { ...base, host: 'codex', phase: 'codex_router_result', baseline_model: 'gpt-6.1-sol',
    reasons: { model: 'low_confidence', effort: 'selected' }, answers: { model: { choice: 'gpt-5.6-terra', probabilities: { 'gpt-5.6-terra': .55 } } }, selection: { probability: .55, threshold: .6 } };
  const response = { ...base, host: 'codex', phase: 'codex_router_response', written_at: later, selected_model: 'gpt-6.1-sol', observed_model: 'gpt-6.1-sol' };
  const steps = buildOperations([decision, response, { ...response, session_id: 'other' }], [], new Date(later), { trace: true }).runs.flatMap(r => r.steps);
  const matched = steps.find(s => s.model?.observed && s.routing?.proposedModel);
  expect(matched?.routing).toMatchObject({ baseline: 'gpt-6.1-sol', proposedModel: 'gpt-5.6-terra', probability: .55, threshold: .6 });
  expect(matched?.model?.selected).toBe('gpt-6.1-sol');
  expect(steps.filter(s => s.model?.observed && s.routing?.proposedModel)).toHaveLength(1);
  const invalid = buildOperations([{ ...decision, selection: { probability: 2, threshold: -1 }, answers: { model: { choice: '__keep__' } } }], [], new Date(later), { trace: true }).runs.flatMap(r => r.steps);
  expect(invalid[0]?.routing?.proposedModel).toBeUndefined();
});


it('treats prepared as preparation metadata, not a completed host response or a new Jev call', () => {
  const prep = { event: 'prepared', session_id: 's', turn: 't', index: 0, scope: 'root', routed: false, preparation_ms: 2 };
  const view = buildOperations([], [row('router', prep)], new Date(at), { trace: true });
  expect(view.requests).toBe(0);
  expect(view.features.find(f => f.id === 'router')?.count).toBe(0);
  expect(view.runs[0]?.steps[0]).toMatchObject({ lifecycle: true, state: 'unconfirmed', title: 'Router · 요청 전달 준비' });
  expect(view.runs[0]?.steps[0]?.summary).toContain('실행 응답 확인은 별도');
  const response = { event: 'root_result', session_id: 's', turn: 't', index: 0, requested: 'claude-opus-5-5', observed: 'claude-opus-5-5' };
  const done = buildOperations([], [row('router', prep), { ...row('router', response), at: later }], new Date(later), { trace: true });
  expect(done.runs[0]?.steps.find(s => s.lifecycle)?.state).toBe('done');
});


it('closes historical preparations without an index but never closes a newer request with an earlier response', () => {
  const prep = { event: 'prepared', session_id: 's', turn: 't', scope: 'root' };
  const response = { event: 'root_result', session_id: 's', turn: 't', index: 0, requested: 'opus', observed: 'claude-opus-5-5' };
  const view = buildOperations([], [row('router', prep), { ...row('router', response), at: later }], new Date(later), { trace: true });
  expect(view.runs[0]?.steps.find(s => s.lifecycle)?.state).toBe('done');
  const pending = buildOperations([], [row('router', response), { ...row('router', { ...prep, index: 1 }), at: later }], new Date(later), { trace: true });
  expect(pending.runs[0]?.steps.find(s => s.lifecycle)?.state).toBe('unconfirmed');
});

it('does not close root or sibling preparations with another agent response in the same turn and loop index', () => {
  const common = { session_id: 's', turn: 't', index: 0 };
  const pending = [
    row('router', { ...common, event: 'prepared', scope: 'root', agent_id: null }),
    row('router', { ...common, event: 'prepared', scope: 'child', agent_id: 'waiting' }),
  ];
  const response = row('router', { ...common, event: 'child_result', agent_id: 'finished', requested: 'sonnet', observed: 'claude-sonnet-5-5' }, later);
  const view = buildOperations([], [...pending, response], new Date(later), { trace: true });
  expect(view.runs.flatMap(r => r.steps).filter(s => s.lifecycle).map(s => s.state)).toEqual(['unconfirmed', 'unconfirmed']);
  const matching = row('router', { ...common, event: 'child_result', agent_id: 'waiting', requested: 'sonnet', observed: 'claude-sonnet-5-5' }, later);
  const settled = buildOperations([], [...pending, response, matching], new Date(later), { trace: true });
  expect(settled.runs.flatMap(r => r.steps).filter(s => s.lifecycle).map(s => s.state).sort()).toEqual(['done', 'unconfirmed']);
});


it('reports actual Compact Jev calls in both hosts separately from local packing and installation', () => {
  const records = [
    { phase: 'codex_compact', host: 'codex', session_id: 'c', run_id: 'r', stage: 'selected', applied: false, jev_sent: true, jev_ms: 310, candidates: 16, available: 20, dependencies: 1, selection: 'current_dependencies', written_at: at },
    { phase: 'codex_compact', host: 'codex', session_id: 'c', run_id: 'r', stage: 'installed', applied: true, written_at: later },
  ];
  const mods = [row('compact', { event: 'compact', session_id: 's', run_id: 'r', stage: 'jev', jev_sent: true, jev_ms: 220, candidates: 4, available: 4, dependencies: 1, selection: 'current_dependencies' }), row('compact', { event: 'compact', session_id: 's', run_id: 'r', applied: true }, later)];
  const view = buildOperations(records, mods, new Date(later), { trace: true });
  expect(view.requests).toBe(2); expect(view.latency.measured).toBe(2);
  expect(view.feed.filter(s => s.lane === 'jev')).toHaveLength(2);
  expect(view.feed.some(s => s.summary.includes('Jev 작업 의존 근거 선택'))).toBe(true);
  expect(view.feed.find(s => s.lane === 'host')?.summary).toContain('설치 확인');
});


it('shows a forwarded native Compact request without a Router mismatch or claimed digest installation', () => {
  const view = buildOperations([{ phase: 'codex_compact', host: 'codex', session_id: 'c', run_id: 'n', stage: 'native_submitted', applied: false, summarizer_request: true, submitted_model: 'gpt-6.1-sol', submitted_effort: 'xhigh', written_at: at }], [], new Date(later), { trace: true, host: 'codex' });
  expect(view.feed).toHaveLength(1);
  expect(view.feed[0]).toMatchObject({ feature: 'compact', lane: 'host', state: 'unconfirmed', summary: expect.stringContaining('호스트 요약 모델') });
  expect(view.feed[0]?.issue).toBeUndefined();
  expect(view.feed[0]?.details.join(' ')).toContain('설치 미관측');
});


describe('actual model request lifecycle', () => {
  it('keeps a slow request active and matches response by session, turn, agent and loop index', () => {
    const request={session_id:'s',turn:'t',index:2,event:'model_request',requested:'claude-opus-5-5'};
    const now=new Date('2026-09-29T06:02:00.000Z');
    const build=(extra:ModRecord[]=[])=>buildOperations([], [row('router',request),...extra],now,{trace:true});
    // A running request carries its start; the page counts the elapsed time, so the record does not change every second.
    expect(build().feed.find(s=>s.lifecycle)).toMatchObject({state:'active',startedAt:expect.any(String)}); expect(build().feed.find(s=>s.lifecycle)?.elapsedMs).toBeUndefined();
    expect(build([row('router',{...request,index:1,event:'root_result'},later)]).feed.find(s=>s.title==='모델 · 응답 대기')?.state).toBe('active');
    expect(build([row('router',{...request,event:'root_result',observed:'claude-opus-5-5'},later)]).feed.find(s=>s.title==='모델 · 응답 대기')?.state).toBe('done');
    const failed=build([row('router',{...request,event:'model_failure'},later)]);
    expect(failed.feed.find(s=>s.title==='모델 · 응답 대기')?.state).toBe('done');
    expect(failed.feed.find(s=>s.title==='모델 · 요청 실패')?.state).toBe('error');
  });
});

describe('unanswered model requests (#212)', () => {
  const sent = '2026-10-08T00:00:00.000Z', minute = (n: number) => new Date(Date.parse(sent) + n * 60_000).toISOString();
  const child = { session_id: 's', turn: 'child-turn', agent_id: 'worker', scope: 'child', index: 3 };
  const request = row('router', { ...child, event: 'model_request', requested: 'claude-sonnet-5-5' }, sent);
  const claude = (extra: ModRecord[], now: string) => {
    const view = buildOperations([], [request, ...extra], new Date(now), { trace: true });
    return { view, step: view.runs.flatMap(r => r.steps).find(s => s.title === '모델 · 응답 대기')! };
  };
  const others = (rec: Record<string, unknown>, at: string) => [{ ...rec, agent_id: 'sibling' }, { ...rec, agent_id: null, scope: 'root' }, { ...rec, session_id: 'other' }].map(r => row('router', r, at));

  it('stops counting a days-old request as running without concluding it, and settles a late response', () => {
    const old = claude([], '2026-10-12T03:13:00.000Z');
    expect(old.step).toMatchObject({ state: 'unconfirmed', summary: '모델 응답 기록 없음 · 현재 활동 미관측' });
    expect(old.step.elapsedMs).toBeUndefined(); expect(old.step.startedAt).toBeUndefined();
    expect(old.view).toMatchObject({ active: 0, attention: 0 }); expect(old.view.runs[0]?.state).toBe('unconfirmed');
    expect(claude([], minute(2)).step).toMatchObject({ state: 'active', summary: '모델 응답 대기', startedAt: sent }); expect(claude([], minute(2)).step.elapsedMs).toBeUndefined();
    expect(claude([], minute(2)).view.active).toBe(1);
    const late = claude([row('router', { ...child, event: 'child_result', requested: 'claude-sonnet-5-5', observed: 'claude-sonnet-5-5', confirmation: 'confirmed' }, minute(5000))], '2026-10-12T03:13:00.000Z');
    expect(late.step).toMatchObject({ state: 'done', summary: '모델 요청 종료 기록 확인' }); expect(late.view.active).toBe(0);
  });

  it('keeps a slow request live only on activity from its exact loop and never closes it from elsewhere', () => {
    const alive = claude([row('router', { ...child, event: 'late', usage: { input: 1 } }, minute(15))], minute(20));
    expect(alive.step).toMatchObject({ state: 'active', startedAt: expect.any(String) }); expect(alive.view.active).toBe(1);
    for (const other of others({ ...child, event: 'late' }, minute(15))) expect(claude([other], minute(20)).step.state).toBe('unconfirmed');
    for (const other of others({ ...child, event: 'child_result', observed: 'claude-sonnet-5-5' }, minute(1))) expect(claude([other], minute(2)).step.state).toBe('active');
    for (const other of [...others({ ...child, event: 'turn_end', reason: 'aborted' }, minute(1)), ...others({ event: 'session_end', session_id: 's' }, minute(1)).slice(2), row('router', { event: 'session_end' }, minute(1))]) expect(claude([other], minute(2)).step.state).toBe('active');
  });

  it('links an exact turn, child or session end without synthesizing a response', () => {
    const end = (rec: Record<string, unknown>, at = minute(1)) => claude([row('router', rec, at)], minute(2)).step;
    expect(end({ ...child, event: 'turn_end', reason: 'answer' })).toMatchObject({ state: 'unconfirmed', summary: '턴 또는 세션 종료 · 이 호출의 결과 이벤트는 미관측' });
    expect(end({ ...child, event: 'turn_end', reason: 'aborted' })).toMatchObject({ state: 'interrupted' });
    expect(end({ event: 'session_end', session_id: 's' })).toMatchObject({ state: 'unconfirmed' });
    expect(end({ ...child, event: 'turn_end', reason: 'aborted' }, '2026-10-07T23:59:00.000Z').state).toBe('active');
    const root = { session_id: 's', turn: 'root-turn', agent_id: null, scope: 'root', index: 0 };
    const rootView = buildOperations([], [row('router', { ...root, event: 'model_request' }, sent), row('router', { ...root, event: 'turn_end', reason: 'aborted' }, minute(1)), request], new Date(minute(2)), { trace: true });
    expect(rootView.runs.flatMap(r => r.steps).filter(s => s.title === '모델 · 응답 대기').map(s => s.state).sort()).toEqual(['active', 'interrupted']);
    expect(rootView.feed.some(s => s.title.includes('turn_end'))).toBe(false);
    const answered = claude([row('router', { ...child, event: 'turn_end', reason: 'aborted' }, minute(1)), row('router', { ...child, event: 'model_failure' }, minute(1))], minute(2));
    expect(answered.step.state).toBe('done'); expect(answered.view.attention).toBe(1);
  });

  it('applies the same evidence to Codex requests', () => {
    const req = { ...base, written_at: sent, host: 'codex', phase: 'codex_model_request', session_id: 'cx', prompt_id: 'turn-1', request_id: 'm1', submitted_model: 'gpt-6.1-sol' };
    const event = (name: string, extra: Record<string, unknown> = {}, at = minute(1)) => ({ host: 'codex', phase: 'codex_event', event: name, session_id: 'cx', prompt_id: 'turn-1', written_at: at, ...extra });
    const build = (extra: Record<string, unknown>[], now: string) => {
      const view = buildOperations([req, ...extra], [], new Date(now), { trace: true, host: 'codex' });
      return { view, step: view.runs.flatMap(r => r.steps).find(s => s.title === '모델 · 응답 대기')! };
    };
    expect(build([], '2026-10-12T03:13:00.000Z')).toMatchObject({ view: { active: 0 }, step: { state: 'unconfirmed', summary: '모델 응답 기록 없음 · 현재 활동 미관측' } });
    expect(build([], minute(2)).step.state).toBe('active');
    expect(build([event('PreToolUse', {}, minute(15))], minute(20)).step).toMatchObject({ state: 'active', startedAt: expect.any(String) });
    for (const other of [event('PreToolUse', { session_id: 'other' }, minute(15)), event('PreToolUse', { prompt_id: 'turn-2' }, minute(15))]) expect(build([other], minute(20)).step.state).toBe('unconfirmed');
    expect(build([event('Stop')], minute(2)).step.state).toBe('unconfirmed');
    expect(build([event('Interrupt')], minute(2)).step.state).toBe('interrupted');
    expect(build([event('SessionEnd', { prompt_id: null })], minute(2)).step.state).toBe('unconfirmed');
    for (const other of [event('Stop', { session_id: 'other' }), event('Stop', { prompt_id: 'turn-2' }), event('SessionEnd', { session_id: 'other' }), event('Stop', {}, '2026-10-07T23:59:00.000Z')]) expect(build([other], minute(2)).step.state).toBe('active');
    expect(build([event('Stop'), { ...req, phase: 'codex_router_response', written_at: minute(5000), observed_model: 'gpt-6.1-sol' }], '2026-10-12T03:13:00.000Z').step.state).toBe('done');
  });

  it('keeps past responses and their usage while an orphaned request is no longer running', () => {
    const usage = { input: 1200, output: 340, cache_read: 9000, cache_creation: 0 };
    const view = buildOperations([], [row('router', { ...child, index: 2, event: 'model_request' }, minute(-1)), row('router', { ...child, index: 2, event: 'child_result', observed: 'claude-sonnet-5-5', usage }, minute(-1)), request, row('router', { ...child, event: 'request', sent: true }, minute(-2))], new Date('2026-10-12T03:13:00.000Z'), { trace: true });
    expect(view.active).toBe(0); expect(view.requests).toBe(1);
    expect(view.runs.flatMap(r => r.steps).find(s => s.title === 'Router · child_result')?.details).toContain('입력 1,200 · 출력 340 · cache read 9,000 · cache write 0');
    expect(view.runs.flatMap(r => r.steps).filter(s => s.title === '모델 · 응답 대기').map(s => s.state).sort()).toEqual(['done', 'unconfirmed']);
  });
});


it('shows Codex model requests in flight even when Router preserves the baseline', () => {
  const req={...base,host:'codex',phase:'codex_model_request',request_id:'model-1',submitted_model:'gpt-6.1-sol'};
  const now=new Date('2026-09-29T06:02:00.000Z');
  const view=buildOperations([req],[],now,{trace:true});
  expect(view.feed[0]).toMatchObject({state:'active',lifecycle:true,startedAt:base.written_at,title:'모델 · 응답 대기'}); expect(view.feed[0]?.elapsedMs).toBeUndefined();
  const ended=buildOperations([req,{...base,written_at:later,host:'codex',phase:'codex_model_failure',request_id:'model-1'}],[],now,{trace:true});
  expect(ended.feed.find(s=>s.title==='모델 · 응답 대기')?.state).toBe('done');
  expect(ended.feed.find(s=>s.title==='모델 · 요청 실패')?.state).toBe('error');
});

it('does not terminate a Codex request from an earlier result or another session or prompt', () => {
  const req={...base,written_at:later,host:'codex',phase:'codex_model_request',request_id:'model-1'};
  const failure={...req,written_at:'2026-09-29T06:00:02.000Z',phase:'codex_model_failure'};
  const build=(record:Record<string,unknown>)=>buildOperations([req,record],[],new Date('2026-09-29T06:02:00.000Z'),{trace:true}).feed.find(s=>s.title==='모델 · 응답 대기')!;
  for(const record of [{...failure,session_id:'other'},{...failure,prompt_id:'other'},{...failure,written_at:at}])expect(build(record).state).toBe('active');
  expect(build(failure).state).toBe('done');
});


it.each([null, undefined])('settles observed Codex responses without a prompt identity (%s)', prompt => {
  const requests = Array.from({ length: 7 }, (_, i) => ({ ...base, host: 'codex', prompt_id: prompt, phase: 'codex_model_request', request_id: 'model-' + i, submitted_model: 'gpt-6-luna' }));
  const responses = requests.map(request => ({ ...request, phase: 'codex_router_response', written_at: later, observed_model: 'gpt-6-luna' }));
  const view = buildOperations([...requests, ...responses], [], new Date('2026-09-29T08:00:00.000Z'), { trace: true });
  expect(view.active).toBe(0);
  expect(view.runs.flatMap(run => run.steps).filter(step => step.title === '모델 · 응답 대기')).toEqual(requests.map(() => expect.objectContaining({ state: 'done', summary: '모델 요청 종료 기록 확인' })));
});

it('keeps unknown-prompt requests separate from other sessions, requests and known prompts', () => {
  const request = { ...base, host: 'codex', prompt_id: null, phase: 'codex_model_request', request_id: 'model-1' };
  const response = { ...request, phase: 'codex_router_response', written_at: later, observed_model: 'gpt-6-luna' };
  const build = (record: Record<string, unknown>) => buildOperations([request, record], [], new Date('2026-09-29T08:00:00.000Z'), { trace: true }).feed.find(step => step.title === '모델 · 응답 대기')!;
  for (const other of [{ ...response, session_id: 'other' }, { ...response, request_id: 'other' }, { ...response, prompt_id: 'known' }, { ...response, written_at: '2026-09-29T05:00:00.000Z' }]) expect(build(other).state).toBe('unconfirmed');
  expect(build(response).state).toBe('done');
});

it('joins actual Codex model evidence for an exact request with an unknown prompt', () => {
  const request = { ...base, host: 'codex', prompt_id: null, phase: 'codex_route_applied', request_id: 'model-1', request_kind: 'root_response', selected_model: 'gpt-6-luna', submitted_model: 'gpt-6-luna', applied: true };
  const response = { ...request, phase: 'codex_router_response', written_at: later, observed_model: 'gpt-6-luna' };
  const build = (record: Record<string, unknown>) => buildOperations([request, record], [], new Date(later), { trace: true }).feed.find(step => step.title === 'Router · Codex 요청 전송')!.model;
  expect(build(response)).toMatchObject({ requestApplied: true, observed: 'gpt-6-luna', status: 'confirmed' });
  expect(build({ ...response, prompt_id: 'known' })).toMatchObject({ requestApplied: true, observed: null, status: 'unobserved' });
});

it('confirms Codex request settings separately and joins only the exact observed response', () => {
  const req={...base,host:'codex',phase:'codex_route_applied',request_id:'req',request_kind:'root_response',selected_model:'gpt-6-luna',submitted_model:'gpt-6-luna',selected_effort:'low',submitted_effort:'low',applied:true};
  const response={...base,written_at:later,host:'codex',phase:'codex_router_response',request_id:'req',selected_model:'gpt-6-luna',observed_model:'gpt-6-luna'};
  const build=(records:Record<string,unknown>[])=>buildOperations(records,[],new Date(later),{trace:true}).feed.find(s=>s.title==='Router · Codex 요청 전송')!;
  expect(build([req]).model).toMatchObject({requestApplied:true,status:'unobserved',observed:null});
  expect(build([req,response]).model).toMatchObject({requestApplied:true,status:'confirmed',observed:'gpt-6-luna'});
  expect(build([req,{...response,session_id:'other'}]).model?.status).toBe('unobserved');
});

it('counts child Jev steps separately, closes only the exact decision and binds each model response', () => {
  const child = { session_id: 's1', turn: 'child-turn', agent_id: 'worker', scope: 'child' };
  const make = (event: string, index: number, extra: Record<string, unknown> = {}, time = at) => row('router', { ...child, event, index, ...extra }, time);
  const records = [make('request', 1, { sent: true }), make('child_route', 1, { sent: true, assessment: 'ok', from: { model: 'claude-opus-5-5' }, reasons: { model: 'selected', effort: 'selected' }, patch: { model: 'claude-sonnet-5-5', effort: 'low' } }, later),
    make('model_request', 1, { requested: 'claude-sonnet-5-5', requested_effort: 'low' }, later),
    make('child_result', 1, { requested: 'claude-sonnet-5-5', observed: 'claude-sonnet-5-5', confirmation: 'confirmed' }, later),
    make('request', 2, { sent: true }, '2026-09-29T06:00:02.000Z')];
  const view = buildOperations([], records, new Date('2026-09-29T06:00:03.000Z'), { trace: true });
  expect(view.requests).toBe(2);
  const requests = view.feed.filter(s => s.title === 'Router · request');
  expect(requests.map(s => s.state).sort()).toEqual(['active', 'done']);
  expect(view.feed.find(s => s.title === 'Router · child_result')).toMatchObject({ agentId: 'worker', routing: { scope: 'child', modelReason: 'selected', effortReason: 'selected' } });
  expect(view.feed.find(s => s.title === '모델 · 응답 대기')?.model?.selected).toBe('claude-sonnet-5-5');
});


it('hides native child routing skips and labels the other child skips', () => {
  const make = (agent: string, skipped: string) => row('router', { session_id: 's1', turn: 't', agent_id: agent, scope: 'child', event: 'child_route', index: 1, sent: false, skipped }, at);
  const feed = buildOperations([], [make('a', 'native_child'), make('b', 'child_unregistered'), make('c', 'child_stopped')], new Date(later), { trace: true }).feed;
  expect(feed.some(s => s.agentId === 'a')).toBe(false);
  expect(feed.find(s => s.agentId === 'b')?.summary).toBe('등록되지 않은 하위 실행 · 원래 설정 유지');
  expect(feed.find(s => s.agentId === 'c')?.summary).toBe('라우팅이 멈춘 하위 실행 · 원래 설정 유지');
});
it('retains every active execution beyond the recent completed-turn window', () => {
  const records: Record<string, unknown>[] = [{...base,phase:'admission_intent',request_id:'pending',prompt_id:'pending'}];
  for(let i=0;i<220;i++)records.push({...base,phase:'admission_result',written_at:later,request_id:'finished-'+i,prompt_id:'finished-'+i,invocation_id:'finished-'+i,attempted:false});
  const view=buildOperations(records,[],new Date(later),{trace:true});
  expect(view.runs).toHaveLength(201);expect(view.runs.flatMap(r=>r.steps).some(s=>s.state==='active')).toBe(true);
});

it('rebuilds only the sessions that changed or are still recent, and equals one pass over the whole recording (#215)', () => {
  const old = '2026-09-29T05:00:00.000Z', avail = { trace: true };
  const settled: Record<string, unknown>[] = [
    { ...base, written_at: old, phase: 'admission_intent', request_id: 'a1' },
    { ...base, written_at: old, phase: 'admission_result', request_id: 'a1', attempted: true, decision: { shape: 'direct' } },
    { written_at: old, phase: 'evidence_jev_intent', request_id: 'e1:1', parent_request_id: 'e1' },
    { ...base, session_id: 's2', written_at: old, phase: 'background_launch', tool_use_id: 'd' },
  ];
  const mods = [row('router', { session_id: 's1', event: 'root', turn: 't1' }, old), row('router', { event: 'root_result', turn: 't2', requested: 'claude-opus-5-5', observed: 'claude-opus-5-5', confirmation: 'confirmed' }, old)];
  const live = { ...base, session_id: 'live', phase: 'admission_intent', request_id: 'b1' };
  const answered = [...settled, live, { ...live, written_at: later, phase: 'admission_result', attempted: true, decision: { shape: 'direct' } }];
  const steps: Array<[Record<string, unknown>[], Date]> = [[[...settled, live], new Date(later)], [answered, new Date(later)],
    [[...answered, { ...settled[0], written_at: at, request_id: 'a2' }], new Date(Date.parse(later) + 31_000)]];
  const [first, second, third] = steps.map(([records, now]) => {
    const view = buildOperations(records, mods, now, avail);
    expect(view).toEqual(buildOperations(records, mods, now, avail, true));
    return view;
  });
  expect(first!.runs[0]?.state).toBe('active'); expect(second!.runs[0]?.state).toBe('done');
  // Only the recording session is rebuilt; then s1 changes, and the session-less pool and s2 stay as they were.
  expect(second!.runs.filter(run => first!.runs.includes(run))).toEqual(second!.runs.slice(1));
  expect(third!.runs.filter(run => second!.runs.includes(run)).map(run => run.title).sort()).toEqual(['Evidence 검색', 'Router 실행', '게이트 세션']);
});

it('reuses an unchanged recent session only until its next age edge, and equals one pass at every time', () => {
  const t0 = Date.parse('2026-09-29T07:00:00.000Z'), iso = (ms: number) => new Date(t0 + ms).toISOString(), avail = { trace: true };
  const records: Record<string, unknown>[] = [
    { ...base, written_at: iso(0), phase: 'admission_intent', request_id: 'open' },
    { ...base, written_at: iso(2_000), phase: 'background_launch', tool_use_id: 'bg' },
    { ...base, host: 'codex', written_at: iso(4_000), phase: 'codex_model_request', request_id: 'm1', submitted_model: 'gpt-6.1-sol' },
    { host: 'codex', phase: 'codex_event', event: 'PreToolUse', session_id: 'cx', prompt_id: 'turn-1', tool_use_id: 'tool', tool_name: 'Bash', written_at: iso(6_000) },
  ];
  const mods = [row('router', { session_id: 's1', turn: 't', index: 1, event: 'model_request', requested: 'claude-opus-5-5' }, iso(8_000)),
    row('compact', { event: 'compact', session_id: 's1', run_id: 'c1', stage: 'started' }, iso(10_000))];
  let previous: ReturnType<typeof buildOperations> | null = null;
  for (const offset of [0, 1, 15_000, 29_999, 30_000, 30_001, 31_000, 300_000, 599_999, 600_000, 600_001, 606_001, 610_001, 900_000, 900_001]) {
    const now = new Date(t0 + offset), view = buildOperations(records, mods, now, avail);
    expect(view, `at +${offset}ms`).toEqual(buildOperations(records, mods, now, avail, true));
    // Between two edges nothing is rebuilt: the same run objects come back.
    if (previous && offset === 31_000) expect(view.runs.every(run => previous!.runs.includes(run))).toBe(true);
    // The dashboard rebuilds without new records only at the next edge: here the 30-second mark of the record at +2s.
    if (offset === 31_000) expect(operationsStableUntil()).toBe(t0 + 32_000);
    previous = view;
  }
});

it('gives a Compact selection and its result written in the same millisecond their own step ids', () => {
  const at = '2026-09-29T06:09:59.000Z', run = { event: 'compact', session_id: 's', run_id: 'c' };
  const steps = buildOperations([], [row('compact', { ...run, stage: 'jev', jev_sent: true, jev_ms: 180 }, at), row('compact', { ...run, applied: true }, at)],
    new Date('2026-09-29T06:10:00.000Z'), { trace: true }).runs.flatMap(r => r.steps);
  expect(steps).toHaveLength(2); expect(new Set(steps.map(s => s.id)).size).toBe(2);
});

it('attaches the receipt of an answered Claude Router or Compact call, and never to a request, a skip or an unsent call (#225)', () => {
  const now = new Date('2026-09-29T06:10:00.000Z'), usage = { input: 1200, output: 30 };
  const steps = (rows: ModRecord[]) => buildOperations([], rows, now, { trace: true }).runs.flatMap(r => r.steps);
  const answered = steps([row('router', { session_id: 's', event: 'root', turn: 't1', sent: true, assessment: 'ok', duration_ms: 240, usage, jev_model: 'jev-1.13.0' })]).find(s => s.lane === 'jev')!;
  expect(answered.receipt).toMatchObject({ model: 'jev-1.13.0', input: 1200, output: 30 });
  expect(answered.receipt?.costUsd).toBeGreaterThan(0);
  // Records written before the model was recorded keep their receipt, and stay unpriced.
  const older = steps([row('router', { session_id: 's', event: 'root', turn: 't2', sent: true, assessment: 'ok', duration_ms: 240, usage })]).find(s => s.lane === 'jev')!;
  expect(older.receipt).toMatchObject({ model: null, input: 1200, costUsd: null });
  const compact = steps([row('compact', { event: 'compact', session_id: 's', run_id: 'c', stage: 'jev', jev_sent: true, jev_ms: 180, usage: { input_tokens: 900, output_tokens: 12 }, jev_model: 'jev-1.13.0', selection: 'current_dependencies' })]).find(s => s.lane === 'jev')!;
  expect(compact.receipt).toMatchObject({ model: 'jev-1.13.0', input: 900, output: 12 });
  const none = steps([
    row('router', { session_id: 's', event: 'request', turn: 't3', sent: true }),
    row('router', { session_id: 's', event: 'root', turn: 't4', sent: false, assessment: 'no_key', duration_ms: 1 }),
    row('compact', { event: 'compact', session_id: 's', run_id: 'c2', stage: 'jev', jev_sent: false, jev_ms: 3 }),
    row('compact', { event: 'compact', session_id: 's', run_id: 'c3', stage: 'started' }),
  ]);
  expect(none.filter(s => s.receipt)).toEqual([]);
});

it('keeps every record and Jev call of the last minute in the feed, past the newest-120 and newest-16 cuts', () => {
  const now = new Date('2026-09-29T06:10:00.000Z');
  const call = (run_id: string, time: Date) => row('compact', { event: 'compact', session_id: 's', run_id, stage: 'jev', jev_sent: true, jev_ms: 100, candidates: 1, available: 1, dependencies: 0, selection: 'current_dependencies' }, time.toISOString());
  const rows = [...Array.from({ length: 150 }, (_, i) => call(`r${i}`, new Date(now.getTime() - i * 300))), call('old', new Date(now.getTime() - 5 * 60_000))];
  const view = buildOperations([], rows, now, { trace: true });
  const inWindow = (s: { at: string }) => Date.parse(s.at) >= now.getTime() - 60_000;
  expect(view.feed.filter(s => s.feature === 'compact' && !s.lifecycle && inWindow(s))).toHaveLength(150);
  expect(view.latency.recent).toHaveLength(150);
});

describe('current incidents and past error records (#223)', () => {
  const yesterday = '2026-09-28T09:00:00.000Z', now = new Date('2026-09-29T06:00:05.000Z'), avail = { trace: true };
  const evidence = (request_id: string, written_at: string, extra: Record<string, unknown>) => ({ host: 'codex', session_id: `s-${request_id}`, phase: 'evidence_result', request_id, written_at, backend: 'local', items: 0, remote_calls: 0, cache_hits: 0, duration_ms: 0, coverage: { read_files: 0, candidates: 0, unjudged_on_page: 0 }, ...extra });
  const refused = evidence('old', yesterday, { status: 'unavailable', is_error: true, reason_codes: ['invalid_input'] });
  const ok = evidence('new', at, { status: 'ok', is_error: false, items: 3, reason_codes: [] });
  const failure = (view: ReturnType<typeof buildOperations>, id: string) => view.runs.find(r => r.steps.some(s => s.state === 'error' && s.at === id))!;
  const build = (records: Record<string, unknown>[], mods: ModRecord[] = []) => {
    const view = buildOperations(records, mods, now, avail);
    expect(view).toEqual(buildOperations(records, mods, now, avail, true));
    return view;
  };

  it('keeps an old invalid-input refusal as a past record of that request, never as an incident or a later success', () => {
    const view = build([refused, ok]);
    const old = failure(view, yesterday);
    expect(old.state).toBe('past_error');
    expect(old.steps[0]).toMatchObject({ state: 'error', issue: 'evidence', cause: 'invalid_input', sessionId: 's-old', impact: { now: 'request_only', lastAt: at, lastState: 'done' } });
    expect(view.attention).toBe(0);
    // Alone, it still affected only that request.
    expect(build([refused]).runs[0]).toMatchObject({ state: 'past_error', steps: [{ impact: { now: 'request_only', lastAt: yesterday, lastState: 'error' } }] });
  });

  it('keeps a service failure in the current count until a later success of the same operation on the same host', () => {
    const outage = (turn: string, time: string, assessment: string) => row('router', { session_id: `s-${turn}`, event: 'root', turn, sent: true, assessment }, time);
    const first = build([], [outage('t1', yesterday, 'network'), outage('t2', at, 'http_401')]);
    expect(first.attention).toBe(2);
    expect(failure(first, yesterday).steps.find(s => s.state === 'error')).toMatchObject({ cause: 'network', sessionId: 's-t1', impact: { now: 'ongoing', lastAt: at, lastState: 'error' } });
    expect(failure(first, at).steps.find(s => s.state === 'error')).toMatchObject({ cause: 'http_401', impact: { now: 'unknown', lastAt: at, lastState: 'error' } });
    const recovered = build([], [outage('t1', yesterday, 'network'), outage('t2', at, 'http_401'), outage('t3', later, 'ok')]);
    expect(recovered.attention).toBe(0);
    expect(recovered.runs.filter(r => r.state === 'past_error')).toHaveLength(2);
    expect(recovered.feed.filter(s => s.state === 'error').map(s => s.impact)).toEqual([{ now: 'later_ok', lastAt: later, lastState: 'done' }, { now: 'later_ok', lastAt: later, lastState: 'done' }]);
    // A success on another host shows nothing about this one.
    const config = evidence('cfg', yesterday, { status: 'unavailable', is_error: true, reason_codes: ['unavailable_config'] });
    const elsewhere = build([config, { ...ok, host: 'claude' }]);
    expect(failure(elsewhere, yesterday)).toMatchObject({ host: 'codex', state: 'attention', steps: [{ cause: 'unavailable_config', impact: { now: 'unknown' } }] });
    expect(elsewhere.runs.filter(r => r.host === 'codex' && r.state === 'attention')).toHaveLength(1);
    expect(elsewhere.runs.filter(r => r.host === 'claude' && r.state === 'attention')).toHaveLength(0);
  });

  it('keeps a verified model mismatch current until a later confirmed model, and an unobserved model settles nothing', () => {
    const result = (turn: string, time: string, confirmation: string, observed: string | null) => row('router', { session_id: `s-${turn}`, event: 'root_result', turn, requested: 'claude-opus-5-5', observed, confirmation }, time);
    const mismatch = result('m', yesterday, 'mismatch', 'claude-sonnet-5'), unobserved = result('u', at, 'unobserved', null);
    const open = build([], [mismatch, unobserved]);
    expect(open.attention).toBe(1);
    expect(failure(open, yesterday).steps[0]).toMatchObject({ model: { status: 'mismatch' }, impact: { now: 'unknown', lastAt: yesterday } });
    expect(open.runs.find(r => r.firstAt === at)).toMatchObject({ state: 'unconfirmed', steps: [{ state: 'unconfirmed', model: { status: 'unobserved' } }] });
    expect(open.feed.filter(s => s.model?.status === 'mismatch')).toHaveLength(1);
    const confirmed = build([], [mismatch, unobserved, result('c', later, 'confirmed', 'claude-opus-5-5')]);
    expect(failure(confirmed, yesterday)).toMatchObject({ state: 'past_error', steps: [{ state: 'error', model: { status: 'mismatch' }, impact: { now: 'later_ok', lastAt: later, lastState: 'done' } }] });
    expect(confirmed.attention).toBe(0);
  });

  it('keeps an unchanged failure run object across rebuilds and replaces it when its classification changes', () => {
    const config = evidence('cfg', yesterday, { status: 'unavailable', is_error: true, reason_codes: ['unavailable_config'] });
    const records = [config, { ...base, phase: 'admission_intent', request_id: 'a1' }];
    const first = buildOperations(records, [], now, avail), id = failure(first, yesterday).id;
    const second = buildOperations([...records, { ...base, session_id: 's9', phase: 'admission_intent', request_id: 'a9', written_at: later }], [], now, avail);
    expect(second.runs.find(r => r.id === id)).toBe(first.runs.find(r => r.id === id));
    const third = buildOperations([...records, ok], [], now, avail);
    expect(third.runs.find(r => r.id === id)).toMatchObject({ state: 'past_error', steps: [{ impact: { now: 'later_ok' } }] });
  });
});

describe('worker contract outcomes (#232)', () => {
  const t = (s: number) => new Date(Date.parse(at) + s * 1000).toISOString(), now = new Date(t(60)), avail = { trace: true };
  const build = (records: Record<string, unknown>[]) => {
    const view = buildOperations(records, [], now, avail);
    expect(view).toEqual(buildOperations(records, [], now, avail, true));
    return view;
  };
  const verification = (over: Record<string, unknown> = {}) => ({ transcript: 'read', contradicted: [], unobserved: [], stale: [], ...over });
  const unobserved = refusalReason(verification({ unobserved: ['#1'] }) as never)!;
  // Field names and shapes of v0.8.18 records: Claude hook rows carry no host and name the execution prompt on background rows;
  // Codex rows carry host and keep the dispatch prompt id. No row below is accepted unless its verdict is `accept`.
  const rows = (host: 'claude' | 'codex', session = `${host}-s`) => {
    const own = { ...(host === 'codex' ? { host } : {}), session_id: session, mode: 'auto', version: '0.8.18' };
    const later = host === 'codex' ? { prompt_id: 'p' } : { prompt_id: 'q', execution_prompt_id: 'p' };
    return {
      post: (s: number, verdict: string | null, reason: string | null, over: Record<string, unknown> = {}) => ({ ...own, phase: 'post', prompt_id: 'p', tool_use_id: `w${s}`, invocation_id: `${host}-post-${s}`, written_at: t(s),
        task_id: 'single', rev: 0, attempt: 1, verdict, verdict_reason: reason, reported_checks: { pass: 1, fail: 0, not_run: 0 }, ready_task_ids: [], plan_complete: false, evidence_format_only: false,
        root_fallback: false, subagent_type: 'jev-gate:worker', requested_model: 'sonnet', resolved_model: 'claude-sonnet-5', tool_response: { status: 'completed', agentId: 'a1' }, root_effort: null,
        verification: verification(verdict === 'incomplete' ? { unobserved: ['#1'] } : {}), advisory: null, ...over }),
      terminal: (s: number, tool = 'w1', over: Record<string, unknown> = {}) => ({ ...own, ...later, phase: 'background_terminal', tool_use_id: tool, invocation_id: `${host}-terminal-${s}`, written_at: t(s), status: 'completed',
        ...(host === 'codex' ? { agent_id: 'a1' } : { task_id: 'single' }), ...over }),
      delivery: (s: number) => ({ ...own, ...later, phase: 'background_policy_delivery', execution_prompt_id: 'p', invocation_id: `${host}-delivery-${s}`, written_at: t(s), reason: 'policy_delivered_no_active_execution', admission_blocked: false }),
      stop: (s: number) => ({ ...own, phase: 'stop', prompt_id: 'p', invocation_id: `${host}-stop-${s}`, written_at: t(s), outcome: 'incomplete' }),
    };
  };
  const contract = (view: ReturnType<typeof build>, outcome: string) => view.runs.flatMap(r => r.steps).filter(s => s.outcome === outcome);

  it.each(['claude', 'codex'] as const)('keeps a refused contract refused through a later host end, policy delivery and stop, with its reason class and check ids (%s)', host => {
    const r = rows(host), view = build([r.post(1, 'incomplete', unobserved), r.terminal(2), r.delivery(3), r.stop(4)]);
    expect(view.runs).toHaveLength(1); expect(view.runs[0]?.state).toBe('attention'); expect(view.attention).toBe(1);
    const [refused] = contract(view, 'rejected');
    expect(refused).toMatchObject({ state: 'error', issue: 'contract', cause: 'check_unobserved', task: 'single', impact: { now: 'unknown' }, summary: 'single · 계약 미충족 · incomplete · 통과 보고 검사의 실행 미관측' });
    expect(refused?.details).toEqual(expect.arrayContaining(['실행 기록 read · 미관측 #1', 'worker 보고 pass 1 · fail 0 · 미실행 0']));
    // The host end is recorded as such and, like the policy delivery and stop, decides nothing that could stand in for the verdict.
    expect(contract(view, 'host_ended')).toEqual([expect.objectContaining({ state: 'done', lifecycle: true, summary: '호스트에서 실제 종료 확인 · 계약 수락은 별도 검사' })]);
    expect(view.runs[0]?.steps.filter(s => s.feature === 'workers' && !s.lifecycle).map(s => s.outcome)).toEqual(['rejected']);
    expect(contract(view, 'accepted')).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('was reported pass');
  });

  it('records the Codex SubagentStop hook of a refused worker as a host end that leaves the refusal current', () => {
    const r = rows('codex'), stop = { host: 'codex', phase: 'codex_event', event: 'SubagentStop', session_id: 'codex-s', agent_id: 'a1', agent_type: 'jev-gate:worker', invocation_id: 'codex-agent-stop', written_at: t(2) };
    const view = build([r.post(1, 'incomplete', unobserved), stop]);
    const refusal = view.runs.find(x => x.steps.some(s => s.outcome === 'rejected'))!, hostRun = view.runs.find(x => x !== refusal)!;
    expect(refusal.state).toBe('attention'); expect(view.attention).toBe(1);
    expect(hostRun.steps).toEqual([expect.objectContaining({ outcome: 'host_ended', lifecycle: true, state: 'done', summary: '종료 훅 관측 · Jev 계약 수락 검사 없음' })]);
  });

  it.each(['claude', 'codex'] as const)('classifies each engine reason into a closed label and never passes the reason text or a reply on (%s)', host => {
    const task: PlannedTask = { id: 't1', outcome: 'o', depends_on: [], context: '', constraints: [], deliverables: [], replan_if: [], contract_hash: 'h', checks: [{ id: 'unit', description: 'd', required: true, command: 'npm test' }] };
    const reply = (over: Partial<WorkerReply>): WorkerReply => ({ status: 'done', summary: 'PRIVATE_SUMMARY', changed_files: [], interfaces: [], checks: [], blockers: [], ...over });
    const invalid = parseWorkerReply('{"status":"PRIVATE_REPLY_TEXT"}');
    const cases: Array<[string, string | null, string, string]> = [
      ['incomplete', refusalReason(verification({ contradicted: ['#2'] }) as never), 'check_contradicted', '모순 #2'],
      ['incomplete', refusalReason(verification({ transcript: 'truncated', unobserved: ['#1', '#3'] }) as never), 'check_unobserved', '미관측 #1, #3'],
      ['incomplete', refusalReason(verification({ transcript: 'unavailable', unobserved: ['#1'] }) as never), 'check_unobserved', '미관측 #1'],
      ['incomplete', refusalReason(verification({ stale: ['#1'] }) as never), 'check_stale', '변경 전 통과 #1'],
      ['incomplete', reportedSingleVerdict(reply({ status: 'blocked', checks: [{ check_id: 'npm test -- PRIVATE_COMMAND', result: 'fail', note: '' }] })).reason, 'worker_blocked', ''],
      ['incomplete', reportedSingleVerdict(reply({ blockers: ['PRIVATE_BLOCKER'] })).reason, 'worker_blocked', ''],
      ['replan', deterministicVerdict(task, reply({ status: 'replan' })).reason, 'worker_blocked', ''],
      ['incomplete', deterministicVerdict(task, reply({})).reason, 'check_report', ''],
      ['rework', deterministicVerdict(task, reply({ checks: [{ check_id: 'unit', result: 'fail', note: 'PRIVATE_NOTE' }] })).reason, 'check_report', ''],
      ['incomplete', deterministicVerdict(task, reply({ checks: [{ check_id: 'other', result: 'pass', note: '' }] })).reason, 'check_report', ''],
      ['incomplete', 'the worker changed files but reported no passing check it ran', 'check_report', ''],
      ['invalid', invalid.ok ? null : invalid.error, 'invalid_reply', ''],
      ['invalid', 'the task is no longer in the current plan', 'superseded', ''],
    ];
    expect(invalid.ok).toBe(false);
    const view = build(cases.map(([verdict, reason, , ids], i) => {
      const over = ids ? { verification: verification({ [ids.startsWith('모순') ? 'contradicted' : ids.startsWith('변경') ? 'stale' : 'unobserved']: ids.replace(/^\S+ (전 통과 )?/, '').split(', ') }) } : {};
      return rows(host, `${host}-${i}`).post(i + 1, verdict, reason, over);
    }));
    cases.forEach(([, reason, cause, ids], i) => {
      const step = view.runs.flatMap(r => r.steps).find(s => s.sessionId === `${host}-${i}`)!;
      expect(step, String(reason)).toMatchObject({ outcome: 'rejected', state: 'error', issue: 'contract', cause });
      if (ids) expect(step.details).toContain(`실행 기록 read · ${ids}`);
      expect(JSON.stringify(view)).not.toContain(String(reason));
    });
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE/);
    // A planned check id is counted, never named; only a reply position (#n) is shown.
    const planned = build([rows(host).post(1, 'incomplete', refusalReason(verification({ unobserved: ['unit', 'lint'] }) as never), { task_id: 't1', verification: verification({ unobserved: ['unit', 'lint'] }) })]);
    expect(contract(planned, 'rejected')[0]?.details).toContain('실행 기록 read · 미관측 2개');
  });

  it.each(['claude', 'codex'] as const)('keeps accept, an unknown verdict and native rows without a verdict apart (%s)', host => {
    const r = rows(host, `${host}-a`), u = rows(host, `${host}-u`), nat = rows(host, `${host}-n`);
    const view = build([
      r.post(1, 'accept', null), r.terminal(2),
      u.post(3, 'unknown', 'the call reported status failed', { reported_checks: null, verification: undefined, tool_response: { status: 'failed' } }), u.terminal(4, 'w3', { status: 'failed' }),
      { ...nat.post(5, null, null), matched: false, job_state: 'absent', verdict: undefined, verdict_reason: undefined, task_id: undefined },
      { ...nat.post(6, null, null), matched: false, job_state: 'absent', verdict: undefined, verdict_reason: undefined, task_id: undefined, tool_response: { status: 'async_launched' } },
    ]);
    const state = (session: string) => view.runs.find(x => x.steps.some(s => s.sessionId === session))?.state;
    expect(contract(view, 'accepted')).toEqual([expect.objectContaining({ state: 'done', summary: 'single · 계약 수락', task: 'single' })]);
    expect(state(`${host}-a`)).toBe('done');
    expect(contract(view, 'unknown')).toEqual([expect.objectContaining({ state: 'unconfirmed', summary: 'single · 판정 미확인 · 워커 응답 없음' })]);
    expect(contract(view, 'unknown')[0]).not.toHaveProperty('cause');
    expect(state(`${host}-u`)).toBe('interrupted');
    // A native outcome record is the host's own end of the call, never an accepted contract; a native launch is not even an end.
    const native = view.runs.flatMap(x => x.steps).filter(s => s.sessionId === `${host}-n`);
    expect(native.map(s => [s.state, s.outcome ?? null, s.summary])).toEqual([['done', 'host_ended', '예약과 일치하지 않는 호출 · 계약 판정 없음'], ['done', null, '예약과 일치하지 않는 호출 · 계약 판정 없음']]);
    expect(view.attention).toBe(0);
  });

  it.each(['claude', 'codex'] as const)('settles a refusal only by a later accept of the same task in the same execution, without rewriting it (%s)', host => {
    const r = rows(host), other = rows(host, `${host}-other`);
    const refused = r.post(1, 'incomplete', unobserved), terminal = r.terminal(2);
    // A late result of a replaced generation records no verdict: it is the host's own end of that call, never an accept, and settles nothing.
    const late = { ...r.post(3, null, null), matched: false, orphaned: true, job_state: 'present', verdict: undefined, verdict_reason: undefined, task_id: undefined };
    const lateTerminal = r.terminal(4, 'w0', { orphaned: true, accepted: false });
    const elsewhere = [other.post(5, 'accept', null), r.post(6, 'accept', null, { task_id: 'other' })];
    const pending = build([refused, terminal, late, lateTerminal, ...elsewhere]);
    const first = pending.runs.find(x => x.steps.some(s => s.outcome === 'rejected'))!;
    expect(first.state).toBe('attention'); expect(contract(pending, 'rejected')[0]?.impact).toMatchObject({ now: 'unknown', lastState: 'error' });
    // Another refusal of the same task is still about that worker's result, never an ongoing incident.
    const again = build([refused, terminal, r.post(7, 'incomplete', unobserved, { attempt: 2 })]);
    expect(contract(again, 'rejected').map(s => s.impact?.now)).toEqual(['unknown', 'unknown']);
    const retried = build([refused, terminal, late, lateTerminal, ...elsewhere, r.post(8, 'accept', null, { attempt: 2 }), r.terminal(9, 'w8')]);
    const run = retried.runs.find(x => x.id === first.id)!;
    expect(run.state).toBe('past_error'); expect(retried.attention).toBe(0);
    const before = first.steps.find(s => s.outcome === 'rejected')!;
    expect(run.steps.find(s => s.outcome === 'rejected')).toEqual({ ...before, impact: { now: 'later_ok', lastAt: t(8), lastState: 'done' } });
    expect(run.steps.filter(s => s.feature === 'workers' && !s.lifecycle).map(s => s.outcome)).toEqual(['rejected', 'host_ended', 'accepted', 'accepted']);
  });
});
