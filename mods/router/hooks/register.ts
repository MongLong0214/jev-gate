import type { EngineInterface, On, Register } from 'claude-code';

import type { RouterConfig } from './config.ts';
import { anyRouting, resolveConfig } from './config.ts';
import type { HostPins, RouterEngine } from './router.ts';
import { createRouter } from './router.ts';
import { installedKeyPath, parseInstalledKey } from './key.ts';
import { createRecorder } from './recording.ts';

const set = (v: string | undefined): boolean => v !== undefined && v.trim() !== '';

const installedKey = async ($: EngineInterface): Promise<string | undefined> => {
  const existing = await $.env.get('TYPESAFE_API_KEY');
  if (existing?.trim()) return existing;
  try {
    const path = installedKeyPath(await $.env.get('HOME'), await $.env.get('XDG_CONFIG_HOME'));
    if (!path) return undefined;
    const parent = await $.fs.stat(path.slice(0, path.lastIndexOf('/'))); const stat = await $.fs.stat(path);
    if (parent.isLink || parent.kind !== 'dir' || stat.isLink || stat.kind !== 'file' || stat.size > 16 * 1024) return undefined;
    return parseInstalledKey(await $.fs.read(path));
  } catch { return undefined; }
};


// The native validator follows $ only within this file; the shared recorder receives plain callbacks.
const recorderOf = ($: EngineInterface) => createRecorder({
  paths: async () => {
    const [home, state, config, trace, session] = await Promise.all([
      $.env.get('HOME'), $.env.get('XDG_STATE_HOME'), $.env.get('XDG_CONFIG_HOME'), $.env.get('JEV_GATE_TRACE_DIR'), $.session.id(),
    ]);
    return { home, state, config, trace, session };
  },
  stat: path => $.fs.stat(path), exists: path => $.fs.exists(path), read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text), debug: line => $.ui.log(line, { to: 'debug' }),
  wait: (ms, signal) => $.clock.sleep(ms, { signal }),
});

/**
 * The host's `$` as the Router's engine. `$.env.get` takes literal names only (validate lists what a module reads),
 * so every variable is spelled out here and nowhere else.
 */
const engineOf = ($: EngineInterface, log: RouterEngine['log']): RouterEngine => ({
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  now: () => Date.now(),
  envKey: () => installedKey($),
  pins: async (scope = 'spawn'): Promise<HostPins> => {
    if (scope === 'effort')
      return { mainModel: false, mainEffort: set(await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')), subagentModel: false, aliasRemap: false };
    if (scope === 'root') {
      const [model, effort] = await Promise.all([$.env.get('ANTHROPIC_MODEL'), $.env.get('CLAUDE_CODE_EFFORT_LEVEL')]);
      return { mainModel: set(model), mainEffort: set(effort), subagentModel: false, aliasRemap: false };
    }
    const [mainModel, mainEffort, subagent, subagentForce, opus, sonnet, haiku] = await Promise.all([
      $.env.get('ANTHROPIC_MODEL'),
      $.env.get('CLAUDE_CODE_EFFORT_LEVEL'),
      $.env.get('CLAUDE_CODE_SUBAGENT_MODEL'),
      $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE'),
      $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL'),
      $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL'),
      $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
    ]);
    return {
      mainModel: set(mainModel),
      mainEffort: set(mainEffort),
      subagentModel: set(subagent) || set(subagentForce),
      aliasRemap: set(opus) || set(sonnet) || set(haiku),
    };
  },
  availableModels: async () => {
    const v = (await $.settings.read())['availableModels'];
    if (v === undefined) return undefined;
    // A malformed allowlist allows nothing, rather than everything.
    return Array.isArray(v) && v.every((x): x is string => typeof x === 'string') ? v : [];
  },
  hostBase: async () => (await $.session.version()).base,
  log,
});

/** Bookkeeping and diagnostics never stand between the host and its own event: a failure here leaves it native. */
const quietly = (f: () => void): void => {
  try {
    f();
  } catch {
    // The event goes on unchanged.
  }
};

/**
 * #40: off by default, and off means no hook at all. An option the Router cannot read turns it off too, with one
 * debug line naming the field when a session starts.
 */
export const register: Register = (on, options) => {
  const resolved = resolveConfig(options);
  if (!resolved.ok) {
    on('session.start', ($, e, next) => {
      quietly(() => $.ui.log(`jev-router ${JSON.stringify({ event: 'router', disabled: 'invalid_option', field: resolved.field })}`, { to: 'debug' }));
      return next(e);
    });
    return;
  }
  registerRouter(on, resolved.config);
};

/** The hooks for a resolved config; the combined jev-gate module (hooks/register.ts) calls this directly. */
export const registerRouter = (on: On, config: RouterConfig): void => {
  if (!anyRouting(config)) return;
  const router = createRouter(config);

  if (router.rootEnabled) {
    on('turn.start', ($, e, next) => {
      quietly(() => router.turnStart(e));
      return next(e);
    });
  }
  if (router.stepEnabled) {
    on('turn.complete', ($, e, next) => {
      quietly(() => router.turnComplete(e));
      return next(e);
    });
  }
  // Root turns and subagent loops both step here.
  if (router.stepEnabled) {
    on('turn.step', async function* ($, e, next) {
      const recorder = recorderOf($);
      try { return yield* router.turnStep(engineOf($, recorder.log), e, next); }
      finally { await recorder.flush(); }
    });
  }
  if (router.spawnEnabled) {
    on('agent.offer', ($, e, next) => {
      quietly(() => router.agentOffer(e));
      return next(e);
    });
    on('agent.spawn', async ($, e, next) => {
      const recorder = recorderOf($);
      try { return await router.agentSpawn(engineOf($, recorder.log), e, next); }
      finally { await recorder.flush(); }
    });
  }
  on('session.end', ($, e, next) => {
    quietly(() => router.sessionEnd());
    return next(e);
  });
};
