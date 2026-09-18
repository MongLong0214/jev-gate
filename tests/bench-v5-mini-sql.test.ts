import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { gradeDir } from '../src/bench/checker.js';
import { isInside, isSafeId } from '../src/bench/paths.js';

interface Fragment {
  version: number;
  cases: Array<{ id: string; group: string; fixtureDir: string; request: string; setup: string[][]; evaluationSetup: string[][]; checkFile: string }>;
}

const root = join(__dirname, '..');
const manifestDir = join(root, 'bench', 'v5');
const fragment = JSON.parse(readFileSync(join(manifestDir, 'cases.mini-sql.json'), 'utf8')) as Fragment;
const cs = fragment.cases[0]!;
const fixtureDir = resolve(manifestDir, cs.fixtureDir);
const checkFile = resolve(manifestDir, cs.checkFile);
const referenceDir = join(manifestDir, 'reference', 'mini-sql');
const opts = { timeoutMs: 120_000, checkerId: 'test' };

const tmp = mkdtempSync(join(tmpdir(), 'jev-bench-v5-mini-sql-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Fixture plus the reference solution copied over it: what a complete candidate looks like. */
const solve = (name: string): string => {
  const dir = join(tmp, name);
  cpSync(fixtureDir, dir, { recursive: true });
  cpSync(referenceDir, dir, { recursive: true });
  return dir;
};

describe('bench/v5 mini-sql manifest fragment', () => {
  it('is a version 5 fragment with one case, a safe id and paths inside bench/v5', () => {
    expect(fragment.version).toBe(5);
    expect(fragment.cases).toHaveLength(1);
    expect(cs.id).toBe('mini-sql');
    expect(isSafeId(cs.id)).toBe(true);
    expect(cs.group.length).toBeGreaterThan(0);
    expect(cs.setup).toEqual([]);
    expect(cs.evaluationSetup).toEqual([]);
    expect(isInside(manifestDir, fixtureDir)).toBe(true);
    expect(isInside(manifestDir, checkFile)).toBe(true);
    expect(statSync(fixtureDir).isDirectory()).toBe(true);
    expect(existsSync(checkFile)).toBe(true);
    // The reference solution must stay out of the fixture the target receives.
    expect(existsSync(join(fixtureDir, 'src', 'analyzer.js'))).toBe(false);
    expect(existsSync(join(referenceDir, 'src', 'analyzer.js'))).toBe(true);
  });

  it('states the grammar and semantics without naming how the work is carried out', () => {
    for (const banned of [/model/i, /tier/i, /agent/i, /delegat/i, /checker/i, /모델/, /티어/, /에이전트/, /위임/, /체커/]) {
      expect(cs.request, `request mentions ${String(banned)}`).not.toMatch(banned);
    }
    for (const declared of ['우선순위', 'IS NULL', 'hash_join', 'index_scan', 'LIMIT', '안정 정렬', '지원하지 않는 것']) {
      expect(cs.request).toContain(declared);
    }
  });

  it('answers --describe with the same check ids it reports for a run', () => {
    const described = spawnSync(process.execPath, [checkFile, '--describe'], { encoding: 'utf8' });
    expect(described.status).toBe(0);
    const ids = (JSON.parse(described.stdout) as { checks: string[] }).checks;
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('null_three_valued');
    expect(ids).toContain('explain_index_scan');
    expect(ids).toContain('test_suite_passes');
  });
});

describe('bench/v5 mini-sql checker', () => {
  it('fails the broken fixture and passes the reference solution', () => {
    const broken = join(tmp, 'broken');
    cpSync(fixtureDir, broken, { recursive: true });
    const before = gradeDir(checkFile, broken, opts);
    expect(before.quality, JSON.stringify(before)).toBe('fail');
    expect(before.checks.filter((c) => c.pass === false).length).toBeGreaterThan(0);
    expect(before.environmentError).toBeNull();

    const after = gradeDir(checkFile, solve('reference'), opts);
    expect(after.quality, JSON.stringify(after)).toBe('pass');
    expect(after.required.sort()).toEqual(after.checks.map((c) => c.id).sort());
    expect(after.checks.every((c) => c.pass === true)).toBe(true);
    expect(after.run?.ms ?? 0).toBeLessThan(60_000);
  }, 180_000);

  // Each variant changes one line of one module, so the named check is the behavior that regressed.
  const variants: Array<[string, string, string, string, string]> = [
    [
      'a NULL that compares equal to another NULL',
      'src/executor.js',
      '      if (a === null || b === null) return null;\n      const c = compareValues(a, b);',
      '      if (a === null || b === null) return a === b;\n      const c = compareValues(a, b);',
      'null_three_valued',
    ],
    [
      'an ORDER BY that reorders equal keys',
      'src/executor.js',
      '      return x.index - y.index;',
      '      return y.index - x.index;',
      'order_by_stability',
    ],
    [
      'a hash build that keeps one row per key',
      'src/executor.js',
      '    if (!buckets.has(key)) buckets.set(key, []);\n    buckets.get(key).push(position);',
      '    if (!buckets.has(key)) buckets.set(key, [position]);',
      'join_inner_hash',
    ],
    [
      'a planner that never uses an index',
      'src/executor.js',
      "      return { plan: { op: 'index_scan', table: source.table, column: r.column }, rows: db.lookup(source.table, r.column, litSide.value) };",
      "      return { plan: { op: 'seq_scan', table: source.table }, rows: db.rows(source.table) };",
      'explain_index_scan',
    ],
    [
      'a formatter that left aligns numbers',
      'src/format.js',
      '  const pad = (text, c) => (numeric[c] ? text.padStart(widths[c]) : text.padEnd(widths[c]));',
      '  const pad = (text, c) => text.padEnd(widths[c]);',
      'format_table_exact',
    ],
  ];

  it.each(variants)('detects %s as %s failing', (name, file, from, to, failing) => {
    const dir = solve(`variant-${failing}`);
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    expect(before, `variant "${name}" no longer matches ${file}`).toContain(from);
    writeFileSync(path, before.replace(from, to));
    const graded = gradeDir(checkFile, dir, opts);
    expect(graded.quality, JSON.stringify(graded)).toBe('fail');
    expect(graded.checks.find((c) => c.id === failing)?.pass, JSON.stringify(graded.checks)).toBe(false);
    expect(graded.environmentError).toBeNull();
  }, 180_000);
});
