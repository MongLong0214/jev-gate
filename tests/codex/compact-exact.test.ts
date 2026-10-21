import { describe, expect, it, vi } from 'vitest';
import { compactCandidates, newCompactState, prepareCodexCompact } from '../../src/codex/compact.js';
import type { Obj } from '../../src/codex/source.js';

const content = 'Unique contract: preserve e\u0301 and 東京; default timeout 37; reject empty input.\n' + 'Documented entry.\n'.repeat(180);
const request = (): Obj => ({ instructions: 'Preserve all contracts.', model: 'native', input: [
  { role: 'user', content: 'Recover the contract from all old reads.' },
  ...Array.from({ length: 10 }, (_, i) => [
    { type: 'function_call', call_id: `read_${i}`, name: 'exec', arguments: 'Read contract.' },
    { type: 'function_call_output', call_id: `read_${i}`, output: content, extra: { preserve: i } },
  ]).flat(),
] });
const run = (input: Obj, extra: Obj = {}) => prepareCodexCompact({ request: input, task: 'Recover all the contract facts.', recentRequests: [], state: newCompactState('p'), session: 's', prompt: 'p', config: { enabled: true, timeoutMs: 100 }, jevModel: 'systemone', env: { TYPESAFE_API_KEY: 'fake-local' }, path: 'inference', signal: new AbortController().signal, current: () => true, ...extra });

describe('exact old tool result references', () => {
  it('retains a byte-identical original, call topology, metadata, and the latest six results without a paid judgment', async () => {
    const original = request(), snapshot = structuredClone(original), fetchImpl = vi.fn(), rows: Obj[] = [];
    const result = await run(original, { fetchImpl, trace: { write: (_p: string, row: Obj) => { rows.push(row); } } });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(original).toEqual(snapshot);
    expect(result.receipt).toMatchObject({ applied: true, exact_references: 3 });
    const before = original.input as Obj[], after = result.request.input as Obj[];
    expect(after).toHaveLength(before.length); expect(after[2]).toBe(before[2]);
    expect(after.slice(-12)).toEqual(before.slice(-12));
    for (const i of [4, 6, 8]) {
      expect(after[i]).toEqual({ ...before[i], output: expect.stringContaining('retained call_id "read_0"') });
      expect(after[i]!.output).not.toContain('omitted');
    }
    after.forEach((item, i) => { if (item.type === 'function_call') expect(item).toBe(before[i]); });
    expect(JSON.stringify(rows)).not.toContain('東京'); expect(JSON.stringify(rows)).not.toContain('fake-local');
    expect(rows).toContainEqual(expect.objectContaining({ reason: 'exact_duplicate_reference', total_token_saving: 'unmeasured' }));
  });

  it('does not mistake similar outputs or different tool invocations for identical evidence', async () => {
    const original = request(), items = original.input as Obj[];
    items[4]!.output = content + ' An extra requirement.';
    items[5]!.arguments = 'Read a different contract.';
    items[7]!.name = 'different_tool';
    expect((await run(original, { fetchImpl: vi.fn() })).request).toBe(original);
  });

  it.each(['compaction', 'user', 'system', 'developer', 'future'])('never refers across a %s boundary', async boundary => {
    const original = request(), items = original.input as Obj[];
    items.splice(3, 0, ['compaction', 'future'].includes(boundary) ? { type: boundary, encrypted_content: 'opaque' } : { role: boundary, content: 'New context.' });
    const result = await run(original, { fetchImpl: vi.fn() }), after = result.request.input as Obj[];
    expect(after[5]).toBe(items[5]);
    expect(after[7]!.output).toContain('retained call_id "read_1"');
    expect(after[9]!.output).toContain('retained call_id "read_1"');
  });

  it.each(['error', 'secret', 'orphan', 'duplicate_call', 'duplicate_result', 'media', 'unknown'])('preserves %s evidence', async kind => {
    const original = request(), items = original.input as Obj[];
    if (kind === 'error') for (const x of items) if (x.type === 'function_call_output') x.is_error = true;
    if (kind === 'secret') for (const x of items) if (x.type === 'function_call_output') x.output = content + '\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    if (kind === 'orphan') original.input = items.filter(x => x.type !== 'function_call');
    if (kind === 'duplicate_call') items.push(...items.filter(x => x.type === 'function_call'));
    if (kind === 'duplicate_result') items.push(...items.filter(x => x.type === 'function_call_output'));
    if (kind === 'media' || kind === 'unknown') for (const x of items) if (x.type === 'function_call_output') x.output = [{ type: 'input_text', text: content }, { type: kind === 'media' ? 'input_image' : 'future', data: 'opaque' }];
    expect((await run(original, { fetchImpl: async () => Response.json({ invalid: true }) })).request).toBe(original);
  });

  it('retains the original text blocks with their metadata and identifies the corresponding duplicate blocks', async () => {
    const original = request();
    for (const x of original.input as Obj[]) if (x.type === 'function_call_output') x.output = [{ type: 'input_text', text: content, extra: 1 }, { type: 'input_text', text: 'Second block: sentinel BETA-948.', extra: 2 }];
    const result = await run(original, { fetchImpl: vi.fn() }), after = result.request.input as Obj[];
    expect(after[2]).toBe((original.input as Obj[])[2]);
    expect(after[4]!.output).toEqual([{ type: 'input_text', text: expect.stringContaining('Text block 0'), extra: 1 }, { type: 'input_text', text: expect.stringContaining('Text block 1'), extra: 2 }]);
  });

  it('encodes a repeated canonical original with an exact count and preserves Unicode and separators', async () => {
    const original = request(), unit = 'Entry: 東京, e\u0301; quantity=37; trailing separator retained.\r\n';
    for (const x of original.input as Obj[]) if (x.type === 'function_call_output') x.output = unit.repeat(100);
    const result = await run(original, { fetchImpl: vi.fn() });
    const text = String((result.request.input as Obj[])[2]!.output);
    const encoded = JSON.parse(text.split('\n')[1]!) as { unit: string; count: number };
    expect(encoded).toEqual({ unit, count: 100 }); expect(encoded.unit.repeat(encoded.count)).toBe(unit.repeat(100));
    expect(result.receipt).toMatchObject({ applied: true, exact_references: 3, exact_repetitions: 1 });
    expect((result.request.input as Obj[]).slice(-12)).toEqual((original.input as Obj[]).slice(-12));
  });

  it('never applies a cached semantic removal to the original needed by its exact references', async () => {
    const original = request(), state = newCompactState('p'), fetchImpl = vi.fn();
    for (const c of compactCandidates(original.input)) { state.decisions.set(c.id, true); state.selections.set(c.id, 'earlier-assessment'); }
    const result = await run(original, { state, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((result.request.input as Obj[])[2]).toBe((original.input as Obj[])[2]);
    expect(result.receipt).toMatchObject({ exact_references: 3, selection_ids: [] });
  });

  it('preserves the entire original if a concurrent semantic assessment is invalid', async () => {
    const original = request(), items = original.input as Obj[];
    items.splice(1, 0, ...Array.from({ length: 4 }, (_, i) => [
      { type: 'function_call', call_id: `mixed_${i}`, name: 'exec', arguments: 'Read previous context.' },
      { type: 'function_call_output', call_id: `mixed_${i}`, output: [{ type: 'input_text', text: 'Older documented context with retained facts.\n'.repeat(300) }, { type: 'input_image', image_url: 'data:image/png;base64,untouched' }] },
    ]).flat());
    const fetchImpl = vi.fn(async () => Response.json({ invalid: true }));
    const result = await run(original, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.request).toBe(original); expect(result.receipt.applied).toBe(false);
  });

  it('bounds exact analysis and preserves every unexamined result', async () => {
    const original = request(), state = newCompactState('p'), fetchImpl = vi.fn();
    const large = 'Preserved entry: quantity 37; exact separators.\n'.repeat(13000);
    for (const x of original.input as Obj[]) if (x.type === 'function_call_output') x.output = large;
    state.calls = 4; // No new semantic assessments after the existing per-context limit.
    const result = await run(original, { state, fetchImpl }), after = result.request.input as Obj[], before = original.input as Obj[];
    expect(fetchImpl).not.toHaveBeenCalled(); expect(result.receipt.exact_references).toBe(2);
    expect(after[8]).toBe(before[8]); expect(after.slice(-12)).toEqual(before.slice(-12));
  });

  it('does not encode unique, whitespace-only, short, failed or imperfectly repeated originals', async () => {
    for (const content of [' '.repeat(8000), 'short '.repeat(400), 'Complete retained fact.\n'.repeat(400) + 'Unique suffix.', 'Error: keep failure facts.\n'.repeat(400)]) {
      const original = request(); for (const x of original.input as Obj[]) if (x.type === 'function_call_output') x.output = content;
      const result = await run(original, { fetchImpl: vi.fn() });
      expect((result.request.input as Obj[])[2]!.output).toBe(content);
      expect(result.receipt.exact_repetitions).toBeUndefined();
    }
  });

  it('preserves disabled, no-key, incremental and stale requests', async () => {
    for (const changed of [{ env: {} }, { config: { enabled: false, timeoutMs: 100 } }, { current: () => false }, { signal: AbortSignal.abort() }]) {
      const original = request(); expect((await run(original, { ...changed, fetchImpl: vi.fn() })).request).toBe(original);
    }
    const original = { ...request(), previous_response_id: 'server-owned' }; expect((await run(original, { fetchImpl: vi.fn() })).request).toBe(original);
  });
});
