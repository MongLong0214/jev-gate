import { describe, expect, it } from 'vitest';
import { routedExecution } from '../../src/codex/execution-efficiency.js';
import type { Obj } from '../../src/codex/source.js';

describe('Codex routed execution guidance', () => {
  const native = (): Obj => ({ model: 'native', reasoning: { effort: 'high' }, input: [
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'native_tool' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Native permissions and tools.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep all user requirements.' }] },
    { type: 'reasoning', encrypted_content: 'native-opaque' },
  ], prompt_cache_key: 'native-cache', metadata: { keep: true } });

  it('supports native Responses Lite without rewriting any original instruction, tool, history or opaque item', () => {
    const original = native(), selected: Obj = { ...original, model: 'routed' }, snapshot = structuredClone(original);
    const result = routedExecution(original, selected);
    expect(original).toEqual(snapshot); expect(selected.input).toBe(original.input);
    expect(result).toEqual({ ...selected, input: [...(original.input as Obj[]), expect.objectContaining({ type: 'message', role: 'developer' })] });
    const input = result.input as Obj[];
    for (let i = 0; i < (original.input as Obj[]).length; i++) expect(input[i]).toBe((original.input as Obj[])[i]);
    expect(JSON.stringify(input.at(-1))).toContain('required verification remain authoritative');
    expect(JSON.stringify(input.at(-1))).toContain('Keep dependent operations sequential');
    expect(JSON.stringify(input.at(-1))).toContain('original public signatures, input types');
    expect(JSON.stringify(input.at(-1))).toContain('recover the original source with native tools before implementing');
    expect(JSON.stringify(input.at(-1))).toContain('passing a smoke test or tests written around your implementation is not proof');
  });

  it('keeps a stable instruction across tool rounds and never adds the guidance twice', () => {
    const original = native(), selected = { ...original, reasoning: { effort: 'medium' } };
    const first = routedExecution(original, selected);
    expect(routedExecution(original, first)).toBe(first);
    const later = { ...selected, input: [...(original.input as Obj[]), { type: 'function_call_output', call_id: 'native', output: 'Later result.' }] };
    expect((routedExecution(original, later).input as Obj[]).at(-1)).toEqual((first.input as Obj[]).at(-1));
  });

  it('supports full Responses requests and preserves their exact native instructions as the prefix', () => {
    const original: Obj = { ...native(), instructions: 'Exact native instructions.\n' }, selected: Obj = { ...original, model: 'routed' };
    const result = routedExecution(original, selected);
    expect(result.instructions).toBe(original.instructions);
    expect((result.input as Obj[]).slice(0, -1)).toEqual(original.input); expect(routedExecution(original, result)).toBe(result);
  });

  it('keeps the entire native prefix across route/keep/route and never stores a proxy hint in native history', () => {
    const original: Obj = { ...native(), instructions: 'Stable native instructions.' };
    const routed = routedExecution(original, { ...original, model: 'routed' });
    const later = { ...original, input: [...original.input as Obj[], { type: 'message', role: 'assistant', content: 'Native reply.' }] };
    const kept = routedExecution(later, later);
    const again = routedExecution(later, { ...later, model: 'routed' });
    expect(routed.instructions).toBe(kept.instructions);
    expect((routed.input as Obj[]).slice(0, -1)).toEqual((kept.input as Obj[]).slice(0, -1));
    expect((again.input as Obj[]).slice(0, -1)).toEqual(kept.input);
    expect(JSON.stringify(original)).not.toContain('Jev routed execution');
  });

  it('leaves unchanged, unknown, incremental and unsupported contexts alone', () => {
    const contexts: Obj[] = [native(), { ...native(), previous_response_id: 'server-owned' }, { model: 'native', input: 'text' }, { ...native(), instructions: {} }];
    for (const original of contexts) {
      expect(routedExecution(original, original)).toBe(original);
      const selected = { ...original, model: 'routed' };
      if (original.previous_response_id || !Array.isArray(original.input) || original.instructions !== undefined) expect(routedExecution(original, selected)).toBe(selected);
    }
    const original = native(); expect(routedExecution(original, { ...original, metadata: { changed: true } }).input).toBe(original.input);
  });
});
