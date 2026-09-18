import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Report } from '../src/bench/report.js';
import { loadManifest, maxOverlap, type CellRecord, type Plan } from '../src/bench/run.js';

const root = join(__dirname, '..');
const fake = join(__dirname, 'fixtures', 'fake-claude.mjs');
const cases = join(__dirname, 'fixtures', 'mini', 'cases.json');
const ARMS = ['sonnet_native', 'frontier_native', 'native_hierarchy', 'orchestrated_control', 'frontier_orchestrated', 'jev_hierarchy'] as const;
let tmp: string;
let dist: string;
let pluginDir: string;
let n = 0;

const baseEnv = (): Record<string, string> => ({ PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home'), TYPESAFE_API_KEY: 'test-key' });
const bench = (args: string[], env: Record<string, string> = {}, out?: string): { status: number | null; stdout: string; stderr: string; out: string } => {
  const dir = out ?? join(tmp, `run-${n++}`);
  const r = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--cases', cases, '--out', dir, '--claude', fake, '--plugin-dir', pluginDir, ...args], { encoding: 'utf8', env: { ...baseEnv(), ...env }, timeout: 180_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: dir };
};
const readCell = (out: string, arm: string, rep = 1): CellRecord => JSON.parse(readFileSync(join(out, 'cells', 'mini', arm, String(rep), 'cell.json'), 'utf8')) as CellRecord;
const report = (out: string): Report => {
  const r = spawnSync(process.execPath, [join(dist, 'bench', 'report.js'), '--run', out], { encoding: 'utf8', env: baseEnv() });
  expect(r.status, r.stderr).toBe(0);
  const files = readdirSync(join(out, 'reports')).filter((f) => f.endsWith('.json')).sort();
  return JSON.parse(readFileSync(join(out, 'reports', files[files.length - 1]!), 'utf8')) as Report;
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jev-bench-'));
  dist = join(tmp, 'dist');
  chmodSync(fake, 0o755);
  const r = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json'), '--outDir', dist], { encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  pluginDir = join(tmp, 'plugin');
  cpSync(dist, join(pluginDir, 'dist'), { recursive: true });
  for (const rel of ['hooks', 'agents', '.claude-plugin']) cpSync(join(root, rel), join(pluginDir, rel), { recursive: true });
}, 60_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('plan', () => {
  it('prints the plan to stdout and writes nothing without --execute', () => {
    const r = bench(['--seed', '7']);
    expect(r.status, r.stderr).toBe(0);
    const plan = JSON.parse(r.stdout) as Plan;
    expect(plan.schema).toBe(5);
    expect(plan.planned_cells).toBe(6);
    expect(plan.arms.map((a) => a.arm).sort()).toEqual([...ARMS].sort());
    expect(plan.arms.filter((a) => a.experimentAdmission === 'orchestrated').map((a) => a.arm).sort()).toEqual(['frontier_orchestrated', 'orchestrated_control']);
    expect(plan.arms.filter((a) => a.rootModel === 'fable').map((a) => a.arm).sort()).toEqual(['frontier_native', 'frontier_orchestrated']);
    expect(existsSync(r.out)).toBe(false);
    expect(JSON.parse(bench(['--seed', '7']).stdout).rows).toEqual(plan.rows);
    const subset = JSON.parse(bench(['--arms', 'jev_hierarchy,native_hierarchy', '--repetitions', '2']).stdout) as Plan;
    expect(subset.planned_cells).toBe(4);
    expect(subset.rows).toHaveLength(2);
  });

  it('rejects invalid arms, the retired fixed_hierarchy, regrade+execute, unsafe ids and a missing session budget', () => {
    expect(bench(['--arms', 'jev_hierarchy,bogus']).status).toBe(1);
    const retired = bench(['--arms', 'jev_hierarchy,fixed_hierarchy']);
    expect(retired.status).toBe(1);
    expect(retired.stderr).toMatch(/--arms must be a unique subset/);
    expect(bench(['--arms', 'jev_hierarchy,jev_hierarchy']).status).toBe(1);
    expect(bench(['--regrade', '--execute', '--max-sessions', '6']).status).toBe(1);
    expect(bench(['--execute']).stderr).toMatch(/--max-sessions/);
    const badManifest = join(tmp, 'bad.json');
    require('node:fs').writeFileSync(badManifest, JSON.stringify({ version: 5, cases: [{ id: '../../victim', group: 'g', fixtureDir: 'x', request: 'r', setup: [], checkFile: 'c.mjs' }] }));
    const r = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--cases', badManifest, '--out', join(tmp, 'never')], { encoding: 'utf8', env: baseEnv() });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a safe path component/);
    expect(existsSync(join(tmp, 'never'))).toBe(false);
  });

  it('loads the V5 manifest and its per-job fragments with the same safety checks', () => {
    const v5 = loadManifest(join(root, 'bench', 'v5', 'cases.json'));
    expect(v5.version).toBe(5);
    expect(v5.cases.map((c) => c.id).sort()).toEqual(['mini-sql', 'orbit-core']);
    for (const c of v5.cases) {
      expect(existsSync(c.fixtureDir)).toBe(true);
      expect(existsSync(c.checkFile)).toBe(true);
      expect(c.checkFileRel.startsWith('checkers/')).toBe(true);
    }
    expect(loadManifest(join(root, 'bench', 'v5', 'cases.orbit-core.json')).cases).toHaveLength(1);
    const v2 = join(tmp, 'v2.json');
    require('node:fs').writeFileSync(v2, JSON.stringify({ version: 2, cases: [] }));
    expect(() => loadManifest(v2)).toThrow(/version:3\|4\|5/);
  });
});

describe('execute', () => {
  it('refuses to start (writing nothing) under API-key auth, unverifiable auth, missing key with the Jev arm, or a low budget', () => {
    for (const [args, env, pattern] of [
      [['--execute', '--max-sessions', '6'], { ANTHROPIC_API_KEY: 'sk-x' }, /ANTHROPIC_API_KEY/],
      [['--execute', '--max-sessions', '6'], { FAKE_CLAUDE_AUTH_EXIT: '7' }, /cannot verify subscription OAuth/],
      [['--execute', '--max-sessions', '6'], { FAKE_CLAUDE_AUTH: JSON.stringify({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' }) }, /not claude\.ai subscription OAuth/],
      [['--execute', '--max-sessions', '5'], {}, /below the 6 planned/],
    ] as Array<[string[], Record<string, string>, RegExp]>) {
      const r = bench(args, env);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(pattern);
      expect(existsSync(r.out)).toBe(false);
    }
    const noKey = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--cases', cases, '--out', join(tmp, 'nokey'), '--claude', fake, '--plugin-dir', pluginDir, '--execute', '--max-sessions', '6'], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home') } });
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toMatch(/TYPESAFE_API_KEY/);
    const noKeyNoJev = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--cases', cases, '--out', join(tmp, 'nokey-ok'), '--claude', fake, '--plugin-dir', pluginDir, '--execute', '--max-sessions', '1', '--arms', 'sonnet_native'], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home') } });
    expect(noKeyNoJev.status, noKeyNoJev.stderr).toBe(0);
  });

  it('refuses an existing output directory, even an empty one', () => {
    const out = join(tmp, 'existing');
    mkdirSync(out);
    const r = bench(['--execute', '--max-sessions', '6'], {}, out);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('runs six arms from frozen inputs with identical prompts, a private state dir and whole-tree accounting', () => {
    const r = bench(['--execute', '--max-sessions', '6', '--seed', '3', '--timeout-ms', '60000']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const plan = JSON.parse(readFileSync(join(r.out, 'plan.json'), 'utf8')) as Plan;
    expect(plan.preflight?.errors).toEqual([]);
    expect(existsSync(join(r.out, 'inputs', 'plugin', 'dist', 'hook.js'))).toBe(true);
    expect(existsSync(join(r.out, 'inputs', 'bench', 'checker.mjs'))).toBe(true);
    const cells = Object.fromEntries(ARMS.map((a) => [a, readCell(r.out, a)])) as Record<(typeof ARMS)[number], CellRecord>;
    expect(new Set(ARMS.map((a) => cells[a].request_sha256)).size).toBe(1);
    expect(new Set(ARMS.map((a) => cells[a].fixture_sha256)).size).toBe(1);
    for (const a of ARMS) {
      const c = cells[a];
      expect(c.schema, a).toBe(5);
      expect(c.started).toBe(true);
      expect(c.spawn!.env_added).toEqual(expect.arrayContaining(['CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']));
      expect(c.result?.usage_status).toBe('ok');
      expect(c.root_model_consistent, a).toBe(true);
      expect(existsSync(join(r.out, 'cells', 'mini', a, '1', 'final', '.env'))).toBe(false);
    }
    for (const a of ['sonnet_native', 'frontier_native'] as const) {
      expect(cells[a].spawn!.argv).not.toContain('--plugin-dir');
      expect(cells[a].state_dir).toBeNull();
      expect(cells[a].gate.jev_input_tokens).toBe(0);
      expect(cells[a].gate.jev_cost_usd).toBe(0);
      expect(cells[a].gate.outcome).toBeNull();
    }
    // Each hierarchy cell gets its own state root inside the cell, so job state never reaches HOME or another cell.
    const stateDirs = new Set<string>();
    for (const a of ['native_hierarchy', 'orchestrated_control', 'frontier_orchestrated', 'jev_hierarchy'] as const) {
      const c = cells[a];
      expect(c.spawn!.argv).toContain(join(r.out, 'inputs', 'plugin'));
      expect(c.init!.jev_gate_loaded).toBe(true);
      expect(c.spawn!.env_added).toContain('JEV_GATE_STATE_DIR');
      expect(c.state_dir).toBe(join(r.out, 'cells', 'mini', a, '1', 'state'));
      expect(existsSync(c.state_dir!)).toBe(true);
      stateDirs.add(c.state_dir!);
      expect(c.gate.prompt_injections).toBe(1);
    }
    expect(stateDirs.size).toBe(4);
    expect(existsSync(join(tmp, 'home', '.local', 'state', 'jev-gate'))).toBe(false);
    for (const a of ['orchestrated_control', 'frontier_orchestrated'] as const) {
      expect(cells[a].experiment_admission).toBe('orchestrated');
      expect(cells[a].spawn!.env_added).toContain('JEV_GATE_EXPERIMENT_ADMISSION');
    }
    expect(cells.native_hierarchy.experiment_admission).toBeNull();
    expect(cells.jev_hierarchy.spawn!.env_added).not.toContain('JEV_GATE_EXPERIMENT_ADMISSION');

    // native: admission recorded as not sent, no Jev spend, no plan
    expect(cells.native_hierarchy.gate.admission).toMatchObject({ attempted: false, known_not_sent: true, decision: 'direct', reason: 'mode_native', choice: null });
    expect(cells.native_hierarchy.gate).toMatchObject({ skipped: { mode_native: 1 }, jev_input_tokens: 0, jev_cost_usd: 0, guard_denials: 0, outcome: 'completed' });
    expect(cells.native_hierarchy.gate.worker_calls['standard']).toMatchObject({ calls: 1, preserved: 1, patched: 0, pinned: 0 });

    // control arms: same state and guard as auto, no Jev calls at all
    for (const a of ['orchestrated_control', 'frontier_orchestrated'] as const) {
      const g = cells[a].gate;
      expect(g.admission, a).toMatchObject({ attempted: false, known_not_sent: true, decision: 'orchestrated' });
      expect(g.guard_denials, a).toBe(3);
      expect(g.continue_false, a).toBe(1);
      expect(g.planner_calls, a).toMatchObject({ requested: 1, completed: 1, plan_status: 'ready', rev: 1, model_observed: 'claude-opus-5', tier_proposed: null });
      expect(g.receipts, a).toEqual({ accept: 2, incomplete: 1, invalid: 0, unknown: 1 });
      expect(g.advisory, a).toEqual({ accept: 0, rework: 0, replan: 0, abstain: 0, none: 4 });
      expect(g.outcome, a).toBe('incomplete');
      expect(g.jev_input_tokens, a).toBe(0);
      expect(Object.fromEntries(Object.entries(g.worker_calls).map(([t, w]) => [t, w.calls])), a).toEqual({ fast: 2, standard: 1, deep: 1 });
      // Self-routing picks the profile, so nothing is patched and reservations are unobservable without Gate B.
      expect(Object.values(g.worker_calls).every((w) => w.patched === 0), a).toBe(true);
      expect(g.parallel, a).toEqual({ reservation_overlap_max: 0, observed_overlap_max: 2 });
    }

    const jev = cells.jev_hierarchy.gate;
    expect(jev.admission).toMatchObject({ attempted: true, known_not_sent: false, choice: 'orchestrated', confidence: 0.93 });
    expect(jev.guard_denials).toBe(0);
    expect(jev.planner_calls).toMatchObject({ requested: 1, completed: 1, tier_proposed: 'deep', model_observed: 'claude-opus-5', plan_status: 'ready', rev: 1 });
    expect(jev.receipts).toEqual({ accept: 2, incomplete: 1, invalid: 0, unknown: 1 });
    expect(jev.advisory).toEqual({ accept: 0, rework: 1, replan: 0, abstain: 0, none: 3 });
    expect(jev.jev_requests.admission).toMatchObject({ attempts: 1, tokens: 300 });
    expect(jev.jev_requests.allocation).toMatchObject({ attempts: 6, tokens: 2220 });
    expect(jev.jev_requests.result).toMatchObject({ attempts: 1, tokens: 200 });
    expect(jev.jev_input_tokens).toBe(2720);
    expect(jev.jev_cost_usd).toBeCloseTo((2720 * 0.042) / 1_000_000, 12);
    expect(jev.parallel).toEqual({ reservation_overlap_max: 2, observed_overlap_max: 2 });
    expect(jev.outcome).toBe('incomplete');
    // A material model change on a standard call is the patch; the deep call that stayed opus is preserved.
    expect(jev.worker_calls['standard']).toMatchObject({ calls: 2, patched: 1, preserved: 0, proposed: { deep: 1, standard: 1 } });
    expect(jev.worker_calls['deep']).toMatchObject({ calls: 1, patched: 0, preserved: 1, root_effort: { high: 1 } });
    expect(jev.worker_calls['fast']).toMatchObject({ calls: 2, preserved: 2, root_effort: { unknown: 2 } });
    // Union join: the paid record with no stream call and the late orphan result both stay visible.
    const byId = Object.fromEntries(cells.jev_hierarchy.agent_calls.map((c) => [c.tool_use_id, c]));
    expect(cells.jev_hierarchy.agent_calls).toHaveLength(7);
    expect(byId['toolu_orphanpaid']).toMatchObject({ from_stream: false, from_records: true, role: 'worker', called_tier: 'standard' });
    expect(byId['toolu_lateresult']).toMatchObject({ from_stream: false, orphaned: true });
    expect(jev.orphan_records).toBe(1);
    expect(jev.missing_pre_records).toBe(0);
    expect(jev.attempt_unknown).toBe(0);

    expect(cells.sonnet_native.grade?.quality).toBe('fail');
    for (const a of ARMS.filter((x) => x !== 'sonnet_native')) expect(cells[a].grade?.quality, a).toBe('pass');

    const rep = report(r.out);
    expect(rep.schema).toBe(5);
    expect(rep.planned_rows).toBe(6);
    expect(rep.per_job.map((j) => j.job)).toEqual(['mini']);
    expect(rep.per_job[0]!.arms).toHaveLength(6);
    const byArm = Object.fromEntries(rep.arms.map((a) => [a.arm, a]));
    expect(byArm['frontier_native']!.fable_tokens).toBe(1260);
    expect(byArm['jev_hierarchy']!.gate_v5.receipts).toEqual({ accept: 2, incomplete: 1, invalid: 0, unknown: 1 });
    expect(byArm['jev_hierarchy']!.gate_v5.admission).toEqual({ 'choice:orchestrated': 1 });
    expect(byArm['orchestrated_control']!.gate_v5.admission).toEqual({ orchestrated: 1 });
    expect(byArm['orchestrated_control']!.gate_v5.guard_denials).toBe(3);
    expect(byArm['jev_hierarchy']!.gate_v5.jev_requests.allocation.tokens).toBe(2220);
    expect(byArm['sonnet_native']!.pass).toBe(0);
    const criteria = Object.fromEntries(rep.comparisons.filter((c) => c.criterion !== 'none').map((c) => [c.control, c]));
    expect(Object.keys(criteria).sort()).toEqual(['frontier_native', 'frontier_orchestrated', 'orchestrated_control', 'sonnet_native']);
    expect(criteria['sonnet_native']!.verdict).toBe('met');
    expect(criteria['frontier_native']!.criterion).toBe('product_target');
    expect(criteria['frontier_native']!.verdict).toBe('not_met');
    expect(rep.conclusion.category).toBe('no added value over matched orchestration');
    expect(existsSync(join(r.out, 'reports', 'report-1.md'))).toBe(true);
    report(r.out);
    expect(existsSync(join(r.out, 'reports', 'report-2.md'))).toBe(true);
  }, 240_000);

  it('records missing allocation records as unknown Jev consumption and an intent-only record as attempt unknown', () => {
    const missing = bench(['--execute', '--max-sessions', '1', '--arms', 'jev_hierarchy'], { FAKE_CLAUDE_MISSING_PRE: '1' });
    expect(missing.status, missing.stderr).toBe(0);
    const c1 = readCell(missing.out, 'jev_hierarchy');
    expect(c1.gate).toMatchObject({ missing_pre_records: 4, jev_input_tokens: null, jev_cost_usd: null });
    expect(c1.gate.jev_requests.admission.tokens).toBe(300);
    const intent = bench(['--execute', '--max-sessions', '1', '--arms', 'jev_hierarchy'], { FAKE_CLAUDE_INTENT_ONLY: '1' });
    const c2 = readCell(intent.out, 'jev_hierarchy');
    expect(c2.gate).toMatchObject({ attempt_unknown: 4, jev_input_tokens: null });
    expect(c2.gate.jev_requests.allocation.tokens).toBeNull();
    expect(report(intent.out).arms[0]!.jev_cost_usd).toBeNull();
  }, 120_000);

  it('--regrade re-scores saved snapshots in a new eval dir, keeps history, and never re-runs the CLI', () => {
    const r = bench(['--execute', '--max-sessions', '2', '--arms', 'sonnet_native,jev_hierarchy', '--seed', '11']);
    expect(r.status, r.stderr).toBe(0);
    const before = readCell(r.out, 'sonnet_native');
    expect(before.grade?.quality).toBe('fail');
    const mtime = require('node:fs').statSync(join(r.out, 'cells', 'mini', 'sonnet_native', '1', 'stream.jsonl')).mtimeMs;
    const again = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--regrade', '--cases', cases, '--out', r.out], { encoding: 'utf8', env: baseEnv(), timeout: 120_000 });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/regraded 2 cells/);
    const after = readCell(r.out, 'sonnet_native');
    expect(after.grade_history).toHaveLength(1);
    expect(after.grade_history[0]!.grade?.quality).toBe('fail');
    expect(existsSync(join(r.out, 'cells', 'mini', 'sonnet_native', '1', 'eval-1'))).toBe(true);
    expect(existsSync(join(r.out, 'cells', 'mini', 'sonnet_native', '1', 'eval-2'))).toBe(true);
    expect(require('node:fs').statSync(join(r.out, 'cells', 'mini', 'sonnet_native', '1', 'stream.jsonl')).mtimeMs).toBe(mtime);
    expect(again.stdout).toMatch(/frozen inputs/);
  }, 180_000);

  it('cleans up a hung session, marks it timed out with an unknown verdict, and keeps the planned denominator', () => {
    const r = bench(['--execute', '--max-sessions', '1', '--arms', 'frontier_native', '--timeout-ms', '1500'], { FAKE_CLAUDE_HANG: '1' });
    expect(r.status, r.stderr).toBe(0);
    const c = readCell(r.out, 'frontier_native');
    expect(c.timed_out).toBe(true);
    expect(c.started).toBe(true);
    expect(c.result?.usage_status).toBe('no_result');
    expect(c.grade?.quality).toBe('unknown');
    expect(c.grade?.reason).toMatch(/timed out/);
    const rep = report(r.out);
    expect(rep.arms[0]).toMatchObject({ planned: 1, by_status: expect.objectContaining({ timed_out: 1 }), unknown: 1, total_cost_usd: null });
  }, 60_000);
});

describe('overlap arithmetic', () => {
  it('counts concurrent intervals and treats touching intervals as sequential', () => {
    expect(maxOverlap([])).toBe(0);
    expect(maxOverlap([[0, 10]])).toBe(1);
    expect(maxOverlap([[0, 10], [10, 20]])).toBe(1);
    expect(maxOverlap([[0, 10], [5, 20], [6, 7]])).toBe(3);
    expect(maxOverlap([[0, 10], [11, 20], [12, 30]])).toBe(2);
  });
});
