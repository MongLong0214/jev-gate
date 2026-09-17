import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CellRecord } from '../src/bench/run.js';
import type { Report } from '../src/bench/report.js';

const root = join(__dirname, '..');
const fake = join(__dirname, 'fixtures', 'fake-claude.mjs');
const cases = join(__dirname, 'fixtures', 'mini', 'cases.json');
let tmp: string;
let dist: string;
let pluginDir: string;
let runCount = 0;

const baseEnv = (): Record<string, string> => ({ PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home'), TYPESAFE_API_KEY: 'test-key' });
const bench = (args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string; out: string } => {
  const out = join(tmp, `run-${runCount++}`);
  const r = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--cases', cases, '--out', out, '--claude', fake, '--plugin-dir', pluginDir, ...args], { encoding: 'utf8', env: { ...baseEnv(), ...env }, timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
};
const readCell = (out: string, arm: string): CellRecord => JSON.parse(readFileSync(join(out, 'cells', 'mini', arm, 'cell.json'), 'utf8')) as CellRecord;
const report = (out: string): Report => {
  const r = spawnSync(process.execPath, [join(dist, 'bench', 'report.js'), '--run', out], { encoding: 'utf8', env: baseEnv() });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report;
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jev-bench-'));
  dist = join(tmp, 'dist');
  chmodSync(fake, 0o755);
  const r = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json'), '--outDir', dist], { encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  // A built plugin dir independent of the repo's own dist/, so the test does not depend on `npm run build` having run.
  pluginDir = join(tmp, 'plugin');
  cpSync(dist, join(pluginDir, 'dist'), { recursive: true });
  cpSync(join(root, 'hooks'), join(pluginDir, 'hooks'), { recursive: true });
}, 60_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('bench run (fake CLI)', () => {
  it('plans four arms per case with zero inference when --execute is absent', () => {
    const r = bench(['--seed', '7']);
    expect(r.status, r.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(join(r.out, 'plan.json'), 'utf8')) as { planned_cells: number; order: Array<{ case: string; arms: string[] }>; execute: boolean };
    expect(plan.planned_cells).toBe(4);
    expect(plan.execute).toBe(false);
    expect([...plan.order[0]!.arms].sort()).toEqual(['frontier_enriched', 'frontier_raw', 'sonnet_gated', 'sonnet_native']);
    expect(existsSync(join(r.out, 'cells'))).toBe(false);
    const again = bench(['--seed', '7']);
    expect((JSON.parse(readFileSync(join(again.out, 'plan.json'), 'utf8')) as typeof plan).order).toEqual(plan.order);
  });

  it('refuses to execute under API-key auth, missing TypeSafe key, or an insufficient session budget', () => {
    const apiKey = bench(['--execute', '--max-sessions', '4'], { ANTHROPIC_API_KEY: 'sk-x' });
    expect(apiKey.status).toBe(2);
    expect(apiKey.stderr).toMatch(/ANTHROPIC_API_KEY/);
    expect(existsSync(join(apiKey.out, 'cells'))).toBe(false);
    const notOauth = bench(['--execute', '--max-sessions', '4'], { FAKE_CLAUDE_AUTH: JSON.stringify({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' }) });
    expect(notOauth.status).toBe(2);
    expect(notOauth.stderr).toMatch(/not claude\.ai subscription OAuth/);
    const budget = bench(['--execute', '--max-sessions', '3']);
    expect(budget.status).toBe(2);
    expect(budget.stderr).toMatch(/below the 4 planned/);
    const noKey = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--cases', cases, '--out', join(tmp, 'nokey'), '--claude', fake, '--plugin-dir', pluginDir, '--execute', '--max-sessions', '4'], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: join(tmp, 'home') } });
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toMatch(/TYPESAFE_API_KEY/);
    const subagentEnv = bench(['--execute', '--max-sessions', '4'], { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
    expect(subagentEnv.status).toBe(2);
    expect(subagentEnv.stderr).toMatch(/CLAUDE_CODE_SUBAGENT_MODEL/);
  });

  it('executes the four arms with identical prompts, isolated plugin loading and whole-tree accounting', () => {
    const r = bench(['--execute', '--max-sessions', '4', '--seed', '3', '--timeout-ms', '60000', '--max-turns', '5']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const arms = ['frontier_raw', 'frontier_enriched', 'sonnet_native', 'sonnet_gated'] as const;
    const cells = Object.fromEntries(arms.map((a) => [a, readCell(r.out, a)])) as Record<(typeof arms)[number], CellRecord>;
    expect(new Set(arms.map((a) => cells[a].prompt_sha256)).size).toBe(1);
    for (const a of arms) {
      const c = cells[a];
      expect(c.started).toBe(true);
      expect(c.setup).toEqual([expect.objectContaining({ argv: ['node', '-e', 'process.exit(0)'], exit: 0 })]);
      expect(c.spawn!.argv.slice(1)).toEqual(expect.arrayContaining(['-p', '--model', c.root_model_requested, '--output-format', 'stream-json', '--max-turns', '5', '--setting-sources', 'project,local', '--no-session-persistence']));
      expect(c.elapsed_ms).toBeGreaterThan(0);
      expect(c.result?.model_usage).not.toBeNull();
      expect(c.root_model_consistent).toBe(true);
      expect(c.final_snapshot!.files).toBeGreaterThan(0);
      expect(existsSync(join(r.out, 'cells', 'mini', a, 'final', 'scratch', 'note.txt'))).toBe(true);
      expect(existsSync(join(r.out, 'cells', 'mini', a, 'stream.jsonl'))).toBe(true);
    }
    for (const a of ['frontier_raw', 'sonnet_native'] as const) {
      expect(cells[a].spawn!.argv).not.toContain('--plugin-dir');
      expect(cells[a].spawn!.env_added).toEqual([]);
      expect(cells[a].init!.plugins).toEqual([]);
      expect(cells[a].init!.jev_gate_loaded).toBe(false);
      expect(cells[a].gate.count).toBe(0);
      expect(cells[a].gate.jev_cost_usd).toBe(0);
    }
    for (const a of ['frontier_enriched', 'sonnet_gated'] as const) {
      expect(cells[a].spawn!.argv).toContain('--plugin-dir');
      expect(cells[a].spawn!.env_added).toEqual(['JEV_GATE_MODE', 'JEV_GATE_TRACE_DIR']);
      expect(cells[a].init!.jev_gate_loaded).toBe(true);
      expect(cells[a].gate.count).toBe(1);
      expect(cells[a].gate.jev_input_tokens).toBe(500);
      expect(cells[a].gate.jev_cost_usd).toBeCloseTo(500 * 0.042 / 1_000_000, 12);
    }
    expect(cells.frontier_enriched.mode).toBe('enrich');
    expect(cells.frontier_enriched.gate.match).toBe('n/a');
    expect(cells.frontier_enriched.agent_calls).toEqual([]);
    const gated = cells.sonnet_gated;
    expect(gated.mode).toBe('auto');
    expect(gated.agent_calls).toHaveLength(1);
    expect(gated.agent_calls[0]).toMatchObject({ subagent_type: 'jev-gate:opus', run_in_background: false, resolved_models: ['claude-opus-5'], result_is_error: false });
    expect(gated.gate).toMatchObject({ recommended_execution: 'delegate', recommended_agent: 'jev-gate:opus', actual_agents: ['jev-gate:opus'], match: 'match' });
    expect(Object.keys(gated.result!.model_usage!).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(gated.result!.total_cost_usd).toBeCloseTo(0.03, 10);
    expect(cells.frontier_raw.grade?.quality).toBe('pass');
    expect(cells.frontier_enriched.grade?.quality).toBe('pass');
    expect(cells.sonnet_native.grade?.quality).toBe('fail');
    expect(gated.grade?.quality).toBe('pass');

    const rep = report(r.out);
    expect(rep.complete_case_set).toEqual(['mini']);
    const byArm = Object.fromEntries(rep.arms.map((a) => [a.arm, a]));
    expect(byArm['frontier_raw']!.fable_tokens).toBe(1260);
    expect(byArm['sonnet_gated']!.fable_tokens).toBe(0);
    expect(byArm['sonnet_gated']!.total_tokens).toBe(1260 + 900);
    expect(byArm['sonnet_gated']!.total_cost_usd).toBeCloseTo(0.03 + 500 * 0.042 / 1_000_000, 10);
    expect(byArm['sonnet_native']!.pass).toBe(0);
    expect(byArm['sonnet_native']!.cost_per_pass_usd).toBeNull();
    expect(rep.deltas_vs_frontier_raw.fable_volume_change).toBe(1);
    expect(rep.deltas_vs_frontier_raw.total_cost_change).toBeCloseTo(1 - (0.03 + 500 * 0.042 / 1_000_000) / 0.01, 6);
    expect(typeof rep.deltas_vs_frontier_raw.elapsed_change).toBe('number');
    expect(existsSync(join(r.out, 'report.md'))).toBe(true);
    expect(readFileSync(join(r.out, 'report.md'), 'utf8')).toMatch(/\| sonnet_gated \| 1 \| 1 \| 1 \| 0 \| 0 \|/);
  }, 120_000);

  it('records a recommendation the main model ignored as a mismatch rather than hiding it', () => {
    const r = bench(['--execute', '--max-sessions', '4', '--seed', '5'], { FAKE_CLAUDE_IGNORE_HINT: '1' });
    expect(r.status, r.stderr).toBe(0);
    const gated = readCell(r.out, 'sonnet_gated');
    expect(gated.agent_calls).toEqual([]);
    expect(gated.gate.match).toBe('mismatch');
    expect(gated.grade?.quality).toBe('pass');
    expect(report(r.out).arms.find((a) => a.arm === 'sonnet_gated')?.mismatch).toBe(1);
  }, 120_000);

  it('--regrade re-scores saved snapshots without executing anything and keeps the previous verdict', () => {
    const r = bench(['--execute', '--max-sessions', '4', '--seed', '11']);
    expect(r.status, r.stderr).toBe(0);
    const before = readCell(r.out, 'sonnet_native');
    expect(before.grade?.quality).toBe('fail');
    const mtime = statSync(join(r.out, 'cells', 'mini', 'sonnet_native', 'stream.jsonl')).mtimeMs;

    const again = spawnSync(process.execPath, [join(dist, 'bench', 'run.js'), '--regrade', '--cases', cases, '--out', r.out, '--claude', fake, '--plugin-dir', pluginDir], { encoding: 'utf8', env: baseEnv(), timeout: 120_000 });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/regraded 4 cells/);
    const after = readCell(r.out, 'sonnet_native') as CellRecord & { previous_grades?: Array<{ grade: { quality: string } | null }> };
    expect(after.grade?.quality).toBe('fail');
    expect(after.previous_grades?.at(-1)?.grade?.quality).toBe('fail');
    // Nothing was re-run: the transcript from the original execution is untouched.
    expect(statSync(join(r.out, 'cells', 'mini', 'sonnet_native', 'stream.jsonl')).mtimeMs).toBe(mtime);
    expect(report(r.out).arms.find((a) => a.arm === 'sonnet_native')?.pass).toBe(0);
  }, 120_000);

  it('refuses --regrade together with --execute', () => {
    const r = bench(['--regrade', '--execute', '--max-sessions', '4']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--regrade/);
  });

  it('cleans up a hung session at the timeout, marks quality unknown and keeps the planned denominator', () => {
    const r = bench(['--execute', '--max-sessions', '4', '--timeout-ms', '1500'], { FAKE_CLAUDE_HANG: '1' });
    expect(r.status, r.stderr).toBe(0);
    const c = readCell(r.out, 'frontier_raw');
    expect(c.timed_out).toBe(true);
    expect(c.result).toBeNull();
    expect(c.grade?.quality).toBe('unknown');
    expect(c.grade?.reason).toMatch(/timed out/);
    const rep = report(r.out);
    expect(rep.arms.every((a) => a.planned === 1 && a.started === 1 && a.unknown === 1)).toBe(true);
    expect(rep.complete_case_set).toEqual([]);
    expect(rep.deltas_vs_frontier_raw).toEqual({ fable_volume_change: null, total_cost_change: null, elapsed_change: null });
    expect(rep.arms.every((a) => a.fable_tokens === null && a.total_cost_usd === null)).toBe(true);
  }, 120_000);
});
