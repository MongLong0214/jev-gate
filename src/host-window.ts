import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Env } from './config.js';

/**
 * #48 P0-1: the host's own auto-compaction window, read the way the host itself resolves it -- env beats settings,
 * observed on this machine 2026-09-20->27 (env wins even when a settings file also sets it). This never asks Jev and
 * never guesses: a value this cannot establish is `null`, and the caller decides what to do with unknown, the same
 * rule `depth.ts` already uses for an unreadable transcript.
 */

/** A settings file larger than this is not read; a host settings file this large is not the kind we are looking for. */
export const HOST_WINDOW_MAX_BYTES = 1024 * 1024;

export type HostWindowResult = { tokens: number; source: string } | { tokens: null; source: 'unknown' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositiveSafeInteger = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

const fromEnv = (env: Env): number | null => {
  const raw = env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'];
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return isPositiveSafeInteger(n) ? n : null;
};

/** One candidate file. Never throws: missing, oversized, unreadable, non-JSON and non-object all read as "no window here". */
const readSettingsWindow = (path: string): number | null => {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > HOST_WINDOW_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) return null;
    const w = parsed['autoCompactWindow'];
    return isPositiveSafeInteger(w) ? w : null;
  } catch {
    return null;
  }
};

/**
 * Precedence (first valid wins), matching the host's own resolution order: env, then project-local settings (local
 * before shared, so an uncommitted override wins over a committed one), then user settings. `cwd` is the tool call's
 * own `cwd`, not `process.cwd()` -- the hook runs as a child of the host and its cwd is the one the host reported.
 */
export const readHostCompactWindow = (env: Env, cwd: string | null | undefined): HostWindowResult => {
  const envWindow = fromEnv(env);
  if (envWindow !== null) return { tokens: envWindow, source: 'env' };

  const candidates: string[] = [];
  if (typeof cwd === 'string' && cwd.length > 0) {
    candidates.push(join(cwd, '.claude', 'settings.local.json'));
    candidates.push(join(cwd, '.claude', 'settings.json'));
  }
  const configDir = env['CLAUDE_CONFIG_DIR'] && env['CLAUDE_CONFIG_DIR'].length > 0 ? env['CLAUDE_CONFIG_DIR'] : join(env['HOME'] && env['HOME'].length > 0 ? env['HOME'] : homedir(), '.claude');
  candidates.push(join(configDir, 'settings.json'));

  for (const path of candidates) {
    const tokens = readSettingsWindow(path);
    if (tokens !== null) return { tokens, source: `settings:${path}` };
  }
  return { tokens: null, source: 'unknown' };
};
