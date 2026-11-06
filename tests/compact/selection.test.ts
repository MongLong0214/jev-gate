import { describe, expect, it, vi } from 'vitest';
import { buildDigest, assemble } from '../../mods/compact/hooks/digest.ts';
import { compactCandidates, createCompactSelector } from '../../mods/compact/hooks/selection.ts';
import { JEV_MODEL } from '../../mods/router/hooks/client.ts';
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
    expect(result).toMatchObject({ sent: true, model: JEV_MODEL, reason: 'current_dependencies', priorities: [{ message: 5, tool: 0 }], usage: { input_tokens: 10, output_tokens: 2 } });
    expect(result.candidates).toBe(16); expect(result.available).toBeGreaterThanOrEqual(result.candidates);
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
    // Only a response the client accepted names the Jev model that priced it.
    expect(result.model).toBe(reason === 'invalid_answers' ? JEV_MODEL : null);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('reads answers that carry fields it does not use, so a later Jev version cannot void the batch', async () => {
    const s = setup();
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const reply = dependencyReply(init.body);
      const body = JSON.parse(reply.text);
      for (const a of Object.values<Record<string, unknown>>(body.answers)) Object.assign(a, { legend: { required: 'x' }, rationale: 'a field a later Jev version may add' });
      return { status: 200, text: JSON.stringify({ ...body, request_id: 'r-1' }) };
    });
    expect(await createCompactSelector(1000)(s.messages, s.baseline, 'key', { fetch, sleep })).toMatchObject({ reason: 'current_dependencies', priorities: [{ message: 5, tool: 0 }] });
  });
  it.each(['null', 'array', 'missing', 'extra', 'replaced_id', 'choice', 'probabilities', 'confidence'])('records only bounded validation metadata for %s, retaining usage and conservative fallback', async kind => {
    const s = setup();
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(dependencyReply(init.body).text);
      const ids = Object.keys(body.answers), first = ids[0]!;
      if (kind === 'null') body.answers = null;
      else if (kind === 'array') body.answers = [];
      else if (kind === 'missing') delete body.answers[first];
      else if (kind === 'extra') body.answers.PRIVATE_EXTRA_CANDIDATE = body.answers[first];
      else if (kind === 'replaced_id') { body.answers.PRIVATE_EXTRA_CANDIDATE = body.answers[first]; delete body.answers[first]; }
      else {
        const answer = body.answers[ids.at(-1)!];
        if (kind === 'choice') answer.choice = 'PRIVATE_INVALID_CHOICE';
        if (kind === 'probabilities') delete answer.probabilities.unclear;
        if (kind === 'confidence') answer.confidence = 2;
      }
      return { status: 200, text: JSON.stringify(body) };
    });
    const result = await createCompactSelector(1000)(s.messages, s.baseline, 'key', { fetch, sleep });
    const shape = kind === 'null' || kind === 'array';
    expect(result).toMatchObject({ sent: true, reason: shape ? 'malformed' : 'invalid_answers', priorities: [], usage: { input_tokens: 10, output_tokens: 2 }, validation: {
      reason: shape ? 'response_shape' : kind === 'missing' || kind === 'extra' ? 'candidate_count' : kind === 'replaced_id' ? 'candidate_ids' : 'choice',
      expected_count: 16, answer_count: shape ? null : kind === 'missing' ? 15 : kind === 'extra' ? 17 : 16,
      missing_count: shape ? null : kind === 'missing' || kind === 'replaced_id' ? 1 : 0,
      extra_count: shape ? null : kind === 'extra' || kind === 'replaced_id' ? 1 : 0,
      invalid_choice_count: shape || ['missing', 'extra', 'replaced_id'].includes(kind) ? null : 1,
    } });
    const reason = { choice: 'label', probabilities: 'probability_labels', confidence: 'confidence' }[kind];
    if (reason) expect(result.validation?.choice_failures).toEqual({ [reason]: 1 });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('a tied answer leaves only that candidate undecided; the other answers stand', async () => {
    const tie = { choice: 'required', probabilities: { required: .5, related: .5, unrelated: 0, unclear: 0 } };
    const reply = (tied: (id: string) => boolean) => vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(dependencyReply(init.body).text);
      Object.keys(body.answers).forEach(id => { if (tied(id)) Object.assign(body.answers[id], tie); });
      return { status: 200, text: JSON.stringify(body) };
    });
    const s = setup();
    let others = 0;
    const some = await createCompactSelector(1000)(s.messages, s.baseline, 'key', { fetch: reply(id => id !== 'm5t0' && others++ < 3), sleep });
    expect(some).toMatchObject({ reason: 'current_dependencies', priorities: [{ message: 5, tool: 0 }], ties: 3, candidates: 16 });
    expect(some.validation).toBeUndefined();
    const dependency = await createCompactSelector(1000)(s.messages, s.baseline, 'key', { fetch: reply(id => id === 'm5t0'), sleep });
    expect(dependency).toMatchObject({ reason: 'recency_kept', priorities: [], ties: 1 });
    expect(dependency.validation).toBeUndefined();
    const broken = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(dependencyReply(init.body).text), ids = Object.keys(body.answers);
      Object.assign(body.answers[ids[0]!], tie); body.answers[ids[1]!].confidence = 2;
      return { status: 200, text: JSON.stringify(body) };
    });
    expect(await createCompactSelector(1000)(s.messages, s.baseline, 'key', { fetch: broken, sleep }))
      .toMatchObject({ reason: 'invalid_answers', priorities: [], ties: 1, validation: { reason: 'choice', invalid_choice_count: 1, choice_failures: { confidence: 1 } } });
    // A tied answer that fails any other check is malformed, not undecided: it voids the batch as before.
    const malformedTies: Array<[Record<string, unknown>, string]> = [
      [{ confidence: 2 }, 'confidence'], [{ confidence: -1 }, 'confidence'], [{ confidence: '0.5' }, 'confidence'],
      [{ confidence: null }, 'confidence'], [{ confidence: undefined }, 'confidence'], [{ choice: 'unrelated' }, 'choice_not_maximum'],
    ];
    for (const [patch, failure] of malformedTies) {
      const fetch = vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(dependencyReply(init.body).text), ids = Object.keys(body.answers);
        Object.assign(body.answers[ids.find(id => id !== 'm5t0')!], tie, patch);
        return { status: 200, text: JSON.stringify(body) };
      });
      expect(await createCompactSelector(1000)(s.messages, s.baseline, 'key', { fetch, sleep }))
        .toMatchObject({ reason: 'invalid_answers', priorities: [], ties: 0, validation: { invalid_choice_count: 1, choice_failures: { [failure]: 1 } } });
    }
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
