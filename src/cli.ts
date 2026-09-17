import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, NATIVE_HOOK_TIMEOUT_MS } from './config.js';

type Level = 'ok' | 'warn' | 'fail' | 'info';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lines: Array<[Level, string]> = [];
const say = (level: Level, text: string): void => {
  lines.push([level, text]);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const run = (cmd: string, args: string[]): { status: number | null; stdout: string; error: string | null } => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout ?? '', error: r.error ? (r.error as NodeJS.ErrnoException).code ?? 'spawn_error' : null };
};

const checkNode = (): void => {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  say(major >= 22 ? 'ok' : 'fail', `Node ${process.versions.node} (requires >= 22)`);
};

const checkPluginFiles = (): void => {
  const required = ['dist/hook.js', '.claude-plugin/plugin.json', 'hooks/hooks.json', 'agents/opus.md', 'agents/frontier.md'];
  for (const rel of required) {
    const p = join(root, rel);
    say(existsSync(p) ? 'ok' : 'fail', `${rel} ${existsSync(p) ? 'present' : 'missing'} (${p})`);
  }
  try {
    const hooks = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8')) as unknown;
    const entries = isRecord(hooks) && isRecord(hooks['hooks']) ? hooks['hooks']['UserPromptSubmit'] : undefined;
    const handlers = Array.isArray(entries) ? entries.flatMap((e) => (isRecord(e) && Array.isArray(e['hooks']) ? e['hooks'] : [])) : [];
    const cmdHooks = handlers.filter((h) => isRecord(h) && h['type'] === 'command' && String(h['command']).includes('dist/hook.js'));
    say(cmdHooks.length === 1 ? 'ok' : 'fail', `hooks.json registers ${cmdHooks.length} UserPromptSubmit command hook(s) for dist/hook.js (expect exactly 1)`);
    const timeout = cmdHooks[0] && isRecord(cmdHooks[0]) ? cmdHooks[0]['timeout'] : undefined;
    say(timeout === NATIVE_HOOK_TIMEOUT_MS / 1000 ? 'ok' : 'warn', `hook timeout ${String(timeout)}s (design assumes ${NATIVE_HOOK_TIMEOUT_MS / 1000}s)`);
    const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')) as unknown;
    if (isRecord(manifest) && 'hooks' in manifest) say('warn', 'plugin.json also declares hooks inline; hooks/hooks.json is auto-discovered, so the hook would run twice');
    if (isRecord(manifest) && manifest['name'] !== 'jev-gate') say('fail', `plugin.json name is ${String(manifest['name'])}; agents are referenced as jev-gate:opus / jev-gate:frontier`);
  } catch (err) {
    say('fail', `cannot parse plugin files: ${(err as Error).message}`);
  }
};

const checkClaude = (): void => {
  const version = run('claude', ['--version']);
  if (version.error || version.status !== 0) {
    say('warn', `claude CLI not runnable (${version.error ?? `exit ${String(version.status)}`}); install/login is the user's step`);
    return;
  }
  say('ok', `claude ${version.stdout.trim()}`);
  const auth = run('claude', ['auth', 'status']);
  if (auth.status !== 0) {
    say('warn', 'claude auth status failed; run `claude auth login` or /login in Claude Code');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(auth.stdout);
  } catch {
    say('warn', 'claude auth status output is not JSON on this version; login state unknown');
    return;
  }
  if (!isRecord(parsed)) {
    say('warn', 'claude auth status returned an unexpected shape; login state unknown');
    return;
  }
  const loggedIn = parsed['loggedIn'];
  const method = parsed['authMethod'];
  const provider = parsed['apiProvider'];
  const subscription = parsed['subscriptionType'];
  if (loggedIn !== true) {
    say('warn', 'not logged in; use `claude auth login` or /login (jev-gate never logs in for you)');
    return;
  }
  const oauth = method === 'claude.ai' && provider === 'firstParty';
  say(oauth ? 'ok' : 'warn', `auth: method=${String(method)} provider=${String(provider)} subscription=${String(subscription ?? 'unknown')}${oauth ? '' : ' (supported MVP condition is claude.ai subscription OAuth; other methods are unverified)'}`);
};

const checkEnvConflicts = (): void => {
  const env = process.env;
  const authVars = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
  const setAuth = authVars.filter((k) => env[k]);
  say(setAuth.length ? 'warn' : 'ok', setAuth.length ? `auth-related env set: ${setAuth.join(', ')} (may override subscription OAuth; jev-gate does not change it)` : 'no API-key/gateway/cloud env overrides detected');
  const sub = ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'].filter((k) => env[k]);
  say(sub.length ? 'warn' : 'ok', sub.length ? `${sub.join(', ')} set: can replace the agents' opus/fable model (per-call model > frontmatter > SUBAGENT_MODEL; FORCE overrides all)` : 'no CLAUDE_CODE_SUBAGENT_MODEL override');
  const fork = env['CLAUDE_CODE_FORK_SUBAGENT'];
  const noBg = env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'];
  if (noBg === '1' || fork === '0') say('ok', `foreground delegation forced (CLAUDE_CODE_FORK_SUBAGENT=${fork ?? 'unset'}, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=${noBg ?? 'unset'})`);
  else say('info', 'interactive sessions run fork mode by default, so Agent calls run in the background; set CLAUDE_CODE_FORK_SUBAGENT=0 (or CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1) for foreground delegation. -p sessions already default to fork mode off');
  if (env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'] === '1') say('info', 'agent teams enabled: a named Agent call in an interactive session launches a teammate instead of a subagent');
  say(env['TYPESAFE_API_KEY'] ? 'ok' : 'warn', env['TYPESAFE_API_KEY'] ? 'TYPESAFE_API_KEY is set (value not shown)' : 'TYPESAFE_API_KEY not set: the hook will answer with the neutral fallback on every turn');
  if (existsSync(join(process.cwd(), '.env'))) say('info', '.env in cwd is NOT auto-loaded by the hook; export the variable in the shell that starts Claude Code');
};

const checkUserSettings = (): void => {
  const p = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(p)) {
    say('info', 'no ~/.claude/settings.json');
    return;
  }
  try {
    const s = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (!isRecord(s)) return;
    if ('apiKeyHelper' in s) say('warn', 'settings.json has apiKeyHelper: the session may not use subscription OAuth');
    const env = isRecord(s['env']) ? Object.keys(s['env']) : [];
    const risky = env.filter((k) => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_SUBAGENT_MODEL') || k === 'CLAUDE_CODE_FORK_SUBAGENT');
    if (risky.length) say('warn', `settings.json env sets ${risky.join(', ')} (names only; not modified)`);
    const ups = isRecord(s['hooks']) && Array.isArray(s['hooks']['UserPromptSubmit']) ? s['hooks']['UserPromptSubmit'].length : 0;
    if (ups > 0) say('info', `user settings already register ${ups} UserPromptSubmit hook group(s); they run alongside jev-gate`);
  } catch {
    say('warn', 'cannot parse ~/.claude/settings.json');
  }
};

const checkConfig = (): void => {
  const loaded = loadConfig(process.env);
  if (!loaded.ok) {
    say('fail', `config invalid (${loaded.source}): ${loaded.error}; the hook falls back natively until fixed`);
    return;
  }
  const c = loaded.config;
  say('ok', `config ${loaded.source}: mode=${c.mode} jevModel=${c.jevModel} deadline=${c.requestDeadlineMs}ms floor=${c.routeConfidenceFloor} uncertainTier=${c.uncertainTier} opusModel=${c.opusModel} frontierModel=${c.frontierModel}`);
  if (c.mode === 'off') say('info', 'mode=off: the hook exits silently without calling Jev');
};

const main = (): void => {
  checkNode();
  checkPluginFiles();
  checkConfig();
  checkClaude();
  checkEnvConflicts();
  checkUserSettings();
  say('info', 'in Claude Code, /hooks should list one jev-gate UserPromptSubmit hook and /agents (or the @agent- typeahead) should show jev-gate:opus and jev-gate:frontier once each');
  say('info', `start: claude --model sonnet --plugin-dir "${root}"  (no inference was performed by doctor)`);
  for (const [level, text] of lines) process.stdout.write(`[${level}] ${text}\n`);
  process.exitCode = lines.some(([l]) => l === 'fail') ? 1 : 0;
};

const argv = process.argv.slice(2);
if (argv[0] === 'doctor') main();
else {
  process.stdout.write('usage: node dist/cli.js doctor\n');
  process.exitCode = argv.length === 0 ? 1 : 2;
}
