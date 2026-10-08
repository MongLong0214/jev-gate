import type { Env } from './config.js';
import type { DispatchAllocation } from './dispatch-allocation.js';
import { claudeCandidates, resolveClaudeModel } from './claude-candidates.js';
import { claudeAgentToolModel, claudeTargetAllowed, currentClaudeModel } from './claude-models.js';
import { frontierRoutingEnabled } from './frontier-config.js';
/** Command hooks use launch environment facts. Native Function Hooks recheck effective settings at dispatch. */
export const claudeAllocation = (env: Env): DispatchAllocation => {
  const allowFable = frontierRoutingEnabled(env, env['CLAUDE_PLUGIN_OPTION_ROUTERALLOWFABLE'] === 'true');
  const api = !['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE'].some(k => env[k] === '1');
  const aliases = { ...(env['ANTHROPIC_DEFAULT_OPUS_MODEL'] || api ? { opus: env['ANTHROPIC_DEFAULT_OPUS_MODEL'] || currentClaudeModel('opus') } : {}),
    ...(env['ANTHROPIC_DEFAULT_SONNET_MODEL'] || api ? { sonnet: env['ANTHROPIC_DEFAULT_SONNET_MODEL'] || currentClaudeModel('sonnet') } : {}),
    ...(env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] || api ? { haiku: env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] || currentClaudeModel('haiku') } : {}),
    ...(env['ANTHROPIC_DEFAULT_FABLE_MODEL'] || api ? { fable: env['ANTHROPIC_DEFAULT_FABLE_MODEL'] || currentClaudeModel('fable') } : {}) };
  return {
    canonical: model => resolveClaudeModel(model, aliases),
    toolModel: claudeAgentToolModel,
    candidates: baseline => claudeCandidates({ baseline, aliases, allowFable, scope: 'spawn' }).filter(c => claudeTargetAllowed(c.id, allowFable)),
    allowed: model => { const id = resolveClaudeModel(model, aliases); return id !== null && claudeTargetAllowed(id, allowFable); },
  };
};
