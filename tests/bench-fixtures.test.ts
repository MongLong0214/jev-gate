import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { gradeDir, loadManifest } from '../src/bench/run.js';

const root = join(__dirname, '..');
const cases = loadManifest(join(root, 'bench', 'cases.json'));
const tmp = mkdtempSync(join(tmpdir(), 'jev-bench-fixtures-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('bench fixtures and checkers', () => {
  it('manifest is v3 with one case per group and every path resolves', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
    expect(new Set(cases.map((c) => c.group)).size).toBe(cases.length);
  });

  it.each(cases.map((c) => [c.id, c] as const))('%s: checker fails the broken fixture and passes the reference', (id, cs) => {
    const broken = join(tmp, id, 'broken');
    cpSync(cs.fixtureDir, broken, { recursive: true });
    const before = gradeDir(cs.checkFile, broken, 60_000);
    expect(before.quality, JSON.stringify(before)).toBe('fail');
    expect(before.checks.find((c) => c.id === 'module_loads')?.pass).toBe(true);
    expect(before.checks.filter((c) => c.pass === false).length).toBeGreaterThan(0);

    const fixed = join(tmp, id, 'reference');
    cpSync(cs.fixtureDir, fixed, { recursive: true });
    cpSync(join(root, 'bench', 'reference', id), fixed, { recursive: true });
    const after = gradeDir(cs.checkFile, fixed, 60_000);
    expect(after.quality, JSON.stringify(after)).toBe('pass');
    expect(after.checks.every((c) => c.pass === true)).toBe(true);
    expect(after.required.sort()).toEqual(after.checks.map((c) => c.id).sort());
  });

  it('search-race grades by behavior, not test-file layout: a late-response test added to the existing file counts', () => {
    const cs = cases.find((c) => c.id === 'search-race')!;
    const dir = join(tmp, 'inline-test');
    cpSync(cs.fixtureDir, dir, { recursive: true });
    cpSync(join(root, 'bench', 'reference', 'search-race', 'src'), join(dir, 'src'), { recursive: true });
    // The regression test lives inside the pre-existing test file instead of a new one.
    const existing = join(dir, 'test', 'search-client.test.mjs');
    writeFileSync(
      existing,
      readFileSync(existing, 'utf8') +
        `
test('late response does not overwrite newer results', async () => {
` +
        `  const pending = new Map();
` +
        `  const client = createSearchClient((q) => new Promise((resolve) => pending.set(q, resolve)));
` +
        `  const first = client.search('old');
  const second = client.search('new');
` +
        `  pending.get('new')(['new-1']);
  await second;
  pending.get('old')(['old-1']);
  await first;
` +
        `  assert.deepEqual(client.getState(), { query: 'new', results: ['new-1'] });
});
`,
    );
    const g = gradeDir(cs.checkFile, dir, 60_000);
    expect(g.quality, JSON.stringify(g)).toBe('pass');
  });

  it('search-race rejects a fixed source whose tests never exercise the bug', () => {
    const cs = cases.find((c) => c.id === 'search-race')!;
    const dir = join(tmp, 'fixed-no-test');
    cpSync(cs.fixtureDir, dir, { recursive: true });
    cpSync(join(root, 'bench', 'reference', 'search-race', 'src'), join(dir, 'src'), { recursive: true });
    const g = gradeDir(cs.checkFile, dir, 60_000);
    expect(g.quality).toBe('fail');
    expect(g.checks.find((c) => c.id === 'late_response_test_detects_bug')?.pass).toBe(false);
    expect(g.checks.find((c) => c.id === 'stale_response_ignored')?.pass).toBe(true);
  });

  it('a candidate that does not load fails module_loads and leaves dependent checks unknown', () => {
    const cs = cases[0]!;
    const dir = join(tmp, 'syntax-error');
    cpSync(cs.fixtureDir, dir, { recursive: true });
    const srcFile = join(dir, 'src', readFileSync(cs.checkFile, 'utf8').match(/importModule\('src\/([^']+)'\)/)![1]!);
    rmSync(srcFile);
    const g = gradeDir(cs.checkFile, dir, 60_000);
    expect(g.quality).toBe('fail');
    expect(g.checks.find((c) => c.id === 'module_loads')?.pass).toBe(false);
    expect(g.checks.filter((c) => c.pass === null).length).toBeGreaterThan(0);
    expect(g.environmentError).toBeNull();
  });
});
