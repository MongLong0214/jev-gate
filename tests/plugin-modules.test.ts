import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * hooks/register.ts types itself against the host's `claude-code` declarations, which this Node typecheck does not
 * load, so it is imported by URL and driven through the structural shape below (as tests/compact/register.test.ts).
 */
type Hook = (...args: unknown[]) => unknown;
type On = (name: string, ...rest: unknown[]) => void;
type Module = { register: (on: On, options: Record<string, unknown>) => unknown; OPTION_NAMES: Record<string, Record<string, string>> };
const load = async (): Promise<Module> => (await import(/* @vite-ignore */ new URL('../hooks/register.ts', import.meta.url).href)) as Module;

const root = join(import.meta.dirname, '..');
const readJson = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8')) as { userConfig?: Record<string, { title: string }> };

// Like the host: a second registration of one event and matcher fails the load.
const registered = async (options: Record<string, unknown>) => {
  const hooks = new Map<string, Hook>();
  (await load()).register((name, ...rest) => {
    const key = rest.length > 1 ? `${name} ${JSON.stringify(rest[0])}` : name;
    if (hooks.has(key)) throw new Error(`${key} registered twice`);
    hooks.set(key, rest[rest.length - 1] as Hook);
  }, options);
  return hooks;
};

describe('the one plugin’s hooks module', () => {
  it('offers every Mod option under its plugin name, with the Mod’s type and default', async () => {
    const { OPTION_NAMES } = await load();
    const expected: Record<string, unknown> = {};
    const label = { compact: 'Compact', output: 'Output', router: 'Router' } as const;
    for (const mod of ['compact', 'output', 'router'] as const) {
      const own = readJson(`mods/${mod}/.claude-plugin/plugin.json`).userConfig!;
      expect(Object.keys(OPTION_NAMES[mod]!).sort(), mod).toEqual(Object.keys(own).sort());
      for (const [key, option] of Object.entries(own)) expected[OPTION_NAMES[mod]![key]!] = { ...option, title: `${label[mod]}: ${option.title}` };
    }
    const { gateMode, ...mods } = readJson('.claude-plugin/plugin.json').userConfig!;
    expect(gateMode).toMatchObject({ type: 'string', default: 'auto' });
    // The integrated key config serves every feature; its type/sensitivity still match the Router option.
    const actualKey = mods['typesafeApiKey']; const expectedKey = expected['typesafeApiKey'] as Record<string, unknown>;
    expect(actualKey).toMatchObject({ type: expectedKey['type'], sensitive: expectedKey['sensitive'] });
    delete mods['typesafeApiKey']; delete expected['typesafeApiKey'];
    expect(mods).toEqual(expected);
  });

  it('registers nothing with all three Mods off, and reads only the plugin’s own names', async () => {
    const off = { compactEnabled: false, outputEnabled: false, routerEnabled: false };
    expect([...(await registered(off)).keys()]).toEqual(['session.start']);
    expect([...(await registered({ ...off, enabled: true })).keys()]).toEqual(['session.start']);
  });

  it('registers each event once with every option at its default, all three Mods on', async () => {
    const defaults = Object.fromEntries(Object.entries(readJson('.claude-plugin/plugin.json').userConfig!).map(([k, v]) => [k, (v as { default?: unknown }).default]));
    for (const options of [{}, defaults]) {
      expect([...(await registered(options)).keys()].sort()).toEqual(['session.start', 'agent.offer', 'agent.spawn', 'session.compact', 'session.end', 'tool.call {"tool":"Bash"}', 'turn.complete', 'turn.start', 'turn.step'].sort());
    }
  });

  it('sets missing foreground defaults and shares the configured key without changing explicit host settings', async () => {
    const hooks = await registered({ typesafeApiKey: 'fake-configured-key' });
    const env: Record<string, string | undefined> = { CLAUDE_CODE_FORK_SUBAGENT: '1' };
    const input = { cwd: '/r' };
    await hooks.get('session.start')!({ env: { get: async (name: string) => env[name], set: async (name: string, value: string | undefined) => { env[name] = value; } } }, input, async (e: unknown) => e);
    expect(env).toEqual({ CLAUDE_CODE_FORK_SUBAGENT: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', TYPESAFE_API_KEY: 'fake-configured-key' });
  });

  it('writes every unusable option from one session-start hook and keeps the other Mods', async () => {
    const hooks = await registered({ compactEnabled: true, compactMode: 'fast', outputEnabled: 'yes', routerEnabled: true });
    expect([...hooks.keys()].filter((k) => !k.startsWith('turn.') && !k.startsWith('agent.'))).toEqual(['session.start', 'session.end']);
    const logs: string[] = [];
    const e = { cwd: '/r' };
    expect(await hooks.get('session.start')!({ ui: { log: (t: string) => logs.push(t) } }, e, async (x: unknown) => x)).toBe(e);
    expect(logs).toEqual([
      'jev-compact {"event":"compact","disabled":"invalid_option","field":"compactMode"}',
      'jev-output {"event":"output","disabled":"invalid_option","field":"outputEnabled"}',
    ]);
  });
});
