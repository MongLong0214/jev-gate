import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { foldVitest, isVitestCommand, MARK, utf8Bytes, withNote } from '../../mods/output/hooks/filter.ts';

/** A real `vitest run --reporter=verbose` log (Vitest 5.0.1, no TTY), its root path rewritten to /work/vt. */
const FIXTURE = readFileSync(new URL('../fixtures/vitest-verbose.log', import.meta.url), 'utf8');

const COUNT = new RegExp(`^${MARK.replace(/[[\]]/g, '\\$&')} the line above, (\\d+) times in a row$`);
/** Undoes the fold: each count line becomes that many copies of the line above it. */
const unfold = (text: string): string[] => {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = COUNT.exec(line);
    if (m) for (let k = 1; k < Number(m[1]); k++) out.push(out.at(-1)!);
    else out.push(line);
  }
  return out;
};
const linesOf = (log: string): string[] => log.replace(/\n+$/, '').split('\n');

const passing = (body: string[]): string =>
  ['', ' RUN  v5.0.1 /work/vt', '', ...body, '', ' Test Files  1 passed (1)', '      Tests  2 passed (2)', '   Start at  14:48:58', '   Duration  91ms (transform 49%, import 22%, worker 15%, tests 14%)', ''].join('\n');

describe('foldVitest', () => {
  it('on a real log folds the 300 identical lines to one with its count, and nothing else', () => {
    const f = foldVitest(FIXTURE);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.runs).toBe(1);
    const lines = f.text.split('\n');
    expect(lines.filter((l) => l === 'building index...')).toHaveLength(1);
    expect(lines).toContain(`${MARK} the line above, 300 times in a row`);
    expect(unfold(f.text)).toEqual(linesOf(FIXTURE));
  });

  it('keeps every unique test name and status, the warning, skipped and todo, and the totals', () => {
    const f = foldVitest(FIXTURE);
    if (!f.ok) throw new Error(f.reason);
    for (const kept of [
      ' ✓ tests/logs.test.ts > parser > logs a repeated progress line 2ms',
      ' ✓ tests/logs.test.ts > other > passes quietly 0ms',
      ' ↓ tests/logs.test.ts > parser > skipped one',
      ' □ tests/logs.test.ts > parser > todo one',
      'stderr | tests/logs.test.ts > parser > warns',
      'deprecated: use parseRow2',
      'row 0',
      ' Test Files  1 passed (1)',
      '      Tests  4 passed | 1 skipped | 1 todo (6)',
    ]) expect(f.text.split('\n')).toContain(kept);
  });

  it('never joins lines that are not consecutive, and counts each run exactly', () => {
    expect(foldVitest(passing(Array.from({ length: 40 }, (_, i) => (i % 2 ? 'tick' : 'tock'))))).toEqual({ ok: false, reason: 'nothing_folded' });
    const f = foldVitest(passing(['x', 'x', 'x', 'y', 'x', 'x', 'x', 'x', 'z', 'z']));
    if (!f.ok) throw new Error(f.reason);
    expect(f.runs).toBe(2);
    expect(f.text.split('\n').slice(3, 9)).toEqual(['x', `${MARK} the line above, 3 times in a row`, 'y', 'x', `${MARK} the line above, 4 times in a row`, 'z']);
    // A run of two, and blank lines, stay as they are.
    expect(f.text.split('\n').slice(9, 11)).toEqual(['z', '']);
    expect(foldVitest(passing(['', '', '', '', 'a', 'a']))).toEqual({ ok: false, reason: 'nothing_folded' });
  });

  it('leaves a failing, interrupted, coloured, or code/JSON/diff-mixed log alone', () => {
    const rep = Array.from({ length: 10 }, () => 'same');
    const bad = [
      FIXTURE.replace(' Test Files  1 passed (1)', ' Test Files  1 failed (1)'),
      FIXTURE.replace('      Tests  4 passed | 1 skipped | 1 todo (6)', '      Tests  1 failed | 3 passed | 1 skipped | 1 todo (6)'),
      FIXTURE.slice(0, FIXTURE.indexOf(' Test Files')),
      FIXTURE.replace(/^ RUN .*$/m, 'building index...'),
      passing([...rep, ' ❯ tests/a.test.ts (2 tests | 1 failed) 3ms']),
      passing([...rep, 'AssertionError: expected 1 to be 2']),
      passing([...rep, '⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯']),
      passing([...rep, '     20|   expect(r.status).toBe(0);']),
      passing([...rep, '\x1b[2K\x1b[1Arunning']),
      passing([...rep, 'progress 10%\rprogress 20%']),
      passing([...rep, '{"ok":true,"rows":3}']),
      passing([...rep, 'diff --git a/x b/x', '@@ -1 +1 @@']),
      passing([...rep, 'const x = parse(row);']),
      passing([...rep, `${MARK} the line above, 3 times in a row`]),
    ];
    for (const log of bad) expect(foldVitest(log)).toEqual({ ok: false, reason: 'format' });
  });
});

describe('isVitestCommand', () => {
  it('knows a direct `vitest run` with plain arguments, and nothing wrapped or compound', () => {
    for (const c of ['vitest run', 'npx vitest run --reporter=verbose', 'pnpm exec vitest run tests/a.test.ts', 'bunx vitest run --root /work/vt']) expect(isVitestCommand(c)).toBe(true);
    for (const c of ['vitest', 'npm test', 'npm run test', 'npx vitest run | tail -5', 'npx vitest run 2>&1', 'npx vitest run && echo ok', 'npx vitest run; ls', 'cat out.log', 'npx vitest run $(cat args)']) expect(isVitestCommand(c)).toBe(false);
  });
});

describe('withNote and utf8Bytes', () => {
  it('says only repeats were folded and where the original is', () => {
    const t = withNote('body', '/h/tool-results/b1.txt', 40129);
    expect(t.startsWith(`${MARK} Only runs of identical consecutive lines were folded`)).toBe(true);
    expect(t).toContain('The full original (40129 bytes) is at /h/tool-results/b1.txt\n');
    expect(t.endsWith('\n\nbody')).toBe(true);
  });
  it('counts UTF-8 bytes as Node does', () => {
    for (const s of [FIXTURE, 'ascii', '✓ ↓ □', 'emoji 🧪', 'lone \ud800 surrogate']) expect(utf8Bytes(s)).toBe(Buffer.byteLength(s, 'utf8'));
  });
});
