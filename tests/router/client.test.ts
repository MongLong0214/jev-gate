import { describe, expect, it, vi } from 'vitest';

import type { HttpReply, Transport, Usage } from '../../mods/router/hooks/client.ts';
import { createClient, estimateTokens, JEV_ENDPOINT, JEV_MODEL, MAX_IN_FLIGHT, parseUsage } from '../../mods/router/hooks/client.ts';
import { deferred, FAKE_KEY } from './fake-engine.ts';

const STATE = { task: { text: 'Rename parseRow to parseRecord.' } };
const QUESTIONS = { control: { type: 'choice', instructions: 'Decide.', criteria: { a: 'A', b: 'B' } } };

/** A transport whose replies come from `reply`, and whose clock only ends a wait when `expire()` is called. */
const transport = (reply: () => HttpReply | Promise<HttpReply>) => {
  const fetch = vi.fn(async (_url: string, _init: { method: 'POST'; headers: Record<string, string>; body: string }) => reply());
  const timers: Array<() => void> = [];
  const t: Transport = {
    fetch,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve, reject) => {
        timers.push(resolve);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  };
  return { t, fetch, expire: () => timers.splice(0).forEach((r) => r()) };
};

const ok200 = (body: Record<string, unknown>): HttpReply => ({ status: 200, text: JSON.stringify(body) });
const GOOD = ok200({ model: JEV_MODEL, answers: { control: { type: 'choice' } }, usage: { input_tokens: 700, output_tokens: 30 } });

describe('the one request', () => {
  it('posts once to the fixed endpoint, with the key only in the Authorization header', async () => {
    const x = transport(() => GOOD);
    const res = await createClient({ timeoutMs: 800 }).assess(x.t, FAKE_KEY, STATE, QUESTIONS);
    expect(res).toEqual({ ok: true, answers: { control: { type: 'choice' } }, usage: { input_tokens: 700, output_tokens: 30 }, requestBytes: expect.any(Number) });
    expect(x.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = x.fetch.mock.calls[0] ?? [];
    expect(url).toBe(JEV_ENDPOINT);
    expect(init?.headers).toEqual({ authorization: `Bearer ${FAKE_KEY}`, 'content-type': 'application/json' });
    expect(JSON.parse(init?.body ?? '')).toEqual({ model: JEV_MODEL, state: STATE, questions: QUESTIONS });
    expect(init?.body).not.toContain(FAKE_KEY);
  });

  it('sends nothing for input that looks like a credential or does not fit, and never trims it to fit', async () => {
    const client = createClient({ timeoutMs: 800 });
    const x = transport(() => GOOD);
    const secret = await client.assess(x.t, FAKE_KEY, { task: { text: 'curl -H "Authorization: Basic dTpw" host' } }, QUESTIONS);
    expect(secret).toMatchObject({ ok: false, reason: 'input_secret', sent: false, requestBytes: null });
    const inQuestion = await client.assess(x.t, FAKE_KEY, STATE, { q: { criteria: { a: `sk-${'b'.repeat(20)}` } } });
    expect(inQuestion).toMatchObject({ ok: false, reason: 'input_secret' });
    const bytes = await client.assess(x.t, FAKE_KEY, { task: { text: 'a '.repeat(70 * 1024) } }, QUESTIONS);
    expect(bytes).toMatchObject({ ok: false, reason: 'input_too_large', sent: false });
    // Under the byte cap, over the token estimate: every non-ASCII character counts as a whole token.
    const tokens = await client.assess(x.t, FAKE_KEY, { task: { text: '가'.repeat(30_000) } }, QUESTIONS);
    expect(tokens).toMatchObject({ ok: false, reason: 'input_too_large', sent: false });
    expect((tokens.ok ? 0 : tokens.requestBytes ?? 0) < 128 * 1024).toBe(true);
    expect(x.fetch).not.toHaveBeenCalled();
  });

  it('maps statuses to closed reasons, keeps the usage a refusal reports, and never retries', async () => {
    const cases: Array<[number, string]> = [
      [400, 'rejected_input'],
      [413, 'rejected_input'],
      [422, 'rejected_input'],
      [429, 'rate_limited'],
      [529, 'overloaded'],
      [500, 'http_other'],
    ];
    for (const [status, reason] of cases) {
      const x = transport(() => ({ status, text: JSON.stringify({ usage: { input_tokens: 5 } }) }));
      const res = await createClient({ timeoutMs: 800 }).assess(x.t, FAKE_KEY, STATE, QUESTIONS);
      expect(res).toMatchObject({ ok: false, reason, sent: true, usage: { input_tokens: 5, output_tokens: null } });
      expect(x.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses a reply that is not a usable assessment', async () => {
    const cases: Array<[HttpReply, string]> = [
      [{ status: 200, text: 'not json' }, 'malformed'],
      [ok200({ model: JEV_MODEL }), 'malformed'],
      [ok200({ model: JEV_MODEL, answers: [] }), 'malformed'],
      [ok200({ model: 'jev-1.12.0', answers: {} }), 'model_mismatch'],
      [{ status: 200, text: JSON.stringify({ model: JEV_MODEL, answers: {}, pad: 'x'.repeat(1024 * 1024) }) }, 'response_too_large'],
    ];
    for (const [reply, reason] of cases) {
      const x = transport(() => reply);
      expect(await createClient({ timeoutMs: 800 }).assess(x.t, FAKE_KEY, STATE, QUESTIONS)).toMatchObject({ ok: false, reason, sent: true });
    }
    const failing = transport(() => Promise.reject(new Error('ECONNRESET')));
    expect(await createClient({ timeoutMs: 800 }).assess(failing.t, FAKE_KEY, STATE, QUESTIONS)).toMatchObject({ ok: false, reason: 'network', sent: true });
  });

  it('after a 401 or 402, asks nothing more for the rest of the activation', async () => {
    for (const status of [401, 402]) {
      const client = createClient({ timeoutMs: 800 });
      const x = transport(() => ({ status, text: '{}' }));
      expect(await client.assess(x.t, FAKE_KEY, STATE, QUESTIONS)).toMatchObject({ reason: status === 401 ? 'unauthorized' : 'payment_required' });
      expect(await client.assess(x.t, FAKE_KEY, STATE, QUESTIONS)).toMatchObject({ ok: false, reason: 'credential_refused', sent: false });
      expect(x.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('ends the wait at the timeout, then observes the late reply for its usage and its refusal', async () => {
    const late: Array<Usage | null> = [];
    const client = createClient({ timeoutMs: 800, onLate: (u) => late.push(u) });
    const reply = deferred<HttpReply>();
    const x = transport(() => reply.promise);
    const pending = client.assess(x.t, FAKE_KEY, STATE, QUESTIONS);
    await vi.waitFor(() => expect(x.fetch).toHaveBeenCalledTimes(1));
    x.expire();
    expect(await pending).toMatchObject({ ok: false, reason: 'timeout', sent: true, usage: null });
    expect(client.inFlight()).toBe(1);
    reply.resolve({ status: 402, text: JSON.stringify({ usage: { input_tokens: 900, output_tokens: 0 } }) });
    await vi.waitFor(() => expect(late).toEqual([{ input_tokens: 900, output_tokens: 0 }]));
    expect(client.inFlight()).toBe(0);
    expect(await client.assess(x.t, FAKE_KEY, STATE, QUESTIONS)).toMatchObject({ reason: 'credential_refused', sent: false });
  });

  it('reports a late reply to the call that sent it as well, and a throwing observer changes nothing', async () => {
    const shared: Array<Usage | null> = [];
    const client = createClient({
      timeoutMs: 800,
      onLate: (u) => {
        shared.push(u);
        throw new Error('observer down');
      },
    });
    const replies = [deferred<HttpReply>(), deferred<HttpReply>()];
    let i = 0;
    const x = transport(() => replies[i++]!.promise);
    const own: Array<Usage | null> = [];
    const first = client.assess(x.t, FAKE_KEY, STATE, QUESTIONS, undefined, (u) => own.push(u));
    const second = client.assess(x.t, FAKE_KEY, STATE, QUESTIONS);
    await vi.waitFor(() => expect(x.fetch).toHaveBeenCalledTimes(2));
    x.expire();
    await Promise.all([first, second]);
    replies[0]!.resolve({ status: 200, text: JSON.stringify({ usage: { input_tokens: 700, output_tokens: 30 } }) });
    replies[1]!.resolve({ status: 200, text: JSON.stringify({ usage: { input_tokens: 500, output_tokens: 20 } }) });
    await vi.waitFor(() => expect(shared).toHaveLength(2));
    // Each call hears only its own reply; the client-wide observer hears both, and its throw reaches neither.
    expect(own).toEqual([{ input_tokens: 700, output_tokens: 30 }]);
  });

  it('ends the wait when the caller aborts, and sends nothing when already aborted', async () => {
    const client = createClient({ timeoutMs: 800 });
    const x = transport(() => new Promise<HttpReply>(() => undefined));
    const pre = new AbortController();
    pre.abort();
    expect(await client.assess(x.t, FAKE_KEY, STATE, QUESTIONS, pre.signal)).toMatchObject({ reason: 'aborted', sent: false });
    const mid = new AbortController();
    const pending = client.assess(x.t, FAKE_KEY, STATE, QUESTIONS, mid.signal);
    await vi.waitFor(() => expect(x.fetch).toHaveBeenCalledTimes(1));
    mid.abort();
    expect(await pending).toMatchObject({ reason: 'aborted', sent: true });
  });

  it('keeps a task native rather than queueing it behind MAX_IN_FLIGHT unresolved requests', async () => {
    const client = createClient({ timeoutMs: 800 });
    const x = transport(() => new Promise<HttpReply>(() => undefined));
    const hung = Array.from({ length: MAX_IN_FLIGHT }, () => client.assess(x.t, FAKE_KEY, STATE, QUESTIONS));
    await vi.waitFor(() => expect(client.inFlight()).toBe(MAX_IN_FLIGHT));
    expect(await client.assess(x.t, FAKE_KEY, STATE, QUESTIONS)).toMatchObject({ ok: false, reason: 'saturated', sent: false });
    expect(x.fetch).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
    x.expire();
    await Promise.all(hung);
  });
});

describe('accounting helpers', () => {
  it('reads usage field by field, and an empty one is unknown rather than zero', () => {
    expect(parseUsage({ usage: { input_tokens: 10, output_tokens: 2 } })).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(parseUsage({ usage: { input_tokens: -1, output_tokens: 2.5 } })).toBeNull();
    expect(parseUsage({ usage: { input_tokens: 3 } })).toEqual({ input_tokens: 3, output_tokens: null });
    expect(parseUsage({ usage: {} })).toBeNull();
    expect(parseUsage(undefined)).toBeNull();
  });

  it('estimates tokens as Lean does: ASCII at 1.5 characters, anything else a whole token', () => {
    expect(estimateTokens('abc')).toBe(2);
    expect(estimateTokens('가나')).toBe(2);
    expect(estimateTokens('ab가')).toBe(3);
  });
});
