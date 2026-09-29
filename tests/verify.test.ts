import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { readWorkerObservation, refusalReason, runsCommand, subagentTranscriptPath, verifyChecks } from '../src/verify.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-verify-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const use = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, isError: boolean | undefined): string =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, ...(isError === undefined ? {} : { is_error: isError }), content: 'x' }] } });
const file = (name: string, lines: string[]): string => {
  const p = join(tmp, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
};

describe('subagentTranscriptPath', () => {
  it('follows the host layout and refuses ids that could leave it', () => {
    expect(subagentTranscriptPath('/p/proj/s1.jsonl', 's1', 'a0f3')).toBe('/p/proj/s1/subagents/agent-a0f3.jsonl');
    expect(subagentTranscriptPath('/p/proj/s1.jsonl', 's1', '../x')).toBeNull();
    expect(subagentTranscriptPath('/p/proj/s1.jsonl', '../s1', 'a0f3')).toBeNull();
  });
});

describe('readWorkerObservation', () => {
  it('pairs each Bash call with its result and marks the last write', () => {
    // A tool_result shares the same index as a tool_use, so the edit is dated when its result is seen.
    const p = file('pairs.jsonl', [use('1', 'Bash', { command: 'npm test' }), result('1', true), use('2', 'Edit', { file_path: 'a' }), result('2', false), use('3', 'Bash', { command: 'npm test' }), result('3', false), 'not json']);
    expect(readWorkerObservation(p)).toEqual({
      runs: [
        { command: 'npm test', status: 'failed', at: 1 },
        { command: 'npm test', status: 'passed', at: 5 },
      ],
      lastWrite: 4,
      truncated: false,
    });
  });

  it('orders runs by when they were called, and reads a result with no mark as unknown', () => {
    // Two parallel calls: the later call's result arrives first.
    const p = file('parallel.jsonl', [use('1', 'Bash', { command: 'npm test' }), use('2', 'Bash', { command: 'npm test' }), result('2', true), result('1', undefined)]);
    expect(readWorkerObservation(p)?.runs).toEqual([
      { command: 'npm test', status: 'unknown', at: 1 },
      { command: 'npm test', status: 'failed', at: 2 },
    ]);
  });

  it('keeps the tail of an oversized transcript and drops the cut first line', () => {
    const lines = [use('1', 'Bash', { command: 'old' }), result('1', false), use('2', 'Bash', { command: 'npm test' }), result('2', true)];
    const p = file('tail.jsonl', lines);
    const tail = Buffer.byteLength(`${lines[2]}\n${lines[3]}\n`) + 5;
    const obs = readWorkerObservation(p, tail);
    expect(obs?.truncated).toBe(true);
    expect(obs?.runs).toEqual([{ command: 'npm test', status: 'failed', at: 1 }]);
  });

  // Observed 2026-09-28 (2.1.283, worker-fast on haiku): the worker ran the planned grep with its file operand absolute.
  it('rewrites only a simple grep file operand under the run cwd', () => {
    const runs = [
      "! grep -q 'old' /w/repo/tests/a.ts && grep -q 'new' /w/repo/tests/a.ts",
      "cat /w/repo2/x x/w/repo/y --config=/w/repo/z && ! grep -q '/w/repo/src' /w/repo/f",
      'cd sub && node /w/repo/test.js',
      "eval 'cd sub' && node /w/repo/test.js",
      'git -C sub diff --quiet -- /w/repo/f',
      '/w/repo/npm test && ! /w/repo/bin/ok',
      'node /w/repo/run.js',
    ];
    const lines = runs.flatMap((command, i) => [JSON.stringify({ ...JSON.parse(use(`${i}`, 'Bash', { command })), cwd: '/w/repo/' }), result(`${i}`, false)]);
    const obs = readWorkerObservation(file('cwd.jsonl', lines))!;
    expect(obs.runs.map((r) => r.relative)).toEqual(["! grep -q 'old' tests/a.ts && grep -q 'new' tests/a.ts", "cat /w/repo2/x x/w/repo/y --config=/w/repo/z && ! grep -q '/w/repo/src' f", undefined, undefined, undefined, undefined, undefined]);
    const v = verifyChecks(obs, [
      { id: 'observed', command: "! grep -q 'old' tests/a.ts && grep -q 'new' tests/a.ts" },
      { id: 'quoted', command: "! grep -q 'src' f" },
      { id: 'cd', command: 'cd sub && node test.js' },
      { id: 'eval', command: "eval 'cd sub' && node test.js" },
      { id: 'option', command: 'git -C sub diff --quiet -- f' },
      { id: 'word', command: 'npm test' },
      { id: 'absolute', command: 'node /w/repo/run.js' },
    ]);
    expect(v.unobserved).toEqual(['quoted', 'cd', 'eval', 'option', 'word']);
    expect(v.contradicted).toEqual([]);
    expect(refusalReason(v)).toContain('shows no passing run');
    expect(refusalReason(v)).not.toContain('/w/repo');
    expect(readWorkerObservation(file('nocwd.jsonl', [use('1', 'Bash', { command: runs[0] }), result('1', false)]))!.runs[0]!.relative).toBeUndefined();
  });

  it('returns null for a transcript that is not there', () => {
    expect(readWorkerObservation(join(tmp, 'absent.jsonl'))).toBeNull();
  });
});

describe('runsCommand', () => {
  it.each([
    ['npm test', true],
    ['npm  test', true],
    ['npm\ttest', true],
    ['npm  test -- --run', false],
    ['npm test -- --listTests', false],
    ['cd pkg && npm test', false],
    ['CI=1 npm test 2>&1 | tail -20', false],
    ['echo npm test', false],
    ['npm testing', false],
    ['/usr/bin/npm test', false],
    ['git commit -m "npm test"', false],
    // `||`, `;`, and `&` are not the check. A later `&&` segment can be, because overall success requires it.
    ['npm test || true', false],
    ['npm test; echo done', false],
    ['npm test\necho done', false],
    ['npm test &', false],
    ['true || npm test', false],
    ['npm test && echo ok', true],
    ['npm run build; npm test', false],
  ])('%s runs npm test: %s', (run, expected) => {
    expect(runsCommand(run, 'npm test')).toBe(expected);
  });

  // A declared check may itself be a compound command; its exact run must be recognized, separators and all.
  it.each([
    ['npm run typecheck && npm test', 'npm run typecheck && npm test', true],
    ['npm  run typecheck  &&  npm test', 'npm run typecheck && npm test', true],
    ['cd pkg && npm run typecheck && npm test -- --run', 'npm run typecheck && npm test', false],
    ['npm run typecheck; npm test', 'npm run typecheck && npm test', false],
    ['npm run typecheck && echo npm test', 'npm run typecheck && npm test', false],
    ['npm run build || true', 'npm run build || true', true],
    ['npm run lint; npm test', 'npm run lint; npm test', true],
    ['npm run lint\nnpm test', 'npm run lint; npm test', false],
    ['npm test | tail -5', 'npm test | tail -5', true],
    ['false | cat', 'false | cat', true],
    ['false  | cat', 'false | cat', false],
    ['npm run typecheck && npm test || true', 'npm run typecheck && npm test', false],
    ['npm run typecheck && npm test; true', 'npm run typecheck && npm test', false],
    // An assignment is part of the command. Dropping it, or setting a different value, is a different run.
    ['NODE_ENV=production npm test', 'NODE_ENV=test npm test', false],
    ['NODE_ENV=test npm test', 'NODE_ENV=test npm test', true],
    ['NODE_ENV=production npm test', 'npm test', false],
    ['npm test --prefix pkg', 'npm test', false],
    ['npm --cwd pkg test', 'npm test', false],
  ])('%s runs %s: %s', (run, wanted, expected) => {
    expect(runsCommand(run, wanted)).toBe(expected);
  });

  it('keeps quoted and escaped text as written', () => {
    expect(runsCommand("! grep -Fq 'a b' double.txt", "! grep -Fq 'a  b' double.txt")).toBe(false);
    expect(runsCommand('false | cat', 'false')).toBe(false);
    expect(runsCommand("echo 'a b'", 'echo "a b"')).toBe(false);
    expect(runsCommand("echo 'a b'", "echo 'a  b'")).toBe(false);
    expect(runsCommand("echo 'a && b'", 'echo a')).toBe(false);
    expect(runsCommand("echo 'a && b'", "echo 'a && b'")).toBe(true);
    expect(runsCommand('npm test\\&\\& echo ok', 'npm test && echo ok')).toBe(false);
    expect(runsCommand('npm test &&\nnpm run lint', 'npm test && npm run lint')).toBe(true);
    expect(runsCommand('! npm test', 'npm test')).toBe(false);
    // `&&` and `||` share precedence, so this line is not evidence that `npm test` was skipped. It is not a pass either.
    expect(runsCommand('true || echo skipped && npm test', 'npm test')).toBe(false);
    expect(runsCommand('npm test $(date)', 'npm test')).toBe(false);
  });
});

describe('verifyChecks', () => {
  const obs = {
    runs: [
      { command: 'npm test', status: 'failed' as const, at: 1 },
      { command: 'npm run  lint', status: 'passed' as const, at: 2 },
      { command: 'npm run typecheck', status: 'unknown' as const, at: 4 },
    ],
    lastWrite: 3,
    truncated: false,
  };

  it('sorts each claim by what its last run shows', () => {
    expect(
      verifyChecks(obs, [
        { id: 'c1', command: 'npm test' },
        { id: 'c2', command: 'npm run lint' },
        { id: 'c3', command: 'npm run build' },
        { id: 'c4', command: null },
        { id: 'c5', command: 'ls' },
        { id: 'c6', command: 'npm run typecheck' },
      ]),
    ).toEqual({ transcript: 'read', contradicted: ['c1'], unobserved: ['c3', 'c4', 'c5', 'c6'], stale: ['c2'] });
  });

  // The same command bytes match, including a newline. A run the comparison cannot read as that command does not.
  it.each([
    ['npm run lint\nnpm test', 'passed', [], []],
    ['npm run typecheck && npm test', 'passed', [], []],
    ['npm run typecheck && npm test || true', 'passed', ['c1'], []],
    ['npm run typecheck && npm test', 'failed', [], ['c1']],
  ] as const)('judges a run of %j that %s', (command, status, unobserved, contradicted) => {
    const declared = command.includes('\n') ? 'npm run lint\nnpm test' : 'npm run typecheck && npm test';
    const v = verifyChecks({ runs: [{ command, status, at: 1 }], lastWrite: null, truncated: false }, [{ id: 'c1', command: declared }]);
    expect(v).toEqual({ transcript: 'read', contradicted, unobserved, stale: [] });
    expect(refusalReason(v) === null).toBe(unobserved.length === 0 && contradicted.length === 0);
  });

  it('refuses a failed last run and a pass it cannot see, however much of the transcript it read', () => {
    expect(refusalReason({ transcript: 'truncated', contradicted: ['c1'], unobserved: [], stale: [] })).toContain('last run in the worker');
    expect(refusalReason({ transcript: 'read', contradicted: [], unobserved: ['c3'], stale: [] })).toContain('shows no passing run');
    expect(refusalReason({ transcript: 'truncated', contradicted: [], unobserved: ['c3'], stale: [] })).toContain('last 8 MiB');
    expect(refusalReason({ transcript: 'unavailable', contradicted: [], unobserved: ['c3'], stale: [] })).toContain('could not be read');
    expect(refusalReason({ transcript: 'unavailable', contradicted: [], unobserved: [], stale: [] })).toBeNull();
    expect(refusalReason({ transcript: 'read', contradicted: [], unobserved: [], stale: ['c2'] })).toBe('check c2: 마지막 관측 변경 이후의 검사 결과 필요');
    expect(refusalReason({ transcript: 'read', contradicted: [], unobserved: [], stale: ['c2', 'c9'] })).toBe('check c2, c9: 마지막 관측 변경 이후의 검사 결과 필요');
    // A seen failure is explained before a missing run, and a missing run before an aged pass.
    expect(refusalReason({ transcript: 'read', contradicted: ['c1'], unobserved: ['c3'], stale: ['c2'] })).toContain('last run');
    expect(refusalReason({ transcript: 'read', contradicted: [], unobserved: ['c3'], stale: ['c2'] })).toContain('shows no passing run');
    expect(refusalReason({ transcript: 'read', contradicted: [], unobserved: ['c3'], stale: ['c2'] })).not.toContain('마지막');
  });

  it('sees no passing run of any claim without a transcript', () => {
    expect(
      verifyChecks(null, [
        { id: 'c1', command: 'npm test' },
        { id: 'c2', command: null },
        { id: 'c3', command: 'ls' },
      ]),
    ).toEqual({ transcript: 'unavailable', contradicted: [], unobserved: ['c1', 'c2', 'c3'], stale: [] });
    expect(verifyChecks(null, [])).toEqual({ transcript: 'unavailable', contradicted: [], unobserved: [], stale: [] });
  });

  it('refuses a claim a cut transcript shows no run of, and judges one it does show', () => {
    const cut = { ...obs, truncated: true };
    const v = verifyChecks(cut, [
      { id: 'c1', command: 'npm test' },
      { id: 'c3', command: 'npm run build' },
    ]);
    expect(v).toEqual({ transcript: 'truncated', contradicted: ['c1'], unobserved: ['c3'], stale: [] });
  });

  const claim = (command: string, runs: Array<{ command: string; status: 'passed' | 'failed' | 'unknown'; at: number }>, lastWrite: number | null = null, openWrite?: true) =>
    verifyChecks({ runs, lastWrite, truncated: false, ...(openWrite ? { openWrite } : {}) }, [{ id: 'c1', command }]);

  it('separates an exact failure from an && list that merely contains the check', () => {
    expect(claim('npm test', [{ command: 'npm test && echo ok', status: 'passed', at: 1 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
    expect(claim('npm test', [{ command: 'npm test && echo ok', status: 'failed', at: 1 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: ['c1'], stale: [] });
    expect(claim('npm test', [{ command: 'false && npm test', status: 'failed', at: 1 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: ['c1'], stale: [] });
    expect(claim('npm test', [{ command: 'npm test && echo ok', status: 'unknown', at: 1 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: ['c1'], stale: [] });
    expect(claim('false | cat', [{ command: 'false | cat', status: 'passed', at: 1 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
    expect(claim('false', [{ command: 'false | cat', status: 'passed', at: 1 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: ['c1'], stale: [] });
    expect(claim('npm test', [{ command: 'cd pkg && npm test', status: 'passed', at: 1 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: ['c1'], stale: [] });
    expect(claim('npm test', [{ command: 'npm test -- --listTests', status: 'passed', at: 1 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: ['c1'], stale: [] });
  });

  it('does not revive an older pass after a newer unknown or an inconclusive && list', () => {
    const passed = { command: 'npm test', status: 'passed' as const, at: 1 };
    expect(claim('npm test', [passed, { command: 'npm test', status: 'unknown', at: 2 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: ['c1'], stale: [] });
    expect(claim('npm test', [passed, { command: 'npm test && echo ok', status: 'failed', at: 2 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: ['c1'], stale: [] });
    expect(claim('npm test', [passed, { command: 'npm run lint', status: 'failed', at: 2 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
    expect(claim('npm test', [{ command: 'npm test', status: 'failed', at: 1 }, { command: 'npm test && echo ok', status: 'passed', at: 2 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
    // Call index, not the order the rows were written in.
    expect(claim('npm test', [{ command: 'npm test', status: 'passed', at: 4 }, { command: 'npm test', status: 'failed', at: 2 }])).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
    expect(claim('npm test', [{ command: 'npm test', status: 'failed', at: 4 }, { command: 'npm test', status: 'passed', at: 2 }])).toEqual({ transcript: 'read', contradicted: ['c1'], unobserved: [], stale: [] });
  });

  it('treats a pass that starts before the last observed edit as stale, not failed', () => {
    const result = verifyChecks({
      runs: [{ command: 'node check.cjs', status: 'passed', at: 1 }],
      lastWrite: 2,
      truncated: false,
    }, [{ id: 'suite', command: 'node check.cjs' }]);
    expect(result.stale).toEqual(['suite']);
    expect(result.contradicted).toEqual([]);
    expect(refusalReason(result)).not.toBeNull();
    expect(refusalReason(result)).toBe('check suite: 마지막 관측 변경 이후의 검사 결과 필요');
    expect(refusalReason(result)).not.toContain('node');
    expect(claim('npm test', [{ command: 'npm test', status: 'passed', at: 3 }], 2)).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
    expect(claim('npm test', [{ command: 'npm test', status: 'passed', at: 1 }, { command: 'npm test', status: 'passed', at: 4 }], 3)).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
    expect(claim('npm test', [{ command: 'npm test', status: 'passed', at: 1 }, { command: 'npm test', status: 'failed', at: 4 }], 3)).toEqual({ transcript: 'read', contradicted: ['c1'], unobserved: [], stale: [] });
    expect(claim('npm test', [{ command: 'npm test', status: 'passed', at: 3 }], 1, true)).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: ['c1'] });
    expect(refusalReason(verifyChecks({ runs: [], lastWrite: 1, truncated: false }, []))).toBeNull();
  });
});

describe('check order in a transcript', () => {
  const bash = (id: string, command: string, mark: 'pass' | 'fail' | 'unknown' | 'pending'): string[] => {
    const started = use(id, 'Bash', { command });
    if (mark === 'pending') return [started];
    if (mark === 'unknown') return [started, result(id, undefined)];
    return [started, result(id, mark === 'fail')];
  };
  const edit = (id: string, name: string, mark: 'done' | 'fail' | 'pending'): string[] => {
    const started = use(id, name, { file_path: 'a.ts' });
    if (mark === 'pending') return [started];
    return [started, result(id, mark === 'fail')];
  };
  const judge = (name: string, lines: string[], command = 'npm test') => {
    const obs = readWorkerObservation(file(name, lines))!;
    const v = verifyChecks(obs, [{ id: 'c1', command }]);
    return { obs, v, reason: refusalReason(v) };
  };

  it('keeps a pending call and follows the call index when results arrive out of order', () => {
    const pending = judge('pending.jsonl', [...bash('1', 'npm test', 'pass'), ...bash('2', 'npm test', 'pending')]);
    expect(pending.obs.runs).toEqual([
      { command: 'npm test', status: 'passed', at: 1 },
      { command: 'npm test', status: 'unknown', at: 3 },
    ]);
    expect(pending.v).toEqual({ transcript: 'read', contradicted: [], unobserved: ['c1'], stale: [] });
    expect(pending.reason).toContain('shows no passing run');

    const swapped = judge('swapped.jsonl', [use('1', 'Bash', { command: 'npm test' }), use('2', 'Bash', { command: 'npm test' }), result('2', true), result('1', false)]);
    expect(swapped.obs.runs.map((r) => [r.at, r.status])).toEqual([[1, 'passed'], [2, 'failed']]);
    expect(swapped.v.contradicted).toEqual(['c1']);
  });

  it('dates a check at its start and a write at its result, on one index', () => {
    const wroteThen = judge('wrote-then.jsonl', [...edit('w', 'Write', 'done'), ...bash('b', 'npm test', 'pass')]);
    expect(wroteThen.v).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
    expect(wroteThen.reason).toBeNull();

    const passThen = judge('pass-then.jsonl', [...bash('b', 'npm test', 'pass'), ...edit('w', 'MultiEdit', 'done')]);
    expect(passThen.v.stale).toEqual(['c1']);
    expect(passThen.v.contradicted).toEqual([]);
    expect(passThen.reason).toBe('check c1: 마지막 관측 변경 이후의 검사 결과 필요');

    const cleared = judge('cleared.jsonl', [...bash('b1', 'npm test', 'pass'), ...edit('w', 'Edit', 'done'), ...bash('b2', 'npm test', 'pass')]);
    expect(cleared.v).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });

    const failedAfter = judge('failed-after.jsonl', [...bash('b1', 'npm test', 'pass'), ...edit('w', 'Write', 'done'), ...bash('b2', 'npm test', 'fail')]);
    expect(failedAfter.v).toEqual({ transcript: 'read', contradicted: ['c1'], unobserved: [], stale: [] });

    const during = judge('during.jsonl', [use('b', 'Bash', { command: 'npm test' }), ...edit('w', 'Write', 'done'), result('b', false)]);
    expect(during.obs.runs[0]?.at).toBe(1);
    expect(during.obs.lastWrite).toBeGreaterThan(during.obs.runs[0]!.at);
    expect(during.v.stale).toEqual(['c1']);
    expect(during.reason).not.toBeNull();

    const overlap = judge('overlap.jsonl', [use('w', 'Write', { file_path: 'a.ts' }), use('b', 'Bash', { command: 'npm test' }), result('w', false), result('b', false)]);
    expect(overlap.obs.openWrite).toBeUndefined();
    expect(overlap.obs.lastWrite).toBeGreaterThan(overlap.obs.runs[0]!.at);
    expect(overlap.v.stale).toEqual(['c1']);

    const open = judge('open.jsonl', [...edit('w', 'NotebookEdit', 'pending'), ...bash('b', 'npm test', 'pass')]);
    expect(open.obs.openWrite).toBe(true);
    expect(open.obs.lastWrite).toBeLessThan(open.obs.runs[0]!.at);
    expect(open.v.stale).toEqual(['c1']);
    expect(open.reason).toBe('check c1: 마지막 관측 변경 이후의 검사 결과 필요');

    const failedWrite = judge('failed-write.jsonl', [...edit('w', 'Edit', 'fail'), ...bash('b', 'npm test', 'pass')]);
    expect(failedWrite.v.stale).toEqual([]);
    expect(failedWrite.reason).toBeNull();
  });

  it('does not treat a redirect inside Bash as an observed edit', () => {
    const seen = judge('bash-edit.jsonl', [...bash('1', 'npm test', 'pass'), ...bash('2', 'printf x > src/t.ts', 'pass')]);
    expect(seen.obs.lastWrite).toBeNull();
    expect(seen.v).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
  });

  it('leaves an ambiguous grep and a sibling path unrewritten', () => {
    const cwdOf = (name: string, command: string): ReturnType<typeof readWorkerObservation> =>
      readWorkerObservation(file(name, [JSON.stringify({ ...JSON.parse(use('1', 'Bash', { command })), cwd: '/w/repo' }), result('1', false)]));
    expect(cwdOf('grep-e.jsonl', "grep -e old /w/repo/a.ts")!.runs[0]!.relative).toBeUndefined();
    expect(cwdOf('grep-sib.jsonl', 'grep -q old /w/repo2/a.ts')!.runs[0]!.relative).toBeUndefined();
    expect(cwdOf('grep-quoted.jsonl', "grep -q old '/w/repo/a.ts'")!.runs[0]!.relative).toBeUndefined();
    const simple = cwdOf('grep-ok.jsonl', "grep -q 'old' /w/repo/tests/a.ts")!;
    expect(simple.runs[0]!.relative).toBe("grep -q 'old' tests/a.ts");
    const v = verifyChecks(simple, [{ id: 'g', command: "grep -q 'old' tests/a.ts" }]);
    expect(v).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
    expect(refusalReason(v)).toBeNull();
  });
});

describe('reproduced command confusions', () => {
  it('does not accept a different quoted pattern, a cwd string inside quotes, or a pipe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-verify-bash-'));
    try {
      writeFileSync(join(dir, 'double.txt'), 'a  b\n');
      writeFileSync(join(dir, 'prefix.txt'), 'prefix a\n');
      const statusOf = (script: string): number | null => spawnSync('bash', ['-c', script], { cwd: dir, timeout: 5000 }).status;
      const plannedSpaces = "! grep -Fq 'a  b' double.txt";
      const actualSpaces = "! grep -Fq 'a b' double.txt";
      expect(statusOf(plannedSpaces)).toBe(1);
      expect(statusOf(actualSpaces)).toBe(0);
      expect(runsCommand(actualSpaces, plannedSpaces)).toBe(false);

      const plannedPrefix = "! grep -Fq 'prefix a' prefix.txt";
      const actualPrefix = `! grep -Fq 'prefix ${dir}/a' prefix.txt`;
      expect(statusOf(plannedPrefix)).toBe(1);
      expect(statusOf(actualPrefix)).toBe(0);
      expect(runsCommand(actualPrefix, plannedPrefix)).toBe(false);

      expect(statusOf('false')).toBe(1);
      expect(statusOf('set +o pipefail; false | cat')).toBe(0);
      expect(runsCommand('false | cat', 'false')).toBe(false);

      const quoted = verifyChecks(readWorkerObservation(file('prefix-run.jsonl', [JSON.stringify({ ...JSON.parse(use('1', 'Bash', { command: actualPrefix })), cwd: dir }), result('1', false)]))!, [{ id: 'c1', command: plannedPrefix }]);
      expect(quoted).toEqual({ transcript: 'read', contradicted: [], unobserved: ['c1'], stale: [] });
      expect(refusalReason(quoted)).not.toBeNull();
      expect(refusalReason(quoted)).not.toContain('prefix');
      expect(refusalReason(quoted)).not.toContain(dir);

      const spaces = verifyChecks(readWorkerObservation(file('spaces-run.jsonl', [use('1', 'Bash', { command: actualSpaces }), result('1', false)]))!, [{ id: 'c1', command: plannedSpaces }]);
      expect(spaces.unobserved).toEqual(['c1']);
      expect(refusalReason(spaces)).not.toBeNull();
      expect(refusalReason(spaces)).not.toContain('double');

      const piped = verifyChecks(readWorkerObservation(file('pipe-run.jsonl', [use('1', 'Bash', { command: 'false | cat' }), result('1', false)]))!, [{ id: 'c1', command: 'false' }]);
      expect(piped.unobserved).toEqual(['c1']);
      expect(refusalReason(piped)).not.toContain('|');

      const samePass = verifyChecks(readWorkerObservation(file('false-pass.jsonl', [use('1', 'Bash', { command: 'false' }), result('1', false)]))!, [{ id: 'c1', command: 'false' }]);
      expect(samePass).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
      expect(refusalReason(samePass)).toBeNull();
      const sameFail = verifyChecks(readWorkerObservation(file('false-fail.jsonl', [use('1', 'Bash', { command: 'false' }), result('1', true)]))!, [{ id: 'c1', command: 'false' }]);
      expect(sameFail.contradicted).toEqual(['c1']);
      const sameUnknown = verifyChecks(readWorkerObservation(file('false-unknown.jsonl', [use('1', 'Bash', { command: 'false' }), result('1', undefined)]))!, [{ id: 'c1', command: 'false' }]);
      expect(sameUnknown.unobserved).toEqual(['c1']);
      expect(sameUnknown.contradicted).toEqual([]);
      const wholePipe = verifyChecks(readWorkerObservation(file('whole-pipe.jsonl', [use('1', 'Bash', { command: 'false | cat' }), result('1', false)]))!, [{ id: 'c1', command: 'false | cat' }]);
      expect(wholePipe).toEqual({ transcript: 'read', contradicted: [], unobserved: [], stale: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('records only the pass from before a real edit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-verify-subject-'));
    try {
      const subject = join(dir, 'subject.cjs');
      const check = join(dir, 'check.cjs');
      writeFileSync(subject, 'module.exports=1\n');
      writeFileSync(check, `const assert = require('node:assert');\nassert.equal(require(${JSON.stringify(subject)}), 1);\n`);
      const ok = spawnSync(process.execPath, [check], { timeout: 5000 });
      expect(ok.status).toBe(0);
      writeFileSync(subject, 'module.exports=2\n');
      const bad = spawnSync(process.execPath, [check], { timeout: 5000 });
      expect(bad.status).toBe(1);
      const result = verifyChecks({
        runs: [{ command: 'node check.cjs', status: 'passed', at: 1 }],
        lastWrite: 2,
        truncated: false,
      }, [{ id: 'suite', command: 'node check.cjs' }]);
      expect(result.stale).toEqual(['suite']);
      expect(result.contradicted).toEqual([]);
      const reason = refusalReason(result);
      expect(reason).not.toBeNull();
      expect(reason).toBe('check suite: 마지막 관측 변경 이후의 검사 결과 필요');
      expect(reason).not.toContain('node');
      expect(reason).not.toContain('check.cjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
