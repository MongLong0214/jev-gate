import { describe, expect, it } from 'vitest';

import { buildAdmissionRequest, decideAdmission, EXECUTION_QUESTION } from '../src/admission.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ADMISSION_ANSWERS, type AdmissionAnswer } from '../src/types.js';

const choice = (winner: AdmissionAnswer, p = 0.9, confidence = p): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: Object.fromEntries(ADMISSION_ANSWERS.map((k) => [k, k === winner ? p : (1 - p) / (ADMISSION_ANSWERS.length - 1)])),
  confidence,
});

describe('buildAdmissionRequest', () => {
  it('sends the raw request, the two available shapes and exactly one question', () => {
    const request = buildAdmissionRequest('Build a settings page and migrate the store.', { ...DEFAULT_CONFIG, jevModel: 'jev-x' });
    expect(request.model).toBe('jev-x');
    expect(request.state.request).toBe('Build a settings page and migrate the store.');
    expect(Object.keys(request.state.available_execution)).toEqual(['direct', 'orchestrated']);
    expect(Object.keys(request.questions)).toEqual(['execution']);
    expect(Object.keys(EXECUTION_QUESTION.criteria)).toEqual([...ADMISSION_ANSWERS]);
    expect(EXECUTION_QUESTION.instructions).toContain('Orchestration has planning and handoff costs');
    expect(EXECUTION_QUESTION.instructions).toContain('Respect explicit requests not to delegate');
    expect(JSON.stringify(request)).not.toContain('claude');
  });
});

describe('decideAdmission', () => {
  it('admits a confident orchestrated answer', () => {
    expect(decideAdmission({ execution: choice('orchestrated') }, 0.8)).toMatchObject({ shape: 'orchestrated', decided: true, reason: null });
  });

  it('keeps direct for a confident direct answer', () => {
    expect(decideAdmission({ execution: choice('direct') }, 0.8)).toMatchObject({ shape: 'direct', decided: true, reason: null });
  });

  it.each([
    ['an invalid answer', { execution: { type: 'choice', choice: 'orchestrated' } }, 'admission_invalid'],
    ['a missing answer', {}, 'admission_invalid'],
    [
      'a tie',
      {
        execution: { type: 'choice', choice: 'orchestrated', probabilities: { direct: 0.45, orchestrated: 0.45, needs_context: 0.05, abstain: 0.05 }, confidence: 0.95 },
      },
      'admission_tie',
    ],
    ['needs_context', { execution: choice('needs_context') }, 'admission_needs_context'],
    ['abstain', { execution: choice('abstain') }, 'admission_abstain'],
    ['low confidence', { execution: choice('orchestrated', 0.82, 0.77) }, 'admission_low_confidence'],
  ])('falls back to direct on %s', (_name, answers, reason) => {
    expect(decideAdmission(answers, 0.8)).toMatchObject({ shape: 'direct', decided: false, reason });
  });
});
