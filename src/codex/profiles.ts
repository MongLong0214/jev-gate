import { OWNED_AGENT_NAMES, LEAN_EXECUTOR_AGENT } from '../types.js';
declare const __JEV_AGENT_INSTRUCTIONS__: Record<string, string>;
/** Build embeds the existing seven agent instructions. No second copy of the execution contracts. */
export const CODEX_PROFILES: Record<string, string> = typeof __JEV_AGENT_INSTRUCTIONS__ === 'undefined' ? {} : __JEV_AGENT_INSTRUCTIONS__;

export const AGENT_TOOL = {
  type: 'function', name: 'jev_agent',
  description: 'Run a foreground Jev Gate planner, contracted worker or Lean executor in a fresh native Codex thread. Jev policies select the execution input and model; code checks the returned plan or task. Use the exact profile and marker from the current Jev guidance. Native permissions still apply. Do not spawn a second coordinator.',
  inputSchema: {
    type: 'object', properties: {
      subagent_type: { type: 'string', enum: [...OWNED_AGENT_NAMES, LEAN_EXECUTOR_AGENT] },
      prompt: { type: 'string', minLength: 1, maxLength: 65536 }, description: { type: 'string' }, model: { type: 'string' },
    }, required: ['subagent_type', 'prompt'], additionalProperties: false,
  },
};
export const codexGuidance = (s: string): string => s.replace(/\bAgent\b/g, 'jev_agent');
