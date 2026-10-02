import { OWNED_AGENT_NAMES, LEAN_EXECUTOR_AGENT } from '../types.js';
declare const __JEV_AGENT_INSTRUCTIONS__: Record<string, string>;
/** Build embeds the existing seven agent instructions. No second copy of the execution contracts. */
export const CODEX_PROFILES: Record<string, string> = typeof __JEV_AGENT_INSTRUCTIONS__ === 'undefined' ? {} : __JEV_AGENT_INSTRUCTIONS__;

export const AGENT_TOOL = {
  type: 'function', name: 'jev_agent',
  description: 'Start a Jev planner, contracted worker or Lean executor in a fresh native Codex thread. Background execution is the default: return immediately and answer new user messages while it works. Use action=status with agent_id to collect the observed result without waiting, or action=cancel for explicit user cancellation. Completion is accepted only by the original contract. Use the exact current profile and marker. Native permissions still apply.',
  inputSchema: {
    type: 'object', properties: {
      subagent_type: { type: 'string', enum: [...OWNED_AGENT_NAMES, LEAN_EXECUTOR_AGENT] },
      prompt: { type: 'string', minLength: 1, maxLength: 65536 }, description: { type: 'string' }, model: { type: 'string' },
      run_in_background: { type: 'boolean', default: true }, action: { type: 'string', enum: ['status', 'cancel'] }, agent_id: { type: 'string' },
    }, anyOf: [{ required: ['subagent_type', 'prompt'] }, { required: ['action', 'agent_id'] }], additionalProperties: false,
  },
};
export const codexGuidance = (s: string): string => s.replace(/\bAgent\b/g, 'jev_agent');
