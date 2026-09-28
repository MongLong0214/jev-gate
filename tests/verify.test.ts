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
    const p = file('pairs.jsonl', [use('1', 'Bash', { command: 'npm test' }), result('1', true), use('2', 'Edit', { file_path: 'a' }), result('2', false), use('3', 'Bash', { command: 'npm test' }), result('3', false), 'not json']);
    expect(readWorkerObservation(p)).toEqual({
      runs: [
        { command: 'npm test', status: 'failed', at: 1 },
        { command: 'npm test', status: 'passed', at: 3 },
      ],
      lastWrite: 2,
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

  it('returns null for a transcript that is not there', () => {
    expect(readWorkerObservation(join(tmp, 'absent.jsonl'))).toBeNull();
  });
});

describe('runsCommand', () => {
  it.each([
    ['npm test', true],
    ['npm  test -- --run', true],
    ['cd pkg && npm test', true],
    ['CI=1 npm test 2>&1 | tail -20', true],
    ['echo npm test', false],
    ['npm testing', false],
    ['git commit -m "npm test"', false],
    // Whatever follows may not decide the exit status, and whatever precedes may not skip the check.
    ['npm test || true', false],
    ['npm test; echo done', false],
    ['npm test\necho done', false],
    ['npm test &', false],
    ['true || npm test', false],
    ['npm test && echo ok', true],
    ['npm run build; npm test', true],
  ])('%s runs npm test: %s', (run, expected) => {
    expect(runsCommand(run, 'npm test')).toBe(expected);
  });

  // A declared check may itself be a compound command; its exact run must be recognized, separators and all.
  it.each([
    ['npm run typecheck && npm test', 'npm run typecheck && npm test', true],
    ['cd pkg && npm run typecheck && npm test -- --run', 'npm run typecheck && npm test', true],
    ['npm run typecheck; npm test', 'npm run typecheck && npm test', false],
    ['npm run typecheck && echo npm test', 'npm run typecheck && npm test', false],
    ['npm run build || true', 'npm run build || true', true],
    ['npm run lint; npm test', 'npm run lint; npm test', true],
    ['npm run lint\nnpm test', 'npm run lint; npm test', true],
    ['npm test | tail -5', 'npm test | tail -5', true],
    ['npm run typecheck && npm test || true', 'npm run typecheck && npm test', false],
    ['npm run typecheck && npm test; true', 'npm run typecheck && npm test', false],
    // An assignment the check sets must be the one the run set; one it leaves open is ignored.
    ['NODE_ENV=production npm test', 'NODE_ENV=test npm test', false],
    ['NODE_ENV=test npm test', 'NODE_ENV=test npm test', true],
    ['NODE_ENV=production npm test', 'npm test', true],
  ])('%s runs %s: %s', (run, wanted, expected) => {
    expect(runsCommand(run, wanted)).toBe(expected);
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

  // The declared command reaches the matcher as written, so a newline in it still separates.
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
    expect(refusalReason({ transcript: 'read', contradicted: [], unobserved: [], stale: ['c2'] })).toBeNull();
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
});
