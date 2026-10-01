import { subagentModelOverride } from './auth.js';
import type { Env } from './config.js';
import type { ConfigV5, HookInput, OwnedRole, SkipCode, Tier } from './types.js';
import { OWNED_AGENTS } from './types.js';

/** Local resource bounds. Not provider or host token limits; over-limit input is preserved, never truncated. */
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 512 * 1024;
/**
 * A6/A7: the guard denies root mutation tools, and a job that keeps probing them instead of dispatching is stopped.
 * Observed on the host (v5-host-1, 2026-09-18): a coordinator probes two or three unavailable tools before its first
 * planner call, so a budget of 3 killed otherwise healthy jobs. The budget bounds a loop, not a few early probes.
 */
export const DENIALS_BEFORE_STOP = 12;

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
 * Whether any Agent call this session makes can pass checkEligibility's foreground test, read from the launch
 * environment alone. Unless CLAUDE_CODE_FORK_SUBAGENT=0, an interactive session runs in the host's fork mode, whose
 * Agent tool has no `run_in_background` field at all; without CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 every brief there
 * is `not_foreground`, and forced forking is refused outright. #48: on such a host an admitted job never reaches a
 * worker, while its guard still refuses the main session's own edits, so admission must not be paid for at all.
 * The gate stays native there rather than asking for the variable to be set globally: forcing the foreground in every
 * session would end the background subagents that #48 P1-2 names as what sped delivery up.
 */
export const foregroundDispatchPossible = (env: Env): boolean =>
  env['CLAUDE_CODE_FORK_SUBAGENT'] !== '1' &&
  (env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'] === '1' || env['CLAUDE_CODE_FORK_SUBAGENT'] === '0');

/**
 * Why no owned Agent call this session makes could reach a worker, or null when one could. A subagent model override
 * is refused by checkEligibility just as a background-only call is, so an orchestrated job is locked out either way:
 * its guard refuses the main session's edits while every brief is declined. Both are fixed at launch, so admission,
 * the forced arm, lean and the SessionStart notice all read this one answer.
 */
export const dispatchBlocker = (env: Env): 'background_only' | 'subagent_model_override' | null => {
  if (!foregroundDispatchPossible(env)) return 'background_only';
  const override = subagentModelOverride(env);
  return override.concrete || override.force ? 'subagent_model_override' : null;
};

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
  // This is the root guard only. A child inherits the host's tools and is skipped before this decision.
  return { allow: GUARD_ALLOW_TOOLS.includes(toolName) || config.guardAllowTools.includes(toolName) || (config.guardAllowMcp && (toolName === 'ToolSearch' || toolName.startsWith('mcp__'))) };
};

export interface AgentPatch {
  subagent_type?: string;
  model?: string;
  prompt?: string;
  /**
   * #48 P1-2: only a WORKER dispatch the hook patches carries this, and only under `workerIsolation: "worktree"`.
   * `EXECUTION_CONTROL_KEYS` above still rejects a CALLER-supplied `isolation` at eligibility time -- this field is
   * the hook adding the key itself, afterward, on the patch it was already going to emit; it is never added on a
   * `preserve()` path, since that path emits no output and the call proceeds completely unpatched.
   */
  isolation?: 'worktree';
}

/** New object; only the named fields differ, and the original prompt stays an exact prefix of a patched prompt. */
export const patchAgentInput = (original: AgentInput, patch: AgentPatch): AgentInput => {
  const out: AgentInput = { ...original };
  if (patch.subagent_type !== undefined) out['subagent_type'] = patch.subagent_type;
  if (patch.model !== undefined) out['model'] = patch.model;
  if (patch.isolation !== undefined) out['isolation'] = patch.isolation;
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

/**
 * `systemMessage` (#114) rides along only when the hook has something the user, not the model, must see: why Gate A
 * was not asked. The host shows it once and never feeds it into model context.
 */
export const renderAdditionalContext = (event: 'UserPromptSubmit' | 'PostToolUse', additionalContext: string, systemMessage: string | null = null): string | null => {
  const text = JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext }, ...(systemMessage === null ? {} : { systemMessage }) });
  return Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES ? null : text;
};

/**
 * #48 P2: a SessionStart-only notice the host shows the user directly and never feeds back into model context --
 * contrast `renderAdditionalContext`, whose whole point is the opposite. Used for the liveness warning, which is
 * about the gate's own health and has no business spending the session's own context budget to report on itself.
 */
export const renderSystemMessage = (text: string): string | null => {
  const out = JSON.stringify({ systemMessage: text });
  return Buffer.byteLength(out, 'utf8') > MAX_OUTPUT_BYTES ? null : out;
};
