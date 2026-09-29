import { describe, expect, it } from 'vitest';

import { buildOperations, type DebugRecord } from '../src/operations.js';

const at = '2026-09-29T06:00:00.000Z';
const later = '2026-09-29T06:00:01.000Z';
const base = { written_at: at, session_id: 's1', prompt_id: 'p1', mode: 'auto', prompt: 'PRIVATE_PROMPT', api_key: 'sk-private-value' };
const row = (component: DebugRecord['component'], rec: Record<string, unknown>, time = at): DebugRecord => ({ at: time, component, rec });

describe('operations display model', () => {
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
    expect(view.runs[0]?.state).toBe('attention');
    expect(view.runs[0]?.steps[0]?.state).toBe('unconfirmed');
    expect(view.features.find((f) => f.id === 'router')?.state).toBe('unavailable');
    expect(JSON.stringify(view)).not.toContain('입력 0');
  });

  it('counts an old attempted result when the intent record is missing', () => {
    const records = [{ ...base, phase: 'admission_result', request_id: 'old', attempted: true, decision: { shape: 'direct' } }];
    const view = buildOperations(records, [], new Date(at), { trace: true, debug: true });
    expect(view.requests).toBe(1);
  });

  it('separates measured Jev response, typed answer and code policy without treating a guard denial as an error', () => {
    const records = [
      { ...base, phase: 'admission_intent', request_id: 'typed' },
      { ...base, written_at: later, phase: 'admission_result', request_id: 'typed', attempted: true,
        http: { duration_ms: 247 }, answers: { need_worker: { noul: 0.81, confidence: 0.72 } },
        decision: { shape: 'orchestrated' } },
      { ...base, written_at: later, phase: 'guard', tool_name: 'Bash', allow: false, denials: 1 },
    ];
    const view = buildOperations(records, [], new Date(later), { trace: true, debug: false });
    const steps = view.runs[0]!.steps;
    const response = steps.find((s) => s.lane === 'jev' && s.durationMs === 247)!;
    expect(response.judgements?.[0]).toMatchObject({ question: 'need_worker', value: '참 확률 81%' });
    expect(response.judgements?.[0]?.probabilities?.[0]).toEqual({ label: '참', value: 0.81 });
    expect(response.judgements?.[0]?.probabilities?.[1]?.value).toBeCloseTo(0.19);
    expect(steps.find((s) => s.lane === 'policy' && s.feature === 'admission')?.summary).toContain('orchestrated');
    expect(steps.find((s) => s.feature === 'guard')?.state).toBe('done');
    expect(view.latency).toMatchObject({ measured: 1, p50: 247, p95: 247 });
  });
});
