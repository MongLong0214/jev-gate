import type { Mode } from './types.js';

/** #12 shared coordinator substance. Fixed text; never includes the user's prompt; no Jev request. */
export const COMMON_GUIDANCE = [
  'Keep the current request and relevant prior user constraints authoritative.',
  'Complete small self-contained work directly; do not delegate individual file reads.',
  'For compound work, form coherent outcomes with explicit interfaces and checks.',
  'Use jev-gate:planner only for a concrete planning uncertainty; it is read-only.',
  'Delegate ready implementation outcomes to jev-gate:worker.',
  'Include the outcome, relevant original restrictions, established interfaces,',
  'observed predecessor results, file locations, requested checks, and unresolved assumptions.',
  'Issue one foreground Agent call at a time with run_in_background:false and no teammate name.',
  'Do not edit concurrently with the worker or duplicate the same investigation first.',
  "Integrate returned results and check the complete user's outcome before claiming success.",
  "A plan or a worker's completion statement is not final acceptance.",
  'Respect explicit models, no-delegation requests, plan mode, permissions, and cancellation.',
];

export const ALLOCATION_SENTENCE: Record<Exclude<Mode, 'off'>, string> = {
  native: 'Model allocation: choose a suitable available per-call model when useful; otherwise the role\'s native default applies. Jev is not involved.',
  auto: 'Model allocation: omit model for automatic owned-role calls; a deliberate caller pin bypasses the gate. Use an explicit model to honor a user selection or a reasoned exception, not merely out of habit.',
};

/**
 * Renders the UserPromptSubmit guidance for native/auto. `experimentalAllocation` is the benchmark's fixed-role control
 * (#17): it replaces only the allocation sentence, only in native mode, and is recorded in the run. It is not a product mode.
 */
export const renderCoordinatorGuidance = (mode: Exclude<Mode, 'off'>, experimentalAllocation?: string): string => {
  const allocation = mode === 'native' && experimentalAllocation ? `Model allocation (experimental control): ${experimentalAllocation}` : ALLOCATION_SENTENCE[mode];
  return ['[Jev Gate coordinator guidance for this session]', ...COMMON_GUIDANCE, allocation].join('\n');
};
