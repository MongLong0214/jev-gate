/** V5 shared types (ADR #22 r1 + r2 amendments). V4 prompt-block and task-decision types were removed with the V4 runtime. */

export type Tier = 'fast' | 'standard' | 'deep' | 'frontier';
export type PlannerTier = 'deep' | 'frontier';
export type Mode = 'off' | 'native' | 'auto';
export type OwnedRole = 'worker' | 'planner';
export type ExecutionShape = 'direct' | 'orchestrated';
export type AdmissionAnswer = 'direct' | 'orchestrated' | 'needs_context' | 'abstain';
export type RouteAnswer = Tier | 'abstain';
export type PlannerRouteAnswer = PlannerTier | 'abstain';
export type UpgradeBasis = 'unresolved_contract_reasoning' | 'observed_reasoning_failure' | 'no_specific_basis' | 'unknown';
export type ResultVerdict = 'accept' | 'rework' | 'replan' | 'abstain';

export const TIERS: readonly Tier[] = ['fast', 'standard', 'deep', 'frontier'];
export const PLANNER_TIERS: readonly PlannerTier[] = ['deep', 'frontier'];
export const MODES: readonly Mode[] = ['off', 'native', 'auto'];
export const ADMISSION_ANSWERS: readonly AdmissionAnswer[] = ['direct', 'orchestrated', 'needs_context', 'abstain'];
export const ROUTE_ANSWERS: readonly RouteAnswer[] = ['fast', 'standard', 'deep', 'frontier', 'abstain'];
export const PLANNER_ROUTE_ANSWERS: readonly PlannerRouteAnswer[] = ['deep', 'frontier', 'abstain'];
export const UPGRADE_BASES: readonly UpgradeBasis[] = ['unresolved_contract_reasoning', 'observed_reasoning_failure', 'no_specific_basis', 'unknown'];
export const RESULT_VERDICTS: readonly ResultVerdict[] = ['accept', 'rework', 'replan', 'abstain'];
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
  'jev-gate:planner': { role: 'planner', tier: 'deep' },
  'jev-gate:planner-frontier': { role: 'planner', tier: 'frontier' },
};

export const OWNED_AGENT_NAMES: readonly string[] = Object.keys(OWNED_AGENTS);

export const agentForTier = (role: OwnedRole, tier: Tier): string => {
  const found = OWNED_AGENT_NAMES.find((name) => OWNED_AGENTS[name]?.role === role && OWNED_AGENTS[name]?.tier === tier);
  // A planner has no fast/standard profile; the caller's tier decision is clamped to the strong profiles before this point.
  return found ?? (role === 'planner' ? 'jev-gate:planner' : 'jev-gate:worker');
};

export interface ConfigV5 {
  version: 5;
  mode: Mode;
  jevModel: string;
  requestDeadlineMs: number;
  admissionConfidenceFloor: number;
  routeConfidenceFloor: number;
  resultConfidenceFloor: number;
  plannerDefaultTier: PlannerTier;
  models: Record<Tier, string>;
  maxParallelWorkers: number;
  guardAllowTools: string[];
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

/** Hook input as read from stdin. Only documented fields are typed; unknown fields are ignored, never forwarded. */
export interface HookInput {
  hook_event_name: string;
  session_id?: string;
  prompt_id?: string;
  cwd?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  effort?: string;
  prompt?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}

/** A1: checks carry stable local ids so receipt completeness is decided by code, not by the worker's prose. */
export interface PlannedCheck {
  id: string;
  description: string;
  required: boolean;
  command: string | null;
}

export interface PlannedTask {
  id: string;
  outcome: string;
  depends_on: string[];
  context: string;
  constraints: string[];
  deliverables: string[];
  checks: PlannedCheck[];
  replan_if: string[];
  /** A3: sha256 over the scheduling-relevant contract; a receipt is accepted for (task_id, contract_hash). */
  contract_hash: string;
}

export interface Plan {
  rev: number;
  goal: string;
  assumptions: string[];
  constraints: string[];
  tasks: PlannedTask[];
}

export type PlannerReply =
  | { status: 'ready'; goal: string; assumptions: string[]; constraints: string[]; tasks: Array<Omit<PlannedTask, 'contract_hash'>> }
  | { status: 'needs_context'; questions: string[]; findings: string[] }
  | { status: 'blocked'; reason: string; findings: string[] };

export interface WorkerCheckResult {
  check_id: string;
  result: 'pass' | 'fail' | 'not_run';
  note: string;
}

export interface WorkerReply {
  status: 'done' | 'blocked' | 'replan';
  summary: string;
  changed_files: string[];
  interfaces: string[];
  checks: WorkerCheckResult[];
  blockers: string[];
}

export type JobPhase = 'admitted' | 'planning' | 'planned' | 'blocked';
export type JobOutcome = 'completed' | 'incomplete' | 'blocked' | 'superseded';
export type DeterministicVerdict = 'accept' | 'incomplete';

/** A4: one reservation per dispatched owned call, taken before any HTTP and released at Post. */
export interface Reservation {
  role: OwnedRole;
  task_id: string | null;
  rev: number | null;
  tier: Tier | null;
  attempt: number;
  deliverables: string[];
  started_at: string;
  orphaned?: true;
}

export interface Receipt {
  task_id: string;
  contract_hash: string;
  rev: number;
  attempt: number;
  tool_use_id: string;
  provenance: 'worker_reported';
  reply: WorkerReply | null;
  verdict: DeterministicVerdict | 'invalid' | 'unknown';
  verdict_reason: string | null;
  /** Gate C is advisory (A1): recorded, never applied to readiness. */
  advisory: ResultVerdict | null;
  observed_model: string | null;
  root_effort: string | null;
  recorded_at: string;
}

export interface JobAttempts {
  planner: number;
  replans: number;
  tasks: Record<string, number>;
}

/** One generation = one (session_id, prompt_id) pair (A2). A new prompt supersedes the previous one into history. */
export interface JobGeneration {
  prompt_id: string | null;
  created_at: string;
  shape: ExecutionShape;
  phase: JobPhase;
  planner_tier: PlannerTier | null;
  plan: Plan | null;
  active: Record<string, Reservation>;
  receipts: Receipt[];
  denials: number;
  attempts: JobAttempts;
  outcome: JobOutcome | null;
  /** A16: the generation was started by the bench control variable, not by a Gate A answer. */
  forced?: true;
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
  | 'shape_direct'
  | 'aborted';

export type HttpCode =
  | 'http_401'
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
  | 'admission_abstain'
  | 'admission_low_confidence'
  | 'prompt_id_absent'
  | 'admission_forced'
  | 'route_invalid'
  | 'route_tie'
  | 'route_abstain'
  | 'route_low_confidence'
  | 'basis_invalid'
  | 'basis_tie'
  | 'basis_absent'
  | 'basis_low_confidence'
  | 'result_invalid'
  | 'result_tie'
  | 'result_abstain'
  | 'result_low_confidence'
  | 'generation_changed'
  | 'pinned';

/** Reasons a dispatch or a root tool call was denied while orchestration is active. */
export type DenyReason =
  | 'guard_denied'
  | 'dispatch_ineligible'
  | 'task_active'
  | 'task_accepted'
  | 'reservation_superseded'
  | 'deliverable_overlap'
  | 'parallel_cap'
  | 'planner_pin_conflict'
  | 'workers_active'
  | 'bounds_exhausted'
  | 'composed_too_large'
  | 'no_marker'
  | 'unknown_task'
  | 'stale_rev'
  | 'deps_incomplete'
  | 'phase_not_planned';

export type StateCode = 'state_corrupt' | 'state_too_large' | 'state_locked' | 'state_symlink' | 'state_write_failed';

export type InputCode = 'stdin_too_large' | 'stdin_invalid_json' | 'stdin_invalid_utf8' | 'stdin_read_failed' | 'internal';

export type ErrorCode = SkipCode | HttpCode | PreserveReason | DenyReason | StateCode | InputCode;
