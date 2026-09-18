import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { gradeDir } from '../src/bench/checker.js';
import { loadManifest } from '../src/bench/run.js';

const root = join(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'jev-bench-fixtures-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const opts = { timeoutMs: 60_000, checkerId: 'test' };

for (const manifest of ['bench/cases.json', 'bench/v4/cases.json']) {
  const { cases, manifestDir } = loadManifest(join(root, manifest));
  describe(manifest, () => {
    it('has one case per group with safe ids', () => {
      expect(cases.length).toBeGreaterThanOrEqual(4);
      expect(new Set(cases.map((c) => c.group)).size).toBe(cases.length);
    });

    it.each(cases.map((c) => [c.id, c] as const))('%s: checker fails the broken fixture and passes the reference', (id, cs) => {
      const broken = join(tmp, manifest.replace(/\W/g, '_'), id, 'broken');
      cpSync(cs.fixtureDir, broken, { recursive: true });
      const before = gradeDir(cs.checkFile, broken, opts);
      expect(before.quality, JSON.stringify(before)).toBe('fail');
      expect(before.checks.filter((c) => c.pass === false).length).toBeGreaterThan(0);
      const fixed = join(tmp, manifest.replace(/\W/g, '_'), id, 'reference');
      cpSync(cs.fixtureDir, fixed, { recursive: true });
      cpSync(join(manifestDir, 'reference', id), fixed, { recursive: true });
      const after = gradeDir(cs.checkFile, fixed, opts);
      expect(after.quality, JSON.stringify(after)).toBe('pass');
      expect(after.required.sort()).toEqual(after.checks.map((c) => c.id).sort());
    });
  });
}

describe('behavioral regression-test checks', () => {
  const { cases } = loadManifest(join(root, 'bench', 'cases.json'));
  const cs = cases.find((c) => c.id === 'search-race')!;

  it('a late-response test added to the existing file counts', () => {
    const dir = join(tmp, 'inline-test');
    cpSync(cs.fixtureDir, dir, { recursive: true });
    cpSync(join(root, 'bench', 'reference', 'search-race', 'src'), join(dir, 'src'), { recursive: true });
    const existing = join(dir, 'test', 'search-client.test.mjs');
    writeFileSync(existing, readFileSync(existing, 'utf8') + `\ntest('late response does not overwrite newer results', async () => {\n  const pending = new Map();\n  const client = createSearchClient((q) => new Promise((resolve) => pending.set(q, resolve)));\n  const first = client.search('old');\n  const second = client.search('new');\n  pending.get('new')(['new-1']);\n  await second;\n  pending.get('old')(['old-1']);\n  await first;\n  assert.deepEqual(client.getState(), { query: 'new', results: ['new-1'] });\n});\n`);
    expect(gradeDir(cs.checkFile, dir, opts).quality).toBe('pass');
  });

  it('a fixed source whose tests never exercise the bug fails the regression-test check, and an unrelated failing test does not count', () => {
    const dir = join(tmp, 'fixed-no-test');
    cpSync(cs.fixtureDir, dir, { recursive: true });
    cpSync(join(root, 'bench', 'reference', 'search-race', 'src'), join(dir, 'src'), { recursive: true });
    const g = gradeDir(cs.checkFile, dir, opts);
    expect(g.quality).toBe('fail');
    expect(g.checks.find((c) => c.id === 'late_response_test_detects_bug')?.pass).toBe(false);
    // A deliberately broken import fails against BOTH sources, so test_suite_passes fails and the candidate is still fail.
    writeFileSync(join(dir, 'test', 'broken.test.mjs'), "import { nope } from '../src/missing.mjs';\n");
    const g2 = gradeDir(cs.checkFile, dir, opts);
    expect(g2.quality).toBe('fail');
    expect(g2.checks.find((c) => c.id === 'test_suite_passes')?.pass).toBe(false);
  });

  it('job-queue: a regression test that hangs against the unfixed source counts as detecting the bug', () => {
    const v4 = loadManifest(join(root, 'bench', 'v4', 'cases.json'));
    const jq = v4.cases.find((c) => c.id === 'job-queue')!;
    const dir = join(tmp, 'jq-hang');
    cpSync(jq.fixtureDir, dir, { recursive: true });
    cpSync(join(v4.manifestDir, 'reference', 'job-queue', 'src'), join(dir, 'src'), { recursive: true });
    // Natural shape of such a test: await the rejection. Against the broken queue this never settles.
    writeFileSync(join(dir, 'test', 'hang.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createQueue } from '../src/queue.mjs';\ntest('failing job rejects', async () => { const q = createQueue({ concurrency: 1 }); await assert.rejects(q.enqueue(async () => { throw new Error('boom'); }), /boom/); });\n");
    const g = gradeDir(jq.checkFile, dir, { ...opts, timeoutMs: 120_000 });
    expect(g.checks.find((c) => c.id === 'regression_tests_detect_bug')?.pass).toBe(true);
    expect(g.quality, JSON.stringify(g)).toBe('pass');
  }, 150_000);

  it('a candidate that does not load fails module_loads and leaves dependent checks unknown without an environment error', () => {
    const dir = join(tmp, 'syntax-error');
    cpSync(cs.fixtureDir, dir, { recursive: true });
    rmSync(join(dir, 'src', 'search-client.mjs'));
    const g = gradeDir(cs.checkFile, dir, opts);
    expect(g.quality).toBe('fail');
    expect(g.checks.find((c) => c.id === 'module_loads')?.pass).toBe(false);
    expect(g.checks.filter((c) => c.pass === null).length).toBeGreaterThan(0);
    expect(g.environmentError).toBeNull();
  });
});
