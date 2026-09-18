import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTH_CONFLICT_ENV, isSubscriptionOAuth, parseAuthStatus, subagentModelOverride, type CommandResult } from './auth.js';
import { loadConfig, MIGRATION_SAMPLE, NATIVE_HOOK_TIMEOUT_MS } from './config.js';

type Level = 'ok' | 'warn' | 'fail' | 'info';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lines: Array<[Level, string]> = [];
const say = (level: Level, text: string): void => {
  lines.push([level, text]);
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const runCommand = (cmd: string, args: string[]): CommandResult => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, signal: r.signal ?? null, stdout: r.stdout ?? '', error: r.error ? ((r.error as NodeJS.ErrnoException).code ?? 'spawn_error') : null };
};

const checkNode = (): void => {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  say(major >= 22 ? 'ok' : 'fail', `Node ${process.versions.node} (requires >= 22)`);
};

interface Frontmatter {
  fields: Record<string, string>;
  error: string | null;
}

export const parseFrontmatter = (text: string): Frontmatter => {
  if (!text.startsWith('---\n')) return { fields: {}, error: 'no frontmatter on line 1' };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { fields: {}, error: 'unterminated frontmatter' };
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) fields[m[1]] = m[2].trim();
  }
  return { fields, error: null };
};

const listOf = (v: string | undefined): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const checkPluginFiles = (): void => {
  for (const rel of ['dist/hook.js', '.claude-plugin/plugin.json', 'hooks/hooks.json', 'agents/worker.md', 'agents/planner.md']) {
    say(existsSync(join(root, rel)) ? 'ok' : 'fail', `${rel} ${existsSync(join(root, rel)) ? 'present' : 'missing'}`);
  }
  try {
    const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')) as unknown;
    if (isRecord(manifest) && manifest['name'] !== 'jev-gate') say('fail', `plugin.json name is ${String(manifest['name'])}; roles are addressed as jev-gate:worker / jev-gate:planner`);
    if (isRecord(manifest) && 'hooks' in manifest) say('fail', 'plugin.json declares hooks inline; hooks/hooks.json is auto-discovered, so each hook would run twice');
    const hooks = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8')) as unknown;
    const table = isRecord(hooks) && isRecord(hooks['hooks']) ? hooks['hooks'] : {};
    const expected: Array<[string, string | null]> = [['UserPromptSubmit', null], ['PreToolUse', '^Agent$'], ['PostToolUse', '^Agent$'], ['PostToolUseFailure', '^Agent$']];
    for (const [event, matcher] of expected) {
      const groups = Array.isArray(table[event]) ? (table[event] as unknown[]) : [];
      const handlers = groups.flatMap((g) => (isRecord(g) && (matcher === null ? !('matcher' in g) : g['matcher'] === matcher) && Array.isArray(g['hooks']) ? g['hooks'] : []));
      const ours = handlers.filter((h) => isRecord(h) && h['type'] === 'command' && String(h['command']).includes('dist/hook.js'));
      say(ours.length === 1 ? 'ok' : 'fail', `hooks.json ${event}${matcher ? ` (${matcher})` : ''}: ${ours.length} command hook(s) → dist/hook.js (expect 1)`);
      const timeout = ours[0] && isRecord(ours[0]) ? ours[0]['timeout'] : undefined;
      if (ours.length === 1 && timeout !== NATIVE_HOOK_TIMEOUT_MS / 1000) say('warn', `${event} hook timeout ${String(timeout)}s (design assumes ${NATIVE_HOOK_TIMEOUT_MS / 1000}s)`);
    }
  } catch (err) {
    say('fail', `cannot parse plugin files: ${(err as Error).message}`);
  }
  const agentsDir = join(root, 'agents');
  const files = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')) : [];
  if (files.some((f) => !['worker.md', 'planner.md'].includes(f))) say('warn', `agents/ contains extra definitions (${files.join(', ')}); only worker.md and planner.md are the V4 roles`);
  const expectations: Record<string, { model: string; tools: string[] }> = { 'worker.md': { model: 'sonnet', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] }, 'planner.md': { model: 'opus', tools: ['Read', 'Grep', 'Glob'] } };
  for (const [file, exp] of Object.entries(expectations)) {
    const p = join(agentsDir, file);
    if (!existsSync(p)) continue;
    const fm = parseFrontmatter(readFileSync(p, 'utf8'));
    if (fm.error) {
      say('fail', `${file}: ${fm.error}`);
      continue;
    }
    const name = file.replace('.md', '');
    const tools = listOf(fm.fields['tools']);
    const disallowed = listOf(fm.fields['disallowedTools']);
    const problems: string[] = [];
    if (fm.fields['name'] !== name) problems.push(`name=${fm.fields['name'] ?? 'missing'}`);
    if (fm.fields['model'] !== exp.model) problems.push(`model=${fm.fields['model'] ?? 'missing'} (expected ${exp.model})`);
    if (tools.join(',') !== exp.tools.join(',')) problems.push(`tools=${tools.join(',') || 'missing'}`);
    if (!disallowed.includes('Agent') || !disallowed.includes('SendMessage')) problems.push('disallowedTools must include Agent and SendMessage');
    for (const ignored of ['permissionMode', 'hooks', 'mcpServers']) if (ignored in fm.fields) problems.push(`${ignored} is ignored for plugin agents`);
    say(problems.length ? 'fail' : 'ok', `agents/${file}: jev-gate:${name} model=${exp.model} tools=[${exp.tools.join(',')}] no Agent/SendMessage${problems.length ? ` — ${problems.join('; ')}` : ''}`);
  }
};

const checkConfig = (): void => {
  const loaded = loadConfig(process.env);
  if (!loaded.ok) {
    say('fail', `config invalid (${loaded.source}): ${loaded.error.split('\n')[0]}; the hook preserves native behavior until this is fixed`);
    if (/V3 layout/.test(loaded.error)) say('info', `V4 config sample (write a new file; the plugin never rewrites yours):\n${MIGRATION_SAMPLE}`);
    return;
  }
  const c = loaded.config;
  say('ok', `config ${loaded.source}: mode=${c.mode} jevModel=${c.jevModel} deadline=${c.requestDeadlineMs}ms floor=${c.routeConfidenceFloor} models=${JSON.stringify(c.models)}`);
  if (c.mode === 'off') say('info', 'mode=off: no coordinator guidance, no Jev, no trace writes. Loaded agent definitions still exist; remove the plugin for the absent-plugin condition');
  if (c.mode === 'native') say('info', 'mode=native: coordinator guidance + owned roles, no Jev request');
  if (c.mode === 'auto') say('info', 'mode=auto: eligible new jev-gate:worker/planner calls send the delegated prompt and description to TypeSafe (may include source excerpts and prior constraints)');
  if (process.env['JEV_GATE_EXPERIMENT_ALLOCATION']) say('warn', 'JEV_GATE_EXPERIMENT_ALLOCATION is set: the benchmark fixed-role control replaces the native allocation sentence');
};

const checkClaude = (): void => {
  const version = runCommand('claude', ['--version']);
  if (version.error || version.status !== 0) {
    say('warn', `claude CLI not runnable (${version.error ?? `exit ${String(version.status)}`}); install/login is the user's step`);
    return;
  }
  say('ok', `claude ${version.stdout.trim()} (V4 host checks recorded on 2.1.274/2.1.275; a version string alone is not proof of patch support)`);
  const parsed = parseAuthStatus(runCommand('claude', ['auth', 'status']));
  if (!parsed.ok) {
    say('warn', `auth unverified: ${parsed.reason}`);
    return;
  }
  const s = parsed.status;
  if (!s.loggedIn) {
    say('warn', 'not logged in; use `claude auth login` or /login (jev-gate never logs in for you)');
    return;
  }
  say(isSubscriptionOAuth(s) ? 'ok' : 'warn', `auth: method=${String(s.authMethod)} provider=${String(s.apiProvider)} subscription=${String(s.subscriptionType ?? 'unknown')}${isSubscriptionOAuth(s) ? '' : ' (supported condition is claude.ai subscription OAuth; other methods are unverified)'}`);
};

const checkEnv = (): void => {
  const env = process.env;
  const conflicts = AUTH_CONFLICT_ENV.filter((k) => env[k]);
  say(conflicts.length ? 'warn' : 'ok', conflicts.length ? `auth-related env set: ${conflicts.join(', ')} (may replace subscription OAuth; jev-gate does not change it)` : 'no API-key/gateway/cloud env overrides detected');
  const o = subagentModelOverride(env);
  if (o.force) say('warn', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1: every subagent model is overridden; eligible calls are preserved (no routing)');
  else if (o.concrete) say('warn', `CLAUDE_CODE_SUBAGENT_MODEL is a concrete override; eligible calls are preserved (no routing)`);
  else if (o.value === 'inherit') say('info', 'CLAUDE_CODE_SUBAGENT_MODEL=inherit is treated as unset on v2.1.196+ (harmless)');
  else say('ok', 'no CLAUDE_CODE_SUBAGENT_MODEL override');
  const fork = env['CLAUDE_CODE_FORK_SUBAGENT'];
  const bg = env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'];
  if (fork === '0' && bg === '1') say('ok', 'launch profile: CLAUDE_CODE_FORK_SUBAGENT=0 and CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 (foreground Agent calls; not a global scheduler)');
  else if (fork === '1') say('warn', 'CLAUDE_CODE_FORK_SUBAGENT=1: Agent calls run in the background and lack run_in_background; eligible calls are preserved');
  else say('info', `launch profile not set (fork=${fork ?? 'unset'}, disable_background=${bg ?? 'unset'}): interactive sessions default to fork mode, where Agent calls omit run_in_background and V4 preserves them. Start with CLAUDE_CODE_FORK_SUBAGENT=0 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`);
  if (env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'] === '1') say('info', 'agent teams enabled: a named Agent call becomes a teammate; the coordinator guidance asks for no teammate name');
  say(env['TYPESAFE_API_KEY'] ? 'ok' : 'warn', env['TYPESAFE_API_KEY'] ? 'TYPESAFE_API_KEY is set (value not shown)' : 'TYPESAFE_API_KEY not set: auto mode preserves every eligible call (key_missing)');
  if (existsSync(join(process.cwd(), '.env'))) say('info', '.env in cwd is NOT auto-loaded by the hook; export the variable in the shell that starts Claude Code');
};

const checkUserSettings = (): void => {
  const p = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(p)) return;
  try {
    const s = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (!isRecord(s)) return;
    if ('apiKeyHelper' in s) say('warn', 'settings.json has apiKeyHelper: the session may not use subscription OAuth');
    const env = isRecord(s['env']) ? Object.keys(s['env']) : [];
    const risky = env.filter((k) => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_SUBAGENT_MODEL') || k === 'CLAUDE_CODE_FORK_SUBAGENT' || k === 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS');
    if (risky.length) say('warn', `settings.json env sets ${risky.join(', ')} (names only; not modified)`);
  } catch {
    say('warn', 'cannot parse ~/.claude/settings.json');
  }
};

const main = (): void => {
  checkNode();
  checkPluginFiles();
  checkConfig();
  checkClaude();
  checkEnv();
  checkUserSettings();
  say('info', 'in Claude Code: /hooks should list four jev-gate entries (UserPromptSubmit, PreToolUse/PostToolUse/PostToolUseFailure on ^Agent$); the @agent- typeahead should show jev-gate:worker and jev-gate:planner once each');
  say('info', `start: JEV_GATE_MODE=auto CLAUDE_CODE_FORK_SUBAGENT=0 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude --model sonnet --plugin-dir "${root}"  (doctor performed no inference; a passing doctor is not proof of patch support or model access)`);
  for (const [level, text] of lines) process.stdout.write(`[${level}] ${text}\n`);
  process.exitCode = lines.some(([l]) => l === 'fail') ? 1 : 0;
};

const isMainModule = (): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMainModule()) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'doctor') main();
  else {
    process.stdout.write('usage: node dist/cli.js doctor\n');
    process.exitCode = 2;
  }
}
