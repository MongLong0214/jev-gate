import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveOutputConfig } from '../../mods/output/hooks/config.ts';
import { MARK } from '../../mods/output/hooks/filter.ts';

/**
 * register.ts types itself against the host's `claude-code` declarations, which this Node typecheck does not load, so
 * it is imported by URL and driven through the structural shape below.
 */
type Hook = (...args: unknown[]) => unknown;
type RegisterFn = (on: (name: string, matcherOrHook: unknown, hook?: Hook) => void, options: Record<string, unknown>) => unknown;
const load = async (): Promise<RegisterFn> =>
  ((await import(/* @vite-ignore */ new URL('../../mods/output/hooks/register.ts', import.meta.url).href)) as { register: RegisterFn }).register;

/** Each hook by event name, with the matcher it was registered under. */
const hooksFor = async (options: Record<string, unknown>) => {
  const hooks = new Map<string, Hook>();
  const matchers = new Map<string, unknown>();
  (await load())((name, a, b) => {
    hooks.set(name, b ?? (a as Hook));
    if (b) matchers.set(name, a);
  }, options);
  return Object.assign(hooks, { matchers });
};

const FIXTURE = readFileSync(new URL('../fixtures/vitest-verbose.log', import.meta.url), 'utf8');
const PATH = '/home/u/.claude/projects/p/s/tool-results/b3x9.txt';
const SIZE = Buffer.byteLength(FIXTURE, 'utf8');

/** The files the host holds, what the module read and fetched, and what it logged. */
const fakeHost = (files: Record<string, string> = { [PATH]: FIXTURE }) => {
  const reads: string[] = [];
  const fetched: string[] = [];
  const logs: string[] = [];
  const $ = {
    fs: {
      read: async (p: string) => {
        reads.push(p);
        if (!(p in files)) throw new Error('ENOENT');
        return files[p]!;
      },
    },
    http: { fetch: async (url: string) => fetched.push(url) },
    ui: { log: (t: string) => logs.push(t) },
  };
  return { $, reads, fetched, logs, lines: () => logs.map((l) => JSON.parse(l.replace(/^jev-output /, '')) as Record<string, unknown>) };
};

/** What the host's `next(e)` resolves to for a persisted Bash result on 2.1.283: stdout capped at 30,000 bytes, a 2 KB preview as text. */
const persisted = (over: Record<string, unknown> = {}, text?: string) => ({
  ref: 7,
  result: { stdout: FIXTURE.slice(0, 30000), stderr: '', interrupted: false, isImage: false, noOutputExpected: false, persistedOutputPath: PATH, persistedOutputSize: SIZE, ...over },
  text:
    text ??
    `<persisted-output>\nOutput too large (${(SIZE / 1024).toFixed(1)}KB). Full output saved to: ${PATH}\n\nPreview (first 2KB):\n${FIXTURE.replace(/^(\s*\n)+/, '').slice(0, 2000)}\n...\n</persisted-output>`,
});
const CALL = { tool: 'Bash', tool_use_id: 'toolu_1', command: 'npx vitest run --reporter=verbose' };

const nextOf = (answer: unknown) => {
  const calls: unknown[] = [];
  const next = async (e: unknown) => {
    calls.push(e);
    return answer;
  };
  return { next, calls };
};

describe('resolveOutputConfig', () => {
  it('defaults to on and names a field it cannot use', () => {
    expect(resolveOutputConfig(undefined)).toEqual({ ok: true, config: { enabled: true } });
    expect(resolveOutputConfig({ enabled: 'yes' })).toEqual({ ok: false, field: 'enabled' });
  });
});

describe('register', () => {
  it('registers nothing when off', async () => {
    expect([...(await hooksFor({ enabled: false })).keys()]).toEqual([]);
  });

  it('with an option it cannot use, registers only a session-start diagnostic naming the field', async () => {
    const hooks = await hooksFor({ enabled: 1 });
    expect([...hooks.keys()]).toEqual(['session.start']);
    const h = fakeHost();
    await hooks.get('session.start')!(h.$, {}, async () => 'went on');
    expect(h.logs).toEqual(['jev-output {"event":"output","disabled":"invalid_option","field":"enabled"}']);
  });

  it('on, hooks Bash tool calls only, once', async () => {
    const hooks = await hooksFor({ enabled: true });
    expect([...hooks.keys()]).toEqual(['tool.call']);
    expect(hooks.matchers.get('tool.call')).toEqual({ tool: 'Bash' });
  });

  it('a passing persisted Vitest log: next once, only the host path read, repeats folded, the rest of the result kept', async () => {
    const hook = (await hooksFor({ enabled: true })).get('tool.call')!;
    const h = fakeHost({ [PATH]: FIXTURE, '/elsewhere/printed.txt': 'x' });
    const ran = persisted({ dangerouslyDisableSandbox: false });
    const { next, calls } = nextOf(ran);
    const r = (await hook(h.$, CALL, next)) as { result: Record<string, unknown>; ref?: number; text?: string };
    expect(calls).toEqual([CALL]);
    expect(h.reads).toEqual([PATH]);
    expect(h.fetched).toEqual([]);
    // The host maps a hook's own result; without the persisted fields it sends stdout itself.
    expect(r.ref).toBeUndefined();
    expect(r.text).toBeUndefined();
    expect(Object.keys(r.result).sort()).toEqual(['dangerouslyDisableSandbox', 'interrupted', 'isImage', 'noOutputExpected', 'stderr', 'stdout']);
    expect(r.result).toMatchObject({ stderr: '', interrupted: false, isImage: false, dangerouslyDisableSandbox: false });
    const stdout = r.result['stdout'] as string;
    expect(stdout.startsWith(`${MARK} Only runs of identical consecutive lines were folded`)).toBe(true);
    expect(stdout).toContain(`The full original (${SIZE} bytes) is at ${PATH}`);
    expect(stdout).toContain(`${MARK} the line above, 300 times in a row`);
    expect(stdout).toContain(' ↓ tests/logs.test.ts > parser > skipped one');
    expect(Buffer.byteLength(stdout) + 512).toBeLessThanOrEqual(Buffer.byteLength(ran.text));
    expect(h.lines()).toEqual([
      { event: 'output', parser: 'vitest', stage: 'started', run_id: expect.any(String) },
      { event: 'output', parser: 'vitest', applied: true, runs: 1, run_id: expect.any(String) },
    ]);
    expect(h.lines()[0]?.['run_id']).toBe(h.lines()[1]?.['run_id']);
  });

  it('keeps the context the host resolved with', async () => {
    const hook = (await hooksFor({ enabled: true })).get('tool.call')!;
    const r = (await hook(fakeHost().$, CALL, nextOf({ ...persisted(), context: ['managed review note'] }).next)) as { context?: string[] };
    expect(r.context).toEqual(['managed review note']);
  });

  it('hands every other result on as it came, the same object, reading nothing it need not', async () => {
    const hook = (await hooksFor({ enabled: true })).get('tool.call')!;
    const cases: Array<[unknown, string | undefined, boolean]> = [
      [{ deny: 'no' }, 'not_completed', false],
      [{ ref: 7, isError: true, result: 'Exit code 1', text: 'Exit code 1\n FAIL tests/a.test.ts' }, 'not_completed', false],
      [persisted({ interrupted: true }), 'not_plain', false],
      [persisted({ isImage: true }), 'not_plain', false],
      [persisted({ backgroundTaskId: 'b1' }), 'not_plain', false],
      [persisted({ returnCodeInterpretation: 'No matches found' }), 'not_plain', false],
      [persisted({ stderr: 'sandbox: write denied' }), 'not_plain', false],
      [persisted({ structuredContent: [{ type: 'image' }] }), 'not_plain', false],
      [persisted({ ghRateLimitHint: 'rate limited' }), 'not_plain', false],
      [persisted({ persistedOutputPath: undefined, persistedOutputSize: undefined }, FIXTURE), 'inline', false],
      [persisted({ persistedOutputSize: undefined }), 'inline', false],
      [persisted({ persistedOutputSize: 1024 * 1024 + 1 }), 'too_large', false],
      [persisted({ persistedOutputSize: SIZE - 1 }), 'size_mismatch', true],
      [persisted({ persistedOutputPath: '/gone.txt' }), 'error', true],
      // The fold is real but not 512 bytes under what the model would have read.
      [persisted({}, 'x'.repeat(1400)), 'not_smaller', true],
    ];
    for (const [ran, skipped, read] of cases) {
      const h = fakeHost();
      const { next, calls } = nextOf(ran);
      expect(await hook(h.$, CALL, next)).toBe(ran);
      expect(calls).toHaveLength(1);
      expect(h.reads.length > 0).toBe(read);
      expect(h.fetched).toEqual([]);
      expect(h.lines()).toEqual([
        { event: 'output', parser: 'vitest', stage: 'started', run_id: expect.any(String) },
        { event: 'output', parser: 'vitest', skipped, run_id: expect.any(String) },
      ]);
    }
  });

  it('a log that is not a passing Vitest run is read once and left alone', async () => {
    const hook = (await hooksFor({ enabled: true })).get('tool.call')!;
    const failing = FIXTURE.replace(' Test Files  1 passed (1)', ' Test Files  1 failed (1)');
    const h = fakeHost({ [PATH]: failing });
    const ran = persisted({ persistedOutputSize: Buffer.byteLength(failing) });
    expect(await hook(h.$, CALL, nextOf(ran).next)).toBe(ran);
    expect(h.lines()).toEqual([
      { event: 'output', parser: 'vitest', stage: 'started', run_id: expect.any(String) },
      { event: 'output', parser: 'vitest', skipped: 'format', run_id: expect.any(String) },
    ]);
  });

  it('any other command is not looked at: no read, no log', async () => {
    const hook = (await hooksFor({ enabled: true })).get('tool.call')!;
    for (const command of ['npm test', 'npx vitest run 2>&1 | tail -40', 'cat /work/vt/out.log']) {
      const h = fakeHost();
      const ran = persisted();
      expect(await hook(h.$, { ...CALL, command }, nextOf(ran).next)).toBe(ran);
      expect(h.reads).toEqual([]);
      expect(h.logs).toEqual([]);
    }
  });

  it('an error or cancellation of the call itself passes up, and the call is not run again', async () => {
    const hook = (await hooksFor({ enabled: true })).get('tool.call')!;
    let calls = 0;
    const next = async () => {
      calls++;
      throw new Error('aborted');
    };
    await expect(hook(fakeHost().$, CALL, next)).rejects.toThrow('aborted');
    expect(calls).toBe(1);
  });

  it('a throwing log does not stand between the host and its result', async () => {
    const hook = (await hooksFor({ enabled: true })).get('tool.call')!;
    const h = fakeHost();
    const bad = { ...h.$, ui: { log: () => { throw new Error('log down'); } } };
    const r = (await hook(bad, CALL, nextOf(persisted()).next)) as { result: { stdout: string } };
    expect(r.result.stdout.startsWith(MARK)).toBe(true);
  });
});
