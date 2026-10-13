import type { OperationRun, OperationStep } from './operations.js';

export const failed = (s: OperationStep): boolean => s.state === 'error' || s.model?.status === 'mismatch';
/** A failure needs action until its own request-scoped cause or a later success on the same host settles what it affects
 * now. A failure with no later record stays here, its current impact unknown. */
export const current = (s: OperationStep): boolean => failed(s) && s.impact?.now !== 'later_ok' && s.impact?.now !== 'request_only';

/** An absent receipt is not a failure. An observed error remains visible while other spans run; a settled one stays a past error. */
export const operationState = (steps: readonly OperationStep[]): OperationRun['state'] =>
  steps.some(current) ? 'attention'
    : steps.some(s => s.state === 'active') ? 'active'
      : steps.some(failed) ? 'past_error'
        : steps.some(s => s.state === 'interrupted') ? 'interrupted'
          : steps.some(s => s.state === 'unconfirmed') ? 'unconfirmed' : 'done';
