import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildCandidates,
  LEXICAL_TERM_DETAIL,
  planLexical,
  searchTerms,
  yieldToEventLoop,
  type CandidateBudget,
  type CandidateQuery,
  type SourceFile,
} from '../../src/evidence/candidates.js';
import { LIMITS } from '../../src/evidence/types.js';

const open = (over: Partial<CandidateBudget> = {}): CandidateBudget => ({
  now: over.now ?? (() => 0),
  until: over.until ?? 1_000_000,
  signal: over.signal ?? new AbortController().signal,
  yield: over.yield ?? (async () => {}),
});

const locate = (goal: string, queryTerms: string[] = [], exactSymbols: string[] = []): CandidateQuery => ({
  mode: 'locate',
  goal,
  queryTerms,
  exactSymbols,
});

const file = (path: string, text: string, sha = 'ab'): SourceFile => ({ path, text, sha256: sha.repeat(32) });

const watchdog = async <T>(work: Promise<T>, ms = 5_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`watchdog ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const words = (n: number, stem = 'zzzz'): string => Array.from({ length: n }, (_, i) => `${stem}${String(i).padStart(4, '0')}`).join(' ');

describe('lexical terms', () => {
  it('keeps the goal-only weights and does not union the goal back into explicit queryTerms', () => {
    expect([...searchTerms('parseHTTPRequest', []).keys()]).toEqual(['parsehttprequest', 'parse', 'http', 'request']);
    const hinted = searchTerms('alpha zebra', ['beta']);
    expect([...hinted.keys()]).toEqual(['beta']);
    expect(hinted.get('beta')).toBe(3);
    expect(planLexical(locate(words(LIMITS.lexicalTerms))).overflow).toBe(false);
    expect(planLexical(locate(words(LIMITS.lexicalTerms + 1))).overflow).toBe(true);
    // The whole queryTerm string counts, so 128 words plus that phrase is over the cap. Nothing is kept.
    expect(planLexical(locate('short question', [words(LIMITS.lexicalTerms)])).overflow).toBe(true);
    expect(planLexical(locate('short question', [words(LIMITS.lexicalTerms - 1)])).overflow).toBe(false);
    expect(planLexical({ mode: 'audit', goal: words(LIMITS.lexicalTerms + 1), queryTerms: [], exactSymbols: [] }).overflow).toBe(false);
    expect(planLexical(locate(words(LIMITS.lexicalTerms + 1), [], ['ExactName'])).overflow).toBe(false);
    expect(LEXICAL_TERM_DETAIL).not.toMatch(/root/i);
  });

  it('rejects the hang fixture before scanning any file text', async () => {
    const goal = Array.from({ length: 1500 }, (_, i) => `aaaa${String(i).padStart(5, '0')}`).join(' ');
    const text = ('a'.repeat(4095) + '\n').repeat(60);
    const files = Array.from({ length: 48 }, (_, i) => file(`src/f${i}.ts`, text, '0'));
    const ac = new AbortController();
    const set = await watchdog(
      buildCandidates(files, locate(goal), { ...open({ signal: ac.signal, yield: yieldToEventLoop }), until: Date.now() + 60_000, now: Date.now }),
      3_000,
    );
    ac.abort();
    expect(set.overflow).toBe(true);
    expect(set.scannedFiles).toBe(0);
    expect(set.candidates).toEqual([]);
    expect(set.peaks).toEqual({ hits: 0, windows: 0, scored: 0 });
    expect(Buffer.byteLength(JSON.stringify({ goal }), 'utf8')).toBeLessThan(LIMITS.inputBytes);
  });
});

describe('candidate bounds', () => {
  it('keeps short-query score order, including ties and a path-only hit', async () => {
    const ranked = await buildCandidates(
      [file('src/a.ts', 'alpha beta\nonly alpha\n', 'aa'), file('src/b.ts', 'beta\n', 'bb'), file('src/m.ts', 'nothing\n', 'cc')],
      locate('alpha beta'),
      open(),
    );
    expect(ranked.candidates.map((c) => [c.path, c.startLine, c.endLine])).toEqual([
      ['src/a.ts', 1, 2],
      ['src/b.ts', 1, 1],
    ]);
    expect(ranked.capped).toBe(false);
    expect(ranked.stopped).toBeNull();

    const tied = await buildCandidates([file('src/a.ts', 'alpha\n', 'aa'), file('src/b.ts', 'alpha\n', 'bb')], locate('alpha'), open());
    expect(tied.candidates.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts']);

    const hinted = await buildCandidates(
      [file('src/a.ts', 'beta\n', 'aa'), file('src/z.ts', 'alpha zebra\n', 'bb')],
      locate('alpha zebra', ['beta']),
      open(),
    );
    expect(hinted.candidates.map((c) => c.path)).toEqual(['src/a.ts']);
    expect(hinted.candidates[0]!.text).toBe('beta\n');
  });

  it('stops a locate scan when the injected clock passes the search budget', async () => {
    const text = 'needle\n'.repeat(400);
    const files = Array.from({ length: 4 }, (_, i) => file(`src/f${i}.ts`, text, String(i + 1)));
    let t = 0;
    let yields = 0;
    const set = await buildCandidates(files, locate('needle'), open({
      now: () => t,
      until: 50,
      yield: async () => {
        yields += 1;
        t = 50;
      },
    }));
    expect(yields).toBeGreaterThan(0);
    expect(set.stopped).toBe('deadline');
    expect(set.candidates.length).toBeGreaterThan(0);
    expect(set.scannedFiles).toBeLessThan(files.length);
    const full = await buildCandidates(files, locate('needle'), open());
    expect(set.candidates.length).toBeLessThan(full.candidates.length);
    expect(full.stopped).toBeNull();
    expect(full.scannedFiles).toBe(files.length);
  });

  it('observes a real timer abort during the scan, because the scan yields', async () => {
    const terms = Array.from({ length: 64 }, (_, i) => `bbbb${String(i).padStart(4, '0')}`);
    const text = ('c'.repeat(1500) + '\n').repeat(80);
    const files = Array.from({ length: 6 }, (_, i) => file(`src/f${i}.ts`, text, String(i + 1)));
    const ac = new AbortController();
    const pending = buildCandidates(files, locate('find', terms), open({ signal: ac.signal, until: 1_000_000, yield: yieldToEventLoop, now: () => 0 }));
    setImmediate(() => ac.abort());
    const set = await watchdog(pending, 8_000);
    expect(set.stopped).toBe('cancelled');
    expect(set.scannedFiles).toBeLessThan(files.length);
    const again = await buildCandidates([file('src/a.ts', 'okay\n', 'aa')], locate('okay'), open());
    expect(again.stopped).toBeNull();
    expect(again.candidates.map((c) => c.text)).toEqual(['okay\n']);
  });

  it('caps hits, windows and scored while collecting and does not pretend the prefix is the global top', async () => {
    const lines = 40 * 1025;
    // `ab` is below the 3-character term floor, so the repeating line has to be a real term. `zzqq` only on the later
    // file would outrank every `alpha` window if the cap were applied after a global sort.
    const text = 'alpha\n'.repeat(lines);
    const set = await buildCandidates(
      [file('src/a.ts', text, '11'), file('src/z.ts', 'alpha zzqq\n', '22')],
      locate('alpha zzqq'),
      open(),
    );
    expect(set.capped).toBe(true);
    expect(set.candidates).toHaveLength(LIMITS.candidates);
    expect(set.candidates.every((c) => c.path === 'src/a.ts')).toBe(true);
    expect(set.peaks.windows).toBeLessThanOrEqual(LIMITS.candidates);
    expect(set.peaks.scored).toBeLessThanOrEqual(LIMITS.candidates);
    expect(set.peaks.hits).toBeLessThanOrEqual(lines);
    expect(set.peaks.hits).toBeGreaterThan(0);
    expect(set.scannedFiles).toBe(0);

    const exact = await buildCandidates([file('src/a.ts', 'ab\n'.repeat(40 * LIMITS.candidates), '11')], { mode: 'audit', goal: 'review', queryTerms: [], exactSymbols: [] }, open());
    expect(exact.capped).toBe(false);
    expect(exact.candidates).toHaveLength(LIMITS.candidates);
    expect(exact.scannedFiles).toBe(1);
    expect(exact.stopped).toBeNull();

    const over = await buildCandidates([file('src/a.ts', 'ab\n'.repeat(40 * LIMITS.candidates + 1), '11')], { mode: 'audit', goal: 'review', queryTerms: [], exactSymbols: [] }, open());
    expect(over.capped).toBe(true);
    expect(over.candidates).toHaveLength(LIMITS.candidates);
    expect(over.scannedFiles).toBe(0);
  });
});

describe('docs', () => {
  it('states the term cap, the partial prefix, and that the budget is cooperative', () => {
    const readme = readFileSync(join(__dirname, '..', '..', 'plugins', 'evidence', 'README.md'), 'utf8');
    expect(readme).toContain(`${LIMITS.lexicalTerms} unique`);
    expect(readme).toContain('not an operating-system or network guarantee');
    expect(readme).toContain('not the repository\'s global top');
    expect(readme).toContain('Narrowing');
    expect(readme).not.toContain('narrowing roots fixes');
  });
});
