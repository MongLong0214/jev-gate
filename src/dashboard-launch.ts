import { spawn } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Env } from './config.js';
import { credentialsDir, privateDirectory, readPrivateJson, writePrivateJson } from './credentials.js';
import { dashboardStatus } from './dashboard-settings.js';
import { startDashboard, dashboardSources } from './dashboard.js';
import { openSetupBrowser } from './onboarding.js';

const runtimePath = (env: Env): string => join(credentialsDir(env), 'dashboard-runtime.json');
const tokenOf = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const urlOf = (value: unknown): value is string => typeof value === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(value);
const versionAt = (root: string): string => {
  for (const kind of ['.codex-plugin', '.claude-plugin']) {
    try { const value = JSON.parse(readFileSync(join(root, kind, 'plugin.json'), 'utf8')); if (typeof value.version === 'string') return value.version; } catch { /* Other host package. */ }
  }
  return 'unknown';
};
const healthy = async (state: Record<string, unknown> | null): Promise<boolean> => {
  if (!state || !urlOf(state['url']) || !tokenOf(state['token'])) return false;
  try {
    const reply = await fetch(`${state['url']}api/health`, { signal: AbortSignal.timeout(300) });
    const body = await reply.json() as Record<string, unknown>;
    return reply.ok && body['service'] === 'jev-gate-dashboard' && body['token'] === state['token'];
  } catch { return false; }
};

/** One shared local dashboard, launched by either installed host. Repeated sessions do not open more tabs. */
export const ensureDashboard = async (root: string, env: Env, options: { launch?: (entry: string, token: string) => void } = {}): Promise<boolean> => {
  if (!dashboardStatus(env).enabled || env['JEV_DASHBOARD_NO_OPEN'] === '1') return false;
  let fd: number | undefined; let lock: string | undefined;
  try {
    const dir = credentialsDir(env); privateDirectory(dir);
    lock = join(dir, 'dashboard.lock');
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = lstatSync(lock);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32) return false;
      const pid = Number(readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) return false;
      try { process.kill(pid, 0); return await healthy(readPrivateJson(runtimePath(env))); }
      catch (dead) { if ((dead as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
      rmSync(lock); fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    }
    writeFileSync(fd, String(process.pid));
    const previous = readPrivateJson(runtimePath(env));
    const version = versionAt(root);
    let reusePort: number | undefined;
    if (previous && await healthy(previous)) {
      const parts = (v: unknown): number[] => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : [];
      const before = parts(previous['version']); const current = parts(version);
      const newer = current.length === 3 && before.length === 3 && current.some((n, i) => n > before[i]! && current.slice(0, i).every((p, j) => p === before[j]));
      if (previous['version'] === version || before.length && current.length && !newer) return true;
      // Authenticated loopback shutdown updates the running build without signalling an arbitrary PID.
      const shutdown = await fetch(`${previous['url']}api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${previous['token']}` }, signal: AbortSignal.timeout(300) }).catch(() => null);
      if (!shutdown?.ok) return false;
      reusePort = Number(new URL(String(previous['url'])).port);
    }
    const token = randomBytes(16).toString('hex');
    const entry = join(root, 'dist', existsSync(join(root, '.codex-plugin/plugin.json')) ? 'cli.mjs' : 'cli.js');
    if (!existsSync(entry)) return false;
    writePrivateJson(runtimePath(env), { token, version, startingAt: Date.now(), pid: process.pid, ...(reusePort ? { reusePort } : {}) });
    if (options.launch) options.launch(entry, token);
    else {
      const child = spawn(process.execPath, [entry, 'dashboard-serve', token], { env: { ...env }, stdio: 'ignore', detached: true });
      child.on('error', () => undefined); child.unref();
    }
    // Wait only for local startup. Nothing about this readiness claims that a Jev policy ran.
    for (let i = 0; i < 30; i++) {
      const state = readPrivateJson(runtimePath(env));
      if (state?.['token'] === token && await healthy(state)) return true;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return false;
  } catch { return false; }
  finally { if (fd !== undefined) { closeSync(fd); if (lock) rmSync(lock, { force: true }); } }
};

export const serveAutomaticDashboard = async (root: string, env: Env, token: string): Promise<void> => {
  const launch = readPrivateJson(runtimePath(env));
  if (!tokenOf(token) || launch?.['token'] !== token || !dashboardStatus(env).enabled) return;
  const reusePort = typeof launch['reusePort'] === 'number' && Number.isInteger(launch['reusePort']) && launch['reusePort'] > 0 && launch['reusePort'] <= 65535 ? launch['reusePort'] : 0;
  const server = await startDashboard(dashboardSources(env), reusePort, { token });
  writePrivateJson(runtimePath(env), { token, version: versionAt(root), url: server.url, pid: process.pid });
  if (!reusePort && env['JEV_DASHBOARD_NO_OPEN'] !== '1') openSetupBrowser(server.url);
  let closing = false;
  const stop = (): void => {
    if (closing) return; closing = true; clearInterval(check);
    void server.close().finally(() => {
      if (readPrivateJson(runtimePath(env))?.['token'] === token) rmSync(runtimePath(env), { force: true });
    });
  };
  const check = setInterval(() => {
    const state = readPrivateJson(runtimePath(env));
    if (!dashboardStatus(env).enabled || state?.['token'] !== token) stop();
  }, 1000);
  check.unref(); process.once('SIGTERM', stop); process.once('SIGINT', stop);
};
