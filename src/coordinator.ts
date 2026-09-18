import type { DenyReason, RoutingMode, Tier } from './types.js';

/** All coordinator text is fixed (D10): it never contains the user's prompt, repository content or a Jev answer's text. */
export const GUIDANCE_HEADER = '[Jev Gate coordinator guidance for this session]';

export const DIRECT_GUIDANCE = [
  'Keep the current request and relevant prior user constraints authoritative.',
  'Complete small self-contained work directly; do not delegate individual file reads.',
  'Delegate a bounded implementation outcome to a jev-gate worker only when it is genuinely separable.',
  'Include the outcome, original restrictions, established interfaces, file locations and requested checks.',
  "Integrate returned results and check the complete user's outcome before claiming success.",
  'Respect explicit models, no-delegation requests, plan mode, permissions and cancellation.',
];

export const DIRECT_MODE_SENTENCE: Record<RoutingMode, string> = {
  native: 'Execution shape: you decide whether this request needs planning or delegation. Jev is not involved.',
  auto: 'Execution shape: direct. This request was admitted as one native conversation; no orchestration state is active.',
};

/** T5: the dispatch sentence states the configured cap, so the guidance can never ask for more workers than will run. */
export const renderDispatchRule = (cap: number): string =>
  cap <= 1
    ? 'Follow the plan: dispatch one ready task at a time and wait for its result. This build runs one worker at a time; a second concurrent dispatch is denied.'
    : `Follow the plan: dispatch a task whose dependencies are already accepted. At most ${cap} workers run at once, so send at most ${cap} ready tasks with disjoint deliverables in one message and hold the rest.`;

export const orchestrationRules = (cap: number): string[] => [
  'You do not implement this request yourself; you coordinate.',
  'Available to you now: Read, Grep, Glob, TodoWrite, and Agent calls to jev-gate:planner and the jev-gate worker roles. Edit, Write, Bash and every other agent (including Explore) are unavailable for this request and will be denied; do not probe them.',
  'Planner first: call jev-gate:planner with no model argument. Give it the exact request, the relevant earlier user constraints, and factual observations about this repository. It is read-only and returns the plan.',
  renderDispatchRule(cap),
  'Each worker prompt starts with the marker [JEV_TASK rev=<n> id=<id>] followed by your own short brief. Do not paste the planner task block: the hook appends the canonical task contract, the global constraints, the required check ids and the predecessor facts.',
  'Never pass a model argument to an owned agent call. Add attempt=<n> to the marker only when you deliberately rework a task that was already dispatched, and only with the next attempt number for that task.',
  'A declared deliverable is the planner\'s claim about what a task writes, not an enforced write boundary; two workers that touch the same file can still collide.',
  'Replan only on a changed interface, a changed dependency, an invalidated task or a major failure, and only after active workers have finished: call the planner again with the concrete violated assumption. A new plan revision starts every task again; results from the previous revision are kept as history, not reused.',
  'Report what was implemented, what was checked, and what was reported but not verified, separately.',
];

export const SUPERSEDED_SENTENCE =
  'A previous Jev Gate job for this session was still unfinished and has been superseded by this request; results from it are not counted toward this plan.';

export const NATIVE_ORCHESTRATION_SENTENCE = 'You decide whether to start planning; no admission decision was made for this request.';

export const renderAdmissionLine = (confidence: number | null): string =>
  `Execution shape: orchestrated${confidence === null ? '' : ` (admission confidence ${confidence.toFixed(2)})`}.`;

export const renderDirectGuidance = (mode: RoutingMode): string => [GUIDANCE_HEADER, ...DIRECT_GUIDANCE, DIRECT_MODE_SENTENCE[mode]].join('\n');

export interface OrchestrationGuidanceOptions {
  mode: RoutingMode;
  confidence: number | null;
  superseded: boolean;
  maxParallelWorkers: number;
}

export const renderOrchestrationGuidance = (opts: OrchestrationGuidanceOptions): string =>
  [
    GUIDANCE_HEADER,
    opts.mode === 'auto' ? renderAdmissionLine(opts.confidence) : NATIVE_ORCHESTRATION_SENTENCE,
    ...orchestrationRules(opts.maxParallelWorkers),
    ...(opts.superseded ? [SUPERSEDED_SENTENCE] : []),
  ].join('\n');

/** A12: the precedence the worker must apply when the sources disagree. */
export const PRECEDENCE_SENTENCE =
  'Precedence: the user restrictions and your native permissions first, then the task contract above, then the predecessor facts reported by earlier workers, then this note.';

export const renderRouteNote = (tier: Tier): string => `\n\n[Jev Gate route note] Tier: ${tier}. The task contract above is authoritative. ${PRECEDENCE_SENTENCE}`;

/** A6: the fixed reason for a root tool that is not on the orchestration allow-list. */
export const GUARD_DENY_REASON =
  'Jev Gate orchestration is active for this request. The main session coordinates; send implementation, shell checks and integration to a planned jev-gate worker task ([JEV_TASK ...]). Nothing was changed by this call.';

export const STOP_REASON =
  'Jev Gate: orchestration blocked. The main session repeatedly tried to implement an admitted compound job directly instead of dispatching planned worker tasks. Nothing further will run for this request. Relaunch with JEV_GATE_MODE=off to work without orchestration.';

const DISPATCH_DENY_TEXT: Record<DenyReason, string> = {
  guard_denied: GUARD_DENY_REASON,
  dispatch_ineligible:
    'This owned agent call cannot be validated as a planned dispatch while orchestration is active. Dispatch a planned task as a foreground call with no resume, team, fork or isolation field, and with a well-formed prompt within the size bound.',
  no_marker: 'This worker prompt has no [JEV_TASK rev=<n> id=<id>] marker on its first line. Dispatch a planned task, or call jev-gate:planner first.',
  unknown_task: 'The marker names a task id that is not in the current plan. Use an id from the current plan revision.',
  stale_rev: 'The marker names an older plan revision. Re-read the current plan revision and dispatch its task ids.',
  deps_incomplete: 'This task still has dependencies without an accepted receipt for the current contract. Dispatch its predecessors first.',
  phase_not_planned: 'No valid plan is active for this request. Call jev-gate:planner and wait for a ready plan before dispatching workers.',
  task_active:
    'This task is already running and its worker was never observed to stop, so a second dispatch of it is refused rather than replacing a live writer. Wait for its result, or cancel it in the session first.',
  task_accepted: 'This task already has an accepted receipt for the current contract. Add attempt=<n> only to deliberately rework it.',
  attempt_mismatch:
    'The attempt number on the marker is not the next attempt this task actually has. attempt=<n> in the text confers nothing on its own; use the number this job has counted, or dispatch without attempt=<n>.',
  dependent_active:
    'A task that depends on this one is running right now, so reworking this one would change the contract underneath it. Let the dependent finish before reworking its predecessor.',
  stale_generation:
    'A newer user request replaced this one while this dispatch was being validated, so it belongs to a plan that is no longer in force. Nothing was run; re-read the current plan and dispatch from it.',
  deliverable_overlap: 'This task writes deliverables that a running task is already writing. Dispatch it after that task finishes.',
  parallel_cap: 'The configured parallel worker limit is already in use. Dispatch this task when one of the running workers finishes.',
  planner_pin_conflict: 'This planner call pins a model that is not one of the configured strong planning models. Remove the model argument, or pin a configured deep/frontier model.',
  planner_active: 'A planner call for this request is already running. Wait for its plan before calling the planner again.',
  workers_active: 'Workers from the current plan are still running. Let them finish before replanning, then call the planner with the concrete violated assumption.',
  bounds_exhausted: 'This job has used its allowed attempts for that step. Report the blocker to the user instead of retrying.',
  composed_too_large: 'The composed task contract exceeds the size bound, so nothing was sent and no constraint was dropped. Ask the planner for a smaller task.',
};

/** Planner-reported text is bounded before it reaches the coordinator; the plugin never forwards unbounded child output. */
const bounded = (detail: string): string => (detail.length > 1000 ? `${detail.slice(0, 1000)}…` : detail);

export const renderDispatchDeny = (reason: DenyReason, detail: string | null = null): string =>
  `${DISPATCH_DENY_TEXT[reason]}${detail ? ` (${bounded(detail)})` : ''} Nothing was changed by this call.`;

/** T5: the dispatch sentence carries the real cap, so the plan context cannot ask for more workers than will be admitted. */
export const renderPlannedContext = (rev: number, readyIds: string[], cap: number): string =>
  `[Jev Gate plan] Revision ${rev} accepted. Ready task ids: ${readyIds.length ? readyIds.join(', ') : 'none'}. ${renderDispatchRule(cap)} Each prompt starts with [JEV_TASK rev=${rev} id=<id>].`;

/** T4: what the pin asked for and what the host reported running are different facts; an unknown id settles neither. */
export const renderPlannerModelNote = (agreement: 'mismatch' | 'unverified'): string =>
  agreement === 'mismatch'
    ? ' The model the host reported for this planner is not the planning profile this job requested, so this plan is not evidence that a strong planner produced it.'
    : ' The host did not report a model this plugin recognizes for this planner, so whether the requested planning profile actually ran is unverified.';

export const renderPlannerProblem = (status: string, detail: string): string =>
  `[Jev Gate plan] The planner returned ${status}; workers cannot be dispatched until a valid plan exists. ${bounded(detail)}`;

/** A failed replan changes nothing: the revision it tried to replace is still the contract in force. */
export const renderReplanProblem = (status: string, detail: string, rev: number): string =>
  `[Jev Gate plan] The replan returned ${status}; plan revision ${rev} stays in force and its ready tasks can still be dispatched. ${bounded(detail)}`;

export const renderWorkerIncomplete = (taskId: string, reason: string): string =>
  `[Jev Gate result] Task ${taskId} is incomplete: ${reason}. Dependent tasks stay locked. Rework it with attempt=<n> on the marker, or replan once no worker is active.`;

/**
 * T10: a malformed report is a reporting failure, not a demonstrated implementation failure. The recovery says so, so
 * a whole implementation is not redone because an id did not match a regular expression.
 */
export const renderWorkerInvalid = (taskId: string, reason: string): string =>
  `[Jev Gate result] Task ${taskId} returned no valid WorkerReply (${bounded(reason)}). This is a report-format failure and says nothing about the code: nothing was accepted, and nothing was shown to be wrong either. Rework it with attempt=<n> on the marker and tell the worker to read the files it already changed, re-run only the checks whose result it cannot confirm, and correct the report to the required check ids. Do not ask it to redo an implementation that was not shown to fail.`;

export const renderWorkerUnknown = (taskId: string): string =>
  `[Jev Gate result] Task ${taskId} did not complete, so no receipt was recorded. Its reservation was released; dispatch it again with attempt=<n> if the work is still needed.`;

/** T11: the worker itself reported the failed required check or the invalidated plan; no second model judged it. */
export const renderWorkerReported = (taskId: string, verdict: 'rework' | 'replan', reason: string): string =>
  verdict === 'rework'
    ? `[Jev Gate result] Task ${taskId} reported a required check as failed (${bounded(reason)}), so dependent tasks stay locked. Rework it with attempt=<n> on the marker.`
    : `[Jev Gate result] Task ${taskId} reported that the plan's assumptions no longer hold (${bounded(reason)}), so dependent tasks stay locked. Replan once no worker is active, with the concrete violated assumption.`;

export const renderWorkerAccepted = (taskId: string, readyIds: string[], cap: number): string =>
  `[Jev Gate result] Task ${taskId} accepted. Ready task ids: ${readyIds.length ? readyIds.join(', ') : 'none'}. ${renderDispatchRule(cap)}`;
