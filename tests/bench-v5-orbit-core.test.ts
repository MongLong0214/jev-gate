import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { gradeDir } from '../src/bench/checker.js';
import { isInside, isSafeId, isSensitiveName } from '../src/bench/paths.js';

const root = join(__dirname, '..');
const benchDir = join(root, 'bench', 'v5');
const tmp = mkdtempSync(join(tmpdir(), 'jev-bench-v5-orbit-core-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const opts = { timeoutMs: 60_000, checkerId: 'test' };

// The fragment is parsed here rather than through loadManifest: loadManifest still accepts version 3|4 only, and merging
// the V5 fragments into a manifest it accepts is another ticket's change. The shape checked below is the one it enforces.
interface Fragment {
  version: number;
  cases: Array<{ id: string; group: string; fixtureDir: string; request: string; setup: unknown; evaluationSetup: unknown; checkFile: string }>;
}
const fragment = JSON.parse(readFileSync(join(benchDir, 'cases.orbit-core.json'), 'utf8')) as Fragment;
const orbit = fragment.cases[0]!;
const fixtureDir = resolve(benchDir, orbit.fixtureDir);
const checkFile = resolve(benchDir, orbit.checkFile);
const referenceDir = join(benchDir, 'reference', 'orbit-core');

const EXPECTED_CHECKS = [
  'modules_load',
  'clock_steps_and_accumulator',
  'clock_pause_and_time_scale',
  'physics_energy_drift_bounded',
  'physics_reversible',
  'collisions_conserve_mass_and_momentum',
  'collisions_transitive_and_order_independent',
  'snapshot_round_trip_exact',
  'snapshot_rejects_unknown_fields',
  'camera_transforms_invertible',
  'camera_zoom_at_keeps_anchor',
  'camera_pan_shifts_view',
  'hud_formats_exact_strings',
  'simulation_replay_bit_identical',
  'simulation_restore_continues_run',
  'test_suite_passes',
];

/** Fixture + reference overlay: the same two copies the runner makes, so a variant mutates a solved candidate. */
const solved = (name: string): string => {
  const dir = join(tmp, name);
  cpSync(fixtureDir, dir, { recursive: true });
  cpSync(referenceDir, dir, { recursive: true });
  return dir;
};

const mutate = (dir: string, rel: string, from: string, to: string): void => {
  const path = join(dir, rel);
  const before = readFileSync(path, 'utf8');
  expect(before, `${rel} no longer contains the text this variant mutates`).toContain(from);
  writeFileSync(path, before.replace(from, to));
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

describe('bench/v5 orbit-core manifest fragment', () => {
  it('parses as a version 5 fragment with one case and safe, contained paths', () => {
    expect(fragment.version).toBe(5);
    expect(fragment.cases).toHaveLength(1);
    expect(orbit.id).toBe('orbit-core');
    expect(isSafeId(orbit.id)).toBe(true);
    expect(orbit.group.length).toBeGreaterThan(0);
    expect(orbit.request.length).toBeGreaterThan(0);
    expect(orbit.setup).toEqual([]);
    expect(orbit.evaluationSetup).toEqual([]);
    expect(isInside(benchDir, fixtureDir)).toBe(true);
    expect(isInside(benchDir, checkFile)).toBe(true);
    expect(existsSync(fixtureDir)).toBe(true);
    expect(existsSync(checkFile)).toBe(true);
  });

  it('states the behaviour without naming how the work should be staffed', () => {
    for (const word of ['모델', '티어', '에이전트', '위임', '체커', 'model', 'tier', 'agent', 'delegat', 'checker']) {
      expect(orbit.request.toLowerCase(), `request text mentions ${word}`).not.toContain(word.toLowerCase());
    }
    // The behaviours a candidate cannot guess: every one of them is spelled out in the request.
    for (const stated of ['maxStepsPerAdvance', 'advance(200)', 'Verlet', 'SnapshotError', 'T+00:01:23.456 x2.0 PAUSED bodies=12 E=-1.234e+5', '1e-4', '1e-6', 'm1=1e12']) {
      expect(orbit.request, `request text does not state ${stated}`).toContain(stated);
    }
  });

  it('ships a fixture with no secrets and no symlinks', () => {
    for (const file of walk(fixtureDir)) {
      expect(lstatSync(file).isSymbolicLink(), file).toBe(false);
      expect(isSensitiveName(file.slice(fixtureDir.length + 1)), file).toBe(false);
    }
  });

  it('--describe lists exactly the checks the checker reports', () => {
    const r = spawnSync(process.execPath, [checkFile, '--describe'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const described = (JSON.parse(r.stdout) as { checks: string[] }).checks;
    expect(described).toEqual(EXPECTED_CHECKS);
    expect(new Set(described).size).toBe(described.length);
  });
});

describe('bench/v5 orbit-core checker', () => {
  it('passes the reference and fails the broken fixture', () => {
    const reference = gradeDir(checkFile, solved('reference'), opts);
    expect(reference.quality, JSON.stringify(reference)).toBe('pass');
    expect(reference.environmentError).toBeNull();
    expect(reference.checks.map((c) => c.id).sort()).toEqual([...reference.required].sort());
    expect(reference.checks.every((c) => c.pass === true)).toBe(true);
    // Every check has to finish inside the run budget the harness gives a checker.
    expect(reference.run?.ms ?? Number.POSITIVE_INFINITY).toBeLessThan(60_000);

    const broken = join(tmp, 'fixture');
    cpSync(fixtureDir, broken, { recursive: true });
    const before = gradeDir(checkFile, broken, opts);
    expect(before.quality, JSON.stringify(before)).toBe('fail');
    expect(before.environmentError).toBeNull();
    for (const id of ['clock_pause_and_time_scale', 'physics_energy_drift_bounded', 'camera_transforms_invertible', 'hud_formats_exact_strings', 'test_suite_passes']) {
      expect(before.checks.find((c) => c.id === id)?.pass, id).toBe(false);
    }
    // Modules the fixture does not ship at all stay unevaluated instead of being scored as wrong behaviour.
    expect(before.checks.filter((c) => c.pass === null).map((c) => c.id)).toContain('snapshot_round_trip_exact');
  }, 120_000);

  // Each variant breaks exactly one behaviour of a working solution; the named check has to be the one that catches it.
  const variants: Array<[string, (dir: string) => void, string, string[]]> = [
    [
      'a first-order Euler step in place of velocity-Verlet',
      (dir) => cpSync(join(fixtureDir, 'src', 'physics.js'), join(dir, 'src', 'physics.js')),
      'physics_energy_drift_bounded',
      ['clock_pause_and_time_scale', 'collisions_conserve_mass_and_momentum', 'camera_transforms_invertible', 'hud_formats_exact_strings'],
    ],
    [
      'a clock that keeps stepping while paused',
      (dir) => mutate(dir, 'src/clock.js', 'if (s.paused) return 0;', 'if (false) return 0;'),
      'clock_pause_and_time_scale',
      ['clock_steps_and_accumulator', 'physics_energy_drift_bounded', 'collisions_conserve_mass_and_momentum', 'hud_formats_exact_strings'],
    ],
    [
      'a merge that loses momentum',
      (dir) => mutate(dir, 'src/collisions.js', 'vx: px / mass, vy: py / mass', 'vx: px / (mass * 2), vy: py / (mass * 2)'),
      'collisions_conserve_mass_and_momentum',
      ['clock_pause_and_time_scale', 'physics_energy_drift_bounded', 'camera_transforms_invertible', 'hud_formats_exact_strings'],
    ],
    [
      'a HUD line with the wrong energy precision',
      (dir) => mutate(dir, 'src/hud.js', 'energy.toExponential(3)', 'energy.toExponential(2)'),
      'hud_formats_exact_strings',
      ['clock_pause_and_time_scale', 'physics_energy_drift_bounded', 'collisions_conserve_mass_and_momentum', 'camera_transforms_invertible'],
    ],
  ];

  it.each(variants)('%s fails %#', (name, apply, failing, untouched) => {
    const dir = solved(`variant-${failing}`);
    apply(dir);
    const g = gradeDir(checkFile, dir, opts);
    expect(g.quality, `${name}: ${JSON.stringify(g)}`).toBe('fail');
    expect(g.environmentError).toBeNull();
    expect(g.checks.find((c) => c.id === failing)?.pass, `${name} was not caught by ${failing}`).toBe(false);
    for (const id of untouched) expect(g.checks.find((c) => c.id === id)?.pass, `${name} also broke ${id}`).toBe(true);
  }, 120_000);
});
