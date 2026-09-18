import { describe, expect, it } from 'vitest';

import {
  DIRECT_MODE_SENTENCE,
  GUARD_DENY_REASON,
  GUIDANCE_HEADER,
  orchestrationRules,
  PRECEDENCE_SENTENCE,
  renderDirectGuidance,
  renderDispatchDeny,
  renderOrchestrationGuidance,
  renderPlannedContext,
  renderPlannerModelNote,
  renderRouteNote,
  renderWorkerAccepted,
  renderWorkerIncomplete,
  renderWorkerInvalid,
  renderWorkerReported,
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
    const auto = renderOrchestrationGuidance({ mode: 'auto', confidence: 0.91, superseded: false, maxParallelWorkers: 1 });
    for (const rule of orchestrationRules(1)) expect(auto).toContain(rule);
    expect(auto).toContain('Execution shape: orchestrated (admission confidence 0.91)');
    expect(auto.indexOf('Planner first')).toBeLessThan(auto.indexOf('Follow the plan'));
    expect(auto.indexOf('Follow the plan')).toBeLessThan(auto.indexOf('Replan only'));
    expect(auto).not.toContain(SUPERSEDED_SENTENCE);
    const native = renderOrchestrationGuidance({ mode: 'native', confidence: null, superseded: true, maxParallelWorkers: 1 });
    expect(native).toContain('You decide whether to start planning');
    expect(native).not.toContain('admission confidence');
    expect(native).toContain(SUPERSEDED_SENTENCE);
  });

  it('asks for the marker plus a brief rather than a pasted task block, and never pins a model', () => {
    const text = renderOrchestrationGuidance({ mode: 'auto', confidence: 0.9, superseded: false, maxParallelWorkers: 1 });
    expect(text).toContain('[JEV_TASK rev=<n> id=<id>]');
    expect(text).toContain('the hook appends the canonical task contract');
    expect(text).toContain('Never pass a model argument');
    expect(text).toContain('A new plan revision starts every task again');
  });

  /** T5/R07: the guidance can never ask for more concurrent workers than the configured cap will admit. */
  it('R07: states the real concurrency cap and never advertises unbounded parallelism', () => {
    const single = renderOrchestrationGuidance({ mode: 'auto', confidence: null, superseded: false, maxParallelWorkers: 1 });
    expect(single).toContain('dispatch one ready task at a time');
    expect(single).not.toContain('in one message so they run in parallel');
    expect(single).toContain('not an enforced write boundary');
    const three = renderOrchestrationGuidance({ mode: 'auto', confidence: null, superseded: false, maxParallelWorkers: 3 });
    expect(three).toContain('At most 3 workers run at once');
    expect(three).toContain('send at most 3 ready tasks');
    expect(renderPlannedContext(2, ['t1', 't2', 't3', 't4'], 2)).toContain('send at most 2 ready tasks');
    expect(renderWorkerAccepted('t1', ['t2', 't3'], 1)).toContain('dispatch one ready task at a time');
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
    // T1/T2: the new refusals say what actually happened, and never that a live writer was replaced.
    expect(renderDispatchDeny('task_active')).toContain('never observed to stop');
    expect(renderDispatchDeny('attempt_mismatch', 'marker attempt=5, next attempt=2')).toContain('(marker attempt=5, next attempt=2)');
    expect(renderDispatchDeny('dependent_active')).toContain('Let the dependent finish');
    expect(renderDispatchDeny('stale_generation')).toContain('no longer in force');
    expect(renderDispatchDeny('planner_active')).toContain('already running');
    expect(GUARD_DENY_REASON).toContain('Nothing was changed by this call.');
    expect(STOP_REASON).toContain('JEV_GATE_MODE=off');
  });

  it('lists ready ids for the coordinator and reports a worker-reported recovery as locking (T11)', () => {
    expect(renderPlannedContext(2, ['t1', 't2'], 1)).toContain('[JEV_TASK rev=2 id=<id>]');
    expect(renderPlannedContext(1, [], 1)).toContain('none');
    expect(renderWorkerAccepted('t1', ['t2'], 1)).toContain('Ready task ids: t2');
    // T11: the wording attributes the verdict to the worker's own report, not to a second model's judgement.
    expect(renderWorkerReported('t1', 'rework', 'required check c1 reported fail')).toContain('reported a required check as failed');
    expect(renderWorkerReported('t1', 'rework', 'x')).toContain('stay locked');
    expect(renderWorkerReported('t1', 'replan', 'the interface changed')).toContain("plan's assumptions no longer hold");
    expect(renderWorkerReported('t1', 'replan', 'x')).not.toContain('was judged');
    expect(renderWorkerIncomplete('t1', 'required check c1 reported fail')).toContain('Dependent tasks stay locked');
  });

  /** T10/R13: a malformed report is a reporting failure; the recovery says so instead of ordering a rebuild. */
  it('R13: tells an invalid reply to correct the report first and not to redo a working implementation', () => {
    const text = renderWorkerInvalid('t2', 'check_id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$');
    expect(text).toContain('report-format failure');
    expect(text).toContain('read the files it already changed');
    expect(text).toContain('correct the report to the required check ids');
    expect(text).toContain('Do not ask it to redo an implementation that was not shown to fail');
    expect(text).toContain('check_id must match');
  });

  /** T4: what the pin asked for and what the host ran are different facts, and an unknown id settles neither. */
  it('R06: reports an unverified or mismatched planner model instead of claiming a strong planner ran', () => {
    expect(renderPlannerModelNote('mismatch')).toContain('not evidence that a strong planner produced it');
    expect(renderPlannerModelNote('unverified')).toContain('unverified');
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
