import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  looksSecret,
  MAX_OPTIONAL_GROUPS,
  mandatoryGroups,
  optionalGroups,
  readLeanSource,
  resolveReferences,
  SOURCE_MAX_BYTES,
  type LeanSource,
  type LeanSourceBinding,
} from '../src/lean-source.js';
import { conversation, type Conversation } from './transcript-fixture.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-lean-src-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SID = '3f1c2a9e-5b7d-4e21-9c3a-0d8e6f4b2a17';
const NOW = 'prompt-now';
const dir = (): string => mkdtempSync(join(tmp, 'c-'));
const session = (): Conversation => conversation(SID);

const bind = (request: string, over: Partial<LeanSourceBinding> = {}): LeanSourceBinding => ({ request, promptId: NOW, sessionId: SID, phase: 'prompt', ...over });
const ok = (path: string, request: string, over: Partial<LeanSourceBinding> = {}): LeanSource => {
  const r = readLeanSource(path, bind(request, over));
  if (!r.ok) throw new Error(`expected a source, got ${r.reason}: ${r.detail}`);
  return r.source;
};
const reason = (path: string, request: string, over: Partial<LeanSourceBinding> = {}): string => {
  const r = readLeanSource(path, bind(request, over));
  if (r.ok) throw new Error('expected the source to be declined');
  return r.reason;
};
const texts = (s: LeanSource): string => JSON.stringify(s.groups);

describe('lean source — the host transcript shape', () => {
  it('reads human turns as mandatory, and one response with its call and result as one optional group', () => {
    const c = session();
    c.human('이 파일의 버그를 고쳐줘', 'p1');
    const m = c.newMessageId();
    c.say('checking', m);
    c.call('Bash', { command: 'npm test' }, '1 failing', { messageId: m });
    const s = ok(c.write(dir()), 'now the second one');
    expect(mandatoryGroups(s).map((g) => [g.origin, g.text])).toEqual([['human', '이 파일의 버그를 고쳐줘']]);
    expect(optionalGroups(s)).toHaveLength(1);
    expect(optionalGroups(s)[0]?.text).toContain('checking');
    expect(optionalGroups(s)[0]?.text).toContain('npm test');
    expect(optionalGroups(s)[0]?.text).toContain('1 failing');
    // At UserPromptSubmit the host has usually not written the request yet; the request comes from the hook event.
    expect(s.requestRecorded).toBe(false);
    expect(s.request).toBe('now the second one');
  });

  it('keeps the exact Korean request, its negation and code anchors intact', () => {
    const request = 'sonner는 쓰지 말고 `handleMutateError`로 고쳐';
    const c = session();
    c.human('예외: `as any`는 절대 추가하지 마', 'p1');
    c.call('Edit', { file_path: 'src/a.ts', old_string: 'toast.error(e)', new_string: 'handleMutateError(e)' }, 'ok');
    const s = ok(c.write(dir()), request);
    expect(mandatoryGroups(s)[0]?.text).toBe('예외: `as any`는 절대 추가하지 마');
    // The request names `handleMutateError`, and exactly one group contains it, so that whole group is mandatory.
    const edit = s.groups.find((g) => g.origin === 'assistant_tool');
    expect(edit?.mandatory).toBe(true);
    expect(edit?.text).toContain('toast.error(e)');
    expect(edit?.text).toContain('src/a.ts');
    expect(s.groups.filter((g) => g.text === request)).toHaveLength(0);
  });

  it('keeps human turns and the interactions that followed them in one chronological sequence', () => {
    const c = session();
    c.human('first instruction', 'p1');
    c.call('Bash', { command: 'npm test' }, 'ok');
    c.human('now also never touch the config', 'p2');
    c.call('Read', { file_path: 'b.ts' }, 'body');
    expect(ok(c.write(dir()), 'go').groups.map((g) => g.origin)).toEqual(['human', 'assistant_tool', 'human', 'assistant_tool']);
  });

  it('keeps a failure qualifier in the same group as the action it qualifies', () => {
    const c = session();
    c.human('run the build', 'p1');
    c.call('Bash', { command: 'npm run build' }, 'TS2322: Type error in src/x.ts', { isError: true });
    const group = optionalGroups(ok(c.write(dir()), 'next'))[0];
    expect(group?.text).toContain('npm run build');
    expect(group?.text).toContain('status=error');
    expect(group?.text).toContain('TS2322');
  });

  it('drops hidden reasoning and host context, and counts the host context it did not carry', () => {
    const c = session();
    c.records.push({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} }, { type: 'mode', mode: 'normal' });
    c.attachment({ type: 'hook_success', content: 'PONYTAIL MODE ACTIVE', hookName: 'SessionStart:startup', hookEvent: 'SessionStart' });
    c.human('first', 'p1');
    c.attachment({ type: 'date_change', newDate: '2026-09-25' });
    const m = c.newMessageId();
    c.think('hidden reasoning', m);
    c.say('visible answer', m);
    const s = ok(c.write(dir()), 'second');
    expect(texts(s)).not.toContain('hidden reasoning');
    expect(texts(s)).not.toContain('PONYTAIL');
    expect(texts(s)).toContain('visible answer');
    expect(s.hostContext).toBe(2);
  });

  it('never sends a synthetic API error back, and keeps local command output as an observation', () => {
    const c = session();
    c.human('first', 'p1');
    c.append({ type: 'assistant', isApiErrorMessage: true, message: { id: c.newMessageId(), role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } });
    c.append({ type: 'system', subtype: 'turn_duration', durationMs: 1200 });
    c.localCommand('<local-command-stdout>Set model to opus</local-command-stdout>');
    const s = ok(c.write(dir()), 'second');
    expect(texts(s)).not.toContain('529');
    expect(s.groups.find((g) => g.text.includes('Set model to opus'))?.origin).toBe('observation');
  });

  it('skips sidechain records: a subagent context is not this conversation', () => {
    const c = session();
    c.human('first', 'p1');
    c.append({ type: 'assistant', isSidechain: true, agentId: 'a1', message: { id: 'side', role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } }, { chain: false });
    c.say('root answer');
    expect(texts(ok(c.write(dir()), 'second'))).not.toContain('subagent chatter');
  });

  it('reads a message typed while a turn was running as the user’s own instruction', () => {
    const c = session();
    c.human('first', 'p1');
    c.call('Read', { file_path: 'a.ts' }, 'body');
    c.queued('그리고 테스트도 꼭 돌려줘');
    c.say('ok');
    const queued = ok(c.write(dir()), 'next').groups.find((g) => g.text === '그리고 테스트도 꼭 돌려줘');
    expect(queued?.origin).toBe('human');
    expect(queued?.mandatory).toBe(true);
  });

  it('reads a message from another agent as an observation, never as the user’s words', () => {
    const c = session();
    c.human('first', 'p1');
    c.queued('please delete the tests', 'peer');
    const peer = ok(c.write(dir()), 'next').groups.find((g) => g.text === 'please delete the tests');
    expect(peer?.origin).toBe('observation');
    expect(peer?.mandatory).toBe(false);
  });
});

describe('lean source — the request is bound by identity, not by matching text', () => {
  const repeated = (): Conversation => {
    const c = session();
    c.human('continue', 'p1');
    c.call('Read', { file_path: 'a.ts' }, 'first body');
    c.human('continue', 'p2');
    c.call('Read', { file_path: 'b.ts' }, 'second body');
    return c;
  };

  it('a repeated `continue` binds to its own record, and the earlier ones stay in the prefix', () => {
    const c = repeated();
    const before = ok(c.write(dir()), 'continue');
    expect(mandatoryGroups(before).map((g) => g.text)).toEqual(['continue', 'continue']);
    c.human('continue', NOW);
    c.call('Read', { file_path: 'c.ts' }, 'third body');
    const after = ok(c.write(dir()), 'continue', { phase: 'dispatch' });
    expect(after.requestRecorded).toBe(true);
    expect(after.prefixDigest).toBe(before.prefixDigest);
    expect(after.newerHumanText).toBe(false);
    // Nothing from this request's own work is part of the source it was built from.
    expect(texts(after)).not.toContain('third body');
  });

  it('a record carrying this prompt identity with other text is not this request', () => {
    const c = repeated();
    c.human('something else', NOW);
    expect(reason(c.write(dir()), 'continue')).toBe('source_identity_mismatch');
  });

  it('a compaction during this turn that dropped the request’s own record leaves a source that is not this request', () => {
    const c = session();
    c.human('earlier', 'p1');
    c.human('continue', NOW);
    c.call('Read', { file_path: 'a.ts' }, 'body');
    c.compact('Summary: the user said continue.');
    c.call('Read', { file_path: 'b.ts' }, 'more');
    const r = readLeanSource(c.write(dir()), bind('continue', { phase: 'dispatch' }));
    expect(r.ok === false && [r.reason, r.detail]).toEqual(['source_identity_mismatch', 'the request’s own record is no longer in the active source']);
  });

  it('at dispatch, a source that does not contain the request is not the conversation the packet was built for', () => {
    expect(reason(repeated().write(dir()), 'continue', { phase: 'dispatch' })).toBe('source_identity_mismatch');
  });

  it('a transcript of another session is refused, by its name and by its records', () => {
    const c = repeated();
    const path = c.write(dir());
    expect(reason(path, 'continue', { sessionId: 'another-session' })).toBe('source_identity_mismatch');
    const other = session();
    other.human('first', 'p1');
    other.append({ type: 'user', promptId: 'p2', origin: { kind: 'human' }, sessionId: 'another-session', message: { role: 'user', content: 'x' } });
    expect(reason(other.write(dir()), 'go')).toBe('source_identity_mismatch');
  });
});

describe('lean source — declining what cannot be established', () => {
  const base = (): Conversation => {
    const c = session();
    c.human('first', 'p1');
    c.call('Read', { file_path: 'a.ts' }, 'body');
    return c;
  };

  it('a complete record that does not parse is corruption, not noise', () => {
    const c = base();
    const lines = c.lines();
    lines.splice(1, 0, '{"type":"user","uuid":"broken", "message":');
    expect(reason(c.write(dir(), lines), 'go')).toBe('source_corrupt');
  });

  it('at the prompt, an unterminated last line may be context this turn needs, so the source is declined', () => {
    const c = base();
    const path = c.write(dir());
    writeFileSync(path, c.lines().join('\n') + '\n' + '{"type":"user","uuid":"half-written","message":{"content":"예외: 공용 컴포');
    expect(reason(path, 'go')).toBe('source_incomplete');
  });

  it('at dispatch, an unterminated last line is this turn’s own output still being written, and is left out', () => {
    const c = base();
    c.human('go', NOW);
    const path = c.write(dir());
    writeFileSync(path, c.lines().join('\n') + '\n' + '{"type":"assistant","uuid":"half-written","message":{"content":[{"type":"te');
    const s = ok(path, 'go', { phase: 'dispatch' });
    expect(s.requestRecorded).toBe(true);
    expect(optionalGroups(s)).toHaveLength(1);
  });

  it('a complete record that is not valid UTF-8 is corruption', () => {
    const c = base();
    const path = c.write(dir());
    const lines = c.lines();
    writeFileSync(path, Buffer.concat([Buffer.from(`${lines[0]}\n`), Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d, 0x0a]), Buffer.from(lines.slice(1).join('\n') + '\n')]));
    expect(reason(path, 'go')).toBe('source_corrupt');
  });

  it('a user envelope that mixes a tool result with other content is declined', () => {
    const c = session();
    c.human('first', 'p1');
    const call = c.use('Read', { file_path: 'a.ts' }, c.newMessageId());
    c.append({ type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'body' }, { type: 'text', text: 'and also do X' }] } });
    expect(reason(c.write(dir()), 'go')).toBe('source_unsupported');
  });

  it('an image the user sent cannot be carried, so the source is declined rather than silently changed', () => {
    const c = session();
    c.human([{ type: 'text', text: 'match this screenshot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }], 'p1');
    c.say('looking');
    expect(reason(c.write(dir()), 'go')).toBe('source_unsupported');
  });

  it('an attachment type it has not seen is declined', () => {
    const c = base();
    c.attachment({ type: 'a_brand_new_host_record', content: 'must not be dropped silently' });
    expect(reason(c.write(dir()), 'go')).toBe('source_unsupported');
  });

  it('a user record with a provenance it has not seen is declined', () => {
    const c = base();
    c.append({ type: 'user', promptId: 'p1', message: { role: 'user', content: 'who wrote this?' } });
    expect(reason(c.write(dir()), 'go')).toBe('source_unsupported');
  });

  it('refuses a FIFO without blocking on it', () => {
    const d = dir();
    const fifo = join(d, `${SID}.jsonl`);
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const started = Date.now();
    expect(reason(fifo, 'go')).toBe('source_unavailable');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('collapses an identical repeat of a record, and refuses one identity with two contents', () => {
    const c = base();
    const same = c.lines();
    same.push(same[1] as string);
    expect(optionalGroups(ok(c.write(dir(), same), 'go'))).toHaveLength(1);
    const differs = c.lines();
    const edited = JSON.parse(differs[0] as string) as Record<string, unknown>;
    differs.push(JSON.stringify({ ...edited, message: { role: 'user', content: 'first, but edited' } }));
    expect(reason(c.write(dir(), differs), 'go')).toBe('source_corrupt');
  });

  it('a parent chain with a cycle is unknown lineage', () => {
    const c = session();
    c.append({ type: 'user', uuid: 'u-a', promptId: 'p1', origin: { kind: 'human' }, message: { role: 'user', content: 'a' } }, { parent: 'u-b' });
    c.append({ type: 'user', uuid: 'u-b', promptId: 'p2', origin: { kind: 'human' }, message: { role: 'user', content: 'b' } }, { parent: 'u-a' });
    expect(reason(c.write(dir()), 'go')).toBe('source_lineage_unknown');
  });
});

describe('lean source — compaction lineage', () => {
  const partial = (form: 'both' | 'list' | 'segment'): { c: Conversation; ids: { boundary: string; summary: string } } => {
    const c = session();
    c.human('a turn that was dropped by the compaction', 'p1');
    c.say('dropped too');
    c.human('the retained turn', 'p2');
    const kept = c.call('Read', { file_path: 'src/keep.ts' }, 'file body');
    const ids = c.compact('Summary: the user asked for X, then Y failed.', [kept.use, kept.result], form);
    c.human('after the compaction', 'p3');
    c.call('Bash', { command: 'npm test' }, 'passed');
    return { c, ids };
  };

  it.each(['both', 'list', 'segment'] as const)('takes the host preserved lineage (%s form): the summary plus the retained suffix', (form) => {
    const { c, ids } = partial(form);
    const s = ok(c.write(dir()), 'carry on');
    expect(s.epoch).toBe(`compact:${ids.boundary}:${ids.summary}`);
    const mandatory = mandatoryGroups(s);
    expect(mandatory.map((g) => g.origin)).toEqual(['compact_summary', 'human']);
    expect(mandatory[0]?.text).toBe('Summary: the user asked for X, then Y failed.');
    expect(texts(s)).not.toContain('a turn that was dropped');
    expect(texts(s)).not.toContain('the retained turn');
    // Partial compaction retained an earlier interaction; it is optional evidence, still in view.
    expect(optionalGroups(s).map((g) => g.text).join('\n')).toContain('src/keep.ts');
    expect(optionalGroups(s).map((g) => g.text).join('\n')).toContain('npm test');
  });

  it('a compaction that kept nothing leaves only the summary and what came after', () => {
    const c = session();
    c.human('dropped', 'p1');
    c.call('Read', { file_path: 'gone.ts' }, 'gone');
    c.compact('Summary: nothing kept.');
    c.human('after', 'p2');
    const s = ok(c.write(dir()), 'go');
    expect(texts(s)).not.toContain('gone.ts');
    expect(mandatoryGroups(s).map((g) => g.origin)).toEqual(['compact_summary', 'human']);
  });

  it('a malformed preserved list or segment is unknown lineage', () => {
    const { c } = partial('both');
    const lines = c.lines().map((l) => {
      const r = JSON.parse(l) as Record<string, unknown>;
      if (r['subtype'] !== 'compact_boundary') return l;
      return JSON.stringify({ ...r, compactMetadata: { trigger: 'auto', preservedSegment: { headUuid: 'h', anchorUuid: 'a' } } });
    });
    expect(reason(c.write(dir(), lines), 'go')).toBe('source_lineage_unknown');
    const listBroken = c.lines().map((l) => {
      const r = JSON.parse(l) as Record<string, unknown>;
      if (r['subtype'] !== 'compact_boundary') return l;
      return JSON.stringify({ ...r, compactMetadata: { trigger: 'auto', preservedMessages: { anchorUuid: 'a', uuids: 'not-a-list' } } });
    });
    expect(reason(c.write(dir(), listBroken), 'go')).toBe('source_lineage_unknown');
  });

  it('a preserved list that repeats an identity is unknown lineage, and one out of write order is not', () => {
    const { c } = partial('list');
    const rewrite = (fn: (uuids: string[]) => string[]): string[] =>
      c.lines().map((l) => {
        const r = JSON.parse(l) as Record<string, unknown>;
        if (r['subtype'] !== 'compact_boundary') return l;
        const meta = r['compactMetadata'] as { preservedMessages: { anchorUuid: string; uuids: string[] } };
        return JSON.stringify({ ...r, compactMetadata: { ...meta, preservedMessages: { ...meta.preservedMessages, uuids: fn(meta.preservedMessages.uuids) } } });
      });
    const r = readLeanSource(c.write(dir(), rewrite((u) => [...u, u[0] as string])), bind('go'));
    expect(r.ok === false && [r.reason, r.detail]).toEqual(['source_lineage_unknown', 'the preserved message list repeats an identity']);
    // Measured: real lists are mostly neither parent chains nor in write order, and the host relinks them as listed.
    expect(ok(c.write(dir(), rewrite((u) => [...u].reverse())), 'go').epoch).toMatch(/^compact:/);
  });

  it('an anchor that is not the compaction summary is unknown lineage', () => {
    const { c, ids } = partial('list');
    const lines = c.lines().map((l) => {
      const r = JSON.parse(l) as Record<string, unknown>;
      return r['uuid'] === ids.summary ? JSON.stringify({ ...r, isCompactSummary: false, origin: { kind: 'human' } }) : l;
    });
    expect(reason(c.write(dir(), lines), 'go')).toBe('source_lineage_unknown');
  });

  it('a preserved record missing from a complete file is unknown lineage', () => {
    const { c, ids } = partial('list');
    const lines = c.lines().filter((l) => {
      const r = JSON.parse(l) as Record<string, unknown>;
      const meta = (c.records.find((x) => x['uuid'] === ids.boundary)?.['compactMetadata'] ?? {}) as { preservedMessages: { uuids: string[] } };
      return r['uuid'] !== meta.preservedMessages.uuids[1];
    });
    expect(reason(c.write(dir(), lines), 'go')).toBe('source_lineage_unknown');
  });

  it('a summary on the chain that is not the anchor of the last compaction is declined', () => {
    const { c } = partial('both');
    c.append({ type: 'user', promptId: 'p3', isCompactSummary: true, message: { role: 'user', content: 'a stray summary' } });
    expect(reason(c.write(dir()), 'go')).toBe('source_unsupported');
  });

  it('a compaction after the packet was built changes the epoch', () => {
    const c = session();
    c.human('first', 'p1');
    const kept = c.call('Read', { file_path: 'a.ts' }, 'x');
    const before = ok(c.write(dir()), 'go');
    c.compact('Summary: ...', [kept.use, kept.result]);
    const after = ok(c.write(dir()), 'go');
    expect(before.epoch).toBe('uncompacted');
    expect(after.epoch).not.toBe(before.epoch);
  });
});

describe('lean source — real interaction identity', () => {
  it('groups parallel calls by their response and pairs results by call id, whatever order they arrive in', () => {
    const c = session();
    c.human('read both', 'p1');
    const m = c.newMessageId();
    c.say('reading both', m);
    const a = c.use('Read', { file_path: 'a.ts' }, m);
    const b = c.use('Read', { file_path: 'b.ts' }, m);
    c.result(b.id, 'body of b');
    c.result(a.id, 'body of a');
    c.say('both read', c.newMessageId());
    const groups = optionalGroups(ok(c.write(dir()), 'go'));
    expect(groups).toHaveLength(2);
    for (const t of ['a.ts', 'b.ts', 'body of a', 'body of b']) expect(groups[0]?.text).toContain(t);
    expect(groups[1]?.text).toBe('both read');
  });

  it('restores a parallel call and its result that sit beside the chain, as the host does', () => {
    const c = session();
    c.human('read both', 'p1');
    const m = c.newMessageId();
    const a = c.use('Read', { file_path: 'a.ts' }, m);
    c.result(a.id, 'body of a', { parent: a.use });
    const b = c.use('Read', { file_path: 'b.ts' }, m, { parent: a.use, chain: false });
    c.result(b.id, 'body of b', { parent: b.use, chain: false });
    c.say('done', c.newMessageId());
    const s = ok(c.write(dir()), 'go');
    expect(optionalGroups(s)[0]?.text).toContain('body of b');
    expect(s.abandoned).toBe(0);
  });

  it('leaves an abandoned branch out, and counts it', () => {
    const c = session();
    c.human('first', 'p1');
    const fork = c.last;
    c.say('an answer the user rewound');
    c.human('an instruction that was edited away', 'p2');
    c.branchFrom(fork);
    c.say('the answer that stayed');
    const s = ok(c.write(dir()), 'go');
    expect(texts(s)).not.toContain('edited away');
    expect(texts(s)).not.toContain('rewound');
    expect(texts(s)).toContain('the answer that stayed');
    expect(s.abandoned).toBe(2);
  });

  it('keeps an interruption with the response it cut short', () => {
    const c = session();
    c.human('run it', 'p1');
    c.call('Bash', { command: 'npm run e2e' }, 'The user doesn’t want to proceed with this tool use.', { isError: true });
    c.interrupt();
    const g = optionalGroups(ok(c.write(dir()), 'go'));
    expect(g).toHaveLength(1);
    expect(g[0]?.text).toContain('npm run e2e');
    expect(g[0]?.text).toContain('[Request interrupted by user for tool use]');
  });

  it('pairs a notification with the call it names, counts one naming an unknown call, and keeps one naming none', () => {
    const c = session();
    c.human('start it in the background', 'p1');
    const t = c.use('Agent', { subagent_type: 'general-purpose', prompt: 'long job', run_in_background: true }, c.newMessageId());
    c.result(t.id, 'Async agent launched successfully.');
    c.notification(t.id, 'completed', 'Agent "long job" completed');
    c.notification('toolu_not_in_view', 'completed', 'something older');
    c.notification(null, 'completed', 'a background shell finished');
    const s = ok(c.write(dir()), 'go');
    const agent = optionalGroups(s).find((g) => g.text.includes('long job'));
    expect(agent?.text).toContain('Async agent launched successfully.');
    expect(agent?.text).toContain('completed');
    expect(texts(s)).not.toContain('something older');
    expect(s.excluded.unattributed).toBe(1);
    expect(optionalGroups(s).find((g) => g.text.includes('a background shell finished'))?.origin).toBe('observation');
  });

  it('one call with two different results is corruption', () => {
    const c = session();
    c.human('go', 'p1');
    const a = c.use('Read', { file_path: 'a.ts' }, c.newMessageId());
    c.result(a.id, 'one body');
    c.result(a.id, 'another body');
    expect(reason(c.write(dir()), 'next')).toBe('source_corrupt');
  });

  it('names media in a result instead of dropping it, and declines a result form it has not seen', () => {
    const c = session();
    c.human('look', 'p1');
    c.call('Read', { file_path: 'shot.png' }, '', { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] });
    c.call('ToolSearch', { query: 'select:Edit' }, '', { content: [{ type: 'tool_reference', tool_name: 'Edit' }] });
    const s = ok(c.write(dir()), 'go');
    expect(texts(s)).toContain('[image not carried]');
    expect(texts(s)).toContain('[tool_reference Edit]');
    c.call('Read', { file_path: 'x.pdf' }, '', { content: [{ type: 'document', source: {} }] });
    expect(reason(c.write(dir()), 'go')).toBe('source_unsupported');
  });

  it('declines when the request makes a result carrying an image required context', () => {
    const c = session();
    c.human('look', 'p1');
    c.call('Read', { file_path: 'shot.png' }, '', { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] });
    c.call('Read', { file_path: 'notes.md' }, 'unrelated notes');
    const path = c.write(dir());
    expect(optionalGroups(ok(path, 'go'))).toHaveLength(2);
    const r = readLeanSource(path, bind('`shot.png` 처럼 맞춰줘'));
    expect(r.ok === false && [r.reason, r.detail]).toEqual(['source_unsupported', 'required context carries an image that is not carried']);
  });
});

describe('lean source — exact references, resolved before anything is evicted', () => {
  const base = (): Conversation => {
    const c = session();
    c.human('earlier', 'p1');
    c.call('Read', { file_path: 'src/quote.ts' }, 'export const parseQuote = (s) => Math.round(Number(s));');
    c.call('Read', { file_path: 'docs/old.md' }, 'a changelog from last year');
    return c;
  };

  it('makes the one group an exact reference resolves to mandatory', () => {
    const s = ok(base().write(dir()), '`parseQuote` 반올림 고쳐줘');
    expect(s.groups.find((g) => g.text.includes('parseQuote'))?.mandatory).toBe(true);
    expect(optionalGroups(s).map((g) => g.text).join('')).toContain('changelog');
  });

  it('resolves a path reference the same way', () => {
    const s = ok(base().write(dir()), 'docs/old.md 를 갱신해줘');
    expect(s.groups.find((g) => g.text.includes('docs/old.md'))?.mandatory).toBe(true);
  });

  it('finds a path beside a long unbroken paste in linear time, instead of running out the source bound', () => {
    const c = base();
    c.human(`this log line: ${'x'.repeat(70 * 1024)}`, 'p2');
    const started = Date.now();
    const s = ok(c.write(dir()), 'docs/old.md 를 갱신해줘');
    expect(Date.now() - started).toBeLessThan(200);
    expect(s.groups.find((g) => g.text.includes('docs/old.md'))?.mandatory).toBe(true);
  });

  it('promotes nothing for an ambiguous or a dangling reference, and does not guess', () => {
    expect(optionalGroups(ok(base().write(dir()), 'that `Read` call was wrong'))).toHaveLength(2);
    const dangling = ok(base().write(dir()), 'do the second option above');
    expect(optionalGroups(dangling)).toHaveLength(2);
    expect(mandatoryGroups(dangling).map((g) => g.origin)).toEqual(['human']);
  });

  it('resolves a reference made in an earlier human turn, not only in the current request', () => {
    const c = base();
    c.human('remember `parseQuote` rounds down', 'p2');
    expect(ok(c.write(dir()), 'carry on').groups.find((g) => g.text.includes('export const parseQuote'))?.mandatory).toBe(true);
  });

  const many = (first: string, extra = 0): Conversation => {
    const c = session();
    c.human('earlier', 'p1');
    c.call('Read', { file_path: 'src/legacy.ts' }, first);
    for (let i = 0; i < MAX_OPTIONAL_GROUPS + extra; i++) c.call('Read', { file_path: `f${i}.ts` }, `body ${i}`);
    return c;
  };

  it('keeps a required group that is older than the enumeration window', () => {
    const s = ok(many('export const parseLegacyQuote = 1;', 2).write(dir()), '`parseLegacyQuote`를 고쳐줘');
    expect(mandatoryGroups(s).some((g) => g.text.includes('parseLegacyQuote'))).toBe(true);
    // The promoted group is required, so it is not one of the optional groups the window counted out.
    expect(s.excluded.window).toBe(2);
  });

  it('two matches are ambiguous even when one of them would have been evicted', () => {
    const c = many('const sharedToken = "old";', 1);
    c.call('Read', { file_path: 'src/new.ts' }, 'const sharedToken = "new";');
    const s = ok(c.write(dir()), '`sharedToken` 값을 바꿔줘');
    // Resolving against what survived the window would have found one match and promoted the wrong group.
    expect(mandatoryGroups(s).some((g) => g.text.includes('sharedToken'))).toBe(false);
  });

  it('a referenced group that screens as a credential becomes required, so the caller declines instead of dropping it', () => {
    const c = session();
    c.human('earlier', 'p1');
    c.call('Bash', { command: 'cat .env.local' }, 'OPENAI_API_KEY=sk-thisisonlyatestnotarealkey123');
    c.call('Read', { file_path: 'a.ts' }, 'plain');
    const s = ok(c.write(dir()), '.env.local 을 정리해줘');
    expect(mandatoryGroups(s).some((g) => looksSecret(g.text))).toBe(true);
    expect(s.excluded.secret).toBe(0);
  });
});

describe('lean source — validity across this request’s own appends', () => {
  const base = (): Conversation => {
    const c = session();
    c.human('earlier', 'p1');
    c.call('Read', { file_path: 'a.ts' }, 'body');
    return c;
  };
  const request = 'implement the parser';

  it('an ordinary assistant/tool append for the same request does not move the prefix digest', () => {
    const c = base();
    const before = ok(c.write(dir()), request);
    c.human(request, NOW);
    c.call('Bash', { command: 'ls' }, 'files');
    c.attachment({ type: 'hook_additional_context', content: ['note'], hookName: 'PostToolUse' });
    const after = ok(c.write(dir()), request, { phase: 'dispatch' });
    expect(after.prefixDigest).toBe(before.prefixDigest);
    expect(after.newerHumanText).toBe(false);
  });

  it('a new human instruction after the request invalidates it, including one typed while the turn ran', () => {
    const typed = base();
    typed.human(request, NOW);
    typed.say('working');
    typed.human('stop, do the other thing', 'p-later');
    expect(ok(typed.write(dir()), request, { phase: 'dispatch' }).newerHumanText).toBe(true);

    const queued = base();
    queued.human(request, NOW);
    queued.call('Bash', { command: 'npm test' }, 'ok');
    queued.queued('actually, leave the tests alone');
    expect(ok(queued.write(dir()), request, { phase: 'dispatch' }).newerHumanText).toBe(true);
  });

  it('a destructive rewrite of an earlier record moves the digest', () => {
    const c = base();
    const before = ok(c.write(dir()), 'go');
    const lines = c.lines();
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    lines[0] = JSON.stringify({ ...first, message: { role: 'user', content: 'earlier, but edited' } });
    expect(ok(c.write(dir(), lines), 'go').prefixDigest).not.toBe(before.prefixDigest);
  });
});

describe('lean source — bounds, safety and what "unknown" means', () => {
  it('an absent transcript is unavailable, never an empty new session', () => {
    expect(reason(join(dir(), `${SID}.jsonl`), 'go')).toBe('source_unavailable');
    expect(readLeanSource(null, bind('go')).ok).toBe(false);
  });

  it('a startup transcript with no prior turns yields zero optional groups, not a failure', () => {
    const c = session();
    c.records.push({ type: 'mode', mode: 'normal' });
    c.attachment({ type: 'hook_success', content: 'ok', hookName: 'SessionStart:startup', hookEvent: 'SessionStart' });
    expect(optionalGroups(ok(c.write(dir()), 'first thing I have said'))).toHaveLength(0);
  });

  it('gives up rather than guessing when the time bound runs out', () => {
    const c = session();
    c.human('first', 'p1');
    const r = readLeanSource(c.write(dir()), bind('go'), { now: (() => { let n = 0; return () => (n += 1000); })() });
    expect(r.ok === false && r.reason).toBe('source_bounded');
  });

  it('the time bound reaches reference resolution: a request naming many things cannot run past it', () => {
    const c = session();
    c.human('first', 'p1');
    c.call('Read', { file_path: 'a.ts' }, 'body');
    const path = c.write(dir());
    // Each clock read costs 3 ms, so only work that reads the clock per step can exhaust 400 ms.
    const slow = (): (() => number) => {
      let n = 0;
      return () => (n += 3);
    };
    expect(readLeanSource(path, bind('go'), { now: slow() }).ok).toBe(true);
    const many = Array.from({ length: 200 }, (_, i) => `\`symbol${i}\``).join(' ');
    const r = readLeanSource(path, bind(many), { now: slow() });
    expect(r.ok === false && r.reason).toBe('source_bounded');
  });

  it('reads the clock before each text, each searched path run and each candidate, not only once per token', () => {
    let ticks = 0;
    const candidates = [{ text: 'x.ts here' }, { text: 'y.ts there' }, { text: 'neither' }];
    const resolved = resolveReferences(['edit x.ts and y.ts', 'no references at all'], candidates, () => {
      ticks += 1;
    });
    expect([...resolved].map((g) => g.text).sort()).toEqual(['x.ts here', 'y.ts there']);
    // 2 texts + 2 path runs + 2 tokens x 3 candidates. Per token alone would be 2.
    expect(ticks).toBe(10);
    const stop = (): void => {
      throw new Error('bound');
    };
    expect(() => resolveReferences(['no references at all'], candidates, stop)).toThrow('bound');
  });

  it('reads the clock inside a long text with no path in it, not only between texts', () => {
    let ticks = 0;
    const words = Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ');
    resolveReferences([words], [], () => {
      ticks += 1;
    });
    // 1 before the text, then one per 16 runs of its 160.
    expect(ticks).toBe(11);
  });

  it('a history cut by the read bound is bounded, not an empty or a guessed conversation', () => {
    const c = session();
    c.human('first', 'p1');
    c.call('Read', { file_path: 'huge.log' }, 'x'.repeat(SOURCE_MAX_BYTES + 1024));
    c.human('second', 'p2');
    c.say('answer');
    expect(reason(c.write(dir()), 'go')).toBe('source_bounded');
  });

  it('withholds a credential-bearing optional group whole and counts it unassessed', () => {
    const c = session();
    c.human('earlier', 'p1');
    c.call('Bash', { command: 'export TYPESAFE_API_KEY=sk-abcdefghijklmnopqrstuvwx' }, 'ok');
    c.call('Read', { file_path: 'a.ts' }, 'body');
    const s = ok(c.write(dir()), 'go');
    expect(optionalGroups(s)).toHaveLength(1);
    expect(texts(s)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(s.excluded.secret).toBe(1);
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

  it('screens a bearer or basic credential whose token has no conventional prefix', () => {
    // Fake values: neither is a credential anywhere.
    expect(looksSecret('curl -H "Authorization: Bearer q7Zt2mVx9LpR4wKs8NcY" https://example.test')).toBe(true);
    expect(looksSecret('{"Authorization": "Basic dGVzdG9ubHk6bm90YWtleQ=="}')).toBe(true);
    expect(looksSecret('authorization=token Xk3pQ9rT5vW2yZ8m')).toBe(true);
    expect(looksSecret('export TOKEN=1; fetch(url, { headers: { Bearer q7Zt2mVx9LpR4wKs8NcY } })')).toBe(true);
    expect(looksSecret('curl -H "Authorization: Bearer $TOKEN" https://example.test')).toBe(false);
    expect(looksSecret('the bearer of this message carries basic internationalization notes')).toBe(false);
  });

  it('screens a short literal header credential and the backtick form, but not a name, placeholder or concatenation', () => {
    // `dTpw` is base64 of `u:p`: short, and still a whole credential.
    expect(looksSecret('curl -H "Authorization: Basic dTpw" https://example.test')).toBe(true);
    expect(looksSecret('headers: { Authorization: `Bearer abcdefghijklmnopqrstuvwx` }')).toBe(true);
    expect(looksSecret("const password = `hunter2hunter2hunter2`;")).toBe(true);
    expect(looksSecret('headers: { Authorization: `Bearer ${token}` }')).toBe(false);
    expect(looksSecret("headers: { Authorization: 'Bearer ' + token }")).toBe(false);
    expect(looksSecret('Authorization: Bearer <token>')).toBe(false);
    expect(looksSecret('Authorization: Basic {{credentials}}')).toBe(false);
    expect(looksSecret('set Authorization: Bearer %API_TOKEN% in the script')).toBe(false);
  });

  it('screens a literal header credential in subscript, call, template and concatenation forms', () => {
    expect(looksSecret('headers["Authorization"] = "Basic dTpw";')).toBe(true);
    expect(looksSecret('headers.set("Authorization", "Basic dTpw");')).toBe(true);
    expect(looksSecret("req.setRequestHeader('Proxy-Authorization', 'Bearer abc');")).toBe(true);
    expect(looksSecret("headers: { Authorization: `Basic ${'dTpw'}` }")).toBe(true);
    expect(looksSecret("headers: { Authorization: 'Basic ' + 'dTpw' }")).toBe(true);
    expect(looksSecret("const auth = btoa('u:p');")).toBe(true);
    expect(looksSecret("Buffer.from('testonly:notakey').toString('base64')")).toBe(true);
    expect(looksSecret('DATABASE_URL=postgres://app:testonlynotakey@db.internal:5432/app')).toBe(true);
    expect(looksSecret('headers.set("Authorization", `Bearer ${token}`);')).toBe(false);
    expect(looksSecret("headers['Authorization'] = 'Basic ' + encoded;")).toBe(false);
    expect(looksSecret('const auth = btoa(`${user}:${pass}`);')).toBe(false);
    expect(looksSecret('postgres://${USER}:${PASS}@db.internal/app and https://user@example.test/')).toBe(false);
  });

  it('enumerates the newest groups under the cap and counts the rest rather than calling them irrelevant', () => {
    const c = session();
    c.human('earlier', 'p1');
    for (let i = 0; i < MAX_OPTIONAL_GROUPS + 5; i++) c.call('Read', { file_path: `f${i}.ts` }, `body ${i}`);
    const s = ok(c.write(dir()), 'go');
    expect(optionalGroups(s)).toHaveLength(MAX_OPTIONAL_GROUPS);
    expect(s.excluded.window).toBe(5);
    expect(s.unassessed).toBe(5);
    expect(optionalGroups(s).at(-1)?.text).toContain(`body ${MAX_OPTIONAL_GROUPS + 4}`);
  });

  it('does not collapse identical text observed at two different records', () => {
    const c = session();
    c.human('earlier', 'p1');
    c.call('Read', { file_path: 'src/a.ts' }, 'export const x = 1;');
    c.call('Read', { file_path: 'src/b.ts' }, 'export const x = 1;');
    expect(optionalGroups(ok(c.write(dir()), 'go'))).toHaveLength(2);
  });
});
