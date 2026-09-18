import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ConfigV5, Mode, PlannerTier, RouteQuestionShape, Tier } from './types.js';
import { MODES, PLANNER_TIERS, ROUTE_QUESTION_SHAPES, TIERS } from './types.js';

export const DEFAULT_CONFIG: ConfigV5 = {
  version: 5,
  mode: 'off',
  jevModel: 'jev-1.13.0',
  requestDeadlineMs: 3000,
  admissionConfidenceFloor: 0.8,
  routeConfidenceFloor: 0.8,
  resultConfidenceFloor: 0.8,
  plannerDefaultTier: 'deep',
  models: { fast: 'haiku', standard: 'sonnet', deep: 'opus', frontier: 'fable' },
  // T5: one worker by default. A declared deliverable is a planner's claim, not an enforced write boundary, and no
  // measurement yet shows parallel dispatch is faster here, so concurrency is opt-in rather than advertised.
  maxParallelWorkers: 1,
  guardAllowTools: [],
  // Optional in a config file: absent keeps the shipped composite Gate B question.
  routeQuestionShape: 'composite',
};

/**
 * hooks/hooks.json declares timeout 5, and a PreToolUse killed at that timeout fails open, so the whole dispatch has to
 * fit inside 5000 ms: node startup (~150 ms) + at most two lock acquisitions (2 x 300 ms deadline, A7) + one HTTP call
 * + state writes. 3500 ms of HTTP leaves ~1050 ms for everything else.
 */
export const NATIVE_HOOK_TIMEOUT_MS = 5000;
export const MAX_REQUEST_DEADLINE_MS = 3500;
export const MAX_PARALLEL_WORKERS_LIMIT = 16;
/** Trusted model identifiers only: no whitespace, shell characters or free text reach the host or the API. */
export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_:-]{0,63}$/;

const V5_KEYS = new Set<string>([
  'version',
  'mode',
  'jevModel',
  'requestDeadlineMs',
  'admissionConfidenceFloor',
  'routeConfidenceFloor',
  'resultConfidenceFloor',
  'plannerDefaultTier',
  'models',
  'maxParallelWorkers',
  'guardAllowTools',
  'routeQuestionShape',
]);
const LEGACY_MARKERS = ['uncertainTier', 'opusModel', 'frontierModel', 'confidenceFloor'];
/** `resultConfidenceFloor` is a deprecated no-op (T11): it is still validated so a deployed file loads, and read by nothing. */
const FLOOR_KEYS = ['admissionConfidenceFloor', 'routeConfidenceFloor', 'resultConfidenceFloor'] as const;

export const MIGRATION_SAMPLE = `{
  "version": 5,
  "mode": "off",
  "jevModel": "jev-1.13.0",
  "requestDeadlineMs": 3000,
  "admissionConfidenceFloor": 0.8,
  "routeConfidenceFloor": 0.8,
  "resultConfidenceFloor": 0.8,
  "plannerDefaultTier": "deep",
  "models": { "fast": "haiku", "standard": "sonnet", "deep": "opus", "frontier": "fable" },
  "maxParallelWorkers": 1,
  "guardAllowTools": []
}`;

export type Env = Record<string, string | undefined>;

export type ConfigResult = { ok: true; config: ConfigV5; source: string } | { ok: false; error: string; source: string };

export const resolveConfigPath = (env: Env): string =>
  env['JEV_GATE_CONFIG'] && env['JEV_GATE_CONFIG'].length > 0
    ? env['JEV_GATE_CONFIG']
    : join(env['HOME'] && env['HOME'].length > 0 ? env['HOME'] : homedir(), '.config', 'jev-gate', 'config.json');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** V5 sends more data to TypeSafe than V4 did, so a V3/V4 file is rejected with a sample rather than reinterpreted (D11). */
export const validateConfig = (raw: unknown): { ok: true; config: ConfigV5 } | { ok: false; error: string } => {
  if (!isRecord(raw)) return { ok: false, error: 'config must be a JSON object' };
  const legacy = LEGACY_MARKERS.filter((k) => k in raw);
  if (raw['version'] === 3 || raw['version'] === 4 || legacy.length > 0 || raw['mode'] === 'enrich') {
    return {
      ok: false,
      error: `config uses a pre-V5 layout (version=${String(raw['version'])}${legacy.length ? `, keys ${legacy.join(',')}` : ''}${raw['mode'] === 'enrich' ? ', mode enrich' : ''}); V5 reads only {"version":5,...} and does not merge older fields. Sample:\n${MIGRATION_SAMPLE}`,
    };
  }
  if (raw['version'] !== 5) return { ok: false, error: `config version must be 5 (got ${String(raw['version'])}). Sample:\n${MIGRATION_SAMPLE}` };
  const unknown = Object.keys(raw).filter((k) => !V5_KEYS.has(k));
  if (unknown.length) return { ok: false, error: `unknown config keys: ${unknown.join(',')}` };
  const c: Record<string, unknown> = { ...DEFAULT_CONFIG, ...raw };
  const mode = c['mode'];
  if (typeof mode !== 'string' || !MODES.includes(mode as Mode)) return { ok: false, error: 'mode must be off|native|auto|context' };
  const jevModel = c['jevModel'];
  if (typeof jevModel !== 'string' || !MODEL_NAME_RE.test(jevModel)) return { ok: false, error: `jevModel must match ${MODEL_NAME_RE.source}` };
  const deadline = c['requestDeadlineMs'];
  if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= 0 || deadline > MAX_REQUEST_DEADLINE_MS) {
    return { ok: false, error: `requestDeadlineMs must be in (0, ${MAX_REQUEST_DEADLINE_MS}] under the ${NATIVE_HOOK_TIMEOUT_MS}ms native hook timeout` };
  }
  const floors: Record<string, number> = {};
  for (const key of FLOOR_KEYS) {
    const v = c[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) return { ok: false, error: `${key} must be a finite number in (0, 1]` };
    floors[key] = v;
  }
  const plannerDefaultTier = c['plannerDefaultTier'];
  if (typeof plannerDefaultTier !== 'string' || !PLANNER_TIERS.includes(plannerDefaultTier as PlannerTier)) {
    return { ok: false, error: 'plannerDefaultTier must be deep|frontier' };
  }
  const modelsRaw = c['models'];
  if (!isRecord(modelsRaw)) return { ok: false, error: 'models must be an object with fast/standard/deep/frontier' };
  const extra = Object.keys(modelsRaw).filter((k) => !(TIERS as readonly string[]).includes(k));
  if (extra.length) return { ok: false, error: `models has unknown tiers: ${extra.join(',')}. Sample:\n${MIGRATION_SAMPLE}` };
  const models = { ...DEFAULT_CONFIG.models } as Record<Tier, string>;
  for (const tier of TIERS) {
    if (!(tier in modelsRaw)) continue;
    const id = modelsRaw[tier];
    if (typeof id !== 'string' || !MODEL_NAME_RE.test(id)) return { ok: false, error: `models.${tier} must match ${MODEL_NAME_RE.source}` };
    models[tier] = id;
  }
  const cap = c['maxParallelWorkers'];
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > MAX_PARALLEL_WORKERS_LIMIT) {
    return { ok: false, error: `maxParallelWorkers must be an integer in [1, ${MAX_PARALLEL_WORKERS_LIMIT}]` };
  }
  // Absent means composite, so a deployed V5 file keeps its behaviour without being edited (§4).
  // Absence defaults; an explicit wrong value is an error. `??` would have turned a null in the file into composite.
  const shape = 'routeQuestionShape' in c ? c['routeQuestionShape'] : 'composite';
  if (typeof shape !== 'string' || !ROUTE_QUESTION_SHAPES.includes(shape as RouteQuestionShape)) {
    return { ok: false, error: `routeQuestionShape must be one of ${ROUTE_QUESTION_SHAPES.join(', ')}` };
  }

  const allow = c['guardAllowTools'];
  if (!Array.isArray(allow) || allow.some((t) => typeof t !== 'string' || !TOOL_NAME_RE.test(t))) {
    return { ok: false, error: `guardAllowTools must be an array of tool names matching ${TOOL_NAME_RE.source}` };
  }
  return {
    ok: true,
    config: {
      version: 5,
      mode: mode as Mode,
      jevModel,
      requestDeadlineMs: deadline,
      admissionConfidenceFloor: floors['admissionConfidenceFloor'] as number,
      routeConfidenceFloor: floors['routeConfidenceFloor'] as number,
      resultConfidenceFloor: floors['resultConfidenceFloor'] as number,
      plannerDefaultTier: plannerDefaultTier as PlannerTier,
      models,
      maxParallelWorkers: cap,
      guardAllowTools: allow as string[],
      routeQuestionShape: shape as RouteQuestionShape,
    },
  };
};

/**
 * Explicit JEV_GATE_MODE=off returns before any file is read, so a broken config can never enable routing.
 * Otherwise the optional file is loaded and validated as V5 only; JEV_GATE_MODE overrides just the mode.
 * `context` is a mode value, not a new config version: version stays 5 and every deployed V5 file keeps loading (§4).
 */
export const loadConfig = (env: Env, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): ConfigResult => {
  const modeEnv = env['JEV_GATE_MODE'];
  if (modeEnv === 'off') return { ok: true, config: { ...DEFAULT_CONFIG, mode: 'off' }, source: 'env:off' };
  if (modeEnv !== undefined && modeEnv !== '' && !MODES.includes(modeEnv as Mode)) return { ok: false, error: 'JEV_GATE_MODE must be off|native|auto|context', source: 'env' };
  const path = resolveConfigPath(env);
  let text: string | null = null;
  try {
    text = readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return { ok: false, error: `cannot read config: ${code ?? 'unknown'}`, source: path };
    if (env['JEV_GATE_CONFIG']) return { ok: false, error: 'JEV_GATE_CONFIG points to a missing file', source: path };
  }
  let base: ConfigV5 = DEFAULT_CONFIG;
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
  if (modeEnv === 'native' || modeEnv === 'auto' || modeEnv === 'context') return { ok: true, config: { ...base, mode: modeEnv }, source };
  return { ok: true, config: base, source };
};
