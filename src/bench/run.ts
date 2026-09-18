import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { isSubscriptionOAuth, parseAuthStatus, subagentModelOverride, AUTH_CONFLICT_ENV, type CommandResult } from '../auth.js';
import { loadConfig } from '../config.js';
import { gradeDir, type Grade } from './checker.js';
import { canonicalize, copyTree, createExclusiveDir, isInside, isSafeId, overlaps, type SnapshotReport } from './paths.js';
import { estimateJevCostUsd, parseModelUsage, safeSum, tokenCount, type ModelUsage } from './usage.js';

export type Arm = 'sonnet_native' | 'native_hierarchy' | 'jev_hierarchy' | 'frontier_native' | 'fixed_hierarchy';
export const ALL_ARMS: readonly Arm[] = ['sonnet_native', 'native_hierarchy', 'jev_hierarchy', 'frontier_native', 'fixed_hierarchy'];

/** Benchmark-only allocation instruction for the fixed-role control (#17 §2). Delivered through the same coordinator surface. */
export const FIXED_ALLOCATION = "Use each role's default model (worker: sonnet, planner: opus) rather than choosing a tier from task content; honor any explicit user model restriction.";

export interface ArmSpec {
  arm: Arm;
  rootModel: string;
  plugin: boolean;
  mode: 'native' | 'auto' | null;
  experimentalAllocation: string | null;
}

export const armSpecs = (frontierModel: string): Record<Arm, ArmSpec> => ({
  sonnet_native: { arm: 'sonnet_native', rootModel: 'sonnet', plugin: false, mode: null, experimentalAllocation: null },
  native_hierarchy: { arm: 'native_hierarchy', rootModel: 'sonnet', plugin: true, mode: 'native', experimentalAllocation: null },
  jev_hierarchy: { arm: 'jev_hierarchy', rootModel: 'sonnet', plugin: true, mode: 'auto', experimentalAllocation: null },
  frontier_native: { arm: 'frontier_native', rootModel: frontierModel, plugin: false, mode: null, experimentalAllocation: null },
  fixed_hierarchy: { arm: 'fixed_hierarchy', rootModel: 'sonnet', plugin: true, mode: 'native', experimentalAllocation: FIXED_ALLOCATION },
});

export interface CodingCase {
  id: string;
  group: string;
  fixtureDir: string;
  request: string;
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
}

export interface CellRecord {
  schema: 4;
  job: string;
  group: string;
  arm: Arm;
  repetition: number;
  root_model_requested: string;
  plugin_expected: boolean;
  mode: 'native' | 'auto' | null;
  experimental_allocation: string | null;
  request_sha256: string;
  fixture_sha256: string | null;
  dispatch: { intent_at: string | null; spawn_observed_at: string | null; pid: number | null };
  started: boolean;
  not_started_reason: string | null;
  setup: Array<{ argv: string[]; exit: number | null; ms: number; error: string | null }>;
  spawn: { argv: string[]; cwd: string; env_added: string[] } | null;
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
  };
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
  if (!isRecord(parsed) || !(parsed['version'] === 3 || parsed['version'] === 4) || !Array.isArray(parsed['cases']) || parsed['cases'].length === 0) {
    throw new Error('manifest must be {version:3|4, cases:[…]} with at least one case');
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
    return { id, group: s('group'), fixtureDir, request: s('request'), setup: cmds('setup'), evaluationSetup: cmds('evaluationSetup'), checkFile, checkFileRel: relative(base, checkFile) };
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
  schema: 4;
  created_at: string;
  execute: boolean;
  manifest: string;
  manifest_version: number;
  cases: Array<{ id: string; group: string; fixtureDir: string; checkFile: string; setup: string[][]; evaluationSetup: string[][]; request: string; request_sha256: string }>;
  arms: ArmSpec[];
  repetitions: number;
  rows: PlanRow[];
  planned_cells: number;
  max_sessions: number | null;
  cli: Record<string, unknown>;
  frozen_inputs: Record<string, unknown> | null;
  preflight: Preflight | null;
}

export const buildPlan = (o: Options, cases: CodingCase[], manifestVersion: number): Plan => {
  const specs = armSpecs(o.frontierModel);
  const rows: PlanRow[] = [];
  cases.forEach((cs, i) => {
    for (let rep = 1; rep <= o.repetitions; rep++) rows.push({ job: cs.id, group: cs.group, repetition: rep, arms: shuffledArms(o.arms, o.seed, i, rep) });
  });
  const effective = loadConfig({ ...process.env, JEV_GATE_MODE: 'auto' });
  return {
    schema: 4,
    created_at: new Date().toISOString(),
    execute: o.execute,
    manifest: resolve(o.cases),
    manifest_version: manifestVersion,
    cases: cases.map((c) => ({ id: c.id, group: c.group, fixtureDir: c.fixtureDir, checkFile: c.checkFile, setup: c.setup, evaluationSetup: c.evaluationSetup, request: c.request, request_sha256: sha256(c.request) })),
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
  const observed = ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'JEV_GATE_CONFIG', 'JEV_GATE_EXPERIMENT_ALLOCATION'];
  const env_observed: Record<string, string | null> = {};
  for (const k of observed) env_observed[k] = process.env[k] ?? null;
  const typesafe_key_present = Boolean(process.env['TYPESAFE_API_KEY']);
  if (needsJev && !typesafe_key_present) errors.push('TYPESAFE_API_KEY not set: the jev_hierarchy arm would only exercise key_missing preservation');
  const plugin_hook_present = existsSync(join(o.pluginDir, 'dist', 'hook.js')) && existsSync(join(o.pluginDir, 'hooks', 'hooks.json')) && existsSync(join(o.pluginDir, 'agents', 'worker.md'));
  if (!plugin_hook_present) errors.push(`plugin dir ${o.pluginDir} lacks dist/hook.js, hooks/hooks.json or agents/worker.md; run npm run build`);
  return { claude_version: version.status === 0 ? version.stdout.trim() : null, auth, auth_reason, env_conflicts: [...authEnv, ...(override.concrete || override.force ? ['CLAUDE_CODE_SUBAGENT_MODEL'] : [])], env_observed, typesafe_key_present, plugin_hook_present, errors };
};

const emptyCell = (cs: CodingCase, spec: ArmSpec, repetition: number): CellRecord => ({
  schema: 4,
  job: cs.id,
  group: cs.group,
  arm: spec.arm,
  repetition,
  root_model_requested: spec.rootModel,
  plugin_expected: spec.plugin,
  mode: spec.mode,
  experimental_allocation: spec.experimentalAllocation,
  request_sha256: sha256(cs.request),
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
  gate: { prompt_injections: 0, agent_calls: 0, owned_calls: 0, pinned: 0, eligible_attempted: 0, patched: 0, preserved: 0, preserve_reasons: {}, skipped: {}, attempt_unknown: 0, missing_pre_records: 0, jev_model: null, jev_input_tokens: null, jev_input_tokens_known: 0, jev_cost_usd: null, gate_ms_total: null, hint_delivered: 0, target_model_matches: 0, target_model_mismatches: 0 },
  final_snapshot: null,
  grade: null,
  grade_history: [],
});

const CONTROL_KEYS = ['resume', 'agentId', 'agent_id', 'name', 'team_name', 'isolation', 'fork'];

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
      if (model && !cell.models_seen_main.includes(model)) cell.models_seen_main.push(model);
      for (const block of Array.isArray(message['content']) ? message['content'] : []) {
        if (!isRecord(block) || block['type'] !== 'tool_use' || block['name'] !== 'Agent') continue;
        const input = isRecord(block['input']) ? block['input'] : {};
        cell.agent_calls.push({
          tool_use_id: str(block['id']) ?? '',
          subagent_type: str(input['subagent_type']),
          has_model: Object.prototype.hasOwnProperty.call(input, 'model'),
          model_param: str(input['model']),
          run_in_background: typeof input['run_in_background'] === 'boolean' ? input['run_in_background'] : null,
          control_keys: Object.keys(input).filter((k) => CONTROL_KEYS.includes(k)),
          resolved_models_stream: [],
          result_is_error: null,
          pre: null,
          pre_intent: null,
          post: null,
          failure: null,
          record_conflicts: 0,
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
    for (const block of isRecord(message) && Array.isArray(message['content']) ? message['content'] : []) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue;
      const call = cell.agent_calls.find((c) => c.tool_use_id === block['tool_use_id']);
      if (call) call.result_is_error = block['is_error'] === true;
    }
    return;
  }
  if (type === 'result') {
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

/** Joins the hook's V4 phase records to the stream's Agent calls by tool_use_id and computes Jev accounting. */
export const ingestTraces = (cell: CellRecord, traceDir: string): void => {
  const records: Array<Record<string, unknown>> = [];
  if (existsSync(traceDir)) {
    for (const f of readdirSync(traceDir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const r = JSON.parse(readFileSync(join(traceDir, f), 'utf8')) as unknown;
        if (isRecord(r) && r['version'] === 4 && typeof r['phase'] === 'string') records.push(r);
      } catch {
        cell.gate.attempt_unknown++;
      }
    }
  }
  const g = cell.gate;
  g.prompt_injections = records.filter((r) => r['phase'] === 'prompt').length;
  g.agent_calls = cell.agent_calls.length;
  const byId = (phase: string, id: string): Array<Record<string, unknown>> => records.filter((r) => r['phase'] === phase && r['tool_use_id'] === id);
  let jevKnownAll = true;
  for (const call of cell.agent_calls) {
    const pres = byId('pre_result', call.tool_use_id);
    const intents = byId('pre_intent', call.tool_use_id);
    const posts = byId('post', call.tool_use_id);
    const fails = byId('failure', call.tool_use_id);
    call.record_conflicts = Math.max(0, pres.length - 1) + Math.max(0, intents.length - 1) + Math.max(0, posts.length - 1);
    call.pre = pres[0] ?? null;
    call.pre_intent = intents[0] ?? null;
    call.post = posts[0] ?? null;
    call.failure = fails[0] ?? null;
    const owned = call.subagent_type === 'jev-gate:worker' || call.subagent_type === 'jev-gate:planner';
    if (owned) g.owned_calls++;
    if (call.has_model) g.pinned++;
    if (cell.mode === 'auto' && owned && !call.has_model) {
      if (!call.pre && !call.pre_intent) {
        g.missing_pre_records++;
        jevKnownAll = false;
      }
    }
    if (call.pre_intent && !call.pre) {
      g.attempt_unknown++;
      jevKnownAll = false;
    }
    if (call.pre) {
      const p = call.pre;
      if (p['known_not_sent'] === true) {
        const code = str(p['skip_code']) ?? 'unknown';
        g.skipped[code] = (g.skipped[code] ?? 0) + 1;
      } else if (p['attempted'] === true) {
        g.eligible_attempted++;
        const jev = isRecord(p['jev']) ? p['jev'] : {};
        const usage = isRecord(jev['usage']) ? jev['usage'] : {};
        const tokens = tokenCount(usage['input_tokens']);
        if (tokens === null) jevKnownAll = false;
        else g.jev_input_tokens_known += tokens;
        g.jev_model = g.jev_model ?? str(jev['model']);
        const http = isRecord(p['http']) ? p['http'] : {};
        const ms = num(http['duration_ms']);
        if (ms !== null) g.gate_ms_total = (g.gate_ms_total ?? 0) + ms;
        const decision = isRecord(p['decision']) ? p['decision'] : null;
        const patch = isRecord(p['patch']) ? p['patch'] : null;
        if (decision && decision['action'] === 'patch' && patch && patch['emitted'] === true) g.patched++;
        else {
          g.preserved++;
          const reason = decision ? (str(decision['reason']) ?? 'route_invalid') : (str(http['code']) ?? 'unknown');
          g.preserve_reasons[reason] = (g.preserve_reasons[reason] ?? 0) + 1;
        }
      }
    }
    if (call.post) {
      const ti = isRecord(call.post['tool_input']) ? call.post['tool_input'] : {};
      if (ti['has_hint_marker'] === true) g.hint_delivered++;
      const requested = str(ti['model']);
      const tr = isRecord(call.post['tool_response']) ? call.post['tool_response'] : {};
      const resolved = str(tr['resolvedModel']);
      if (requested && resolved) {
        if (resolved.toLowerCase().includes(requested.toLowerCase())) g.target_model_matches++;
        else g.target_model_mismatches++;
      }
    }
  }
  const observedOk = cell.result !== null && cell.result.usage_status === 'ok' && cell.init !== null;
  if (cell.mode !== 'auto') {
    // Native/absent arms send nothing to TypeSafe when the plugin state matches the plan and the run completed.
    const pluginStateOk = cell.init !== null && cell.init.jev_gate_loaded === cell.plugin_expected;
    g.jev_input_tokens = observedOk && pluginStateOk && !cell.timed_out && !cell.cancelled ? 0 : null;
  } else if (g.eligible_attempted === 0 && g.attempt_unknown === 0 && g.missing_pre_records === 0 && observedOk && !cell.timed_out && !cell.cancelled) {
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

const runClaudeCell = (cs: CodingCase, spec: ArmSpec, o: Options, pluginDir: string, cellDir: string, cell: CellRecord): Promise<void> =>
  new Promise((done) => {
    const work = join(cellDir, 'work');
    const traceDir = join(cellDir, 'trace');
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
    for (const k of ['JEV_GATE_MODE', 'JEV_GATE_TRACE_DIR', 'JEV_GATE_EXPERIMENT_ALLOCATION']) delete env[k];
    const envAdded = ['CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'];
    if (spec.plugin && spec.mode) {
      env['JEV_GATE_MODE'] = spec.mode;
      env['JEV_GATE_TRACE_DIR'] = traceDir;
      envAdded.push('JEV_GATE_MODE', 'JEV_GATE_TRACE_DIR');
      if (spec.experimentalAllocation) {
        env['JEV_GATE_EXPERIMENT_ALLOCATION'] = spec.experimentalAllocation;
        envAdded.push('JEV_GATE_EXPERIMENT_ALLOCATION');
      }
      mkdirSync(traceDir, { recursive: true, mode: 0o700 });
    } else {
      env['JEV_GATE_MODE'] = 'off';
      envAdded.push('JEV_GATE_MODE');
    }
    const argv = [o.claude, '-p', '--model', spec.rootModel, '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--max-turns', String(o.maxTurns), '--permission-mode', o.permissionMode, '--allowedTools', o.allowedTools, '--setting-sources', o.settingSources, '--no-session-persistence'];
    if (spec.plugin) argv.push('--plugin-dir', pluginDir);
    cell.spawn = { argv, cwd: work, env_added: envAdded };
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
    child.stdin.end(cs.request);
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      streamOut.write(line + '\n');
      cell.stdout_lines++;
      try {
        observeEvent(cell, JSON.parse(line));
      } catch {
        cell.unparsed_lines++;
      }
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

/** Copies the fixtures, manifest, checkers (with their support files and referenced broken sources) and the plugin build into the run. */
const freezeInputs = (o: Options, cases: CodingCase[], manifestDir: string, out: string): Record<string, unknown> => {
  const inputs = join(out, 'inputs');
  mkdirSync(inputs, { recursive: true });
  const manifestCopy = join(inputs, 'bench');
  const benchReport = copyTree(manifestDir, manifestCopy, { forbiddenRoots: [out], strictSymlinks: true });
  const pluginCopy = join(inputs, 'plugin');
  mkdirSync(pluginCopy, { recursive: true });
  for (const rel of ['dist', 'hooks', 'agents', '.claude-plugin']) cpSync(join(o.pluginDir, rel), join(pluginCopy, rel), { recursive: true });
  const checkerIds: Record<string, string> = {};
  for (const cs of cases) checkerIds[cs.id] = `sha256:${createHash('sha256').update(readFileSync(cs.checkFile)).digest('hex').slice(0, 16)}`;
  return { bench_copy: manifestCopy, bench_sha256: benchReport.sha256, bench_files: benchReport.files, bench_skipped: benchReport.skipped, plugin_copy: pluginCopy, plugin_hook_sha256: createHash('sha256').update(readFileSync(join(pluginCopy, 'dist', 'hook.js'))).digest('hex'), checker_ids: checkerIds };
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
        const checkerId = `sha256:${createHash('sha256').update(readFileSync(checkFile)).digest('hex').slice(0, 16)}${useFrozen ? '' : ' (current source, frozen copy missing)'}`;
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
  const summary = existsSync(summaryPath) ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>) : { schema: 4 };
  writeJsonAtomic(summaryPath, { ...summary, regraded_at: stamp, regrade_checker_source: useFrozen ? 'frozen inputs' : 'current repository (frozen copy missing)' });
  process.stdout.write(`regraded ${count} cells, ${changed} verdict change(s) using checkers from ${useFrozen ? 'frozen inputs' : 'the current repository (frozen copy missing)'}; previous verdicts kept in grade_history. Next: node dist/bench/report.js --run ${out}\n`);
  return 0;
};

export const main = async (argv: string[]): Promise<number> => {
  const o = parseArgs(argv);
  if (o.regrade) return regrade(o);
  const { cases, manifestDir, version } = loadManifest(o.cases);
  const out = resolve(o.out);
  if (overlaps(manifestDir, out)) throw new Error(`--out ${out} overlaps the manifest directory ${manifestDir}`);
  const plan = buildPlan(o, cases, version);
  if (!o.execute) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    process.stderr.write(`plan: ${plan.planned_cells} cells (${cases.length} jobs × ${o.repetitions} rep × ${o.arms.length} arms); nothing written, no inference. Execute with --execute --max-sessions ${plan.planned_cells} --out ${out}\n`);
    return 0;
  }
  if (existsSync(out)) throw new Error(`--out ${out} already exists; execute creates a new result directory exclusively`);
  const pf = preflight(o, o.arms.includes('jev_hierarchy'));
  plan.preflight = pf;
  if (o.maxSessions !== null && o.maxSessions < plan.planned_cells) pf.errors.push(`--max-sessions ${o.maxSessions} is below the ${plan.planned_cells} planned top-level sessions`);
  if (pf.errors.length) {
    process.stderr.write(`preflight failed; nothing executed and nothing written:\n${pf.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 2;
  }
  createExclusiveDir(out);
  plan.frozen_inputs = freezeInputs(o, cases, manifestDir, out);
  writeJsonAtomic(join(out, 'plan.json'), plan);
  const pluginDir = String(plan.frozen_inputs['plugin_copy']);
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
      process.stdout.write(`[${sessions}/${plan.planned_cells}] ${cs.id} r${row.repetition} ${arm} (root=${spec.rootModel}${spec.plugin ? `, jev-gate ${spec.mode}${spec.experimentalAllocation ? ' fixed' : ''}` : ''})\n`);
      await runClaudeCell(cs, spec, o, pluginDir, cellDir, cell);
      try {
        const finalReport = copyTree(work, join(cellDir, 'final'), { keepGit: true, forbiddenRoots: [] });
        cell.final_snapshot = { ...finalReport, path: join(cellDir, 'final') };
      } catch (err) {
        cell.final_snapshot = null;
        cell.not_started_reason = `snapshot_failed: ${(err as Error).message}`;
      }
      ingestTraces(cell, join(cellDir, 'trace'));
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
  writeJsonAtomic(join(out, 'summary.json'), { schema: 4, finished_at: new Date().toISOString(), cancelled, cells: written.length });
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
