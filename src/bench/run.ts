import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { isSubscriptionOAuth, parseAuthStatus, subagentModelOverride, AUTH_CONFLICT_ENV, type CommandResult } from '../auth.js';
import { DENIALS_BEFORE_STOP } from '../brief.js';
import { DEFAULT_CONFIG, loadConfig } from '../config.js';
import { OWNED_AGENTS, type ConfigV5, type Tier } from '../types.js';
import { gradeDir, type Grade } from './checker.js';
import { canonicalize, copyTree, createExclusiveDir, isInside, isSafeId, overlaps, type SnapshotReport } from './paths.js';
import { estimateJevCostUsd, modelFamily, parseModelUsage, safeSum, tokenCount, type ModelUsage } from './usage.js';

/**
 * ADR A15 product arms plus the A16 diagnostic arm. `fixed_hierarchy` (V4) is retired from the plan and from `--arms`;
 * the report still reads runs that contain it, because a retired arm is a fact about an old run, not a reason to stop
 * reading it.
 */
export type Arm = 'sonnet_native' | 'frontier_native' | 'native_hierarchy' | 'orchestrated_control' | 'frontier_orchestrated' | 'jev_hierarchy' | 'jev_single' | 'jev_forced_orchestration';
/** The only variables a measured session inherits; everything else, including the parent's CLAUDE_* settings, is dropped. */
export const KEEP_ENV: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'TZ', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'TYPESAFE_API_KEY'];
/** FAKE_CLAUDE_* is the test double's control channel; a real session has none, so passing it through changes nothing. */
const KEEP_ENV_PREFIX = 'FAKE_CLAUDE_';
const keepEnvVar = (key: string): boolean => KEEP_ENV.includes(key) || key.startsWith(KEEP_ENV_PREFIX);

export const ALL_ARMS: readonly Arm[] = ['sonnet_native', 'frontier_native', 'native_hierarchy', 'orchestrated_control', 'frontier_orchestrated', 'jev_hierarchy', 'jev_single', 'jev_forced_orchestration'];

export interface ArmSpec {
  arm: Arm;
  rootModel: string;
  plugin: boolean;
  mode: 'native' | 'auto' | null;
  /** A9/A15/A16: forced orchestration through the same state, guard, profiles and cap. */
  experimentAdmission: 'orchestrated' | null;
  /**
   * A16: a diagnostic arm answers a mechanism question and carries no product claim. Gate A calibration put the pilot
   * jobs below the admission floor, so this arm keeps Gate B and C measurable without tuning the floor on pilot data.
   */
  diagnostic: boolean;
  /**
   * A19: the arm runs the same frozen config with `admittedShape` overridden, written per cell so the file the cell
   * actually loaded is on disk beside its trace and its sha256 is recorded in the cell. Every other key is the frozen
   * one, so the two plugin arms differ in this key and nothing else.
   *
   * An override rather than a second run: a run freezes one config, so measuring this shape separately would compare
   * two runs with different frozen inputs, which is the comparison this harness exists to avoid.
   */
  admittedShape?: 'single';
}

export const armSpecs = (frontierModel: string): Record<Arm, ArmSpec> => ({
  sonnet_native: { arm: 'sonnet_native', rootModel: 'sonnet', plugin: false, mode: null, experimentAdmission: null, diagnostic: false },
  frontier_native: { arm: 'frontier_native', rootModel: frontierModel, plugin: false, mode: null, experimentAdmission: null, diagnostic: false },
  native_hierarchy: { arm: 'native_hierarchy', rootModel: 'sonnet', plugin: true, mode: 'native', experimentAdmission: null, diagnostic: false },
  orchestrated_control: { arm: 'orchestrated_control', rootModel: 'sonnet', plugin: true, mode: 'native', experimentAdmission: 'orchestrated', diagnostic: false },
  frontier_orchestrated: { arm: 'frontier_orchestrated', rootModel: frontierModel, plugin: true, mode: 'native', experimentAdmission: 'orchestrated', diagnostic: false },
  jev_hierarchy: { arm: 'jev_hierarchy', rootModel: 'sonnet', plugin: true, mode: 'auto', experimentAdmission: null, diagnostic: false },
  jev_single: { arm: 'jev_single', rootModel: 'sonnet', plugin: true, mode: 'auto', experimentAdmission: null, diagnostic: false, admittedShape: 'single' },
  jev_forced_orchestration: { arm: 'jev_forced_orchestration', rootModel: 'sonnet', plugin: true, mode: 'auto', experimentAdmission: 'orchestrated', diagnostic: true },
});

export interface CodingCase {
  id: string;
  group: string;
  fixtureDir: string;
  request: string;
  /**
   * Prompts sent in the same session before `request`. Their purpose is depth: a gate that reads how much context the
   * session is carrying (`src/depth.ts`) sees a fresh session when the priming happens inside the job turn, which is
   * what every earlier loaded case did. A primed case sends its prompts over stream-json input and keeps session
   * persistence on, because without the transcript on disk the depth is unreadable -- measured: every prompt reads
   * depth_unknown with --no-session-persistence, and a real depth without it.
   *
   * More than one prompt is allowed for a measured reason: the host flushes a turn's usage line to the transcript
   * after the turn ends, and a job prompt submitted immediately behind the priming turn can read depth_unknown from a
   * file that does not have the line yet (observed 2026-09-19: the line carried timestamp 01:55:13.762 and the hook
   * two seconds later still saw none). A short confirming turn between the two costs almost nothing and gives the
   * write time to land.
   */
  prime: string[];
  setup: string[][];
  evaluationSetup: string[][];
  checkFile: string;
  /** checkFile relative to the manifest directory; used to resolve the frozen copy inside the run. */
  checkFileRel: string;
}

export interface Options {
  cases: string;
  out: string;
  execute: boolean;
  regrade: boolean;
  arms: Arm[];
  repetitions: number;
  maxSessions: number | null;
  timeoutMs: number;
  maxTurns: number;
  seed: number;
  pluginDir: string;
  claude: string;
  settingSources: string;
  permissionMode: string;
  allowedTools: string;
  frontierModel: string;
  allowEnvConflicts: boolean;
  /** Case ids to run from the manifest; empty means every case. Staging a run costs less than one big one. */
  only: string[];
}

export interface AgentCall {
  tool_use_id: string;
  subagent_type: string | null;
  has_model: boolean;
  model_param: string | null;
  run_in_background: boolean | null;
  control_keys: string[];
  resolved_models_stream: string[];
  result_is_error: boolean | null;
  pre: Record<string, unknown> | null;
  pre_intent: Record<string, unknown> | null;
  post: Record<string, unknown> | null;
  failure: Record<string, unknown> | null;
  record_conflicts: number;
  /** V5 union join: a call may be seen in the stream, in the hook records, or in both. */
  from_stream: boolean;
  from_records: boolean;
  role: 'worker' | 'planner' | null;
  called_tier: string | null;
  observed_model: string | null;
  /** Root effort as the host reported it to PostToolUse (A8); the child's own effort is not observable here. */
  root_effort: string | null;
  /** A2: a late result whose reservation belongs to a superseded generation. */
  orphaned: boolean;
  /** T6/B1: the model the final patch/preserve/pin policy required. Null when no record determines it. */
  target_model: string | null;
  /** T6: that required model against the model the host actually resolved. An unknown alias is neither. */
  target_model_match: 'match' | 'mismatch' | 'unknown';
  /** T6: whether the final policy moved the call off the model its original profile would have used. */
  target_model_changed: boolean | null;
  result_gate: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
}

/** One Jev gate group: attempts made, input tokens when every attempt reported them, and cost at the dated list price. */
export interface JevPhaseUsage {
  attempts: number;
  tokens: number | null;
  tokens_known: number;
  cost_usd: number | null;
}

export interface WorkerTierRecord {
  calls: number;
  proposed: Record<string, number>;
  observed_model: Record<string, number>;
  root_effort: Record<string, number>;
  patched: number;
  preserved: number;
  pinned: number;
}

/** Schema 5 additions (#28, ADR A13). Every field is observed; nothing is inferred from agent frontmatter. */
export interface GateV5 {
  admission: { attempted: boolean; known_not_sent: boolean; forced: boolean; decided: boolean | null; choice: string | null; confidence: number | null; decision: string | null; reason: string | null };
  guard_denials: number;
  continue_false: number;
  planner_calls: { requested: number; completed: number; tier_proposed: string | null; model_observed: string | null; plan_status: string | null; rev: number | null };
  worker_calls: Record<string, WorkerTierRecord>;
  receipts: { accept: number; incomplete: number; invalid: number; unknown: number; rework: number; replan: number };
  advisory: { accept: number; rework: number; replan: number; abstain: number; none: number };
  parallel: { reservation_overlap_max: number; observed_overlap_max: number };
  jev_requests: { admission: JevPhaseUsage; allocation: JevPhaseUsage; result: JevPhaseUsage; scope: JevPhaseUsage };
  outcome: string | null;
  /** A17: judgments made against judgments that changed the outcome; nine calls that changed nothing must read as nine. */
  influence: { judgments: number; changed_default: number };
  orphan_records: number;
  /** Cross-check (A13): recorded Gate B decisions whose applied tier disagrees with the observed model family. */
  decision_mismatch: number;
}

export interface CellRecord {
  schema: 5;
  job: string;
  group: string;
  arm: Arm;
  repetition: number;
  root_model_requested: string;
  plugin_expected: boolean;
  mode: 'native' | 'auto' | null;
  /** Retired V4 field, kept so a reader that knows only V4 cells still parses a V5 one. */
  experimental_allocation: string | null;
  experiment_admission: 'orchestrated' | null;
  diagnostic: boolean;
  /** Per-cell job state directory, so job state never touches the real HOME or another cell. */
  state_dir: string | null;
  /** A19: set when the arm overrode a config key; the path and hash of the file this cell actually loaded. */
  config_override: { path: string; sha256: string; admittedShape: string } | null;
  request_sha256: string;
  /** Set only for a primed case: the priming prompts sent before the job prompt in the same session. */
  prime_sha256: string[];
  /**
   * Primed cases only. `context_at_job_prompt` is the main session's context when the job prompt was submitted --
   * the number the depth gate reads, observed from the stream rather than claimed. `turn_totals_usd` is each turn's
   * cumulative `total_cost_usd`, so the priming turn can be subtracted from the job: the host reports the session
   * total on every result event, not that turn's own cost.
   */
  context_at_job_prompt: number | null;
  turn_totals_usd: number[];
  fixture_sha256: string | null;
  dispatch: { intent_at: string | null; spawn_observed_at: string | null; pid: number | null };
  started: boolean;
  not_started_reason: string | null;
  setup: Array<{ argv: string[]; exit: number | null; ms: number; error: string | null }>;
  spawn: { argv: string[]; cwd: string; env_added: string[]; env_stripped: string[] } | null;
  elapsed_ms: number | null;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  cancelled: boolean;
  stdout_lines: number;
  unparsed_lines: number;
  init: { model: string | null; plugins: string[]; plugin_errors: unknown[]; jev_gate_loaded: boolean; agents: string[] | null; permission_mode: string | null } | null;
  root_model_consistent: boolean | null;
  models_seen_main: string[];
  agent_calls: AgentCall[];
  api_retries: number;
  result: {
    subtype: string | null;
    is_error: boolean | null;
    duration_ms: number | null;
    num_turns: number | null;
    total_cost_usd: number | null;
    model_usage: ModelUsage | null;
    usage_status: 'ok' | 'absent' | 'malformed' | 'empty_after_inference' | 'no_result';
    permission_denials: number | null;
  } | null;
  gate: {
    prompt_injections: number;
    agent_calls: number;
    owned_calls: number;
    pinned: number;
    eligible_attempted: number;
    patched: number;
    preserved: number;
    preserve_reasons: Record<string, number>;
    skipped: Record<string, number>;
    attempt_unknown: number;
    missing_pre_records: number;
    jev_model: string | null;
    jev_input_tokens: number | null;
    jev_input_tokens_known: number;
    jev_cost_usd: number | null;
    gate_ms_total: number | null;
    hint_delivered: number;
    target_model_matches: number;
    target_model_mismatches: number;
    /** T6: calls whose required or observed model could not be normalized; neither a match nor a mismatch. */
    target_model_unknown: number;
  } & GateV5;
  final_snapshot: (SnapshotReport & { path: string }) | null;
  grade: Grade | null;
  grade_history: Array<{ at: string; grade: Grade | null }>;
}

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const nowMs = (): number => performance.now();
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const positiveInt = (name: string, v: string | undefined): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
};

export const parseArgs = (argv: string[]): Options => {
  const o: Options = {
    cases: '',
    out: '',
    execute: false,
    regrade: false,
    arms: [...ALL_ARMS],
    repetitions: 1,
    maxSessions: null,
    timeoutMs: 900_000,
    maxTurns: 60,
    seed: 42,
    pluginDir: root,
    claude: 'claude',
    settingSources: 'project,local',
    permissionMode: 'acceptEdits',
    allowedTools: 'Bash(node *),Bash(npm test),Bash(npm run test),Bash(ls *)',
    frontierModel: 'fable',
    allowEnvConflicts: false,
    only: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === '--cases') o.cases = next();
    else if (a === '--out') o.out = next();
    else if (a === '--execute') o.execute = true;
    else if (a === '--regrade') o.regrade = true;
    else if (a === '--allow-env-conflicts') o.allowEnvConflicts = true;
    else if (a === '--arms') {
      const arms = next().split(',').map((s) => s.trim()).filter(Boolean);
      const bad = arms.filter((x) => !(ALL_ARMS as readonly string[]).includes(x));
      if (bad.length || arms.length === 0 || new Set(arms).size !== arms.length) throw new Error(`--arms must be a unique subset of ${ALL_ARMS.join(',')}`);
      o.arms = arms as Arm[];
    } else if (a === '--only') {
      const ids = next().split(',').map((x) => x.trim()).filter(Boolean);
      if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('--only must be a unique, non-empty list of case ids');
      o.only = ids;
    } else if (a === '--repetitions') o.repetitions = positiveInt(a, next());
    else if (a === '--max-sessions') o.maxSessions = positiveInt(a, next());
    else if (a === '--timeout-ms') o.timeoutMs = positiveInt(a, next());
    else if (a === '--max-turns') o.maxTurns = positiveInt(a, next());
    else if (a === '--seed') o.seed = positiveInt(a, next());
    else if (a === '--plugin-dir') o.pluginDir = resolve(next());
    else if (a === '--claude') o.claude = next();
    else if (a === '--setting-sources') o.settingSources = next();
    else if (a === '--permission-mode') o.permissionMode = next();
    else if (a === '--allowed-tools') o.allowedTools = next();
    else if (a === '--frontier-model') {
      const m = next();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(m)) throw new Error('--frontier-model must be a plain model identifier');
      o.frontierModel = m;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!o.cases || !o.out) throw new Error('usage: run.js --cases <manifest> --out <new dir> [--arms a,b] [--repetitions N] [--execute --max-sessions N] | --regrade --cases <manifest> --out <existing run>');
  if (o.execute && o.maxSessions === null) throw new Error('--execute requires --max-sessions');
  if (o.execute && o.regrade) throw new Error('--regrade re-scores an existing run and never executes; drop --execute');
  return o;
};

export const loadManifest = (path: string): { cases: CodingCase[]; manifestDir: string; version: number } => {
  const abs = resolve(path);
  const parsed = JSON.parse(readFileSync(abs, 'utf8')) as unknown;
  if (!isRecord(parsed) || !(parsed['version'] === 3 || parsed['version'] === 4 || parsed['version'] === 5) || !Array.isArray(parsed['cases']) || parsed['cases'].length === 0) {
    throw new Error('manifest must be {version:3|4|5, cases:[…]} with at least one case');
  }
  const base = dirname(abs);
  const seen = new Set<string>();
  const cases = parsed['cases'].map((raw, idx) => {
    if (!isRecord(raw)) throw new Error(`case ${idx} is not an object`);
    const s = (k: string): string => {
      const v = raw[k];
      if (typeof v !== 'string' || v.length === 0) throw new Error(`case ${idx}: ${k} must be a non-empty string`);
      return v;
    };
    const id = s('id');
    if (!isSafeId(id)) throw new Error(`case ${idx}: id ${JSON.stringify(id)} is not a safe path component`);
    if (seen.has(id.toLowerCase())) throw new Error(`duplicate case id ${id} (case-insensitive)`);
    seen.add(id.toLowerCase());
    const cmds = (k: string): string[][] => {
      const v = raw[k] ?? [];
      if (!Array.isArray(v) || !v.every((c) => Array.isArray(c) && c.length > 0 && c.every((x) => typeof x === 'string'))) throw new Error(`case ${id}: ${k} must be string[][]`);
      return v as string[][];
    };
    const fixtureDir = resolve(base, s('fixtureDir'));
    const checkFile = resolve(base, s('checkFile'));
    if (!isInside(base, fixtureDir) || !isInside(base, checkFile)) throw new Error(`case ${id}: fixtureDir and checkFile must live under the manifest directory`);
    if (!existsSync(fixtureDir) || !statSync(fixtureDir).isDirectory()) throw new Error(`case ${id}: fixtureDir missing`);
    if (!existsSync(checkFile)) throw new Error(`case ${id}: checkFile missing`);
    const primeRaw = raw['prime'] ?? [];
    if (!Array.isArray(primeRaw) || primeRaw.some((x) => typeof x !== 'string' || x.length === 0)) throw new Error(`case ${id}: prime must be an array of non-empty strings`);
    const prime = primeRaw as string[];
    return { id, group: s('group'), fixtureDir, request: s('request'), prime, setup: cmds('setup'), evaluationSetup: cmds('evaluationSetup'), checkFile, checkFileRel: relative(base, checkFile) };
  });
  return { cases, manifestDir: base, version: parsed['version'] as number };
};

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const shuffledArms = (arms: readonly Arm[], seed: number, jobIndex: number, repetition: number): Arm[] => {
  const rng = mulberry32(seed * 1000 + jobIndex * 10 + repetition);
  const out = [...arms];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

export interface PlanRow {
  job: string;
  group: string;
  repetition: number;
  arms: Arm[];
}

export interface Plan {
  schema: 5;
  created_at: string;
  execute: boolean;
  manifest: string;
  manifest_version: number;
  cases: Array<{ id: string; group: string; fixtureDir: string; checkFile: string; setup: string[][]; evaluationSetup: string[][]; request: string; request_sha256: string; prime: string[]; prime_sha256: string[] }>;
  arms: ArmSpec[];
  repetitions: number;
  rows: PlanRow[];
  planned_cells: number;
  max_sessions: number | null;
  cli: Record<string, unknown>;
  /**
   * T8/B3: the configuration resolved once, before execution. `--execute` freezes exactly this object and points every
   * plugin child at the frozen copy, so the model mappings, floors, concurrency and deadlines recorded here are the
   * ones the run used. Null when the resolved configuration does not load; preflight then refuses to start.
   */
  effective_config: ConfigV5 | null;
  effective_config_source: string;
  effective_config_error: string | null;
  frozen_inputs: Record<string, unknown> | null;
  preflight: Preflight | null;
}

export const buildPlan = (o: Options, cases: CodingCase[], manifestVersion: number): Plan => {
  const specs = armSpecs(o.frontierModel);
  const rows: PlanRow[] = [];
  cases.forEach((cs, i) => {
    for (let rep = 1; rep <= o.repetitions; rep++) rows.push({ job: cs.id, group: cs.group, repetition: rep, arms: shuffledArms(o.arms, o.seed, i, rep) });
  });
  // The per-arm mode is the one deliberate override, so the file is read as if mode were auto; every other field
  // (models, floors, concurrency, deadline) is taken exactly as resolved.
  const effective = loadConfig({ ...process.env, JEV_GATE_MODE: 'auto' });
  return {
    schema: 5,
    created_at: new Date().toISOString(),
    execute: o.execute,
    manifest: resolve(o.cases),
    manifest_version: manifestVersion,
    cases: cases.map((c) => ({ id: c.id, group: c.group, fixtureDir: c.fixtureDir, checkFile: c.checkFile, setup: c.setup, evaluationSetup: c.evaluationSetup, request: c.request, request_sha256: sha256(c.request), prime: c.prime, prime_sha256: c.prime.map((t) => sha256(t)) })),
    arms: o.arms.map((a) => specs[a]),
    repetitions: o.repetitions,
    rows,
    planned_cells: rows.length * o.arms.length,
    max_sessions: o.maxSessions,
    cli: {
      claude: o.claude,
      plugin_dir: o.pluginDir,
      setting_sources: o.settingSources,
      permission_mode: o.permissionMode,
      allowed_tools: o.allowedTools,
      max_turns: o.maxTurns,
      timeout_ms: o.timeoutMs,
      seed: o.seed,
      frontier_model: o.frontierModel,
      launch_env: { CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
      effective_config_nonsecret: effective.ok ? { ...effective.config, source: effective.source } : { error: effective.error },
      note: 'Root models are CLI aliases; actual models come from system/init and modelUsage. User-scope settings are excluded for every arm via --setting-sources; user-level CLAUDE.md still loads equally in all arms. --max-turns bounds top-level turns, not every descendant request or subscription spend.',
    },
    effective_config: effective.ok ? effective.config : null,
    effective_config_source: effective.source,
    effective_config_error: effective.ok ? null : effective.error,
    frozen_inputs: null,
    preflight: null,
  };
};

interface Preflight {
  claude_version: string | null;
  auth: { loggedIn: boolean; authMethod: string | null; apiProvider: string | null; subscriptionType: string | null } | null;
  auth_reason: string | null;
  env_conflicts: string[];
  env_observed: Record<string, string | null>;
  typesafe_key_present: boolean;
  plugin_hook_present: boolean;
  errors: string[];
}

const runSync = (argv: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): CommandResult & { ms: number; stderr: string } => {
  const t = nowMs();
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8', shell: false, timeout: timeoutMs, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, signal: r.signal ?? null, stdout: r.stdout ?? '', error: r.error ? r.error.message : null, ms: Math.round(nowMs() - t), stderr: r.stderr ?? '' };
};

export const preflight = (o: Options, needsJev: boolean): Preflight => {
  const errors: string[] = [];
  const version = runSync([o.claude, '--version'], process.cwd(), 20_000);
  if (version.error || version.status !== 0) errors.push(`claude not runnable: ${version.error ?? `exit ${String(version.status)}`}`);
  const parsed = parseAuthStatus(runSync([o.claude, 'auth', 'status'], process.cwd(), 20_000));
  let auth: Preflight['auth'] = null;
  let auth_reason: string | null = null;
  if (!parsed.ok) {
    auth_reason = parsed.reason;
    errors.push(`cannot verify subscription OAuth: ${parsed.reason}`);
  } else {
    auth = parsed.status;
    if (!isSubscriptionOAuth(parsed.status)) errors.push(`auth is not claude.ai subscription OAuth (method=${String(parsed.status.authMethod)}, provider=${String(parsed.status.apiProvider)})`);
  }
  const authEnv = AUTH_CONFLICT_ENV.filter((k) => process.env[k]);
  if (authEnv.length) errors.push(`API-key/gateway/cloud env active (${authEnv.join(', ')})`);
  const override = subagentModelOverride(process.env);
  if ((override.concrete || override.force) && !o.allowEnvConflicts) errors.push('CLAUDE_CODE_SUBAGENT_MODEL/FORCE override would replace role models; unset it or pass --allow-env-conflicts');
  if (process.env['CLAUDE_CODE_FORK_SUBAGENT'] === '1') errors.push('CLAUDE_CODE_FORK_SUBAGENT=1 conflicts with the foreground launch profile');
  const observed = ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'JEV_GATE_CONFIG', 'JEV_GATE_STATE_DIR', 'JEV_GATE_EXPERIMENT_ADMISSION'];
  const env_observed: Record<string, string | null> = {};
  for (const k of observed) env_observed[k] = process.env[k] ?? null;
  const typesafe_key_present = Boolean(process.env['TYPESAFE_API_KEY']);
  if (needsJev && !typesafe_key_present) errors.push('TYPESAFE_API_KEY not set: the jev_hierarchy arm would only exercise key_missing preservation');
  const plugin_hook_present = existsSync(join(o.pluginDir, 'dist', 'hook.js')) && existsSync(join(o.pluginDir, 'hooks', 'hooks.json')) && existsSync(join(o.pluginDir, 'agents', 'worker.md'));
  if (!plugin_hook_present) errors.push(`plugin dir ${o.pluginDir} lacks dist/hook.js, hooks/hooks.json or agents/worker.md; run npm run build`);
  return { claude_version: version.status === 0 ? version.stdout.trim() : null, auth, auth_reason, env_conflicts: [...authEnv, ...(override.concrete || override.force ? ['CLAUDE_CODE_SUBAGENT_MODEL'] : [])], env_observed, typesafe_key_present, plugin_hook_present, errors };
};

const emptyJevPhase = (): JevPhaseUsage => ({ attempts: 0, tokens: null, tokens_known: 0, cost_usd: null });

const emptyGateV5 = (): GateV5 => ({
  admission: { attempted: false, known_not_sent: false, forced: false, decided: null, choice: null, confidence: null, decision: null, reason: null },
  guard_denials: 0,
  continue_false: 0,
  planner_calls: { requested: 0, completed: 0, tier_proposed: null, model_observed: null, plan_status: null, rev: null },
  worker_calls: {},
  receipts: { accept: 0, incomplete: 0, invalid: 0, unknown: 0, rework: 0, replan: 0 },
  advisory: { accept: 0, rework: 0, replan: 0, abstain: 0, none: 0 },
  parallel: { reservation_overlap_max: 0, observed_overlap_max: 0 },
  jev_requests: { admission: emptyJevPhase(), allocation: emptyJevPhase(), result: emptyJevPhase(), scope: emptyJevPhase() },
  outcome: null,
  influence: { judgments: 0, changed_default: 0 },
  orphan_records: 0,
  decision_mismatch: 0,
});

/** A planned cell before anything is observed. Exported so regressions can drive `observeEvent`/`ingestTraces` directly. */
export const emptyCell = (cs: CodingCase, spec: ArmSpec, repetition: number): CellRecord => ({
  schema: 5,
  job: cs.id,
  group: cs.group,
  arm: spec.arm,
  repetition,
  root_model_requested: spec.rootModel,
  plugin_expected: spec.plugin,
  config_override: null,
  mode: spec.mode,
  experimental_allocation: null,
  experiment_admission: spec.experimentAdmission,
  diagnostic: spec.diagnostic,
  state_dir: null,
  request_sha256: sha256(cs.request),
  prime_sha256: cs.prime.map((t) => sha256(t)),
  context_at_job_prompt: null,
  turn_totals_usd: [],
  fixture_sha256: null,
  dispatch: { intent_at: null, spawn_observed_at: null, pid: null },
  started: false,
  not_started_reason: null,
  setup: [],
  spawn: null,
  elapsed_ms: null,
  exit_code: null,
  signal: null,
  timed_out: false,
  cancelled: false,
  stdout_lines: 0,
  unparsed_lines: 0,
  init: null,
  root_model_consistent: null,
  models_seen_main: [],
  agent_calls: [],
  api_retries: 0,
  result: null,
  gate: { prompt_injections: 0, agent_calls: 0, owned_calls: 0, pinned: 0, eligible_attempted: 0, patched: 0, preserved: 0, preserve_reasons: {}, skipped: {}, attempt_unknown: 0, missing_pre_records: 0, jev_model: null, jev_input_tokens: null, jev_input_tokens_known: 0, jev_cost_usd: null, gate_ms_total: null, hint_delivered: 0, target_model_matches: 0, target_model_mismatches: 0, target_model_unknown: 0, ...emptyGateV5() },
  final_snapshot: null,
  grade: null,
  grade_history: [],
});

const CONTROL_KEYS = ['resume', 'agentId', 'agent_id', 'name', 'team_name', 'isolation', 'fork'];

const emptyAgentCall = (toolUseId: string): AgentCall => ({
  tool_use_id: toolUseId,
  subagent_type: null,
  has_model: false,
  model_param: null,
  run_in_background: null,
  control_keys: [],
  resolved_models_stream: [],
  result_is_error: null,
  pre: null,
  pre_intent: null,
  post: null,
  failure: null,
  record_conflicts: 0,
  from_stream: false,
  from_records: false,
  role: null,
  called_tier: null,
  observed_model: null,
  root_effort: null,
  orphaned: false,
  target_model: null,
  target_model_match: 'unknown',
  target_model_changed: null,
  result_gate: null,
  plan: null,
});

/**
 * The main session's context at the moment an event was produced, by the same definition `src/depth.ts` reads from the
 * transcript: cache reads + cache writes + fresh input. Only top-level turns count; a subagent's usage describes its
 * own context, not this session's.
 */
const contextOf = (message: Record<string, unknown>): number | null => {
  const usage = message['usage'];
  if (!isRecord(usage)) return null;
  let total = 0;
  let seen = false;
  for (const k of ['cache_read_input_tokens', 'cache_creation_input_tokens', 'input_tokens'] as const) {
    const v = usage[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    total += v;
    seen = true;
  }
  return seen ? total : null;
};
const lastMainContext = new WeakMap<CellRecord, number>();
const promptsSeen = new WeakMap<CellRecord, number>();

/** Folds one stream-json event into the record. Unknown shapes are ignored, never guessed. */
export const observeEvent = (cell: CellRecord, ev: unknown): void => {
  if (!isRecord(ev)) return;
  const type = ev['type'];
  if (type === 'system' && ev['subtype'] === 'init') {
    const plugins = Array.isArray(ev['plugins']) ? ev['plugins'].map((p) => (isRecord(p) ? (str(p['name']) ?? '') : String(p))) : [];
    const agentsRaw = ev['agents'];
    cell.init = {
      model: str(ev['model']),
      plugins,
      plugin_errors: Array.isArray(ev['plugin_errors']) ? ev['plugin_errors'] : [],
      jev_gate_loaded: plugins.includes('jev-gate'),
      agents: Array.isArray(agentsRaw) ? agentsRaw.map((a) => (isRecord(a) ? (str(a['name']) ?? JSON.stringify(a)) : String(a))) : null,
      permission_mode: str(ev['permissionMode']),
    };
    cell.root_model_consistent = cell.init.model ? cell.init.model.toLowerCase().includes(cell.root_model_requested.toLowerCase()) : null;
    return;
  }
  if (type === 'system' && ev['subtype'] === 'api_retry') {
    cell.api_retries++;
    return;
  }
  if (type === 'assistant') {
    const message = ev['message'];
    if (!isRecord(message)) return;
    const model = str(message['model']);
    const parent = str(ev['parent_tool_use_id']);
    if (parent === null) {
      const ctx = contextOf(message);
      if (ctx !== null) lastMainContext.set(cell, ctx);
      if (model && !cell.models_seen_main.includes(model)) cell.models_seen_main.push(model);
      for (const block of Array.isArray(message['content']) ? message['content'] : []) {
        if (!isRecord(block) || block['type'] !== 'tool_use' || block['name'] !== 'Agent') continue;
        const input = isRecord(block['input']) ? block['input'] : {};
        cell.agent_calls.push({
          ...emptyAgentCall(str(block['id']) ?? ''),
          subagent_type: str(input['subagent_type']),
          has_model: Object.prototype.hasOwnProperty.call(input, 'model'),
          model_param: str(input['model']),
          run_in_background: typeof input['run_in_background'] === 'boolean' ? input['run_in_background'] : null,
          control_keys: Object.keys(input).filter((k) => CONTROL_KEYS.includes(k)),
          from_stream: true,
        });
      }
    } else {
      const call = cell.agent_calls.find((c) => c.tool_use_id === parent);
      if (call && model && !call.resolved_models_stream.includes(model)) call.resolved_models_stream.push(model);
    }
    return;
  }
  if (type === 'user') {
    const message = ev['message'];
    /**
     * With --replay-user-messages the host echoes each prompt read from stdin as a user event whose content is a
     * plain string; a tool result is an array of blocks. The second such echo is the job prompt of a primed case, and
     * the context standing at the echo that follows the priming prompts is what the depth gate saw at the job prompt.
     */
    if (isRecord(message) && typeof message['content'] === 'string') {
      const n = (promptsSeen.get(cell) ?? 0) + 1;
      promptsSeen.set(cell, n);
      if (n === cell.prime_sha256.length + 1) cell.context_at_job_prompt = lastMainContext.get(cell) ?? null;
      return;
    }
    for (const block of isRecord(message) && Array.isArray(message['content']) ? message['content'] : []) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue;
      const call = cell.agent_calls.find((c) => c.tool_use_id === block['tool_use_id']);
      if (call) call.result_is_error = block['is_error'] === true;
    }
    return;
  }
  if (type === 'result') {
    const turnTotal = num(ev['total_cost_usd']);
    // Every turn reports the session total so far, so the list is cumulative and the job's own cost is a difference.
    if (turnTotal !== null) cell.turn_totals_usd.push(turnTotal);
    const inferenceObserved = cell.models_seen_main.length > 0 || cell.agent_calls.length > 0;
    const usage = parseModelUsage(ev, inferenceObserved);
    cell.result = {
      subtype: str(ev['subtype']),
      is_error: typeof ev['is_error'] === 'boolean' ? ev['is_error'] : null,
      duration_ms: num(ev['duration_ms']),
      num_turns: num(ev['num_turns']),
      total_cost_usd: num(ev['total_cost_usd']),
      model_usage: usage.ok ? usage.usage : null,
      usage_status: usage.ok ? 'ok' : usage.reason,
      permission_denials: Array.isArray(ev['permission_denials']) ? ev['permission_denials'].length : null,
    };
  }
};

const bump = (into: Record<string, number>, key: string): void => {
  into[key] = (into[key] ?? 0) + 1;
};

const timeOf = (r: Record<string, unknown> | null | undefined): number | null => {
  const t = r ? str(r['written_at']) : null;
  const ms = t === null ? NaN : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
};

/** Greatest number of intervals covering one instant; touching intervals (end == start) do not overlap. */
export const maxOverlap = (intervals: Array<[number, number]>): number => {
  const events = intervals.flatMap(([s, e]) => [[s, 1] as [number, number], [e, -1] as [number, number]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let max = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > max) max = current;
  }
  return max;
};

const emptyTier = (): WorkerTierRecord => ({ calls: 0, proposed: {}, observed_model: {}, root_effort: {}, patched: 0, preserved: 0, pinned: 0 });

/**
 * Joins the hook's V5 phase records to the stream's Agent calls as a union by tool_use_id: a call seen only in the
 * records (a paid attempt or a late result whose generation was superseded) stays visible instead of being dropped,
 * and a call seen only in the stream is reported as a missing record rather than as zero consumption.
 */
export const ingestTraces = (cell: CellRecord, traceDir: string, models: Record<Tier, string> = DEFAULT_CONFIG.models): void => {
  const records: Array<Record<string, unknown>> = [];
  if (existsSync(traceDir)) {
    for (const f of readdirSync(traceDir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const r = JSON.parse(readFileSync(join(traceDir, f), 'utf8')) as unknown;
        if (isRecord(r) && r['version'] === 5 && typeof r['phase'] === 'string') records.push(r);
      } catch {
        cell.gate.attempt_unknown++;
      }
    }
  }
  const g = cell.gate;
  const phase = (p: string): Array<Record<string, unknown>> => records.filter((r) => r['phase'] === p);
  const byId = (p: string, id: string): Array<Record<string, unknown>> => records.filter((r) => r['phase'] === p && r['tool_use_id'] === id);
  const answer = (r: Record<string, unknown> | null, key: string): Record<string, unknown> | null => {
    const answers = r && isRecord(r['answers']) ? r['answers'] : null;
    return answers && isRecord(answers[key]) ? (answers[key] as Record<string, unknown>) : null;
  };
  /** T6: the frozen configuration's model for a tier; a tier it does not map stays unknown. */
  const modelOfTier = (tier: string | null): string | null => (tier === null ? null : ((models[tier as Tier] as string | undefined) ?? null));
  /** T7: the id a gate call writes into both of its records; older records only have the tool_use_id. */
  const corrKey = (r: Record<string, unknown>): string | null => str(r['request_id']) ?? str(r['tool_use_id']);
  /**
   * T7: the last record by recorded event time, never by the random UUID in its filename. Missing or tied timestamps
   * leave the order unresolved, and an unresolved order is reported as unknown rather than guessed.
   */
  const lastByTime = <T extends Record<string, unknown>>(rows: T[]): T | null => {
    if (rows.length <= 1) return rows[0] ?? null;
    const times = rows.map(timeOf);
    if (times.some((t) => t === null)) return null;
    const max = Math.max(...(times as number[]));
    return times.filter((t) => t === max).length === 1 ? (rows[times.indexOf(max)] as T) : null;
  };
  let jevKnownAll = true;

  /** One Jev gate group. Unknown usage on any attempt leaves the group's tokens and cost null, never zero. */
  const account = (rows: Array<Record<string, unknown>>, intents: Array<Record<string, unknown>>, into: JevPhaseUsage): void => {
    const attempted = rows.filter((r) => r['attempted'] === true);
    into.attempts = attempted.length;
    let known = true;
    for (const r of attempted) {
      const jev = isRecord(r['jev']) ? r['jev'] : {};
      const usage = isRecord(jev['usage']) ? jev['usage'] : {};
      const tokens = tokenCount(usage['input_tokens']);
      if (tokens === null) known = false;
      else into.tokens_known += tokens;
      g.jev_model = g.jev_model ?? str(jev['model']);
      const http = isRecord(r['http']) ? r['http'] : {};
      const ms = num(http['duration_ms']);
      if (ms !== null) g.gate_ms_total = (g.gate_ms_total ?? 0) + ms;
    }
    for (const r of rows) {
      if (r['known_not_sent'] !== true) continue;
      bump(g.skipped, str(r['skip_code']) ?? str(r['reason']) ?? 'unknown');
    }
    // An intent with no result of its own is one paid-or-not attempt whose consumption is unknown. T7: the pairing key
    // is the per-call `request_id`; `invocation_id` differs per record and Gate A usually has no `tool_use_id`, so two
    // different admissions must never collapse into one. Records written before `request_id` keep the tool_use_id
    // fallback, and keyless ones pair by count alone, which reveals a missing result instead of hiding it.
    const pool = new Map<string, number>();
    let keylessResults = 0;
    for (const r of rows) {
      const k = corrKey(r);
      if (k === null) keylessResults++;
      else pool.set(k, (pool.get(k) ?? 0) + 1);
    }
    let unmatched = 0;
    let keylessIntents = 0;
    for (const i of intents) {
      const k = corrKey(i);
      if (k === null) {
        keylessIntents++;
        continue;
      }
      const left = pool.get(k) ?? 0;
      if (left > 0) pool.set(k, left - 1);
      else unmatched++;
    }
    unmatched += Math.max(0, keylessIntents - keylessResults);
    g.attempt_unknown += unmatched;
    if (unmatched > 0) known = false;
    if (!known) jevKnownAll = false;
    into.tokens = known ? into.tokens_known : null;
    into.cost_usd = into.tokens === null ? null : into.tokens === 0 ? 0 : estimateJevCostUsd(g.jev_model ?? 'jev-1.13.0', into.tokens);
  };

  // ---- Gate A
  const admissions = phase('admission_result');
  g.prompt_injections = admissions.length;
  const admission = lastByTime(admissions);
  if (admission === null && admissions.length > 0) {
    // The counts below still hold; only which admission decided this prompt is unresolved.
    g.admission = {
      attempted: admissions.some((r) => r['attempted'] === true),
      known_not_sent: admissions.every((r) => r['known_not_sent'] === true),
      forced: admissions.some((r) => r['forced'] === true),
      decided: null,
      choice: null,
      confidence: null,
      decision: null,
      reason: 'ambiguous_record_order',
    };
  }
  if (admission) {
    const execution = answer(admission, 'execution');
    // A17: every gate now records its decision nested under `decision`; records written before that are flat.
    const dec = isRecord(admission['decision']) ? admission['decision'] : admission;
    g.admission = {
      attempted: admission['attempted'] === true,
      known_not_sent: admission['known_not_sent'] === true,
      // A16: a forced generation is a bench control, not a Jev answer, and the admission table says so.
      forced: admission['forced'] === true,
      decided: typeof dec['decided'] === 'boolean' ? dec['decided'] : null,
      choice: execution ? str(execution['choice']) : null,
      confidence: execution ? num(execution['confidence']) : null,
      decision: str(dec['shape']) ?? str(dec['decision']),
      reason: str(dec['reason']) ?? str(admission['skip_code']),
    };
  }
  const admissionIntents = phase('admission_intent');
  account(admissions, admissionIntents, g.jev_requests.admission);
  // T7/B2: in auto every prompt reaches Gate A unless something says otherwise. A recorded bypass (known_not_sent, a
  // skip code, a forced admission) proves the zero; the plugin not loading proves it too. No record at all proves
  // nothing, so the admission stays unknown instead of becoming a free call.
  if (cell.mode === 'auto' && cell.started && cell.init?.jev_gate_loaded !== false && admissions.length === 0 && admissionIntents.length === 0) {
    g.attempt_unknown++;
    g.jev_requests.admission.tokens = null;
    g.jev_requests.admission.cost_usd = null;
    jevKnownAll = false;
  }

  // ---- guard (A6): a denial that reaches the threshold is the one that also returns continue:false
  const denied = phase('guard').filter((r) => r['allow'] === false);
  g.guard_denials = denied.length;
  // The hook records the stop it actually applied; older records without the field fall back to the denial count.
  g.continue_false = denied.filter((r) => (typeof r['stopped'] === 'boolean' ? r['stopped'] : (num(r['denials']) ?? 0) >= DENIALS_BEFORE_STOP - 1)).length;
  const stops = phase('stop');
  g.outcome = str(lastByTime(stops)?.['outcome'] ?? null);

  // ---- union of stream calls and record-only calls
  const callPhases = ['pre_intent', 'pre_result', 'post', 'failure', 'result_intent', 'result_result', 'plan'];
  const known = new Set(cell.agent_calls.map((c) => c.tool_use_id));
  for (const r of records) {
    if (!callPhases.includes(String(r['phase']))) continue;
    const id = str(r['tool_use_id']);
    if (id === null || known.has(id)) continue;
    known.add(id);
    cell.agent_calls.push({ ...emptyAgentCall(id), from_records: true });
  }
  g.agent_calls = cell.agent_calls.length;

  const reservationIntervals: Array<[number, number]> = [];
  const observedIntervals: Array<[number, number]> = [];
  for (const call of cell.agent_calls) {
    const id = call.tool_use_id;
    const pres = byId('pre_result', id);
    const intents = byId('pre_intent', id);
    const posts = byId('post', id);
    call.record_conflicts = Math.max(0, pres.length - 1) + Math.max(0, intents.length - 1) + Math.max(0, posts.length - 1);
    call.pre = pres[0] ?? null;
    call.pre_intent = intents[0] ?? null;
    call.post = posts[0] ?? null;
    call.failure = byId('failure', id)[0] ?? null;
    call.result_gate = byId('result_result', id)[0] ?? null;
    call.plan = byId('plan', id)[0] ?? null;
    call.from_records = call.from_records || Boolean(call.pre ?? call.pre_intent ?? call.post ?? call.failure ?? call.result_gate ?? call.plan);
    const owned = call.subagent_type !== null ? OWNED_AGENTS[call.subagent_type] : undefined;
    const intent = call.pre ?? call.pre_intent;
    const role = owned ? owned.role : (str(intent?.['role'] ?? null) ?? (call.plan ? 'planner' : null));
    call.role = role === 'worker' || role === 'planner' ? role : null;
    call.called_tier = owned ? owned.tier : str(intent?.['called_tier'] ?? null);
    if (owned) g.owned_calls++;
    if (call.has_model) g.pinned++;
    if (call.post) {
      const tr = isRecord(call.post['tool_response']) ? call.post['tool_response'] : {};
      call.observed_model = str(tr['resolvedModel']);
      call.root_effort = str(call.post['root_effort']);
      call.orphaned = call.post['matched'] === false;
      if (call.orphaned) g.orphan_records++;
      const verdict = str(call.post['verdict']);
      // A17: Gate C may demote an accept, so every receipt verdict has a bucket and the totals still add up.
      if (verdict !== null && Object.prototype.hasOwnProperty.call(g.receipts, verdict)) g.receipts[verdict as keyof typeof g.receipts]++;
      const gateC = isRecord(call.result_gate?.['decision']) ? (call.result_gate?.['decision'] as Record<string, unknown>) : null;
      const advisory = gateC ? (str(gateC['verdict']) ?? (str(gateC['reason']) === 'result_abstain' ? 'abstain' : 'none')) : str(call.post['advisory']);
      if (advisory === 'accept' || advisory === 'rework' || advisory === 'replan' || advisory === 'abstain') g.advisory[advisory]++;
      else if (verdict !== null) g.advisory.none++;
      const observedEnd = timeOf(call.post);
      const duration = num(tr['totalDurationMs']);
      if (observedEnd !== null && duration !== null) observedIntervals.push([observedEnd - duration, observedEnd]);
    }
    call.observed_model = call.observed_model ?? call.resolved_models_stream[0] ?? null;

    // T6/B1: the three facts are separate. Jev's answer lives in `answers`, the policy the hook applied lives in
    // `decision`, and the model the host resolved lives in the post record. The comparison that matters is the model
    // the final patch/preserve/pin policy required against the one actually observed; asking "did either differ from
    // the original?" lets original sonnet -> patched haiku -> executed opus pass as a match. A missing step is never
    // filled in from another, and normalization is only the alias mapping that already exists (modelFamily), so an
    // alias it does not know is unknown rather than a verdict.
    const gateDecision = isRecord(call.pre?.['decision']) ? (call.pre?.['decision'] as Record<string, unknown>) : null;
    const profileTier = call.called_tier ?? str(intent?.['default_tier'] ?? null);
    const profileModel = call.has_model ? call.model_param : modelOfTier(profileTier);
    // An eligible call in auto whose gate result was never recorded has no known final policy: whether the hook
    // patched it is exactly the missing step, so it is not assumed to have kept its profile.
    const policyUnknown = cell.mode === 'auto' && !call.has_model && call.pre === null && (call.pre_intent !== null || owned !== undefined);
    call.target_model = policyUnknown ? null : gateDecision !== null && str(gateDecision['action']) === 'patch' ? modelOfTier(str(gateDecision['tier'])) : profileModel;
    const wantedFamily = call.target_model === null ? 'unknown' : modelFamily(call.target_model);
    const gotFamily = call.observed_model === null ? 'unknown' : modelFamily(call.observed_model);
    call.target_model_match = wantedFamily === 'unknown' || gotFamily === 'unknown' ? 'unknown' : wantedFamily === gotFamily ? 'match' : 'mismatch';
    call.target_model_changed = call.target_model === null || profileModel === null ? null : wantedFamily !== modelFamily(profileModel);
    if (call.target_model_match === 'match') g.target_model_matches++;
    else if (call.target_model_match === 'mismatch') g.target_model_mismatches++;
    else g.target_model_unknown++;
    if (cell.mode === 'auto' && owned && !call.has_model && !call.pre && !call.pre_intent) {
      g.missing_pre_records++;
      jevKnownAll = false;
    }
    if (call.pre?.['attempted'] === true) g.eligible_attempted++;

    if (call.role === 'planner') {
      g.planner_calls.requested++;
      const proposed = answer(call.pre, 'planning_tier');
      const plannerDecision = isRecord(call.pre?.['decision']) ? (call.pre?.['decision'] as Record<string, unknown>) : null;
      if (proposed) g.planner_calls.tier_proposed = str(proposed['choice']);
      else if (plannerDecision) g.planner_calls.tier_proposed = str(plannerDecision['tier']);
      if (call.observed_model) g.planner_calls.model_observed = call.observed_model;
      if (call.plan) {
        if (str(call.plan['status']) === 'completed') g.planner_calls.completed++;
        g.planner_calls.plan_status = str(call.plan['outcome']);
        g.planner_calls.rev = num(call.plan['rev']);
      }
    } else if (call.role === 'worker' || call.called_tier !== null) {
      const tier = call.called_tier ?? 'unknown';
      const bucket = g.worker_calls[tier] ?? emptyTier();
      g.worker_calls[tier] = bucket;
      bucket.calls++;
      if (call.has_model) bucket.pinned++;
      const route = answer(call.pre, 'route');
      const decision = isRecord(call.pre?.['decision']) ? (call.pre?.['decision'] as Record<string, unknown>) : null;
      // A5: on `preserve` the recorded tier is the profile that was kept, so the proposal is read from the answer.
      bump(bucket.proposed, route ? (str(route['choice']) ?? 'invalid') : (str(decision?.['tier'] ?? null) ?? 'none'));
      bump(bucket.observed_model, call.observed_model ?? 'unknown');
      // A8: effort is recorded only where the host exposed it; frontmatter is never treated as an observation.
      bump(bucket.root_effort, call.root_effort ?? 'unknown');
      const baseModel = models[tier as Tier] as string | undefined;
      const baseFamily = baseModel === undefined ? 'unknown' : modelFamily(baseModel);
      const observedFamily = call.observed_model === null ? null : modelFamily(call.observed_model);
      if (decision) {
        const patched = decision['action'] === 'patch';
        if (patched) {
          g.patched++;
          bucket.patched++;
        } else {
          g.preserved++;
          bucket.preserved++;
          bump(g.preserve_reasons, str(decision['reason']) ?? 'unknown');
        }
        // A13 cross-check, read from the T6 comparison: the model this decision required against the one observed.
        if (call.target_model_match === 'mismatch') g.decision_mismatch++;
      } else if (observedFamily !== null && baseFamily !== 'unknown') {
        if (observedFamily === baseFamily) {
          bucket.preserved++;
          g.preserved++;
        } else {
          bucket.patched++;
          g.patched++;
        }
      }
    }

    const start = timeOf(call.pre ?? call.pre_intent);
    const end = timeOf(call.post);
    if (start !== null && end !== null && call.role !== 'planner') reservationIntervals.push([start, end]);
  }

  account(records.filter((r) => r['phase'] === 'pre_result'), phase('pre_intent'), g.jev_requests.allocation);
  account(records.filter((r) => r['phase'] === 'result_result'), phase('result_intent'), g.jev_requests.result);
  // A17: the plan scope gate is a real request per plan, so its consumption is counted like every other gate.
  account(records.filter((r) => r['phase'] === 'scope_result'), phase('scope_intent'), g.jev_requests.scope);
  // A17: influence is read from the records, never re-derived here; the hook is the only thing that knows the counterfactual.
  for (const r of records) {
    if (!['admission_result', 'pre_result', 'result_result', 'scope_result'].includes(String(r['phase'])) || r['attempted'] !== true) continue;
    g.influence.judgments += 1;
    const decision = isRecord(r['decision']) ? r['decision'] : {};
    if (decision['changed_default'] === true) g.influence.changed_default += 1;
  }
  g.parallel = { reservation_overlap_max: maxOverlap(reservationIntervals), observed_overlap_max: maxOverlap(observedIntervals) };
  g.jev_input_tokens_known =
    g.jev_requests.admission.tokens_known + g.jev_requests.allocation.tokens_known + g.jev_requests.result.tokens_known + g.jev_requests.scope.tokens_known;

  const observedOk = cell.result !== null && cell.result.usage_status === 'ok' && cell.init !== null;
  const attempts = g.jev_requests.admission.attempts + g.jev_requests.allocation.attempts + g.jev_requests.result.attempts + g.jev_requests.scope.attempts;
  if (cell.mode !== 'auto') {
    // Native/absent arms send nothing to TypeSafe when the plugin state matches the plan and the run completed.
    const pluginStateOk = cell.init !== null && cell.init.jev_gate_loaded === cell.plugin_expected;
    g.jev_input_tokens = observedOk && pluginStateOk && attempts === 0 && !cell.timed_out && !cell.cancelled ? 0 : null;
  } else if (attempts === 0 && g.attempt_unknown === 0 && g.missing_pre_records === 0 && observedOk && !cell.timed_out && !cell.cancelled) {
    g.jev_input_tokens = 0;
  } else {
    g.jev_input_tokens = jevKnownAll && g.attempt_unknown === 0 && g.missing_pre_records === 0 && !cell.timed_out && !cell.cancelled ? g.jev_input_tokens_known : null;
  }
  g.jev_cost_usd = g.jev_input_tokens === null ? null : g.jev_input_tokens === 0 ? 0 : estimateJevCostUsd(g.jev_model ?? 'jev-1.13.0', g.jev_input_tokens);
};

const killTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already gone */
  }
};

let cancelled = false;

const writeJsonAtomic = (path: string, value: unknown): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
};

const runClaudeCell = (cs: CodingCase, spec: ArmSpec, o: Options, pluginDir: string, configPath: string, cellDir: string, cell: CellRecord): Promise<void> =>
  new Promise((done) => {
    const work = join(cellDir, 'work');
    const traceDir = join(cellDir, 'trace');
    const stateDir = join(cellDir, 'state');
    // Host finding (v5-host-1, 2026-09-18): the launching Claude Code session exports CLAUDE_* variables — effort,
    // output-token limits, agent teams, messaging sockets — and inheriting them would silently change every measured
    // session. Only the variables this runner sets, plus the keys a session genuinely needs, reach the child.
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (keepEnvVar(k) && v !== undefined) env[k] = v;
    const strippedEnv = Object.keys(process.env).filter((k) => !keepEnvVar(k) && (k.startsWith('CLAUDE') || k.startsWith('JEV_GATE_'))).sort();
    env['CLAUDE_CODE_FORK_SUBAGENT'] = '0';
    env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'] = '1';
    const envAdded = ['CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'];
    if (spec.plugin && spec.mode) {
      env['JEV_GATE_MODE'] = spec.mode;
      // T8: the parent's JEV_GATE_CONFIG is stripped with the rest of the parent environment and replaced by the frozen
      // file, so a child can never fall back to the HOME config or to defaults while the plan records something else.
      // A19: an arm that overrides a config key gets its own file, derived from the frozen one so every other key is
      // identical, written inside the cell and hashed there. The plan's frozen config stays the record of what the
      // run was planned with; this records what this cell actually loaded.
      if (spec.admittedShape) {
        const base = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        const text = JSON.stringify({ ...base, admittedShape: spec.admittedShape }, null, 2) + '\n';
        const overridePath = join(cellDir, 'config.json');
        writeFileSync(overridePath, text, 'utf8');
        cell.config_override = { path: overridePath, sha256: sha256(text), admittedShape: spec.admittedShape };
        env['JEV_GATE_CONFIG'] = overridePath;
      } else {
        env['JEV_GATE_CONFIG'] = configPath;
      }
      env['JEV_GATE_TRACE_DIR'] = traceDir;
      // D7: a fresh state root per cell, so one cell's job state can never reach another cell or the real HOME.
      env['JEV_GATE_STATE_DIR'] = stateDir;
      envAdded.push('JEV_GATE_MODE', 'JEV_GATE_CONFIG', 'JEV_GATE_TRACE_DIR', 'JEV_GATE_STATE_DIR');
      cell.state_dir = stateDir;
      if (spec.experimentAdmission) {
        env['JEV_GATE_EXPERIMENT_ADMISSION'] = spec.experimentAdmission;
        envAdded.push('JEV_GATE_EXPERIMENT_ADMISSION');
      }
      mkdirSync(traceDir, { recursive: true, mode: 0o700 });
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    } else {
      env['JEV_GATE_MODE'] = 'off';
      envAdded.push('JEV_GATE_MODE');
    }
    /**
     * A primed case needs two things an unprimed one does not: stream-json input, to send the priming prompt and the
     * job prompt as two turns of one session, and the session transcript on disk, because that file is where the depth
     * gate reads how deep the session already is. Measured on 2026-09-19: with --no-session-persistence both prompts
     * read depth_unknown and 0 bytes; without it the second prompt reads a real depth. Every arm of a given case gets
     * the same profile, so the comparison inside a case never mixes the two.
     */
    const primed = cs.prime.length > 0;
    const argv = [o.claude, '-p', '--model', spec.rootModel, '--input-format', primed ? 'stream-json' : 'text', '--output-format', 'stream-json', '--verbose', '--max-turns', String(o.maxTurns), '--permission-mode', o.permissionMode, '--allowedTools', o.allowedTools, '--setting-sources', o.settingSources];
    if (primed) argv.push('--replay-user-messages');
    else argv.push('--no-session-persistence');
    if (spec.plugin) argv.push('--plugin-dir', pluginDir);
    cell.spawn = { argv, cwd: work, env_added: envAdded, env_stripped: strippedEnv };
    cell.dispatch.intent_at = new Date().toISOString();
    writeJsonAtomic(join(cellDir, 'cell.json'), cell);
    const streamOut = createWriteStream(join(cellDir, 'stream.jsonl'));
    const streamErr = createWriteStream(join(cellDir, 'stderr.txt'));
    const t0 = nowMs();
    const child = spawn(argv[0]!, argv.slice(1), { cwd: work, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let exited = false;
    const timers: NodeJS.Timeout[] = [];
    child.once('spawn', () => {
      cell.dispatch.spawn_observed_at = new Date().toISOString();
      cell.dispatch.pid = child.pid ?? null;
      cell.started = true;
      writeJsonAtomic(join(cellDir, 'cell.json'), cell);
    });
    child.stdin.on('error', () => undefined);
    const userMessage = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
    /**
     * Prompts are written one turn at a time, on the `result` event that ends the previous turn -- never all at once.
     * Measured 2026-09-19: closing stdin with every prompt in it makes the host append the waiting input to the turn
     * already running, so a thirty-file priming turn and the job prompt become ONE turn and the job prompt is
     * submitted at a fresh session's depth. That run recorded context_at_job_prompt 27-28K for a case built to reach
     * 406K, and its arms disagreed on whether the job was even in scope.
     */
    const queued = primed ? [...cs.prime.slice(1), cs.request] : [];
    if (primed) child.stdin.write(userMessage(cs.prime[0] as string));
    else child.stdin.end(cs.request);
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      streamOut.write(line + '\n');
      cell.stdout_lines++;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(line);
        observeEvent(cell, parsed);
      } catch {
        cell.unparsed_lines++;
      }
      if (!primed || !isRecord(parsed) || parsed['type'] !== 'result') return;
      const next = queued.shift();
      if (next === undefined) child.stdin.end();
      else child.stdin.write(userMessage(next));
    });
    child.stderr.pipe(streamErr);
    const escalate = (why: 'timeout' | 'cancel'): void => {
      if (why === 'timeout') cell.timed_out = true;
      else cell.cancelled = true;
      killTree(child, 'SIGINT');
      timers.push(setTimeout(() => {
        if (!exited) killTree(child, 'SIGTERM');
        timers.push(setTimeout(() => {
          if (!exited) killTree(child, 'SIGKILL');
        }, 2000));
      }, 3000));
    };
    timers.push(setTimeout(() => escalate('timeout'), o.timeoutMs));
    const onSigint = (): void => {
      cancelled = true;
      escalate('cancel');
    };
    process.once('SIGINT', onSigint);
    child.on('error', (err) => {
      streamErr.write(`spawn error: ${err.message}\n`);
      cell.not_started_reason = `spawn error: ${err.message}`;
    });
    child.on('close', (code, signal) => {
      exited = true;
      for (const t of timers) clearTimeout(t);
      process.removeListener('SIGINT', onSigint);
      cell.elapsed_ms = Math.round(nowMs() - t0);
      cell.exit_code = code;
      cell.signal = signal;
      if (cell.started && !cell.result) cell.result = { subtype: null, is_error: null, duration_ms: null, num_turns: null, total_cost_usd: null, model_usage: null, usage_status: 'no_result', permission_denials: null };
      streamOut.end();
      streamErr.end(() => done());
    });
  });

/** Identity of a checker and its sibling support library, so a correction to either shows up in every verdict. */
export const checkerIdentity = (checkFile: string): string => {
  const h = createHash('sha256').update(readFileSync(checkFile));
  const lib = join(dirname(checkFile), '_lib.mjs');
  if (existsSync(lib)) h.update(readFileSync(lib));
  return `sha256:${h.digest('hex').slice(0, 16)}`;
};

const grade = (cs: CodingCase, checkFile: string, cellDir: string, timeoutMs: number, checkerId: string): Grade => {
  const finalDir = join(cellDir, 'final');
  const empty: Grade = { quality: 'unknown', reason: 'no final snapshot', required: [], checks: [], environmentError: null, describe: null, run: null, evaluationSetup: [], checkerId };
  if (!existsSync(finalDir)) return empty;
  let n = 1;
  while (existsSync(join(cellDir, `eval-${n}`))) n++;
  const evalDir = join(cellDir, `eval-${n}`);
  copyTree(finalDir, evalDir, { keepGit: true });
  return gradeDir(checkFile, evalDir, { timeoutMs, evaluationSetup: cs.evaluationSetup, checkerId });
};

/** Copies the fixtures, manifest, checkers (with their support files and referenced broken sources), the plugin build and the resolved config into the run. */
const freezeInputs = (o: Options, cases: CodingCase[], manifestDir: string, out: string, config: ConfigV5): Record<string, unknown> => {
  const inputs = join(out, 'inputs');
  mkdirSync(inputs, { recursive: true });
  const manifestCopy = join(inputs, 'bench');
  const benchReport = copyTree(manifestDir, manifestCopy, { forbiddenRoots: [out], strictSymlinks: true });
  const pluginCopy = join(inputs, 'plugin');
  mkdirSync(pluginCopy, { recursive: true });
  for (const rel of ['dist', 'hooks', 'agents', '.claude-plugin']) cpSync(join(o.pluginDir, rel), join(pluginCopy, rel), { recursive: true });
  // T8: the configuration every plugin child reads, written once here. ConfigV5 holds no key or secret; the API key
  // stays in the environment. Editing the parent's file or the HOME config after this point changes nothing.
  const configCopy = join(inputs, 'config.json');
  const configText = JSON.stringify(config, null, 2) + '\n';
  writeFileSync(configCopy, configText, { encoding: 'utf8', mode: 0o600 });
  const checkerIds: Record<string, string> = {};
  for (const cs of cases) checkerIds[cs.id] = checkerIdentity(cs.checkFile);
  return { config_copy: configCopy, config_sha256: sha256(configText), config: { ...config }, bench_copy: manifestCopy, bench_sha256: benchReport.sha256, bench_files: benchReport.files, bench_skipped: benchReport.skipped, plugin_copy: pluginCopy, plugin_hook_sha256: createHash('sha256').update(readFileSync(join(pluginCopy, 'dist', 'hook.js'))).digest('hex'), checker_ids: checkerIds };
};

export const regrade = (o: Options): number => {
  const { cases, manifestDir } = loadManifest(o.cases);
  const out = resolve(o.out);
  const cellsDir = join(out, 'cells');
  if (!existsSync(cellsDir)) throw new Error(`--regrade needs an existing run directory with cells/: ${out}`);
  const frozenBench = join(out, 'inputs', 'bench');
  const useFrozen = existsSync(frozenBench);
  const stamp = new Date().toISOString();
  let changed = 0;
  let count = 0;
  for (const job of readdirSync(cellsDir)) {
    const cs = cases.find((c) => c.id === job);
    for (const armDir of readdirSync(join(cellsDir, job))) {
      for (const repDir of readdirSync(join(cellsDir, job, armDir))) {
        const cellDir = join(cellsDir, job, armDir, repDir);
        const cellPath = join(cellDir, 'cell.json');
        if (!existsSync(cellPath)) continue;
        const cell = JSON.parse(readFileSync(cellPath, 'utf8')) as CellRecord;
        count++;
        if (!cell.started || !cs) continue;
        const checkFile = useFrozen ? join(frozenBench, cs.checkFileRel) : cs.checkFile;
        const checkerId = `${checkerIdentity(checkFile)}${useFrozen ? '' : ' (current source, frozen copy missing)'}`;
        const before = cell.grade;
        let next = grade(cs, checkFile, cellDir, o.timeoutMs, checkerId);
        if (cell.timed_out || cell.cancelled) next = { ...next, quality: 'unknown', reason: `${cell.timed_out ? 'timed out' : 'cancelled'}; snapshot may be incomplete (${next.reason ?? next.quality})` };
        cell.grade_history = [...(cell.grade_history ?? []), { at: stamp, grade: before }];
        cell.grade = next;
        writeJsonAtomic(cellPath, cell);
        if (before?.quality !== next.quality) changed++;
        process.stdout.write(`    ${job} ${armDir} r${repDir}: ${before?.quality ?? 'none'} → ${next.quality}${next.reason ? ` (${next.reason})` : ''}\n`);
      }
    }
  }
  const summaryPath = join(out, 'summary.json');
  const summary = existsSync(summaryPath) ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>) : { schema: 5 };
  writeJsonAtomic(summaryPath, { ...summary, regraded_at: stamp, regrade_checker_source: useFrozen ? 'frozen inputs' : 'current repository (frozen copy missing)' });
  process.stdout.write(`regraded ${count} cells, ${changed} verdict change(s) using checkers from ${useFrozen ? 'frozen inputs' : 'the current repository (frozen copy missing)'}; previous verdicts kept in grade_history. Next: node dist/bench/report.js --run ${out}\n`);
  return 0;
};

export const main = async (argv: string[]): Promise<number> => {
  const o = parseArgs(argv);
  if (o.regrade) return regrade(o);
  const { cases: allCases, manifestDir, version } = loadManifest(o.cases);
  // Staging a run is cheaper than one big one, and a case named here but absent is a typo, never a silent no-op.
  const missing = o.only.filter((id) => !allCases.some((c) => c.id === id));
  if (missing.length) throw new Error(`--only names cases that are not in the manifest: ${missing.join(',')}`);
  const cases = o.only.length ? allCases.filter((c) => o.only.includes(c.id)) : allCases;
  const out = resolve(o.out);
  if (overlaps(manifestDir, out)) throw new Error(`--out ${out} overlaps the manifest directory ${manifestDir}`);
  const plan = buildPlan(o, cases, version);
  if (!o.execute) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    process.stderr.write(`plan: ${plan.planned_cells} cells (${cases.length} jobs × ${o.repetitions} rep × ${o.arms.length} arms); nothing written, no inference. Execute with --execute --max-sessions ${plan.planned_cells} --out ${out}\n`);
    return 0;
  }
  if (existsSync(out)) throw new Error(`--out ${out} already exists; execute creates a new result directory exclusively`);
  const pf = preflight(o, o.arms.some((a) => armSpecs(o.frontierModel)[a].mode === 'auto'));
  plan.preflight = pf;
  // T8: a plugin arm without a loadable configuration would run on defaults while the plan claimed otherwise.
  if (plan.effective_config === null && o.arms.some((a) => armSpecs(o.frontierModel)[a].plugin)) {
    pf.errors.push(`jev-gate config at ${plan.effective_config_source} does not load: ${String(plan.effective_config_error)}`);
  }
  if (o.maxSessions !== null && o.maxSessions < plan.planned_cells) pf.errors.push(`--max-sessions ${o.maxSessions} is below the ${plan.planned_cells} planned top-level sessions`);
  if (pf.errors.length) {
    process.stderr.write(`preflight failed; nothing executed and nothing written:\n${pf.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 2;
  }
  createExclusiveDir(out);
  const frozenConfig = plan.effective_config ?? DEFAULT_CONFIG;
  plan.frozen_inputs = freezeInputs(o, cases, manifestDir, out, frozenConfig);
  writeJsonAtomic(join(out, 'plan.json'), plan);
  const pluginDir = String(plan.frozen_inputs['plugin_copy']);
  const configPath = String(plan.frozen_inputs['config_copy']);
  const frozenBench = String(plan.frozen_inputs['bench_copy']);
  const specs = armSpecs(o.frontierModel);
  let sessions = 0;
  const written: string[] = [];
  for (const row of plan.rows) {
    const cs = cases.find((c) => c.id === row.job)!;
    for (const arm of row.arms) {
      const spec = specs[arm];
      const cell = emptyCell(cs, spec, row.repetition);
      const cellDir = join(out, 'cells', cs.id, arm, String(row.repetition));
      mkdirSync(cellDir, { recursive: true });
      written.push(cellDir);
      if (cancelled) {
        cell.not_started_reason = 'cancelled';
        writeJsonAtomic(join(cellDir, 'cell.json'), cell);
        continue;
      }
      if (o.maxSessions !== null && sessions >= o.maxSessions) {
        cell.not_started_reason = 'max_sessions_reached';
        writeJsonAtomic(join(cellDir, 'cell.json'), cell);
        continue;
      }
      const work = join(cellDir, 'work');
      const fixtureCopy = join(frozenBench, relative(manifestDir, cs.fixtureDir));
      let snap: SnapshotReport;
      try {
        snap = copyTree(fixtureCopy, work, { forbiddenRoots: [out], strictSymlinks: true });
      } catch (err) {
        cell.not_started_reason = `fixture preparation failed: ${(err as Error).message}`;
        writeJsonAtomic(join(cellDir, 'cell.json'), cell);
        continue;
      }
      cell.fixture_sha256 = snap.sha256;
      let setupOk = true;
      for (const cmd of cs.setup) {
        const r = runSync(cmd, work, o.timeoutMs, { PATH: process.env['PATH'] ?? '', HOME: join(cellDir, 'setup-home') });
        cell.setup.push({ argv: cmd, exit: r.status, ms: r.ms, error: r.error });
        if (r.error || r.status !== 0) {
          setupOk = false;
          break;
        }
      }
      if (!setupOk) {
        cell.not_started_reason = 'setup_failed';
        writeJsonAtomic(join(cellDir, 'cell.json'), cell);
        continue;
      }
      sessions++;
      process.stdout.write(`[${sessions}/${plan.planned_cells}] ${cs.id} r${row.repetition} ${arm} (root=${spec.rootModel}${spec.plugin ? `, jev-gate ${spec.mode}${spec.experimentAdmission ? ' forced-orchestrated' : ''}` : ''})\n`);
      await runClaudeCell(cs, spec, o, pluginDir, configPath, cellDir, cell);
      try {
        const finalReport = copyTree(work, join(cellDir, 'final'), { keepGit: true, forbiddenRoots: [] });
        cell.final_snapshot = { ...finalReport, path: join(cellDir, 'final') };
      } catch (err) {
        cell.final_snapshot = null;
        cell.not_started_reason = `snapshot_failed: ${(err as Error).message}`;
      }
      // T8: the accounting and the model-match comparison read the same frozen configuration the child ran on.
      ingestTraces(cell, join(cellDir, 'trace'), frozenConfig.models);
      writeJsonAtomic(join(cellDir, 'cell.json'), cell);
      process.stdout.write(`    exit=${String(cell.exit_code)} elapsed=${String(cell.elapsed_ms)}ms timed_out=${cell.timed_out} model=${cell.init?.model ?? 'unknown'} plugins=${cell.init?.plugins.join(',') || '-'} agents=${cell.agent_calls.map((c) => `${c.subagent_type}${c.has_model ? `(pin:${c.model_param})` : ''}`).join(',') || '-'} jev: attempted=${cell.gate.eligible_attempted} patched=${cell.gate.patched} preserved=${cell.gate.preserved}\n`);
    }
  }
  process.stdout.write('grading final snapshots (no model calls)\n');
  for (const cellDir of written) {
    const cellPath = join(cellDir, 'cell.json');
    const cell = JSON.parse(readFileSync(cellPath, 'utf8')) as CellRecord;
    if (!cell.started) continue;
    const cs = cases.find((c) => c.id === cell.job)!;
    const checkFile = join(frozenBench, cs.checkFileRel);
    const checkerId = String((plan.frozen_inputs['checker_ids'] as Record<string, string>)[cs.id]);
    cell.grade = grade(cs, checkFile, cellDir, o.timeoutMs, checkerId);
    if (cell.timed_out || cell.cancelled) cell.grade = { ...cell.grade, quality: 'unknown', reason: `${cell.timed_out ? 'timed out' : 'cancelled'}; snapshot may be incomplete (${cell.grade.reason ?? cell.grade.quality})` };
    writeJsonAtomic(cellPath, cell);
    process.stdout.write(`    ${cell.job} r${cell.repetition} ${cell.arm}: ${cell.grade.quality}${cell.grade.reason ? ` (${cell.grade.reason})` : ''}\n`);
  }
  writeJsonAtomic(join(out, 'summary.json'), { schema: 5, finished_at: new Date().toISOString(), cancelled, cells: written.length });
  process.stdout.write(`done: ${out}. Next: node dist/bench/report.js --run ${out}\n`);
  return cancelled ? 130 : 0;
};

const isMainModule = (): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMainModule()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: Error) => {
      process.stderr.write(`bench run failed: ${err.message}\n`);
      process.exitCode = 1;
    });
}

export { canonicalize, safeSum };
