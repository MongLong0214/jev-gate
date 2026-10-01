import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createJudgementCache } from '../../src/evidence/cache.js';
import { LEXICAL_TERM_DETAIL, yieldToEventLoop } from '../../src/evidence/candidates.js';
import { createEvidenceService, type EvidenceService } from '../../src/evidence/service.js';
import { listFiles as listProjectFiles, readSource as readProjectFile, sha256Hex } from '../../src/evidence/source.js';
import { LIMITS, type EvidenceResult, type SourceRef } from '../../src/evidence/types.js';
import { config, git, lineBytes, live, repo, write } from './repo.js';

const numbered = (n: number, line = (i: number) => `line ${i}`): string => Array.from({ length: n }, (_, i) => `${line(i + 1)}\n`).join('');
const run = async (svc: EvidenceService, raw: unknown): Promise<EvidenceResult> => (await svc.run(raw, live())).result;
const local = async (root: string, over: Record<string, unknown> = {}): Promise<EvidenceService> => createEvidenceService(await config(root, over), { apiKey: null });
/** Every returned body must be the file's own bytes for its lines, under the hash of the whole file. */
const exact = (root: string, r: EvidenceResult): void => {
  for (const it of r.items) {
    const buf = readFileSync(join(root, it.source.path));
    expect(it.source.fileSha256).toBe(sha256Hex(buf));
    if (it.text !== undefined) expect(Buffer.from(it.text, 'utf8').equals(lineBytes(buf, it.source.startLine, it.source.endLine))).toBe(true);
  }
};

describe('locate and audit', () => {
  it('reaches English source from a Korean goal through queryTerms, and audit lists windows that match nothing', async () => {
    const root = repo({ 'src/retry.ts': 'export const retryWithBackoff = (n: number) => n * 2;\n', 'src/other.ts': numbered(3) });
    const svc = await local(root);
    const goal = '재시도 지연은 어디서 계산되나';
    expect(await run(svc, { goal })).toMatchObject({ status: 'ok', items: [], reasonCodes: ['no_candidate', 'remote_disabled'], next: null });
    const found = await run(svc, { goal, queryTerms: ['backoff'] });
    expect(found.items.map((i) => i.source.path)).toEqual(['src/retry.ts']);
    const audit = await run(svc, { goal, mode: 'audit' });
    expect(audit.items.map((i) => [i.source.path, i.source.startLine, i.source.endLine])).toEqual([
      ['src/other.ts', 1, 3],
      ['src/retry.ts', 1, 1],
    ]);
    exact(root, audit);
  });

  it('matches exactSymbols literally at every location and returns the exact bytes across CRLF, BOM and a missing final newline', async () => {
    const crlf = `﻿const x = a.b(c)*2;\r\nconst y = aXb(c)2;\r\n${numbered(60).replaceAll('\n', '\r\n')}return a.b(c)*3;`;
    const root = repo({ 'src/crlf.ts': crlf, 'src/plain.ts': 'nothing here\n', 'src/long.ts': `short\nconst z = a.b(c)* ${'x'.repeat(LIMITS.windowBytes)}\n` });
    const svc = await local(root);
    const r = await run(svc, { goal: 'where', exactSymbols: ['a.b(c)*'] });
    expect(r.items.map((i) => [i.source.path, i.source.startLine, i.source.endLine])).toEqual([
      ['src/crlf.ts', 1, 16],
      ['src/crlf.ts', 60, 63],
    ]);
    exact(root, r);
    // A wider view is the same file's reference with other lines, read back exactly.
    const wide = await run(svc, { goal: 'where', sources: [{ ...r.items[0]!.source, endLine: 40 }] });
    expect(wide.items[0]).toMatchObject({ textState: 'included', source: { startLine: 1, endLine: 40 } });
    expect(r.items[0]!.text!.startsWith('﻿const x')).toBe(true);
    expect(r.items[1]!.text!.endsWith('return a.b(c)*3;')).toBe(true);
    // The line too long for any window is named by reason, never cut.
    expect(r).toMatchObject({ status: 'partial', reasonCodes: ['line_too_long'], coverage: { sourceIncomplete: true } });
  });

  it('pages without gaps or duplicates, and refuses a continuation when the file, the query or the scope changed', async () => {
    const root = repo({ 'src/a.ts': numbered(200), 'lib/b.ts': numbered(2) });
    const svc = await local(root);
    const q = { goal: 'review', mode: 'audit', roots: ['src'], limit: 2 };
    const seen: SourceRef[] = [];
    let page = await run(svc, q);
    const snapshot = page.snapshotId;
    for (;;) {
      seen.push(...page.items.map((i) => i.source));
      expect(page.snapshotId).toBe(snapshot);
      if (!page.next) break;
      expect(page.status).toBe('partial');
      page = await run(svc, { ...q, ...page.next });
    }
    expect(seen.map((s) => [s.startLine, s.endLine])).toEqual([[1, 40], [41, 80], [81, 120], [121, 160], [161, 200]]);
    expect(page).toMatchObject({ status: 'ok', coverage: { candidates: 5, pageCandidates: 1 } });

    const first = await run(svc, q);
    const next = first.next!;
    const refused = { status: 'partial', items: [], next: null, snapshotId: null };
    expect(await run(svc, { ...q, goal: 'another question', ...next })).toMatchObject({ ...refused, reasonCodes: ['source_changed'] });
    expect(await run(svc, { ...q, roots: ['src', 'lib'], ...next })).toMatchObject({ ...refused, reasonCodes: ['source_changed'] });
    write(root, 'src/a.ts', numbered(200, (i) => `changed ${i}`));
    expect(await run(svc, { ...q, ...next })).toMatchObject({ ...refused, reasonCodes: ['source_changed'] });
    expect((await svc.run({ ...q, offset: 2 }, live())).result.reasonCodes).toEqual(['invalid_input']);
  });
});

describe('sources', () => {
  it('returns the exact text of a returned reference, stale for a changed file, source_missing for a deleted one', async () => {
    const root = repo({ 'src/a.ts': 'one\r\ntwo\r\nthree', 'src/b.ts': 'bee\n', 'src/wide.ts': numbered(30, () => 'w'.repeat(300)) });
    const fetchImpl = vi.fn();
    const svc = createEvidenceService(await config(root, { remote: true }), { apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const refOf = async (symbol: string): Promise<SourceRef> => (await run(svc, { goal: 'x', exactSymbols: [symbol] })).items[0]!.source;
    const a = await refOf('two');
    const b = await refOf('bee');
    const got = await run(svc, { goal: 'x', sources: [{ ...a, startLine: 2, endLine: 3 }, b] });
    expect(got).toMatchObject({ status: 'ok', backend: 'local', snapshotId: null, next: null });
    expect(got.items.map((i) => [i.text, i.textState])).toEqual([['two\r\nthree', 'included'], ['bee\n', 'included']]);

    write(root, 'src/a.ts', 'one\r\nTWO\r\nthree');
    rmSync(join(root, 'src/b.ts'));
    const after = await run(svc, { goal: 'x', sources: [a, b] });
    expect(after.items).toEqual([
      { source: a, textState: 'stale', origin: 'local', judgement: 'unjudged' },
      { source: b, textState: 'stale', origin: 'local', judgement: 'unjudged' },
    ]);
    expect(after).toMatchObject({ status: 'partial', reasonCodes: ['source_changed', 'source_missing'] });

    const wide = await refOf('www');
    expect((await svc.run({ goal: 'x', sources: [{ ...wide, startLine: 1, endLine: 41 }] }, live())).result.reasonCodes).toEqual(['invalid_input']);
    expect((await svc.run({ goal: 'x', sources: [{ ...wide, startLine: 1, endLine: 30 }] }, live())).result.reasonCodes).toEqual(['range_too_large']);
    expect((await svc.run({ goal: 'x', sources: [wide], roots: ['src'] }, live())).result.reasonCodes).toEqual(['invalid_input']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads back only a listed file, and refuses rather than folds a read-back over 64 KiB', async () => {
    const big = numbered(640, (i) => `${i} ${'b'.repeat(170)}`);
    const root = repo({ '.gitignore': 'secret.ts\n', 'src/secret.ts': 'hidden\n', 'src/nested/in.ts': 'inner\n', 'src/big.ts': big });
    git(join(root, 'src/nested'), 'init', '-q');
    const svc = await local(root);
    const ref = (path: string, text: string): SourceRef => ({ path, startLine: 1, endLine: 1, fileSha256: sha256Hex(text) });
    const hidden = await run(svc, { goal: 'x', sources: [ref('src/secret.ts', 'hidden\n'), ref('src/nested/in.ts', 'inner\n'), ref('src/gone.ts', '')] });
    expect(hidden.items.map((i) => [i.textState, i.text])).toEqual([['stale', undefined], ['stale', undefined], ['stale', undefined]]);
    expect(hidden.reasonCodes).toEqual(['out_of_scope', 'source_missing']);

    const sources = Array.from({ length: 16 }, (_, k) => ({ path: 'src/big.ts', startLine: k * 40 + 1, endLine: k * 40 + 40, fileSha256: sha256Hex(big) }));
    const over = await svc.run({ goal: 'x', sources }, live());
    expect(over).toMatchObject({ isError: true, result: { items: [], reasonCodes: ['output_limit'] } });
  });

  it('makes a file whose path names a term a candidate, and excludes fixed directories in any case', async () => {
    const root = repo({ 'src/auth/guard.ts': 'export const check = () => true;\n', 'NODE_MODULES/pkg/auth.ts': 'auth\n' });
    const r = await run(await local(root), { goal: 'x', queryTerms: ['auth'] });
    expect(r.items.map((i) => [i.source.path, i.source.startLine])).toEqual([['src/auth/guard.ts', 1]]);
  });
});

describe('bounds', () => {
  it('fits the whole serialized result in 64 KiB by omitting whole bodies, never by cutting text', async () => {
    // Quotes and backslashes double under JSON escaping, so the bound is on the escaped size.
    const root = repo({ 'src/big.ts': numbered(640, () => '"\\'.repeat(80)) });
    const r = await run(await local(root), { goal: 'x', mode: 'audit', limit: 16 });
    expect(Buffer.byteLength(JSON.stringify(r), 'utf8')).toBeLessThanOrEqual(LIMITS.resultBytes);
    expect(r.items).toHaveLength(16);
    const omitted = r.items.filter((i) => i.textState === 'omitted_budget');
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.every((i) => i.text === undefined)).toBe(true);
    expect(r).toMatchObject({ status: 'partial', coverage: { omittedBodies: omitted.length, pageCandidates: 16 } });
    expect(r.reasonCodes).toContain('output_limit');
    exact(root, r);
  });

  it('reports the file, size and candidate caps and the deadline as they happened', async () => {
    const files: Record<string, string> = { 'huge/big.ts': 'x'.repeat(LIMITS.fileBytes + 1) };
    for (let i = 0; i < 205; i++) files[`many/f${String(i).padStart(3, '0')}.ts`] = numbered(240);
    const root = repo(files);
    const capped = await run(await local(root), { goal: 'x', mode: 'audit', roots: ['many'], limit: 1 });
    expect(capped.coverage).toMatchObject({ inventoryComplete: true, filesTotal: 205, readFiles: LIMITS.files, candidates: LIMITS.candidates, sourceIncomplete: true });
    expect(capped).toMatchObject({ status: 'partial', reasonCodes: ['source_limit', 'remote_disabled'] });
    const big = await run(await local(root), { goal: 'x', mode: 'audit', roots: ['huge'] });
    expect(big).toMatchObject({ status: 'partial', items: [], reasonCodes: ['source_limit', 'no_candidate', 'remote_disabled'], coverage: { filesTotal: 1, readFiles: 0, skippedFiles: 1, sourceIncomplete: true } });

    // Each clock read moves 500 ms: the search stops at its share of the 3 s, and what cannot be re-read is not published.
    let t = 0;
    const slow = createEvidenceService(await config(root), { apiKey: null, now: () => (t += 500) });
    const late = (await slow.run({ goal: 'x', mode: 'audit', roots: ['many'], limit: 1 }, live())).result;
    expect(late.coverage).toMatchObject({ filesTotal: 205, readFiles: 4, sourceIncomplete: true });
    expect(late.items.map((i) => [i.textState, i.text])).toEqual([['omitted_budget', undefined]]);
    expect(late).toMatchObject({ status: 'partial', reasonCodes: ['deadline', 'remote_disabled', 'source_unverified'] });
  });

  it('turns cancellation into cancelled and a missing key into a local result, with no fetch', async () => {
    const root = repo({ 'src/a.ts': 'widget\n' });
    const fetchImpl = vi.fn();
    const cfg = await config(root, { remote: true });
    const ac = new AbortController();
    ac.abort();
    const cancelled = await createEvidenceService(cfg, { apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch }).run({ goal: 'widget' }, ac.signal);
    expect(cancelled).toMatchObject({ isError: true, result: { status: 'cancelled', items: [], reasonCodes: ['cancelled'] } });
    const keyless = await createEvidenceService(cfg, { apiKey: null, fetchImpl: fetchImpl as unknown as typeof fetch }).run({ goal: 'widget' }, live());
    expect(keyless).toMatchObject({ isError: false, result: { status: 'ok', backend: 'local', reasonCodes: ['missing_key'] } });
    expect(keyless.result.items.map((i) => [i.text, i.origin, i.judgement])).toEqual([['widget\n', 'local', 'unjudged']]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses a newly entered key in the same service process and keeps exact reads local', async () => {
    const root = repo({ 'src/a.ts': 'widget\n' });
    let key: string | null = null;
    const headers: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(new Headers(init.headers).get('authorization')!);
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      expect(String(init.body)).not.toContain('fake-newly-entered-key');
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'choice', choice: 'relevant', confidence: .91, probabilities: { relevant: .91, unrelated: .05, needs_context: .04 } }])) }));
    });
    const svc = createEvidenceService(await config(root, { remote: true }), { apiKey: null, getApiKey: () => key, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await run(svc, { goal: 'widget' })).toMatchObject({ backend: 'local', reasonCodes: ['missing_key'] });
    expect(fetchImpl).not.toHaveBeenCalled();
    key = 'fake-newly-entered-key';
    expect(await run(svc, { goal: 'widget' })).toMatchObject({ backend: 'jev' });
    expect(headers).toEqual(['Bearer fake-newly-entered-key']);
    await run(svc, { goal: 'widget', exactSymbols: ['widget'] }); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

const lexicalGoal = (n: number): string => Array.from({ length: n }, (_, i) => `aaaa${String(i).padStart(5, '0')}`).join(' ');

describe('lexical input', () => {
  it('rejects too many goal terms before scan or HTTP, and does not confuse that with the byte cap', async () => {
    const goal = lexicalGoal(1500);
    expect(Buffer.byteLength(JSON.stringify({ goal }), 'utf8')).toBeLessThan(LIMITS.inputBytes);
    const root = repo({ 'src/a.ts': 'aaaa00000\n' });
    const listFiles = vi.fn(listProjectFiles);
    const readSource = vi.fn(readProjectFile);
    const fetchImpl = vi.fn();
    const svc = createEvidenceService(await config(root, { remote: true }), { apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch, listFiles, readSource });
    const reply = await svc.run({ goal, mode: 'locate' }, live());
    expect(reply).toMatchObject({ isError: true, detail: LEXICAL_TERM_DETAIL, result: { status: 'unavailable', items: [], snapshotId: null, reasonCodes: ['invalid_input'], coverage: { readFiles: 0 } } });
    expect(reply.detail).not.toMatch(/root/i);
    expect(listFiles).not.toHaveBeenCalled();
    expect(readSource).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const bytes = 'word '.repeat(5000);
    expect(Buffer.byteLength(JSON.stringify({ goal: bytes }), 'utf8')).toBeGreaterThan(LIMITS.inputBytes);
    const overBytes = await svc.run({ goal: bytes }, live());
    expect(overBytes.detail).toBe('the input is over 16 KiB');
    expect(overBytes.detail).not.toBe(LEXICAL_TERM_DETAIL);
    expect(listFiles).not.toHaveBeenCalled();

    const phrase = Array.from({ length: LIMITS.lexicalTerms }, (_, i) => `zzzz${String(i).padStart(4, '0')}`).join(' ');
    const derived = await svc.run({ goal: 'short question', queryTerms: [phrase] }, live());
    expect(derived.detail).toBe(LEXICAL_TERM_DETAIL);
    expect(listFiles).not.toHaveBeenCalled();
  });

  it('keeps a long goal and its constraints when short queryTerms are the only lexical hints', async () => {
    const goal = lexicalGoal(1500);
    const constraints = ['keep-this-constraint'];
    const raw = { goal, queryTerms: ['needle'], constraints };
    expect(Buffer.byteLength(JSON.stringify(raw), 'utf8')).toBeLessThan(LIMITS.inputBytes);
    const root = repo({ 'src/decoy.ts': 'aaaa00000\n', 'src/hit.ts': 'needle here\n' });
    const requests: Array<{ state: { goal: string; constraints: string[] } }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)) as { state: { goal: string; constraints: string[] } });
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'choice', choice: 'relevant', probabilities: { relevant: 0.91, unrelated: 0.05, needs_context: 0.04 }, confidence: 0.91 }])),
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 });
    });
    const svc = createEvidenceService(await config(root, { remote: true }), { apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const found = await run(svc, raw);
    expect(found.items.map((i) => i.source.path)).toEqual(['src/hit.ts']);
    expect(found.items[0]!.text).toBe('needle here\n');
    expect(requests[0]!.state.goal).toBe(goal);
    expect(requests[0]!.state.constraints).toEqual(constraints);
    expect(requests[0]!.state.goal).toContain('aaaa01499');
  });

  it('does not reject audit, exact, or sources for unused goal terms', async () => {
    const goal = lexicalGoal(200);
    const root = repo({ 'src/a.ts': 'marker\n' });
    const listFiles = vi.fn(listProjectFiles);
    const svc = createEvidenceService(await config(root), { apiKey: null, listFiles });
    const audit = await run(svc, { goal, mode: 'audit' });
    expect(audit.reasonCodes).not.toContain('invalid_input');
    expect(audit.items.map((i) => i.source.path)).toEqual(['src/a.ts']);
    const exact = await run(svc, { goal, exactSymbols: ['marker'] });
    expect(exact.reasonCodes).not.toContain('invalid_input');
    expect(exact.items[0]!.text).toBe('marker\n');
    const back = await run(svc, { goal, sources: [exact.items[0]!.source] });
    expect(back.reasonCodes).not.toContain('invalid_input');
    expect(back.items[0]!.text).toBe('marker\n');
    expect(back.snapshotId).toBeNull();
    expect(listFiles).toHaveBeenCalled();
  });
});

describe('search endings', () => {
  const needleFile = (): string => 'needle\n'.repeat(400);

  it('applies the search budget during generation, before a full candidate set exists', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`src/f${i}.ts`] = needleFile();
    const root = repo(files);
    const full = await run(await local(root), { goal: 'needle', limit: 16 });
    let t = 0;
    let yields = 0;
    const stopped = createEvidenceService(await config(root), {
      apiKey: null,
      now: () => t,
      yield: async () => {
        yields += 1;
        t = 10_000;
      },
    });
    const partial = (await stopped.run({ goal: 'needle', limit: 16 }, live())).result;
    expect(yields).toBeGreaterThan(0);
    expect(partial.coverage.candidates).toBeGreaterThan(0);
    expect(partial.coverage.candidates).toBeLessThan(full.coverage.candidates);
    expect(partial.reasonCodes).toContain('deadline');
    expect(partial.coverage.sourceIncomplete).toBe(true);
    expect(partial.status).toBe('partial');
  });

  it('re-verifies a budget stop while reserve remains, and does not call Jev or write the cache', async () => {
    const root = repo({ 'src/a.ts': needleFile() });
    const fetchImpl = vi.fn();
    const cache = createJudgementCache(() => 0);
    let t = 80_000;
    const reads: string[] = [];
    const svc = createEvidenceService(await config(root, { remote: true }), {
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache,
      now: () => t,
      readSource: async (dir, rel) => {
        reads.push(rel);
        return readProjectFile(dir, rel);
      },
      yield: async () => {
        // deadline is t0+3000; readBy is 400ms publish reserve plus 1500ms remote reserve earlier.
        t = 82_000;
      },
    });
    const reply = await svc.run({ goal: 'where', queryTerms: ['needle'], limit: 2 }, live());
    expect(reply.result.status).toBe('partial');
    expect(reply.result.reasonCodes).toContain('deadline');
    expect(reply.result.coverage.sourceIncomplete).toBe(true);
    expect(reply.result.items.length).toBeGreaterThan(0);
    expect(reply.result.items.every((i) => i.textState === 'included' && i.text?.includes('needle'))).toBe(true);
    exact(root, reply.result);
    expect(reads.filter((rel) => rel === 'src/a.ts').length).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cache.size()).toBe(0);
  });

  it('does not re-read, call Jev, or cache when the total deadline is already gone', async () => {
    const root = repo({ 'src/a.ts': needleFile() });
    const fetchImpl = vi.fn();
    const cache = createJudgementCache(() => 0);
    let t = 80_000;
    let after = false;
    const lateReads: string[] = [];
    const svc = createEvidenceService(await config(root, { remote: true }), {
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache,
      now: () => t,
      readSource: async (dir, rel) => {
        if (after) lateReads.push(rel);
        return readProjectFile(dir, rel);
      },
      yield: async () => {
        after = true;
        t = 90_000;
        write(root, 'src/a.ts', 'CHANGED\n');
      },
    });
    const reply = await svc.run({ goal: 'where', queryTerms: ['needle'], limit: 2 }, live());
    expect(reply.result.status).toBe('partial');
    expect(reply.result.reasonCodes).toEqual(expect.arrayContaining(['deadline', 'source_unverified']));
    expect(reply.result.reasonCodes).not.toContain('source_changed');
    expect(reply.result.items.every((i) => i.text === undefined && i.textState === 'omitted_budget')).toBe(true);
    expect(lateReads).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cache.size()).toBe(0);
  });

  it('cancels the scanning call only, then serves the next request on the same service', async () => {
    const root = repo({ 'src/a.ts': needleFile(), 'src/mark.ts': 'MARKER\n' });
    const fetchImpl = vi.fn();
    const cache = createJudgementCache(() => 0);
    const ac = new AbortController();
    let stopReads = false;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const svc = createEvidenceService(await config(root, { remote: true }), {
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache,
      readSource: async (dir, rel) => {
        // The other call is rooted at src/mark.ts, so a late read of the scan file belongs to the cancelled call.
        if (stopReads && rel === 'src/a.ts') throw new Error(`read ${rel} after cancel`);
        return readProjectFile(dir, rel);
      },
      yield: async () => {
        if (release) {
          release();
          release = undefined;
        }
        await yieldToEventLoop();
      },
    });
    const heavy = svc.run({ goal: 'where', queryTerms: ['needle'], roots: ['src/a.ts'] }, ac.signal);
    await started;
    const light = svc.run({ goal: 'marker', exactSymbols: ['MARKER'], roots: ['src/mark.ts'] }, live());
    // setTimeout would run only after this scan's setImmediate chain drained. Queue the abort behind the yield already waiting.
    setImmediate(() => {
      stopReads = true;
      ac.abort();
    });
    const lightReply = await light;
    expect(lightReply.result.status).not.toBe('cancelled');
    expect(lightReply.result.items.map((i) => i.text)).toEqual(['MARKER\n']);
    const heavyReply = await heavy;
    expect(heavyReply).toMatchObject({ isError: true, result: { status: 'cancelled', items: [], reasonCodes: ['cancelled'] } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cache.size()).toBe(0);
    const next = await svc.run({ goal: 'marker', exactSymbols: ['MARKER'], roots: ['src/mark.ts'] }, live());
    expect(next.result.items).toHaveLength(1);
    expect(next.result.status).not.toBe('cancelled');
  });

  it('still judges a capped page when the deadline remains, and re-reads only that page', async () => {
    const root = repo({ 'src/a.ts': 'alpha\n', 'src/z.ts': 'alpha zzqq\n' });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'choice', choice: 'relevant', probabilities: { relevant: 0.91, unrelated: 0.05, needs_context: 0.04 }, confidence: 0.91 }]));
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    });
    const cache = createJudgementCache(() => 1);
    const reads: string[] = [];
    const svc = createEvidenceService(await config(root, { remote: true }), {
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache,
      now: () => 5_000,
      readSource: async (dir, rel) => {
        reads.push(rel);
        return readProjectFile(dir, rel);
      },
    });
    // Enough windows to stop inside a.ts. zzqq exists only in z.ts, so a global ranking would have put that file first.
    write(root, 'src/a.ts', 'alpha\n'.repeat(40 * (LIMITS.candidates + 1)));
    const found = await run(svc, { goal: 'alpha zzqq', limit: 2 });
    expect(found.status).toBe('partial');
    expect(found.reasonCodes).toContain('source_limit');
    expect(found.coverage.candidates).toBe(LIMITS.candidates);
    expect(found.coverage.sourceIncomplete).toBe(true);
    expect(found.items.every((i) => i.source.path === 'src/a.ts' && i.textState === 'included')).toBe(true);
    expect(reads.filter((rel) => rel === 'src/z.ts')).toEqual(['src/z.ts']);
    expect(reads.filter((rel) => rel === 'src/a.ts')).toEqual(['src/a.ts', 'src/a.ts']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(1);
  });
});

describe('snapshots', () => {
  it('pages one set, ignores limit, and changes when queryTerms or the file change', async () => {
    const root = repo({ 'src/a.ts': 'needle\n'.repeat(90), 'src/b.ts': 'other\n' });
    const svc = await local(root);
    const goal = 'where is the needle';
    const q = { goal, queryTerms: ['needle'], mode: 'locate' as const };
    const first = await run(svc, { ...q, limit: 1 });
    const wider = await run(svc, { ...q, limit: 2 });
    expect(first.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(wider.snapshotId).toBe(first.snapshotId);
    expect(first.next?.expectedSnapshot).toBe(first.snapshotId);
    const second = await run(svc, { ...q, limit: 1, ...first.next });
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.items[0]!.source.startLine).toBeGreaterThan(first.items[0]!.source.endLine);
    exact(root, first);
    exact(root, second);
    const otherTerms = await run(svc, { goal, queryTerms: ['other'], ...first.next });
    expect(otherTerms).toMatchObject({ status: 'partial', items: [], snapshotId: null, reasonCodes: ['source_changed'] });
    const audit = await run(svc, { goal, mode: 'audit', limit: 1 });
    const exactHit = await run(svc, { goal, exactSymbols: ['needle'], limit: 1 });
    expect(audit.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(exactHit.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.snapshotId).not.toBe(first.snapshotId);
    expect(exactHit.snapshotId).not.toBe(first.snapshotId);
    const back = await run(svc, { goal, sources: [exactHit.items[0]!.source] });
    expect(back.snapshotId).toBeNull();
    expect(back.items[0]!.text).toBe(exactHit.items[0]!.text);
    write(root, 'src/a.ts', `${'needle\n'.repeat(90)}\n`);
    const changed = await run(svc, { ...q, limit: 1, ...first.next });
    expect(changed.reasonCodes).toContain('source_changed');
    expect(changed.snapshotId).toBeNull();
  });

  it('distinguishes a full 1,024-candidate set from one that stopped at the cap', async () => {
    const root = repo({ 'src/a.ts': 'a\n'.repeat(40 * LIMITS.candidates) });
    const full = await run(await local(root), { goal: 'review', mode: 'audit', limit: 1 });
    expect(full.coverage).toMatchObject({ candidates: LIMITS.candidates, sourceIncomplete: false });
    expect(full.reasonCodes).not.toContain('source_limit');
    expect(full.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    write(root, 'src/a.ts', 'a\n'.repeat(40 * LIMITS.candidates + 1));
    const capped = await run(await local(root), { goal: 'review', mode: 'audit', limit: 1 });
    expect(capped.coverage).toMatchObject({ candidates: LIMITS.candidates, sourceIncomplete: true });
    expect(capped.reasonCodes).toContain('source_limit');
    expect(capped.snapshotId).not.toBe(full.snapshotId);
    const again = await run(await local(root), { goal: 'review', mode: 'audit', limit: 8 });
    expect(again.snapshotId).toBe(capped.snapshotId);
  });
});
