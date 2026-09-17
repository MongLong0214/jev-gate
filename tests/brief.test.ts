import { describe, expect, it } from 'vitest';

import { splitLossless } from '../src/blocks.js';
import { MAX_BRIEF_BYTES, NEUTRAL_REMINDER, renderAdditionalContext } from '../src/brief.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { GateDecision } from '../src/types.js';
import { NATIVE_FALLBACK_DECISION } from '../src/types.js';

const EXAMPLE = '검색 응답이 역순으로 오면 옛 결과가 화면을 덮는 버그를 고쳐줘.\nAPI 응답 형식과 의존성은 바꾸지 마.\n늦은 응답을 재현하는 테스트도 추가해.';
const blocks = splitLossless(EXAMPLE);
const roles = { u1: 'goal', u2: 'constraint', u3: 'acceptance' } as const;
const delegateOpus: GateDecision = { kind: 'debug', roles, rawRoute: null, execution: 'delegate', tier: 'opus', agentName: 'jev-gate:opus', reason: 'selected' };

describe('renderAdditionalContext', () => {
  it('renders the spec example with exact quotes and delegation directives', () => {
    const text = renderAdditionalContext(delegateOpus, blocks, DEFAULT_CONFIG);
    expect(text).toBe(
      [
        '[Jev Gate: applies only to the accompanying user turn]',
        'Task kind: debug (fallible annotation)',
        'Execution: delegate to jev-gate:opus; requested model: opus',
        'Request annotations, original order:',
        '- u1 goal: "검색 응답이 역순으로 오면 옛 결과가 화면을 덮는 버그를 고쳐줘.\\n"',
        '- u2 constraint: "API 응답 형식과 의존성은 바꾸지 마.\\n"',
        '- u3 acceptance: "늦은 응답을 재현하는 테스트도 추가해."',
        'Treat the original user message and applicable prior instructions as authoritative.',
        'Delegate once in foreground before doing the same investigation yourself.',
        'Pass the original request intact, these annotations, and required prior context.',
        "Do not perform parallel or duplicate edits. Return the worker's observed result.",
        'User instructions, plan mode, permissions and model availability take precedence; if the agent or model is unavailable, report it instead of retrying another tier.',
      ].join('\n'),
    );
  });

  it('names the trusted model override and the uncertain policy when they apply', () => {
    const text = renderAdditionalContext({ ...delegateOpus, tier: 'fable', agentName: 'jev-gate:frontier', reason: 'uncertain' }, blocks, { ...DEFAULT_CONFIG, frontierModel: 'claude-fable-5-1' });
    expect(text).toContain('Execution: delegate to jev-gate:frontier; requested model: claude-fable-5-1; pass it as the Agent tool model parameter');
    expect(text).toContain('uncertain-route policy');
  });

  it('omits delegation and model text in enrich, main and main_context', () => {
    const enrich = renderAdditionalContext({ ...delegateOpus, execution: 'main', tier: null, agentName: null, reason: 'enrich_only' }, blocks, DEFAULT_CONFIG)!;
    expect(enrich).toContain('mode=enrich');
    expect(enrich).not.toMatch(/delegate|requested model|jev-gate:/);
    const main = renderAdditionalContext({ ...delegateOpus, execution: 'main', tier: 'sonnet', agentName: null }, blocks, DEFAULT_CONFIG)!;
    expect(main).toContain('handle in the current main session');
    expect(main).not.toMatch(/Delegate once/);
    const ctx = renderAdditionalContext({ ...delegateOpus, execution: 'main_context', tier: null, agentName: null, reason: 'context_required' }, blocks, DEFAULT_CONFIG)!;
    expect(ctx).toContain('context_required is not a difficulty rating');
    expect(ctx).not.toMatch(/jev-gate:/);
  });

  it('returns the fixed neutral reminder for native fallback', () => {
    expect(renderAdditionalContext(NATIVE_FALLBACK_DECISION, blocks, DEFAULT_CONFIG)).toBe(NEUTRAL_REMINDER);
  });

  it('switches long quotes to whole-block offset references instead of truncating', () => {
    const long = 'x'.repeat(9000);
    const prompt = `짧은 목표\n${long}\n검증 조건`;
    const b = splitLossless(prompt);
    const decision: GateDecision = { ...delegateOpus, roles: { u1: 'goal', u2: 'background', u3: 'acceptance' } };
    const text = renderAdditionalContext(decision, b, DEFAULT_CONFIG)!;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_BRIEF_BYTES);
    expect(text).toContain(`- u2 background; current prompt UTF-16[${b[1]!.start},${b[1]!.end})`);
    expect(text).toContain('- u1 goal: "짧은 목표\\n"');
    expect(text).not.toContain('xxxxxxxxxx…');
    expect(text).not.toContain(long.slice(0, 100));
  });
});
