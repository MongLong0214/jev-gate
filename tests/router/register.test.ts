import { describe, expect, it } from 'vitest';

import { JEV_MODEL } from '../../mods/router/hooks/client.ts';
import { choice, FAKE_KEY } from './fake-engine.ts';

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
  settings?: Record<string, unknown>;
  version?: { version: string; base?: string };
}

const fakeHost = (world: World = {}) => {
  const envReads: string[] = [];
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const logs: string[] = [];
  // The full version differs from its release base, so reading the wrong field cannot pass.
  const version = world.version ?? { version: '2.1.282+build.7f3c', base: '2.1.282' };
  const $ = {
    env: {
      get: async (name: string) => {
        envReads.push(name);
        return world.env?.[name];
      },
    },
    settings: { read: async () => world.settings ?? {} },
    session: { version: async () => version },
    ui: { log: (text: string) => logs.push(text) },
    clock: { sleep: (_ms: number, o?: { signal?: AbortSignal }) => new Promise<void>((_r, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) },
    http: {
      fetch: async (url: string, init: { headers: Record<string, string>; body: string }) => {
        requests.push({ url, headers: init.headers });
        const { questions } = JSON.parse(init.body) as { questions: Record<string, { criteria: Record<string, string> }> };
        const picks: Record<string, [string, number]> = { control: ['task_clear', 0.97], action_risk: ['ordinary', 0.97], tier: ['fast', 0.95] };
        const answers = Object.fromEntries(Object.entries(questions).map(([n, q]) => [n, choice(Object.keys(q.criteria), picks[n] ?? ['preserve', 0.9])]));
        return { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: JEV_MODEL, answers, usage: { input_tokens: 800, output_tokens: 20 } }) };
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
    expect([...(await registered({})).keys()]).toEqual([]);
    expect([...(await registered({ enabled: true, routeSubagentModel: false, routeMainEffort: false, routeMainModel: false })).keys()]).toEqual([]);
  });

  it('registers only a diagnostic for an option it cannot read, naming the field and never the value', async () => {
    const hooks = await registered({ enabled: true, timeoutMs: 'soon' });
    expect([...hooks.keys()]).toEqual(['session.start']);
    const host = fakeHost();
    const e = { cwd: '/w' };
    const out = await hooks.get('session.start')?.(host.$, e, withSignal(async (x: unknown) => ({ passed: x })));
    expect(out).toEqual({ passed: e });
    expect(host.logs).toEqual(['jev-router {"event":"router","disabled":"invalid_option","field":"timeoutMs"}']);
  });

  it('registers the root hooks and the spawn hooks their switches ask for', async () => {
    expect([...(await registered({ enabled: true })).keys()].sort()).toEqual(['agent.offer', 'agent.spawn', 'session.end', 'turn.complete', 'turn.start', 'turn.step']);
    expect([...(await registered({ enabled: true, routeMainEffort: false })).keys()].sort()).toEqual(['agent.offer', 'agent.spawn', 'session.end']);
    expect([...(await registered({ enabled: true, routeSubagentModel: false })).keys()].sort()).toEqual(['session.end', 'turn.complete', 'turn.start', 'turn.step']);
  });

  it('routes a spawn through the host adapter with the environment key, sent only in the header', async () => {
    const host = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY } });
    const asked = await spawnThrough(await registered({ enabled: true, routeMainEffort: false }), host);
    expect(asked).toBe('haiku');
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]?.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);
    expect(host.logs.join('\n')).not.toContain(FAKE_KEY);
    expect(host.logs.every((l) => l.startsWith('jev-router '))).toBe(true);
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

  it('stays native when the environment pins the child model or remaps an alias', async () => {
    for (const name of ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
      const host = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY, [name]: 'claude-sonnet-5' } });
      expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false }), host), name).toBeUndefined();
      expect(host.requests, name).toHaveLength(0);
    }
  });

  it('reads a malformed availableModels as allowing nothing, and a development build or one without a release base as unverified', async () => {
    const malformed = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY }, settings: { availableModels: 'haiku' } });
    expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false }), malformed)).toBeUndefined();
    expect(malformed.logs.join('\n')).toContain('"target_not_allowed"');

    const allowed = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY }, settings: { availableModels: ['haiku', 'sonnet', 'opus'] } });
    expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false }), allowed)).toBe('haiku');

    for (const version of [{ version: '2.1.282-dev.20260920', base: '2.1.282-dev' }, { version: 'local' }]) {
      const host = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY }, version });
      expect(await spawnThrough(await registered({ enabled: true, routeMainEffort: false }), host), version.version).toBeUndefined();
      expect(host.logs.join('\n')).toContain('"host_unverified"');
      expect(host.requests).toHaveLength(0);
    }
  });
});
