import type { OperationRun, OperationStep } from './operations.js';

/** An absent receipt is not a failure. An observed error remains visible while other spans run. */
export const operationState = (steps: readonly OperationStep[]): OperationRun['state'] =>
  steps.some(s => s.state === 'error' || s.model?.status === 'mismatch') ? 'attention'
    : steps.some(s => s.state === 'active') ? 'active'
      : steps.some(s => s.state === 'interrupted') ? 'interrupted'
        : steps.some(s => s.state === 'unconfirmed') ? 'unconfirmed' : 'done';
