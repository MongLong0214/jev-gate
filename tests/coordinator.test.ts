import { describe, expect, it } from 'vitest';

import { ALLOCATION_SENTENCE, COMMON_GUIDANCE, renderCoordinatorGuidance } from '../src/coordinator.js';

describe('renderCoordinatorGuidance', () => {
  it('renders the shared substance plus the mode sentence and never echoes a user prompt', () => {
    const auto = renderCoordinatorGuidance('auto');
    const native = renderCoordinatorGuidance('native');
    for (const line of COMMON_GUIDANCE) {
      expect(auto).toContain(line);
      expect(native).toContain(line);
    }
    expect(auto).toContain(ALLOCATION_SENTENCE.auto);
    expect(native).toContain(ALLOCATION_SENTENCE.native);
    expect(auto).not.toContain(ALLOCATION_SENTENCE.native);
    expect(auto).toContain('jev-gate:worker');
    expect(auto).toContain('jev-gate:planner');
    expect(auto).toContain('run_in_background:false');
  });

  it('applies the experimental allocation control only in native mode', () => {
    const fixed = renderCoordinatorGuidance('native', 'use each role default');
    expect(fixed).toContain('Model allocation (experimental control): use each role default');
    expect(fixed).not.toContain(ALLOCATION_SENTENCE.native);
    expect(renderCoordinatorGuidance('auto', 'use each role default')).toContain(ALLOCATION_SENTENCE.auto);
  });
});
