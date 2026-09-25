import type { EngineInterface, Register } from 'claude-code';

import { anyRouting, resolveConfig } from './config.ts';
import type { HostPins, RouterEngine } from './router.ts';
import { createRouter } from './router.ts';

const set = (v: string | undefined): boolean => v !== undefined && v.trim() !== '';

/**
 * The host's `$` as the Router's engine. `$.env.get` takes literal names only (validate lists what a module reads),
 * so every variable is spelled out here and nowhere else.
 */
const engineOf = ($: EngineInterface): RouterEngine => ({
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  envKey: () => $.env.get('TYPESAFE_API_KEY'),
  pins: async (): Promise<HostPins> => {
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
  log: (line) => $.ui.log(line, { to: 'debug' }),
});

/**
 * #40: off by default, and off means no hook at all. An option the Router cannot read turns it off too, with one
 * debug line naming the field when a session starts.
 */
export const register: Register = (on, options) => {
  const resolved = resolveConfig(options);
  if (!resolved.ok) {
    on('session.start', ($, e, next) => {
      $.ui.log(`jev-router ${JSON.stringify({ event: 'router', disabled: 'invalid_option', field: resolved.field })}`, { to: 'debug' });
      return next(e);
    });
    return;
  }
  const config = resolved.config;
  if (!anyRouting(config)) return;
  const router = createRouter(config);

  if (router.rootEnabled) {
    on('turn.start', ($, e, next) => {
      router.turnStart(e);
      return next(e);
    });
    on('turn.step', async function* ($, e, next) {
      return yield* router.turnStep(engineOf($), e, next);
    });
    on('turn.complete', ($, e, next) => {
      router.turnComplete(e);
      return next(e);
    });
  }
  if (router.spawnEnabled) {
    on('agent.offer', ($, e, next) => {
      router.agentOffer(e);
      return next(e);
    });
    on('agent.spawn', ($, e, next) => router.agentSpawn(engineOf($), e, next));
  }
  on('session.end', ($, e, next) => {
    router.sessionEnd();
    return next(e);
  });
};
