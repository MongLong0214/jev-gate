import { describe, expect, it, vi } from 'vitest';

import { splitLossless } from '../src/blocks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildJevRequest, callJev, decide, JEV_ENDPOINT, MAX_RESPONSE_BYTES, topChoices, validateChoice } from '../src/jev.js';
import { KINDS, NATIVE_FALLBACK_DECISION, ROLES, ROUTES } from '../src/types.js';

const EXAMPLE = '검색 응답이 역순으로 오면 옛 결과가 화면을 덮는 버그를 고쳐줘.\nAPI 응답 형식과 의존성은 바꾸지 마.\n늦은 응답을 재현하는 테스트도 추가해.';
const blocks = splitLossless(EXAMPLE);

const choice = (keys: readonly string[], winner: string, p = 0.9, confidence = p): Record<string, unknown> => {
  const rest = (1 - p) / (keys.length - 1);
  const probabilities = Object.fromEntries(keys.map((k) => [k, k === winner ? p : rest]));
  return { type: 'choice', choice: winner, probabilities, confidence };
};

const goodAnswers = (route = 'opus'): Record<string, unknown> => ({
  task_kind: choice(KINDS, 'debug'),
  route: choice(ROUTES, route),
  role_u1: choice(ROLES, 'goal'),
  role_u2: choice(ROLES, 'constraint'),
  role_u3: choice(ROLES, 'acceptance'),
});

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('buildJevRequest', () => {
  it('sends only the blocks and fixed profiles, asks route only in auto mode', () => {
    const auto = buildJevRequest(blocks, DEFAULT_CONFIG, 'auto');
    expect(auto.model).toBe('jev-1.13.0');
    expect(auto.state.request_blocks).toEqual(blocks.map(({ id, text }) => ({ id, text })));
    expect(auto.state.context_available_to_jev).toBe('current_user_text_only');
    expect(Object.keys(auto.questions).sort()).toEqual(['role_u1', 'role_u2', 'role_u3', 'route', 'task_kind']);
    expect(auto.questions['role_u2']?.instructions).toContain('block u2 in request_blocks');
    expect(Object.keys(auto.questions['route']!.criteria)).toEqual(ROUTES);
    const enrich = buildJevRequest(blocks, DEFAULT_CONFIG, 'enrich');
    expect('route' in enrich.questions).toBe(false);
    expect(JSON.stringify(auto)).not.toMatch(/cwd|transcript|session_id|Bearer/);
  });
});

describe('callJev', () => {
  it('posts once to the fixed endpoint with a bearer header and no redirects', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ model: 'jev-1.13.0', answers: goodAnswers(), usage: { input_tokens: 321, output_tokens: 12 } }));
    const req = buildJevRequest(blocks, DEFAULT_CONFIG, 'auto');
    const out = await callJev(req, { apiKey: 'sk-test-secret', deadlineMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test-secret');
    expect(JSON.parse(init.body as string)).toEqual(req);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.response.model).toBe('jev-1.13.0');
      expect(out.response.usage).toEqual({ input_tokens: 321, output_tokens: 12 });
      expect(JSON.stringify(out)).not.toContain('sk-test-secret');
    }
  });

  it.each([
    [401, 'http_401'],
    [422, 'http_422'],
    [429, 'http_429'],
    [529, 'http_529'],
    [500, 'http_other'],
  ])('maps status %s to %s with zero retries', async (status, code) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'x' }, status));
    const out = await callJev(buildJevRequest(blocks, DEFAULT_CONFIG, 'auto'), { apiKey: 'k', deadlineMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toMatchObject({ ok: false, code, status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out on the single deadline and reports timeout', async () => {
    const fetchImpl = vi.fn((_: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const out = await callJev(buildJevRequest(blocks, DEFAULT_CONFIG, 'auto'), { apiKey: 'k', deadlineMs: 20, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toMatchObject({ ok: false, code: 'timeout' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('makes no request after the caller aborted and reports aborted mid-flight', async () => {
    const pre = new AbortController();
    pre.abort();
    const fetchImpl = vi.fn();
    const out = await callJev(buildJevRequest(blocks, DEFAULT_CONFIG, 'auto'), { apiKey: 'k', deadlineMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch, signal: pre.signal });
    expect(out).toMatchObject({ ok: false, code: 'aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();

    const mid = new AbortController();
    const hanging = vi.fn((_: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const p = callJev(buildJevRequest(blocks, DEFAULT_CONFIG, 'auto'), { apiKey: 'k', deadlineMs: 5000, fetchImpl: hanging as unknown as typeof fetch, signal: mid.signal });
    mid.abort();
    expect(await p).toMatchObject({ ok: false, code: 'aborted' });
  });

  it('rejects invalid JSON, missing answers, oversize bodies and network errors', async () => {
    const bad = async (res: () => Response | Promise<Response>): Promise<unknown> =>
      callJev(buildJevRequest(blocks, DEFAULT_CONFIG, 'auto'), { apiKey: 'k', deadlineMs: 2000, fetchImpl: (async () => res()) as unknown as typeof fetch });
    expect(await bad(() => new Response('{oops', { status: 200 }))).toMatchObject({ ok: false, code: 'response_invalid' });
    expect(await bad(() => jsonResponse({ model: 'jev' }))).toMatchObject({ ok: false, code: 'response_invalid' });
    expect(await bad(() => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), { status: 200 }))).toMatchObject({ ok: false, code: 'response_too_large' });
    expect(await bad(() => Promise.reject(new TypeError('fetch failed')))).toMatchObject({ ok: false, code: 'network' });
  });

  it('keeps usage null when absent instead of inventing zero', async () => {
    const out = await callJev(buildJevRequest(blocks, DEFAULT_CONFIG, 'auto'), { apiKey: 'k', deadlineMs: 1000, fetchImpl: (async () => jsonResponse({ answers: goodAnswers() })) as unknown as typeof fetch });
    expect(out.ok && out.response.usage).toEqual({ input_tokens: null, output_tokens: null });
    expect(out.ok && out.response.model).toBeNull();
  });

  it('refuses oversize requests before any HTTP call', async () => {
    const huge = splitLossless('x'.repeat(200 * 1024));
    const fetchImpl = vi.fn();
    const out = await callJev(buildJevRequest(huge, DEFAULT_CONFIG, 'auto'), { apiKey: 'k', deadlineMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('validateChoice', () => {
  it('accepts a well-formed answer and exposes ties', () => {
    const ok = validateChoice(choice(ROUTES, 'opus'), ROUTES);
    expect(ok?.choice).toBe('opus');
    const tie = validateChoice({ type: 'choice', choice: 'opus', probabilities: { sonnet: 0, opus: 0.5, fable: 0.5, context_required: 0, uncertain: 0 }, confidence: 0.5 }, ROUTES);
    expect(tie && topChoices(tie).sort()).toEqual(['fable', 'opus']);
  });

  it('rejects wrong key sets, coerced types, bad sums, non-argmax choices and bad confidence', () => {
    const base = choice(ROUTES, 'opus') as { probabilities: Record<string, number> };
    expect(validateChoice({ ...base, probabilities: { ...base.probabilities, extra: 0 } }, ROUTES)).toBeNull();
    const { sonnet: _s, ...missing } = base.probabilities;
    expect(validateChoice({ ...base, probabilities: missing }, ROUTES)).toBeNull();
    expect(validateChoice({ ...base, probabilities: { ...base.probabilities, opus: '0.9' } }, ROUTES)).toBeNull();
    expect(validateChoice({ ...base, probabilities: { ...base.probabilities, sonnet: 0.5 } }, ROUTES)).toBeNull();
    expect(validateChoice({ ...base, choice: 'sonnet' }, ROUTES)).toBeNull();
    expect(validateChoice({ ...base, confidence: 1.2 }, ROUTES)).toBeNull();
    expect(validateChoice({ ...base, confidence: true }, ROUTES)).toBeNull();
    expect(validateChoice({ ...base, type: 'noul' }, ROUTES)).toBeNull();
    expect(validateChoice({ ...base, probabilities: { ...base.probabilities, opus: Number.NaN } }, ROUTES)).toBeNull();
  });
});

describe('decide', () => {
  it('routes confident tiers to main or the scoped agents', () => {
    expect(decide(goodAnswers('opus'), blocks, DEFAULT_CONFIG, 'auto').decision).toMatchObject({ kind: 'debug', execution: 'delegate', tier: 'opus', agentName: 'jev-gate:opus', reason: 'selected', roles: { u1: 'goal', u2: 'constraint', u3: 'acceptance' } });
    expect(decide(goodAnswers('fable'), blocks, DEFAULT_CONFIG, 'auto').decision).toMatchObject({ execution: 'delegate', tier: 'fable', agentName: 'jev-gate:frontier' });
    expect(decide(goodAnswers('sonnet'), blocks, DEFAULT_CONFIG, 'auto').decision).toMatchObject({ execution: 'main', tier: 'sonnet', agentName: null, reason: 'selected' });
  });

  it('keeps context_required in the main conversation even when tied or low confidence', () => {
    expect(decide(goodAnswers('context_required'), blocks, DEFAULT_CONFIG, 'auto').decision).toMatchObject({ execution: 'main_context', tier: null, reason: 'context_required' });
    const tied = { ...goodAnswers(), route: { type: 'choice', choice: 'opus', probabilities: { sonnet: 0, opus: 0.5, fable: 0, context_required: 0.5, uncertain: 0 }, confidence: 0.5 } };
    expect(decide(tied, blocks, DEFAULT_CONFIG, 'auto').decision.execution).toBe('main_context');
    const low = { ...goodAnswers(), route: choice(ROUTES, 'context_required', 0.4, 0.2) };
    expect(decide(low, blocks, DEFAULT_CONFIG, 'auto').decision.execution).toBe('main_context');
  });

  it('uses the configured uncertain tier for uncertain, tied or low-confidence routes', () => {
    expect(decide(goodAnswers('uncertain'), blocks, DEFAULT_CONFIG, 'auto').decision).toMatchObject({ execution: 'delegate', tier: 'fable', agentName: 'jev-gate:frontier', reason: 'uncertain' });
    const low = { ...goodAnswers(), route: choice(ROUTES, 'opus', 0.6, 0.55) };
    expect(decide(low, blocks, DEFAULT_CONFIG, 'auto').decision).toMatchObject({ tier: 'fable', reason: 'uncertain' });
    expect(decide(low, blocks, { ...DEFAULT_CONFIG, uncertainTier: 'opus' }, 'auto').decision).toMatchObject({ tier: 'opus', agentName: 'jev-gate:opus', reason: 'uncertain' });
    const tie = { ...goodAnswers(), route: { type: 'choice', choice: 'opus', probabilities: { sonnet: 0, opus: 0.5, fable: 0.5, context_required: 0, uncertain: 0 }, confidence: 0.99 } };
    expect(decide(tie, blocks, DEFAULT_CONFIG, 'auto').decision.reason).toBe('uncertain');
  });

  it('falls back natively only when the auto route answer is missing or invalid', () => {
    const { route: _r, ...noRoute } = goodAnswers();
    expect(decide(noRoute, blocks, DEFAULT_CONFIG, 'auto')).toEqual({ decision: NATIVE_FALLBACK_DECISION, code: 'answers_invalid' });
    expect(decide({ ...goodAnswers(), route: { type: 'choice', choice: 'opus' } }, blocks, DEFAULT_CONFIG, 'auto').code).toBe('answers_invalid');
    expect(decide(noRoute, blocks, DEFAULT_CONFIG, 'enrich')).toMatchObject({ code: null, decision: { execution: 'main', reason: 'enrich_only', rawRoute: null, tier: null, agentName: null, kind: 'debug' } });
  });

  it('degrades uncertain annotations to other/mixed without dropping the turn', () => {
    const answers = { ...goodAnswers(), task_kind: { type: 'choice', choice: 'x' }, role_u2: choice(ROLES, 'constraint', 0.4, 0.3), role_u3: { type: 'choice', choice: 'goal', probabilities: { goal: 0.5, constraint: 0.5, acceptance: 0, background: 0, mixed: 0 }, confidence: 0.9 } };
    const { decision, code } = decide(answers, blocks, DEFAULT_CONFIG, 'auto');
    expect(code).toBeNull();
    expect(decision.kind).toBe('other');
    expect(decision.roles).toEqual({ u1: 'goal', u2: 'mixed', u3: 'mixed' });
    expect(decision.execution).toBe('delegate');
  });
});
