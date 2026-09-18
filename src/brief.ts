import type { ConfigV4, HookInput, OwnedRole, SkipCode, TaskKind } from './types.js';
import { OWNED_AGENTS } from './types.js';
import { subagentModelOverride } from './auth.js';
import type { Env } from './config.js';

/** Local resource bounds (#10 §4). Not provider or host token limits; over-limit input is preserved, never truncated. */
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_SUFFIX_BYTES = 1024;
export const MAX_OUTPUT_BYTES = 512 * 1024;

/** Agent-call fields whose execution semantics make automatic reallocation unsafe: resume/follow-up, team, fork, isolation. */
export const EXECUTION_CONTROL_KEYS = ['resume', 'agentId', 'agent_id', 'name', 'team_name', 'isolation', 'fork'] as const;

export type AgentInput = Record<string, unknown>;

export type Eligibility =
  | { eligible: true; role: OwnedRole; input: AgentInput; prompt: string; description: string; sessionId: string; toolUseId: string }
  | { eligible: false; code: SkipCode };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * #10 §4 in one function. Every failing condition is a documented no-op with HTTP 0; the original input is never changed.
 * Mode and key are checked by the caller in the order that keeps `off` ahead of configuration work.
 */
export const checkEligibility = (hook: HookInput, env: Env, config: ConfigV4): Eligibility => {
  if (config.mode === 'off') return { eligible: false, code: 'mode_off' };
  if (config.mode === 'native') return { eligible: false, code: 'mode_native' };
  if (hook.hook_event_name !== 'PreToolUse' || hook.tool_name !== 'Agent') return { eligible: false, code: 'not_agent_tool' };
  if (nonEmpty(hook.agent_id)) return { eligible: false, code: 'child_caller' };
  if (nonEmpty(hook.agent_type)) return { eligible: false, code: 'custom_agent_session' };
  if (!nonEmpty(hook.session_id) || !nonEmpty(hook.tool_use_id)) return { eligible: false, code: 'missing_ids' };
  const input = hook.tool_input;
  if (!isRecord(input)) return { eligible: false, code: 'bad_tool_input' };
  const { description, prompt, subagent_type } = input;
  if (typeof description !== 'string' || typeof prompt !== 'string' || prompt.trim().length === 0) return { eligible: false, code: 'bad_tool_input' };
  const role = (Object.keys(OWNED_AGENTS) as OwnedRole[]).find((r) => OWNED_AGENTS[r] === subagent_type);
  if (!role) return { eligible: false, code: 'role_not_owned' };
  if (input['run_in_background'] !== false) return { eligible: false, code: 'not_foreground' };
  if (Object.prototype.hasOwnProperty.call(input, 'model')) return { eligible: false, code: 'model_pinned' };
  if (EXECUTION_CONTROL_KEYS.some((k) => Object.prototype.hasOwnProperty.call(input, k))) return { eligible: false, code: 'execution_control_present' };
  const override = subagentModelOverride(env);
  if (override.concrete || override.force) return { eligible: false, code: 'subagent_model_override' };
  if (env['CLAUDE_CODE_FORK_SUBAGENT'] === '1') return { eligible: false, code: 'fork_or_background_override' };
  if (!prompt.isWellFormed() || !description.isWellFormed()) return { eligible: false, code: 'prompt_invalid_unicode' };
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return { eligible: false, code: 'prompt_too_large' };
  return { eligible: true, role, input, prompt, description, sessionId: hook.session_id, toolUseId: hook.tool_use_id };
};

/** Closed labels plus fixed wording (#11 example). No invented files, solutions, permissions or test obligations. */
export const renderTaskSuffix = (kind: TaskKind): string =>
  `\n\n[Jev Gate task hint]\nTask kind: ${kind}. The original request and applicable constraints remain authoritative.`;

/** New object; only `model` and `prompt` differ, and the original prompt is an exact prefix of the new one. */
export const patchAgentInput = (original: AgentInput, model: string, suffix: string): AgentInput => {
  if (Buffer.byteLength(suffix, 'utf8') > MAX_SUFFIX_BYTES) throw new Error('suffix exceeds MAX_SUFFIX_BYTES');
  return { ...original, model, prompt: `${String(original['prompt'])}${suffix}` };
};

/** The one JSON object a patch emits. Returns null when the serialized envelope exceeds the local bound. */
export const renderPreToolUseOutput = (updatedInput: AgentInput): string | null => {
  const text = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } });
  return Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES ? null : text;
};
