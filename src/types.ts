/** V5 shared types (ADR #22 r1 + r2 amendments). V4 prompt-block and task-decision types were removed with the V4 runtime. */

export type Tier = 'fast' | 'standard' | 'deep' | 'frontier';
export type Mode = 'off' | 'native' | 'auto';
/** The two modes that reach V5 routing; routing-only types name these instead of excluding 'off'. */
export type RoutingMode = 'native' | 'auto';
export type OwnedRole = 'worker';
export type ExecutionShape = 'direct' | 'orchestrated';
export type RouteQuestionShape = 'composite' | 'atomic';
/** Gate A asks the same way Gate B does, and the two are configured independently. */
export type AdmissionQuestionShape = RouteQuestionShape;
export const ROUTE_QUESTION_SHAPES: readonly RouteQuestionShape[] = ['composite', 'atomic'];

export type WorkerIsolation = 'none' | 'worktree';
export const WORKER_ISOLATIONS: readonly WorkerIsolation[] = ['none', 'worktree'];

export type AdmissionAnswer = 'direct' | 'orchestrated' | 'needs_context' | 'abstain';
export type RouteAnswer = Tier | 'abstain';
export type UpgradeBasis = 'unresolved_contract_reasoning' | 'observed_reasoning_failure' | 'no_specific_basis' | 'unknown';

export const TIERS: readonly Tier[] = ['fast', 'standard', 'deep', 'frontier'];
export const MODES: readonly Mode[] = ['off', 'native', 'auto'];
export const ADMISSION_ANSWERS: readonly AdmissionAnswer[] = ['direct', 'orchestrated', 'needs_context', 'abstain'];
export const ROUTE_ANSWERS: readonly RouteAnswer[] = ['fast', 'standard', 'deep', 'frontier', 'abstain'];
export const UPGRADE_BASES: readonly UpgradeBasis[] = ['unresolved_contract_reasoning', 'observed_reasoning_failure', 'no_specific_basis', 'unknown'];
/** The two bases that can justify an above-default worker (#27); the other two never can. */
export const UPGRADE_BASES_SUFFICIENT: readonly UpgradeBasis[] = ['unresolved_contract_reasoning', 'observed_reasoning_failure'];

export interface OwnedAgent {
  role: OwnedRole;
  tier: Tier;
}

/** Scoped agent names as the host discovers them from this plugin; one definition per abstract tier (D3). */
export const OWNED_AGENTS: Record<string, OwnedAgent> = {
  'jev-gate:worker-fast': { role: 'worker', tier: 'fast' },
  'jev-gate:worker': { role: 'worker', tier: 'standard' },
  'jev-gate:worker-deep': { role: 'worker', tier: 'deep' },
  'jev-gate:worker-frontier': { role: 'worker', tier: 'frontier' },
};

export const OWNED_AGENT_NAMES: readonly string[] = Object.keys(OWNED_AGENTS);

export const agentForTier = (role: OwnedRole, tier: Tier): string => {
  const found = OWNED_AGENT_NAMES.find((name) => OWNED_AGENTS[name]?.role === role && OWNED_AGENTS[name]?.tier === tier);
  return found ?? 'jev-gate:worker';
};

export interface ConfigV5 {
  /** Opt in to host-supported frontier targets across Router and owned dispatches. */
  frontierEnabled: boolean;
  version: 5;
  mode: Mode;
  jevModel: string;
  requestDeadlineMs: number;
  admissionConfidenceFloor: number;
  routeConfidenceFloor: number;
  models: Record<Tier, string>;
  /** Optional in a config file; absent means workers share the caller's checkout. */
  workerIsolation: WorkerIsolation;
  /**
   * How Gate B asks. `composite` is the shipped five-way choice; `atomic` fans the same judgement out into read-off
   * questions and composes them in code. Optional in a config file and defaulted to `composite`, so a deployed file
   * keeps its current behaviour without being edited.
   */
  routeQuestionShape: RouteQuestionShape;
  /**
   * Context tokens the main session must already be carrying before Gate A is asked anything. Below it the turn is
   * direct and no request is sent: delegation measured +182 % at 55K and -57 % at 406K, so depth, not the prompt, is
   * what decides. 0 disables the floor.
   *
   * #48 P0-1: `null` (the default) means derive the floor from the host's own auto-compaction window instead of
   * this absolute number -- see `effectiveDepthFloor` in config.ts. An explicit non-negative integer keeps today's
   * absolute meaning exactly, including 0 to disable it. Optional in a config file, like `routeQuestionShape`; an
   * explicit `null` in a file is accepted and means the same as leaving the key out.
   */
  delegationDepthFloor: number | null;
  /**
   * #48 P0-1: the fraction of the host's compaction window that `effectiveDepthFloor` uses when `delegationDepthFloor`
   * is not set explicitly. 0.6 is a policy choice made so a smaller window still admits some prompts before the host
   * compacts; it is not a measured crossing point. Must be strictly between 0 and 1. Optional in a config file.
   * Since 0.4.0 only the composite Gate A reads it: the atomic gate's floor comes from its cost model.
   */
  delegationDepthFraction: number;
  /**
   * How Gate A asks. `composite` is the shipped four-way choice; `atomic` fans the same judgement out into read-off
   * questions composed in code as vetoes, and does not consult `admissionConfidenceFloor` at all. Optional in a
   * config file and defaulted to `composite`, mirroring `routeQuestionShape`.
   */
  admissionQuestionShape: AdmissionQuestionShape;
  /**
   * Gate A's cost model (`delegationSaving` in src/admission.ts): the root turns a delegated turn still takes at
   * depth, and what one worker turn reads. Declared, not fitted; the coordinator figure is the jev_single bench's
   * 11-17 root turns.
   */
  delegationCoordinatorTurns: number;
  delegationWorkerTokensPerCall: number;
  /**
   * Whether a worker's reported check results are compared with the commands its own transcript shows it ran
   * (src/verify.ts). A check reported as passing whose last run failed makes the task `incomplete`. On by default.
   */
  verifyWorkerChecks: boolean;
}

export interface ChoiceAnswer<K extends string> {
  type: 'choice';
  choice: K;
  probabilities: Record<K, number>;
  confidence: number;
}

export interface JevUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * #233: why an owned Codex dispatch ended without completion, and where. Closed, so no raw error text, prompt or
 * command reaches a trace or a tool result. `not_executed` is definite non-execution evidence, never a terminal.
 */
export type CodexFailureCategory = 'preflight_conflict' | 'permissions_unavailable' | 'worktree_unavailable' | 'allocation_unavailable' | 'cancelled' | 'reservation_unavailable' | 'native_start_rejected' | 'native_failed_turn' | 'interrupted' | 'termination_unconfirmed';
export const CODEX_FAILURE_CATEGORIES: readonly CodexFailureCategory[] = ['preflight_conflict', 'permissions_unavailable', 'worktree_unavailable', 'allocation_unavailable', 'cancelled', 'reservation_unavailable', 'native_start_rejected', 'native_failed_turn', 'interrupted', 'termination_unconfirmed'];
export type CodexFailureStage = 'preflight' | 'reservation' | 'thread_start' | 'turn_start' | 'turn';
export const CODEX_FAILURE_STAGES: readonly CodexFailureStage[] = ['preflight', 'reservation', 'thread_start', 'turn_start', 'turn'];
export interface CodexFailure { category: CodexFailureCategory; stage: CodexFailureStage; not_executed: boolean }

/** Hook input as read from stdin. Only documented fields are typed; unknown fields are ignored, never forwarded. */
export interface HookInput {
  hook_event_name: string;
  session_id?: string;
  prompt_id?: string;
  /** Every hook event carries it; only Gate A reads it, to measure how deep the session already is (`src/depth.ts`). */
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  effort?: string;
  prompt?: string;
  /** Native UserPromptSubmit author provenance; older payloads may omit it. */
  source?: 'user' | 'sdk' | 'system' | 'loop_wakeup' | 'schedule_wakeup' | 'poll_event';
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
  /** Set only by the Codex adapter's owned dispatch failure. */
  codex_failure?: CodexFailure;
}

/** A1: checks carry stable local ids so receipt completeness is decided by code, not by the worker's prose. */
export interface PlannedCheck {
  id: string;
  description: string;
  required: boolean;
  command: string | null;
}

/** The task Gate B routes on. A dispatch with no contract sends an empty one, so absent evidence reads as unknown. */
export interface PlannedTask {
  id: string;
  outcome: string;
  depends_on: string[];
  context: string;
  constraints: string[];
  deliverables: string[];
  checks: PlannedCheck[];
  replan_if: string[];
  contract_hash: string;
}

export interface WorkerCheckResult {
  check_id: string;
  result: 'pass' | 'fail' | 'not_run';
  note: string;
}

export interface WorkerReply {
  status: 'done' | 'blocked';
  summary: string;
  changed_files: string[];
  interfaces: string[];
  checks: WorkerCheckResult[];
  blockers: string[];
}

export type JobOutcome = 'completed' | 'incomplete' | 'blocked' | 'superseded';
export type DeterministicVerdict = 'accept' | 'incomplete';
export type ReceiptVerdict = DeterministicVerdict | 'invalid' | 'unknown';

/** A4: one reservation per dispatched owned call, taken before any HTTP and released at Post. */
export interface Reservation {
  role: OwnedRole;
  task_id: string | null;
  /**
   * A4/T1: the contract this dispatch was reserved under, so the receipt that closes it is selectable by the same key
   * it was dispatched on. `''` on a single-executor dispatch, which has no contract.
   * State written before this field existed carries none, so read it through `reservedContractHash`, never directly.
   */
  contract_hash: string | null;
  rev: number | null;
  tier: Tier | null;
  attempt: number;
  deliverables: string[];
  started_at: string;
  orphaned?: true;
  /** Native execution survives local RPC timeout and generation retirement until terminal settlement commits. */
  codex_execution?: {
    thread_id: string; turn_id: string | null; cwd: string; root_cwd: string;
    /** #239: the app-server process that runs the worker. Absent in reservations written before 0.8.20. */
    host_pid?: number;
  };
  /** A launch receipt is not a terminal result. Native identity remains reserved until observed completion. */
  allocation_pair?: { model: string; effort_edit: { kind: 'keep' } | { kind: 'set'; value: string } | { kind: 'omit' } };
  background_execution?: { token: string; agent_id: string | null; subagent_type: string; resolved_model: string | null };
}

/** What a worker's own transcript showed about the checks it reported as passing (src/verify.ts). */
export interface CheckVerification {
  transcript: 'read' | 'truncated' | 'unavailable';
  /** Reported pass; the last run of its command failed. */
  contradicted: string[];
  /** Reported pass; no passing run of its command was seen: the transcript read shows none or only an unmarked one, or none could be read. */
  unobserved: string[];
  /** Reported pass whose start is not known to follow the last observed edit. Aged success, not an observed failure. */
  stale: string[];
}

export interface WorkerReceiptReply {
  status: WorkerReply['status'];
  checks: Pick<WorkerCheckResult, 'check_id' | 'result'>[];
}

export interface Receipt {
  task_id: string;
  contract_hash: string;
  rev: number;
  attempt: number;
  tool_use_id: string;
  provenance: 'worker_reported';
  reply: WorkerReceiptReply | null;
  verdict: ReceiptVerdict;
  verdict_reason: string | null;
  observed_model: string | null;
  root_effort: string | null;
  recorded_at: string;
  /** Present when `verifyWorkerChecks` compared the reply with the worker's transcript. */
  verification?: CheckVerification;
  /** A bounded, uncharged single-shape retry for a passing command with only an unsupported display suffix. */
  evidence_format_only?: true;
  requested_tier?: Tier | null;
  requested_model?: string | null;
}

export interface JobAttempts {
  tasks: Record<string, number>;
}

/** One generation = one (session_id, prompt_id) pair (A2). A new prompt supersedes the previous one into history. */
export interface JobGeneration {
  prompt_id: string | null;
  /** #284: the host reuses a prompt_id for queued prompts and notices, so a late answer is matched to this, not to it. Absent in older state. */
  generation_id?: string;
  /**
   * A17: the admitted request, verbatim, carried to the worker as its task. Null when the turn carried none, or when
   * it was larger than REQUEST_MAX_BYTES: the absence is stated in the prompt, never truncated into a half-spec.
   */
  request: string | null;
  created_at: string;
  shape: ExecutionShape;
  active: Record<string, Reservation>;
  receipts: Receipt[];
  attempts: JobAttempts;
  outcome: JobOutcome | null;
  /** A16: the generation was started by the bench control variable, not by a Gate A answer. */
  forced?: true;
  /** A19: every admitted turn runs one worker. Absent only in state written by the removed planner path (#289). */
  execution?: 'single';
  /** The admitted job handed remaining work to the root: accepted terminal results, failed required delivery, or the single-attempt cap. */
  root_fallback?: true;
  root_fallback_reason?: 'attempt_cap' | 'delivery_failed' | 'accepted';
  /** New automatic atomic admissions require an intact single-worker request. Absent is legacy. */
  admission_revision?: 'atomic-context-v1';
  /** Conversation turns can advance while this original execution contract stays current. */
  background_job?: true;
  interactive_prompt_id?: string;
  /** Time the last owned reservation was released; absence in older state remains unknown. */
  background_idle_since?: string;
  /** Exact stored result delivered after all native executions ended; unrelated prompts can then supersede. */
  background_delivery?: { result: string; prompt_id: string; stalled_since: string };
  /** Terminal policy guidance delivered to the root, rather than to a SubagentStop child context. */
  background_context?: string;
  /** #281: executions a native TaskStop ended, each awaiting the host's one killed notice (taken once, `notices_taken`). */
  background_stopped?: Array<{ agent_id: string; tool_use_id: string }>;
  /** #281: notices taken as the host's before their row was written (noticeClaim). A later copy is a person's. */
  notices_taken?: string[];
}

export interface JobState {
  version: 5;
  session_id: string;
  updated_at: string;
  current: JobGeneration;
  history: JobGeneration[];
}

/** Fixed diagnostic codes: the only text the hook writes to stderr, and the only reason strings a trace stores. */
export type SkipCode =
  | 'mode_off'
  | 'mode_native'
  | 'not_agent_tool'
  | 'child_caller'
  | 'custom_agent_session'
  | 'missing_ids'
  | 'bad_tool_input'
  | 'role_not_owned'
  | 'not_foreground'
  | 'model_pinned'
  | 'execution_control_present'
  | 'subagent_model_override'
  | 'fork_or_background_override'
  | 'prompt_too_large'
  | 'prompt_invalid_unicode'
  | 'request_too_large'
  | 'key_missing'
  | 'config_invalid'
  | 'trace_intent_failed'
  | 'output_too_large'
  | 'no_state'
  | 'aborted'
  | 'host_unsupported'
  /** Local work left too little of the hook's own time for the provider call; nothing was sent. */
  | 'deadline_exhausted';

export type HttpCode =
  | 'http_400'
  /** A 400 whose body names `max_tokens_exceeded`: the request is over the model's context length. */
  | 'context_exceeded'
  | 'http_401'
  | 'http_402'
  | 'http_413'
  | 'http_415'
  | 'http_422'
  | 'http_429'
  | 'http_529'
  | 'http_other'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'response_too_large'
  | 'response_invalid'
  | 'request_too_large';

/** Reasons a decision preserved the called profile or the native shape instead of applying a Jev answer. */
export type PreserveReason =
  | 'admission_invalid'
  | 'admission_tie'
  | 'admission_needs_context'
  | 'admission_context_unclear'
  | 'admission_context_low_confidence'
  | 'admission_abstain'
  | 'admission_low_confidence'
  | 'prompt_id_absent'
  | 'admission_forced'
  | 'depth_unknown'
  | 'depth_below_floor'
  | 'admission_forbids_delegation'
  | 'task_notification'
  /** Historical only (before 0.4.0): stored traces carry these; no current decision produces them. */
  | 'admission_answer_only'
  | 'admission_too_small'
  | 'admission_external_tools'
  | 'admission_not_worth'
  | 'admission_shape_unknown'
  | 'admission_delivery_failed'
  | 'route_invalid'
  | 'route_tie'
  | 'route_abstain'
  | 'route_low_confidence'
  | 'route_not_fast'
  | 'basis_invalid'
  | 'basis_tie'
  | 'basis_absent'
  | 'basis_low_confidence'
  | 'generation_changed'
  | 'pinned';

/** Reasons an owned dispatch was denied. */
export type DenyReason = 'dispatch_ineligible' | 'task_active' | 'attempt_mismatch' | 'stale_generation' | 'bounds_exhausted';

export type StateCode = 'state_corrupt' | 'state_too_large' | 'state_locked' | 'state_symlink' | 'state_write_failed';

export type InputCode = 'stdin_too_large' | 'stdin_invalid_json' | 'stdin_invalid_utf8' | 'stdin_read_failed' | 'internal';

export type ErrorCode = SkipCode | HttpCode | PreserveReason | DenyReason | StateCode | InputCode;
