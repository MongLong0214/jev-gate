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
    expect(readJson('.claude-plugin/plugin.json').userConfig).toEqual(expected);
  });

  it('registers nothing with every option at its default', async () => {
    expect([...(await registered({})).keys()]).toEqual([]);
  });

  it('registers each event once with all three Mods on, and reads only the plugin’s own names', async () => {
    const all = await registered({ compactEnabled: true, outputEnabled: true, routerEnabled: true });
    expect([...all.keys()].sort()).toEqual(['agent.offer', 'agent.spawn', 'session.compact', 'session.end', 'tool.call {"tool":"Bash"}', 'turn.complete', 'turn.start', 'turn.step'].sort());
    expect([...(await registered({ enabled: true })).keys()]).toEqual([]);
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
