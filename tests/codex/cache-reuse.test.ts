import { describe, expect, it } from 'vitest';
import { cacheDiagnostics, compactBenefit, requestChange, requestShape } from '../../src/codex/cache-reuse.js';
import type { Obj } from '../../src/codex/source.js';

const request = (old: string, tail: string): Obj => ({ model: 'gpt-6.1-sol', reasoning: { effort: 'high' }, instructions: 'Native unchanged.', input: [
  { role: 'user', content: 'Keep the parser contract.' }, { type: 'function_call_output', call_id: 'old', output: old }, { role: 'user', content: tail },
] });

describe('Codex cache-aware input estimates', () => {
  it('holds a small early edit before a long potentially reusable suffix', () => {
    const before = request('x'.repeat(5000), 'tail'.repeat(30000)), after = request('x'.repeat(1000), 'tail'.repeat(30000));
    const result = compactBenefit(requestShape(before), requestShape(after), requestShape(before)!, 'chatgpt');
    expect(result).toMatchObject({ allow: false, reason: 'prefix_reprocessing_risk', first_changed_item: 1, cache_residency: 'unknown', total_token_saving: 'unmeasured', future_requests: 'not_assumed' });
    expect('estimated_credit_delta' in result && result.estimated_credit_delta).toBeGreaterThan(0);
  });
  it('holds even a favorable late-edit estimate without a bound on rendered token reprocessing', () => {
    const before = request('preserve'.repeat(10000), 'z'.repeat(20000)), after = request('preserve'.repeat(10000), 'short replacement marker');
    const result = compactBenefit(requestShape(before), requestShape(after), requestShape(before)!, 'chatgpt');
    expect(result).toMatchObject({ allow: false, reason: 'prefix_reprocessing_risk', first_changed_item: 2, authorization: 'rendered_token_bound_unavailable' });
    expect('estimated_credit_delta' in result && result.estimated_credit_delta).toBeLessThan(0);
  });
  it('reuses an identical previous transformed prefix instead of repeatedly charging for it', () => {
    const before = request('x'.repeat(10000), 'keep'.repeat(30000)), after = request('omitted', 'keep'.repeat(30000));
    const result = compactBenefit(requestShape(before), requestShape(after), requestShape(after)!, 'chatgpt');
    expect(result).toMatchObject({ allow: true, reason: 'previous_prefix_preserved', lost_prefix_estimated_tokens: 0 });
  });
  it('counts an overlapping shared suffix once for the whole edit', () => {
    const before = request('x'.repeat(5000), 'tail'.repeat(30000)), after = request('omitted', 'changed' + 'tail'.repeat(29000));
    const a = requestShape(before)!, b = requestShape(after)!;
    const result = compactBenefit(a, b, a, 'chatgpt');
    expect(result).toMatchObject({ lost_prefix_estimated_tokens: a.items[1]!.tokens + a.items[2]!.tokens });
  });
  it.each(['api', 'unknown'] as const)('does not invent a known reuse rate for %s traffic', billing => {
    const before = request('x'.repeat(5000), 'tail'.repeat(30000));
    expect(compactBenefit(requestShape(before), requestShape(request('short', 'tail'.repeat(30000))), requestShape(before)!, billing)).toMatchObject({ allow: false, reason: 'reuse_cost_unknown' });
  });
  it.each(['priority', 'flex', 'future_tier'])('does not apply standard credit rates to %s requests', service_tier => {
    const before = { ...request('x'.repeat(5000), 'tail'.repeat(30000)), service_tier };
    const after = { ...request('short', 'tail'.repeat(30000)), service_tier };
    expect(compactBenefit(requestShape(before), requestShape(after), requestShape(before)!, 'chatgpt')).toMatchObject({ allow: false, reason: 'reuse_cost_unknown' });
  });
  it('labels missing and model/effort-incompatible comparisons unobserved, never cold or cache-preserving', () => {
    const before = request('x'.repeat(5000), 'tail'), after = request('short', 'tail');
    const previous = requestShape({ ...before, model: 'gpt-6-luna' })!;
    expect(compactBenefit(requestShape(before), requestShape(after), previous, 'chatgpt')).toMatchObject({ allow: true, reason: 'reuse_unobserved', cache_residency: 'unknown' });
    expect(compactBenefit(requestShape(before), requestShape(after), undefined, 'chatgpt')).toMatchObject({ reason: 'reuse_unobserved' });
  });
  it('bounds retained metadata and never persists request text or hashes in change receipts', () => {
    const before = request('private payload', 'private tail'), after = request('short', 'private tail');
    const receipt = requestChange(before, after);
    expect(JSON.stringify(receipt)).not.toMatch(/private|digest|instructions|Native unchanged/);
    expect(requestShape({ ...before, previous_response_id: 'opaque' })).toBeNull();
    expect(requestShape(request('x'.repeat(2_000_001), 'tail'))).toBeNull();
    expect(requestShape({ ...before, input: Array(4097).fill({ content: 'bounded' }) })).toBeNull();
    expect(requestShape({ ...before, input: [undefined] })).toBeNull();
    const cyclic: Obj = {}; cyclic['self'] = cyclic;
    expect(requestShape({ ...before, input: [cyclic] })).toBeNull();
    expect(compactBenefit(null, requestShape(after), requestShape(before)!, 'chatgpt')).toMatchObject({ allow: false, reason: 'input_shape_unknown' });
  });
  it('projects only closed diagnostics and safe counts, and does not manufacture observed hits', () => {
    expect(cacheDiagnostics({ type: 'cache_miss', reason: 'input_changed', cache_missed_tokens: 10, raw_prompt: 'secret' })).toEqual({ type: 'cache_miss', reason: 'input_changed', cache_missed_tokens: 10 });
    expect(cacheDiagnostics({ type: 'cache_miss', reason: 'untrusted text', comparison_reusable_tokens: -1, cache_missed_tokens: 1.5 })).toEqual({ type: 'cache_miss', reason: 'unknown' });
    for (const value of [undefined, {}, { type: 'new diagnostic', reason: 'secret' }]) expect(cacheDiagnostics(value)).toEqual({ type: 'unknown' });
    expect(cacheDiagnostics({ type: 'unavailable' })).toEqual({ type: 'unavailable' });
    expect(cacheDiagnostics({ type: 'cache_hit' })).toEqual({ type: 'cache_hit' });
  });
});
