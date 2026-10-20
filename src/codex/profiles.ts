import { OWNED_AGENT_NAMES } from '../types.js';
declare const __JEV_AGENT_INSTRUCTIONS__: Record<string, string>;
/** Build embeds the existing six agent instructions. No second copy of the execution contracts. */
export const CODEX_PROFILES: Record<string, string> = typeof __JEV_AGENT_INSTRUCTIONS__ === 'undefined' ? {} : __JEV_AGENT_INSTRUCTIONS__;

export const AGENT_TOOL = {
  type: 'function', name: 'jev_agent',
  description: 'Start a Jev planner or contracted worker in a fresh native Codex thread: subagent_type is the owned profile; prompt is the task, beginning unchanged with any [JEV_TASK ...] marker. Runs in the background by default; answer new user messages meanwhile. action=status|cancel with agent_id collects its result or cancels on explicit user request. Only the original contract accepts completion. Native permissions still apply.',
  inputSchema: {
    type: 'object', properties: {
      subagent_type: { type: 'string', enum: [...OWNED_AGENT_NAMES] },
      prompt: { type: 'string', minLength: 1, maxLength: 65536 }, description: { type: 'string' }, model: { type: 'string' },
      run_in_background: { type: 'boolean', default: true }, action: { type: 'string', enum: ['status', 'cancel'] }, agent_id: { type: 'string' },
    }, anyOf: [{ required: ['subagent_type', 'prompt'] }, { required: ['action', 'agent_id'] }], additionalProperties: false,
  },
};
export const codexGuidance = (s: string): string => s.replace(/\bAgent\b/g, 'jev_agent');
