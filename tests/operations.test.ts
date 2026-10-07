import { describe, expect, it } from 'vitest';

import { buildOperations, type DebugRecord } from '../src/operations.js';

const at = '2026-09-29T06:00:00.000Z';
const later = '2026-09-29T06:00:01.000Z';
const base = { written_at: at, session_id: 's1', prompt_id: 'p1', mode: 'auto', prompt: 'PRIVATE_PROMPT', api_key: 'sk-private-value' };
const row = (component: DebugRecord['component'], rec: Record<string, unknown>, time = at): DebugRecord => ({ at: time, component, rec });

describe('operations display model', () => {
  it('identifies a request effort mismatch without inventing a response model mismatch', () => {
    const rows = [
      { ...base, host: 'codex', phase: 'codex_route_applied', request_kind: 'root_response', selected_model: 'gpt-6.1-sol', submitted_model: 'gpt-6.1-sol', selected_effort: 'high', submitted_effort: 'xhigh', applied: false },
      { ...base, host: 'codex', prompt_id: 'model', phase: 'codex_route_applied', request_kind: 'root_response', selected_model: 'gpt-6-luna', submitted_model: 'gpt-6.1-sol', selected_effort: 'low', submitted_effort: 'low', applied: false },
      { ...base, host: 'codex', prompt_id: 'legacy', phase: 'codex_route_applied', selected_model: 'gpt-6.1-sol', applied: false },
    ];
    const view = buildOperations(rows, [], new Date(later), { trace: true, debug: false });
    expect(view.feed.find(s => s.issue === 'request_effort')).toMatchObject({ state: 'error', summary: '선택 effort와 API 전송 effort 불일치 · 선택 high · 전송 xhigh', model: { status: 'unobserved', observed: null } });
    expect(view.feed.some(s => s.issue === 'request_model')).toBe(true);
    expect(view.feed.some(s => s.issue === 'request_unconfirmed')).toBe(true);
    expect(view.attention).toBe(2);
  });
  it('keeps legacy request discrepancies unconfirmed when the request purpose was not recorded', () => {
    const view = buildOperations([{ ...base, host: 'codex', phase: 'codex_route_applied', selected_model: 'gpt-6.1-sol', submitted_model: 'gpt-6.1-sol', selected_effort: 'high', submitted_effort: 'xhigh', applied: false }], [], new Date(later), { trace: true, debug: false });
    expect(view.feed[0]).toMatchObject({ state: 'unconfirmed', issue: 'request_unconfirmed', summary: 'API 설정 관측 · 요청 종류 미확인 · gpt-6.1-sol · gpt-6.1-sol · xhigh' });
    expect(view.attention).toBe(0);
  });
  it('shows a proposed effort downgrade held by the cache separately from the final request setting', () => {
    const view = buildOperations([], [row('router', { event: 'root', turn: 'warm', from: { model: 'claude-opus-5-5', effort: 'xhigh' }, proposed_patch: { effort: 'low' }, patch: {}, held_for_cache: 'low', reasons: { model: 'same_value', effort: 'cache_preserved' } })], new Date(later), { trace: false, debug: true });
    expect(view.feed[0]?.details.join(' ')).toContain('캐시 재사용을 위해 effort 유지 · Jev 제안 low · 요청 설정 xhigh');
    expect(view.feed[0]?.model?.forwardedEffort).not.toBe('low');
  });
  it('keeps host dispatch effort, wire request effort and missing response effort as different facts', () => {
    const report = buildOperations([
      { phase: 'codex_router_response', host: 'codex', session_id: 'codex', prompt_id: 'p1', written_at: at, selected_model: 'gpt-6.1-sol', observed_model: 'gpt-6.1-sol', selected_effort: 'low', submitted_effort: 'low', observed_effort: 'unknown' },
    ], [row('router', { event: 'root_result', turn: 't1', requested: 'claude-opus-5-5', requested_effort: 'high', observed: 'claude-opus-5-5', observed_effort: 'unknown', confirmation: 'confirmed' })], new Date(at), { trace: true, debug: true });
    const models = report.runs.flatMap(r => r.steps).filter(s => s.model).map(s => s.model!);
    expect(models).toContainEqual(expect.objectContaining({ effortSource: 'host_hook', forwardedEffort: 'high', observedEffort: null }));
    expect(models).toContainEqual(expect.objectContaining({ effortSource: 'provider_request', forwardedEffort: 'low', observedEffort: null }));
  });
  it('connects background launches, questions and terminals to the original job without treating launch as completion', () => {
    const launch = { ...base, phase: 'background_launch', tool_use_id: 'd', status: 'running' };
    const question = { ...base, phase: 'background_conversation', prompt_id: 'q', execution_prompt_id: 'p1', active: 1 };
    const active = buildOperations([launch, question], [], new Date(later), { trace: true, debug: false });
    expect(active.runs).toHaveLength(1); expect(active.runs[0]?.state).toBe('active');
    expect(active.feed.some(s => s.summary.includes('질문 가능'))).toBe(true);
    const stale = buildOperations([launch], [], new Date(Date.parse(at) + 31_000), { trace: true, debug: false });
    expect(stale.feed[0]?.summary).toBe('시작 기록 있음 · 종료 결과 미관측'); expect(stale.runs[0]?.state).toBe('unconfirmed');
    const terminal = { ...base, written_at: later, phase: 'background_terminal', tool_use_id: 'd', prompt_id: 'q', execution_prompt_id: 'p1', status: 'completed' };
    const done = buildOperations([launch, question, terminal], [], new Date(later), { trace: true, debug: false });
    expect(done.runs).toHaveLength(1); expect(done.runs[0]?.state).toBe('done');
    expect(done.feed.some(s => s.summary.includes('별도 검사'))).toBe(true);
  });
  it('preserves native variant IDs and the Router identity confirmation without reclassifying dated aliases', () => {
    const view = buildOperations([], [
      row('router', { event: 'root_result', turn: 'variant', requested: 'claude-opus-5-5[1m]', observed: 'claude-opus-5-5[1m]', confirmation: 'confirmed' }),
      row('router', { event: 'spawn_result', tool_use_id: 'dated', requested: 'claude-haiku-4-5', observed: 'claude-haiku-4-5-20251001', confirmation: 'confirmed' }),
      row('router', { event: 'root_result', turn: 'mismatch', requested: 'claude-opus-5-5[1m]', observed: 'claude-opus-5-5', confirmation: 'mismatch' }),
    ], new Date(later), { trace: false, debug: true });
    expect(view.feed.find(s => s.model?.selected === 'claude-haiku-4-5')?.model?.status).toBe('confirmed');
    expect(view.feed.filter(s => s.model?.selected === 'claude-opus-5-5[1m]').map(s => s.model?.status).sort()).toEqual(['confirmed', 'mismatch']);
  });
  it('reports a failed Jev Router assessment separately from preserving native execution', () => {
    const view = buildOperations([{ ...base, host: 'codex', phase: 'codex_router_result', attempted: true, ok: false, reason: 'timeout', http: { code: 'timeout', duration_ms: 500 } }], [], new Date(later), { trace: true, debug: false });
    expect(view.runs[0]?.state).toBe('attention');
    expect(view.feed.find(s => s.lane === 'jev')?.state).toBe('error');
    const claude = buildOperations([], [row('router', { event: 'root', turn: 'failed', sent: true, assessment: 'timeout' })], new Date(later), { trace: false, debug: true });
    expect(claude.runs[0]?.state).toBe('attention');
    const gate = buildOperations([{ ...base, phase: 'admission_result', attempted: true, http: { code: 'deadline', duration_ms: 500 }, decision: { shape: 'direct' } }], [], new Date(later), { trace: true, debug: false });
    expect(gate.feed.find(s => s.lane === 'jev')?.state).toBe('error');
  });
  it('does not present a direct turn ending or a planner dispatch as observed worker execution', () => {
    const view = buildOperations([{ ...base, phase: 'stop', outcome: 'completed' }, { ...base, phase: 'dispatch', role: 'planner' }], [], new Date(later), { trace: true, debug: false, host: 'codex' });
    expect(view.features.find(f => f.id === 'workers')).toMatchObject({ count: 0, state: 'waiting' });
    expect(view.features.find(f => f.id === 'planning')).toMatchObject({ count: 1, state: 'observed' });
    expect(view.feed.some(s => s.title === '턴 종료' && s.lifecycle === true)).toBe(true);
  });
  it('exposes the applied admission path even when a Jev result or a local fallback owns it', () => {
    const view = buildOperations([
      { ...base, phase: 'admission_result', attempted: true, decision: { shape: 'direct' } },
      { ...base, prompt_id: 'p2', request_id: 'second', phase: 'admission_result', attempted: false, decision: { shape: 'orchestrated' } },
      { ...base, prompt_id: 'p3', request_id: 'third', phase: 'admission_result', decision: { shape: 'abstain' } },
    ], [], new Date(later), { trace: true, debug: false });
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
      { ...base, phase: 'post', task_id: 't1', verdict: 'accepted', requested_model: 'sonnet', resolved_model: 'claude-sonnet-5', reported_checks: { pass: 1, fail: 0, not_run: 0 } },
      { ...base, phase: 'lean_intent', request_id: 'l1' },
      { ...base, phase: 'lean_result', request_id: 'l1', attempted: true, decision: { action: 'select', retained: 3, omitted: 2 } },
      { ...base, phase: 'lean_dispatch', applied: true, retained_groups: 3, omitted_groups: 2 },
      { written_at: at, phase: 'evidence_start', request_id: 'e1', kind: 'search', mode: 'locate' },
      { written_at: at, phase: 'evidence_jev_intent', request_id: 'e1:1', parent_request_id: 'e1', candidates: 4 },
      { written_at: later, phase: 'evidence_jev_result', request_id: 'e1:1', parent_request_id: 'e1', attempted: true, http: { status: 200 }, jev: { usage: { input_tokens: 20, output_tokens: 3 } } },
      { written_at: later, phase: 'evidence_result', request_id: 'e1', status: 'ok', backend: 'jev', items: 4, remote_calls: 1, cache_hits: 0 },
    ];
    const debug = [
      row('router', { event: 'request', turn: 'r1', sent: true }),
      row('router', { event: 'root', turn: 'r1', sent: true, patch: { effort: 'low' }, applied: { effort: 'low' } }, later),
      row('compact', { event: 'compact', run_id: 'c1', stage: 'started', mode: 'active' }),
      row('compact', { event: 'compact', run_id: 'c1', applied: true, digestChars: 100 }, later),
      row('output', { event: 'output', run_id: 'o1', stage: 'started', parser: 'vitest' }),
      row('output', { event: 'output', run_id: 'o1', applied: true, runs: 1 }, later),
    ];
    const view = buildOperations(records, debug, new Date('2026-09-29T06:00:02.000Z'), { trace: true, debug: true });
    expect(view.features.map((f) => f.id)).toEqual(['admission', 'allocation', 'planning', 'workers', 'guard', 'lean', 'router', 'compact', 'output', 'evidence']);
    expect(view.features.every((f) => f.state === 'observed')).toBe(true);
    expect(view.requests).toBe(5);
    expect(view.runs.map((r) => r.source).sort()).toEqual(['compact', 'evidence', 'gate', 'output', 'router']);
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
    const view = buildOperations(records, [], new Date('2026-09-29T06:01:00.000Z'), { trace: true, debug: false });
    expect(view.requests).toBe(1);
    expect(view.runs[0]?.state).toBe('unconfirmed');
    expect(view.runs[0]?.steps[0]?.state).toBe('unconfirmed');
    expect(view.features.find((f) => f.id === 'router')?.state).toBe('unavailable');
    expect(JSON.stringify(view)).not.toContain('입력 0');
  });

  it('counts an old attempted result when the intent record is missing', () => {
    const records = [{ ...base, phase: 'admission_result', request_id: 'old', attempted: true, decision: { shape: 'direct' } }];
    const view = buildOperations(records, [], new Date(at), { trace: true, debug: true });
    expect(view.requests).toBe(1);
  });

  it('shows actual model mismatch even while another step awaits a response', () => {
    const view = buildOperations([
      { ...base, phase: 'admission_intent', request_id: 'pending' },
      { ...base, phase: 'post', requested_model: 'opus', resolved_model: 'claude-sonnet-5' },
    ], [], new Date(later), { trace: true, debug: false });
    expect(view.runs[0]?.state).toBe('attention');
    expect(view.feed.find(s => s.model)?.state).toBe('error');
  });

  it('uses root_result applied.model as the selected model and keeps missing response evidence unknown', () => {
    const debug = [row('router', { event: 'root_result', turn: 'r', applied: { model: 'sonnet', effort: 'low' }, observed: 'claude-sonnet-5' })];
    const view = buildOperations([], debug, new Date(later), { trace: false, debug: true });
    expect(view.feed[0]?.model).toMatchObject({ selected: 'sonnet', observed: 'claude-sonnet-5', status: 'confirmed', selectedEffort: 'low' });
  });

  it.each(['codex_event', 'guard'])('keeps a Jev judgment visible after a busy %s loop and correlates the known turn', phase => {
    const records: Array<Record<string, unknown>> = [
      { ...base, host: 'codex', phase: 'admission_result', request_id: 'a', attempted: true, decision: { shape: 'direct' } },
      ...Array.from({ length: 200 }, (_, i) => ({ ...base, written_at: later, host: 'codex', phase, event: 'PostToolUse', allow: true, tool_use_id: `c${i}`, invocation_id: `i${i}` })),
    ];
    const view = buildOperations(records, [], new Date(later), { trace: true, debug: false });
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
    const view = buildOperations(records, [], new Date(later), { trace: true, debug: false });
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
  const view = buildOperations([pre, result], [], new Date(at), { trace: true, debug: false });
  const steps = view.runs.flatMap(r => r.steps);
  expect(steps.some(s => s.model?.status === 'mismatch')).toBe(false);
  expect(steps.find(s => s.lane === 'policy')?.summary).toContain(selected);
  expect(steps.find(s => s.model?.status === 'confirmed')?.model).toMatchObject({ selected, observed: selected });
  expect(steps.find(s => s.model?.status === 'unobserved')?.model).toMatchObject({ selected, observed: null, selectedEffort: 'high' });
  const mismatch = buildOperations([pre, { ...result, resolved_model: 'claude-opus-5-5' }], [], new Date(at), { trace: true, debug: false });
  expect(mismatch.feed.some(s => s.model?.status === 'mismatch')).toBe(true);
});


it('links Router keep/change reasons to the exact root response and preserves cache-held effort', () => {
  const decision = { event: 'root', session_id: 's', turn: 't', from: { model: 'claude-opus-5-5', effort: 'xhigh' }, patch: {}, held_for_cache: 'high', reasons: { model: 'same_value', effort: 'cache_preserved' } };
  const response = { event: 'root_result', session_id: 's', turn: 't', requested: 'claude-opus-5-5', requested_effort: 'xhigh', observed: 'claude-opus-5-5', confirmation: 'confirmed', observed_effort: 'unknown' };
  const view = buildOperations([], [row('router', decision), { ...row('router', response), at: later }, { ...row('router', { ...response, session_id: 'other' }), at: later }], new Date(later), { trace: true, debug: true });
  const responses = view.runs.flatMap(r => r.steps).filter(s => s.model);
  expect(responses.filter(s => s.routing)).toHaveLength(1);
  expect(responses.find(s => s.routing)?.routing).toEqual({ scope: 'root', baseline: 'claude-opus-5-5', modelReason: 'same_value', effortReason: 'cache_preserved' });
  expect(responses.find(s => s.routing)?.model).toMatchObject({ selectedEffort: 'xhigh', forwardedEffort: 'xhigh', observedEffort: null });
});

it('identifies Gate-owned spawn and child decisions using recorded tool and agent identities', () => {
  const gate = { ...base, phase: 'pre_result', tool_use_id: 'tool', allocation: { selected_model: 'claude-sonnet-5-5', effort_edit: { kind: 'set', value: 'high' } } };
  const spawn = { event: 'spawn_result', session_id: base.session_id, tool_use_id: 'tool', agent_id: 'child', requested: 'claude-sonnet-5-5', observed: 'claude-sonnet-5-5' };
  const response = { event: 'child_result', session_id: base.session_id, agent_id: 'child', turn: 'ct', requested: 'claude-sonnet-5-5', observed: 'claude-sonnet-5-5' };
  const view = buildOperations([gate], [row('router', spawn), { ...row('router', response), at: later }], new Date(later), { trace: true, debug: true });
  const steps = view.runs.flatMap(r => r.steps);
  expect(steps.find(s => s.title.endsWith('spawn_result'))?.routing).toMatchObject({ scope: 'owned', modelReason: 'gate_allocated' });
  expect(steps.find(s => s.title.endsWith('child_result'))?.routing).toMatchObject({ scope: 'child', modelReason: 'gate_allocated' });
});


it('joins Codex Router reasons to matching provider responses without inferring reported effort', () => {
  const decision = { ...base, host: 'codex', phase: 'codex_router_result', baseline_model: 'gpt-6.1-sol', reasons: { model: 'same_value', effort: 'cache_preserved' } };
  const response = { ...base, host: 'codex', phase: 'codex_router_response', written_at: later, selected_model: 'gpt-6.1-sol', observed_model: 'gpt-6.1-sol', selected_effort: 'high', observed_effort: 'unknown' };
  const view = buildOperations([decision, response, { ...response, session_id: 'other' }], [], new Date(later), { trace: true, debug: false });
  const responses = view.runs.flatMap(r => r.steps).filter(s => s.model?.observed);
  expect(responses.filter(s => s.routing?.modelReason === 'same_value')).toHaveLength(1);
  expect(responses.find(s => s.routing?.modelReason)?.model?.observedEffort).toBeNull();
});

it('shows a rejected Codex model proposal separately from the final model and only on its matching response', () => {
  const decision = { ...base, host: 'codex', phase: 'codex_router_result', baseline_model: 'gpt-6.1-sol',
    reasons: { model: 'low_confidence', effort: 'selected' }, answers: { model: { choice: 'gpt-5.6-terra', probabilities: { 'gpt-5.6-terra': .55 } } }, selection: { probability: .55, threshold: .6 } };
  const response = { ...base, host: 'codex', phase: 'codex_router_response', written_at: later, selected_model: 'gpt-6.1-sol', observed_model: 'gpt-6.1-sol' };
  const steps = buildOperations([decision, response, { ...response, session_id: 'other' }], [], new Date(later), { trace: true, debug: false }).runs.flatMap(r => r.steps);
  const matched = steps.find(s => s.model?.observed && s.routing?.proposedModel);
  expect(matched?.routing).toMatchObject({ baseline: 'gpt-6.1-sol', proposedModel: 'gpt-5.6-terra', probability: .55, threshold: .6 });
  expect(matched?.model?.selected).toBe('gpt-6.1-sol');
  expect(steps.filter(s => s.model?.observed && s.routing?.proposedModel)).toHaveLength(1);
  const invalid = buildOperations([{ ...decision, selection: { probability: 2, threshold: -1 }, answers: { model: { choice: '__keep__' } } }], [], new Date(later), { trace: true, debug: false }).runs.flatMap(r => r.steps);
  expect(invalid[0]?.routing?.proposedModel).toBeUndefined();
});


it('treats prepared as preparation metadata, not a completed host response or a new Jev call', () => {
  const prep = { event: 'prepared', session_id: 's', turn: 't', index: 0, scope: 'root', routed: false, preparation_ms: 2 };
  const view = buildOperations([], [row('router', prep)], new Date(at), { trace: true, debug: true });
  expect(view.requests).toBe(0);
  expect(view.features.find(f => f.id === 'router')?.count).toBe(0);
  expect(view.runs[0]?.steps[0]).toMatchObject({ lifecycle: true, state: 'unconfirmed', title: 'Router · 요청 전달 준비' });
  expect(view.runs[0]?.steps[0]?.summary).toContain('실행 응답 확인은 별도');
  const response = { event: 'root_result', session_id: 's', turn: 't', index: 0, requested: 'claude-opus-5-5', observed: 'claude-opus-5-5' };
  const done = buildOperations([], [row('router', prep), { ...row('router', response), at: later }], new Date(later), { trace: true, debug: true });
  expect(done.runs[0]?.steps.find(s => s.lifecycle)?.state).toBe('done');
});


it('closes historical preparations without an index but never closes a newer request with an earlier response', () => {
  const prep = { event: 'prepared', session_id: 's', turn: 't', scope: 'root' };
  const response = { event: 'root_result', session_id: 's', turn: 't', index: 0, requested: 'opus', observed: 'claude-opus-5-5' };
  const view = buildOperations([], [row('router', prep), { ...row('router', response), at: later }], new Date(later), { trace: true, debug: true });
  expect(view.runs[0]?.steps.find(s => s.lifecycle)?.state).toBe('done');
  const pending = buildOperations([], [row('router', response), { ...row('router', { ...prep, index: 1 }), at: later }], new Date(later), { trace: true, debug: true });
  expect(pending.runs[0]?.steps.find(s => s.lifecycle)?.state).toBe('unconfirmed');
});

it('does not close root or sibling preparations with another agent response in the same turn and loop index', () => {
  const common = { session_id: 's', turn: 't', index: 0 };
  const pending = [
    row('router', { ...common, event: 'prepared', scope: 'root', agent_id: null }),
    row('router', { ...common, event: 'prepared', scope: 'child', agent_id: 'waiting' }),
  ];
  const response = row('router', { ...common, event: 'child_result', agent_id: 'finished', requested: 'sonnet', observed: 'claude-sonnet-5-5' }, later);
  const view = buildOperations([], [...pending, response], new Date(later), { trace: true, debug: true });
  expect(view.runs.flatMap(r => r.steps).filter(s => s.lifecycle).map(s => s.state)).toEqual(['unconfirmed', 'unconfirmed']);
  const matching = row('router', { ...common, event: 'child_result', agent_id: 'waiting', requested: 'sonnet', observed: 'claude-sonnet-5-5' }, later);
  const settled = buildOperations([], [...pending, response, matching], new Date(later), { trace: true, debug: true });
  expect(settled.runs.flatMap(r => r.steps).filter(s => s.lifecycle).map(s => s.state).sort()).toEqual(['done', 'unconfirmed']);
});


it('reports actual Compact Jev calls in both hosts separately from local packing and installation', () => {
  const records = [
    { phase: 'codex_compact', host: 'codex', session_id: 'c', run_id: 'r', stage: 'selected', applied: false, jev_sent: true, jev_ms: 310, candidates: 16, available: 20, dependencies: 1, selection: 'current_dependencies', written_at: at },
    { phase: 'codex_compact', host: 'codex', session_id: 'c', run_id: 'r', stage: 'installed', applied: true, written_at: later },
  ];
  const debug = [row('compact', { event: 'compact', session_id: 's', run_id: 'r', stage: 'jev', jev_sent: true, jev_ms: 220, candidates: 4, available: 4, dependencies: 1, selection: 'current_dependencies' }), row('compact', { event: 'compact', session_id: 's', run_id: 'r', applied: true }, later)];
  const view = buildOperations(records, debug, new Date(later), { trace: true, debug: true });
  expect(view.requests).toBe(2); expect(view.latency.measured).toBe(2);
  expect(view.feed.filter(s => s.lane === 'jev')).toHaveLength(2);
  expect(view.feed.some(s => s.summary.includes('Jev 작업 의존 근거 선택'))).toBe(true);
  expect(view.feed.find(s => s.lane === 'host')?.summary).toContain('설치 확인');
});


it('shows a forwarded native Compact request without a Router mismatch or claimed digest installation', () => {
  const view = buildOperations([{ phase: 'codex_compact', host: 'codex', session_id: 'c', run_id: 'n', stage: 'native_submitted', applied: false, summarizer_request: true, submitted_model: 'gpt-6.1-sol', submitted_effort: 'xhigh', written_at: at }], [], new Date(later), { trace: true, debug: false, host: 'codex' });
  expect(view.feed).toHaveLength(1);
  expect(view.feed[0]).toMatchObject({ feature: 'compact', lane: 'host', state: 'unconfirmed', summary: expect.stringContaining('호스트 요약 모델') });
  expect(view.feed[0]?.issue).toBeUndefined();
  expect(view.feed[0]?.details.join(' ')).toContain('설치 미관측');
});


describe('actual model request lifecycle', () => {
  it('keeps a slow request active and matches response by session, turn, agent and loop index', () => {
    const request={session_id:'s',turn:'t',index:2,event:'model_request',requested:'claude-opus-5-5'};
    const now=new Date('2026-09-29T06:02:00.000Z');
    const build=(extra:DebugRecord[]=[])=>buildOperations([], [row('router',request),...extra],now,{trace:false,debug:true});
    expect(build().feed.find(s=>s.lifecycle)).toMatchObject({state:'active',elapsedMs:120000});
    expect(build([row('router',{...request,index:1,event:'root_result'},later)]).feed.find(s=>s.title==='모델 · 응답 대기')?.state).toBe('active');
    expect(build([row('router',{...request,event:'root_result',observed:'claude-opus-5-5'},later)]).feed.find(s=>s.title==='모델 · 응답 대기')?.state).toBe('done');
    const failed=build([row('router',{...request,event:'model_failure'},later)]);
    expect(failed.feed.find(s=>s.title==='모델 · 응답 대기')?.state).toBe('done');
    expect(failed.feed.find(s=>s.title==='모델 · 요청 실패')?.state).toBe('error');
  });
});


it('shows Codex model requests in flight even when Router preserves the baseline', () => {
  const req={...base,host:'codex',phase:'codex_model_request',request_id:'model-1',submitted_model:'gpt-6.1-sol'};
  const now=new Date('2026-09-29T06:02:00.000Z');
  const view=buildOperations([req],[],now,{trace:true,debug:false});
  expect(view.feed[0]).toMatchObject({state:'active',lifecycle:true,elapsedMs:120000,title:'모델 · 응답 대기'});
  const ended=buildOperations([req,{...base,written_at:later,host:'codex',phase:'codex_model_failure',request_id:'model-1'}],[],now,{trace:true,debug:false});
  expect(ended.feed.find(s=>s.title==='모델 · 응답 대기')?.state).toBe('done');
  expect(ended.feed.find(s=>s.title==='모델 · 요청 실패')?.state).toBe('error');
});

it('does not terminate a Codex request from an earlier result or another session or prompt', () => {
  const req={...base,written_at:later,host:'codex',phase:'codex_model_request',request_id:'model-1'};
  const failure={...req,written_at:'2026-09-29T06:00:02.000Z',phase:'codex_model_failure'};
  const build=(record:Record<string,unknown>)=>buildOperations([req,record],[],new Date('2026-09-29T06:02:00.000Z'),{trace:true,debug:false}).feed.find(s=>s.title==='모델 · 응답 대기')!;
  for(const record of [{...failure,session_id:'other'},{...failure,prompt_id:'other'},{...failure,written_at:at}])expect(build(record).state).toBe('active');
  expect(build(failure).state).toBe('done');
});


it('confirms Codex request settings separately and joins only the exact observed response', () => {
  const req={...base,host:'codex',phase:'codex_route_applied',request_id:'req',request_kind:'root_response',selected_model:'gpt-6-luna',submitted_model:'gpt-6-luna',selected_effort:'low',submitted_effort:'low',applied:true};
  const response={...base,written_at:later,host:'codex',phase:'codex_router_response',request_id:'req',selected_model:'gpt-6-luna',observed_model:'gpt-6-luna'};
  const build=(records:Record<string,unknown>[])=>buildOperations(records,[],new Date(later),{trace:true,debug:false}).feed.find(s=>s.title==='Router · Codex 요청 전송')!;
  expect(build([req]).model).toMatchObject({requestApplied:true,status:'unobserved',observed:null});
  expect(build([req,response]).model).toMatchObject({requestApplied:true,status:'confirmed',observed:'gpt-6-luna'});
  expect(build([req,{...response,session_id:'other'}]).model?.status).toBe('unobserved');
});
