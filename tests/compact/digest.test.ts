import { describe, expect, it } from 'vitest';

import { assemble, buildDigest, DIGEST_MARK, messageChars } from '../../mods/compact/hooks/digest.ts';

/** A row as the engine hands it, plus the ids the pairing check needs; structurally a DigestMessage. */
interface Row {
  role: 'user' | 'assistant';
  text: string;
  toolUses: Array<{ tool: string; input: Record<string, unknown>; text?: string; id: string }>;
  toolResults?: Array<{ text: string; id: string }>;
  handle: string;
}

let n = 0;
const user = (text: string): Row => ({ role: 'user', text, toolUses: [], handle: `h${n++}` });
const call = (text: string, tool: string, input: Record<string, unknown>, result: string): Row[] => {
  const id = `t${n}`;
  return [
    { role: 'assistant', text, toolUses: [{ tool, input, text: result, id }], handle: `h${n++}` },
    { role: 'user', text: '', toolUses: [], toolResults: [{ text: result, id }], handle: `h${n++}` },
  ];
};
const say = (text: string): Row => ({ role: 'assistant', text, toolUses: [], handle: `h${n++}` });

/** A session: a prior summary, two requests, forty tool exchanges with sizeable results, a closing reply. */
const session = (): Row[] => [
  user('This session is being continued from a previous conversation. Summary: migrating parseRow in src/rows.ts.'),
  user('<system-reminder>Today is Sunday.</system-reminder>'),
  user('Rename parseRow to parseRecord across the repo.'),
  ...Array.from({ length: 40 }, (_, i) => call(`Step ${i}: checking file ${i}.`, 'Read', { file_path: `/repo/src/file${i}.ts` }, `contents of file${i} `.repeat(120))).flat(),
  user('Also update the README.'),
  ...call('Updating the README.', 'Edit', { file_path: '/repo/README.md', old_string: 'parseRow', new_string: 'parseRecord' }, 'ok'),
  say('Done: renamed in 40 files and the README.'),
];

describe('buildDigest', () => {
  it('keeps a tail that starts at an assistant message and holds both halves of every tool exchange in it', () => {
    const rows = session();
    const d = buildDigest(rows, { budgetChars: 40000 });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const out = assemble(rows, d.result);
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.text.startsWith(DIGEST_MARK)).toBe(true);
    expect(out[1]!.role).toBe('assistant');
    const tail = out.slice(1) as Row[];
    const uses = new Set(tail.flatMap((m) => m.toolUses.map((u) => u.id)));
    for (const m of tail) for (const r of m.toolResults ?? []) expect(uses.has(r.id)).toBe(true);
    // The kept messages are the engine's own objects, handles and all.
    expect(tail.every((m, i) => m === rows[d.result.start + i])).toBe(true);
  });

  it('stays within the budget when the tail fits its share', () => {
    const rows = session();
    const d = buildDigest(rows, { budgetChars: 40000 });
    if (!d.ok) throw new Error(d.reason);
    expect(d.result.tailChars).toBeLessThanOrEqual(16000);
    expect(d.result.digestChars + d.result.tailChars).toBeLessThanOrEqual(40000);
    expect(d.result.tailChars).toBe(rows.slice(d.result.start).reduce((a, m) => a + messageChars(m), 0));
  });

  it('carries the previous summary, the requests (not engine text), and the tool inputs, oldest first', () => {
    const rows = session();
    const d = buildDigest(rows, { budgetChars: 40000 });
    if (!d.ok) throw new Error(d.reason);
    const t = d.result.digest;
    expect(t).toContain('## Previous summary\nThis session is being continued');
    expect(t).toContain('▸ Rename parseRow to parseRecord across the repo.');
    expect(t).not.toContain('Today is Sunday');
    expect(t.indexOf('/repo/src/file0.ts')).toBeGreaterThan(0);
    expect(t.indexOf('/repo/src/file0.ts')).toBeLessThan(t.indexOf('/repo/src/file30.ts'));
    // Results are excerpts: newer ones first while room lasts.
    expect(t).toContain('contents of file30');
  });

  it('takes a digest it wrote apart: its summary stays the summary, its requests and steps join the new ones', () => {
    const rows1 = session();
    const first = buildDigest(rows1, { budgetChars: 30000 });
    if (!first.ok) throw new Error(first.reason);
    // What the engine holds after the first compaction, and then some more work.
    const rows = [
      ...(assemble(rows1, first.result) as Row[]),
      user('Now add a changelog entry.'),
      ...Array.from({ length: 12 }, (_, i) => call(`Changelog ${i}.`, 'Edit', { file_path: `/repo/CHANGELOG${i}.md` }, 'z'.repeat(1500))).flat(),
      say('Added.'),
    ];
    const d = buildDigest(rows, { budgetChars: 30000 });
    if (!d.ok) throw new Error(d.reason);
    const t = d.result.digest;
    expect(t.match(/## Previous summary/g)?.length).toBe(1);
    expect(t.match(/\[jev-gate compact\]/g)?.length).toBe(1);
    expect(t).toContain('## Previous summary\nThis session is being continued');
    // Requests from both stretches, oldest first.
    expect(t.indexOf('▸ Rename parseRow')).toBeGreaterThan(0);
    expect(t.indexOf('▸ Rename parseRow')).toBeLessThan(t.indexOf('▸ Also update the README.'));
    expect(t.indexOf('▸ Also update the README.')).toBeLessThan(t.indexOf('▸ Now add a changelog entry.'));
    // The newest carried steps survive, before this stretch's; the oldest go first.
    const carriedAt = t.search(/\/repo\/src\/file\d+\.ts/);
    expect(carriedAt).toBeGreaterThan(0);
    expect(carriedAt).toBeLessThan(t.indexOf('/repo/README.md'));
    expect(t).not.toContain('/repo/src/file0.ts');
    expect(t.indexOf('/repo/README.md')).toBeLessThan(t.indexOf('/repo/CHANGELOG0.md'));
    expect(t.length + d.result.tailChars).toBeLessThanOrEqual(30000);
  });

  it('keeps the last exchange whole even past its share, and leaves one over twice the budget to the engine', () => {
    const big = 'x'.repeat(30000);
    const rows = [user('Read the log.'), say('Reading.'), user('ok'), ...call('Reading the log.', 'Read', { file_path: '/var/log/a' }, big)];
    const d = buildDigest(rows, { budgetChars: 20000 });
    if (!d.ok) throw new Error(d.reason);
    expect(d.result.start).toBe(3);
    expect(d.result.digest.length).toBeLessThanOrEqual(6000 + 10);
    const huge = [user('Read the log.'), say('Reading.'), ...call('Reading the log.', 'Read', { file_path: '/var/log/a' }, 'x'.repeat(50000))];
    expect(buildDigest(huge, { budgetChars: 20000 })).toEqual({ ok: false, reason: 'tail_too_large' });
  });

  it('leaves a conversation with nothing before its last assistant message to the engine', () => {
    expect(buildDigest([user('hi')], { budgetChars: 20000 })).toEqual({ ok: false, reason: 'nothing_to_compact' });
    expect(buildDigest([say('hello'), user('hi')], { budgetChars: 20000 }).ok).toBe(false);
  });
});
