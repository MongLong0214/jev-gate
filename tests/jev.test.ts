import { describe, expect, it, vi } from 'vitest';

import { splitLossless } from '../src/blocks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildTaskRequest, callJev, CONTEXT_QUESTION, decideTask, JEV_ENDPOINT, KIND_QUESTION, MAX_RESPONSE_BYTES, MODEL_PROFILES, ROUTE_QUESTION, topChoices, validateChoice } from '../src/jev.js';
import { CONTEXT_ANSWERS, ROUTE_ANSWERS, TASK_KINDS } from '../src/types.js';

const PROMPT = 'Implement pan and zoom.\r\nPreserve the current camera API.\n```js\nconst x = 1;\n```';
const blocks = splitLossless(PROMPT);
const config = { ...DEFAULT_CONFIG, mode: 'auto' as const };

const choice = (keys: readonly string[], winner: string, p = 0.9, confidence = p): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === winner ? p : (1 - p) / (keys.length - 1)])),
  confidence,
});
const answers = (route = 'opus', context = 'ready', kind = 'implement'): Record<string, unknown> => ({
  context: choice(CONTEXT_ANSWERS, context),
  route: choice(ROUTE_ANSWERS, route),
  kind: choice(TASK_KINDS, kind),
});
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe('buildTaskRequest (#10 §5)', () => {
  it('sends role, native default tier, description, lossless blocks and fixed profiles; three independent Choice questions', () => {
    const req = buildTaskRequest('worker', 'Implement camera input', blocks, config);
    expect(req.model).toBe('jev-1.13.0');
    expect(req.state).toEqual({ role: 'worker', native_default_tier: 'sonnet', task: { description: 'Implement camera input', blocks: blocks.map(({ id, text }) => ({ id, text })) }, model_profiles: MODEL_PROFILES });
    expect(req.state.task.blocks.map((b) => b.text).join('')).toBe(PROMPT);
    expect(Object.keys(req.questions)).toEqual(['context', 'route', 'kind']);
    expect(req.questions.context).toBe(CONTEXT_QUESTION);
    expect(req.questions.route).toBe(ROUTE_QUESTION);
    expect(req.questions.kind).toBe(KIND_QUESTION);
    expect(Object.keys(ROUTE_QUESTION.criteria)).toEqual(['sonnet', 'opus', 'fable', 'abstain']);
    expect(ROUTE_QUESTION.instructions).toContain('task.blocks');
    expect(buildTaskRequest('planner', 'd', blocks, config).state.native_default_tier).toBe('opus');
    expect(JSON.stringify(req)).not.toMatch(/transcript|cwd|Bearer|messages|rewritten/);
  });
});

describe('callJev', () => {
  it('posts once to the fixed endpoint with Bearer auth, redirect:error, and returns whitelisted usage', async () => {
    const fetchImpl = vi.fn(async () => json({ model: 'jev-1.13.0', answers: answers(), usage: { input_tokens: 500, output_tokens: 30 } }));
    const req = buildTaskRequest('worker', 'd', blocks, config);
    const out = await callJev(req, { apiKey: 'sk-secret', deadlineMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-secret');
    expect(JSON.parse(init.body as string)).toEqual(req);
    expect(out.ok && out.response.usage).toEqual({ input_tokens: 500, output_tokens: 30 });
    expect(JSON.stringify(out)).not.toContain('sk-secret');
  });

  it.each([[401, 'http_401'], [422, 'http_422'], [429, 'http_429'], [529, 'http_529'], [503, 'http_other']])('status %s → %s, zero retries', async (status, code) => {
    const fetchImpl = vi.fn(async () => json({ error: 'reflected sk-secret', extra: { leak: 'x' } }, status));
    const out = await callJev(buildTaskRequest('worker', 'd', blocks, config), { apiKey: 'sk-secret', deadlineMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toMatchObject({ ok: false, code, status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(out)).not.toMatch(/reflected|leak|sk-secret/);
  });

  it('one deadline covers headers and body; a stalled body times out and a pre-aborted signal sends nothing', async () => {
    const stalledBody = new ReadableStream<Uint8Array>({ start() { /* never enqueue, never close */ } });
    const stalled = vi.fn(async () => new Response(stalledBody, { status: 200 }));
    const out = await callJev(buildTaskRequest('worker', 'd', blocks, config), { apiKey: 'k', deadlineMs: 30, fetchImpl: stalled as unknown as typeof fetch });
    expect(out).toMatchObject({ ok: false, code: 'timeout' });
    const pre = new AbortController();
    pre.abort();
    const never = vi.fn();
    expect(await callJev(buildTaskRequest('worker', 'd', blocks, config), { apiKey: 'k', deadlineMs: 1000, fetchImpl: never as unknown as typeof fetch, signal: pre.signal })).toMatchObject({ ok: false, code: 'aborted' });
    expect(never).not.toHaveBeenCalled();
  }, 10_000);

  it('rejects invalid JSON, non-object answers, oversize bodies; keeps usage null when missing', async () => {
    const run = (res: () => Response | Promise<Response>): Promise<unknown> => callJev(buildTaskRequest('worker', 'd', blocks, config), { apiKey: 'k', deadlineMs: 2000, fetchImpl: (async () => res()) as unknown as typeof fetch });
    expect(await run(() => new Response('{oops', { status: 200 }))).toMatchObject({ ok: false, code: 'response_invalid' });
    expect(await run(() => json({ model: 'jev' }))).toMatchObject({ ok: false, code: 'response_invalid' });
    expect(await run(() => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), { status: 200 }))).toMatchObject({ ok: false, code: 'response_too_large' });
    expect(await run(() => Promise.reject(new TypeError('fetch failed')))).toMatchObject({ ok: false, code: 'network' });
    const noUsage = await run(() => json({ answers: answers() }));
    expect((noUsage as { ok: true; response: { usage: unknown; model: unknown } }).response).toMatchObject({ usage: { input_tokens: null, output_tokens: null }, model: null });
  });

  it('usage survives an answer set that will later fail validation (consumption is known, decision is not)', async () => {
    const out = await callJev(buildTaskRequest('worker', 'd', blocks, config), { apiKey: 'k', deadlineMs: 1000, fetchImpl: (async () => json({ model: 'jev-1.13.0', answers: { route: 'garbage' }, usage: { input_tokens: 77, output_tokens: 1 } })) as unknown as typeof fetch });
    expect(out.ok && out.response.usage.input_tokens).toBe(77);
    expect(decideTask((out as { response: { answers: Record<string, unknown> } }).response.answers, 0.8)).toMatchObject({ action: 'preserve', reason: 'context_invalid' });
  });
});

describe('validateChoice', () => {
  it('rejects wrong key sets, coercible strings, bad sums, non-argmax choices and bad confidence', () => {
    const good = choice(ROUTE_ANSWERS, 'opus') as { probabilities: Record<string, number> };
    expect(validateChoice(good, ROUTE_ANSWERS)?.choice).toBe('opus');
    expect(validateChoice({ ...good, probabilities: { ...good.probabilities, extra: 0 } }, ROUTE_ANSWERS)).toBeNull();
    expect(validateChoice({ ...good, probabilities: { ...good.probabilities, opus: '0.9' } }, ROUTE_ANSWERS)).toBeNull();
    expect(validateChoice({ ...good, probabilities: { ...good.probabilities, sonnet: 0.5 } }, ROUTE_ANSWERS)).toBeNull();
    expect(validateChoice({ ...good, choice: 'sonnet' }, ROUTE_ANSWERS)).toBeNull();
    expect(validateChoice({ ...good, confidence: 1.5 }, ROUTE_ANSWERS)).toBeNull();
    expect(validateChoice({ ...good, probabilities: { ...good.probabilities, fable: Number.NaN } }, ROUTE_ANSWERS)).toBeNull();
    const tie = { type: 'choice', choice: 'opus', probabilities: { sonnet: 0.5, opus: 0.5, fable: 0, abstain: 0 }, confidence: 0.5 };
    expect(topChoices(validateChoice(tie, ROUTE_ANSWERS)!).sort()).toEqual(['opus', 'sonnet']);
  });
});

describe('decideTask (#10 §5 policy)', () => {
  it('patches only when context is ready and a unique tier clears the floor', () => {
    expect(decideTask(answers('sonnet'), 0.8)).toMatchObject({ action: 'patch', tier: 'sonnet', kind: 'implement', reason: null });
    expect(decideTask(answers('opus'), 0.8)).toMatchObject({ action: 'patch', tier: 'opus' });
    expect(decideTask(answers('fable', 'ready', 'design'), 0.8)).toMatchObject({ action: 'patch', tier: 'fable', kind: 'design' });
  });

  it('V3 regression: sonnet .82 / confidence .77 / floor .8 preserves the native input and does not escalate', () => {
    const v3 = { ...answers(), route: { type: 'choice', choice: 'sonnet', probabilities: { sonnet: 0.82, opus: 0.18, fable: 0, abstain: 0 }, confidence: 0.77 } };
    expect(decideTask(v3, 0.8)).toMatchObject({ action: 'preserve', tier: null, reason: 'route_low_confidence' });
  });

  it('context is judged first: needs_context, ties, invalid or low confidence preserve even with a confident route', () => {
    expect(decideTask(answers('opus', 'needs_context'), 0.8)).toMatchObject({ action: 'preserve', reason: 'needs_context' });
    expect(decideTask({ ...answers(), context: { type: 'choice', choice: 'ready', probabilities: { ready: 0.5, needs_context: 0.5 }, confidence: 0.99 } }, 0.8)).toMatchObject({ reason: 'context_tie' });
    expect(decideTask({ ...answers(), context: choice(CONTEXT_ANSWERS, 'ready', 0.7, 0.6) }, 0.8)).toMatchObject({ reason: 'context_low_confidence' });
    const { context: _c, ...noContext } = answers();
    expect(decideTask(noContext, 0.8)).toMatchObject({ reason: 'context_invalid' });
  });

  it('route abstain, tie, invalid or missing preserve; kind degrades to other without invalidating the route', () => {
    expect(decideTask(answers('abstain'), 0.8)).toMatchObject({ action: 'preserve', reason: 'route_abstain' });
    expect(decideTask({ ...answers(), route: { type: 'choice', choice: 'opus', probabilities: { sonnet: 0, opus: 0.5, fable: 0.5, abstain: 0 }, confidence: 0.9 } }, 0.8)).toMatchObject({ reason: 'route_tie' });
    const { route: _r, ...noRoute } = answers();
    expect(decideTask(noRoute, 0.8)).toMatchObject({ reason: 'route_invalid' });
    expect(decideTask({ ...answers('opus'), kind: { type: 'choice', choice: 'nope' } }, 0.8)).toMatchObject({ action: 'patch', tier: 'opus', kind: 'other' });
    expect(decideTask({ ...answers('opus'), kind: { type: 'choice', choice: 'implement', probabilities: { implement: 0.5, investigate: 0.5, design: 0, verify: 0, other: 0 }, confidence: 0.5 } }, 0.8)).toMatchObject({ action: 'patch', kind: 'other' });
  });
});
