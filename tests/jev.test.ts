import { describe, expect, it, vi } from 'vitest';

import { buildAdmissionRequest } from '../src/admission.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { callJev, JEV_ENDPOINT, MAX_REQUEST_BYTES, PLANNER_TIER_PROFILES, TIER_PROFILES, topChoices, validateChoice } from '../src/jev.js';
import { ROUTE_ANSWERS, TIERS, type RouteAnswer } from '../src/types.js';

const KEY = 'ts-secret-key-123';
const request = buildAdmissionRequest('Add pan and zoom to the canvas.', DEFAULT_CONFIG);
const deps = { apiKey: KEY, deadlineMs: 500 };
const ok = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

const choice = (winner: RouteAnswer, p = 0.9, confidence = p): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: Object.fromEntries(ROUTE_ANSWERS.map((k) => [k, k === winner ? p : (1 - p) / (ROUTE_ANSWERS.length - 1)])),
  confidence,
});

describe('callJev', () => {
  it('sends exactly one POST to the fixed endpoint with the key only in the header', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(JEV_ENDPOINT);
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${KEY}`);
      expect(String(init.body)).not.toContain(KEY);
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { execution: {} }, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
    });
    const r = await callJev(request, { ...deps, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, status: 200, response: { model: 'jev-1.13.0', usage: { input_tokens: 5 } } });
  });

  it.each([
    [401, 'http_401'],
    [422, 'http_422'],
    [429, 'http_429'],
    [529, 'http_529'],
    [503, 'http_other'],
  ])('maps status %s to %s without a retry', async (status, code) => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status }));
    expect(await callJev(request, { ...deps, fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ ok: false, code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports timeout, network failure, invalid body and an oversized request', async () => {
    const hang = (_u: string, init: RequestInit): Promise<Response> =>
      new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await callJev(request, { ...deps, deadlineMs: 20, fetchImpl: hang as unknown as typeof fetch })).toMatchObject({ ok: false, code: 'timeout' });
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await callJev(request, { ...deps, fetchImpl: boom })).toMatchObject({ ok: false, code: 'network' });
    expect(await callJev(request, { ...deps, fetchImpl: ok({ model: 'x' }) })).toMatchObject({ ok: false, code: 'response_invalid' });
    const huge = buildAdmissionRequest('z'.repeat(MAX_REQUEST_BYTES + 1), DEFAULT_CONFIG);
    const never = vi.fn();
    expect(await callJev(huge, { ...deps, fetchImpl: never as unknown as typeof fetch })).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(never).not.toHaveBeenCalled();
  });

  it('does not call fetch when the caller already cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = vi.fn();
    expect(await callJev(request, { ...deps, signal: ac.signal, fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ ok: false, code: 'aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('validateChoice', () => {
  it('accepts a well-formed answer and returns the tied keys', () => {
    const answer = validateChoice(choice('deep'), ROUTE_ANSWERS);
    expect(answer).toMatchObject({ choice: 'deep', confidence: 0.9 });
    if (answer) expect(topChoices(answer)).toEqual(['deep']);
    const tie = validateChoice(
      { type: 'choice', choice: 'fast', probabilities: { fast: 0.4, standard: 0.4, deep: 0.1, frontier: 0.05, abstain: 0.05 }, confidence: 0.9 },
      ROUTE_ANSWERS,
    );
    expect(tie && topChoices(tie).sort()).toEqual(['fast', 'standard']);
  });

  it.each([
    ['wrong type', { type: 'text', choice: 'fast' }],
    ['unknown choice', { ...choice('deep'), choice: 'genius' }],
    ['missing key', { type: 'choice', choice: 'fast', probabilities: { fast: 1 }, confidence: 0.9 }],
    ['probabilities that do not sum to one', { type: 'choice', choice: 'fast', probabilities: { fast: 0.5, standard: 0.1, deep: 0, frontier: 0, abstain: 0 }, confidence: 0.9 }],
    ['choice that is not the argmax', { type: 'choice', choice: 'fast', probabilities: { fast: 0.1, standard: 0.9, deep: 0, frontier: 0, abstain: 0 }, confidence: 0.9 }],
    ['confidence out of range', { ...choice('deep'), confidence: 1.4 }],
  ])('rejects %s', (_name, value) => {
    expect(validateChoice(value, ROUTE_ANSWERS)).toBeNull();
  });
});

describe('tier profiles', () => {
  it('describe capability without naming a vendor or model', () => {
    const text = [...Object.values(TIER_PROFILES), ...Object.values(PLANNER_TIER_PROFILES)].join(' ').toLowerCase();
    for (const vendor of ['haiku', 'sonnet', 'opus', 'fable', 'claude', 'gpt', 'anthropic', 'openai']) expect(text).not.toContain(vendor);
    expect(Object.keys(TIER_PROFILES)).toEqual([...TIERS]);
  });
});

describe('usage and response boundaries (JGL-02)', () => {
  const post = async (body: string | Buffer, status = 200): Promise<Awaited<ReturnType<typeof callJev>>> =>
    await callJev({ model: 'jev-1.13.0', state: {}, questions: {} }, { apiKey: 'k', deadlineMs: 1000, fetchImpl: async () => new Response(body, { status }) });

  it('rejects fractional, negative and unsafe counters as unknown rather than reading them as values', async () => {
    const r = await post(JSON.stringify({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 10.5, output_tokens: -1 } }));
    expect(r.ok && r.response.usage).toEqual({ input_tokens: null, output_tokens: null });
    const big = await post(JSON.stringify({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: Number.MAX_SAFE_INTEGER + 2, output_tokens: 3 } }));
    expect(big.ok && big.response.usage).toEqual({ input_tokens: null, output_tokens: 3 });
  });

  it('keeps usage that parsed independently of answers it cannot use', async () => {
    const r = await post(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 40, output_tokens: 5 }, answers: 'not an object' }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('response_invalid');
    expect(r.ok === false && r.usage).toEqual({ input_tokens: 40, output_tokens: 5 });
    expect(r.ok === false && r.model).toBe('jev-1.13.0');
  });

  it('rejects invalid UTF-8 instead of repairing it into source', async () => {
    const r = await post(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('response_invalid');
  });

  it('reports a missing model as null so a caller cannot read an unknown model as the pinned one', async () => {
    const r = await post(JSON.stringify({ answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }));
    expect(r.ok && r.response.model).toBeNull();
  });
});
