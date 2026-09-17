import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Config, GateMode } from './types.js';

export const DEFAULT_CONFIG: Config = {
  version: 3,
  mode: 'auto',
  jevModel: 'jev-1.13.0',
  requestDeadlineMs: 3000,
  routeConfidenceFloor: 0.8,
  uncertainTier: 'fable',
  opusModel: 'opus',
  frontierModel: 'fable',
};

/** hooks/hooks.json declares timeout 5; the internal HTTP deadline must leave headroom under it. */
export const NATIVE_HOOK_TIMEOUT_MS = 5000;
export const MAX_REQUEST_DEADLINE_MS = 4000;
/** Trusted model identifiers only: no whitespace, shell characters or free text reach the API. */
export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const MODES: readonly GateMode[] = ['off', 'enrich', 'auto'];
const CONFIG_KEYS = new Set<string>([
  'version',
  'mode',
  'jevModel',
  'requestDeadlineMs',
  'routeConfidenceFloor',
  'uncertainTier',
  'opusModel',
  'frontierModel',
]);
const LEGACY_KEYS = ['jev', 'worker', 'frontier', 'max_input_bytes', 'max_response_bytes'];

export type ConfigResult =
  | { ok: true; config: Config; source: string }
  | { ok: false; error: string; source: string };

export type Env = Record<string, string | undefined>;

export const resolveConfigPath = (env: Env): string =>
  env['JEV_GATE_CONFIG'] && env['JEV_GATE_CONFIG'].length > 0
    ? env['JEV_GATE_CONFIG']
    : join(env['HOME'] && env['HOME'].length > 0 ? env['HOME'] : homedir(), '.config', 'jev-gate', 'config.json');

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const validateConfig = (raw: unknown): { ok: true; config: Config } | { ok: false; error: string } => {
  if (!isRecord(raw)) return { ok: false, error: 'config must be a JSON object' };
  const legacy = LEGACY_KEYS.filter((k) => k in raw);
  if (raw['version'] !== 3 || legacy.length > 0) {
    return {
      ok: false,
      error: `config is not a v3 layout (version=${String(raw['version'])}${legacy.length ? `, legacy keys: ${legacy.join(',')}` : ''}); v3 expects {"version":3,"mode":"auto",...} and never mixes v1/v2 worker/frontier entries`,
    };
  }
  const unknown = Object.keys(raw).filter((k) => !CONFIG_KEYS.has(k));
  if (unknown.length > 0) return { ok: false, error: `unknown config keys: ${unknown.join(',')}` };

  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(raw)) merged[k] = raw[k];
  return checkFields(merged);
};

const checkFields = (c: Record<string, unknown>): { ok: true; config: Config } | { ok: false; error: string } => {
  const mode = c['mode'];
  if (typeof mode !== 'string' || !MODES.includes(mode as GateMode)) return { ok: false, error: 'mode must be off|enrich|auto' };
  for (const key of ['jevModel', 'opusModel', 'frontierModel'] as const) {
    const v = c[key];
    if (typeof v !== 'string' || !MODEL_NAME_RE.test(v)) return { ok: false, error: `${key} must match ${MODEL_NAME_RE.source}` };
  }
  const deadline = c['requestDeadlineMs'];
  if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= 0 || deadline > MAX_REQUEST_DEADLINE_MS) {
    return { ok: false, error: `requestDeadlineMs must be a finite number in (0, ${MAX_REQUEST_DEADLINE_MS}] (native hook timeout is ${NATIVE_HOOK_TIMEOUT_MS}ms)` };
  }
  const floor = c['routeConfidenceFloor'];
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0 || floor > 1) {
    return { ok: false, error: 'routeConfidenceFloor must be a finite number in [0, 1]' };
  }
  const uncertainTier = c['uncertainTier'];
  if (uncertainTier !== 'opus' && uncertainTier !== 'fable') return { ok: false, error: 'uncertainTier must be opus|fable' };
  return {
    ok: true,
    config: {
      version: 3,
      mode: mode as GateMode,
      jevModel: c['jevModel'] as string,
      requestDeadlineMs: deadline,
      routeConfidenceFloor: floor,
      uncertainTier,
      opusModel: c['opusModel'] as string,
      frontierModel: c['frontierModel'] as string,
    },
  };
};

export const loadConfig = (env: Env, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): ConfigResult => {
  const path = resolveConfigPath(env);
  let base: Config;
  let source: string;
  let text: string | null = null;
  try {
    text = readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return { ok: false, error: `cannot read config: ${code ?? 'unknown'}`, source: path };
    if (env['JEV_GATE_CONFIG']) return { ok: false, error: 'JEV_GATE_CONFIG points to a missing file', source: path };
  }
  if (text === null) {
    base = DEFAULT_CONFIG;
    source = 'defaults';
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: 'config is not valid JSON', source: path };
    }
    const v = validateConfig(parsed);
    if (!v.ok) return { ok: false, error: v.error, source: path };
    base = v.config;
    source = path;
  }
  const modeOverride = env['JEV_GATE_MODE'];
  if (modeOverride !== undefined && modeOverride !== '') {
    if (!MODES.includes(modeOverride as GateMode)) return { ok: false, error: 'JEV_GATE_MODE must be off|enrich|auto', source };
    return { ok: true, config: { ...base, mode: modeOverride as GateMode }, source };
  }
  return { ok: true, config: base, source };
};
