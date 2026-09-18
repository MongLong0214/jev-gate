import { describe, expect, it } from 'vitest';

import {
  DIRECT_MODE_SENTENCE,
  GUARD_DENY_REASON,
  GUIDANCE_HEADER,
  ORCHESTRATION_RULES,
  PRECEDENCE_SENTENCE,
  renderDirectGuidance,
  renderDispatchDeny,
  renderOrchestrationGuidance,
  renderPlannedContext,
  renderRouteNote,
  renderWorkerAccepted,
  renderWorkerIncomplete,
  STOP_REASON,
  SUPERSEDED_SENTENCE,
} from '../src/coordinator.js';

describe('guidance', () => {
  it('renders direct guidance per mode without any orchestration rule', () => {
    const auto = renderDirectGuidance('auto');
    expect(auto).toContain(GUIDANCE_HEADER);
    expect(auto).toContain(DIRECT_MODE_SENTENCE.auto);
    expect(auto).not.toContain('you coordinate');
    expect(renderDirectGuidance('native')).toContain(DIRECT_MODE_SENTENCE.native);
  });

  it('renders the orchestration rules in order with the admission line only in auto', () => {
    const auto = renderOrchestrationGuidance({ mode: 'auto', confidence: 0.91, superseded: false });
    for (const rule of ORCHESTRATION_RULES) expect(auto).toContain(rule);
    expect(auto).toContain('Execution shape: orchestrated (admission confidence 0.91)');
    expect(auto.indexOf('Planner first')).toBeLessThan(auto.indexOf('Follow the plan'));
    expect(auto.indexOf('Follow the plan')).toBeLessThan(auto.indexOf('Replan only'));
    expect(auto).not.toContain(SUPERSEDED_SENTENCE);
    const native = renderOrchestrationGuidance({ mode: 'native', confidence: null, superseded: true });
    expect(native).toContain('You decide whether to start planning');
    expect(native).not.toContain('admission confidence');
    expect(native).toContain(SUPERSEDED_SENTENCE);
  });

  it('asks for the marker plus a brief rather than a pasted task block, and never pins a model', () => {
    const text = renderOrchestrationGuidance({ mode: 'auto', confidence: 0.9, superseded: false });
    expect(text).toContain('[JEV_TASK rev=<n> id=<id>]');
    expect(text).toContain('the hook appends the canonical task contract');
    expect(text).toContain('Never pass a model argument');
    expect(text).toContain('in one message so they run in parallel');
  });
});

describe('fixed reasons', () => {
  it('states the precedence in the route note and keeps the deny reasons actionable', () => {
    const note = renderRouteNote('deep');
    expect(note).toContain('Tier: deep');
    expect(note).toContain(PRECEDENCE_SENTENCE);
    expect(note.startsWith('\n\n')).toBe(true);
    expect(renderDispatchDeny('no_marker')).toContain('[JEV_TASK rev=<n> id=<id>]');
    expect(renderDispatchDeny('stale_rev', 'marker rev=1, current rev=2')).toContain('(marker rev=1, current rev=2)');
    expect(renderDispatchDeny('planner_pin_conflict')).toContain('strong planning models');
    expect(renderDispatchDeny('composed_too_large')).toContain('no constraint was dropped');
    expect(GUARD_DENY_REASON).toContain('Nothing was changed by this call.');
    expect(STOP_REASON).toContain('JEV_GATE_MODE=off');
  });

  it('lists ready ids for the coordinator and separates an advisory hint from readiness', () => {
    expect(renderPlannedContext(2, ['t1', 't2'])).toContain('[JEV_TASK rev=2 id=<id>]');
    expect(renderPlannedContext(1, [])).toContain('none');
    expect(renderWorkerAccepted('t1', ['t2'], 'rework')).toContain('Advisory (does not change readiness): rework');
    expect(renderWorkerAccepted('t1', ['t2'], null)).not.toContain('Advisory');
    expect(renderWorkerIncomplete('t1', 'required check c1 reported fail')).toContain('Dependent tasks stay locked');
  });
});

describe('renderDispatchDeny (review P2: bounded detail)', () => {
  it('bounds planner-authored detail so an oversized deliverable cannot be echoed verbatim', () => {
    const huge = 'x'.repeat(8 * 1024);
    const text = renderDispatchDeny('deliverable_overlap', huge);
    expect(text.length).toBeLessThan(1500);
    expect(text).toContain('…');
    expect(text).not.toContain(huge);
    expect(renderDispatchDeny('deliverable_overlap', 'src/a.js')).toContain('(src/a.js)');
  });
});
