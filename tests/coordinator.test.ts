import { describe, expect, it } from 'vitest';

import {
  singleRules,
  DIRECT_MODE_SENTENCE,
  GUIDANCE_HEADER,
  renderDirectGuidance,
  renderDispatchDeny,
  renderRouteNote,
  renderSingleRouteNote,
  renderSingleGuidance,
  renderSingleResult,
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

  it('renders the single-worker rules with the admission line only in auto', () => {
    const auto = renderSingleGuidance({ mode: 'auto', confidence: 0.91, superseded: false });
    for (const rule of singleRules()) expect(auto).toContain(rule);
    expect(auto).toContain('Execution shape: orchestrated (admission confidence 0.91)');
    expect(auto).toContain('Dispatch this request once, whole, to jev-gate:worker.');
    expect(auto).toContain('Never pass a model argument');
    expect(auto).not.toContain(SUPERSEDED_SENTENCE);
    expect(renderSingleGuidance({ mode: 'auto', confidence: null, superseded: false, preferFastWorker: true })).toContain('to jev-gate:worker-fast.');
    const native = renderSingleGuidance({ mode: 'native', confidence: null, superseded: true });
    expect(native).toContain('You decide whether to dispatch');
    expect(native).not.toContain('admission confidence');
    expect(native).toContain(SUPERSEDED_SENTENCE);
  });

  /** #289: the planner and the root tool guard are gone, so no guidance names either. */
  it('never mentions a planner, a plan revision or a root tool guard', () => {
    for (const text of [
      renderSingleGuidance({ mode: 'auto', confidence: 0.9, superseded: true }),
      renderSingleGuidance({ mode: 'native', confidence: null, superseded: false }),
      renderDirectGuidance('auto'),
      renderDirectGuidance('native', true),
    ]) {
      expect(text).not.toMatch(/planner|JEV_TASK|root guard|guard denies|denies root/i);
    }
  });
});

describe('fixed reasons', () => {
  it('states the precedence in the route note and keeps the deny reasons actionable', () => {
    const note = renderRouteNote('deep');
    expect(note).toContain('Tier: deep');
    expect(note).toContain('Precedence: the user restrictions and your native permissions first, then this note.');
    // #289: no dispatch carries a contract or predecessor facts, so neither note names them.
    for (const n of [note, renderSingleRouteNote('deep')]) expect(n).not.toMatch(/contract|predecessor/);
    expect(renderSingleRouteNote('deep')).toContain('then the "[Jev Gate user request]" block above, then this note.');
    expect(note.startsWith('\n\n')).toBe(true);
    // T1/T2: the refusals say what actually happened, and never that a live writer was replaced.
    expect(renderDispatchDeny('task_active')).toContain('never observed to stop');
    expect(renderDispatchDeny('attempt_mismatch', 'marker attempt=5, next attempt=2')).toContain('(marker attempt=5, next attempt=2)');
    expect(renderDispatchDeny('stale_generation')).toContain('no longer in force');
    expect(renderDispatchDeny('bounds_exhausted')).toContain('Nothing was changed by this call.');
  });

  it('says what an accepted single result does and does not establish', () => {
    const accepted = renderSingleResult('accept', '', { rootFallback: true, rootFallbackReason: 'accepted' });
    expect(accepted).toContain('The worker reported done with no blockers');
    expect(accepted).toContain('not a claim of complete requirements verification');
    expect(renderSingleResult('incomplete', 'worker reported status blocked')).toContain('Dispatch it again with what was wrong.');
    expect(renderSingleResult('incomplete', 'x', { rootFallback: true, rootFallbackReason: 'attempt_cap' })).toContain('Finish the remaining work in this session');
  });
});

describe('renderDispatchDeny (review P2: bounded detail)', () => {
  it('bounds detail so an oversized value cannot be echoed verbatim', () => {
    const huge = 'x'.repeat(8 * 1024);
    const text = renderDispatchDeny('dispatch_ineligible', huge);
    expect(text.length).toBeLessThan(1500);
    expect(text).toContain('…');
    expect(text).not.toContain(huge);
    expect(renderDispatchDeny('dispatch_ineligible', 'malformed_input')).toContain('(malformed_input)');
  });
});
