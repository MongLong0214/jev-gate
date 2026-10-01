import { randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { Env } from './config.js';

export const validApiKey = (key: unknown): key is string => typeof key === 'string' && /^[\x21-\x7e]{8,1024}$/.test(key);
export const credentialsDir = (env: Env): string => {
  const base = env['XDG_CONFIG_HOME'] ?? join(env['HOME'] || homedir(), '.config');
  if (!isAbsolute(base)) throw new Error('Jev configuration directory must be absolute');
  return join(base, 'jev-gate', 'auth');
};
export const credentialsPath = (env: Env): string => join(credentialsDir(env), 'credentials.json');

/** Only Jev-owned files use this writer. Never rewrite a host's settings with it. */
export const privateDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error('Jev directory must be private');
};
export const readPrivateJson = (path: string): Record<string, unknown> | null => {
  try {
    const parent = lstatSync(dirname(path));
    const stat = lstatSync(path);
    if (parent.isSymbolicLink() || !parent.isDirectory() || parent.mode & 0o077 || !stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 16 * 1024) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } finally { closeSync(fd); }
  } catch { return null; }
};
export const writePrivateJson = (path: string, value: Record<string, unknown>): void => {
  privateDirectory(dirname(path));
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('Jev file is a symlink'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(tmp, path); } finally { rmSync(tmp, { force: true }); }
};

/** Explicit input is authoritative, including an invalid value: never silently use another owner's key. */
export const resolveApiKey = (env: Env): string | undefined => {
  for (const name of ['CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY', 'TYPESAFE_API_KEY']) {
    const key = env[name];
    if (key !== undefined && key.trim() !== '') return validApiKey(key) ? key : undefined;
  }
  try { const key = readPrivateJson(credentialsPath(env))?.['apiKey']; return validApiKey(key) ? key : undefined; }
  catch { return undefined; }
};
export const saveApiKey = (env: Env, key: unknown): void => {
  if (!validApiKey(key)) throw new Error('Invalid Jev API key format');
  writePrivateJson(credentialsPath(env), { version: 1, apiKey: key });
};
export const withApiKey = (env: Env): Env => {
  const key = resolveApiKey(env);
  return { ...env, TYPESAFE_API_KEY: key };
};
