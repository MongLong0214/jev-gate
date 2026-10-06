import { describe, expect, it, vi } from 'vitest';
import { buildDigest, assemble } from '../../mods/compact/hooks/digest.ts';
import { compactCandidates, createCompactSelector } from '../../mods/compact/hooks/selection.ts';
import { dependencyConversation, dependencyFact, dependencyReply } from '../fixtures/compact-dependencies.ts';
import type { Transport } from '../../mods/router/hooks/client.ts';
const sleep: Transport['sleep'] = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('abort')); }, { once: true });
});
const setup = () => {
  const messages = dependencyConversation(); const baseline = buildDigest(messages, { budgetChars: 8000 });
  if (!baseline.ok) throw new Error(baseline.reason);
  const fetch = vi.fn(async (_url: string, init: { body: string }) => dependencyReply(init.body));
  return { messages, baseline: baseline.result, fetch, transport: { fetch, sleep } };
};
describe('bounded current-task compaction dependency selection', () => {
  it('recovers an aged dependency at the same budget while preserving user text, tail and pairing', async () => {
    const s = setup(); expect(s.baseline.digest).not.toContain(dependencyFact);
    const result = await createCompactSelector(1000)(s.messages, s.baseline, 'key', s.transport);
    expect(result).toMatchObject({ sent: true, reason: 'current_dependencies', priorities: [{ message: 5, tool: 0 }], usage: { input_tokens: 10, output_tokens: 2 } });
    expect(result.candidates).toBeLessThanOrEqual(16); expect(result.available).toBeGreaterThanOrEqual(result.candidates);
    const enhanced = buildDigest(s.messages, { budgetChars: 8000, priorityResults: result.priorities });
    expect(enhanced.ok).toBe(true); if (!enhanced.ok) return;
    expect(enhanced.result.digest).toContain(dependencyFact);
    expect(enhanced.result.digest).toContain(s.messages[0]!.text);
    expect(enhanced.result.digestChars + enhanced.result.tailChars).toBeLessThanOrEqual(8000);
    expect(enhanced.result.start).toBe(s.baseline.start);
    expect(assemble(s.messages, enhanced.result).slice(1)).toEqual(assemble(s.messages, s.baseline).slice(1));
    const request = JSON.parse(s.fetch.mock.calls[0]![1].body);
    expect(request).not.toHaveProperty('key'); expect(JSON.stringify(request)).not.toContain('Bearer');
  });
  it.each(['no_key', 'aborted', 'input_secret', 'invalid_answers', 'network', 'timeout'])('keeps the local order on %s without retry', async reason => {
    const s = setup(); const controller = new AbortController(); let key: string | undefined = 'key';
    if (reason === 'no_key') key = undefined;
    if (reason === 'aborted') controller.abort();
    if (reason === 'input_secret') s.messages.unshift({ role: 'user', text: 'Authorization: Bearer sk_live_abcdefghijklmnopqrstuv', toolUses: [] });
    if (reason === 'input_secret') s.messages.push({ role: 'user', text: 'Authorization: Bearer sk_live_abcdefghijklmnopqrstuv', toolUses: [] });
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      if (reason === 'network') throw new Error('network');
      if (reason === 'timeout') return new Promise<never>(() => {});
      return dependencyReply(init.body, reason === 'invalid_answers');
    });
    const result = await createCompactSelector(10)(s.messages, s.baseline, key, { fetch, sleep }, controller.signal);
    expect(result.priorities).toEqual([]); expect(result.reason).toBe(reason);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('withholds full secret-bearing and interrupted evidence before excerpting', () => {
    const s = setup(); const m = s.messages[5]!; const u = m.toolUses[0]!;
    s.messages[5] = { ...m, toolUses: [{ ...u, text: 'x'.repeat(1400) + '\nAuthorization: Bearer sk_live_abcdefghijklmnopqrstuv' }] };
    expect(compactCandidates(s.messages, s.baseline)?.candidates.some(c => c.message === 5)).toBe(false);
    s.messages[5] = { ...m, toolUses: [{ ...u, result: { interrupted: true } }] };
    expect(compactCandidates(s.messages, s.baseline)?.candidates.some(c => c.message === 5)).toBe(false);
    s.messages[5] = { ...m, toolUses: [{ ...u, outcome: 'unknown' }] };
    expect(compactCandidates(s.messages, s.baseline)?.candidates.some(c => c.message === 5)).toBe(false);
  });
  it('does not apply a valid late response after cancellation', async () => {
    const s = setup(); const controller = new AbortController();
    const transport = { sleep, fetch: async (_url: string, init: { body: string }) => { controller.abort(); return dependencyReply(init.body); } };
    expect(await createCompactSelector(1000)(s.messages, s.baseline, 'key', transport, controller.signal)).toMatchObject({ priorities: [], reason: 'aborted' });
  });
  it('cannot use priorities to remove mandatory error evidence or exceed the budget', () => {
    const s = setup(); const m = s.messages[5]!, u = m.toolUses[0]!;
    s.messages[5] = { ...m, toolUses: [{ ...u, isError: true, text: 'Critical failed observation.' }] };
    const enhanced = buildDigest(s.messages, { budgetChars: 8000, priorityResults: [{ message: 5, tool: 0 }, { message: 999, tool: 0 }] });
    expect(enhanced.ok).toBe(true); if (enhanced.ok) { expect(enhanced.result.digest).toContain('Critical failed observation.'); expect(enhanced.result.digestChars + enhanced.result.tailChars).toBeLessThanOrEqual(8000); }
  });
});

it('offers fewer complete candidates when wide text crosses the exact provider estimate', async () => {
  const s = setup(); s.messages[0] = { ...s.messages[0]!, text: '현재 작업 '.repeat(2000) };
  const result = await createCompactSelector(1000)(s.messages, s.baseline, 'key', s.transport);
  expect(s.fetch).toHaveBeenCalledOnce(); expect(result.sent).toBe(true);
  expect(result.candidates).toBeLessThan(16); expect(result.available).toBe(20);
});

it('allows a corrected credential after an earlier credential was refused', async () => {
  const s = setup(); const select = createCompactSelector(1000); let calls = 0;
  const transport = { sleep, fetch: async (_url: string, init: { body: string }) => { calls++; return calls === 1 ? { status: 401, text: '{}' } : dependencyReply(init.body); } };
  expect((await select(s.messages, s.baseline, 'bad', transport)).reason).toBe('unauthorized');
  expect((await select(s.messages, s.baseline, 'bad', transport)).reason).toBe('credential_refused');
  expect((await select(s.messages, s.baseline, 'corrected', transport)).reason).toBe('current_dependencies');
  expect(calls).toBe(2);
});
