import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Trusted checker protocol (#15 §4):
 *   node checker.mjs --describe        → {"checks":["id", …]}                          exit 0
 *   node checker.mjs <evaluation-dir>  → {"checks":[{"id","pass":true|false|null}],"environmentError":null|string}  exit 0
 * Normal completion is JSON plus exit 0. PASS JSON followed by a crash, a signal, a nonzero exit or a timeout is unknown.
 */
export type Quality = 'pass' | 'fail' | 'unknown';

export interface CheckObservation {
  id: string;
  pass: boolean | null;
}

export interface ProcessFacts {
  exit: number | null;
  signal: string | null;
  spawnError: string | null;
  timedOut: boolean;
  ms: number;
  stdoutBytes: number;
  stderrTail: string;
}

export interface Grade {
  quality: Quality;
  reason: string | null;
  required: string[];
  checks: CheckObservation[];
  environmentError: string | null;
  describe: ProcessFacts | null;
  run: ProcessFacts | null;
  evaluationSetup: Array<{ argv: string[]; facts: ProcessFacts }>;
  checkerId: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Minimal environment for setup/checker subprocesses: no API keys, OAuth, NODE_OPTIONS or credential paths (#15 §6). */
export const minimalEnv = (home: string): NodeJS.ProcessEnv => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, LANG: process.env['LANG'] ?? 'C.UTF-8', TMPDIR: tmpdir() });

export const runProcess = (argv: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): { facts: ProcessFacts; stdout: string } => {
  const t = performance.now();
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8', shell: false, timeout: timeoutMs, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  return {
    facts: { exit: r.status, signal: r.signal ?? null, spawnError: r.error && !timedOut ? r.error.message : null, timedOut, ms: Math.round(performance.now() - t), stdoutBytes: Buffer.byteLength(r.stdout ?? '', 'utf8'), stderrTail: (r.stderr ?? '').slice(-500) },
    stdout: r.stdout ?? '',
  };
};

const completedNormally = (f: ProcessFacts): boolean => f.exit === 0 && f.signal === null && f.spawnError === null && !f.timedOut;

const parseDescribe = (stdout: string): string[] | null => {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed['checks'])) return null;
    const ids = parsed['checks'];
    if (!ids.every((c): c is string => typeof c === 'string' && c.length > 0)) return null;
    if (ids.length === 0 || new Set(ids).size !== ids.length) return null;
    return ids;
  } catch {
    return null;
  }
};

const parseRun = (stdout: string): { checks: CheckObservation[]; environmentError: string | null } | null => {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed['checks']) || !('environmentError' in parsed)) return null;
    const env = parsed['environmentError'];
    if (env !== null && typeof env !== 'string') return null;
    const checks: CheckObservation[] = [];
    for (const c of parsed['checks']) {
      if (!isRecord(c) || typeof c['id'] !== 'string' || !(c['pass'] === null || typeof c['pass'] === 'boolean')) return null;
      checks.push({ id: c['id'], pass: c['pass'] as boolean | null });
    }
    return { checks, environmentError: env };
  } catch {
    return null;
  }
};

export interface GradeOptions {
  timeoutMs: number;
  /** Trusted dependency/build preparation run inside the disposable evaluation copy only (#15 §6). Default none. */
  evaluationSetup?: string[][];
  /** Identity of the checker used, recorded with the verdict so history stays interpretable after a checker change. */
  checkerId: string;
}

/**
 * Grades an evaluation directory that the caller already prepared as a disposable copy. Never touches the saved snapshot.
 * Verdict rules: all required true → pass; any verified false → fail (nulls retained with the reason); otherwise unknown.
 */
export const gradeDir = (checkFile: string, evalDir: string, opts: GradeOptions): Grade => {
  const home = mkdtempSync(join(tmpdir(), 'jev-eval-home-'));
  const env = minimalEnv(home);
  const base: Grade = { quality: 'unknown', reason: null, required: [], checks: [], environmentError: null, describe: null, run: null, evaluationSetup: [], checkerId: opts.checkerId };
  try {
    for (const argv of opts.evaluationSetup ?? []) {
      const r = runProcess(argv, evalDir, opts.timeoutMs, env);
      base.evaluationSetup.push({ argv, facts: r.facts });
      if (!completedNormally(r.facts)) return { ...base, reason: `evaluation setup failed: ${argv.join(' ')} (${r.facts.timedOut ? 'timeout' : r.facts.spawnError ?? `exit ${String(r.facts.exit)}${r.facts.signal ? ` signal ${r.facts.signal}` : ''}`})` };
    }
    if (!existsSync(checkFile)) return { ...base, reason: 'checker file missing' };
    const describe = runProcess([process.execPath, checkFile, '--describe'], evalDir, opts.timeoutMs, env);
    base.describe = describe.facts;
    if (!completedNormally(describe.facts)) return { ...base, reason: `checker --describe did not complete normally (${describe.facts.timedOut ? 'timeout' : describe.facts.spawnError ?? `exit ${String(describe.facts.exit)}`})` };
    const required = parseDescribe(describe.stdout);
    if (!required) return { ...base, reason: 'checker --describe returned an invalid, empty or duplicated check list' };
    base.required = required;
    const run = runProcess([process.execPath, checkFile, evalDir], evalDir, opts.timeoutMs, env);
    base.run = run.facts;
    const parsed = parseRun(run.stdout);
    if (!completedNormally(run.facts)) {
      // A PASS-looking payload before a crash, signal, nonzero exit or timeout is never a pass.
      return { ...base, checks: parsed?.checks ?? [], environmentError: parsed?.environmentError ?? null, reason: `checker did not complete normally (${run.facts.timedOut ? 'timeout' : run.facts.spawnError ?? `exit ${String(run.facts.exit)}${run.facts.signal ? ` signal ${run.facts.signal}` : ''}`})` };
    }
    if (!parsed) return { ...base, reason: 'checker output violates the protocol (not JSON, missing environmentError, or bad check shapes)' };
    const ids = parsed.checks.map((c) => c.id);
    if (ids.length !== required.length || new Set(ids).size !== ids.length || !required.every((r) => ids.includes(r))) {
      return { ...base, checks: parsed.checks, environmentError: parsed.environmentError, reason: 'checker output does not match its declared check list' };
    }
    const graded: Grade = { ...base, checks: parsed.checks, environmentError: parsed.environmentError };
    const failed = parsed.checks.filter((c) => c.pass === false).map((c) => c.id);
    const unrun = parsed.checks.filter((c) => c.pass === null).map((c) => c.id);
    if (failed.length) return { ...graded, quality: 'fail', reason: `failed: ${failed.join(',')}${unrun.length ? `; not evaluated: ${unrun.join(',')}` : ''}${parsed.environmentError ? `; environment: ${parsed.environmentError}` : ''}` };
    if (parsed.environmentError) return { ...graded, reason: `environment: ${parsed.environmentError}` };
    if (unrun.length) return { ...graded, reason: `not evaluated: ${unrun.join(',')}` };
    return { ...graded, quality: 'pass', reason: null };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};
