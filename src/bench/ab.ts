/**
 * Paired A/B bench for the installed plugin (#130): the same task under four plugin conditions, in two-turn sessions,
 * with the condition order rotated per repetition. This is the harness that lived in `~/.jev-gate/bench/*.sh`
 * (2026-09-30) moved into the package so that its lessons (#121–#128) are code rather than a findings file:
 *
 * - every `claude -p` gets a hard timeout (macOS has no `timeout`; #121)
 * - the output directory is explicit and permanent, never a session scratch path (#125)
 * - worktrees are removed with `git worktree remove --force`, never `rm -rf` (#126)
 * - each cell records its own start time and wall clock, so progress is read from the file, not guessed (#127)
 * - nothing is symlinked or rsynced between directories (#128); node is glob-free by construction (#124)
 *
 * A two-turn session is the design, not a convenience: a headless first prompt has no transcript yet, so Gate A reads
 * `depth_unknown` and never asks Jev (#114). Turn 1 primes the context above the floor identically for every
 * condition; only turn 2 (`--resume`) is measured.
 *
 * Usage:
 *   node dist/bench/ab.js run    --tasks tasks.json --out DIR [--reps 3] [--only S,M] [--conds A,B,C,D] [--timeout-ms 3600000]
 *   node dist/bench/ab.js report --out DIR [--trace DIR]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONDITIONS = ['A', 'B', 'C', 'D'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** A = everything off (baseline), B = Gate only, C = Compact only, D = everything on (the shipped defaults). */
export const CONDITION_OPTIONS: Record<Condition, { options: Record<string, unknown>; mode: 'off' | 'auto' }> = {
  A: { options: { gateMode: 'off', compactEnabled: false, routerEnabled: false, outputEnabled: false }, mode: 'off' },
  B: { options: { gateMode: 'auto', compactEnabled: false, routerEnabled: false, outputEnabled: false }, mode: 'auto' },
  C: { options: { gateMode: 'off', compactEnabled: true, compactMode: 'active', routerEnabled: false, outputEnabled: false }, mode: 'off' },
  D: { options: { gateMode: 'auto', compactEnabled: true, compactMode: 'active', routerEnabled: true, outputEnabled: true }, mode: 'auto' },
};

export const conditionSettings = (cond: Condition, pluginKey = 'jev-gate@jev-gate'): string =>
  JSON.stringify({ pluginConfigs: { [pluginKey]: { options: CONDITION_OPTIONS[cond].options } } });

/**
 * Prompt-cache warming favours whichever condition runs first (#129 item 1: the same request cost 3x more as cache
 * creation than as cache read), so each repetition starts one position later: ABCD, BCDA, CDAB, DABC.
 */
export const rotate = <T>(items: readonly T[], rep: number): T[] => {
  const off = (rep - 1) % items.length;
  return [...items.slice(off), ...items.slice(0, off)];
};

export interface Task {
  prompt: string;
  /** Commit to check out in a fresh worktree for editing tasks; absent = run in the main checkout. */
  base?: string;
  /** Shell command run after the task; exit 0 = quality gate passed. Jest path patterns are regexes: `(` `[` need escaping (#122). */
  check?: string;
  /** Regex the final result text must match for the run to count (e.g. `SUCCESS|zip`); absent = no text gate. */
  resultPattern?: string;
}
export interface TasksFile {
  /** Turn-1 prompt, identical for every condition; must lift the context above the depth floor. */
  _prime: string;
  /** Path to the repository the tasks run in. */
  _repo: string;
  [task: string]: Task | string;
}

export interface CellResult {
  id: string;
  task: string;
  cond: Condition;
  rep: number;
  sid: string;
  cwd: string;
  started_at: string;
  prime_wall_s: number;
  wall_s: number;
  prime_rc: number | null;
  rc: number | null;
  timed_out: boolean;
  check_rc: number | null;
  prime: TurnSummary;
  harness: TurnSummary;
  result_head: string;
}
type TurnSummary = { cost_usd?: number | undefined; turns?: number | undefined; dur_ms?: number | undefined; usage?: unknown; models?: string[] | undefined; session_id?: string | undefined };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
};
const summarize = (v: unknown): TurnSummary => {
  if (!isRecord(v)) return {};
  const models = isRecord(v['modelUsage']) ? Object.keys(v['modelUsage']) : undefined;
  return { cost_usd: v['total_cost_usd'] as number | undefined, turns: v['num_turns'] as number | undefined, dur_ms: v['duration_ms'] as number | undefined, usage: v['usage'], models, session_id: v['session_id'] as string | undefined };
};

/** The measured session inherits nothing of this shell's Claude configuration (AGENTS.md: `CLAUDE_*` removed). */
export const cleanEnv = (env: NodeJS.ProcessEnv, mode: 'off' | 'auto'): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('CLAUDE_') && !k.startsWith('JEV_GATE_')) out[k] = v;
  out['JEV_GATE_MODE'] = mode;
  return out;
};

interface RunOptions {
  tasks: string;
  out: string;
  reps: number;
  only: string[] | null;
  conds: Condition[];
  timeoutMs: number;
  claude: string;
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
};

export const parseRunArgs = (argv: string[]): RunOptions => {
  const tasks = flag(argv, '--tasks');
  const out = flag(argv, '--out');
  if (!tasks || !out) throw new Error('run needs --tasks <tasks.json> and --out <dir>');
  const reps = Number(flag(argv, '--reps') ?? '3');
  const timeoutMs = Number(flag(argv, '--timeout-ms') ?? String(60 * 60 * 1000));
  if (!Number.isInteger(reps) || reps < 1) throw new Error('--reps must be a positive integer');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout-ms must be an integer >= 1000');
  const conds = (flag(argv, '--conds') ?? CONDITIONS.join(',')).split(',') as Condition[];
  for (const c of conds) if (!CONDITIONS.includes(c)) throw new Error(`unknown condition ${c}; use ${CONDITIONS.join('|')}`);
  const only = flag(argv, '--only')?.split(',') ?? null;
  return { tasks: resolve(tasks), out: resolve(out), reps, only, conds, timeoutMs, claude: flag(argv, '--claude') ?? 'claude' };
};

const git = (repo: string, args: string[]): void => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
};

/** One two-turn cell. Skips when its result file exists, so an interrupted sweep resumes where it stopped. */
export const runCell = (o: RunOptions, file: TasksFile, task: string, cond: Condition, rep: number): CellResult | 'skip' => {
  const id = `${task}-${cond}-${rep}`;
  const R = join(o.out, 'results');
  const outPath = join(R, `${id}.json`);
  if (existsSync(outPath)) return 'skip';
  mkdirSync(R, { recursive: true });
  mkdirSync(join(o.out, 'settings'), { recursive: true });
  mkdirSync(join(o.out, 'wt'), { recursive: true });
  const t = file[task];
  if (!isRecord(t) || typeof t['prompt'] !== 'string') throw new Error(`task ${task} has no prompt`);
  const spec = t as unknown as Task;
  const repo = file._repo;

  let cwd = repo;
  if (spec.base) {
    // #126: a worktree is removed by git, which is allowed everywhere a bare `rm -rf` of that path is not.
    cwd = join(o.out, 'wt', id);
    if (existsSync(cwd)) git(repo, ['worktree', 'remove', '--force', cwd]);
    git(repo, ['worktree', 'prune']);
    git(repo, ['worktree', 'add', '-q', '--detach', cwd, spec.base]);
    const modules = join(repo, 'node_modules');
    if (existsSync(modules)) symlinkSync(modules, join(cwd, 'node_modules'));
  }

  const settings = join(o.out, 'settings', `${cond}.json`);
  writeFileSync(settings, conditionSettings(cond));
  const common = ['--settings', settings, '--output-format', 'json', '--dangerously-skip-permissions'];
  const env = cleanEnv(process.env, CONDITION_OPTIONS[cond].mode);
  const sid = crypto.randomUUID();
  const claude = (args: string[]): ReturnType<typeof spawnSync> =>
    // #121: a real timeout, from node itself; `timeout`/`gtimeout` are not on macOS.
    spawnSync(o.claude, args, { cwd, env, encoding: 'utf8', timeout: o.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

  const startedAt = new Date().toISOString();
  process.stdout.write(`run ${id} sid=${sid} cwd=${cwd} started=${startedAt}\n`);
  const p0 = Date.now();
  const prime = claude(['-p', file._prime, '--session-id', sid, ...common]);
  writeFileSync(join(R, `${id}.prime.json`), String(prime.stdout ?? ''));
  writeFileSync(join(R, `${id}.prime.err`), String(prime.stderr ?? ''));
  const t0 = Date.now();
  const work = claude(['-p', spec.prompt, '--resume', sid, ...common]);
  const t1 = Date.now();
  writeFileSync(join(R, `${id}.raw.json`), String(work.stdout ?? ''));
  writeFileSync(join(R, `${id}.err`), String(work.stderr ?? ''));
  const timedOut = prime.signal === 'SIGKILL' || work.signal === 'SIGKILL';

  let checkRc: number | null = null;
  if (spec.check) {
    const c = spawnSync('/bin/sh', ['-c', spec.check], { cwd, env, encoding: 'utf8', timeout: o.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(join(R, `${id}.check.log`), `${String(c.stdout ?? '')}\n${String(c.stderr ?? '')}`);
    checkRc = c.status ?? (c.signal ? 137 : null);
  }

  const raw = readJson(join(R, `${id}.raw.json`));
  const result: CellResult = {
    id, task, cond, rep, sid, cwd, started_at: startedAt,
    prime_wall_s: Math.round((t0 - p0) / 1000), wall_s: Math.round((t1 - t0) / 1000),
    prime_rc: prime.status, rc: work.status, timed_out: timedOut, check_rc: checkRc,
    prime: summarize(readJson(join(R, `${id}.prime.json`))), harness: summarize(raw),
    result_head: isRecord(raw) ? String(raw['result'] ?? '').slice(0, 400) : '',
  };
  writeFileSync(outPath, JSON.stringify(result, null, 1));
  process.stdout.write(`done ${id} rc=${String(work.status)} prime_rc=${String(prime.status)} wall=${result.wall_s}s check=${String(checkRc)}${timedOut ? ' TIMED OUT' : ''}\n`);
  return result;
};

export const run = (argv: string[]): void => {
  const o = parseRunArgs(argv);
  const file = readJson(o.tasks) as TasksFile | null;
  if (!isRecord(file) || typeof file['_prime'] !== 'string' || typeof file['_repo'] !== 'string') throw new Error('tasks.json needs string fields _prime and _repo');
  const tasks = Object.keys(file).filter((k) => !k.startsWith('_') && (o.only === null || o.only.includes(k)));
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, 'plan.json'), JSON.stringify({ tasks, conds: o.conds, reps: o.reps, tasks_file: o.tasks, started_at: new Date().toISOString() }, null, 1));
  // Sequential on purpose: the tasks share a browser and a local server.
  for (let rep = 1; rep <= o.reps; rep++) for (const task of tasks) for (const cond of rotate(o.conds, rep)) runCell(o, file, task, cond, rep);
};

// ---------------------------------------------------------------- report

export interface TranscriptLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: { id?: string; usage?: Record<string, unknown>; content?: unknown };
}
export interface UsageSum {
  input: number;
  cache_create: number;
  cache_read: number;
  output: number;
  requests: number;
  tools: number;
}

/** Streaming leaves several lines per message id; only the last usage of each counts. Tool calls are counted per block. */
export const usageOf = (lines: TranscriptLine[]): UsageSum => {
  const byId = new Map<string, Record<string, unknown>>();
  let tools = 0;
  for (const e of lines) {
    if (e.type !== 'assistant' || !e.message) continue;
    if (e.message.usage) byId.set(e.message.id ?? e.uuid ?? String(byId.size), e.message.usage);
    if (Array.isArray(e.message.content)) for (const b of e.message.content) if (isRecord(b) && b['type'] === 'tool_use') tools++;
  }
  const sum: UsageSum = { input: 0, cache_create: 0, cache_read: 0, output: 0, requests: byId.size, tools };
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  for (const u of byId.values()) {
    sum.input += n(u['input_tokens']);
    sum.cache_create += n(u['cache_creation_input_tokens']);
    sum.cache_read += n(u['cache_read_input_tokens']);
    sum.output += n(u['output_tokens']);
  }
  return sum;
};

const readJsonl = (path: string): TranscriptLine[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as TranscriptLine;
      } catch {
        return null;
      }
    })
    .filter((x): x is TranscriptLine => x !== null);

const findTranscript = (home: string, sid: string): string | null => {
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return null;
  for (const project of readdirSync(root)) {
    const p = join(root, project, `${sid}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
};

const traceShapes = (traceDir: string, sid: string): string[] => {
  if (!existsSync(traceDir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(traceDir)) {
    if (!f.startsWith('admission_result')) continue;
    const r = readJson(join(traceDir, f));
    if (isRecord(r) && r['session_id'] === sid) out.push(String(isRecord(r['decision']) ? r['decision']['shape'] ?? '?' : '?'));
  }
  return out;
};

export interface Row {
  id: string;
  task: string;
  cond: Condition;
  rep: number;
  ok: boolean;
  wall_s: number;
  cost: number | undefined;
  prime_cost: number | undefined;
  /** #123: how many tool calls the priming turn actually made, so "read 30 files" is checked, not assumed. */
  prime_tools: number | null;
  total_tokens: number;
  cache_create: number;
  cache_read: number;
  output: number;
  requests: number;
  tools: number;
  subs: number;
  compacts: number;
  shapes: string;
  missing?: boolean;
}

/** Cell → row: the task turn (second user message onward) plus subagent transcripts written after it. */
export const rowOf = (r: CellResult, file: TasksFile | null, transcript: string | null, traceDir: string): Row => {
  const spec = file && isRecord(file[r.task]) ? (file[r.task] as unknown as Task) : null;
  const pattern = spec?.resultPattern ? new RegExp(spec.resultPattern, 'i') : null;
  const ok = !r.timed_out && r.rc === 0 && (r.check_rc === null || r.check_rc === 0) && (pattern === null || pattern.test(r.result_head));
  const base: Row = { id: r.id, task: r.task, cond: r.cond, rep: r.rep, ok, wall_s: r.wall_s, cost: r.harness.cost_usd, prime_cost: r.prime.cost_usd, prime_tools: null, total_tokens: 0, cache_create: 0, cache_read: 0, output: 0, requests: 0, tools: 0, subs: 0, compacts: 0, shapes: traceShapes(traceDir, r.sid).join(',') };
  if (transcript === null) return { ...base, missing: true };
  const all = readJsonl(transcript);
  const userIdx = all.map((e, i) => (e.type === 'user' && typeof e.message?.content === 'string' ? i : -1)).filter((i) => i >= 0);
  const taskStart = userIdx.length >= 2 ? userIdx[1]! : 0;
  const taskTs = all[taskStart]?.timestamp ?? '';
  const primeUsage = usageOf(all.slice(0, taskStart));
  const main = all.slice(taskStart);
  const mu = usageOf(main);
  const su: UsageSum = { input: 0, cache_create: 0, cache_read: 0, output: 0, requests: 0, tools: 0 };
  let subs = 0;
  const subDir = transcript.replace(/\.jsonl$/, '/subagents');
  if (existsSync(subDir)) {
    for (const s of readdirSync(subDir).filter((x) => x.endsWith('.jsonl'))) {
      const lines = readJsonl(join(subDir, s)).filter((e) => (e.timestamp ?? '') >= taskTs);
      if (!lines.length) continue;
      subs++;
      const u = usageOf(lines);
      for (const k of Object.keys(su) as Array<keyof UsageSum>) su[k] += u[k];
    }
  }
  const raw = main.map((e) => JSON.stringify(e)).join('\n');
  const compacts = (raw.match(/compact_boundary|isCompactSummary":true|\[jev-gate compact\]/g) ?? []).length;
  return {
    ...base,
    prime_tools: taskStart > 0 ? primeUsage.tools : null,
    total_tokens: mu.input + mu.cache_create + mu.cache_read + mu.output + su.input + su.cache_create + su.cache_read + su.output,
    cache_create: mu.cache_create + su.cache_create,
    cache_read: mu.cache_read + su.cache_read,
    output: mu.output + su.output,
    requests: mu.requests + su.requests,
    tools: mu.tools + su.tools,
    subs,
    compacts,
  };
};

export const median = (a: number[]): number | null => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : null;
};

export interface GridRow {
  task: string;
  cond: Condition;
  n: number;
  tokens?: number | null;
  'tok/A'?: string;
  wall_s?: number | null;
  cost?: string;
  cache_create?: number | null;
  cache_read?: number | null;
  compacts?: number | null;
  delegated?: number;
  /** #129 item 6: "effect" only when every paired repetition beats A; `k/n below A` otherwise. */
  paired?: string;
}

/**
 * Median per task x condition over ok rows, ratio to A, and the paired-sign verdict: a condition counts as an effect
 * on a task only when, for every repetition where both it and A are ok, its token total is below A's.
 */
export const grid = (rows: Row[], tasks: string[], conds: readonly Condition[] = CONDITIONS): GridRow[] => {
  const out: GridRow[] = [];
  for (const task of tasks) {
    const A = rows.filter((r) => r.task === task && r.cond === 'A' && r.ok);
    const bT = median(A.map((r) => r.total_tokens));
    for (const cond of conds) {
      const g = rows.filter((r) => r.task === task && r.cond === cond && r.ok);
      if (!g.length) {
        out.push({ task, cond, n: 0 });
        continue;
      }
      const T = median(g.map((r) => r.total_tokens));
      const C = median(g.map((r) => r.cost ?? NaN).filter((x) => Number.isFinite(x)));
      const pairs = g.map((r) => [r, A.find((a) => a.rep === r.rep)] as const).filter((p): p is readonly [Row, Row] => p[1] !== undefined);
      const below = pairs.filter(([r, a]) => r.total_tokens < a.total_tokens).length;
      const paired = cond === 'A' ? '-' : pairs.length === 0 ? 'no pair' : `${below}/${pairs.length} below A${below === pairs.length && pairs.length >= 3 ? ' → effect' : ''}`;
      out.push({
        task, cond, n: g.length, tokens: T, 'tok/A': bT && T !== null ? (T / bT).toFixed(2) : '-', wall_s: median(g.map((r) => r.wall_s)), cost: C === null ? '-' : C.toFixed(3),
        cache_create: median(g.map((r) => r.cache_create)), cache_read: median(g.map((r) => r.cache_read)), compacts: median(g.map((r) => r.compacts)),
        delegated: g.filter((r) => /orchestrated|single|parallel/.test(r.shapes)).length, paired,
      });
    }
  }
  return out;
};

export const report = (argv: string[]): void => {
  const out = flag(argv, '--out');
  if (!out) throw new Error('report needs --out <dir>');
  const home = process.env['HOME'] ?? homedir();
  const traceDir = flag(argv, '--trace') ?? process.env['JEV_GATE_TRACE_DIR'] ?? join(home, '.jev-gate', 'trace');
  const plan = readJson(join(out, 'plan.json'));
  const file = isRecord(plan) && typeof plan['tasks_file'] === 'string' ? (readJson(plan['tasks_file']) as TasksFile | null) : null;
  const R = join(out, 'results');
  const rows: Row[] = [];
  for (const f of readdirSync(R).filter((x) => /^[^.]+-[ABCD]-\d+\.json$/.test(x))) {
    const r = readJson(join(R, f)) as CellResult | null;
    if (!r) continue;
    rows.push(rowOf(r, file, findTranscript(home, r.sid), traceDir));
  }
  const tasks = [...new Set(rows.map((r) => r.task))].sort();
  console.log('\n== cells (ok=false and timed_out are excluded from medians; missing = transcript not found) ==');
  console.table(rows.map((r) => ({ ...r, shapes: r.shapes || '-' })));
  console.log('== task x condition medians over ok cells; ratio to A; paired sign vs A ==');
  console.table(grid(rows, tasks));
  console.log('Rule: an effect needs every paired repetition below A. One median beating another may be model variance (#129).');
  const planned = isRecord(plan) && Array.isArray(plan['tasks']) && Array.isArray(plan['conds']) && typeof plan['reps'] === 'number' ? plan['tasks'].length * plan['conds'].length * plan['reps'] : null;
  if (planned !== null) console.log(`planned cells ${planned}, result files ${rows.length}: a missing file is a not-run cell, not a zero.`);
  const stale = rows.filter((r) => r.missing).length;
  if (stale) console.log(`${stale} cell(s) have no transcript under ~/.claude/projects; their tokens are unknown, not zero.`);
  // #127: progress of a sweep is read from the files it wrote, never from a remembered start time.
  for (const f of readdirSync(R).filter((x) => x.endsWith('.prime.json'))) {
    const id = f.replace(/\.prime\.json$/, '');
    if (!existsSync(join(R, `${id}.json`))) console.log(`in progress or aborted: ${id} (prime written ${statSync(join(R, f)).mtime.toISOString()})`);
  }
};

const isMainModule = (): boolean => {
  const entry = process.argv[1];
  return typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url);
};

if (isMainModule()) {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === 'run') run(argv.slice(1));
    else if (argv[0] === 'report') report(argv.slice(1));
    else {
      process.stdout.write('usage: node dist/bench/ab.js run --tasks tasks.json --out DIR [--reps 3] [--only S,M] [--conds A,B,C,D] [--timeout-ms 3600000] [--claude claude]\n       node dist/bench/ab.js report --out DIR [--trace DIR]\n');
      process.exitCode = 2;
    }
  } catch (err) {
    process.stderr.write(`bench ab: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
