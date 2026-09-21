import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { looksSecret, MAX_OPTIONAL_GROUPS, mandatoryGroups, optionalGroups, readLeanSource, type LeanSource } from '../src/lean-source.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-lean-src-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const transcript = (entries: unknown[]): string => {
  const p = join(tmp, `t-${(seq += 1)}.jsonl`);
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
};

const human = (uuid: string, content: string): unknown => ({ type: 'user', uuid, message: { role: 'user', content } });
const assistant = (uuid: string, text: string, tool?: { id: string; name: string; input: unknown }): unknown => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'text', text }, ...(tool ? [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }] : [])] },
});
const toolResult = (uuid: string, id: string, content: string, isError = false): unknown => ({
  type: 'user',
  uuid,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});

const ok = (path: string, request: string): LeanSource => {
  const r = readLeanSource(path, request);
  if (!r.ok) throw new Error(`expected a source, got ${r.reason}`);
  return r.source;
};

describe('lean source — what counts as a human instruction', () => {
  it('reads a user-type event carrying a tool_result as an observation, never as human text', () => {
    const p = transcript([
      human('u1', '이 파일의 버그를 고쳐줘'),
      assistant('a1', 'checking', { id: 'tu1', name: 'Bash', input: { command: 'npm test' } }),
      toolResult('r1', 'tu1', '1 failing'),
      human('u2', 'now the second one'),
    ]);
    const s = ok(p, 'now the second one');
    const mandatory = mandatoryGroups(s);
    expect(mandatory.map((g) => g.text)).toEqual(['이 파일의 버그를 고쳐줘']);
    expect(mandatory.every((g) => g.origin === 'human')).toBe(true);
    // The tool call and its result are one optional group, not two, and not a human turn.
    expect(optionalGroups(s)).toHaveLength(1);
    expect(optionalGroups(s)[0]?.text).toContain('npm test');
    expect(optionalGroups(s)[0]?.text).toContain('1 failing');
  });

  it('keeps the exact Korean request, its negation and code anchors intact', () => {
    const request = 'sonner는 쓰지 말고 `handleMutateError`로 고쳐';
    const p = transcript([
      human('u1', '예외: `as any`는 절대 추가하지 마'),
      assistant('a1', 'editing', { id: 'tu1', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'toast.error(e)', new_string: 'handleMutateError(e)' } }),
      toolResult('r1', 'tu1', 'ok'),
      human('u2', request),
    ]);
    const s = ok(p, request);
    expect(mandatoryGroups(s)[0]?.text).toBe('예외: `as any`는 절대 추가하지 마');
    expect(optionalGroups(s)[0]?.text).toContain('toast.error(e)');
    expect(optionalGroups(s)[0]?.text).toContain('src/a.ts');
    // The current request is carried once, from the hook event, and not repeated as a group.
    expect(s.groups.filter((g) => g.text === request)).toHaveLength(0);
    expect(s.request).toBe(request);
  });

  it('keeps a failure qualifier in the same group as the action it qualifies', () => {
    const p = transcript([
      human('u1', 'run the build'),
      assistant('a1', 'building', { id: 'tu1', name: 'Bash', input: { command: 'npm run build' } }),
      toolResult('r1', 'tu1', 'TS2322: Type error in src/x.ts', true),
      human('u2', 'next'),
    ]);
    const group = optionalGroups(ok(p, 'next'))[0];
    expect(group?.text).toContain('npm run build');
    expect(group?.text).toContain('status=error');
    expect(group?.text).toContain('TS2322');
  });

  it('drops hidden reasoning and host bookkeeping records', () => {
    const p = transcript([
      { type: 'mode', mode: 'normal' },
      { type: 'attachment', uuid: 'x1', attachment: { type: 'hook_success', content: 'PONYTAIL MODE ACTIVE' } },
      human('u1', 'first'),
      assistant('a1', 'visible answer'),
      human('u2', 'second'),
    ]);
    const s = ok(p, 'second');
    expect(JSON.stringify(s.groups)).not.toContain('hidden reasoning');
    expect(JSON.stringify(s.groups)).not.toContain('PONYTAIL');
  });

  it('skips sidechain turns: a subagent context is not this conversation', () => {
    const p = transcript([
      human('u1', 'first'),
      { type: 'assistant', uuid: 'a0', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } },
      assistant('a1', 'root answer'),
      human('u2', 'second'),
    ]);
    expect(JSON.stringify(ok(p, 'second').groups)).not.toContain('subagent chatter');
  });
});

describe('lean source — compaction lineage', () => {
  const compacted = (summary: string, retained: unknown[], after: unknown[]): string =>
    transcript([
      human('old1', 'a turn that was dropped by the compaction'),
      assistant('olda', 'dropped too'),
      ...retained,
      { type: 'system', uuid: 'b1', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preservedSegment: { headUuid: 'h1', anchorUuid: 's1', tailUuid: 't1' } } },
      { type: 'user', uuid: 's1', isCompactSummary: true, message: { role: 'user', content: summary } },
      ...after,
    ]);

  it('takes the host preserved segment: the summary plus the retained pre-compact suffix', () => {
    const p = compacted('Summary: the user asked for X, then Y failed.', [assistant('h1', 'kept action', { id: 'tu1', name: 'Read', input: { file_path: 'src/keep.ts' } }), toolResult('t1', 'tu1', 'file body')], [human('u9', 'carry on')]);
    const s = ok(p, 'carry on');
    expect(s.epoch).toBe('1:s1');
    const mandatoryText = mandatoryGroups(s).map((g) => g.text);
    expect(mandatoryText).toContain('Summary: the user asked for X, then Y failed.');
    expect(mandatoryText.join('\n')).not.toContain('a turn that was dropped');
    expect(mandatoryGroups(s).find((g) => g.origin === 'compact_summary')).toBeDefined();
    // Partial compaction retained an earlier record; it is optional evidence, still in view.
    expect(optionalGroups(s).map((g) => g.text).join('\n')).toContain('src/keep.ts');
  });

  it('stays native when a boundary exists whose preserved segment cannot be resolved', () => {
    const p = transcript([
      human('u1', 'first'),
      { type: 'system', uuid: 'b1', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preservedSegment: { headUuid: 'missing', anchorUuid: 'also-missing' } } },
      human('u2', 'second'),
    ]);
    const r = readLeanSource(p, 'second');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('source_lineage_unknown');
  });

  it('a compaction after the packet was built changes the epoch', () => {
    const before = ok(transcript([human('u1', 'first'), assistant('a1', 'x'), human('u2', 'go')]), 'go');
    const after = ok(
      transcript([
        human('u1', 'first'),
        assistant('h1', 'x'),
        { type: 'system', uuid: 'b1', subtype: 'compact_boundary', compactMetadata: { preservedSegment: { headUuid: 'h1', anchorUuid: 's1', tailUuid: 'h1' } } },
        { type: 'user', uuid: 's1', isCompactSummary: true, message: { role: 'user', content: 'Summary: ...' } },
        human('u2', 'go'),
      ]),
      'go',
    );
    expect(after.epoch).not.toBe(before.epoch);
  });
});

describe('lean source — validity across this request’s own appends', () => {
  const base = [human('u1', 'earlier'), assistant('a1', 'did a thing', { id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } }), toolResult('r1', 'tu1', 'body')];

  it('an ordinary assistant/tool append for the same request does not move the prefix digest', () => {
    const request = 'implement the parser';
    const before = ok(transcript([...base]), request);
    const after = ok(
      transcript([
        ...base,
        human('u2', request),
        assistant('a2', 'working', { id: 'tu2', name: 'Bash', input: { command: 'ls' } }),
        toolResult('r2', 'tu2', 'files'),
      ]),
      request,
    );
    expect(after.prefixDigest).toBe(before.prefixDigest);
    expect(after.newerHumanText).toBe(false);
  });

  it('a new human instruction after the request invalidates it', () => {
    const request = 'implement the parser';
    const after = ok(transcript([...base, human('u2', request), assistant('a2', 'working'), human('u3', 'stop, do the other thing')]), request);
    expect(after.newerHumanText).toBe(true);
  });

  it('a destructive rewrite of an earlier record moves the digest', () => {
    const request = 'go';
    const before = ok(transcript([...base, human('u2', request)]), request);
    const rewritten = ok(transcript([human('u1', 'earlier, but edited'), base[1], base[2], human('u2', request)]), request);
    expect(rewritten.prefixDigest).not.toBe(before.prefixDigest);
  });
});

describe('lean source — bounds, safety and what "unknown" means', () => {
  it('an absent transcript is unavailable, never an empty new session', () => {
    const r = readLeanSource(join(tmp, 'does-not-exist.jsonl'), 'go');
    expect(r.ok === false && r.reason).toBe('source_unavailable');
    expect(readLeanSource(null, 'go').ok).toBe(false);
  });

  it('a real startup transcript with no prior turns yields zero optional groups, not a failure', () => {
    const p = transcript([{ type: 'mode', mode: 'normal' }, human('u1', 'first thing I have said')]);
    const s = ok(p, 'first thing I have said');
    expect(optionalGroups(s)).toHaveLength(0);
  });

  it('gives up rather than guessing when the read bound cuts an uncompacted history', () => {
    const r = readLeanSource(transcript([human('u1', 'first'), human('u2', 'go')]), 'go', { now: (() => { let n = 0; return () => (n += 1000); })() });
    expect(r.ok).toBe(false);
  });

  it('excludes a credential-bearing optional group whole and counts it unassessed', () => {
    const p = transcript([
      human('u1', 'earlier'),
      assistant('a1', 'exported the token', { id: 'tu1', name: 'Bash', input: { command: 'export TYPESAFE_API_KEY=sk-abcdefghijklmnopqrstuvwx' } }),
      toolResult('r1', 'tu1', 'ok'),
      assistant('a2', 'ordinary work', { id: 'tu2', name: 'Read', input: { file_path: 'a.ts' } }),
      toolResult('r2', 'tu2', 'body'),
      human('u2', 'go'),
    ]);
    const s = ok(p, 'go');
    expect(optionalGroups(s)).toHaveLength(1);
    expect(JSON.stringify(s.groups)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(s.unassessed).toBe(1);
    expect(s.coverage).toBe('partial');
  });

  it('screens the conventional credential shapes and leaves ordinary text alone', () => {
    expect(looksSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(looksSecret('ghp_012345678901234567890123456789')).toBe(true);
    expect(looksSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(looksSecret('password = "hunter2hunter2hunter2"')).toBe(true);
    expect(looksSecret('const password = readPassword();')).toBe(false);
    expect(looksSecret('the sk- prefix is how those keys start')).toBe(false);
  });

  it('enumerates the newest groups under the cap and counts the rest rather than calling them irrelevant', () => {
    const many: unknown[] = [human('u1', 'earlier')];
    for (let i = 0; i < MAX_OPTIONAL_GROUPS + 5; i++) {
      many.push(assistant(`a${i}`, `step ${i}`, { id: `tu${i}`, name: 'Read', input: { file_path: `f${i}.ts` } }), toolResult(`r${i}`, `tu${i}`, `body ${i}`));
    }
    many.push(human('u2', 'go'));
    const s = ok(transcript(many), 'go');
    expect(optionalGroups(s)).toHaveLength(MAX_OPTIONAL_GROUPS);
    expect(s.unassessed).toBe(5);
    expect(optionalGroups(s).at(-1)?.text).toContain(`step ${MAX_OPTIONAL_GROUPS + 4}`);
  });

  it('does not collapse identical text observed at two different records', () => {
    const p = transcript([
      human('u1', 'earlier'),
      assistant('a1', 'read', { id: 'tu1', name: 'Read', input: { file_path: 'src/a.ts' } }),
      toolResult('r1', 'tu1', 'export const x = 1;'),
      assistant('a2', 'read', { id: 'tu2', name: 'Read', input: { file_path: 'src/b.ts' } }),
      toolResult('r2', 'tu2', 'export const x = 1;'),
      human('u2', 'go'),
    ]);
    expect(optionalGroups(ok(p, 'go'))).toHaveLength(2);
  });
});
