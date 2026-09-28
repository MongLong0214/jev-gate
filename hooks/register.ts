import type { PluginOptions, Register } from 'claude-code';

import { resolveCompactConfig } from '../mods/compact/hooks/config.ts';
import { registerCompact } from '../mods/compact/hooks/register.ts';
import { resolveOutputConfig } from '../mods/output/hooks/config.ts';
import { registerOutput } from '../mods/output/hooks/register.ts';
import { resolveConfig } from '../mods/router/hooks/config.ts';
import { registerRouter } from '../mods/router/hooks/register.ts';


/**
 * The one plugin's option name for each option a Mod reads. A name two Mods share, or one that would read as the
 * gate's, carries the Mod's prefix; tests/plugin-modules.test.ts holds plugin.json's userConfig to this table.
 */
export const OPTION_NAMES = {
  compact: { enabled: 'compactEnabled', mode: 'compactMode', budgetChars: 'compactBudgetChars', compactSubagents: 'compactSubagents', compactManual: 'compactManual' },
  output: { enabled: 'outputEnabled' },
  router: {
    enabled: 'routerEnabled',
    routeSubagentModel: 'routeSubagentModel',
    routeExplicitSpawnModel: 'routeExplicitSpawnModel',
    routeSubagentEffort: 'routeSubagentEffort',
    routeMainEffort: 'routeMainEffort',
    routeMainModel: 'routeMainModel',
    typesafeApiKey: 'typesafeApiKey',
    fastModel: 'routerFastModel',
    standardModel: 'routerStandardModel',
    deepModel: 'routerDeepModel',
    frontierModel: 'routerFrontierModel',
    minUpgradeConfidence: 'routerMinUpgradeConfidence',
    minDowngradeConfidence: 'routerMinDowngradeConfidence',
    timeoutMs: 'routerTimeoutMs',
    logDecisions: 'routerLogDecisions',
  },
} as const;

const rename = (o: PluginOptions, names: Readonly<Record<string, string>>): PluginOptions =>
  Object.fromEntries(Object.entries(names).flatMap(([own, merged]) => (o[merged] === undefined ? [] : [[own, o[merged]]])));

/** Bookkeeping never stands between the host and its own event. */
const quietly = (f: () => void): void => {
  try {
    f();
  } catch {
    // The event goes on unchanged.
  }
};

/**
 * The host loads one hooks module per plugin, and a second registration of one event fails that whole module. The
 * Mods' own hooks never share an event; only their diagnostic for an option they cannot use would (each registers
 * `session.start` for it), so this module resolves the options itself and writes those lines from one hook. A Mod
 * with an unusable option stays off, as it does alone, and the others run.
 */
export const register: Register = (on, options) => {
  const o = options ?? {};
  const compact = resolveCompactConfig(rename(o, OPTION_NAMES.compact));
  const output = resolveOutputConfig(rename(o, OPTION_NAMES.output));
  const router = resolveConfig(rename(o, OPTION_NAMES.router));
  const invalid = [
    ...(compact.ok ? [] : [['compact', OPTION_NAMES.compact[compact.field as keyof typeof OPTION_NAMES.compact] ?? compact.field]]),
    ...(output.ok ? [] : [['output', OPTION_NAMES.output[output.field as keyof typeof OPTION_NAMES.output] ?? output.field]]),
    ...(router.ok ? [] : [['router', OPTION_NAMES.router[router.field as keyof typeof OPTION_NAMES.router] ?? router.field]]),
  ];
  if (invalid.length) {
    on('session.start', ($, e, next) => {
      for (const [mod, field] of invalid) quietly(() => $.ui.log(`jev-${mod} ${JSON.stringify({ event: mod, disabled: 'invalid_option', field })}`, { to: 'debug' }));
      return next(e);
    });
  }
  if (compact.ok) registerCompact(on, compact.config);
  if (output.ok) registerOutput(on, output.config);
  if (router.ok) registerRouter(on, router.config);
};
