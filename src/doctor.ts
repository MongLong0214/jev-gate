import { constants, accessSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Env } from './config.js';
import { credentialsDir, readPrivateJson } from './credentials.js';
import { packageVersion, type ReleaseInfo, unknownRelease, compareVersions } from './release-info.js';

export type DoctorLevel = 'ok' | 'warn' | 'fail' | 'info';
export type DoctorGroup = 'runtime' | 'package' | 'host' | 'configuration' | 'credentials' | 'storage' | 'activity' | 'version' | 'models';
export interface DoctorCheck { id: string; group: DoctorGroup; level: DoctorLevel; message: string; action: string | null }
export interface DoctorReport {
  host: 'claude' | 'codex'; checkedAt: string; ok: boolean; status: 'ready' | 'attention' | 'blocked';
  version: { package: string | null; release: ReleaseInfo }; checks: DoctorCheck[];
  counts: Record<DoctorLevel, number>;
  models?: { source: string; complete: boolean; accountAccess: 'unverified'; compatibility: import('./doctor-models.js').ModelCompatibility[] };
}
const ACTIONS: Record<DoctorGroup, string> = {
  runtime: 'Install Node 22.15 or newer and rerun doctor.',
  package: 'Update or reinstall the official Jev Gate plugin; rerun doctor against the installed package.',
  host: 'Install the native CLI, then use its login and /hooks commands to check authentication and hook trust.',
  configuration: 'Correct the named setting or environment override; start a fresh native session to load it.',
  credentials: 'Enter a Jev API key in the local setup screen. Explicit key overrides take precedence over the saved key.',
  storage: 'Correct the named path or its permissions. Doctor does not create directories or change permissions.',
  activity: 'Check the latest execution records in the dashboard; missing observations do not establish failure or success.',
  version: 'Update the plugin through its marketplace. A fresh native session loads the new hooks.',
  models: 'Update the native CLI and inspect its /model list and model restrictions; correct the model or effort mapping.',
};
export const doctorChecks = () => {
  const checks: DoctorCheck[] = [];
  let group: DoctorGroup = 'runtime';
  return { checks, group: (value: DoctorGroup) => { group = value; },
    say: (level: DoctorLevel, message: string, action?: string): void => { checks.push({ id: `${group}.${checks.filter(c => c.group === group).length + 1}`, group, level, message, action: level === 'fail' || level === 'warn' ? action ?? ACTIONS[group] : null }); },
  };
};
export const finishDoctor = (host: DoctorReport['host'], root: string, checks: DoctorCheck[], release = unknownRelease()): DoctorReport => {
  const counts = { ok: 0, warn: 0, fail: 0, info: 0 }; for (const check of checks) counts[check.level]++;
  return { host, checkedAt: new Date().toISOString(), ok: counts.fail === 0, status: counts.fail ? 'blocked' : counts.warn ? 'attention' : 'ready', version: { package: packageVersion(root, host), release }, checks, counts };
};
export const renderDoctor = (report: DoctorReport, verbose = false): string => {
  const out = [`Jev Gate ${report.version.package ? `v${report.version.package}` : '(version unknown)'} · ${report.host} · ${report.status.toUpperCase()}`, `${report.counts.fail} failures · ${report.counts.warn} warnings · ${report.counts.ok} local checks passed`, 'Local readiness only; active hook trust, provider application and savings need observed execution records.'];
  for (const group of ['runtime', 'package', 'host', 'configuration', 'models', 'credentials', 'storage', 'activity', 'version'] as const) {
    const all = report.checks.filter(c => c.group === group); if (!all.length) continue;
    const visible = all.filter(c => verbose || c.level === 'fail' || c.level === 'warn' || ['runtime', 'host', 'models', 'version', 'credentials', 'activity'].includes(group));
    out.push(`\n${group} · ${all.filter(c => c.level === 'fail').length} failures / ${all.filter(c => c.level === 'warn').length} warnings`);
    for (const c of visible) { out.push(`[${c.level}] ${c.message}`); if (c.action) out.push(`  Next: ${c.action}`); }
    if (visible.length !== all.length) out.push(`${all.length - visible.length} detail checks; use --verbose or --json.`);
  }
  return out.join('\n') + '\n';
};
/** Inspect without mkdir, chmod, probing writes, or following a symlink in the path. */
export const storageIssue = (path: string, privatePath = false): string | null => {
  if (!isAbsolute(path)) return 'path must be absolute';
  let current = path;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return 'symlink in storage path';
      if (!stat.isDirectory()) return 'storage path is not a directory';
      if (current === path && privatePath && (stat.mode & 0o077)) return 'directory must be private (0700)';
      accessSync(current, constants.R_OK | constants.W_OK | constants.X_OK);
      // Native temporary/home prefixes can be system aliases (e.g. /var on macOS).
      return null;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'storage path is unreadable or not writable'; }
    const parent = dirname(current); if (parent === current) return 'no writable parent directory'; current = parent;
  }
};
export const readableFile = (path: string): boolean => { try { const stat = lstatSync(path); if (!stat.isFile()) return false; accessSync(path, constants.R_OK); return true; } catch { return false; } };
/** Dashboard health is bounded and read-only. Tokens and raw error bodies never enter the report. */
export const dashboardDiagnostic = async (env: Env): Promise<{ level: DoctorLevel; message: string }> => {
  let path: string; try { path = join(credentialsDir(env), 'dashboard-runtime.json'); } catch { return { level: 'fail', message: 'Dashboard runtime: invalid shared configuration path' }; }
  const state = readPrivateJson(path);
  if (!state) return { level: 'info', message: 'Dashboard runtime: no readable owner record; active runtime is unverified' };
  if (typeof state['url'] !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(state['url']) || typeof state['token'] !== 'string') return { level: 'warn', message: 'Dashboard runtime: invalid owner metadata' };
  try {
    const response = await fetch(`${state['url']}api/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || body['service'] !== 'jev-gate-dashboard' || body['token'] !== state['token']) return { level: 'warn', message: 'Dashboard runtime: owner identity could not be confirmed' };
    return { level: 'ok', message: `Dashboard runtime: responding at ${state['url']}; running package ${typeof state['version'] === 'string' ? state['version'] : 'unknown'}` };
  } catch { return { level: 'warn', message: 'Dashboard runtime: health probe timed out or failed; the owner may be busy (not proof of a dead process)' }; }
};
export const versionDiagnostic = (root: string, host: DoctorReport['host'], release: ReleaseInfo): { level: DoctorLevel; message: string } => {
  const current = packageVersion(root, host), comparison = compareVersions(current, release.latest);
  return { level: comparison === -1 ? 'warn' : 'info', message: comparison === null ? `Latest release: unverified${release.error ? ` (${release.error})` : '; use --check-update for a public GitHub check'}` : comparison === 0 ? `Latest release: v${release.latest}; this package is current` : comparison === -1 ? `Latest release: v${release.latest}; package v${current} needs an update` : `Latest release: v${release.latest}; package v${current} is newer than the published release` };
};
