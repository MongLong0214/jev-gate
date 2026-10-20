import type { EngineInterface, On, Register } from 'claude-code';

import type { RouterConfig } from './config.ts';
import { anyRouting, resolveConfig } from './config.ts';
import type { HostPins, RouterEngine } from './router.ts';
import { createRouter } from './router.ts';
import { installedKeyPath, parseInstalledKey } from './key.ts';
import { frontierConfigPath, parseFrontierRouting } from '../../../src/frontier-routing.ts';
import { createRecorder, createRecordingState, type RecordingState } from './recording.ts';
import { childStepContext } from '../../../src/router-child-context.ts';
import { currentClaudeModel, factsOf, frontmatterEdits, frontmatterModel } from './models.ts';

const set = (v: string | undefined): boolean => v !== undefined && v.trim() !== '';
/** Each session's root record lives under this prefix in the plugin's store, so a resume finds its native pair. */
const ROOT_KEY = 'router-root:';
const MAX_ROOT_RECORDS = 200;
/** #277: one key per model, true when its last root effort change read the cache. */
const EFFORT_KEY = 'router-effort-cache:';

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


/** The file a custom agent type runs from, or null when there is none or it cannot be read. */
const agentFile = async ($: EngineInterface, type: string): Promise<string | null> => {
  // A plugin's agent (`plugin:name`) is defined by its plugin, never by a file under these directories.
  if (!/^[\w-]+$/.test(type)) return null;
  const [root, configDir, home] = await Promise.all([$.session.root(), $.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME')]);
  const user = configDir?.trim() ? configDir : home ? `${home}/.claude` : undefined;
  // The project's definition wins over the user's of the same name, as the host loads them.
  for (const dir of [`${root}/.claude/agents`, ...(user ? [`${user}/agents`] : [])]) {
    const path = `${dir}/${type}.md`;
    try {
      if (!await $.fs.exists(path)) continue;
      const stat = await $.fs.stat(path);
      return stat.kind === 'file' && stat.size <= 256 * 1024 ? await $.fs.read(path) : null;
    } catch { return null; }
  }
  return null;
};

// The native validator follows $ only within this file; the shared recorder receives plain callbacks.
const recorderOf = ($: EngineInterface, state: RecordingState) => createRecorder({
  paths: async () => {
    const [home, state, config, trace, session] = await Promise.all([
      $.env.get('HOME'), $.env.get('XDG_STATE_HOME'), $.env.get('XDG_CONFIG_HOME'), $.env.get('JEV_GATE_TRACE_DIR'), $.session.id(),
    ]);
    return { home, state, config, trace, session };
  },
  stat: path => $.fs.stat(path), exists: path => $.fs.exists(path), read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
  wait: (ms, signal) => $.clock.sleep(ms, { signal }),
}, state);

/**
 * The host's `$` as the Router's engine. `$.env.get` takes literal names only (validate lists what a module reads),
 * so every variable is spelled out here and nowhere else.
 */
const engineOf = ($: EngineInterface, log: RouterEngine['log']): RouterEngine => ({
  frontierEnabled: async () => {
    try {
      const path = frontierConfigPath(await $.env.get('HOME'), await $.env.get('XDG_CONFIG_HOME'), await $.env.get('JEV_GATE_CONFIG'));
      if (!path || !await $.fs.exists(path)) return undefined;
      const stat = await $.fs.stat(path);
      if (stat.isLink || stat.kind !== 'file' || stat.size > 64 * 1024) return false;
      return parseFrontierRouting(await $.fs.read(path));
    } catch { return false; }
  },
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  now: () => Date.now(),
  envKey: () => installedKey($),
  cacheCapability: async () => {
    const [auth, version, betas, base] = await Promise.all([$.session.authorize(), $.session.version(), $.env.get('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'), $.env.get('ANTHROPIC_BASE_URL')]);
    // No API here exposes organization HIPAA status. Runtime hit observations can establish preservation.
    return { host: version.base, connection: auth?.kind ?? 'unknown', excluded: betas === '1' || !!base && base !== 'https://api.anthropic.com', hipaa: null };
  },
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
  currentEffort: async () => {
    const override = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL');
    const value = override?.trim() ? override : (await $.settings.read())['effortLevel'];
    return typeof value === 'number' || ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(value)) ? value as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number : undefined;
  },
  hostModel: async () => {
    const env = await $.env.get('ANTHROPIC_MODEL');
    const value = env?.trim() ? env : (await $.settings.read())['model'];
    return typeof value === 'string' && value.trim() ? value : undefined;
  },
  transcript: async () => { const rows = await $.session.messages(); return { length: rows.length, answered: rows.some(m => m.role === 'assistant') }; },
  loadRoot: async () => $.store.get(`${ROOT_KEY}${await $.session.id()}`),
  sessionId: () => $.session.id(),
  saveRoot: async (record, sessionId) => {
    await $.store.set(`${ROOT_KEY}${sessionId}`, record);
    // Keys keep insertion order: the oldest sessions' records go first.
    const keys = (await $.store.keys()).filter(k => k.startsWith(ROOT_KEY));
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ROOT_RECORDS))) await $.store.delete(k);
  },
  effortCacheHits: async () => {
    const keys = (await $.store.keys()).filter(k => k.startsWith(EFFORT_KEY));
    const hits = await Promise.all(keys.map(async k => await $.store.get(k) === true ? k.slice(EFFORT_KEY.length) : null));
    return hits.filter((id): id is string => id !== null);
  },
  saveEffortCache: (model, hit) => $.store.set(`${EFFORT_KEY}${model}`, hit),
  modelAliases: async () => {
    const [opus, sonnet, haiku, fable, bedrock, vertex, foundry, mantle, version] = await Promise.all([
      $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL'), $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL'), $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
      $.env.get('ANTHROPIC_DEFAULT_FABLE_MODEL'), $.env.get('CLAUDE_CODE_USE_BEDROCK'), $.env.get('CLAUDE_CODE_USE_VERTEX'),
      $.env.get('CLAUDE_CODE_USE_FOUNDRY'), $.env.get('CLAUDE_CODE_USE_MANTLE'), $.session.version(),
    ]);
    // Provider-specific deployments without an explicit verified mapping remain unresolved.
    const api = !set(bedrock) && !set(vertex) && !set(foundry) && !set(mantle);
    const release = /^2\.1\.(\d+)$/.exec(version.base ?? '');
    const supports = (family: 'sonnet' | 'haiku'): boolean => release !== null && Number(release[1]) >= (factsOf(currentClaudeModel(family))?.minimumHostRelease ?? Infinity);
    return { ...(opus || api ? { opus: opus || currentClaudeModel('opus') } : {}),
      ...(sonnet || api ? { sonnet: sonnet || (supports('sonnet') ? currentClaudeModel('sonnet') : 'claude-sonnet-5') } : {}),
      ...(haiku || api ? { haiku: haiku || (supports('haiku') ? currentClaudeModel('haiku') : 'claude-haiku-4-5') } : {}), ...(fable || api ? { fable: fable || currentClaudeModel('fable') } : {}) };
  },
  dispatchPair: async (tool, model, allowFable, agent, eligible = true, token = '') => {
    // CLAUDE_PLUGIN_ROOT is injected into command hooks, not native Function Hooks. The host owns this path.
    const root = $.plugin.root;
    const path = root + '/dist/dispatch-policy.js';
    if (!await $.fs.exists(path)) return null; // Standalone Router has no owned Gate state.
    const result = await $.process.run(['node', path, await $.session.id(), tool, model, String(allowFable), agent, String(eligible), token], { timeoutMs: 500 });
    const out = result.exitCode === 0 ? JSON.parse(result.stdout) : null;
    // Like a timeout, a failed or malformed answer is no answer: the Router denies and releases at its own boundary.
    if (!out || typeof out !== 'object') throw new Error('dispatch policy unavailable');
    return out;
  },
  agentModel: async type => { const text = await agentFile($, type); return text === null ? null : frontmatterModel(text); },
  agentEdits: async type => { const text = await agentFile($, type); return text === null ? null : frontmatterEdits(text); },
  resumes: async name => (await $.agent.list()).some(a => a.name === name || a.id === name),
  hostBase: async () => (await $.session.version()).base,
  childContext: async agentId => {
    const rows = await $.session.messages({ agentId });
    return Array.isArray(rows) ? childStepContext(rows) : undefined;
  },
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
 * #40: off by default, and off means no hook at all. An option the Router cannot read turns it off too.
 */
export const register: Register = (on, options) => {
  const resolved = resolveConfig(options);
  if (!resolved.ok) return;
  if (!anyRouting(resolved.config)) return;
  const observer: ContextObserver = {};
  registerRouter(on, resolved.config, false, observer);
  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (result.skip === undefined) observer.contextChanged?.(e.agentId);
    return result;
  });
};

/** The hooks for a resolved config; the combined jev-gate module (hooks/register.ts) calls this directly. */
export interface ContextObserver { contextChanged?: (agentId?: string) => void }
export const registerRouter = (on: On, config: RouterConfig, ownedDispatch = false, observer?: ContextObserver, recording = createRecordingState()): void => {
  if (anyRouting(config) && !config.logDecisions) recording.failed = true;
  const router = createRouter(config, undefined, ownedDispatch);
  if (observer) observer.contextChanged = router.contextChanged;
  if (!ownedDispatch && !anyRouting(config)) return;

  if (router.rootEnabled) {
    on('turn.start', ($, e, next) => {
      quietly(() => router.turnStart(e));
      return next(e);
    });
  }
  if (router.stepEnabled) {
    on('turn.complete', async ($, e, next) => {
      const recorder = recorderOf($, recording);
      quietly(() => router.turnComplete(e, { log: recorder.log }));
      try { return await next(e); }
      finally { await recorder.flush(); }
    });
  }
  // Root turns and subagent loops both step here.
  if (router.stepEnabled) {
    on('turn.step', async function* ($, e, next) {
      const recorder = recorderOf($, recording);
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
      const recorder = recorderOf($, recording);
      try { return await router.agentSpawn(engineOf($, recorder.log), e, next); }
      finally { await recorder.flush(); }
    });
  }
  on('session.end', async ($, e, next) => {
    const recorder = recorderOf($, recording);
    quietly(() => router.sessionEnd({ log: recorder.log }));
    try { return await next(e); }
    finally { await recorder.finish(); }
  });

};
