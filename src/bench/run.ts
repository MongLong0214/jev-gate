import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { estimateJevCostUsd, parseModelUsage, type ModelUsage } from './usage.js';

export type Arm = 'frontier_raw' | 'frontier_enriched' | 'sonnet_native' | 'sonnet_gated';

export interface ArmSpec {
  arm: Arm;
  rootModel: string;
  plugin: boolean;
  mode: 'enrich' | 'auto' | null;
}

export const ARMS: readonly ArmSpec[] = [
  { arm: 'frontier_raw', rootModel: 'fable', plugin: false, mode: null },
  { arm: 'frontier_enriched', rootModel: 'fable', plugin: true, mode: 'enrich' },
  { arm: 'sonnet_native', rootModel: 'sonnet', plugin: false, mode: null },
  { arm: 'sonnet_gated', rootModel: 'sonnet', plugin: true, mode: 'auto' },
];

export interface CodingCase {
  id: string;
  group: string;
  fixtureDir: string;
  request: string;
  setup: string[][];
  checkFile: string;
}

export interface Options {
  cases: string;
  out: string;
  execute: boolean;
  maxSessions: number | null;
  timeoutMs: number;
  maxTurns: number;
  seed: number;
  pluginDir: string;
  claude: string;
  settingSources: string;
  permissionMode: string;
  allowedTools: string;
  allowEnvConflicts: boolean;
  regrade: boolean;
}

export interface AgentCall {
  tool_use_id: string;
  subagent_type: string | null;
  model_param: string | null;
  run_in_background: boolean | null;
  name: string | null;
  resolved_models: string[];
  result_is_error: boolean | null;
  result_preview: string | null;
}

export interface HookTraceSummary {
  invocation_id: string;
  error_code: string | null;
  output_kind: string;
  execution: string;
  tier: string | null;
  agent_name: string | null;
  reason: string;
  kind: string;
  jev_model: string | null;
  jev_input_tokens: number | null;
  jev_output_tokens: number | null;
  durations_ms: { total: number; jev: number | null };
}

export type Quality = 'pass' | 'fail' | 'unknown';

export interface Grade {
  quality: Quality;
  reason: string | null;
  required: string[];
  checks: Array<{ id: string; pass: boolean | null }>;
  environmentError: string | null;
}

export interface CellRecord {
  case: string;
  group: string;
  arm: Arm;
  root_model_requested: string;
  plugin_expected: boolean;
  mode: 'enrich' | 'auto' | null;
  prompt_sha256: string;
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
  init: {
    model: string | null;
    plugins: string[];
    plugin_errors: unknown[];
    jev_gate_loaded: boolean;
    agents: string[] | null;
    permission_mode: string | null;
    tools: number | null;
  } | null;
  root_model_consistent: boolean | null;
  models_seen_main: string[];
  agent_calls: AgentCall[];
  api_retries: number;
  result: {
    subtype: string | null;
    is_error: boolean | null;
    duration_ms: number | null;
    duration_api_ms: number | null;
    num_turns: number | null;
    total_cost_usd: number | null;
    model_usage: ModelUsage | null;
    permission_denials: number | null;
    usage_top_level: unknown;
  } | null;
  hook_traces: HookTraceSummary[];
  gate: {
    count: number;
    fallback_count: number;
    jev_model: string | null;
    jev_input_tokens: number | null;
    jev_cost_usd: number | null;
    gate_ms_total: number | null;
    recommended_execution: string | null;
    recommended_agent: string | null;
    actual_agents: string[];
    match: 'match' | 'mismatch' | 'n/a';
  };
  final_snapshot: { path: string; files: number } | null;
  grade: Grade | null;
}

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const nowMs = (): number => performance.now();
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
    maxSessions: null,
    timeoutMs: 600_000,
    maxTurns: 40,
    seed: 42,
    pluginDir: root,
    claude: 'claude',
    settingSources: 'project,local',
    permissionMode: 'acceptEdits',
    allowedTools: 'Bash(node *),Bash(npm test),Bash(npm run test)',
    allowEnvConflicts: false,
    regrade: false,
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
    else if (a === '--allow-env-conflicts') o.allowEnvConflicts = true;
    else if (a === '--regrade') o.regrade = true;
    else if (a === '--max-sessions') o.maxSessions = positiveInt(a, next());
    else if (a === '--timeout-ms') o.timeoutMs = positiveInt(a, next());
    else if (a === '--max-turns') o.maxTurns = positiveInt(a, next());
    else if (a === '--seed') o.seed = positiveInt(a, next());
    else if (a === '--plugin-dir') o.pluginDir = resolve(next());
    else if (a === '--claude') o.claude = next();
    else if (a === '--setting-sources') o.settingSources = next();
    else if (a === '--permission-mode') o.permissionMode = next();
    else if (a === '--allowed-tools') o.allowedTools = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.cases || !o.out) throw new Error('usage: run.js --cases <manifest> --out <new dir> [--execute --max-sessions N --timeout-ms MS --max-turns N --seed N] | --regrade --out <existing run dir>');
  if (o.execute && o.maxSessions === null) throw new Error('--execute requires --max-sessions');
  if (o.execute && o.regrade) throw new Error('--regrade re-scores an existing run and never executes; drop --execute');
  return o;
};

export const loadManifest = (path: string): CodingCase[] => {
  const abs = resolve(path);
  const parsed = JSON.parse(readFileSync(abs, 'utf8')) as unknown;
  if (!isRecord(parsed) || parsed['version'] !== 3 || !Array.isArray(parsed['cases'])) throw new Error('manifest must be {version:3, cases:[...]}');
  const base = dirname(abs);
  const seen = new Set<string>();
  return parsed['cases'].map((raw, idx) => {
    if (!isRecord(raw)) throw new Error(`case ${idx} is not an object`);
    const str = (k: string): string => {
      const v = raw[k];
      if (typeof v !== 'string' || v.length === 0) throw new Error(`case ${idx}: ${k} must be a non-empty string`);
      return v;
    };
    const id = str('id');
    if (seen.has(id)) throw new Error(`duplicate case id ${id}`);
    seen.add(id);
    const setup = raw['setup'];
    if (!Array.isArray(setup) || !setup.every((c) => Array.isArray(c) && c.length > 0 && c.every((s) => typeof s === 'string'))) {
      throw new Error(`case ${id}: setup must be string[][]`);
    }
    const fixtureDir = resolve(base, str('fixtureDir'));
    const checkFile = resolve(base, str('checkFile'));
    if (!existsSync(fixtureDir) || !statSync(fixtureDir).isDirectory()) throw new Error(`case ${id}: fixtureDir missing`);
    if (!existsSync(checkFile)) throw new Error(`case ${id}: checkFile missing`);
    return { id, group: str('group'), fixtureDir, request: str('request'), setup: setup as string[][], checkFile };
  });
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

export const shuffledArms = (seed: number, caseIndex: number): ArmSpec[] => {
  const rng = mulberry32(seed * 1000 + caseIndex);
  const arms = [...ARMS];
  for (let i = arms.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arms[i], arms[j]] = [arms[j]!, arms[i]!];
  }
  return arms;
};

export const copyTree = (src: string, dst: string, skip: ReadonlySet<string>): number => {
  mkdirSync(dst, { recursive: true });
  let files = 0;
  for (const name of readdirSync(src)) {
    if (skip.has(name)) continue;
    const s = join(src, name);
    const st = lstatSync(s);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) files += copyTree(s, join(dst, name), skip);
    else if (st.isFile()) {
      copyFileSync(s, join(dst, name));
      files++;
    }
  }
  return files;
};

const SNAPSHOT_SKIP = new Set(['.git', 'node_modules', 'artifacts', 'bench-runs']);
const FINAL_SKIP = new Set(['node_modules']);

const runSync = (argv: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): { exit: number | null; ms: number; error: string | null; stdout: string; stderr: string } => {
  const t = nowMs();
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8', shell: false, timeout: timeoutMs, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { exit: r.status, ms: Math.round(nowMs() - t), error: r.error ? r.error.message : null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

interface Preflight {
  claude_version: string | null;
  auth: { loggedIn: unknown; authMethod: unknown; apiProvider: unknown; subscriptionType: unknown } | null;
  env_conflicts: string[];
  env_observed: Record<string, string | null>;
  typesafe_key_present: boolean;
  plugin_hook_present: boolean;
  errors: string[];
}

export const preflight = (o: Options): Preflight => {
  const errors: string[] = [];
  const version = runSync([o.claude, '--version'], process.cwd(), 20_000);
  if (version.error || version.exit !== 0) errors.push(`claude not runnable: ${version.error ?? `exit ${String(version.exit)}`}`);
  let auth: Preflight['auth'] = null;
  const status = runSync([o.claude, 'auth', 'status'], process.cwd(), 20_000);
  try {
    const parsed = JSON.parse(status.stdout) as unknown;
    if (isRecord(parsed)) auth = { loggedIn: parsed['loggedIn'], authMethod: parsed['authMethod'], apiProvider: parsed['apiProvider'], subscriptionType: parsed['subscriptionType'] };
  } catch {
    errors.push('claude auth status did not return JSON; cannot confirm subscription OAuth');
  }
  if (auth && !(auth.loggedIn === true && auth.authMethod === 'claude.ai' && auth.apiProvider === 'firstParty')) {
    errors.push(`auth is not claude.ai subscription OAuth (method=${String(auth.authMethod)}, provider=${String(auth.apiProvider)}); the OAuth comparison does not run`);
  }
  const authEnv = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].filter((k) => process.env[k]);
  if (authEnv.length) errors.push(`API-key/gateway/cloud env active (${authEnv.join(', ')}); the OAuth comparison does not run`);
  const modelEnv = ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'].filter((k) => process.env[k]);
  if (modelEnv.length && !o.allowEnvConflicts) errors.push(`${modelEnv.join(', ')} set: subagent tiers would be replaced; unset it or pass --allow-env-conflicts to record the conflict and proceed`);
  const observedKeys = ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'JEV_GATE_CONFIG'];
  const env_observed: Record<string, string | null> = {};
  for (const k of observedKeys) env_observed[k] = process.env[k] ?? null;
  const typesafe_key_present = Boolean(process.env['TYPESAFE_API_KEY']);
  if (!typesafe_key_present) errors.push('TYPESAFE_API_KEY not set: plugin arms would only exercise the fallback path');
  const plugin_hook_present = existsSync(join(o.pluginDir, 'dist', 'hook.js')) && existsSync(join(o.pluginDir, 'hooks', 'hooks.json'));
  if (!plugin_hook_present) errors.push(`plugin dir ${o.pluginDir} lacks dist/hook.js or hooks/hooks.json; run npm run build`);
  return { claude_version: version.exit === 0 ? version.stdout.trim() : null, auth, env_conflicts: [...authEnv, ...modelEnv], env_observed, typesafe_key_present, plugin_hook_present, errors };
};

const emptyCell = (cs: CodingCase, spec: ArmSpec): CellRecord => ({
  case: cs.id,
  group: cs.group,
  arm: spec.arm,
  root_model_requested: spec.rootModel,
  plugin_expected: spec.plugin,
  mode: spec.mode,
  prompt_sha256: sha256(cs.request),
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
  hook_traces: [],
  gate: { count: 0, fallback_count: 0, jev_model: null, jev_input_tokens: null, jev_cost_usd: null, gate_ms_total: null, recommended_execution: null, recommended_agent: null, actual_agents: [], match: 'n/a' },
  final_snapshot: null,
  grade: null,
});

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Folds one stream-json event into the cell record. Unknown shapes are ignored, never guessed. */
export const observeEvent = (cell: CellRecord, ev: unknown): void => {
  if (!isRecord(ev)) return;
  const type = ev['type'];
  if (type === 'system' && ev['subtype'] === 'init') {
    const plugins = Array.isArray(ev['plugins']) ? ev['plugins'].map((p) => (isRecord(p) ? strOrNull(p['name']) ?? '' : String(p))) : [];
    const agentsRaw = ev['agents'];
    const agents = Array.isArray(agentsRaw) ? agentsRaw.map((a) => (isRecord(a) ? strOrNull(a['name']) ?? JSON.stringify(a) : String(a))) : null;
    cell.init = {
      model: strOrNull(ev['model']),
      plugins,
      plugin_errors: Array.isArray(ev['plugin_errors']) ? ev['plugin_errors'] : [],
      jev_gate_loaded: plugins.includes('jev-gate'),
      agents,
      permission_mode: strOrNull(ev['permissionMode']),
      tools: Array.isArray(ev['tools']) ? ev['tools'].length : null,
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
    const model = strOrNull(message['model']);
    const parent = strOrNull(ev['parent_tool_use_id']);
    if (parent === null) {
      if (model && !cell.models_seen_main.includes(model)) cell.models_seen_main.push(model);
      const content = Array.isArray(message['content']) ? message['content'] : [];
      for (const block of content) {
        if (!isRecord(block) || block['type'] !== 'tool_use' || block['name'] !== 'Agent') continue;
        const input = isRecord(block['input']) ? block['input'] : {};
        cell.agent_calls.push({
          tool_use_id: strOrNull(block['id']) ?? '',
          subagent_type: strOrNull(input['subagent_type']),
          model_param: strOrNull(input['model']),
          run_in_background: typeof input['run_in_background'] === 'boolean' ? input['run_in_background'] : null,
          name: strOrNull(input['name']),
          resolved_models: [],
          result_is_error: null,
          result_preview: null,
        });
      }
    } else {
      const call = cell.agent_calls.find((c) => c.tool_use_id === parent);
      if (call && model && !call.resolved_models.includes(model)) call.resolved_models.push(model);
    }
    return;
  }
  if (type === 'user') {
    const message = ev['message'];
    const content = isRecord(message) && Array.isArray(message['content']) ? message['content'] : [];
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue;
      const call = cell.agent_calls.find((c) => c.tool_use_id === block['tool_use_id']);
      if (!call) continue;
      call.result_is_error = block['is_error'] === true;
      const raw = block['content'];
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p) => (isRecord(p) && typeof p['text'] === 'string' ? p['text'] : '')).join('') : '';
      call.result_preview = text.slice(0, 300);
    }
    return;
  }
  if (type === 'result') {
    cell.result = {
      subtype: strOrNull(ev['subtype']),
      is_error: typeof ev['is_error'] === 'boolean' ? ev['is_error'] : null,
      duration_ms: num(ev['duration_ms']),
      duration_api_ms: num(ev['duration_api_ms']),
      num_turns: num(ev['num_turns']),
      total_cost_usd: num(ev['total_cost_usd']),
      model_usage: parseModelUsage(ev),
      permission_denials: Array.isArray(ev['permission_denials']) ? ev['permission_denials'].length : null,
      usage_top_level: ev['usage'] ?? null,
    };
  }
};

export const summarizeTraces = (cell: CellRecord, traceDir: string): void => {
  if (!existsSync(traceDir)) return;
  const files = readdirSync(traceDir).filter((f) => f.startsWith('hook-') && f.endsWith('.json')).sort();
  for (const f of files) {
    try {
      const t = JSON.parse(readFileSync(join(traceDir, f), 'utf8')) as Record<string, unknown>;
      const decision = isRecord(t['decision']) ? t['decision'] : {};
      const jev = isRecord(t['jev']) ? t['jev'] : {};
      const usage = isRecord(jev['usage']) ? jev['usage'] : {};
      const durations = isRecord(t['durations_ms']) ? t['durations_ms'] : {};
      const output = isRecord(t['output']) ? t['output'] : {};
      cell.hook_traces.push({
        invocation_id: strOrNull(t['invocation_id']) ?? f,
        error_code: strOrNull(t['error_code']),
        output_kind: strOrNull(output['kind']) ?? 'unknown',
        execution: strOrNull(decision['execution']) ?? 'unknown',
        tier: strOrNull(decision['tier']),
        agent_name: strOrNull(decision['agentName']),
        reason: strOrNull(decision['reason']) ?? 'unknown',
        kind: strOrNull(decision['kind']) ?? 'unknown',
        jev_model: strOrNull(jev['model']),
        jev_input_tokens: num(usage['input_tokens']),
        jev_output_tokens: num(usage['output_tokens']),
        durations_ms: { total: num(durations['total']) ?? 0, jev: num(durations['jev']) },
      });
    } catch {
      cell.hook_traces.push({ invocation_id: f, error_code: 'unreadable_trace', output_kind: 'unknown', execution: 'unknown', tier: null, agent_name: null, reason: 'unknown', kind: 'unknown', jev_model: null, jev_input_tokens: null, jev_output_tokens: null, durations_ms: { total: 0, jev: null } });
    }
  }
  const traces = cell.hook_traces;
  cell.gate.count = traces.length;
  cell.gate.fallback_count = traces.filter((t) => t.output_kind === 'fallback').length;
  cell.gate.gate_ms_total = traces.length ? traces.reduce((s, t) => s + t.durations_ms.total, 0) : null;
  const called = traces.filter((t) => t.jev_model !== null);
  cell.gate.jev_model = called[0]?.jev_model ?? null;
  const tokensKnown = traces.every((t) => t.jev_input_tokens !== null || t.error_code === 'key_missing' || t.error_code === 'prompt_too_large' || t.error_code === 'config_invalid' || t.error_code === 'request_too_large');
  cell.gate.jev_input_tokens = traces.length && tokensKnown ? traces.reduce((s, t) => s + (t.jev_input_tokens ?? 0), 0) : null;
  cell.gate.jev_cost_usd = cell.gate.jev_input_tokens === null ? (traces.length ? null : 0) : estimateJevCostUsd(cell.gate.jev_model ?? 'jev-1.13.0', cell.gate.jev_input_tokens);
  if (!traces.length) cell.gate.jev_cost_usd = 0;
  const last = traces[traces.length - 1];
  cell.gate.actual_agents = cell.agent_calls.map((c) => c.subagent_type ?? 'unknown');
  if (!last) return;
  cell.gate.recommended_execution = last.execution;
  cell.gate.recommended_agent = last.agent_name;
  const jevAgents = cell.gate.actual_agents.filter((a) => a.startsWith('jev-gate:'));
  if (last.output_kind !== 'output' || last.reason === 'enrich_only') cell.gate.match = 'n/a';
  else if (last.execution === 'delegate') cell.gate.match = last.agent_name && jevAgents.includes(last.agent_name) ? 'match' : 'mismatch';
  else cell.gate.match = jevAgents.length === 0 ? 'match' : 'mismatch';
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

const runClaudeCell = (cs: CodingCase, spec: ArmSpec, o: Options, cellDir: string, cell: CellRecord): Promise<void> =>
  new Promise((done) => {
    const work = join(cellDir, 'work');
    const traceDir = join(cellDir, 'trace');
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['JEV_GATE_MODE'];
    delete env['JEV_GATE_TRACE_DIR'];
    const envAdded: string[] = [];
    if (spec.plugin && spec.mode) {
      env['JEV_GATE_MODE'] = spec.mode;
      env['JEV_GATE_TRACE_DIR'] = traceDir;
      envAdded.push('JEV_GATE_MODE', 'JEV_GATE_TRACE_DIR');
      mkdirSync(traceDir, { recursive: true });
    }
    const argv = [
      o.claude,
      '-p',
      '--model',
      spec.rootModel,
      '--input-format',
      'text',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      String(o.maxTurns),
      '--permission-mode',
      o.permissionMode,
      '--allowedTools',
      o.allowedTools,
      '--setting-sources',
      o.settingSources,
      '--no-session-persistence',
    ];
    if (spec.plugin) argv.push('--plugin-dir', o.pluginDir);
    cell.spawn = { argv, cwd: work, env_added: envAdded };
    const streamOut = createWriteStream(join(cellDir, 'stream.jsonl'));
    const streamErr = createWriteStream(join(cellDir, 'stderr.txt'));
    const t0 = nowMs();
    const child = spawn(argv[0]!, argv.slice(1), { cwd: work, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    cell.started = true;
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
    let exited = false;
    const timers: NodeJS.Timeout[] = [];
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
    });
    child.on('close', (code, signal) => {
      exited = true;
      for (const t of timers) clearTimeout(t);
      process.removeListener('SIGINT', onSigint);
      cell.elapsed_ms = Math.round(nowMs() - t0);
      cell.exit_code = code;
      cell.signal = signal;
      streamOut.end();
      streamErr.end(() => done());
    });
  });

const emptyGrade = (quality: Quality, reason: string): Grade => ({ quality, reason, required: [], checks: [], environmentError: null });

/** Runs the trusted checker against a prepared evaluation directory. Pure with respect to the run layout. */
export const gradeDir = (checkFile: string, evalDir: string, timeoutMs: number): Grade => {
  const describe = runSync([process.execPath, checkFile, '--describe'], evalDir, timeoutMs);
  let required: string[];
  try {
    const parsed = JSON.parse(describe.stdout) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed['checks']) || !parsed['checks'].every((c) => typeof c === 'string')) throw new Error('bad describe');
    required = parsed['checks'] as string[];
  } catch {
    return emptyGrade('unknown', `checker --describe failed: ${describe.error ?? describe.stderr.slice(0, 200)}`);
  }
  if (required.length === 0 || new Set(required).size !== required.length) return emptyGrade('unknown', 'checker declares an empty or duplicated check list');
  const run = runSync([process.execPath, checkFile, evalDir], evalDir, timeoutMs);
  let checks: Array<{ id: string; pass: boolean | null }>;
  let environmentError: string | null;
  try {
    const parsed = JSON.parse(run.stdout) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed['checks'])) throw new Error('bad output');
    checks = parsed['checks'].map((c) => {
      if (!isRecord(c) || typeof c['id'] !== 'string' || !(c['pass'] === null || typeof c['pass'] === 'boolean')) throw new Error('bad check');
      return { id: c['id'], pass: c['pass'] as boolean | null };
    });
    environmentError = strOrNull(parsed['environmentError']);
  } catch {
    return { quality: 'unknown', reason: `checker run failed: ${run.error ?? run.stderr.slice(0, 200)}`, required, checks: [], environmentError: null };
  }
  const ids = checks.map((c) => c.id);
  if (ids.length !== required.length || new Set(ids).size !== ids.length || !required.every((r) => ids.includes(r))) {
    return { quality: 'unknown', reason: 'checker output does not match its declared check list', required, checks, environmentError };
  }
  if (environmentError) return { quality: 'unknown', reason: `environment: ${environmentError}`, required, checks, environmentError };
  if (checks.some((c) => c.pass === false)) return { quality: 'fail', reason: `failed: ${checks.filter((c) => c.pass === false).map((c) => c.id).join(',')}`, required, checks, environmentError };
  if (checks.every((c) => c.pass === true)) return { quality: 'pass', reason: null, required, checks, environmentError };
  return { quality: 'unknown', reason: `not evaluated: ${checks.filter((c) => c.pass === null).map((c) => c.id).join(',')}`, required, checks, environmentError };
};

const grade = (cs: CodingCase, cellDir: string, timeoutMs: number): Grade => {
  const finalDir = join(cellDir, 'final');
  if (!existsSync(finalDir)) return emptyGrade('unknown', 'no final snapshot');
  const evalDir = join(cellDir, 'eval');
  copyTree(finalDir, evalDir, FINAL_SKIP);
  return gradeDir(cs.checkFile, evalDir, timeoutMs);
};

const writeJson = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');

/**
 * Re-scores an existing run's saved final snapshots with the current checkers. No model calls, no re-execution.
 * The previous grade of every cell is kept in `previous_grades` so a checker change never erases the earlier verdict.
 */
export const regrade = (o: Options): number => {
  const cases = loadManifest(o.cases);
  const out = resolve(o.out);
  const cellsDir = join(out, 'cells');
  if (!existsSync(cellsDir)) throw new Error(`--regrade needs an existing run directory with cells/: ${out}`);
  const stamp = new Date().toISOString();
  const cells: CellRecord[] = [];
  let changed = 0;
  for (const caseId of readdirSync(cellsDir)) {
    const cs = cases.find((c) => c.id === caseId);
    for (const arm of readdirSync(join(cellsDir, caseId))) {
      const cellDir = join(cellsDir, caseId, arm);
      const cellPath = join(cellDir, 'cell.json');
      if (!existsSync(cellPath)) continue;
      const cell = JSON.parse(readFileSync(cellPath, 'utf8')) as CellRecord & { previous_grades?: Array<{ at: string; grade: Grade | null }> };
      cells.push(cell);
      if (!cell.started || !cs) continue;
      const before = cell.grade;
      rmSync(join(cellDir, 'eval'), { recursive: true, force: true });
      let next = grade(cs, cellDir, o.timeoutMs);
      if (cell.timed_out || cell.cancelled) next = { ...next, quality: 'unknown', reason: `${cell.timed_out ? 'timed out' : 'cancelled'}; snapshot may be incomplete (${next.reason ?? next.quality})` };
      cell.previous_grades = [...(cell.previous_grades ?? []), { at: stamp, grade: before }];
      cell.grade = next;
      writeJson(cellPath, cell);
      if (before?.quality !== next.quality) changed++;
      process.stdout.write(`    ${caseId} ${arm}: ${before?.quality ?? 'none'} → ${next.quality}${next.reason ? ` (${next.reason})` : ''}\n`);
    }
  }
  const summaryPath = join(out, 'summary.json');
  const summary = existsSync(summaryPath) ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>) : { version: 3 };
  writeJson(summaryPath, { ...summary, regraded_at: stamp, cells });
  process.stdout.write(`regraded ${cells.length} cells, ${changed} verdict change(s). Next: node dist/bench/report.js --run ${out}\n`);
  return 0;
};

export const main = async (argv: string[]): Promise<number> => {
  const o = parseArgs(argv);
  if (o.regrade) return regrade(o);
  const cases = loadManifest(o.cases);
  const out = resolve(o.out);
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`--out ${out} exists and is not empty; use a new result folder`);
  mkdirSync(out, { recursive: true });
  const order = cases.map((cs, i) => ({ case: cs.id, arms: shuffledArms(o.seed, i).map((a) => a.arm) }));
  const planned = cases.length * ARMS.length;
  const plan = {
    version: 3,
    created_at: new Date().toISOString(),
    execute: o.execute,
    manifest: resolve(o.cases),
    cases: cases.map((c) => ({ id: c.id, group: c.group, fixtureDir: c.fixtureDir, checkFile: c.checkFile, setup: c.setup, request: c.request, request_sha256: sha256(c.request) })),
    arms: ARMS,
    order,
    planned_cells: planned,
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
      note: 'root models are CLI aliases; the actual model is read from system/init and modelUsage. User-scope settings are excluded for every arm via --setting-sources; user-level CLAUDE.md still loads equally in all arms.',
    },
    preflight: null as Preflight | null,
  };
  if (!o.execute) {
    writeJson(join(out, 'plan.json'), plan);
    process.stdout.write(`planned ${planned} cells (${cases.length} cases × ${ARMS.length} arms) in ${out}; no inference performed. Add --execute --max-sessions ${planned} to run.\n`);
    return 0;
  }
  const pf = preflight(o);
  plan.preflight = pf;
  if (o.maxSessions !== null && o.maxSessions < planned) pf.errors.push(`--max-sessions ${o.maxSessions} is below the ${planned} planned top-level sessions; raise it or reduce cases before starting`);
  writeJson(join(out, 'plan.json'), plan);
  if (pf.errors.length) {
    process.stderr.write(`preflight failed; nothing executed:\n${pf.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 2;
  }
  const cells: CellRecord[] = [];
  let sessions = 0;
  for (const [i, cs] of cases.entries()) {
    for (const spec of shuffledArms(o.seed, i)) {
      const cell = emptyCell(cs, spec);
      cells.push(cell);
      const cellDir = join(out, 'cells', cs.id, spec.arm);
      mkdirSync(cellDir, { recursive: true });
      if (cancelled) {
        cell.not_started_reason = 'cancelled';
        writeJson(join(cellDir, 'cell.json'), cell);
        continue;
      }
      if (o.maxSessions !== null && sessions >= o.maxSessions) {
        cell.not_started_reason = 'max_sessions_reached';
        writeJson(join(cellDir, 'cell.json'), cell);
        continue;
      }
      const work = join(cellDir, 'work');
      copyTree(cs.fixtureDir, work, SNAPSHOT_SKIP);
      let setupOk = true;
      for (const cmd of cs.setup) {
        const r = runSync(cmd, work, o.timeoutMs);
        cell.setup.push({ argv: cmd, exit: r.exit, ms: r.ms, error: r.error });
        if (r.error || r.exit !== 0) {
          setupOk = false;
          break;
        }
      }
      if (!setupOk) {
        cell.not_started_reason = 'setup_failed';
        writeJson(join(cellDir, 'cell.json'), cell);
        continue;
      }
      sessions++;
      process.stdout.write(`[${sessions}/${planned}] ${cs.id} ${spec.arm} (root=${spec.rootModel}${spec.plugin ? `, jev-gate ${spec.mode}` : ''})\n`);
      await runClaudeCell(cs, spec, o, cellDir, cell);
      try {
        const files = copyTree(work, join(cellDir, 'final'), FINAL_SKIP);
        cell.final_snapshot = { path: join(cellDir, 'final'), files };
      } catch (err) {
        cell.final_snapshot = null;
        cell.not_started_reason = `snapshot_failed: ${(err as Error).message}`;
      }
      if (spec.plugin) summarizeTraces(cell, join(cellDir, 'trace'));
      else {
        cell.gate.jev_cost_usd = 0;
        cell.gate.actual_agents = cell.agent_calls.map((c) => c.subagent_type ?? 'unknown');
      }
      writeJson(join(cellDir, 'cell.json'), cell);
      process.stdout.write(`    exit=${String(cell.exit_code)} elapsed=${String(cell.elapsed_ms)}ms timed_out=${cell.timed_out} model=${cell.init?.model ?? 'unknown'} plugins=${cell.init?.plugins.join(',') || '-'} agents=${cell.gate.actual_agents.join(',') || '-'}\n`);
    }
  }
  process.stdout.write('grading final snapshots (no model calls)\n');
  for (const cell of cells) {
    if (!cell.started) continue;
    const cs = cases.find((c) => c.id === cell.case)!;
    const cellDir = join(out, 'cells', cell.case, cell.arm);
    cell.grade = grade(cs, cellDir, o.timeoutMs);
    if (cell.timed_out || cell.cancelled) cell.grade = { ...cell.grade, quality: 'unknown', reason: `${cell.timed_out ? 'timed out' : 'cancelled'}; snapshot may be incomplete (${cell.grade.reason ?? cell.grade.quality})` };
    writeJson(join(cellDir, 'cell.json'), cell);
    process.stdout.write(`    ${cell.case} ${cell.arm}: ${cell.grade.quality}${cell.grade.reason ? ` (${cell.grade.reason})` : ''}\n`);
  }
  writeJson(join(out, 'summary.json'), { version: 3, finished_at: new Date().toISOString(), cancelled, cells });
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
