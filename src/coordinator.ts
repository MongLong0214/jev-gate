import type { DenyReason, Receipt, RoutingMode, Tier } from './types.js';
import { workerReceipt } from './plan.js';

/** Guidance is fixed (D10); worker deliveries append only the shared, screened receipt projection. */
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

/**
 * #356: Gate A cannot tell a long task from its text before any work is done. A root turn that has already made
 * `requests` requests is told once, before its next tool call, that a worker would be cheaper if about as much remains;
 * the root alone knows how much does.
 */
export const renderHandoff = (requests: number, depth: number, breakEven: number): string =>
  `[Jev Gate handoff] Observed in this turn: ${requests} model requests at about ${Math.round(depth / 1000)}K tokens of context, and each further request here re-reads all of it; a jev-gate:worker starts from a small context of its own. By Jev Gate's cost model, handing the rest of this turn to one worker is cheaper when about ${breakEven} or more steps of work remain, and finishing here is cheaper when fewer do. If you hand off, give one worker the whole remainder, not a part of it, and do not change files while it runs. It cannot see this conversation, so its brief carries the goal and the user's constraints, the decisions already made and why, what is done and which files changed, what remains, approaches already tried and their errors, the exact checks to run, and a request for a short report. Pass no model argument. When it returns, check its result against the request before finishing. This note appears once per turn.`;

export const WORKTREE_REMINDER = 'The worker runs in an isolated worktree. Apply only its changes relative to its initial snapshot baseline to the main checkout before final checks and reporting; do not merge the snapshot commit.';

export interface SingleGuidanceOptions {
  workerIsolation?: 'none' | 'worktree';
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
    ...(opts.workerIsolation === 'worktree' ? [WORKTREE_REMINDER] : []),
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
  const format = opts.formatHint ? ` This appears to be a check-command format mismatch for ${bounded(opts.formatHint)}. Run each reported check_id as its own exact Bash command, with no ; echo, pipe, or output suffix. Retry the same worker profile and model; this formatting retry does not use one of the two charged attempts.` : '';
  const handoff =
    opts.rootFallbackReason === 'accepted'
      ? ' The worker actually ended and no owned execution remains active. Continue review, integration and reporting in this session; this is not a claim of complete requirements verification.'
      : '';
  return result + (opts.checks ? ` ${opts.checks}` : '') + handoff + format;
};

export const renderAdhocResult = (verdict: string, reason: string, checks: string): string =>
  `[Jev Gate result] The bounded worker ended with verdict ${verdict}${reason ? ` (${bounded(reason)})` : ''}. Integrate this subtask result in the main session; the overall user request remains yours to complete. ${checks}`;

/** Every owned delivery uses the same functional projection and positional evidence, including legacy replay. */
export const renderWorkerDelivery = (raw: Receipt, opts: { single?: boolean; rootFallback?: boolean; rootFallbackReason?: 'attempt_cap' | 'accepted' } = {}): string => {
  const receipt = workerReceipt(raw), verification = receipt.verification;
  const passed = receipt.reply?.checks.filter(check => check.result === 'pass').length ?? 0;
  const rejected = verification ? [...verification.contradicted, ...verification.stale, ...verification.unobserved] : [];
  const confirmed = verification && verification.transcript !== 'unavailable' && !rejected.includes('unmapped')
    ? receipt.reply?.checks.filter(check => check.result === 'pass' && !rejected.includes(check.check_id)).length ?? 0 : 0;
  const checks = verification
    ? `Check evidence: reported pass ${passed}; confirmed command pass ${confirmed}; transcript ${verification.transcript}; contradicted ${verification.contradicted.length}; stale ${verification.stale.length}; unobserved ${verification.unobserved.length}. Confirmation covers matched command runs and observed edit timing only; this does not establish requirement coverage.`
    : 'Check evidence: observation disabled or unavailable. No verified pass is claimed.';
  const guidance = opts.single
    ? renderSingleResult(receipt.verdict as 'accept' | 'incomplete' | 'unknown' | 'invalid', receipt.verdict_reason ?? '', {
      ...opts, checks, formatHint: receipt.evidence_format_only ? verification?.unobserved.map(id => `check ${id}`).join(', ') || 'reported checks' : '',
    })
    : renderAdhocResult(receipt.verdict, receipt.verdict_reason ?? '', checks);
  const worktree = receipt.worker_worktree;
  const integration = worktree ? `\nWorker worktree: ${worktree.path}\nBranch: ${worktree.branch}\nSnapshot baseline: ${worktree.baseline}. Apply only the diff from this baseline to the worker branch in the root; this result does not integrate it.` : '';
  return `${receipt.reply ? JSON.stringify({ ...receipt.reply, ...(verification ? { verification } : {}) }) : 'No usable worker report.'}\n\n${guidance}${integration}`;
};
