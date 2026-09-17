export type Tier = 'sonnet' | 'opus' | 'fable';
export type GateMode = 'off' | 'enrich' | 'auto';
export type Kind = 'question' | 'debug' | 'change' | 'review' | 'design' | 'other';
export type Role = 'goal' | 'constraint' | 'acceptance' | 'background' | 'mixed';
export type Route = Tier | 'context_required' | 'uncertain';

export const TIERS: readonly Tier[] = ['sonnet', 'opus', 'fable'];
export const KINDS: readonly Kind[] = ['question', 'debug', 'change', 'review', 'design', 'other'];
export const ROLES: readonly Role[] = ['goal', 'constraint', 'acceptance', 'background', 'mixed'];
export const ROUTES: readonly Route[] = ['sonnet', 'opus', 'fable', 'context_required', 'uncertain'];

export interface PromptBlock {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface HookInput {
  hook_event_name: string;
  prompt?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
}

export interface ChoiceAnswer<K extends string> {
  type: 'choice';
  choice: K;
  probabilities: Record<K, number>;
  confidence: number;
}

export type Execution = 'main' | 'delegate' | 'main_context' | 'native_fallback';
export type DecisionReason = 'selected' | 'uncertain' | 'context_required' | 'enrich_only' | 'error';
export type AgentName = 'jev-gate:opus' | 'jev-gate:frontier';

export interface GateDecision {
  kind: Kind;
  roles: Record<string, Role>;
  rawRoute: ChoiceAnswer<Route> | null;
  execution: Execution;
  tier: Tier | null;
  agentName: AgentName | null;
  reason: DecisionReason;
}

export interface Config {
  version: 3;
  mode: GateMode;
  jevModel: string;
  requestDeadlineMs: number;
  routeConfidenceFloor: number;
  uncertainTier: 'opus' | 'fable';
  opusModel: string;
  frontierModel: string;
}

export interface JevUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}

/** Fixed error codes: the only diagnostic text the hook ever writes to stderr or a trace. */
export type ErrorCode =
  | 'stdin_too_large'
  | 'stdin_invalid_json'
  | 'stdin_read_failed'
  | 'config_invalid'
  | 'prompt_too_large'
  | 'key_missing'
  | 'request_too_large'
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
  | 'answers_invalid'
  | 'brief_too_large'
  | 'trace_dir_unwritable'
  | 'trace_write_failed'
  | 'internal';

export const NATIVE_FALLBACK_DECISION: GateDecision = {
  kind: 'other',
  roles: {},
  rawRoute: null,
  execution: 'native_fallback',
  tier: null,
  agentName: null,
  reason: 'error',
};
