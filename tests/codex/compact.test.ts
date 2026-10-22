import { describe, expect, it, vi } from 'vitest';
import { compactCandidates, compactScope, newCompactState, prepareCodexCompact } from '../../src/codex/compact.js';
import type { Obj } from '../../src/codex/source.js';

const fixture = (): Obj => ({ model: 'native-model', reasoning: { effort: 'xhigh' }, instructions: 'Keep user constraints.', extra: { owner: true }, input: [
  { type: 'reasoning', encrypted_content: 'opaque-do-not-touch', summary: [] },
  { type: 'compaction', encrypted_content: 'opaque-compact' },
  { type: 'agent_message', unknown: { nested: true } },
  { role: 'user', content: [{ type: 'input_text', text: 'Implement the new parser; keep its public contract.' }] },
  ...Array.from({ length: 10 }, (_, i) => [
    { type: 'custom_tool_call', call_id: `call${i}`, name: 'exec', input: 'Read documentation for the obsolete task.' },
    { type: 'custom_tool_call_output', call_id: `call${i}`, extra: { preserve: true }, output: [
      { type: 'input_text', text: 'receipt '.repeat(40) + ('Old completed unrelated setup information.\n'.repeat(400)) + 'completion receipt '.repeat(40) },
      { type: 'input_image', image_url: 'data:image/png;base64,unchanged', detail: 'original' },
      { type: 'future_content', preserve: true },
    ] },
  ]).flat(),
] });
const answer = (body: string, options: { invalid?: boolean; confidence?: number; keep?: boolean } = {}) => {
  const request = JSON.parse(body);
  return Response.json({ model: 'systemone', usage: { input_tokens: 300, output_tokens: 12 }, answers: Object.fromEntries(Object.keys(request.questions).map((id, i) => [id,
    options.invalid && i === 0 ? null : { type: 'choice', choice: options.keep ? 'keep' : 'remove', confidence: options.confidence ?? .99, probabilities: options.keep ? { keep: .99, remove: .005, unclear: .005 } : { keep: .005, remove: .99, unclear: .005 } },
  ])) });
};
const argsFor = (request = fixture()) => ({ request, task: 'Implement the new parser; keep its public contract.', recentRequests: [], state: newCompactState('task'), session: 's', prompt: 'p', config: { enabled: true, timeoutMs: 200 }, jevModel: 'systemone', env: { TYPESAFE_API_KEY: 'local-fake' }, path: 'inference' as const, signal: new AbortController().signal, current: () => true });

describe('Codex Jev Compact wire selector (#317)', () => {
  it('offers complete Unicode scalars when an emoji straddles the preserved head boundary', () => {
    const request = fixture(), output = (request.input as Obj[]).find(i => i.type === 'custom_tool_call_output')!;
    (output.output as Obj[])[0]!.text = 'h'.repeat(255) + '😀' + 'Completed unrelated setup details.\n'.repeat(200);
    const candidates = compactCandidates(request.input);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.text).toBe(Buffer.from(candidate.text, 'utf8').toString('utf8'));
    }
  });

  it('assesses unique OAuth evidence without treating separate Jev usage as subscription debit', async () => {
    const request = fixture();
    for (const [i, item] of (request.input as Obj[]).entries()) if (item.type === 'custom_tool_call_output') {
      (item.output as Obj[])[0]!.text = Array.from({ length: 90 }, (_, j) => `Archived sample ${i}:${j}: completed unrelated color survey with no parser dependency.\n`).join('');
    }
    const args = { ...argsFor(request), billing: 'chatgpt' as const }, before = structuredClone(request);
    const fetchImpl = vi.fn(async (_url, init) => answer(String(init?.body)));
    const first = await prepareCodexCompact({ ...args, fetchImpl });
    const retry = await prepareCodexCompact({ ...args, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(first.receipt.applied).toBe(true); expect(first.receipt.removed_chars).toBeGreaterThan(8192);
    expect(retry.request).toEqual(first.request); expect(request).toEqual(before);
    expect((first.request.input as Obj[]).slice(-12)).toEqual((request.input as Obj[]).slice(-12));
    expect((first.request.input as Obj[]).map(({ output: _output, ...item }) => item)).toEqual((request.input as Obj[]).map(({ output: _output, ...item }) => item));
  });

  it.each(['api', 'unknown'] as const)('keeps the existing one-shot assessment budget for %s traffic', async billing => {
    const request = fixture();
    for (const [i, item] of (request.input as Obj[]).entries()) if (item.type === 'custom_tool_call_output') {
      (item.output as Obj[])[0]!.text = Array.from({ length: 90 }, (_, j) => `Archived sample ${i}:${j}: completed unrelated color survey with no parser dependency.\n`).join('');
    }
    const fetchImpl = vi.fn();
    const out = await prepareCodexCompact({ ...argsFor(request), billing, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(out.request).toBe(request);
  });

  it('preserves unique one-shot evidence when even all removals cannot repay a new assessment (#321)', async () => {
    const request = fixture();
    for (const [i, item] of (request.input as Obj[]).entries()) if (item.type === 'custom_tool_call_output') {
      (item.output as Obj[])[0]!.text = Array.from({ length: 90 }, (_, j) => `Archived sample ${i}:${j}: completed unrelated color survey with no parser dependency.\n`).join('');
    }
    const rows: Obj[] = [], args = argsFor(request), fetchImpl = vi.fn();
    const out = await prepareCodexCompact({ ...args, fetchImpl, trace: { write: (_phase, body) => { rows.push(body); return { ok: true, file: 'fake' }; } } });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(out.request).toBe(request); expect(out.receipt.applied).toBe(false);
    expect(rows).toContainEqual(expect.objectContaining({ stage: 'prepared', reason: 'assessment_not_amortized', sent: false }));
    expect(args.state.calls).toBe(0); expect(args.state.decisions.size).toBe(0);
  });

  it('still applies previously verified exact decisions when an unseen batch cannot repay its assessment', async () => {
    const args = argsFor(), fetchImpl = vi.fn(async (_url, init) => answer(String(init?.body)));
    await prepareCodexCompact({ ...args, fetchImpl });
    const next = structuredClone(args.request), item = (next.input as Obj[]).find(i => i.type === 'custom_tool_call_output')!;
    (item.output as Obj[])[0]!.text = Array.from({ length: 180 }, (_, j) => `Unique archived sample ${j}: completed color survey; no parser dependency.\n`).join('');
    const out = await prepareCodexCompact({ ...args, request: next, fetchImpl });
    expect(out.receipt.applied).toBe(true); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((out.request.input as Obj[]).find(i => i.call_id === item.call_id && i.type === item.type)).toEqual(item);
  });

  it('keeps a useful repeated batch without paying to assess its unique tails', async () => {
    const args = argsFor(), item = (args.request.input as Obj[]).find(i => i.type === 'custom_tool_call_output')!;
    (item.output as Obj[])[0]!.text = Array.from({ length: 180 }, (_, j) => `Unique archived sample ${j}: completed color survey; no parser dependency.\n`).join('');
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).state.candidates.every((c: { text: string }) => !c.text.includes('Unique archived sample'))).toBe(true);
      return answer(String(init?.body));
    });
    const out = await prepareCodexCompact({ ...args, fetchImpl });
    expect(out.receipt.applied).toBe(true); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((out.request.input as Obj[]).find(i => i.call_id === item.call_id && i.type === item.type)).toEqual(item);
  });

  it('handles encrypted history, large mandatory context and mixed code-mode blocks without dropping topology or media', async () => {
    const request = fixture(); (request.input as unknown[]).unshift({ role: 'developer', content: 'mandatory '.repeat(50000) });
    const original = structuredClone(request);
    const fetchImpl = vi.fn(async (_url, init) => answer(String(init?.body)));
    const result = await prepareCodexCompact({ ...argsFor(request), fetchImpl });
    expect(result.receipt.applied).toBe(true); expect(result.receipt.removed_chars).toBeGreaterThan(20000);
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(request).toEqual(original);
    expect(result.request).toMatchObject({ model: request.model, reasoning: request.reasoning, instructions: request.instructions, extra: request.extra });
    const input = result.request.input as Obj[], before = request.input as Obj[];
    expect(input).toHaveLength(before.length);
    input.forEach((item, i) => {
      if (item.type !== 'custom_tool_call_output') expect(item).toBe(before[i]);
      else {
        expect(item.call_id).toBe(before[i]!.call_id); expect(item.extra).toEqual(before[i]!.extra);
        expect((item.output as unknown[]).slice(1)).toEqual((before[i]!.output as unknown[]).slice(1));
      }
    });
    expect(input.slice(-12)).toEqual(before.slice(-12));
  });
  it('reuses decisions on exact matching tool evidence across continuations, but binds scope to task and instructions', async () => {
    const args = argsFor(); const fetchImpl = vi.fn(async (_url, init) => answer(String(init?.body)));
    const first = await prepareCodexCompact({ ...args, fetchImpl });
    const second = await prepareCodexCompact({ ...args, fetchImpl });
    expect(second.request).toEqual(first.request); expect(second.receipt.removed_chars).toBe(first.receipt.removed_chars); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(compactScope(args.request, args.task, 'p')).not.toBe(compactScope(args.request, args.task, 'next'));
    expect(compactScope(args.request, args.task, 'p')).not.toBe(compactScope({ ...args.request, instructions: 'New requirements' }, args.task, 'p'));
    expect(compactScope(args.request, args.task, 'p')).not.toBe(compactScope(args.request, 'Different work', 'p'));
  });
  it.each([{ invalid: true }, { confidence: .89 }, { keep: true }])('preserves every byte when any answer is invalid or removal is not certain: %j', async options => {
    const args = argsFor(); const out = await prepareCodexCompact({ ...args, fetchImpl: async (_url, init) => answer(String(init?.body), options) });
    expect(out.request).toBe(args.request); expect(out.receipt.applied).toBe(false);
  });
  it('preserves orphan/duplicate results, failures, secrets and unknown output shapes', () => {
    const request = fixture(); const input = request.input as Obj[];
    input.splice(4, 0, { type: 'function_call_output', call_id: 'orphan', output: 'unpaired '.repeat(1000) });
    const out = input.find(i => i.type === 'custom_tool_call_output')!;
    out.is_error = true;
    const next = input.filter(i => i.type === 'custom_tool_call_output')[1]!;
    (next.output as Obj[])[0]!.text = 'Error: unresolved failure '.repeat(1000);
    const third = input.filter(i => i.type === 'custom_tool_call_output')[2]!;
    third.output = { future: 'unknown' };
    const fourth = input.filter(i => i.type === 'custom_tool_call_output')[3]!;
    input.splice(5, 0, fourth);
    expect(compactCandidates(input)).toEqual([]);
  });
  it('coalesces concurrent identical requests, rejects stale choices and never records text or keys', async () => {
    const args = argsFor(); const rows: unknown[] = [];
    let release!: () => void; const wait = new Promise<void>(r => { release = r; });
    const fetchImpl = vi.fn(async (_url, init) => { await wait; return answer(String(init?.body)); });
    const trace = { write: (_phase: unknown, body: Obj) => { rows.push(body); return { ok: true as const, file: 'fake' }; } };
    const first = prepareCodexCompact({ ...args, fetchImpl, trace });
    const second = prepareCodexCompact({ ...args, fetchImpl, trace });
    release(); expect((await first).receipt.applied).toBe(true); expect((await second).receipt.applied).toBe(true); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rows)).not.toContain('Old completed'); expect(JSON.stringify(rows)).not.toContain('local-fake');
    let current = true; const staleArgs = argsFor();
    const stale = await prepareCodexCompact({ ...staleArgs, current: () => current, fetchImpl: async (_url, init) => { current = false; return answer(String(init?.body)); } });
    expect(stale.request).toBe(staleArgs.request); expect(staleArgs.state.decisions.size).toBe(0);
  });
  it('uses one deadline, does not retry failures, and keeps no-key/disabled/incremental requests native', async () => {
    const args = argsFor();
    const fetchImpl = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    expect((await prepareCodexCompact({ ...args, config: { enabled: true, timeoutMs: 20 }, fetchImpl })).request).toBe(args.request);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const never = vi.fn();
    for (const changed of [{ env: {} }, { config: { enabled: false, timeoutMs: 20 } }, { request: { ...args.request, previous_response_id: 'opaque' } }]) {
      const input = { ...argsFor(), ...changed, fetchImpl: never };
      expect((await prepareCodexCompact(input)).request).toBe(input.request);
    }
    expect(never).not.toHaveBeenCalled();
  });
});
