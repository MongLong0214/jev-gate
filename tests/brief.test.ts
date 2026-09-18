import { describe, expect, it } from 'vitest';

import { checkEligibility, EXECUTION_CONTROL_KEYS, MAX_OUTPUT_BYTES, MAX_PROMPT_BYTES, MAX_SUFFIX_BYTES, patchAgentInput, renderPreToolUseOutput, renderTaskSuffix } from '../src/brief.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { ConfigV4, HookInput } from '../src/types.js';

const auto: ConfigV4 = { ...DEFAULT_CONFIG, mode: 'auto' };
const base = (over: Partial<HookInput> = {}, input: Record<string, unknown> = {}): HookInput => ({
  hook_event_name: 'PreToolUse',
  session_id: 'test-session',
  tool_use_id: 'test-call',
  tool_name: 'Agent',
  tool_input: { subagent_type: 'jev-gate:worker', description: 'Implement camera controls', prompt: 'Implement pan and zoom. Preserve the camera API.', run_in_background: false, ...input },
  ...over,
});

describe('checkEligibility', () => {
  it('accepts the #11 example for both owned roles', () => {
    const r = checkEligibility(base(), {}, auto);
    expect(r).toMatchObject({ eligible: true, role: 'worker', sessionId: 'test-session', toolUseId: 'test-call' });
    expect(checkEligibility(base({}, { subagent_type: 'jev-gate:planner' }), {}, auto)).toMatchObject({ eligible: true, role: 'planner' });
  });

  it.each([
    ['mode off', base(), {}, { ...auto, mode: 'off' as const }, 'mode_off'],
    ['mode native', base(), {}, { ...auto, mode: 'native' as const }, 'mode_native'],
    ['other tool', base({ tool_name: 'Bash' }), {}, auto, 'not_agent_tool'],
    ['other event', base({ hook_event_name: 'PostToolUse' }), {}, auto, 'not_agent_tool'],
    ['child caller', base({ agent_id: 'a1' }), {}, auto, 'child_caller'],
    ['custom main agent', base({ agent_type: 'my-agent' }), {}, auto, 'custom_agent_session'],
    ['missing session', base({ session_id: '' }), {}, auto, 'missing_ids'],
    ['missing tool_use_id', { ...base(), tool_use_id: undefined }, {}, auto, 'missing_ids'],
    ['non-object input', base({ tool_input: 'x' }), {}, auto, 'bad_tool_input'],
    ['blank prompt', base({}, { prompt: '   ' }), {}, auto, 'bad_tool_input'],
    ['missing description', base({}, { description: undefined }), {}, auto, 'bad_tool_input'],
    ['other agent', base({}, { subagent_type: 'Explore' }), {}, auto, 'role_not_owned'],
    ['other plugin agent', base({}, { subagent_type: 'other:worker' }), {}, auto, 'role_not_owned'],
    ['V3 model-named agent', base({}, { subagent_type: 'jev-gate:opus' }), {}, auto, 'role_not_owned'],
    ['background', base({}, { run_in_background: true }), {}, auto, 'not_foreground'],
    ['background omitted', base({}, { run_in_background: undefined }), {}, auto, 'not_foreground'],
    ['model pinned', base({}, { model: 'opus' }), {}, auto, 'model_pinned'],
    ['model null is still a pin', base({}, { model: null }), {}, auto, 'model_pinned'],
    ['model empty is still a pin', base({}, { model: '' }), {}, auto, 'model_pinned'],
    ['concrete subagent model override', base(), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, auto, 'subagent_model_override'],
    ['force override', base(), { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }, auto, 'subagent_model_override'],
    ['fork mode forced on', base(), { CLAUDE_CODE_FORK_SUBAGENT: '1' }, auto, 'fork_or_background_override'],
    ['lone surrogate', base({}, { prompt: 'bad \ud800 text' }), {}, auto, 'prompt_invalid_unicode'],
    ['oversize prompt', base({}, { prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1) }), {}, auto, 'prompt_too_large'],
  ])('%s → no-op', (_name, hook, env, config, code) => {
    expect(checkEligibility(hook as HookInput, env as Record<string, string>, config)).toEqual({ eligible: false, code });
  });

  it.each(EXECUTION_CONTROL_KEYS.map((k) => [k]))('execution control %s → no-op', (key) => {
    expect(checkEligibility(base({}, { [key]: 'x' }), {}, auto)).toEqual({ eligible: false, code: 'execution_control_present' });
  });

  it('documented inherit override is harmless and unknown ordinary fields do not block', () => {
    expect(checkEligibility(base({}, { mode: 'acceptEdits', custom_field: { deep: 1 } }), { CLAUDE_CODE_SUBAGENT_MODEL: 'inherit', CLAUDE_CODE_FORK_SUBAGENT: '0' }, auto).eligible).toBe(true);
  });
});

describe('patchAgentInput / renderTaskSuffix / renderPreToolUseOutput', () => {
  it('produces the #11 example output exactly', () => {
    const original = { subagent_type: 'jev-gate:worker', description: 'Implement camera controls', prompt: 'Implement pan and zoom. Preserve the camera API.', run_in_background: false };
    const out = renderPreToolUseOutput(patchAgentInput(original, 'sonnet', renderTaskSuffix('implement')));
    expect(JSON.parse(out!)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          subagent_type: 'jev-gate:worker',
          description: 'Implement camera controls',
          prompt: 'Implement pan and zoom. Preserve the camera API.\n\n[Jev Gate task hint]\nTask kind: implement. The original request and applicable constraints remain authoritative.',
          run_in_background: false,
          model: 'sonnet',
        },
      },
    });
    expect(out).not.toMatch(/permissionDecision|"decision"|updatedPermissions|"continue"/);
  });

  it('preserves every other field, does not mutate, and keeps the original prompt as an exact prefix (CRLF/fence/Unicode/negation)', () => {
    const prompt = 'Do NOT change the API.\r\n```js\nconst x = "😀";\n```\n  -3.5 ≠ 3';
    const original = { subagent_type: 'jev-gate:worker', description: 'd', prompt, run_in_background: false, mode: 'default', nested: { a: [1, 2] }, marker: '[Jev Gate task hint]' };
    const frozen = JSON.stringify(original);
    const patched = patchAgentInput(original, 'claude-opus-5', renderTaskSuffix('investigate'));
    expect(JSON.stringify(original)).toBe(frozen);
    expect(patched).not.toBe(original);
    expect(String(patched['prompt']).startsWith(prompt)).toBe(true);
    expect(patched['model']).toBe('claude-opus-5');
    const { model: _m, prompt: _p, ...rest } = patched;
    const { prompt: _op, ...origRest } = original;
    expect(rest).toEqual(origRest);
    expect(Buffer.byteLength(renderTaskSuffix('other'), 'utf8')).toBeLessThanOrEqual(MAX_SUFFIX_BYTES);
    expect(() => patchAgentInput(original, 'x', 'y'.repeat(MAX_SUFFIX_BYTES + 1))).toThrow();
  });

  it('discards the whole output when the serialized envelope exceeds the bound', () => {
    const big = { subagent_type: 'jev-gate:worker', description: 'd', prompt: 'p', run_in_background: false, extra: 'z'.repeat(MAX_OUTPUT_BYTES) };
    expect(renderPreToolUseOutput(patchAgentInput(big, 'sonnet', renderTaskSuffix('other')))).toBeNull();
  });
});
