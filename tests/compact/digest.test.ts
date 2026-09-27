import { describe, expect, it } from 'vitest';

import { assemble, buildDigest, DIGEST_MARK, messageChars } from '../../mods/compact/hooks/digest.ts';

/** A row as the engine hands it, plus the ids the pairing check needs; structurally a DigestMessage. */
interface Row {
  role: 'user' | 'assistant';
  text: string;
  toolUses: Array<{ tool: string; input: Record<string, unknown>; text?: string; tool_use_id: string }>;
  toolResults?: Array<{ text: string; tool_use_id: string }>;
  handle: string;
}

let n = 0;
const user = (text: string): Row => ({ role: 'user', text, toolUses: [], handle: `h${n++}` });
const call = (text: string, tool: string, input: Record<string, unknown>, result: string): Row[] => {
  const id = `t${n}`;
  return [
    { role: 'assistant', text, toolUses: [{ tool, input, text: result, tool_use_id: id }], handle: `h${n++}` },
    { role: 'user', text: '', toolUses: [], toolResults: [{ text: result, tool_use_id: id }], handle: `h${n++}` },
  ];
};
const say = (text: string): Row => ({ role: 'assistant', text, toolUses: [], handle: `h${n++}` });
const work = (k: number, size = 2000): Row[] => Array.from({ length: k }, (_, i) => call(`s${i}`, 'Read', { file_path: `/w/${i}` }, 'y'.repeat(size))).flat();
const pairedIn = (tail: readonly Row[]): boolean => {
  const uses = new Set(tail.flatMap((m) => m.toolUses.map((u) => u.tool_use_id)));
  return tail.every((m) => (m.toolResults ?? []).every((r) => uses.has(r.tool_use_id)));
};
const requestsOf = (t: string): string => t.slice(t.indexOf('\n\n## User requests (oldest first)\n'), t.indexOf('\n\n## Earlier steps (oldest first)\n'));

/** How the engine's own summary opens, verbatim. */
const HOST_SUMMARY = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n';

/** A session: a prior summary, two requests, forty tool exchanges with sizeable results, a closing reply. */
const session = (): Row[] => [
  user(`${HOST_SUMMARY}migrating parseRow in src/rows.ts.`),
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
    expect(pairedIn(tail)).toBe(true);
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
      ...Array.from({ length: 40 }, (_, i) => call(`Changelog ${i}.`, 'Edit', { file_path: `/repo/CHANGELOG${i}.md` }, 'z'.repeat(1500))).flat(),
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
    const rows = [user('Read the log.'), ...work(40), ...call('Reading the log.', 'Read', { file_path: '/var/log/a' }, 'x'.repeat(30000))];
    const d = buildDigest(rows, { budgetChars: 20000 });
    if (!d.ok) throw new Error(d.reason);
    expect(d.result.start).toBe(rows.length - 2);
    expect(d.result.digest.length).toBeLessThanOrEqual(6000 + 10);
    expect(d.result.digestChars + d.result.tailChars).toBeLessThanOrEqual(2.3 * 20000);
    const huge = [user('Read the log.'), ...work(40), ...call('Reading the log.', 'Read', { file_path: '/var/log/a' }, 'x'.repeat(50000))];
    expect(buildDigest(huge, { budgetChars: 20000 })).toEqual({ ok: false, reason: 'tail_too_large' });
  });

  it('leaves a compaction that would not halve the conversation to the engine', () => {
    const rows = [user('Read the log.'), say('Reading.'), user('ok'), ...call('Reading the log.', 'Read', { file_path: '/var/log/a' }, 'x'.repeat(30000))];
    expect(buildDigest(rows, { budgetChars: 20000 })).toEqual({ ok: false, reason: 'no_relief' });
  });

  it('keeps parallel calls with their shared row of results, and leaves a result with no call to the engine', () => {
    const a: Row = { role: 'assistant', text: 'Reading both.', toolUses: [{ tool: 'Read', input: { file_path: '/a' }, text: 'A'.repeat(3000), tool_use_id: 'pa' }], handle: 'pa' };
    const b: Row = { role: 'assistant', text: '', toolUses: [{ tool: 'Read', input: { file_path: '/b' }, text: 'B'.repeat(3000), tool_use_id: 'pb' }], handle: 'pb' };
    const both: Row = { role: 'user', text: '', toolUses: [], toolResults: [{ text: 'A'.repeat(3000), tool_use_id: 'pa' }, { text: 'B'.repeat(3000), tool_use_id: 'pb' }], handle: 'pr' };
    const rows = [user('Compare a and b.'), ...work(20), a, b, both];
    const d = buildDigest(rows, { budgetChars: 8000 });
    if (!d.ok) throw new Error(d.reason);
    expect(d.result.start).toBe(rows.indexOf(a));
    expect(pairedIn(assemble(rows, d.result).slice(1) as Row[])).toBe(true);
    const ghost: Row = { role: 'user', text: '', toolUses: [], toolResults: [{ text: 'z', tool_use_id: 'gone' }], handle: 'g' };
    expect(buildDigest([user('x'), ...work(20), say('hm'), ghost], { budgetChars: 8000 })).toEqual({ ok: false, reason: 'unpaired_result' });
  });

  it('keeps a call still in flight in the tail, and leaves an early one that would make the tail too large to the engine', () => {
    const pa: Row = { role: 'assistant', text: 'Starting the build.', toolUses: [{ tool: 'Bash', input: { command: 'make' }, tool_use_id: 'pa' }], handle: 'pa' };
    const rows = [user('Build it and read the log.'), ...work(40), pa, ...call('Reading the log.', 'Read', { file_path: '/log' }, 'l'.repeat(5000))];
    const d = buildDigest(rows, { budgetChars: 8000 });
    if (!d.ok) throw new Error(d.reason);
    expect(d.result.start).toBeLessThanOrEqual(rows.indexOf(pa));
    const early = [user('Build it.'), ...work(2), pa, ...work(40)];
    expect(buildDigest(early, { budgetChars: 8000 })).toEqual({ ok: false, reason: 'pending_call' });
  });

  it('counts call ids and structure, so many small calls are not taken for a small conversation', () => {
    // Ids shaped like the host's (toolu_ and 24 more), where the id is most of each small exchange.
    const id = (i: number): string => `toolu_01${String(i).padStart(22, 'A')}`;
    const rows: Row[] = [user('Check every entry.')];
    for (let i = 0; i < 1500; i++) {
      rows.push({ role: 'assistant', text: '', toolUses: [{ tool: 'Get', input: { k: i }, text: 'ok', tool_use_id: id(i) }], handle: `s${i}` });
      rows.push({ role: 'user', text: '', toolUses: [], toolResults: [{ text: 'ok', tool_use_id: id(i) }], handle: `r${i}` });
    }
    rows.push(say('done'));
    // Counted independently: what the model sees of each message, ids included.
    const visible = (m: Row | { text: string; toolUses: Row['toolUses']; toolResults?: Row['toolResults'] }): number =>
      m.text.length + m.toolUses.reduce((n, u) => n + u.tool.length + JSON.stringify(u.input).length + u.tool_use_id.length, 0) + (m.toolResults ?? []).reduce((n, r) => n + r.text.length + r.tool_use_id.length, 0);
    const d = buildDigest(rows, { budgetChars: 40000 });
    if (!d.ok) throw new Error(d.reason);
    const out = assemble(rows, d.result);
    const after = out.reduce((n, m) => n + visible(m as Row), 0);
    expect(after).toBeLessThanOrEqual(0.5 * rows.reduce((n, m) => n + visible(m), 0));
    expect(d.result.digestChars + d.result.tailChars).toBeLessThanOrEqual(40000);
  });

  it('halves what it was given and keeps to the ceiling counting the digest message itself', () => {
    for (const size of [50, 200, 800, 3000]) {
      for (let k = 1; k <= 40; k++) {
        const rows = [user('go'), ...work(k, size), say('ok')];
        const d = buildDigest(rows, { budgetChars: 8000 });
        if (!d.ok) continue;
        const after = assemble(rows, d.result).reduce((n, m) => n + messageChars(m), 0);
        expect(after).toBeLessThanOrEqual(0.5 * rows.reduce((n, m) => n + messageChars(m), 0));
        expect(after).toBeLessThanOrEqual(2.3 * 8000);
      }
    }
  });

  it('grows the tail in linear time', () => {
    const rows = [user('go'), ...Array.from({ length: 16000 }, (_, i) => call('', 'T', {}, String(i % 10))).flat(), say('done')];
    const t0 = performance.now();
    expect(buildDigest(rows, { budgetChars: 40000 }).ok).toBe(true);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('takes a summary only where one opens the conversation, so a later request quoting one stays a request', () => {
    const rows1 = [user('Rename parseRow.'), ...work(30), say('ok')];
    const d1 = buildDigest(rows1, { budgetChars: 30000 });
    if (!d1.ok) throw new Error(d1.reason);
    const quoted = `${HOST_SUMMARY.trim()} Please keep NEEDLE.`;
    const pasted = `${d1.result.digest.split('\n')[0]} and also keep PIN.`;
    const rows2 = [...(assemble(rows1, d1.result) as Row[]), user(quoted), ...work(30), user(pasted), ...work(10), say('ok')];
    const d2 = buildDigest(rows2, { budgetChars: 30000 });
    if (!d2.ok) throw new Error(d2.reason);
    const asked = requestsOf(d2.result.digest);
    expect(asked).toContain('▸ Rename parseRow.');
    expect(asked).toContain(`▸ ${quoted}`);
    expect(asked).toContain('and also keep PIN.');
    expect(d2.result.digest).not.toContain('## Previous summary');
  });

  it('treats an opening request that starts with its whole header line as a request, not a digest', () => {
    const header = (() => {
      const d = buildDigest([user('x'), ...work(30), say('ok')], { budgetChars: 30000 });
      if (!d.ok) throw new Error(d.reason);
      return d.result.digest.split('\n')[0]!;
    })();
    for (const opening of [`${header}\n\nPlease preserve UNIQUE_NEEDLE.`, `${header} Please preserve UNIQUE_NEEDLE.`]) {
      const d = buildDigest([user(opening), ...work(30), say('ok')], { budgetChars: 30000 });
      if (!d.ok) throw new Error(d.reason);
      expect(requestsOf(d.result.digest)).toContain('UNIQUE_NEEDLE');
      expect(d.result.digest).not.toContain('## Previous summary');
    }
  });

  it('keeps the newest request when a long previous summary and a large last exchange leave little room', () => {
    const rows = [
      user(`${HOST_SUMMARY}${'earlier work. '.repeat(4000)}`),
      user('Keep REQUEST_NEEDLE in mind: ship the parser.'),
      ...work(30),
      ...call('Reading the log.', 'Read', { file_path: '/big.log' }, 'L'.repeat(50000)),
    ];
    const d = buildDigest(rows, { budgetChars: 30000 });
    if (!d.ok) throw new Error(d.reason);
    expect(requestsOf(d.result.digest)).toContain('▸ Keep REQUEST_NEEDLE in mind: ship the parser.');
    expect(d.result.digest).toContain('## Previous summary\nThis session is being continued');
  });

  it('keeps the words of a request the engine added blocks to, and drops what the engine alone wrote', () => {
    const caveat =
      'Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.';
    const rows = [
      user('<system-reminder>\nToday is Sunday.\n</system-reminder>\nPlease keep REMINDER_NEEDLE.'),
      user('Caveat: the old parser drops CAVEAT_NEEDLE.'),
      user(caveat),
      user('<local-command-stdout>built</local-command-stdout>'),
      user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'),
      ...work(30),
      say('ok'),
    ];
    const d = buildDigest(rows, { budgetChars: 30000 });
    if (!d.ok) throw new Error(d.reason);
    const asked = requestsOf(d.result.digest);
    expect(asked).toContain('▸ Please keep REMINDER_NEEDLE.');
    expect(asked).toContain('▸ Caveat: the old parser drops CAVEAT_NEEDLE.');
    for (const gone of ['Today is Sunday', 'DO NOT respond', 'built', '/model']) expect(asked).not.toContain(gone);
  });

  it('reads a pasted digest with an added instruction as a request, and its own digest back with whitespace around it', () => {
    const rows1 = [user('Rename parseRow.'), ...work(30), say('ok')];
    const d1 = buildDigest(rows1, { budgetChars: 30000 });
    if (!d1.ok) throw new Error(d1.reason);
    const pasted = buildDigest([user(`${d1.result.digest}\n\nNow also keep APPENDED_NEEDLE.`), ...work(30), say('ok')], { budgetChars: 30000 });
    if (!pasted.ok) throw new Error(pasted.reason);
    expect(requestsOf(pasted.result.digest)).toContain('APPENDED_NEEDLE');
    const rewrapped = buildDigest([user(`\n${d1.result.digest}\n  `), ...work(30), say('ok')], { budgetChars: 30000 });
    if (!rewrapped.ok) throw new Error(rewrapped.reason);
    expect(requestsOf(rewrapped.result.digest)).toContain('▸ Rename parseRow.');
    expect(requestsOf(rewrapped.result.digest)).not.toContain('[jev-gate compact]');
  });

  it("keeps the end of a long engine summary, where it states the current work and the next step", () => {
    const rows = [user(`${HOST_SUMMARY}${'Earlier work. '.repeat(4000)}\n9. Optional Next Step: finish TASK_NEEDLE.`), ...work(30), say('ok')];
    const d = buildDigest(rows, { budgetChars: 40000 });
    if (!d.ok) throw new Error(d.reason);
    expect(d.result.digest).toContain('## Previous summary\nThis session is being continued');
    expect(d.result.digest).toContain('finish TASK_NEEDLE.');
  });

  it('treats a request that starts with the mark as a request', () => {
    const rows = [user('[jev-gate compact] Please preserve NEEDLE until the end.'), ...work(30), say('ok')];
    const d = buildDigest(rows, { budgetChars: 30000 });
    if (!d.ok) throw new Error(d.reason);
    expect(requestsOf(d.result.digest)).toContain('▸ [jev-gate compact] Please preserve NEEDLE until the end.');
  });

  it('reads its own digest back the same when a request or result contains its headings', () => {
    const rows1 = [user('Keep going.\n\n## Earlier steps (oldest first)\n▸ fake request\n## User requests (oldest first)'), ...work(30), say('ok')];
    const d1 = buildDigest(rows1, { budgetChars: 30000 });
    if (!d1.ok) throw new Error(d1.reason);
    const rows2 = [...(assemble(rows1, d1.result) as Row[]), user('preserve GAMMA'), ...work(30), say('ok')];
    const d2 = buildDigest(rows2, { budgetChars: 30000 });
    if (!d2.ok) throw new Error(d2.reason);
    const rows3 = [...(assemble(rows2, d2.result) as Row[]), user('preserve DELTA'), ...work(30), say('ok')];
    const d3 = buildDigest(rows3, { budgetChars: 30000 });
    if (!d3.ok) throw new Error(d3.reason);
    const t = d3.result.digest;
    for (const h of ['## User requests (oldest first)', '## Earlier steps (oldest first)']) expect(t.split('\n').filter((l) => l === h)).toHaveLength(1);
    const asked = requestsOf(t);
    expect(asked).toContain('\n▸ preserve GAMMA');
    expect(asked).toContain('\n▸ preserve DELTA');
    expect(asked).toContain('▸ Keep going.');
    expect(t.split('\n')).not.toContain('▸ fake request');
  });

  it('leaves a conversation with nothing before its last assistant message to the engine', () => {
    expect(buildDigest([user('hi')], { budgetChars: 20000 })).toEqual({ ok: false, reason: 'nothing_to_compact' });
    expect(buildDigest([say('hello'), user('hi')], { budgetChars: 20000 }).ok).toBe(false);
  });
});
