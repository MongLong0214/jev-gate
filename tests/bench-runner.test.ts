import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Report } from '../src/bench/report.js';
import type { CellRecord, Plan } from '../src/bench/run.js';

const root = join(__dirname, '..');
const fake = join(__dirname, 'fixtures', 'fake-claude.mjs');
const cases = join(__dirname, 'fixtures', 'mini', 'cases.json');
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
    expect(plan.planned_cells).toBe(5);
    expect(plan.arms.map((a) => a.arm).sort()).toEqual(['fixed_hierarchy', 'frontier_native', 'jev_hierarchy', 'native_hierarchy', 'sonnet_native']);
    expect(plan.arms.find((a) => a.arm === 'fixed_hierarchy')?.experimentalAllocation).toMatch(/default model/);
    expect(existsSync(r.out)).toBe(false);
    expect(JSON.parse(bench(['--seed', '7']).stdout).rows).toEqual(plan.rows);
    const subset = JSON.parse(bench(['--arms', 'jev_hierarchy,native_hierarchy', '--repetitions', '2']).stdout) as Plan;
    expect(subset.planned_cells).toBe(4);
    expect(subset.rows).toHaveLength(2);
  });

  it('rejects invalid arms, regrade+execute, unsafe ids and a missing session budget', () => {
    expect(bench(['--arms', 'jev_hierarchy,bogus']).status).toBe(1);
    expect(bench(['--regrade', '--execute', '--max-sessions', '5']).status).toBe(1);
    expect(bench(['--execute']).stderr).toMatch(/--max-sessions/);
    const badManifest = join(tmp, 'bad.json');
    require('node:fs').writeFileSync(badManifest, JSON.stringify({ version: 4, cases: [{ id: '../../victim', group: 'g', fixtureDir: 'x', request: 'r', setup: [], checkFile: 'c.mjs' }] }));
    const r = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--cases', badManifest, '--out', join(tmp, 'never')], { encoding: 'utf8', env: baseEnv() });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a safe path component/);
    expect(existsSync(join(tmp, 'never'))).toBe(false);
  });
});

describe('execute', () => {
  it('refuses to start (writing nothing) under API-key auth, unverifiable auth, missing key with the Jev arm, or a low budget', () => {
    for (const [args, env, pattern] of [
      [['--execute', '--max-sessions', '5'], { ANTHROPIC_API_KEY: 'sk-x' }, /ANTHROPIC_API_KEY/],
      [['--execute', '--max-sessions', '5'], { FAKE_CLAUDE_AUTH_EXIT: '7' }, /cannot verify subscription OAuth/],
      [['--execute', '--max-sessions', '5'], { FAKE_CLAUDE_AUTH: JSON.stringify({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' }) }, /not claude\.ai subscription OAuth/],
      [['--execute', '--max-sessions', '4'], {}, /below the 5 planned/],
    ] as Array<[string[], Record<string, string>, RegExp]>) {
      const r = bench(args, env);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(pattern);
      expect(existsSync(r.out)).toBe(false);
    }
    const noKey = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--cases', cases, '--out', join(tmp, 'nokey'), '--claude', fake, '--plugin-dir', pluginDir, '--execute', '--max-sessions', '5'], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home') } });
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toMatch(/TYPESAFE_API_KEY/);
    const noKeyNoJev = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--cases', cases, '--out', join(tmp, 'nokey-ok'), '--claude', fake, '--plugin-dir', pluginDir, '--execute', '--max-sessions', '1', '--arms', 'sonnet_native'], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home') } });
    expect(noKeyNoJev.status, noKeyNoJev.stderr).toBe(0);
  });

  it('refuses an existing output directory, even an empty one', () => {
    const out = join(tmp, 'existing');
    mkdirSync(out);
    const r = bench(['--execute', '--max-sessions', '5'], {}, out);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('runs five arms from frozen inputs with identical prompts, whole-tree accounting and V4 gate facts', () => {
    const r = bench(['--execute', '--max-sessions', '5', '--seed', '3', '--timeout-ms', '60000']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const plan = JSON.parse(readFileSync(join(r.out, 'plan.json'), 'utf8')) as Plan;
    expect(plan.preflight?.errors).toEqual([]);
    expect(existsSync(join(r.out, 'inputs', 'plugin', 'dist', 'hook.js'))).toBe(true);
    expect(existsSync(join(r.out, 'inputs', 'bench', 'checker.mjs'))).toBe(true);
    const arms = ['sonnet_native', 'native_hierarchy', 'jev_hierarchy', 'frontier_native', 'fixed_hierarchy'] as const;
    const cells = Object.fromEntries(arms.map((a) => [a, readCell(r.out, a)])) as Record<(typeof arms)[number], CellRecord>;
    expect(new Set(arms.map((a) => cells[a].request_sha256)).size).toBe(1);
    expect(new Set(arms.map((a) => cells[a].fixture_sha256)).size).toBe(1);
    for (const a of arms) {
      const c = cells[a];
      expect(c.started).toBe(true);
      expect(c.dispatch.intent_at).not.toBeNull();
      expect(c.dispatch.spawn_observed_at).not.toBeNull();
      expect(c.spawn!.env_added).toEqual(expect.arrayContaining(['CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']));
      expect(c.result?.usage_status).toBe('ok');
      expect(c.root_model_consistent).toBe(true);
      expect(existsSync(join(r.out, 'cells', 'mini', a, '1', 'final', 'scratch', 'note.txt'))).toBe(true);
      expect(existsSync(join(r.out, 'cells', 'mini', a, '1', 'final', '.env'))).toBe(false);
      expect(c.final_snapshot?.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ path: '.env', kind: 'sensitive' })]));
    }
    for (const a of ['sonnet_native', 'frontier_native'] as const) {
      expect(cells[a].spawn!.argv).not.toContain('--plugin-dir');
      expect(cells[a].init!.jev_gate_loaded).toBe(false);
      expect(cells[a].gate.jev_input_tokens).toBe(0);
      expect(cells[a].gate.jev_cost_usd).toBe(0);
    }
    for (const a of ['native_hierarchy', 'jev_hierarchy', 'fixed_hierarchy'] as const) {
      expect(cells[a].spawn!.argv).toContain(join(r.out, 'inputs', 'plugin'));
      expect(cells[a].init!.jev_gate_loaded).toBe(true);
      expect(cells[a].gate.prompt_injections).toBe(1);
      expect(cells[a].gate.owned_calls).toBe(1);
    }
    expect(cells.native_hierarchy.gate).toMatchObject({ pinned: 1, eligible_attempted: 0, skipped: { mode_native: 1 }, jev_input_tokens: 0, jev_cost_usd: 0 });
    expect(cells.native_hierarchy.agent_calls[0]!.resolved_models_stream).toEqual(['claude-opus-5']);
    expect(cells.fixed_hierarchy.spawn!.env_added).toContain('JEV_GATE_EXPERIMENT_ALLOCATION');
    expect(cells.fixed_hierarchy.gate.pinned).toBe(0);
    const jev = cells.jev_hierarchy;
    expect(jev.gate).toMatchObject({ eligible_attempted: 1, patched: 1, preserved: 0, jev_input_tokens: 500, jev_model: 'jev-1.13.0', hint_delivered: 1, target_model_matches: 1, missing_pre_records: 0, attempt_unknown: 0 });
    expect(jev.gate.jev_cost_usd).toBeCloseTo((500 * 0.042) / 1_000_000, 12);
    expect(jev.agent_calls[0]!.pre?.['attempted']).toBe(true);
    expect((jev.agent_calls[0]!.post?.['tool_response'] as Record<string, unknown>)['resolvedModel']).toBe('claude-sonnet-5');
    expect(Object.keys(jev.result!.model_usage!).sort()).toEqual(['claude-sonnet-5']);
    expect(cells.sonnet_native.grade?.quality).toBe('fail');
    for (const a of ['native_hierarchy', 'jev_hierarchy', 'frontier_native', 'fixed_hierarchy'] as const) expect(cells[a].grade?.quality, a).toBe('pass');
    expect(cells.jev_hierarchy.grade?.checkerId).toMatch(/^sha256:/);

    const rep = report(r.out);
    expect(rep.planned_rows).toBe(5);
    const byArm = Object.fromEntries(rep.arms.map((a) => [a.arm, a]));
    expect(byArm['frontier_native']!.fable_tokens).toBe(1260);
    expect(byArm['jev_hierarchy']!.fable_tokens).toBe(0);
    expect(byArm['jev_hierarchy']!.total_cost_usd).toBeCloseTo(0.03 + (500 * 0.042) / 1_000_000, 10);
    expect(byArm['sonnet_native']!.pass).toBe(0);
    const primary = rep.comparisons.find((c) => c.treatment === 'jev_hierarchy' && c.control === 'native_hierarchy')!;
    expect(primary.validity).toBe('ok');
    expect(primary.cost_known).toBe(true);
    expect(primary.pass_treatment).toBe(1);
    expect(existsSync(join(r.out, 'reports', 'report-1.md'))).toBe(true);
    report(r.out);
    expect(existsSync(join(r.out, 'reports', 'report-2.md'))).toBe(true);
  }, 180_000);

  it('records a missing pre record as unknown Jev consumption and an intent-only record as attempt unknown', () => {
    const missing = bench(['--execute', '--max-sessions', '1', '--arms', 'jev_hierarchy'], { FAKE_CLAUDE_MISSING_PRE: '1' });
    expect(missing.status, missing.stderr).toBe(0);
    const c1 = readCell(missing.out, 'jev_hierarchy');
    expect(c1.gate).toMatchObject({ missing_pre_records: 1, eligible_attempted: 0, jev_input_tokens: null, jev_cost_usd: null });
    const intent = bench(['--execute', '--max-sessions', '1', '--arms', 'jev_hierarchy'], { FAKE_CLAUDE_INTENT_ONLY: '1' });
    const c2 = readCell(intent.out, 'jev_hierarchy');
    expect(c2.gate).toMatchObject({ attempt_unknown: 1, eligible_attempted: 0, jev_input_tokens: null });
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
