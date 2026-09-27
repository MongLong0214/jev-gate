import { describe, expect, it } from 'vitest';

import { resolveCompactConfig } from '../../mods/compact/hooks/config.ts';

/**
 * register.ts types itself against the host's `claude-code` declarations, which this Node typecheck does not load, so
 * it is imported by URL and driven through the structural shape below.
 */
type Hook = (...args: unknown[]) => unknown;
type RegisterFn = (on: (name: string, hook: Hook) => void, options: Record<string, unknown>) => unknown;
const load = async (): Promise<RegisterFn> =>
  ((await import(/* @vite-ignore */ new URL('../../mods/compact/hooks/register.ts', import.meta.url).href)) as { register: RegisterFn }).register;

const hooksFor = async (options: Record<string, unknown>) => {
  const hooks = new Map<string, Hook>();
  (await load())((name, hook) => hooks.set(name, hook), options);
  return hooks;
};

const logs: string[] = [];
const $ = { ui: { log: (t: string) => logs.push(t) } };

const conversation = () => [
  { role: 'user', text: 'Rename parseRow.', toolUses: [], handle: 'h0' },
  ...Array.from({ length: 30 }, (_, i) => [
    { role: 'assistant', text: `step ${i}`, toolUses: [{ tool: 'Read', input: { file_path: `/r/f${i}.ts` }, text: 'y'.repeat(2000), tool_use_id: `t${i}` }], handle: `a${i}` },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: 'y'.repeat(2000), isError: false }], handle: `u${i}` },
  ]).flat(),
  { role: 'assistant', text: 'done', toolUses: [], handle: 'end' },
];

const CORE = { messages: [{ role: 'user', text: 'core summary', toolUses: [] }], tokensBefore: 180000, tokensAfter: 20000, usage: { input_tokens: 5, output_tokens: 9000 } };
const nextSpy = () => {
  const calls: unknown[] = [];
  const next = async (e: unknown) => {
    calls.push(e);
    return CORE;
  };
  return { next, calls };
};

describe('resolveCompactConfig', () => {
  it('defaults to off, shadow, 40000 characters, subagents on, /compact left alone', () => {
    expect(resolveCompactConfig(undefined)).toEqual({ ok: true, config: { enabled: false, mode: 'shadow', budgetChars: 40000, subagents: true, manual: false } });
  });
  it('names the field it cannot use', () => {
    expect(resolveCompactConfig({ mode: 'fast' })).toEqual({ ok: false, field: 'mode' });
    expect(resolveCompactConfig({ budgetChars: 100 })).toEqual({ ok: false, field: 'budgetChars' });
    expect(resolveCompactConfig({ budgetChars: 1.5e4 + 0.5 })).toEqual({ ok: false, field: 'budgetChars' });
    expect(resolveCompactConfig({ enabled: 'yes' })).toEqual({ ok: false, field: 'enabled' });
  });
});

describe('register', () => {
  it('registers nothing when off', async () => {
    expect([...(await hooksFor({})).keys()]).toEqual([]);
  });

  it('with an option it cannot use, registers only a session-start diagnostic naming the field', async () => {
    const hooks = await hooksFor({ enabled: true, budgetChars: -1 });
    expect([...hooks.keys()]).toEqual(['session.start']);
    logs.length = 0;
    await hooks.get('session.start')!($, {}, async () => 'went on');
    expect(logs).toEqual(['jev-compact {"event":"compact","disabled":"invalid_option","field":"budgetChars"}']);
  });

  it('shadow: the engine compacts; the digest size and the engine time and usage are logged', async () => {
    const hook = (await hooksFor({ enabled: true })).get('session.compact')!;
    const { next, calls } = nextSpy();
    logs.length = 0;
    const e = { trigger: 'auto', messages: conversation() };
    expect(await hook($, e, next)).toBe(CORE);
    expect(calls).toEqual([e]);
    const line = JSON.parse(logs[0]!.replace(/^jev-compact /, '')) as Record<string, unknown>;
    expect(line).toMatchObject({ mode: 'shadow', trigger: 'auto', subagent: false, applied: false, tokensBefore: 180000, usage: { output_tokens: 9000 } });
    expect(typeof line['digestChars']).toBe('number');
    expect(typeof line['coreMs']).toBe('number');
  });

  it('active: answers without asking the engine; the digest leads and the tail keeps its handles', async () => {
    const hook = (await hooksFor({ enabled: true, mode: 'active' })).get('session.compact')!;
    const { next, calls } = nextSpy();
    const r = (await hook($, { trigger: 'auto', messages: conversation() }, next)) as { messages: Array<{ role: string; text: string; handle?: string }> };
    expect(calls).toEqual([]);
    expect(r.messages[0]!.handle).toBeUndefined();
    expect(r.messages[0]!.text.startsWith('[jev-gate compact]')).toBe(true);
    expect(r.messages[1]!.role).toBe('assistant');
    expect(r.messages.slice(1).every((m) => typeof m.handle === 'string')).toBe(true);
    expect(r.messages.at(-1)!.handle).toBe('end');
  });

  it('active: /compact, a subagent when excluded, and a digest it cannot build all go to the engine', async () => {
    const { next, calls } = nextSpy();
    const on = (await hooksFor({ enabled: true, mode: 'active', compactSubagents: false })).get('session.compact')!;
    await on($, { trigger: 'manual', messages: conversation() }, next);
    await on($, { trigger: 'precompute', messages: conversation() }, next);
    await on($, { trigger: 'auto', agentId: 'a1', messages: conversation() }, next);
    await on($, { trigger: 'auto', messages: [{ role: 'user', text: 'hi', toolUses: [] }] }, next);
    expect(calls).toHaveLength(4);
    const manual = (await hooksFor({ enabled: true, mode: 'active', compactManual: true })).get('session.compact')!;
    await manual($, { trigger: 'manual', instructions: 'keep the plan', messages: conversation() }, next);
    expect(calls).toHaveLength(5);
    expect(await manual($, { trigger: 'manual', messages: conversation() }, next)).not.toBe(CORE);
  });

  it('a throwing log does not stand between the host and its compaction', async () => {
    const hook = (await hooksFor({ enabled: true, mode: 'active' })).get('session.compact')!;
    const bad = { ui: { log: () => { throw new Error('log down'); } } };
    const r = (await hook(bad, { trigger: 'auto', messages: conversation() }, nextSpy().next)) as { messages: unknown[] };
    expect(r.messages.length).toBeGreaterThan(1);
  });
});
