import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JEV_MODEL } from '../../mods/router/hooks/client.ts';
import { dispatchMarker } from '../../src/claude-background.js';
import { newGeneration, readJob, reserve, updateJob } from '../../src/job.js';
import { OWNED_AGENTS } from '../../src/types.js';
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

const TRACE_DIR = '/trace';
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
      write: async (_path: string, text: string) => {
        // The Mod's records reach the trace as files; each one is read back as the line the Mod emitted.
        const { host: _host, session_id: _session, phase, version: _version, invocation_id: _id, written_at: _at, ...fields } = JSON.parse(text) as Record<string, unknown>;
        logs.push(`jev-${String(phase).slice(4)} ${JSON.stringify(fields)}`);
      },
      stat: async (path: string) => {
        if (path === TRACE_DIR) return { kind: 'dir', isLink: false, size: 0 };
        const text = world.files?.[path];
        if (text !== undefined) return { kind: 'file', isLink: false, size: text.length };
        if (Object.keys(world.files ?? {}).some(file => file.startsWith(path + '/'))) return { kind: 'dir', isLink: false, size: 0 };
        throw new Error('ENOENT');
      },
    },
    env: {
      get: async (name: string) => {
        envReads.push(name);
        return world.env?.[name] ?? { HOME: '/home/test', JEV_GATE_TRACE_DIR: TRACE_DIR }[name];
      },
    },
    settings: { read: async () => ({ effortLevel: 'high', ...world.settings }) },
    session: { id: async () => 'session', version: async () => version },
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

  it('registers nothing for an option it cannot read', async () => {
    expect([...(await registered({ enabled: true, timeoutMs: 'soon' })).keys()]).toEqual([]);
  });

  it('registers the root hooks and the spawn hooks their switches ask for', async () => {
    expect([...(await registered({ enabled: true })).keys()].sort()).toEqual(['agent.offer', 'agent.spawn', 'session.compact', 'session.end', 'turn.complete', 'turn.start', 'turn.step']);
    // A subagent's effort is set on its own loop's steps, so turn.step stays without the root switches.
    expect([...(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false })).keys()].sort()).toEqual(['agent.offer', 'agent.spawn', 'session.compact', 'session.end', 'turn.complete', 'turn.step']);
    expect([...(await registered({ enabled: true, routeMainEffort: false, routeMainModel: false, routeSubagentEffort: false })).keys()].sort()).toEqual(['agent.offer', 'agent.spawn', 'session.compact', 'session.end', 'turn.complete', 'turn.step']);
    expect([...(await registered({ enabled: true, routeSubagentModel: false })).keys()].sort()).toEqual(['agent.offer', 'agent.spawn', 'session.compact', 'session.end', 'turn.complete', 'turn.start', 'turn.step']);
    expect([...(await registered({ enabled: true, routeSubagentModel: false, routeSubagentEffort: false })).keys()].sort()).toEqual(['session.compact', 'session.end', 'turn.complete', 'turn.start', 'turn.step']);
  });

  it.each([false, true])('reads the common frontier switch through Function Hooks: %s', async enabled => {
    const host = fakeHost({ env: { HOME:'/owner', TYPESAFE_API_KEY:FAKE_KEY }, files:{'/owner/.config/jev-gate/config.json':JSON.stringify({version:5,frontierEnabled:enabled})} });
    let offered=false;
    const fetch=host.$.http.fetch;
    host.$.http.fetch=async (url, init) => {
      offered=init.body.includes('"open_problem"');
      return fetch(url,init);
    };
    await spawnThrough(await registered({enabled:true,allowFable:!enabled}),host);
    expect(offered).toBe(enabled);
  });

  it('reads a custom agent\'s model from the project file first, then the user agents directory, never for a plugin agent', async () => {
    const run = async (subagentType: string, files: Record<string, string>) => {
      const host = fakeHost({ env: { TYPESAFE_API_KEY: FAKE_KEY, CLAUDE_CONFIG_DIR: '/cfg' }, files });
      Object.assign(host.$.session, { root: async () => '/proj' });
      const read: string[] = [];
      const exists = host.$.fs.exists;
      host.$.fs.exists = async (path: string) => { read.push(path); return exists(path); };
      let asked: string | undefined;
      const hooks = await registered({ enabled: true, routeMainEffort: false, routeMainModel: false });
      await hooks.get('agent.spawn')?.(host.$, { ...SPAWN, subagentType, provider: { plugin: 'user', tier: 'local' } }, withSignal(async (e: { model?: string }) => { asked = e.model; return { model: e.model ?? 'claude-opus-5-5' }; }));
      return { asked, read: read.filter(r => r.includes('/agents/')), logs: host.logs.join('\n') };
    };
    const user = await run('guardian', { '/cfg/agents/guardian.md': '---\nname: guardian\nmodel: opus\n---\nReview.\n' });
    expect(user.read).toEqual(['/proj/.claude/agents/guardian.md', '/cfg/agents/guardian.md']);
    expect(user.logs).toContain('"from":"claude-opus-5-5"');
    expect(user.asked).toBe('claude-haiku-5-5');
    const project = await run('guardian', { '/proj/.claude/agents/guardian.md': '---\nmodel: haiku\n---\n', '/cfg/agents/guardian.md': '---\nmodel: opus\n---\n' });
    expect(project.read).toEqual(['/proj/.claude/agents/guardian.md']);
    expect(project.logs).toContain('"from":"claude-haiku-5-5"');
    expect((await run('someone:guardian', {})).read).toEqual([]);
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
      offered.push(Object.keys(req.questions.capability.criteria));
      return { status: 200, text: JSON.stringify({ model: JEV_MODEL, answers: Object.fromEntries(Object.entries(req.questions).map(([name, q]) => [name, (q as { type: string }).type === 'choice' ? choice(Object.keys((q as { criteria: object }).criteria), [name === 'capability' ? 'mechanical' : name === 'control' ? 'task_clear' : 'ordinary', .99]) : { type: 'score', probabilities: { 0: 0, 1: 0, 2: 1 } }])) }) };
    };
    const hooks = await registered({ enabled: true, routeMainModel: false, routeMainEffort: false, routeSubagentEffort: false });
    let calls = 0;
    await hooks.get('agent.spawn')?.(host.$, { ...SPAWN, model: 'haiku' }, withSignal(async (e: { model?: string }) => { calls++; expect(e.model).toBe('haiku'); return { model: expected }; }));
    expect(calls).toBe(1);
    expect(offered).toHaveLength(1);
    // The baseline serves its own role, so the resolved native Haiku is the fast role's one model.
    expect(host.logs.join('\n')).toContain(`{"role":"fast","option":"mechanical","model":"${expected}"}`);
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

describe('owned dispatch through the packaged policy process (#211)', () => {
  const TOOL = 'toolu_owned'; const TOKEN = '0b1f5c2e-8a4d-4f6e-9c3b-2d7e1a5f4c8b';
  const NO_MODEL = 'No eligible automatic child model. Continue in the main session; no child started.';
  const PROTECTED = 'No child started. Ownership cleanup pending; reservations remain protected.';
  // As the command hook leaves it at background_dispatch: the alias in Agent.model, the marker ending the prompt.
  const OWNED = { ...SPAWN, tool_use_id: TOOL, prompt: 'Complete the outcome.' + dispatchMarker(TOKEN), description: 'outcome', subagentType: 'jev-gate:worker-fast', provider: { plugin: 'jev-gate', tier: 'user' }, model: 'haiku' as string | undefined, background: true };
  let dir = ''; let root = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jev-owned-spawn-')); root = join(dir, 'plugin'); mkdirSync(root);
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const repo = join(__dirname, '../..');
    const build = spawnSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', join(repo, 'tsconfig.json'), '--outDir', join(root, 'dist')], { encoding: 'utf8' });
    if (build.status !== 0) throw new Error(build.stdout + build.stderr);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  type Failure = 'timeout' | 'exit' | 'malformed' | { deny: string } | undefined;
  /** One Gate B reservation and the real policy entrypoint behind `$.process.run`; `fail` replaces one answer. */
  const dispatch = async (o: { event?: typeof OWNED; agent?: string; pair?: string; options?: Record<string, unknown>; env?: Record<string, string>; files?: Record<string, string>; fail?: (eligible: boolean) => Failure; delayMs?: number } = {}) => {
    const agent = o.agent ?? 'jev-gate:worker-fast'; const state = mkdtempSync(join(dir, 'state-'));
    const env = { PATH: process.env['PATH'] ?? '', HOME: state, JEV_GATE_STATE_DIR: state };
    updateJob(env, 'root', () => {
      const s = newGeneration(null, 'root', 'prompt', 'orchestrated').state;
      const current = reserve(s.current, TOOL, { role: 'worker', taskId: null, contractHash: null, rev: null, tier: OWNED_AGENTS[agent]!.tier, attempt: 1, deliverables: [] });
      return { ...s, current: { ...current, background_job: true, active: { [TOOL]: { ...current.active[TOOL]!, allocation_pair: { model: o.pair ?? 'claude-haiku-5-5', effort_edit: { kind: 'set', value: 'medium' } },
        background_execution: { token: TOKEN, agent_id: null, subagent_type: agent, resolved_model: null } } } } };
    });
    const host = fakeHost({ env: { HOME: '/owner', ...o.env }, files: { [root + '/dist/dispatch-policy.js']: '', ...o.files }, version: { version: '2.1.296', base: '2.1.296' } });
    const runs: boolean[] = [];
    Object.assign(host.$.session, { id: async () => 'root' });
    Object.assign(host.$, { plugin: { root }, process: { run: async (argv: string[]) => {
      const eligible = argv[7] === 'true'; runs.push(eligible);
      const failure = o.fail?.(eligible);
      if (failure === 'timeout') throw new Error('still running at its timeout');
      if (failure === 'exit') return { exitCode: 1, stdout: '', stderr: 'failed' };
      if (failure === 'malformed') return { exitCode: 0, stdout: '{"model":', stderr: '' };
      if (o.delayMs) await new Promise(r => setTimeout(r, o.delayMs));
      if (failure) return { exitCode: 0, stdout: JSON.stringify(failure), stderr: '' };
      const r = spawnSync(process.execPath, argv.slice(1), { env, encoding: 'utf8' });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    } } });
    const hooks = await registered({ enabled: true, routeMainEffort: false, routeMainModel: false, timeoutMs: 30_000, ...o.options });
    const calls: Array<string | undefined> = [];
    const out = await hooks.get('agent.spawn')?.(host.$, o.event ?? { ...OWNED, subagentType: agent }, withSignal(async (e: { model?: string }) => (calls.push(e.model), { model: e.model ?? 'claude-opus-5-5', agentId: 'child' })));
    const job = readJob(env, 'root'); const current = job.ok ? job.value?.current : undefined;
    const denials = host.logs.filter(l => l.includes('"spawn_denied"')).map(l => JSON.parse(l.slice('jev-router '.length)) as unknown);
    return { out, calls, runs, current, kept: current?.active[TOOL]?.background_execution?.token === TOKEN, denials, logs: host.logs.join('\n') };
  };
  const denial = (reason: string, type = 'jev-gate:worker-fast') => [{ event: 'spawn_denied', tool_use_id: TOOL, type, reason }];

  it('delivers an eligible owned worker-fast dispatch whose model Gate B kept, with its allocated pair', async () => {
    const r = await dispatch();
    expect(r.out).toEqual({ model: 'claude-haiku-5-5', agentId: 'child' });
    expect([r.calls, r.runs, r.denials, r.kept]).toEqual([['claude-haiku-5-5'], [true], [], true]);
  });

  it.each(['timeout', 'exit', 'malformed'] as const)('denies on a policy %s, releasing the unstarted reservation once and recording no completion', async kind => {
    const r = await dispatch({ fail: eligible => eligible ? kind : undefined });
    expect(r.out).toEqual({ deny: 'Dispatch ownership unavailable; no child started.' });
    expect([r.calls, r.runs, r.denials, r.kept]).toEqual([[], [true, false], denial('policy_unavailable'), false]);
    expect(r.current).toMatchObject({ root_fallback: true, receipts: [] });
    expect(r.logs).not.toContain('Complete the outcome');
  });

  it.each([
    ['past the spawn budget', { options: { timeoutMs: 50 }, delayMs: 80 }],
    ['over a restricted parent baseline', { event: { ...OWNED, model: undefined, parentModel: 'claude-fable-5-1' } }],
  ])('keeps a concrete policy denial %s', async (_, o) => {
    const r = await dispatch({ ...o, fail: eligible => eligible ? { deny: PROTECTED } : undefined });
    expect(r.out).toEqual({ deny: PROTECTED });
    expect([r.calls, r.runs, r.denials, r.kept]).toEqual([[], [true], denial('policy_denied'), true]);
  });

  it.each([
    ['answers', undefined, NO_MODEL, false],
    // 0.8.14 let this throw past its cleanup and named it "could not be verified"; the reservation stays protected.
    ['times out', 'timeout' as const, 'Automatic child unavailable; continue in the main session.', true],
  ])('keeps a user subagent pin and releases once when the cleanup %s', async (_, failure, deny, kept) => {
    const r = await dispatch({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5' }, fail: eligible => eligible ? undefined : failure });
    expect(r.out).toEqual({ deny });
    expect([r.calls, r.runs, r.denials, r.kept]).toEqual([[], [true, false], denial('subagent_model_pinned'), kept]);
  });

  it.each([false, true])('keeps the frontier opt-in for an owned frontier pair: %s', async enabled => {
    const r = await dispatch({ agent: 'jev-gate:worker-frontier', pair: 'claude-fable-5-1', event: { ...OWNED, subagentType: 'jev-gate:worker-frontier', model: undefined },
      files: { '/owner/.config/jev-gate/config.json': JSON.stringify({ version: 5, frontierEnabled: enabled }) } });
    expect(r.out).toEqual(enabled ? { model: 'claude-fable-5-1', agentId: 'child' } : { deny: NO_MODEL });
    expect([r.calls, r.runs, r.denials, r.kept]).toEqual(enabled ? [['claude-fable-5-1'], [true], [], true] : [[], [true], denial('policy_denied', 'jev-gate:worker-frontier'), false]);
  });
});
