/** V4 shared types (jev-gate-v4-task-boundary-r2). V3 prompt-level types were removed with the V3 runtime. */

export type Tier = 'sonnet' | 'opus' | 'fable';
export type Mode = 'off' | 'native' | 'auto';
export type OwnedRole = 'worker' | 'planner';
export type TaskKind = 'implement' | 'investigate' | 'design' | 'verify' | 'other';
export type ContextAnswer = 'ready' | 'needs_context';
export type RouteAnswer = Tier | 'abstain';

export const TIERS: readonly Tier[] = ['sonnet', 'opus', 'fable'];
export const MODES: readonly Mode[] = ['off', 'native', 'auto'];
export const TASK_KINDS: readonly TaskKind[] = ['implement', 'investigate', 'design', 'verify', 'other'];
export const CONTEXT_ANSWERS: readonly ContextAnswer[] = ['ready', 'needs_context'];
export const ROUTE_ANSWERS: readonly RouteAnswer[] = ['sonnet', 'opus', 'fable', 'abstain'];

/** Scoped agent names as the host discovers them from this plugin. */
export const OWNED_AGENTS: Record<OwnedRole, string> = { worker: 'jev-gate:worker', planner: 'jev-gate:planner' };
/** Native frontmatter defaults of the owned roles; used as Jev state and never changed by an abstention. */
export const ROLE_DEFAULT_TIER: Record<OwnedRole, Tier> = { worker: 'sonnet', planner: 'opus' };

export interface PromptBlock {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface ConfigV4 {
  version: 4;
  mode: Mode;
  jevModel: string;
  requestDeadlineMs: number;
  routeConfidenceFloor: number;
  models: Record<Tier, string>;
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
  cwd?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  prompt?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
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

export type PreserveReason =
  | 'context_invalid'
  | 'context_tie'
  | 'needs_context'
  | 'context_low_confidence'
  | 'route_invalid'
  | 'route_tie'
  | 'route_abstain'
  | 'route_low_confidence';

export type InputCode = 'stdin_too_large' | 'stdin_invalid_json' | 'stdin_invalid_utf8' | 'stdin_read_failed' | 'internal';

export type ErrorCode = SkipCode | HttpCode | PreserveReason | InputCode;

export interface TaskDecision {
  action: 'patch' | 'preserve';
  tier: Tier | null;
  kind: TaskKind;
  reason: PreserveReason | null;
  context: ChoiceAnswer<ContextAnswer> | null;
  route: ChoiceAnswer<RouteAnswer> | null;
}
