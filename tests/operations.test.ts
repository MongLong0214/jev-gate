import { describe, expect, it } from 'vitest';

import { buildOperations, type DebugRecord } from '../src/operations.js';

const at = '2026-09-29T06:00:00.000Z';
const later = '2026-09-29T06:00:01.000Z';
const base = { written_at: at, session_id: 's1', prompt_id: 'p1', mode: 'auto', prompt: 'PRIVATE_PROMPT', api_key: 'sk-private-value' };
const row = (component: DebugRecord['component'], rec: Record<string, unknown>, time = at): DebugRecord => ({ at: time, component, rec });

describe('operations display model', () => {
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
