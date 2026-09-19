import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ConfigV5 } from '../src/types.js';
import type { Report } from '../src/bench/report.js';
import { loadManifest, maxOverlap, type CellRecord, type Plan } from '../src/bench/run.js';

const root = join(__dirname, '..');
const fake = join(__dirname, 'fixtures', 'fake-claude.mjs');
const cases = join(__dirname, 'fixtures', 'mini', 'cases.json');
const ARMS = ['sonnet_native', 'frontier_native', 'native_hierarchy', 'orchestrated_control', 'frontier_orchestrated', 'jev_hierarchy', 'jev_single', 'jev_forced_orchestration'] as const;
const JEV_ARMS = ['jev_hierarchy', 'jev_forced_orchestration'] as const;
const HIERARCHY_ARMS = ['native_hierarchy', 'orchestrated_control', 'frontier_orchestrated', 'jev_hierarchy', 'jev_forced_orchestration'] as const;
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
    expect(plan.planned_cells).toBe(8);
    expect(plan.arms.map((a) => a.arm).sort()).toEqual([...ARMS].sort());
    expect(plan.arms.filter((a) => a.experimentAdmission === 'orchestrated').map((a) => a.arm).sort()).toEqual(['frontier_orchestrated', 'jev_forced_orchestration', 'orchestrated_control']);
    expect(plan.arms.filter((a) => a.diagnostic).map((a) => a.arm)).toEqual(['jev_forced_orchestration']);
    expect(plan.arms.filter((a) => a.mode === 'auto').map((a) => a.arm).sort()).toEqual(['jev_forced_orchestration', 'jev_hierarchy', 'jev_single']);
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
    expect(bench(['--regrade', '--execute', '--max-sessions', '8']).status).toBe(1);
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
      [['--execute', '--max-sessions', '8'], { ANTHROPIC_API_KEY: 'sk-x' }, /ANTHROPIC_API_KEY/],
      [['--execute', '--max-sessions', '8'], { FAKE_CLAUDE_AUTH_EXIT: '7' }, /cannot verify subscription OAuth/],
      [['--execute', '--max-sessions', '8'], { FAKE_CLAUDE_AUTH: JSON.stringify({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' }) }, /not claude\.ai subscription OAuth/],
      [['--execute', '--max-sessions', '7'], {}, /below the 8 planned/],
    ] as Array<[string[], Record<string, string>, RegExp]>) {
      const r = bench(args, env);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(pattern);
      expect(existsSync(r.out)).toBe(false);
    }
    const noKey = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--cases', cases, '--out', join(tmp, 'nokey'), '--claude', fake, '--plugin-dir', pluginDir, '--execute', '--max-sessions', '8'], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home') } });
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toMatch(/TYPESAFE_API_KEY/);
    const noKeyNoJev = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--cases', cases, '--out', join(tmp, 'nokey-ok'), '--claude', fake, '--plugin-dir', pluginDir, '--execute', '--max-sessions', '1', '--arms', 'sonnet_native'], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home') } });
    expect(noKeyNoJev.status, noKeyNoJev.stderr).toBe(0);
  });

  it('refuses an existing output directory, even an empty one', () => {
    const out = join(tmp, 'existing');
    mkdirSync(out);
    const r = bench(['--execute', '--max-sessions', '8'], {}, out);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('runs eight arms from frozen inputs with identical prompts, a private state dir and whole-tree accounting', () => {
    const r = bench(['--execute', '--max-sessions', '8', '--seed', '3', '--timeout-ms', '60000']);
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
    for (const a of HIERARCHY_ARMS) {
      const c = cells[a];
      expect(c.spawn!.argv).toContain(join(r.out, 'inputs', 'plugin'));
      expect(c.init!.jev_gate_loaded).toBe(true);
      expect(c.spawn!.env_added).toContain('JEV_GATE_STATE_DIR');
      expect(c.state_dir).toBe(join(r.out, 'cells', 'mini', a, '1', 'state'));
      expect(existsSync(c.state_dir!)).toBe(true);
      stateDirs.add(c.state_dir!);
      expect(c.gate.prompt_injections).toBe(1);
    }
    expect(stateDirs.size).toBe(5);
    expect(existsSync(join(tmp, 'home', '.local', 'state', 'jev-gate'))).toBe(false);
    for (const a of ['orchestrated_control', 'frontier_orchestrated', 'jev_forced_orchestration'] as const) {
      expect(cells[a].experiment_admission, a).toBe('orchestrated');
      expect(cells[a].spawn!.env_added, a).toContain('JEV_GATE_EXPERIMENT_ADMISSION');
    }
    expect(cells.native_hierarchy.experiment_admission).toBeNull();
    expect(cells.jev_hierarchy.spawn!.env_added).not.toContain('JEV_GATE_EXPERIMENT_ADMISSION');
    expect(ARMS.filter((a) => cells[a].diagnostic)).toEqual(['jev_forced_orchestration']);

    // A19: the single arm loads a config derived from the frozen one inside its own cell, and the cell records which
    // file that was with its hash. Every other arm loads the frozen file itself, so the override is visible per cell
    // rather than asserted for the run.
    const frozen = JSON.parse(readFileSync(String(plan.frozen_inputs!['config_copy']), 'utf8')) as Record<string, unknown>;
    const override = cells.jev_single.config_override!;
    expect(override.path).toBe(join(r.out, 'cells', 'mini', 'jev_single', '1', 'config.json'));
    const overrideText = readFileSync(override.path, 'utf8');
    expect(createHash('sha256').update(overrideText).digest('hex')).toBe(override.sha256);
    expect(override.admittedShape).toBe('single');
    // Only the one key differs, so the two plugin arms are the same run in every other respect.
    expect(JSON.parse(overrideText)).toEqual({ ...frozen, admittedShape: 'single' });
    expect(cells.jev_single.spawn!.env_added).toContain('JEV_GATE_CONFIG');
    for (const a of ARMS.filter((x) => x !== 'jev_single')) expect(cells[a].config_override, a).toBeNull();

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
      expect(g.receipts, a).toEqual({ accept: 2, incomplete: 1, invalid: 0, unknown: 1, rework: 0, replan: 0 });
      expect(g.advisory, a).toEqual({ accept: 0, rework: 0, replan: 0, abstain: 0, none: 4 });
      expect(g.outcome, a).toBe('incomplete');
      expect(g.jev_input_tokens, a).toBe(0);
      expect(Object.fromEntries(Object.entries(g.worker_calls).map(([t, w]) => [t, w.calls])), a).toEqual({ fast: 3, standard: 1, deep: 1 });
      // Self-routing picks the profile, so nothing is patched and reservations are unobservable without Gate B.
      expect(Object.values(g.worker_calls).every((w) => w.patched === 0), a).toBe(true);
      expect(g.parallel, a).toEqual({ reservation_overlap_max: 0, observed_overlap_max: 2 });
    expect(g.decision_mismatch, a).toBe(0);
    expect(g.admission.forced, a).toBe(true);
    }

    const jev = cells.jev_hierarchy.gate;
    expect(jev.admission).toMatchObject({ attempted: true, known_not_sent: false, forced: false, decided: true, choice: 'orchestrated', confidence: 0.93, decision: 'orchestrated', reason: null });
    expect(jev.guard_denials).toBe(0);
    expect(jev.planner_calls).toMatchObject({ requested: 1, completed: 1, tier_proposed: 'deep', model_observed: 'claude-opus-5', plan_status: 'ready', rev: 1 });
    // T11: the current policy runs no Gate C, so a deterministic accept is the receipt that stands.
    expect(jev.receipts).toEqual({ accept: 2, incomplete: 1, invalid: 0, unknown: 1, rework: 0, replan: 0 });
    expect(jev.advisory).toEqual({ accept: 0, rework: 0, replan: 0, abstain: 0, none: 4 });
    expect(jev.jev_requests.admission).toMatchObject({ attempts: 1, tokens: 300 });
    expect(jev.jev_requests.allocation).toMatchObject({ attempts: 7, tokens: 2620 });
    // T11: no Gate C and no plan-scope request on the current path; the buckets stay readable and stay at zero.
    expect(jev.jev_requests.result).toMatchObject({ attempts: 0, tokens: 0 });
    expect(jev.jev_requests.scope).toMatchObject({ attempts: 0, tokens: 0 });
    expect(jev.jev_input_tokens).toBe(2920);
    expect(jev.jev_cost_usd).toBeCloseTo((2920 * 0.042) / 1_000_000, 12);
    // A17 item 7: judgments made, and the ones that changed what would have happened without Jev.
    expect(jev.influence).toEqual({ judgments: 8, changed_default: 3 });
    expect(cells.orchestrated_control.gate.influence).toEqual({ judgments: 0, changed_default: 0 });
    expect(jev.parallel).toEqual({ reservation_overlap_max: 2, observed_overlap_max: 2 });
    expect(jev.outcome).toBe('incomplete');
    // The recorded Gate B decision is authoritative; `proposed` stays Jev's answer even when the call was preserved.
    expect(jev.worker_calls['standard']).toMatchObject({ calls: 2, patched: 2, preserved: 0, proposed: { deep: 1, standard: 1 } });
    expect(jev.worker_calls['deep']).toMatchObject({ calls: 1, patched: 1, preserved: 0, root_effort: { high: 1 } });
    expect(jev.worker_calls['fast']).toMatchObject({ calls: 3, patched: 2, preserved: 1, proposed: { fast: 1, deep: 2 }, root_effort: { unknown: 3 } });
    expect(jev.preserve_reasons).toEqual({ route_low_confidence: 1 });
    // Cross-check: Gate B recorded a patch to deep on t5, but the host resolved the fast profile's model.
    expect(jev.decision_mismatch).toBe(1);
    expect(jev.patched).toBe(5);
    expect(jev.preserved).toBe(1);
    // Union join: the paid record with no stream call and the late orphan result both stay visible.
    const byId = Object.fromEntries(cells.jev_hierarchy.agent_calls.map((c) => [c.tool_use_id, c]));
    expect(cells.jev_hierarchy.agent_calls).toHaveLength(8);
    // PostToolUseFailure leaves only a failure record, and it still joins to its stream call.
    expect(cells.jev_hierarchy.agent_calls.filter((c) => c.failure !== null)).toHaveLength(1);
    expect(byId['toolu_orphanpaid']).toMatchObject({ from_stream: false, from_records: true, role: 'worker', called_tier: 'standard' });
    expect(byId['toolu_lateresult']).toMatchObject({ from_stream: false, orphaned: true });
    expect(jev.orphan_records).toBe(1);
    expect(jev.missing_pre_records).toBe(0);
    expect(jev.attempt_unknown).toBe(0);

    const forcedJev = cells.jev_forced_orchestration.gate;
    expect(forcedJev.admission).toMatchObject({ attempted: false, known_not_sent: true, decision: 'orchestrated', reason: 'admission_forced', choice: null });
    expect(forcedJev.jev_requests.admission).toMatchObject({ attempts: 0, tokens: 0 });
    expect(forcedJev.jev_requests.allocation).toMatchObject({ attempts: 7, tokens: 2620 });
    expect(forcedJev.jev_requests.result).toMatchObject({ attempts: 0, tokens: 0 });
    expect(forcedJev.jev_requests.scope).toMatchObject({ attempts: 0, tokens: 0 });
    expect(forcedJev.jev_input_tokens).toBe(2620);
    // A16: Gate A is not asked here, so the forced admission is never counted as a judgment or as influence.
    expect(forcedJev.influence).toEqual({ judgments: 7, changed_default: 2 });
    expect(forcedJev.advisory.rework).toBe(0);
    expect(forcedJev.patched).toBe(5);
    expect(forcedJev.parallel.reservation_overlap_max).toBe(2);
    expect(forcedJev.guard_denials).toBe(0);
    expect(forcedJev.admission.forced).toBe(true);
    expect(forcedJev.decision_mismatch).toBe(1);

    expect(cells.sonnet_native.grade?.quality).toBe('fail');
    for (const a of ARMS.filter((x) => x !== 'sonnet_native')) expect(cells[a].grade?.quality, a).toBe('pass');

    const rep = report(r.out);
    expect(rep.schema).toBe(5);
    expect(rep.planned_rows).toBe(8);
    expect(rep.per_job.map((j) => j.job)).toEqual(['mini']);
    expect(rep.per_job[0]!.arms).toHaveLength(8);
    const byArm = Object.fromEntries(rep.arms.map((a) => [a.arm, a]));
    expect(byArm['frontier_native']!.fable_tokens).toBe(1260);
    expect(byArm['jev_hierarchy']!.gate_v5.receipts).toEqual({ accept: 2, incomplete: 1, invalid: 0, unknown: 1, rework: 0, replan: 0 });
    expect(byArm['jev_hierarchy']!.gate_v5.admission).toEqual({ orchestrated: 1 });
    expect(byArm['jev_forced_orchestration']!.diagnostic).toBe(true);
    expect(byArm['jev_hierarchy']!.diagnostic).toBe(false);
    expect(byArm['orchestrated_control']!.gate_v5.admission).toEqual({ 'forced:orchestrated': 1 });
    expect(byArm['jev_forced_orchestration']!.gate_v5.admission).toEqual({ 'forced:orchestrated': 1 });
    expect(byArm['orchestrated_control']!.gate_v5.guard_denials).toBe(3);
    expect(byArm['jev_hierarchy']!.gate_v5.jev_requests.allocation.tokens).toBe(2620);
    expect(byArm['sonnet_native']!.pass).toBe(0);
    const criteria = Object.fromEntries(rep.comparisons.filter((c) => c.criterion !== 'none').map((c) => [`${c.treatment}->${c.control}`, c]));
    expect(Object.keys(criteria).sort()).toEqual([
      'jev_forced_orchestration->frontier_orchestrated',
      'jev_forced_orchestration->orchestrated_control',
      'jev_hierarchy->frontier_native',
      'jev_hierarchy->frontier_orchestrated',
      'jev_hierarchy->orchestrated_control',
      'jev_hierarchy->sonnet_native',
    ]);
    expect(criteria['jev_hierarchy->sonnet_native']!.verdict).toBe('met');
    expect(criteria['jev_hierarchy->frontier_native']!.criterion).toBe('product_target');
    expect(criteria['jev_hierarchy->frontier_native']!.verdict).toBe('not_met');
    expect(criteria['jev_forced_orchestration->orchestrated_control']!.criterion).toBe('incremental_not_worse');
    expect(rep.conclusion.category).toBe('no added value over matched orchestration');
    expect(existsSync(join(r.out, 'reports', 'report-1.md'))).toBe(true);
    report(r.out);
    expect(existsSync(join(r.out, 'reports', 'report-2.md'))).toBe(true);
  }, 240_000);

  it('records missing allocation records as unknown Jev consumption and an intent-only record as attempt unknown', () => {
    const missing = bench(['--execute', '--max-sessions', '1', '--arms', 'jev_hierarchy'], { FAKE_CLAUDE_MISSING_PRE: '1' });
    expect(missing.status, missing.stderr).toBe(0);
    const c1 = readCell(missing.out, 'jev_hierarchy');
    expect(c1.gate).toMatchObject({ missing_pre_records: 5, jev_input_tokens: null, jev_cost_usd: null });
    expect(c1.gate.jev_requests.admission.tokens).toBe(300);
    const intent = bench(['--execute', '--max-sessions', '1', '--arms', 'jev_hierarchy'], { FAKE_CLAUDE_INTENT_ONLY: '1' });
    const c2 = readCell(intent.out, 'jev_hierarchy');
    expect(c2.gate).toMatchObject({ attempt_unknown: 5, jev_input_tokens: null });
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

describe('historical runs recorded under the earlier policy', () => {
  it('still reads the plan-scope gate, Gate C and its advisory, and counts them in the arm totals', () => {
    // T11 removed both gates from the live path. A run recorded before that is a fact about that run, so the reader
    // keeps parsing it; this is the only place those records are asserted.
    const r = bench(['--execute', '--max-sessions', '1', '--arms', 'jev_hierarchy', '--timeout-ms', '60000'], { FAKE_CLAUDE_HISTORICAL_GATES: '1' });
    expect(r.status, r.stderr).toBe(0);
    const g = readCell(r.out, 'jev_hierarchy').gate;
    expect(g.jev_requests.scope).toMatchObject({ attempts: 1, tokens: 150 });
    expect(g.jev_requests.result).toMatchObject({ attempts: 1, tokens: 200 });
    // Gate C demoted t3, so that accepted receipt reads as a rework and the totals still cover every dispatch.
    expect(g.receipts).toEqual({ accept: 1, incomplete: 1, invalid: 0, unknown: 1, rework: 1, replan: 0 });
    expect(g.advisory).toEqual({ accept: 0, rework: 1, replan: 0, abstain: 0, none: 3 });
    expect(g.influence).toEqual({ judgments: 10, changed_default: 5 });
    expect(g.jev_input_tokens).toBe(3270);
    expect(g.jev_cost_usd).toBeCloseTo((3270 * 0.042) / 1_000_000, 12);
    const arm = report(r.out).arms.find((a) => a.arm === 'jev_hierarchy')!;
    expect(arm.gate_v5.jev_requests.scope.tokens).toBe(150);
    expect(arm.gate_v5.receipts.rework).toBe(1);
    expect(arm.gate_v5.influence).toEqual({ judgments: 10, changed_default: 5 });
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------
// R11: the frozen configuration (document section T8). R08-R10 live in bench-ingest.test.ts, which needs no CLI.

describe('R11: the frozen configuration is the one the child reads', () => {
  const PARENT: ConfigV5['models'] = { fast: 'sonnet', standard: 'sonnet', deep: 'opus', frontier: 'fable' };
  const writeConfig = (path: string, models: ConfigV5['models'], cap: number): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 5, mode: 'auto', models, maxParallelWorkers: cap, requestDeadlineMs: 2500 }, null, 2));
  };

  it('plan, execution and accounting agree, and mid-run edits to either source do not reach later cells', () => {
    const home = join(tmp, 't8-home');
    const parentPath = join(tmp, 't8-parent.json');
    const homePath = join(home, '.config', 'jev-gate', 'config.json');
    writeConfig(parentPath, PARENT, 2);
    writeConfig(homePath, { fast: 'opus', standard: 'opus', deep: 'opus', frontier: 'opus' }, 7);
    const env = { HOME: home, JEV_GATE_CONFIG: parentPath };

    // plan-only still writes nothing, and it records the configuration the run would use.
    const planned = bench(['--arms', 'jev_hierarchy'], env);
    expect(planned.status, planned.stderr).toBe(0);
    expect(existsSync(planned.out)).toBe(false);
    expect((JSON.parse(planned.stdout) as Plan).effective_config?.models).toEqual(PARENT);

    const r = bench(['--execute', '--max-sessions', '2', '--arms', 'native_hierarchy,jev_hierarchy', '--seed', '5', '--timeout-ms', '60000'], { ...env, FAKE_CLAUDE_MUTATE_CONFIG: JSON.stringify([parentPath, homePath]) });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const plan = JSON.parse(readFileSync(join(r.out, 'plan.json'), 'utf8')) as Plan;
    const frozenPath = join(r.out, 'inputs', 'config.json');
    const frozen = JSON.parse(readFileSync(frozenPath, 'utf8')) as ConfigV5;
    expect(plan.effective_config_source).toBe(parentPath);
    expect(plan.effective_config).toEqual(frozen);
    expect(frozen).toMatchObject({ version: 5, models: PARENT, maxParallelWorkers: 2, requestDeadlineMs: 2500 });
    expect(JSON.stringify(frozen)).not.toMatch(/test-key/);

    // Both sources were rewritten while the run was in flight.
    for (const p of [parentPath, homePath]) expect((JSON.parse(readFileSync(p, 'utf8')) as ConfigV5).models.deep).toBe('mutated-deep');

    for (const arm of ['native_hierarchy', 'jev_hierarchy'] as const) {
      const observed = JSON.parse(readFileSync(join(r.out, 'cells', 'mini', arm, '1', 'trace', 'config-observed.json'), 'utf8')) as { path: string; from_env: boolean; config: ConfigV5 };
      expect(observed.path, arm).toBe(frozenPath);
      expect(observed.from_env, arm).toBe(true);
      expect(observed.config, arm).toEqual(frozen);
      expect(readCell(r.out, arm).spawn!.env_added, arm).toContain('JEV_GATE_CONFIG');
    }
    // Accounting reads the same frozen mapping: under it the fast profile is sonnet, so the haiku children that the
    // default mapping would have called a match are mismatches here.
    const g = readCell(r.out, 'jev_hierarchy').gate;
    expect(g.target_model_mismatches).toBe(3);
    expect(g.decision_mismatch).toBe(3);
  }, 120_000);

  it('refuses to start a plugin arm when the resolved configuration does not load', () => {
    const bad = join(tmp, 't8-bad.json');
    writeFileSync(bad, JSON.stringify({ version: 4, models: {} }));
    const r = bench(['--execute', '--max-sessions', '1', '--arms', 'jev_hierarchy'], { JEV_GATE_CONFIG: bad });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/config at .*t8-bad\.json does not load/);
    expect(existsSync(r.out)).toBe(false);
  });
});
