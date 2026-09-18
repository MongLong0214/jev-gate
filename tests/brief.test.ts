import { describe, expect, it } from 'vitest';

import {
  checkEligibility,
  DENIALS_BEFORE_STOP,
  GUARD_ALLOW_TOOLS,
  guardDecision,
  MAX_OUTPUT_BYTES,
  MAX_PROMPT_BYTES,
  patchAgentInput,
  renderAdditionalContext,
  renderPreToolUseOutput,
} from '../src/brief.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { ConfigV5, HookInput } from '../src/types.js';

const config: ConfigV5 = { ...DEFAULT_CONFIG, mode: 'auto' };
const env = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
const hook = (input: Record<string, unknown> = {}, top: Record<string, unknown> = {}): HookInput => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  session_id: 's1',
  tool_use_id: 'toolu_1',
  tool_input: { subagent_type: 'jev-gate:worker', description: 'd', prompt: 'do the thing', run_in_background: false, ...input },
  ...top,
});

describe('checkEligibility', () => {
  it('accepts each owned profile with its role and tier', () => {
    for (const [agent, expected] of [
      ['jev-gate:worker-fast', { role: 'worker', tier: 'fast' }],
      ['jev-gate:worker', { role: 'worker', tier: 'standard' }],
      ['jev-gate:worker-deep', { role: 'worker', tier: 'deep' }],
      ['jev-gate:worker-frontier', { role: 'worker', tier: 'frontier' }],
      ['jev-gate:planner', { role: 'planner', tier: 'deep' }],
      ['jev-gate:planner-frontier', { role: 'planner', tier: 'frontier' }],
    ] as const) {
      expect(checkEligibility(hook({ subagent_type: agent }), env, config), agent).toMatchObject({ eligible: true, ...expected, pinned: false });
    }
  });

  it('reports a caller pin instead of rejecting it, because a pinned call still receives the contract', () => {
    expect(checkEligibility(hook({ model: 'opus' }), env, config)).toMatchObject({ eligible: true, pinned: true });
  });

  it('treats an absent run_in_background as foreground only under the documented launch profile', () => {
    const input = hook();
    delete (input.tool_input as Record<string, unknown>)['run_in_background'];
    expect(checkEligibility(input, env, config)).toMatchObject({ eligible: true });
    expect(checkEligibility(input, {}, config)).toEqual({ eligible: false, code: 'not_foreground' });
  });

  it.each([
    ['mode off', hook(), {}, { ...config, mode: 'off' as const }, 'mode_off'],
    ['another agent', hook({ subagent_type: 'Explore' }), env, config, 'role_not_owned'],
    ['a child caller', hook({}, { agent_id: 'child' }), env, config, 'child_caller'],
    ['a custom agent session', hook({}, { agent_type: 'custom' }), env, config, 'custom_agent_session'],
    ['a background call', hook({ run_in_background: true }), env, config, 'not_foreground'],
    ['an execution control field', hook({ resume: 'agent-1' }), env, config, 'execution_control_present'],
    ['a blank prompt', hook({ prompt: '   ' }), env, config, 'bad_tool_input'],
    ['a concrete subagent override', hook(), { ...env, CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, config, 'subagent_model_override'],
    ['a forced fork', hook(), { ...env, CLAUDE_CODE_FORK_SUBAGENT: '1' }, config, 'fork_or_background_override'],
    ['an oversized prompt', hook({ prompt: 'z'.repeat(MAX_PROMPT_BYTES + 1) }), env, config, 'prompt_too_large'],
    ['a lone surrogate', hook({ prompt: 'bad \ud800' }), env, config, 'prompt_invalid_unicode'],
    ['a missing tool_use_id', hook({}, { tool_use_id: undefined }), env, config, 'missing_ids'],
  ])('rejects %s', (_name, input, e, c, code) => {
    expect(checkEligibility(input, e, c)).toEqual({ eligible: false, code });
  });
});

describe('guardDecision', () => {
  it('allows the read-only and bookkeeping tools, owned agents and configured extras', () => {
    for (const tool of GUARD_ALLOW_TOOLS) expect(guardDecision(tool, {}, config), tool).toEqual({ allow: true });
    expect(guardDecision('Agent', { subagent_type: 'jev-gate:worker-deep' }, config)).toEqual({ allow: true });
    expect(guardDecision('mcp__docs__search', {}, { ...config, guardAllowTools: ['mcp__docs__search'] })).toEqual({ allow: true });
  });

  it('declines writing tools, non-owned agents and unknown tools', () => {
    for (const tool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Skill', 'SendMessage', 'Workflow', 'mcp__unknown__do'])
      expect(guardDecision(tool, {}, config), tool).toEqual({ allow: false });
    expect(guardDecision('Agent', { subagent_type: 'Explore' }, config)).toEqual({ allow: false });
    expect(guardDecision('Agent', {}, config)).toEqual({ allow: false });
  });
});

describe('patchAgentInput', () => {
  it('copies the whole input and changes only the named fields', () => {
    const original = { subagent_type: 'jev-gate:worker', description: 'd', prompt: 'p', run_in_background: false, extra: { keep: true } };
    expect(patchAgentInput(original, { subagent_type: 'jev-gate:worker-deep', model: 'opus', prompt: 'p + contract' })).toEqual({
      ...original,
      subagent_type: 'jev-gate:worker-deep',
      model: 'opus',
      prompt: 'p + contract',
    });
    expect(patchAgentInput(original, { prompt: 'p + note' })).toMatchObject({ subagent_type: 'jev-gate:worker', prompt: 'p + note' });
    expect(patchAgentInput(original, {})).toEqual(original);
    expect(() => patchAgentInput(original, { prompt: 'different' })).toThrow(/exact prefix/);
  });
});

describe('rendering', () => {
  it('emits updatedInput, a deny, and a deny with continue:false once the denial budget is spent', () => {
    const update = JSON.parse(renderPreToolUseOutput({ kind: 'update', updatedInput: { prompt: 'p' } }) ?? '{}') as Record<string, Record<string, unknown>>;
    expect(update['hookSpecificOutput']).toEqual({ hookEventName: 'PreToolUse', updatedInput: { prompt: 'p' } });
    const deny = JSON.parse(renderPreToolUseOutput({ kind: 'deny', reason: 'no', stopReason: null }) ?? '{}') as Record<string, unknown>;
    expect(deny['hookSpecificOutput']).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'no' });
    expect(deny).not.toHaveProperty('continue');
    const stopped = JSON.parse(renderPreToolUseOutput({ kind: 'deny', reason: 'no', stopReason: 'stop now' }) ?? '{}') as Record<string, unknown>;
    expect(stopped).toMatchObject({ continue: false, stopReason: 'stop now' });
    expect(DENIALS_BEFORE_STOP).toBe(12);
  });

  it('returns null instead of an oversized envelope', () => {
    expect(renderPreToolUseOutput({ kind: 'update', updatedInput: { prompt: 'z'.repeat(MAX_OUTPUT_BYTES + 1) } })).toBeNull();
    expect(renderAdditionalContext('PostToolUse', 'ok')).toContain('"hookEventName":"PostToolUse"');
    expect(renderAdditionalContext('UserPromptSubmit', 'z'.repeat(MAX_OUTPUT_BYTES + 1))).toBeNull();
  });
});
