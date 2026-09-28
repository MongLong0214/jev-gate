import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { readWorkerObservation, subagentTranscriptPath, verifyChecks } from '../src/verify.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-verify-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const use = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, isError: boolean): string => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });
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
        { command: 'npm test', failed: true, at: 1 },
        { command: 'npm test', failed: false, at: 3 },
      ],
      lastWrite: 2,
      truncated: false,
    });
  });

  it('keeps the tail of an oversized transcript and drops the cut first line', () => {
    const lines = [use('1', 'Bash', { command: 'old' }), result('1', false), use('2', 'Bash', { command: 'npm test' }), result('2', true)];
    const p = file('tail.jsonl', lines);
    const tail = Buffer.byteLength(`${lines[2]}\n${lines[3]}\n`) + 5;
    const obs = readWorkerObservation(p, tail);
    expect(obs?.truncated).toBe(true);
    expect(obs?.runs).toEqual([{ command: 'npm test', failed: true, at: 1 }]);
  });

  it('returns null for a transcript that is not there', () => {
    expect(readWorkerObservation(join(tmp, 'absent.jsonl'))).toBeNull();
  });
});

describe('verifyChecks', () => {
  const obs = { runs: [{ command: 'npm test', failed: true, at: 1 }, { command: 'npm run  lint', failed: false, at: 2 }], lastWrite: 3, truncated: false };

  it('sorts each claim by what its last run shows', () => {
    expect(
      verifyChecks(obs, [
        { id: 'c1', command: 'npm test' },
        { id: 'c2', command: 'npm run lint' },
        { id: 'c3', command: 'npm run build' },
        { id: 'c4', command: null },
        { id: 'c5', command: 'ls' },
      ]),
    ).toEqual({ transcript: 'read', contradicted: ['c1'], unobserved: ['c3'], stale: ['c2'] });
  });

  it('judges nothing without a transcript', () => {
    expect(verifyChecks(null, [{ id: 'c1', command: 'npm test' }])).toEqual({ transcript: 'unavailable', contradicted: [], unobserved: [], stale: [] });
  });
});
