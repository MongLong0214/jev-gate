import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Env } from './config.js';
import { credentialsDir, readPrivateJson, writePrivateJson } from './credentials.js';

/** Both hosts share this preference; no file is needed for the default. */
export const dashboardSettingsPath = (env: Env): string => join(dirname(credentialsDir(env)), 'dashboard', 'config.json');
export const dashboardStatus = (env: Env): { enabled: boolean; error?: string } => {
  try {
    const path = dashboardSettingsPath(env);
    if (!existsSync(path)) return { enabled: true };
    const value = readPrivateJson(path);
    return value?.['version'] === 1 && typeof value['enabled'] === 'boolean'
      ? { enabled: value['enabled'] } : { enabled: false, error: 'invalid_dashboard_settings' };
  } catch { return { enabled: false, error: 'dashboard_settings_unavailable' }; }
};
export const setDashboard = (env: Env, enabled: boolean): void => writePrivateJson(dashboardSettingsPath(env), { version: 1, enabled });
export const dashboardPreferenceCommand = (env: Env, action: string): string => {
  if (!['on', 'off', 'status'].includes(action)) throw new Error('dashboard requires on, off or status');
  if (action !== 'status') setDashboard(env, action === 'on');
  const state = dashboardStatus(env);
  return `Jev dashboard: ${state.enabled ? 'on' : 'off'}${state.error ? ` (${state.error})` : ''}. Automatic browser opening applies to Claude Code and Codex. Recording is controlled separately.`;
};
