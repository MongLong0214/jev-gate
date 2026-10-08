import { describe, expect, it } from 'vitest';

import { JEV_MODEL } from '../../mods/router/hooks/client.ts';
import { answering, CLEAR, choice, drain, FAKE_KEY, score } from './fake-engine.ts';

/**
 * register.ts types itself against the host's `claude-code` declarations, which this Node typecheck does not load, so
 * it is imported by URL and driven through the structural shape below. `claude plugin test mods/router` covers the
 * same module inside the host, where options cannot be set and only the default (off) path runs.
 */
type Hook = (...args: unknown[]) => unknown;
type RegisterFn = (on: (name: string, hook: Hook) => void, options: Record<string, unknown>) => unknown;
const load = async (): Promise<RegisterFn> =>
  ((await import(/* @vite-ignore */ new URL('../../mods/router/hooks/register.ts', import.meta.url).href)) as { register: RegisterFn }).register;

interface World {
  env?: Record<string, string>;
  files?: Record<string, string>;
  settings?: Record<string, unknown>;
  version?: { version: string; base?: string };
}

const fakeHost = (world: World = {}) => {
  const envReads: string[] = [];
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const logs: string[] = [];
  // The full version differs from its release base, so reading the wrong field cannot pass.
  const version = world.version ?? { version: '2.1.293+build.7f3c', base: '2.1.293' };
  const $ = {
    fs: {
      exists: async (path: string) => path in (world.files ?? {}),
      read: async (path: string) => {
        const text = world.files?.[path];
        if (text === undefined) throw new Error('ENOENT');
        return text;
      },
      stat: async (path: string) => {
        const text = world.files?.[path];
        if (text !== undefined) return { kind: 'file', isLink: false, size: text.length };
        if (Object.keys(world.files ?? {}).some(file => file.startsWith(path + '/'))) return { kind: 'dir', isLink: false, size: 0 };
        throw new Error('ENOENT');
      },
    },
    env: {
      get: async (name: string) => {
        envReads.push(name);
        return world.env?.[name];
      },
    },
    settings: { read: async () => ({ effortLevel: 'high', ...world.settings }) },
    session: { version: async () => version },
    ui: { log: (text: string) => logs.push(text) },
    clock: { sleep: (_ms: number, o?: { signal?: AbortSignal }) => new Promise<void>((_r, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) },
    http: {
      fetch: async (url: string, init: { headers: Record<string, string>; body: string }) => {
        requests.push({ url, headers: init.headers });
        const { questions } = JSON.parse(init.body) as { questions: Record<string, { type: string; criteria: Record<string, string> | string[] }> };
        return answering({ ...CLEAR, tier: ['fast', .95], effort: ['low', .95] })({ url, headers: init.headers, state: {}, questions });
      },
    },
  };
  return { $, envReads, requests, logs };
};

const registered = async (options: Record<string, unknown>) => {
  const register = await load();
  const hooks = new Map<string, Hook>();
  register((name, hook) => {
    if (hooks.has(name)) throw new Error(`registered twice: ${name}`);
    hooks.set(name, hook);
  }, options);
  return hooks;
};

const withSignal = <F extends (...a: never[]) => unknown>(f: F): F & { signal: AbortSignal } => Object.assign(f, { signal: new AbortController().signal });

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'List the files under src/ that import ./config.',
  description: 'list config imports',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
};
const OFFER = { agent: 'general-purpose', description: 'General agent', source: 'built-in', provider: { plugin: 'engine', tier: 'core' } };

/** Offers the built-in, then spawns it; returns the model the engine was asked for. */
const spawnThrough = async (hooks: Map<string, Hook>, host: ReturnType<typeof fakeHost>): Promise<string | undefined> => {
  await hooks.get('agent.offer')?.(host.$, OFFER, withSignal(async (e: unknown) => ({ isOffered: true, e })));
  let asked: string | undefined;
  await hooks.get('agent.spawn')?.(
    host.$,
    SPAWN,
    withSignal(async (e: { model?: string }) => {
      asked = e.model;
      return { model: e.model ?? 'claude-opus-5-5' };
    }),
  );
  return asked;
};

describe('register', () => {
  it('registers nothing when off, or when every switch is off', async () => {
    expect([...(await registered({ enabled: false })).keys()]).toEqual([]);
    expect([...(await registered({ enabled: true, routeSubagentModel: false, routeSubagentEffort: false, routeMainEffort: false, routeMainModel: false })).keys()]).toEqual([]);
  });

  it('registers only a diagnostic for an option it cannot read, naming the field and never the value', async () => {
    const hooks = await registered({ enabled: true, timeoutMs: 'soon' });
    expect([...hooks.keys()]).toEqual(['session.start']);
    const host = fakeHost();
    const e = { cwd: '/w' };
    const out = await hooks.get('session.start')?.(host.$, e, withSignal(async (x: unknown) => ({ passed: x })));
    expect(out).toEqual({ passed: e });
    expect(host.logs).toEqual(['jev-router {"event":"router","disabled":"invalid_option","field":"timeoutMs"}']);

    // A logger that throws changes nothing: the event still goes on.
    const broken = fakeHost();
    broken.$.ui.log = () => {
      throw new Error('log unavailable');
    };
    expect(await hooks.get('session.start')?.(broken.$, e, withSignal(async (x: unknown) => ({ passed: x })))).toEqual({ passed: e });
  });

  it('registers the root hooks and the spawn hooks their switches ask for', async () => {
    expect([...(await registered({ enabled: true })).keys()].sort()).toEqual(['agent.offer', 'agent.spawn', 'session.end', 'turn.complete', 'turn.start', 'turn.step']);
    // A subagent's effort is set on its own loop's steps, so turn.step stays without the root switches.
    expect([...(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false })).keys()].sort()).toEqual(['agent.offer', 'agent.spawn', 'session.end', 'turn.complete', 'turn.step']);
    expect([...(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false, routeSubagentEffort: false })).keys()].sort()).toEqual(['agent.offer', 'agent.spawn', 'session.end', 'turn.complete', 'turn.step']);
    expect([...(await registered({ enabled: true, routeSubagentModel: false })).keys()].sort()).toEqual(['agent.offer', 'agent.spawn', 'session.end', 'turn.complete', 'turn.start', 'turn.step']);
    expect([...(await registered({ enabled: true, routeSubagentModel: false, routeSubagentEffort: false })).keys()].sort()).toEqual(['session.end', 'turn.complete', 'turn.start', 'turn.step']);
  });

  it.each([false, true])('reads the common frontier switch through Function Hooks: %s', async enabled => {
    const host = fakeHost({ env: { HOME:'/owner', TYPESAFE_API_KEY:FAKE_KEY }, files:{'/owner/.config/jev-gate/config.json':JSON.stringify({version:5,frontierEnabled:enabled})} });
    let offered=false;
    const fetch=host.$.http.fetch;
    host.$.http.fetch=async (url, init) => {
      offered=init.body.includes('claude-fable-5-1');
      return fetch(url,init);
    };
    await spawnThrough(await registered({enabled:true,allowFable:!enabled}),host);
    expect(offered).toBe(enabled);
  });

  it('routes a spawn through the host adapter with the environment key, sent only in the header', async () => {
    const host = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY } });
    const asked = await spawnThrough(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false }), host);
    expect(asked).toBe('claude-haiku-5-5');
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]?.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);
    expect(host.logs.join('\n')).not.toContain(FAKE_KEY);
    expect(host.logs.every((l) => l.startsWith('jev-router '))).toBe(true);
  });
  it.each([
    ['2.1.293', {}, 'claude-haiku-5-5'],
    ['2.1.293', { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5' }, 'claude-haiku-5-5'],
  ])('resolves the native Haiku baseline for host %s and preserves an explicit alias override', async (base, overrides, expected) => {
    const host = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY, ...overrides }, version: { version: base, base } });
    const offered: string[][] = [];
    host.$.http.fetch = async (_url, init) => {
      const req = JSON.parse(init.body);
      offered.push(Object.keys(req.questions.model.criteria));
      return { status: 200, text: JSON.stringify({ model: JEV_MODEL, answers: Object.fromEntries(Object.entries(req.questions).map(([name, q]) => [name, (q as { type: string }).type === 'choice' ? choice(Object.keys((q as { criteria: object }).criteria), [name === 'model' ? '__keep__' : name === 'control' ? 'task_clear' : 'ordinary', .99]) : { type: 'score', probabilities: { 0: 0, 1: 0, 2: 1 } }])) }) };
    };
    const hooks = await registered({ enabled: true, routeMainModel: false, routeMainEffort: false, routeSubagentEffort: false });
    let calls = 0;
    await hooks.get('agent.spawn')?.(host.$, { ...SPAWN, model: 'haiku' }, withSignal(async (e: { model?: string }) => { calls++; expect(e.model).toBe('haiku'); return { model: expected }; }));
    expect(calls).toBe(1);
    expect(offered).toHaveLength(1);
    expect(offered[0]).not.toContain(expected);
    expect(offered[0]?.includes('claude-haiku-5-5')).toBe(base === '2.1.293' && expected !== 'claude-haiku-5-5');
    expect(host.logs.join('\n')).not.toContain('"confirmation":"mismatch"');
  });
  it.each([
    ['2.1.292', {}],
    ['2.1.293', { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5' }],
  ])('does not start an outdated native Haiku fallback on %s', async (base, overrides) => {
    const host = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY, ...overrides }, version: { version: base, base } });
    host.$.http.fetch = async (_url, init) => {
      const req = JSON.parse(init.body);
      return { status: 200, text: JSON.stringify({ model: JEV_MODEL, answers: Object.fromEntries(Object.entries(req.questions).map(([name, q]) => [name, choice(Object.keys((q as { criteria: object }).criteria), [name === 'model' ? '__keep__' : name === 'control' ? 'task_clear' : 'ordinary', .99])])) }) };
    };
    const hooks = await registered({ enabled: true, routeMainModel: false, routeMainEffort: false, routeSubagentEffort: false });
    let calls = 0;
    const out = await hooks.get('agent.spawn')?.(host.$, { ...SPAWN, model: 'haiku' }, withSignal(async () => { calls++; return { model: 'claude-haiku-4-5' }; }));
    expect(calls).toBe(0);
    expect(out).toMatchObject({ deny: expect.any(String) });
  });

  it('routes with the shared saved key without a shell export and preserves invalid explicit input', async () => {
    for (const [env, path] of [
      [{ HOME: '/owner' }, '/owner/.config/jev-gate/auth/credentials.json'],
      [{ HOME: '/owner', XDG_CONFIG_HOME: '/private-config' }, '/private-config/jev-gate/auth/credentials.json'],
    ] as const) {
      const files = { [path]: JSON.stringify({ version: 1, apiKey: FAKE_KEY }) };
      const host = fakeHost({ env, files });
      expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false }), host)).toBe('claude-haiku-5-5');
      expect(host.requests[0]?.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);
      expect(host.logs.join('\n')).not.toContain(FAKE_KEY);
      const invalid = fakeHost({ env: { ...env, TYPESAFE_API_KEY: 'invalid key' }, files });
      expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false }), invalid)).toBeUndefined();
      expect(invalid.requests).toHaveLength(0);
    }
  });

  it('never starts a subagent of its own: `$.agent` is never read, and each spawn and step calls next once', async () => {
    const host = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY } });
    const nouns = new Set<string>();
    const $ = new Proxy(host.$, { get: (t, k) => (nouns.add(String(k)), Reflect.get(t, k)) });
    const hooks = await registered({ enabled: true });
    await hooks.get('agent.offer')?.($, OFFER, withSignal(async (e: unknown) => ({ isOffered: true, e })));
    let spawns = 0;
    await hooks.get('agent.spawn')?.($, SPAWN, withSignal(async (e: { model?: string }) => (spawns++, { model: e.model ?? 'claude-opus-5-5', agentId: 'a1' })));
    let steps = 0;
    const stepNext = withSignal(async function* (e: { model: string }) {
      steps++;
      yield 'chunk';
      return { usage: { model: e.model } };
    });
    const gen = hooks.get('turn.step')?.($, { turnId: 'c1', index: 0, model: 'claude-haiku-5-5', agentId: 'a1', messageCount: 1 }, stepNext) as AsyncGenerator<string, unknown>;
    expect((await drain(gen)).chunks).toEqual(['chunk']);
    expect([spawns, steps]).toEqual([1, 1]);
    expect(nouns.has('agent')).toBe(false);
  });

  it('prefers a valid explicit key, and never falls back from an invalid one to the environment', async () => {
    const explicit = 'sk-router-explicit-testonlynotakey';
    const a = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY } });
    await spawnThrough(await registered({ enabled: true, routeMainEffort: false, typesafeApiKey: explicit }), a);
    expect(a.requests[0]?.headers['authorization']).toBe(`Bearer ${explicit}`);
    expect(a.envReads).not.toContain('TYPESAFE_API_KEY');

    const b = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY } });
    expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false, typesafeApiKey: 'has a space in it' }), b)).toBeUndefined();
    expect(b.requests).toHaveLength(0);
  });

  it('keeps model pins independent from effort, and resolves aliases without treating them as pins', async () => {
    for (const name of ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE']) {
      const host = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY, [name]: 'claude-sonnet-5-5' } });
      expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false, routeSubagentEffort: false }), host)).toBeUndefined();
      expect(host.requests).toHaveLength(0);
      const effort = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY, [name]: 'claude-sonnet-5-5' } });
      expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false }), effort)).toBeUndefined();
      expect(effort.requests).toHaveLength(1);
      expect(effort.logs.join('\n')).toContain('"effort_asked":true');
    }
    for (const name of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
      const host = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY, [name]: 'claude-sonnet-5-5' } });
      expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false }), host)).toBe('claude-haiku-5-5');
      expect(host.requests).toHaveLength(1);
      expect(host.logs.join('\n')).toContain('"model_asked":true');
    }
  });

  it('reads a malformed availableModels as allowing nothing, and a development build or one without a release base as unverified', async () => {
    const malformed = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY }, settings: { availableModels: 'haiku' } });
    expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false, routeSubagentEffort: false }), malformed)).toBeUndefined();
    // Nothing the list allows could be applied, so nothing is asked.
    expect(malformed.logs.join('\n')).toContain('"no_alternative"');
    expect(malformed.requests).toHaveLength(0);

    const allowed = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY }, settings: { availableModels: ['haiku', 'sonnet', 'opus'] } });
    expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false }), allowed)).toBe('claude-haiku-5-5');

    for (const version of [{ version: '2.1.282-dev.20260920', base: '2.1.282-dev' }, { version: 'local' }]) {
      const host = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY }, version });
      expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false, routeSubagentEffort: false }), host), version.version).toBeUndefined();
      expect(host.logs.join('\n')).toContain('"host_unverified"');
      expect(host.requests).toHaveLength(0);
    }
  });
});
