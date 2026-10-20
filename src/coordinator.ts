import type { DenyReason, RoutingMode, Tier } from './types.js';

/** All coordinator text is fixed (D10): it never contains the user's prompt, repository content or a Jev answer's text. */
export const GUIDANCE_HEADER = '[Jev Gate coordinator guidance for this session]';

/**
 * Every root turn re-reads the whole session, so the saving of a delegated turn is the root turns it removes. The
 * jev_single bench took 11-17 root turns; reading the repository before dispatch is what the worker is there to do.
 */
export const DISPATCH_FIRST_SENTENCE =
  'Dispatch first: do not read or search the repository before the dispatch. Every turn you take re-reads this whole session, and the worker reads what it needs in its own context.';

export const BACKGROUND_GUIDANCE = 'Owned executions run in the background by default. Answer new user messages in the main conversation while they work. A launch receipt is not completion: accept only the original contract result after native terminal evidence. Do not duplicate active work or edit its files. Explicit user cancellation remains authoritative.';

/**
 * A19: the single-executor shape, the only one an admitted turn runs since the planner was removed (#289): the depth
 * reader, Gate A, Gate B's tier choice and one worker.
 */
export const singleRules = (preferFastWorker = false): string[] => [
  'You do not implement this request yourself; you coordinate.',
  BACKGROUND_GUIDANCE,
  `Dispatch this request once, whole, to ${preferFastWorker ? 'jev-gate:worker-fast' : 'jev-gate:worker'}. Do not split it across several workers.`,
  DISPATCH_FIRST_SENTENCE,
  'Your brief does not have to restate the request: the hook appends the user\'s own request verbatim, and the worker is told it is the task.',
  'Never pass a model argument to an owned agent call.',
  'If the worker comes back incomplete or wrong, say so and dispatch it again with what was wrong.',
  'Report what was implemented, what was checked, and what was reported but not verified, separately.',
];

export interface SingleGuidanceOptions {
  preferFastWorker?: boolean;
  mode: RoutingMode;
  confidence: number | null;
  superseded: boolean;
}

export const renderSingleGuidance = (opts: SingleGuidanceOptions): string =>
  [
    GUIDANCE_HEADER,
    opts.mode === 'auto' ? renderAdmissionLine(opts.confidence) : NATIVE_ORCHESTRATION_SENTENCE,
    ...singleRules(opts.preferFastWorker),
    ...(opts.superseded ? [SUPERSEDED_SENTENCE] : []),
  ].join('\n');

export const SUPERSEDED_SENTENCE =
  'A previous Jev Gate job for this session was still unfinished and has been superseded by this request; results from it are not counted toward this job.';

export const NATIVE_ORCHESTRATION_SENTENCE = 'You decide whether to dispatch; no admission decision was made for this request.';

export const renderAdmissionLine = (confidence: number | null): string =>
  `Execution shape: orchestrated${confidence === null ? '' : ` (admission confidence ${confidence.toFixed(2)})`}.`;

/** A12/A19: the precedence a worker must apply when the sources disagree. The single shape carries the request block. */
export const renderSingleRouteNote = (tier: Tier): string =>
  `\n\n[Jev Gate route note] Tier: ${tier}. Precedence: the user restrictions and your native permissions first, then the "[Jev Gate user request]" block above, then this note.`;

export const renderRouteNote = (tier: Tier): string =>
  `\n\n[Jev Gate route note] Tier: ${tier}. Precedence: the user restrictions and your native permissions first, then this note.`;

const DISPATCH_DENY_TEXT: Record<DenyReason, string> = {
  dispatch_ineligible:
    'This owned agent call cannot be validated while orchestration is active. Dispatch the worker as a background call with no resume, team, fork or isolation field, and with a well-formed prompt within the size bound.',
  task_active:
    'This task is already running and its worker was never observed to stop, so a second dispatch of it is refused rather than replacing a live writer. Wait for its result, or cancel it in the session first.',
  attempt_mismatch: 'This dispatch is not the retry this job expects. Retry with the worker profile and model it names.',
  stale_generation:
    'A newer user request replaced this one while this dispatch was being validated, so it belongs to a job that is no longer in force. Nothing was run; dispatch from the current request.',
  bounds_exhausted: 'This job has used its allowed attempts for that step. Report the blocker to the user instead of retrying.',
};

/** Worker-reported text is bounded before it reaches the coordinator; the plugin never forwards unbounded child output. */
const bounded = (detail: string): string => (detail.length > 1000 ? `${detail.slice(0, 1000)}…` : detail);

export const renderDispatchDeny = (reason: DenyReason, detail: string | null = null): string =>
  `${DISPATCH_DENY_TEXT[reason]}${detail ? ` (${bounded(detail)})` : ''} Nothing was changed by this call.`;

/**
 * A19: the single shape has no contract, so its result line says what was and was not established. An accept here is
 * the worker's own report and the checks the transcript confirmed, and the coordinator is told so.
 */
export const renderSingleResult = (
  verdict: 'accept' | 'incomplete' | 'unknown' | 'invalid',
  reason: string,
  opts: { formatHint?: string; rootFallback?: boolean; rootFallbackReason?: 'attempt_cap' | 'accepted'; checks?: string } = {},
): string => {
  if (opts.rootFallback && opts.rootFallbackReason !== 'accepted') {
    return `[Jev Gate result] The single-worker attempt limit is reached (${bounded(reason)}). Finish the remaining work in this session, run checks you can execute, and identify anything still unverified.${opts.checks ? ` ${opts.checks}` : ''}`;
  }
  const result =
    verdict === 'accept'
      ? '[Jev Gate result] The worker reported done with no blockers. Compare its result and observed checks with the user request. Do not spawn another worker or rerun identical checks merely to restate the same evidence on the same state. Check only missing requirements, contradictions, new edits or integration differences; an observed command pass does not prove complete requirement coverage. Report observed checks separately from the worker report.'
      : verdict === 'unknown'
        ? `[Jev Gate result] The single-executor dispatch returned no usable reply (${bounded(reason)}). Its reservation was released; dispatch the request again if the work is still needed.`
        : verdict === 'invalid'
          ? `[Jev Gate result] The single-executor dispatch replied in a shape this plugin could not read (${bounded(reason)}). Nothing about the work is settled; dispatch it again or finish it another way.`
          : `[Jev Gate result] The single-executor dispatch reported that it did not finish (${bounded(reason)}). Dispatch it again with what was wrong.`;
  const format = opts.formatHint ? ` This appears to be a check-command format mismatch. Closest executed command per unmatched check: ${bounded(opts.formatHint)}. Run each reported check_id as its own exact Bash command, with no ; echo, pipe, or output suffix. Retry the same worker profile and model; this formatting retry does not use one of the two charged attempts.` : '';
  const handoff =
    opts.rootFallbackReason === 'accepted'
      ? ' The worker actually ended and no Agent remains active. Continue review, integration and reporting in this session; this is not a claim of complete requirements verification.'
      : '';
  return result + (opts.checks ? ` ${opts.checks}` : '') + handoff + format;
};

export const renderAdhocResult = (verdict: string, reason: string, checks: string): string =>
  `[Jev Gate result] The bounded worker ended with verdict ${verdict}${reason ? ` (${bounded(reason)})` : ''}. Integrate this subtask result in the main session; the overall user request remains yours to complete. ${checks}`;
