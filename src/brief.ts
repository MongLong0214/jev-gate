import { subagentModelOverride } from './auth.js';
import type { Env } from './config.js';
import type { ConfigV5, HookInput, OwnedRole, SkipCode, Tier } from './types.js';
import { OWNED_AGENTS } from './types.js';

/** Local resource bounds. Not provider or host token limits; over-limit input is preserved, never truncated. */
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 512 * 1024;
export const DENIALS_BEFORE_STOP = 3;

/** Agent-call fields whose execution semantics make automatic reallocation unsafe: resume/follow-up, team, fork, isolation. */
export const EXECUTION_CONTROL_KEYS = ['resume', 'agentId', 'agent_id', 'name', 'team_name', 'isolation', 'fork'] as const;

/**
 * A6 (replaces the V4/D4 deny-list): during orchestration the root may use these read-only and bookkeeping tools plus the
 * owned agents and anything the user added to config `guardAllowTools`. Everything else is declined as unsupported.
 */
export const GUARD_ALLOW_TOOLS: readonly string[] = [
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'ListAgents',
];

export type AgentInput = Record<string, unknown>;

export type Eligibility =
  | {
      eligible: true;
      role: OwnedRole;
      tier: Tier;
      agent: string;
      pinned: boolean;
      input: AgentInput;
      prompt: string;
      description: string;
      sessionId: string;
      toolUseId: string;
    }
  | { eligible: false; code: SkipCode };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * V4 §4 conditions kept for V5. A caller pin is reported rather than fatal: a pinned call still receives the canonical
 * task contract (A5), it just keeps its model. Every other failing condition is a documented no-op with HTTP 0.
 */
export const checkEligibility = (hook: HookInput, env: Env, config: ConfigV5): Eligibility => {
  if (config.mode === 'off') return { eligible: false, code: 'mode_off' };
  if (hook.hook_event_name !== 'PreToolUse' || hook.tool_name !== 'Agent') return { eligible: false, code: 'not_agent_tool' };
  if (nonEmpty(hook.agent_id)) return { eligible: false, code: 'child_caller' };
  if (nonEmpty(hook.agent_type)) return { eligible: false, code: 'custom_agent_session' };
  if (!nonEmpty(hook.session_id) || !nonEmpty(hook.tool_use_id)) return { eligible: false, code: 'missing_ids' };
  const input = hook.tool_input;
  if (!isRecord(input)) return { eligible: false, code: 'bad_tool_input' };
  const { description, prompt, subagent_type } = input;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return { eligible: false, code: 'bad_tool_input' };
  if (description !== undefined && typeof description !== 'string') return { eligible: false, code: 'bad_tool_input' };
  const owned = typeof subagent_type === 'string' ? OWNED_AGENTS[subagent_type] : undefined;
  if (!owned || typeof subagent_type !== 'string') return { eligible: false, code: 'role_not_owned' };
  // Host observation (Claude Code 2.1.275): with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 the host forces every Agent call
  // into the foreground and strips `run_in_background`, so an explicit false is never delivered there.
  const bg = input['run_in_background'];
  const forcedForeground = bg === undefined && env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'] === '1';
  if (bg !== false && !forcedForeground) return { eligible: false, code: 'not_foreground' };
  if (EXECUTION_CONTROL_KEYS.some((k) => Object.prototype.hasOwnProperty.call(input, k))) return { eligible: false, code: 'execution_control_present' };
  const override = subagentModelOverride(env);
  if (override.concrete || override.force) return { eligible: false, code: 'subagent_model_override' };
  if (env['CLAUDE_CODE_FORK_SUBAGENT'] === '1') return { eligible: false, code: 'fork_or_background_override' };
  const descriptionText = typeof description === 'string' ? description : '';
  if (!prompt.isWellFormed() || !descriptionText.isWellFormed()) return { eligible: false, code: 'prompt_invalid_unicode' };
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return { eligible: false, code: 'prompt_too_large' };
  return {
    eligible: true,
    role: owned.role,
    tier: owned.tier,
    agent: subagent_type,
    pinned: Object.prototype.hasOwnProperty.call(input, 'model'),
    input,
    prompt,
    description: descriptionText,
    sessionId: hook.session_id,
    toolUseId: hook.tool_use_id,
  };
};

/** The guard never returns `allow`: a permitted call produces no output at all, so native permissions still apply. */
export const guardDecision = (toolName: string, toolInput: unknown, config: ConfigV5): { allow: boolean } => {
  if (toolName === 'Agent') {
    const subagent = isRecord(toolInput) ? toolInput['subagent_type'] : undefined;
    return { allow: typeof subagent === 'string' && subagent in OWNED_AGENTS };
  }
  return { allow: GUARD_ALLOW_TOOLS.includes(toolName) || config.guardAllowTools.includes(toolName) };
};

export interface AgentPatch {
  subagent_type?: string;
  model?: string;
  prompt?: string;
}

/** New object; only the named fields differ, and the original prompt stays an exact prefix of a patched prompt. */
export const patchAgentInput = (original: AgentInput, patch: AgentPatch): AgentInput => {
  const out: AgentInput = { ...original };
  if (patch.subagent_type !== undefined) out['subagent_type'] = patch.subagent_type;
  if (patch.model !== undefined) out['model'] = patch.model;
  if (patch.prompt !== undefined) {
    if (!patch.prompt.startsWith(String(original['prompt'] ?? ''))) throw new Error('patched prompt must keep the original as an exact prefix');
    out['prompt'] = patch.prompt;
  }
  return out;
};

export type PreToolUseOutput =
  | { kind: 'update'; updatedInput: AgentInput }
  | { kind: 'deny'; reason: string; stopReason: string | null };

/** The one JSON object a PreToolUse decision emits. Returns null when the serialized envelope exceeds the local bound. */
export const renderPreToolUseOutput = (out: PreToolUseOutput): string | null => {
  const envelope =
    out.kind === 'update'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: out.updatedInput } }
      : {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.reason },
          ...(out.stopReason === null ? {} : { continue: false, stopReason: out.stopReason }),
        };
  const text = JSON.stringify(envelope);
  return Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES ? null : text;
};

export const renderAdditionalContext = (event: 'UserPromptSubmit' | 'PostToolUse', additionalContext: string): string | null => {
  const text = JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
  return Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES ? null : text;
};
