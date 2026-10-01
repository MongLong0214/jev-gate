import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Env } from './config.js';
import { credentialsDir, privateDirectory, readPrivateJson, writePrivateJson } from './credentials.js';

export const claudeConfigDir = (env: Env): string => {
  const path = env['CLAUDE_CONFIG_DIR'] ?? join(env['HOME'] || homedir(), '.claude');
  if (!isAbsolute(path)) throw new Error('Claude configuration directory must be absolute');
  return path;
};
export const claudeTraceDir = (env: Env): string => env['JEV_GATE_TRACE_DIR'] ?? join(env['XDG_STATE_HOME'] || join(env['HOME'] || homedir(), '.local', 'state'), 'jev-gate', 'claude', 'traces');
export const claudeDefaults = (env: Env): Record<string, string> => ({
  CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
  CLAUDE_CODE_FORK_SUBAGENT: '0',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  JEV_GATE_TRACE_DIR: claudeTraceDir(env),
  CLAUDE_CODE_DEBUG_LOGS_DIR: join(claudeConfigDir(env), 'debug'),
});
export const integratedClaudePlugin = (env: Env): boolean => {
  try {
    const root = env['CLAUDE_PLUGIN_ROOT'];
    return !!root && JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))?.name === 'jev-gate';
  } catch { return false; }
};
export interface ClaudeSetup { changed: boolean; restartRequired: boolean; conflicts: string[]; error?: string }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Missing launch defaults and obsolete Jev installations are repaired; owner options and native permissions survive. */
export const prepareClaude = (env: Env): ClaudeSetup => {
  let lock: string | undefined;
  let fd: number | undefined;
  try {
    const dir = claudeConfigDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error('symlink');
    const settings = join(dir, 'settings.json');
    lock = join(dir, '.jev-gate-setup.lock');
    // A crashed initializer leaves no permanent barrier. Never take another live initializer's lock.
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const stat = lstatSync(lock);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32) throw new Error('lock');
      const pid = Number(readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('lock');
      try { process.kill(pid, 0); return { changed: false, restartRequired: false, conflicts: [], error: 'initialization_busy' }; }
      catch (dead) { if ((dead as NodeJS.ErrnoException).code !== 'ESRCH') throw dead; }
      rmSync(lock);
      fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    }
    writeFileSync(fd, String(process.pid));
    if (existsSync(settings) && (!lstatSync(settings).isFile() || lstatSync(settings).isSymbolicLink() || lstatSync(settings).size > 2 * 1024 * 1024)) throw new Error('settings');
    const before = existsSync(settings) ? readFileSync(settings, 'utf8') : null;
    const value: unknown = before === null ? {} : JSON.parse(before);
    if (!obj(value) || value['env'] !== undefined && !obj(value['env']) || value['enabledPlugins'] !== undefined && !obj(value['enabledPlugins'])) throw new Error('settings');
    const launch = { ...(value['env'] as Record<string, unknown> | undefined) };
    const defaults = claudeDefaults(env);
    const conflicts: string[] = [];
    let changed = false;
    for (const [name, fallback] of Object.entries(defaults)) {
      if (launch[name] === undefined && (env[name] === undefined || env[name] === fallback)) { launch[name] = fallback; changed = true; }
      else if (name.startsWith('CLAUDE_CODE_') && (launch[name] ?? env[name]) !== fallback) conflicts.push(name);
    }
    if (changed) value['env'] = launch;
    if (value['worktree'] === undefined) { value['worktree'] = { baseRef: 'head' }; changed = true; }
    else if (obj(value['worktree']) && value['worktree']['baseRef'] === undefined) { value['worktree']['baseRef'] = 'head'; changed = true; }
    const plugins = value['enabledPlugins'];
    if (obj(plugins)) for (const name of Object.keys(plugins)) {
      if (/^jev-gate-(?:compact|router|output|evidence)@/.test(name) && plugins[name] === true) { plugins[name] = false; changed = true; }
    }
    if (changed) {
      const tmp = `${settings}.${process.pid}.${randomBytes(8).toString('hex')}`;
      const out = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(out, JSON.stringify(value, null, 2) + '\n'); } finally { closeSync(out); }
      try {
        if ((existsSync(settings) ? readFileSync(settings, 'utf8') : null) !== before) throw new Error('settings_changed');
        renameSync(tmp, settings);
      } finally { rmSync(tmp, { force: true }); }
    }
    const restartRequired = Object.entries(defaults).some(([name, expected]) => name.startsWith('CLAUDE_CODE_') && env[name] !== expected);
    return { changed, restartRequired, conflicts };
  } catch { return { changed: false, restartRequired: true, conflicts: [], error: 'initialization_failed' }; }
  finally { if (fd !== undefined) { closeSync(fd); if (lock) rmSync(lock, { force: true }); } }
};

/** A one-time UI notice, not context fed to the model. No config, key or user prompt is included. */
export const claudeSetupMessage = (result: ClaudeSetup): string | null => {
  return result.error === 'initialization_busy' ? null : result.error ? 'Jev Gate could not prepare Claude Code settings. Run the installed plugin doctor.'
    : result.conflicts.length ? `Jev Gate preserved explicit host settings that conflict with automatic delegation: ${result.conflicts.join(', ')}. Run the installed plugin doctor.`
    : result.restartRequired ? 'Jev Gate prepared its required settings automatically. Restart Claude Code once to load Function Hooks and foreground workers; no settings file editing is needed.' : null;
};
export const claudeSetupNotice = (env: Env): string | null => {
  const text = claudeSetupMessage(prepareClaude(env));
  if (!text) return null;
  try {
    const path = join(credentialsDir(env), 'claude-notice.json');
    privateDirectory(credentialsDir(env));
    if (readPrivateJson(path)?.['notice'] === text) return null;
    writePrivateJson(path, { notice: text });
  } catch { /* Still show the useful startup notice when bookkeeping is unavailable. */ }
  return text;
};
