import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from './config.js';
import { credentialsDir, readPrivateJson, writePrivateJson } from './credentials.js';

/** A live, shared switch. Hosts keep their existing native logging and permissions. */
export const recordingPath = (env: Env): string => join(credentialsDir(env), 'recording.json');
export const recordingStatus = (env: Env): { enabled: boolean; error?: string } => {
  try {
    const path = recordingPath(env);
    if (!existsSync(path)) return { enabled: true };
    if (lstatSync(path).isSymbolicLink()) return { enabled: false, error: 'invalid_recording_settings' };
    const value = readPrivateJson(path);
    return value?.['version'] === 1 && typeof value['enabled'] === 'boolean'
      ? { enabled: value['enabled'] } : { enabled: false, error: 'invalid_recording_settings' };
  } catch { return { enabled: false, error: 'recording_settings_unavailable' }; }
};
export const setRecording = (env: Env, enabled: boolean): void => writePrivateJson(recordingPath(env), { version: 1, enabled });
export const recordingCommand = (env: Env, action = 'status'): string => {
  if (!['on', 'off', 'status'].includes(action)) throw new Error('recording requires on, off or status');
  if (action !== 'status') setRecording(env, action === 'on');
  const status = recordingStatus(env);
  return `Jev recording: ${status.enabled ? 'on' : 'off'}${status.error ? ` (${status.error})` : ''}. Applies to new records in Claude Code and Codex; no restart required.`;
};
