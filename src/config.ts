import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ConfigV4, Mode, Tier } from './types.js';
import { MODES, TIERS } from './types.js';

export const DEFAULT_CONFIG: ConfigV4 = {
  version: 4,
  mode: 'off',
  jevModel: 'jev-1.13.0',
  requestDeadlineMs: 3000,
  routeConfidenceFloor: 0.8,
  models: { sonnet: 'sonnet', opus: 'opus', fable: 'fable' },
};

/** hooks/hooks.json declares timeout 5; the internal HTTP deadline must leave headroom under it. */
export const NATIVE_HOOK_TIMEOUT_MS = 5000;
export const MAX_REQUEST_DEADLINE_MS = 4000;
/** Trusted model identifiers only: no whitespace, shell characters or free text reach the host or the API. */
export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const V4_KEYS = new Set<string>(['version', 'mode', 'jevModel', 'requestDeadlineMs', 'routeConfidenceFloor', 'models']);
const V3_MARKERS = ['uncertainTier', 'opusModel', 'frontierModel'];

export const MIGRATION_SAMPLE = `{
  "version": 4,
  "mode": "off",
  "jevModel": "jev-1.13.0",
  "requestDeadlineMs": 3000,
  "routeConfidenceFloor": 0.8,
  "models": { "sonnet": "sonnet", "opus": "opus", "fable": "fable" }
}`;

export type Env = Record<string, string | undefined>;

export type ConfigResult =
  | { ok: true; config: ConfigV4; source: string }
  | { ok: false; error: string; source: string };

export const resolveConfigPath = (env: Env): string =>
  env['JEV_GATE_CONFIG'] && env['JEV_GATE_CONFIG'].length > 0
    ? env['JEV_GATE_CONFIG']
    : join(env['HOME'] && env['HOME'].length > 0 ? env['HOME'] : homedir(), '.config', 'jev-gate', 'config.json');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const validateConfig = (raw: unknown): { ok: true; config: ConfigV4 } | { ok: false; error: string } => {
  if (!isRecord(raw)) return { ok: false, error: 'config must be a JSON object' };
  const v3 = V3_MARKERS.filter((k) => k in raw);
  if (raw['version'] === 3 || v3.length > 0 || raw['mode'] === 'enrich') {
    return { ok: false, error: `config uses the V3 layout (version=${String(raw['version'])}${v3.length ? `, keys ${v3.join(',')}` : ''}${raw['mode'] === 'enrich' ? ', mode enrich' : ''}); V4 reads only {"version":4,...} and does not merge V3 fields. Sample:\n${MIGRATION_SAMPLE}` };
  }
  if (raw['version'] !== 4) return { ok: false, error: `config version must be 4 (got ${String(raw['version'])})` };
  const unknown = Object.keys(raw).filter((k) => !V4_KEYS.has(k));
  if (unknown.length) return { ok: false, error: `unknown config keys: ${unknown.join(',')}` };
  const c: Record<string, unknown> = { ...DEFAULT_CONFIG, ...raw };
  const mode = c['mode'];
  if (typeof mode !== 'string' || !MODES.includes(mode as Mode)) return { ok: false, error: 'mode must be off|native|auto' };
  const jevModel = c['jevModel'];
  if (typeof jevModel !== 'string' || !MODEL_NAME_RE.test(jevModel)) return { ok: false, error: `jevModel must match ${MODEL_NAME_RE.source}` };
  const deadline = c['requestDeadlineMs'];
  if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= 0 || deadline > MAX_REQUEST_DEADLINE_MS) {
    return { ok: false, error: `requestDeadlineMs must be in (0, ${MAX_REQUEST_DEADLINE_MS}] under the ${NATIVE_HOOK_TIMEOUT_MS}ms native hook timeout` };
  }
  const floor = c['routeConfidenceFloor'];
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0 || floor > 1) return { ok: false, error: 'routeConfidenceFloor must be a finite number in [0, 1]' };
  const modelsRaw = c['models'];
  if (!isRecord(modelsRaw)) return { ok: false, error: 'models must be an object with sonnet/opus/fable' };
  const extra = Object.keys(modelsRaw).filter((k) => !(TIERS as readonly string[]).includes(k));
  if (extra.length) return { ok: false, error: `models has unknown tiers: ${extra.join(',')}` };
  const models = { ...DEFAULT_CONFIG.models } as Record<Tier, string>;
  for (const tier of TIERS) {
    if (!(tier in modelsRaw)) continue;
    const id = modelsRaw[tier];
    if (typeof id !== 'string' || !MODEL_NAME_RE.test(id)) return { ok: false, error: `models.${tier} must match ${MODEL_NAME_RE.source}` };
    models[tier] = id;
  }
  return { ok: true, config: { version: 4, mode: mode as Mode, jevModel, requestDeadlineMs: deadline, routeConfidenceFloor: floor, models } };
};

/**
 * Explicit JEV_GATE_MODE=off returns before any file is read, so a broken config can never enable routing.
 * Otherwise the optional file is loaded and validated as V4 only; JEV_GATE_MODE overrides just the mode.
 */
export const loadConfig = (env: Env, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): ConfigResult => {
  const modeEnv = env['JEV_GATE_MODE'];
  if (modeEnv === 'off') return { ok: true, config: { ...DEFAULT_CONFIG, mode: 'off' }, source: 'env:off' };
  if (modeEnv !== undefined && modeEnv !== '' && !MODES.includes(modeEnv as Mode)) return { ok: false, error: 'JEV_GATE_MODE must be off|native|auto', source: 'env' };
  const path = resolveConfigPath(env);
  let text: string | null = null;
  try {
    text = readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return { ok: false, error: `cannot read config: ${code ?? 'unknown'}`, source: path };
    if (env['JEV_GATE_CONFIG']) return { ok: false, error: 'JEV_GATE_CONFIG points to a missing file', source: path };
  }
  let base: ConfigV4 = DEFAULT_CONFIG;
  let source = 'defaults';
  if (text !== null) {
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
  if (modeEnv === 'native' || modeEnv === 'auto') return { ok: true, config: { ...base, mode: modeEnv }, source };
  return { ok: true, config: base, source };
};
