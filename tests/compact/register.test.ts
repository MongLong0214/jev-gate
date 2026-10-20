import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCompactConfig } from '../../mods/compact/hooks/config.ts';
import { rowOf, type CellResult } from '../../src/bench/ab.js';

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
  (await load())((name, hook) => hooks.set(name, hook), { jevEnabled: false, ...options });
  return hooks;
};

// The Mod's records reach the trace as files; each one is read back here as the line the Mod emitted.
const logs: string[] = [];
const marks: string[] = [];
const hostWith = (write: (path: string, text: string) => Promise<void>) => ({
  env: { get: async (name: string) => ({ HOME: '/h', JEV_GATE_TRACE_DIR: '/h/trace' } as Record<string, string>)[name] },
  session: { id: async () => 's' },
  fs: { stat: async () => ({ isLink: false, kind: 'dir', size: 0 }), exists: async () => false, read: async () => '', write },
  clock: { sleep: () => new Promise<void>(() => undefined) },
});
const $ = hostWith(async (path, text) => {
  if (path.endsWith('.asked')) { marks.push(path); return; }
  const { host: _host, session_id: _session, phase, version: _version, invocation_id: _id, written_at: _at, recording_id: _recording, loss_marker: _marker, ...fields } = JSON.parse(text) as Record<string, unknown>;
  logs.push(`jev-${String(phase).slice(4)} ${JSON.stringify(fields)}`);
});

const conversation = () => [
  { role: 'user', text: 'Rename parseRow.', toolUses: [], handle: 'h0' },
  ...Array.from({ length: 30 }, (_, i) => [
    { role: 'assistant', text: `step ${i}`, toolUses: [{ tool: 'Read', input: { file_path: `/r/f${i}.ts` }, text: 'y'.repeat(6000), tool_use_id: `t${i}` }], handle: `a${i}` },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: 'y'.repeat(6000), isError: false }], handle: `u${i}` },
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
  it('defaults to on, active, 40000 characters, subagents and manual compaction on', () => {
    expect(resolveCompactConfig(undefined)).toEqual({ ok: true, config: { enabled: true, mode: 'active', budgetChars: 40000, subagents: true, manual: true, jevEnabled: true, jevTimeoutMs: 1000 } });
  });
  it('names the field it cannot use', () => {
    expect(resolveCompactConfig({ mode: 'fast' })).toEqual({ ok: false, field: 'mode' });
    expect(resolveCompactConfig({ budgetChars: 100 })).toEqual({ ok: false, field: 'budgetChars' });
    expect(resolveCompactConfig({ budgetChars: 1.5e4 + 0.5 })).toEqual({ ok: false, field: 'budgetChars' });
    expect(resolveCompactConfig({ enabled: 'yes' })).toEqual({ ok: false, field: 'enabled' });
  });
});

describe('register', () => {
  it('keeps a confirmed fake Jev send unknown after record loss and a post-send native exception', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-compact-loss-'));
    try {
      const hooks = await hooksFor({ enabled: true, jevEnabled: true, mode: 'shadow' });
      const host = hostWith(async () => { throw new Error('EMFILE'); }); let sends = 0;
      host.env.get = async name => ({ HOME: dir, JEV_GATE_TRACE_DIR: dir, TYPESAFE_API_KEY: 'k'.repeat(16) } as Record<string, string>)[name];
      const engine = { ...host, http: { fetch: async () => { sends++; return { status: 200, text: JSON.stringify({ model: 'jev-1.14.0', answers: {}, usage: { input_tokens: 100, output_tokens: 1 } }) }; } } };
      await expect(hooks.get('session.compact')!(engine, { trigger: 'auto', messages: conversation() }, async () => { throw new Error('engine failed after selection'); })).rejects.toThrow('engine failed after selection');
      expect(sends).toBe(1); expect(readdirSync(dir)).toEqual([]);
      const receipts: Record<string, unknown>[] = [];
      host.fs.write = async (path, text) => { receipts.push(JSON.parse(text)); writeFileSync(path, text); };
      await hooks.get('session.end')!(engine, {}, async () => ({}));
      expect(receipts).toMatchObject([{ complete: false }]);
      const cell = { cond: 'C', sid: 's', recording_version: 1, trace_complete: true, prime: {}, harness: {} } as CellResult;
      expect(rowOf(cell, null, null, dir).jev_cost).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('leaves the marker the plugin\'s command hook reads, for every compaction it is asked about and defers', async () => {
    const hook = (await hooksFor({ enabled: true, mode: 'shadow' })).get('session.compact')!;
    marks.length = 0;
    await hook($, { trigger: 'auto', messages: conversation() }, nextSpy().next);
    expect(marks).toEqual(['/h/trace/compact_asked-s.asked']);
    marks.length = 0;
    await (await hooksFor({ enabled: true, mode: 'active', compactManual: false })).get('session.compact')!($, { trigger: 'manual', messages: conversation() }, nextSpy().next);
    expect(marks).toEqual(['/h/trace/compact_asked-s.asked']);
  });

  it('registers nothing when off', async () => {
    expect([...(await hooksFor({ enabled: false })).keys()]).toEqual([]);
  });

  it('with an option it cannot use, registers nothing', async () => {
    expect([...(await hooksFor({ enabled: true, budgetChars: -1 })).keys()]).toEqual([]);
  });

  it('shadow: the engine compacts; the digest size and the engine time and usage are logged', async () => {
    const hook = (await hooksFor({ enabled: true, mode: 'shadow' })).get('session.compact')!;
    const { next, calls } = nextSpy();
    logs.length = 0;
    const e = { trigger: 'auto', messages: conversation() };
    expect(await hook($, e, next)).toBe(CORE);
    expect(calls).toEqual([e]);
    const start = JSON.parse(logs[0]!.replace(/^jev-compact /, '')) as Record<string, unknown>;
    const line = JSON.parse(logs[1]!.replace(/^jev-compact /, '')) as Record<string, unknown>;
    expect(start).toMatchObject({ stage: 'started', run_id: line['run_id'], mode: 'shadow' });
    expect(line).toMatchObject({ mode: 'shadow', trigger: 'auto', subagent: false, applied: false, tokensBefore: 180000, usage: { output_tokens: 9000 } });
    expect(typeof line['digestChars']).toBe('number');
    expect(typeof line['coreMs']).toBe('number');
  });

  it('active: answers without asking the engine; the digest leads and the tail keeps its handles', async () => {
    const hook = (await hooksFor({ enabled: true, mode: 'active', compactManual: false })).get('session.compact')!;
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
    const on = (await hooksFor({ enabled: true, mode: 'active', compactSubagents: false, compactManual: false })).get('session.compact')!;
    logs.length = 0;
    await on($, { trigger: 'manual', messages: conversation() }, next);
    await on($, { trigger: 'plugin', messages: conversation() }, next);
    await on($, { trigger: 'auto', agentId: 'a1', messages: conversation() }, next);
    await on($, { trigger: 'auto', messages: [{ role: 'user', text: 'hi', toolUses: [] }] }, next);
    expect(calls).toHaveLength(4);
    const why = logs.map((l) => JSON.parse(l.replace(/^jev-compact /, '')) as Record<string, unknown>).filter((x) => x['stage'] !== 'started').map((x) => x['deferred'] ?? x['fallback']);
    expect(why).toEqual(['trigger', 'trigger', 'subagent', 'nothing_to_compact']);
    const manual = (await hooksFor({ enabled: true, mode: 'active', compactManual: true })).get('session.compact')!;
    await manual($, { trigger: 'manual', instructions: 'keep the plan', messages: conversation() }, next);
    expect(calls).toHaveLength(5);
    expect(await manual($, { trigger: 'manual', messages: conversation() }, next)).not.toBe(CORE);
  });

  it('precompute: active computes nothing ahead of a compaction it answers; shadow and an excluded subagent leave it to the engine', async () => {
    const parse = () => logs.map((l) => JSON.parse(l.replace(/^jev-compact /, '')) as Record<string, unknown>);
    const { next, calls } = nextSpy();
    const active = (await hooksFor({ enabled: true, mode: 'active', compactSubagents: false })).get('session.compact')!;
    logs.length = 0;
    expect(await active($, { trigger: 'precompute', messages: conversation() }, next)).toEqual({ skip: expect.any(String) });
    expect(calls).toEqual([]);
    expect(parse()).toEqual([expect.objectContaining({ trigger: 'precompute', mode: 'active', subagent: false, skipped: 'precompute' })]);
    const all = (await hooksFor({ enabled: true, mode: 'active' })).get('session.compact')!;
    expect(await all($, { trigger: 'precompute', agentId: 'a1', messages: conversation() }, next)).toEqual({ skip: expect.any(String) });
    expect(calls).toEqual([]);
    logs.length = 0;
    const sub = { trigger: 'precompute', agentId: 'a1', messages: conversation() };
    expect(await active($, sub, next)).toBe(CORE);
    const shadow = { trigger: 'precompute', messages: conversation() };
    expect(await (await hooksFor({ enabled: true, mode: 'shadow' })).get('session.compact')!($, shadow, next)).toBe(CORE);
    expect(calls).toEqual([sub, shadow]);
    expect(parse().map((x) => x['deferred'])).toEqual(['subagent', 'trigger']);
  });

  describe('precompute then auto', () => {
    const parse = () => logs.map((l) => JSON.parse(l.replace(/^jev-compact /, '')) as Record<string, unknown>);
    const turn = (text: string) => ({ role: 'user', text, toolUses: [] });
    const say = (text: string) => ({ role: 'assistant', text, toolUses: [] });
    const call = (text: string, result: string, id: string) => [
      { role: 'assistant', text, toolUses: [{ tool: 'Read', input: { file_path: `/w/${id}` }, text: result, tool_use_id: id }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: result, isError: false }] },
    ];
    const work = (k: number) => Array.from({ length: k }, (_, i) => call(`s${i}`, 'y'.repeat(2000), `w${i}`)).flat();
    const pending = { role: 'assistant', text: 'Starting the build.', toolUses: [{ tool: 'Bash', input: { command: 'make' }, tool_use_id: 'pa' }] };
    const ghost = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'gone', text: 'z', isError: false }] };
    const fallbacks: Array<[string, number, unknown[]]> = [
      ['mandatory_overflow', 40000, [turn('a'.repeat(45000)), say('b'.repeat(90000)), turn('continue'), say('done')]],
      ['tail_too_large', 20000, [turn('Read the log.'), ...work(40), ...call('Reading the log.', 'x'.repeat(50000), 'big')]],
      ['opaque_result', 30000, [turn('Look at the page.'), ...work(30), ...call('Taking a screenshot.', '', 'shot')]],
      ['no_relief', 20000, [turn('Read the log.'), say('Reading.'), turn('ok'), ...call('Reading the log.', 'x'.repeat(30000), 'log')]],
      ['unpaired_result', 8000, [turn('x'), ...work(20), say('hm'), ghost]],
      ['pending_call', 8000, [turn('Build it.'), ...work(2), pending, ...work(40)]],
      ['nothing_to_compact', 40000, [turn('hi')]],
    ];

    it.each(fallbacks)('%s: the engine precomputes, and the auto compaction that follows goes to the engine too', async (reason, budgetChars, messages) => {
      const hook = (await hooksFor({ enabled: true, mode: 'active', budgetChars })).get('session.compact')!;
      const { next, calls } = nextSpy();
      logs.length = 0;
      const pre = { trigger: 'precompute', messages };
      const auto = { trigger: 'auto', messages };
      expect(await hook($, pre, next)).toBe(CORE);
      expect(await hook($, auto, next)).toBe(CORE);
      expect(calls).toEqual([pre, auto]);
      expect(parse().filter((x) => x['stage'] !== 'started').map((x) => [x['trigger'], x['fallback'], x['skipped']])).toEqual([['precompute', reason, undefined], ['auto', reason, undefined]]);
    });

    it('a transcript whose digest builds: precompute is skipped and the auto compaction is answered locally, so the engine is never asked', async () => {
      const hook = (await hooksFor({ enabled: true, mode: 'active' })).get('session.compact')!;
      const { next, calls } = nextSpy();
      logs.length = 0;
      expect(await hook($, { trigger: 'precompute', messages: conversation() }, next)).toEqual({ skip: expect.any(String) });
      expect(await hook($, { trigger: 'auto', messages: conversation() }, next)).toEqual({ messages: expect.any(Array) });
      expect(calls).toEqual([]);
      expect(parse().filter((x) => x['stage'] !== 'started').map((x) => [x['trigger'], x['skipped'], x['applied']])).toEqual([['precompute', 'precompute', undefined], ['auto', undefined, true]]);
    });

    it('a transcript that changed between the two: the auto compaction is judged on its own and the engine takes it when no digest builds', async () => {
      const hook = (await hooksFor({ enabled: true, mode: 'active' })).get('session.compact')!;
      const { next, calls } = nextSpy();
      expect(await hook($, { trigger: 'precompute', messages: conversation() }, next)).toEqual({ skip: expect.any(String) });
      const later = { trigger: 'auto', messages: [turn('hi')] };
      expect(await hook($, later, next)).toBe(CORE);
      expect(calls).toEqual([later]);
    });

    it('a transcript the local check cannot read: precompute stays the engine\'s', async () => {
      const hook = (await hooksFor({ enabled: true, mode: 'active' })).get('session.compact')!;
      const { next, calls } = nextSpy();
      logs.length = 0;
      const pre = { trigger: 'precompute', messages: [null] };
      expect(await hook($, pre, next)).toBe(CORE);
      expect(calls).toEqual([pre]);
      expect(parse().at(-1)).toMatchObject({ trigger: 'precompute', fallback: 'error' });
    });
  });

  it('when the engine refuses a compaction it was handed, the line is still written and the refusal passes up', async () => {
    const hook = (await hooksFor({ enabled: true, mode: 'active', compactManual: false })).get('session.compact')!;
    const huge = [
      { role: 'user', text: 'Read it.', toolUses: [] },
      { role: 'assistant', text: 'Reading.', toolUses: [{ tool: 'Read', input: { file_path: '/big' }, tool_use_id: 'tx' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tx', text: 'z'.repeat(100000), isError: false }] },
    ];
    logs.length = 0;
    await expect(hook($, { trigger: 'auto', messages: huge }, async () => Promise.reject(new Error('no assistant messages')))).rejects.toThrow('no assistant messages');
    expect(JSON.parse(logs.at(-1)!.replace(/^jev-compact /, ''))).toMatchObject({ applied: false, fallback: 'tail_too_large', coreError: true });
  });

  it('a failing recorder does not stand between the host and its compaction', async () => {
    const hook = (await hooksFor({ enabled: true, mode: 'active', compactManual: false })).get('session.compact')!;
    const bad = hostWith(async () => { throw new Error('write down'); });
    const r = (await hook(bad, { trigger: 'auto', messages: conversation() }, nextSpy().next)) as { messages: unknown[] };
    expect(r.messages.length).toBeGreaterThan(1);
    const shadow = (await hooksFor({ enabled: true, mode: 'shadow' })).get('session.compact')!;
    const { next, calls } = nextSpy();
    expect(await shadow(bad, { trigger: 'auto', messages: conversation() }, next)).toBe(CORE);
    expect(calls).toHaveLength(1);
  });

  it('its own failure goes to the engine once; the engine failing or being cancelled is passed up, never retried', async () => {
    const hook = (await hooksFor({ enabled: true, mode: 'active', compactManual: false })).get('session.compact')!;
    const broken = conversation();
    Object.defineProperty(broken[5]!, 'text', { get: () => { throw new Error('unreadable'); } });
    const { next, calls } = nextSpy();
    logs.length = 0;
    expect(await hook($, { trigger: 'auto', messages: broken }, next)).toBe(CORE);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(logs.at(-1)!.replace(/^jev-compact /, ''))).toMatchObject({ applied: false, fallback: 'error' });
    const lone = [{ role: 'user', text: 'hi', toolUses: [] }];
    for (const mode of ['shadow', 'active']) {
      const on = (await hooksFor({ enabled: true, mode })).get('session.compact')!;
      let asked = 0;
      await expect(on($, { trigger: 'auto', messages: lone }, async () => { asked++; throw new Error('engine down'); })).rejects.toThrow('engine down');
      await expect(on($, { trigger: 'auto', messages: lone }, async () => { asked++; throw new DOMException('cancelled', 'AbortError'); })).rejects.toThrow('cancelled');
      const skipped = { skip: 'cancelled' };
      expect(await on($, { trigger: 'auto', messages: lone }, async () => { asked++; return skipped; })).toBe(skipped);
      expect(asked).toBe(3);
    }
  });
});


describe('optional Jev failure does not discard the local digest', () => {
  it('keeps active local compaction when credential access throws', async () => {
    const hook = (await hooksFor({ enabled: true, jevEnabled: true })).get('session.compact')!;
    const { next, calls } = nextSpy();
    const engine = { ...$, session: { id: async () => 'fixture' }, env: { get: async (name: string) => { if (name === 'TYPESAFE_API_KEY') throw new Error('unavailable'); return undefined; } } };
    const result = await hook(engine, { trigger: 'auto', messages: conversation() }, next) as { messages: Array<{ text: string }> };
    expect(result.messages[0]!.text).toContain('[jev-gate compact]'); expect(calls).toEqual([]);
  });
  it('forwards cancellation once instead of installing a digest', async () => {
    const hook = (await hooksFor({ enabled: true, jevEnabled: false })).get('session.compact')!;
    const controller = new AbortController(); controller.abort();
    const { next, calls } = nextSpy(); Object.assign(next, { signal: controller.signal });
    const event = { trigger: 'auto', messages: conversation() };
    expect(await hook($, event, next)).toBe(CORE); expect(calls).toEqual([event]);
  });
});
