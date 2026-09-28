import { describe, expect, it, vi } from 'vitest';

import { createEvidenceService, type EvidenceServiceDeps } from '../../src/evidence/service.js';
import { EVIDENCE_MODEL, JUDGEMENTS, LIMITS, type EvidenceResult, type Judgement } from '../../src/evidence/types.js';
import { JEV_ENDPOINT } from '../../src/jev.js';
import { config, live, repo, write } from './repo.js';

type Sent = { id: string; path: string; startLine: number; endLine: number; text: string };
type Req = { model: string; state: { goal: string; constraints: string[]; candidates: Sent[] }; questions: Record<string, { type: string; instructions: string }> };

const choice = (winner: Judgement, p: number): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: Object.fromEntries(JUDGEMENTS.map((k) => [k, k === winner ? p : (1 - p) / 2])),
  confidence: p,
});

/** A fake Jev: answers each sent candidate by `answer`, and records every request body it received. */
const jev = (answer: (c: Sent) => unknown, reply: (req: Req) => Response | null = () => null) => {
  const requests: Req[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(JEV_ENDPOINT);
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer test-key');
    const req = JSON.parse(String(init.body)) as Req;
    requests.push(req);
    const answers = Object.fromEntries(req.state.candidates.map((c) => [c.id, answer(c)]));
    return reply(req) ?? new Response(JSON.stringify({ model: EVIDENCE_MODEL, answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  });
  return { requests, fetchImpl: fetchImpl as unknown as typeof fetch, calls: () => fetchImpl.mock.calls.length };
};

const widget = (n: number): string => `src/a${String(n).padStart(2, '0')}.ts`;
const widgets = (n: number): string => {
  const files: Record<string, string> = {};
  for (let i = 1; i <= n; i++) files[widget(i)] = `widget handler ${i}\n`;
  return repo(files);
};
const remote = async (root: string, deps: Omit<EvidenceServiceDeps, 'apiKey'> & { apiKey?: string | null }) =>
  createEvidenceService(await config(root, { remote: true }), { apiKey: 'test-key', ...deps });
const paths = (r: EvidenceResult): string[] => r.items.map((i) => i.source.path);

describe('when Jev is not asked', () => {
  it('makes no HTTP call for exact-only, sources, remote off, no key, no candidate or a cancelled call, yet asks about a page that fits', async () => {
    const root = widgets(2);
    const fake = jev(() => choice('relevant', 0.9));
    const svc = await remote(root, { fetchImpl: fake.fetchImpl });
    const exact = (await svc.run({ goal: 'widget', exactSymbols: ['handler'] }, live())).result;
    expect(exact).toMatchObject({ status: 'ok', backend: 'local', reasonCodes: [] });
    await svc.run({ goal: 'widget', sources: [exact.items[0]!.source] }, live());
    expect(await svc.run({ goal: 'nothing matches zzqx' }, live())).toMatchObject({ result: { reasonCodes: ['no_candidate'], items: [] } });
    expect((await svc.run({ goal: 'widget sk-abcdefghijklmnopqrstuvwx' }, live())).result.reasonCodes).toContain('remote_secret');
    const ac = new AbortController();
    ac.abort();
    expect((await svc.run({ goal: 'widget' }, ac.signal)).result.status).toBe('cancelled');
    const off = createEvidenceService(await config(root), { apiKey: 'test-key', fetchImpl: fake.fetchImpl });
    expect((await off.run({ goal: 'widget' }, live())).result.reasonCodes).toEqual(['remote_disabled']);
    const keyless = await remote(root, { apiKey: null, fetchImpl: fake.fetchImpl });
    expect((await keyless.run({ goal: 'widget' }, live())).result.reasonCodes).toEqual(['missing_key']);
    expect(fake.calls()).toBe(0);

    // Both bodies fit the result many times over; the semantic page is still judged.
    expect(await svc.run({ goal: 'widget' }, live())).toMatchObject({ result: { status: 'ok', backend: 'jev' } });
    expect(fake.calls()).toBe(1);
  });
});

describe('requests', () => {
  it('sends only the page, eight candidates a request and two requests at most, under the pinned model', async () => {
    const root = widgets(20);
    const fake = jev(() => choice('relevant', 0.9));
    const svc = await remote(root, { fetchImpl: fake.fetchImpl });
    const r = (await svc.run({ goal: 'widget handler', constraints: ['only the handler'], limit: LIMITS.maxPage }, live())).result;
    expect(fake.requests).toHaveLength(2);
    const sent = fake.requests.flatMap((q) => q.state.candidates);
    expect(sent.map((c) => c.path)).toEqual(Array.from({ length: 16 }, (_, i) => widget(i + 1)));
    for (const q of fake.requests) {
      expect(q.model).toBe('jev-1.13.0');
      expect(q.state).toMatchObject({ goal: 'widget handler', constraints: ['only the handler'] });
      expect(q.state.candidates.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
      expect(Object.keys(q.questions)).toEqual(q.state.candidates.map((c) => c.id));
      for (const c of q.state.candidates) {
        expect(c).toEqual({ id: c.id, path: c.path, startLine: 1, endLine: 1, text: `widget handler ${Number(c.path.slice(5, 7))}\n` });
        expect(q.questions[c.id]!.instructions).toContain(`"${c.id}" (${c.path}, lines 1-1)`);
      }
    }
    expect(r).toMatchObject({ backend: 'jev', status: 'partial', next: { offset: 16 }, coverage: { pageCandidates: 16, unjudgedOnPage: 0 } });
  });

  it('sends only whole candidates that fit the token estimate and leaves the rest unjudged', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 8; i++) files[widget(i)] = `widget ${'가'.repeat(2700)}\n`;
    const fake = jev(() => choice('relevant', 0.9));
    const r = (await (await remote(repo(files), { fetchImpl: fake.fetchImpl })).run({ goal: 'widget' }, live())).result;
    const sent = fake.requests[0]!.state.candidates;
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(8);
    expect(sent.every((c) => c.text === files[c.path])).toBe(true);
    expect(r.items).toHaveLength(8);
    expect(r.coverage.unjudgedOnPage).toBe(8 - sent.length);
    expect(r).toMatchObject({ status: 'partial', backend: 'mixed' });
    expect(r.reasonCodes).toContain('remote_budget');
  });

  it('never sends a candidate that looks like a credential', async () => {
    const root = repo({ [widget(1)]: 'widget handler 1\n', [widget(2)]: 'widget key = sk-abcdefghijklmnopqrstuv\n' });
    const fake = jev(() => choice('relevant', 0.9));
    const r = (await (await remote(root, { fetchImpl: fake.fetchImpl })).run({ goal: 'widget' }, live())).result;
    expect(JSON.stringify(fake.requests)).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(fake.requests[0]!.state.candidates.map((c) => c.path)).toEqual([widget(1)]);
    expect(r.items.find((i) => i.source.path === widget(2))).toMatchObject({ origin: 'local', judgement: 'unjudged', textState: 'included' });
    expect(r).toMatchObject({ status: 'partial', reasonCodes: ['remote_secret'] });
  });
});

describe('ordering and folding', () => {
  const answers: Record<string, unknown> = {
    [widget(1)]: choice('unrelated', 0.95),
    [widget(2)]: choice('relevant', 0.9),
    [widget(3)]: choice('needs_context', 0.6),
    [widget(4)]: choice('relevant', 0.85),
    [widget(5)]: choice('unrelated', 0.85),
    [widget(6)]: choice('relevant', 0.7),
  };

  it('orders relevant, uncertain, unrelated with local order kept; locate folds only the clear unrelated, audit folds nothing', async () => {
    const fake = jev((c) => answers[c.path]);
    const svc = await remote(widgets(6), { fetchImpl: fake.fetchImpl });
    const order = [widget(2), widget(4), widget(3), widget(5), widget(6), widget(1)];
    const located = (await svc.run({ goal: 'widget' }, live())).result;
    expect(paths(located)).toEqual(order);
    const folded = located.items[5]!;
    expect(folded).toEqual({
      source: { path: widget(1), startLine: 1, endLine: 1, fileSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      textState: 'omitted_irrelevant',
      origin: 'jev',
      judgement: 'unrelated',
      probabilities: { relevant: 0.025, unrelated: 0.95, needs_context: 0.025 },
    });
    expect(located.items.slice(0, 5).every((i) => i.textState === 'included' && i.text !== undefined)).toBe(true);
    expect(located).toMatchObject({ status: 'partial', backend: 'jev', coverage: { omittedBodies: 1, unjudgedOnPage: 0, pageCandidates: 6 } });

    // The folded reference reads back whole, with no request and no second folding.
    const back = (await svc.run({ goal: 'widget', sources: [folded.source] }, live())).result;
    expect(back.items).toEqual([{ source: folded.source, text: 'widget handler 1\n', textState: 'included', origin: 'local', judgement: 'unjudged' }]);
    expect(fake.calls()).toBe(1);

    const audited = (await svc.run({ goal: 'widget', mode: 'audit' }, live())).result;
    expect(paths(audited)).toEqual(order);
    expect(audited.items.every((i) => i.textState === 'included')).toBe(true);
    expect(audited).toMatchObject({ status: 'ok', coverage: { omittedBodies: 0 } });
  });

  it('leaves NaN, tied, missing and unknown-id answers unjudged, keeps a rounded one, and does not cache the batch', async () => {
    const tie = { type: 'choice', choice: 'relevant', probabilities: { relevant: 0.45, unrelated: 0.45, needs_context: 0.1 }, confidence: 0.45 };
    const bad: Record<string, unknown> = {
      [widget(1)]: { ...choice('relevant', 0.9), probabilities: { relevant: Number.NaN, unrelated: 0.05, needs_context: 0.05 } },
      [widget(2)]: tie,
      [widget(4)]: { type: 'choice', choice: 'relevant', probabilities: { relevant: 0.98, unrelated: 0.01, needs_context: 0 }, confidence: 0.98 },
      [widget(5)]: choice('unrelated', 0.95),
    };
    const fake = jev(
      (c) => bad[c.path],
      (req) => {
        // widget 3's answer arrives under an id no candidate has.
        const answers = Object.fromEntries(req.state.candidates.map((c) => [c.id, bad[c.path]]));
        return new Response(JSON.stringify({ model: EVIDENCE_MODEL, answers: { ...answers, c99: choice('relevant', 0.99) } }), { status: 200 });
      },
    );
    const svc = await remote(widgets(5), { fetchImpl: fake.fetchImpl });
    const r = (await svc.run({ goal: 'widget' }, live())).result;
    expect(r.items.map((i) => [i.source.path, i.judgement, i.textState])).toEqual([
      [widget(4), 'relevant', 'included'],
      [widget(1), 'unjudged', 'included'],
      [widget(2), 'unjudged', 'included'],
      [widget(3), 'unjudged', 'included'],
      [widget(5), 'unrelated', 'omitted_irrelevant'],
    ]);
    expect(r.items[0]!.probabilities).toEqual({ relevant: 0.99, unrelated: 0.01, needs_context: 0 });
    expect(r.items.filter((i) => i.judgement === 'unjudged').every((i) => i.origin === 'local' && i.probabilities === undefined)).toBe(true);
    expect(r).toMatchObject({ status: 'partial', backend: 'mixed', reasonCodes: ['remote_failed'], coverage: { unjudgedOnPage: 3 } });
    await svc.run({ goal: 'widget' }, live());
    expect(fake.calls()).toBe(2);
  });
});

describe('failures', () => {
  it('voids a batch under the wrong model, keeps the other batch when one fails, and times out without a retry', async () => {
    const wrong = jev(() => choice('relevant', 0.9), (req) => new Response(JSON.stringify({ model: 'jev-1.12.0', answers: Object.fromEntries(req.state.candidates.map((c) => [c.id, choice('relevant', 0.9)])) }), { status: 200 }));
    const w = (await (await remote(widgets(2), { fetchImpl: wrong.fetchImpl })).run({ goal: 'widget' }, live())).result;
    expect(w.items.every((i) => i.origin === 'local' && i.judgement === 'unjudged')).toBe(true);
    expect(w).toMatchObject({ status: 'partial', backend: 'local', reasonCodes: ['remote_failed'] });

    const half = jev(
      () => choice('relevant', 0.9),
      (req) => (req.state.candidates.some((c) => c.path === widget(1)) ? new Response('{}', { status: 503 }) : null),
    );
    const h = (await (await remote(widgets(16), { fetchImpl: half.fetchImpl })).run({ goal: 'widget', limit: 16 }, live())).result;
    expect(half.calls()).toBe(2);
    expect(paths(h)).toEqual([...Array.from({ length: 8 }, (_, i) => widget(i + 9)), ...Array.from({ length: 8 }, (_, i) => widget(i + 1))]);
    expect(h.items.slice(0, 8).every((i) => i.judgement === 'relevant')).toBe(true);
    expect(h.items.slice(8).every((i) => i.judgement === 'unjudged' && i.text !== undefined)).toBe(true);
    expect(h).toMatchObject({ status: 'partial', backend: 'mixed', reasonCodes: ['remote_failed'] });

    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const started = Date.now();
    const t = (await (await remote(widgets(2), { fetchImpl: hang as unknown as typeof fetch })).run({ goal: 'widget' }, live())).result;
    expect(Date.now() - started).toBeLessThan(LIMITS.deadlineMs);
    expect(hang).toHaveBeenCalledTimes(1);
    expect(t).toMatchObject({ status: 'partial', backend: 'local', reasonCodes: ['remote_timeout'] });
  });

  it('refuses a third concurrent call as busy instead of queueing it', async () => {
    const release: Array<() => void> = [];
    const gated = jev(
      () => choice('relevant', 0.9),
      () => null,
    );
    const fetchImpl = (async (u: string, init: RequestInit) => {
      await new Promise<void>((resolve) => release.push(resolve));
      return gated.fetchImpl(u, init);
    }) as unknown as typeof fetch;
    const svc = await remote(widgets(2), { fetchImpl });
    const first = svc.run({ goal: 'widget' }, live());
    const second = svc.run({ goal: 'widget handler' }, live());
    await vi.waitFor(() => expect(release).toHaveLength(2));
    expect(await svc.run({ goal: 'widget' }, live())).toMatchObject({ isError: true, result: { reasonCodes: ['busy'] } });
    release.forEach((r) => r());
    expect((await first).result.backend).toBe('jev');
    expect((await second).result.backend).toBe('jev');
  });
});

describe('cancellation and cache', () => {
  it('drops a late answer after abort, caches only completed batches, and misses on a changed file, other constraints or expiry', async () => {
    const root = widgets(2);
    const fake = jev(() => choice('relevant', 0.9));
    let t = 1_000_000;
    let onFetch: (() => void) | null = null;
    const fetchImpl = (async (u: string, init: RequestInit) => {
      onFetch?.();
      onFetch = null;
      return fake.fetchImpl(u, init);
    }) as unknown as typeof fetch;
    const svc = await remote(root, { fetchImpl, now: () => t });

    const ac = new AbortController();
    onFetch = () => ac.abort();
    expect(await svc.run({ goal: 'widget' }, ac.signal)).toMatchObject({ isError: true, result: { status: 'cancelled', items: [] } });
    expect(fake.calls()).toBe(1);

    const judged = (await svc.run({ goal: 'widget' }, live())).result;
    expect(fake.calls()).toBe(2);
    expect(await svc.run({ goal: 'widget' }, live())).toEqual({ result: judged, isError: false });
    expect(fake.calls()).toBe(2);

    await svc.run({ goal: 'widget', constraints: ['only tests'] }, live());
    expect(fake.calls()).toBe(3);
    write(root, widget(2), 'widget handler two\n');
    await svc.run({ goal: 'widget' }, live());
    expect(fake.calls()).toBe(4);
    t += LIMITS.cacheTtlMs + 1;
    await svc.run({ goal: 'widget' }, live());
    expect(fake.calls()).toBe(5);

    // A file that changes while Jev judges it is published stale, without the score given for its old text.
    onFetch = () => write(root, widget(1), 'widget handler one\n');
    const raced = (await svc.run({ goal: 'widget', constraints: ['race'] }, live())).result;
    expect(raced.items.find((i) => i.source.path === widget(1))).toEqual({ source: expect.objectContaining({ path: widget(1) }), textState: 'stale', origin: 'local', judgement: 'unjudged' });
    expect(raced.reasonCodes).toContain('source_changed');
    expect(raced.status).toBe('partial');
  });
});
