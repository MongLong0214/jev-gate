import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LIVENESS_WINDOW, appendLiveness } from '../src/liveness.js';

/**
 * #48 P0-1/P2: doctor's own resolution of the effective depth floor and the liveness ring, exercised as a real
 * process against the compiled CLI -- the same way tests/hook.test.ts's "dist/hook.js (process)" block treats
 * hook.ts, and for the same reason: `checkConfig`/`checkLiveness` are not exported, so the only way to see their
 * FAIL/WARN output is to run `doctor` itself.
 */
let out: string;
const tmp = mkdtempSync(join(tmpdir(), 'jev-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeAll(() => {
  // A plugin-shaped root, so doctor's own file checks pass and its exit status reflects only what a test sets up.
  const root = mkdtempSync(join(tmp, 'plugin-'));
  out = join(root, 'dist');
  const r = spawnSync(process.execPath, [join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(__dirname, '..', 'tsconfig.json'), '--outDir', out], { encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  for (const d of ['.claude-plugin', 'hooks', 'agents']) cpSync(join(__dirname, '..', d), join(root, d), { recursive: true });
}, 60_000);

let seq = 0;
const doctorRun = (env: Record<string, string | undefined>, cwd: string = mktemp()): { status: number | null; stdout: string } => {
  const r = spawnSync(process.execPath, [join(out, 'cli.js'), 'doctor'], {
    cwd,
    encoding: 'utf8',
    // PATH: /nonexistent keeps checkClaude from finding a real `claude` binary on this machine.
    env: { PATH: '/nonexistent', HOME: mktemp(), ...env },
  });
  return { status: r.status, stdout: r.stdout };
};
const doctor = (env: Record<string, string | undefined>): string => doctorRun(env).stdout;
// spawnSync's cwd/HOME must actually exist on disk (unlike liveness.ts's own state dir, which mkdirs itself).
const mktemp = (): string => {
  const p = join(tmp, `d${(seq += 1)}`);
  mkdirSync(p, { recursive: true });
  return p;
};
const configFile = (body: unknown): string => {
  const p = join(tmp, `config-${(seq += 1)}.json`);
  writeFileSync(p, JSON.stringify(body));
  return p;
};

describe('doctor: effective depth floor (#48 P0-1)', () => {
  it('prints the cost model floor for the shipped atomic gate, whatever the window', () => {
    const stdout = doctor({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' });
    expect(stdout).toMatch(/\[info\].*effective depth floor: 48980 \(cost_model\).*could repay the coordinator/);
    expect(stdout).toMatch(/prices the request in code -- delegate when \(turns - 11\) x depth - turns x 40000 > 0/);
  });

  // The window rule below is the composite gate's; the atomic gate's floor comes from its cost model.
  const composite = (): string => configFile({ version: 5, mode: 'auto', admissionQuestionShape: 'composite' });

  it('warns when the host window is unknown and the floor falls back to the legacy absolute default', () => {
    const stdout = doctor({ JEV_GATE_CONFIG: composite() });
    expect(stdout).toMatch(/host compaction window: unknown/);
    expect(stdout).toMatch(/\[warn\] no autoCompactWindow is configured/);
    // The runtime default by model is spelled out, and so is the fallback a 200K session would never reach.
    expect(stdout).toMatch(/1M for Opus 4\.7\+, Sonnet 5 and Fable on the Anthropic API \(floor 300000\), 200K for other models or with CLAUDE_CODE_DISABLE_1M_CONTEXT \(floor 120000\)/);
    expect(stdout).toMatch(/the floor is the fixed 300000 \(fallback_absolute\), which a 200K session never reaches/);
    expect(stdout).toMatch(/--autocompact or --settings flag, MDM policy and server-managed settings are not visible to a hook/);
  });

  it('caps the window at 200K under CLAUDE_CODE_DISABLE_1M_CONTEXT, so a configured 1M no longer passes as healthy', () => {
    const stdout = doctor({ JEV_GATE_CONFIG: composite(), CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' });
    expect(stdout).toMatch(/host compaction window: 200000 tokens \(env capped by CLAUDE_CODE_DISABLE_1M_CONTEXT\)/);
    expect(stdout).toMatch(/effective depth floor: 120000 \(window_fraction\)/);
  });

  it('reports an info line, not a warning, for a floor comfortably under a known window', () => {
    const stdout = doctor({ JEV_GATE_CONFIG: composite(), CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' });
    expect(stdout).toMatch(/host compaction window: 300000 tokens \(env\)/);
    // DEFAULT_CONFIG.delegationDepthFloor is null, so this is window_fraction: min(300000, floor(0.6*300000))=180000.
    expect(stdout).toMatch(/\[info\].*effective depth floor: 180000 \(window_fraction\)/);
    expect(stdout).not.toMatch(/effective depth floor.*\[warn\]/);
  });

  it('fails when an explicit config floor is at or above the host window -- the #48 failure mode itself', () => {
    const cfg = configFile({ version: 5, mode: 'auto', delegationDepthFloor: 300000 });
    const stdout = doctor({ JEV_GATE_CONFIG: cfg, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' });
    expect(stdout).toMatch(/\[fail\].*effective depth floor 300000 \(config\) is at or above the host's own compaction window 300000/);
  });

  it('warns when an explicit config floor is within 15% of the host window, without failing', () => {
    const cfg = configFile({ version: 5, mode: 'auto', delegationDepthFloor: 260000 });
    const stdout = doctor({ JEV_GATE_CONFIG: cfg, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' });
    expect(stdout).toMatch(/\[warn\].*effective depth floor 260000 \(config\) is within 15% of the host's compaction window 300000/);
    // This fixture has no plugin.json/hooks/agents, so unrelated [fail] lines for those are expected here -- only the
    // floor line itself must not have escalated to fail.
    expect(stdout).not.toMatch(/\[fail\].*effective depth floor/);
  });

  it('keeps the floor=0 warning for an explicit zero, independent of the window', () => {
    const cfg = configFile({ version: 5, mode: 'auto', delegationDepthFloor: 0 });
    const stdout = doctor({ JEV_GATE_CONFIG: cfg, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' });
    expect(stdout).toMatch(/\[warn\] effective depth floor is 0: Gate A is asked on every prompt/);
  });

  it('prints delegationDepthFraction alongside the raw config summary', () => {
    const stdout = doctor({});
    expect(stdout).toMatch(/delegationDepthFloor=null \(derived\) delegationDepthFraction=0\.6/);
    expect(stdout).toMatch(/admittedShape=auto delegationCoordinatorTurns=11 delegationWorkerTokensPerCall=40000 guardAllowMcp=true verifyWorkerChecks=true/);
  });
});

describe('doctor: liveness (#48 P2)', () => {
  it('reports no record yet on a fresh install', () => {
    const stateDir = mktemp();
    const stdout = doctor({ JEV_GATE_STATE_DIR: stateDir });
    expect(stdout).toMatch(/\[info\] liveness: no record yet at .*liveness\.json/);
  });

  it('reports counts without warning below a full window', () => {
    const stateDir = mktemp();
    for (let i = 0; i < LIVENESS_WINDOW - 1; i++) appendLiveness({ JEV_GATE_STATE_DIR: stateDir }, { at: `t${i}`, attempted: false, reason: 'depth_below_floor' });
    const stdout = doctor({ JEV_GATE_STATE_DIR: stateDir });
    expect(stdout).toMatch(new RegExp(`\\[info\\] liveness: ${LIVENESS_WINDOW - 1}/${LIVENESS_WINDOW} recent auto-mode decisions recorded, 0 attempted`));
    expect(stdout).not.toMatch(/liveness:.*\[warn\]/);
  });

  it('warns when a full window never attempted a call, matching SessionStart', () => {
    const stateDir = mktemp();
    for (let i = 0; i < LIVENESS_WINDOW; i++) appendLiveness({ JEV_GATE_STATE_DIR: stateDir }, { at: `t${i}`, attempted: false, reason: 'depth_below_floor' });
    const stdout = doctor({ JEV_GATE_STATE_DIR: stateDir });
    expect(stdout).toMatch(/\[warn\] liveness: the last 50 auto-mode admission decisions never attempted a Gate A call/);
  });

  it('does not warn when at least one of a full window attempted a call', () => {
    const stateDir = mktemp();
    for (let i = 0; i < LIVENESS_WINDOW - 1; i++) appendLiveness({ JEV_GATE_STATE_DIR: stateDir }, { at: `t${i}`, attempted: false, reason: 'depth_below_floor' });
    appendLiveness({ JEV_GATE_STATE_DIR: stateDir }, { at: 'last', attempted: true, reason: null });
    const stdout = doctor({ JEV_GATE_STATE_DIR: stateDir });
    expect(stdout).toMatch(new RegExp(`liveness: ${LIVENESS_WINDOW}/${LIVENESS_WINDOW} recent auto-mode decisions recorded, 1 attempted`));
    expect(stdout).not.toMatch(/liveness:.*never attempted/);
  });
});

describe('doctor: mode=off idle-cost warning (#48 P2 Task 4.4)', () => {
  it('warns that mode=off still starts a process per hook event and names the disable command', () => {
    const cfg = configFile({ version: 5, mode: 'off' });
    const stdout = doctor({ JEV_GATE_CONFIG: cfg });
    expect(stdout).toMatch(/\[warn\] mode=off still starts a node process for every matched hook event.*claude plugin disable jev-gate@<marketplace>/);
  });

  it('does not print the mode=off idle-cost warning in auto mode', () => {
    // DEFAULT_CONFIG.mode is 'off', so this needs an explicit override to actually exercise the auto path.
    const cfg = configFile({ version: 5, mode: 'auto' });
    const stdout = doctor({ JEV_GATE_CONFIG: cfg });
    expect(stdout).not.toMatch(/still starts a node process for every matched hook event/);
  });
});

describe('doctor: mentions SessionStart as a sixth registered event', () => {
  it('names all six events in the closing /hooks line', () => {
    const stdout = doctor({});
    expect(stdout).toMatch(/\/hooks should list six jev-gate entries \(UserPromptSubmit, PreToolUse with no matcher, PostToolUse on \^Agent\$, PostToolUseFailure on \^Agent\$, Stop, SessionStart\)/);
  });
});

describe('doctor: worker isolation base (#48 P1-2 review)', () => {
  const isolated = (): string => configFile({ version: 5, mode: 'auto', maxParallelWorkers: 2, workerIsolation: 'worktree', guardAllowTools: ['Bash'] });
  const configDir = (settings: unknown): string => {
    const dir = mktemp();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
    return dir;
  };

  it('warns that worktree isolation is not in effect when the host base ref is unset', () => {
    const stdout = doctor({ JEV_GATE_CONFIG: isolated(), CLAUDE_CONFIG_DIR: mktemp() });
    expect(stdout).toMatch(/\[warn\] workerIsolation=worktree is not in effect: host worktree\.baseRef is unset/);
  });

  it('warns and names the file when the host base ref is "fresh"', () => {
    const dir = configDir({ worktree: { baseRef: 'fresh' } });
    const stdout = doctor({ JEV_GATE_CONFIG: isolated(), CLAUDE_CONFIG_DIR: dir });
    expect(stdout).toContain(`host worktree.baseRef is "fresh" (settings:${join(dir, 'settings.json')})`);
  });

  it('reports isolation as configured when the host base ref is "head"', () => {
    const stdout = doctor({ JEV_GATE_CONFIG: isolated(), CLAUDE_CONFIG_DIR: configDir({ worktree: { baseRef: 'head' } }) });
    expect(stdout).toMatch(/\[info\] workerIsolation=worktree with worktree\.baseRef="head"/);
    expect(stdout).not.toMatch(/is not in effect/);
  });
});

describe('doctor: a launch profile that lets an admitted job reach a worker (#48)', () => {
  const failLine = (out: string): string | undefined => out.split('\n').find((l) => l.startsWith('[fail] mode='));
  const withSettingsEnv = (env: Record<string, string>): string => {
    const home = mktemp();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env }));
    return home;
  };

  // A [fail] line must also fail the process, and a clean profile must not: a script reads the status, not the text.
  const expectFail = (r: { status: number | null; stdout: string }): string | undefined => {
    expect(r.status).toBe(1);
    return failLine(r.stdout);
  };
  const expectPass = (r: { status: number | null; stdout: string }): void => {
    expect(failLine(r.stdout)).toBeUndefined();
    expect(r.status).toBe(0);
  };
  const projectWith = (file: 'settings.json' | 'settings.local.json', env: Record<string, string>): string => {
    const dir = mktemp();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', file), JSON.stringify({ env }));
    return dir;
  };

  it('fails in auto mode when Agent calls could only run in the background, and says the hook sends nothing', () => {
    const line = expectFail(doctorRun({ JEV_GATE_CONFIG: configFile({ version: 5, mode: 'auto' }) }));
    expect(line).toContain('mode=auto but Agent calls can only run in the background (fork=unset, disable_background=unset');
    expect(line).toContain('host_unsupported and sends no Jev request');
  });

  it('fails in lean mode for the same reason', () => {
    expect(expectFail(doctorRun({ JEV_GATE_CONFIG: configFile({ version: 5, mode: 'lean' }) }))).toContain('mode=lean but');
  });

  it.each([
    ['the full profile', { CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }],
    ['forced foreground alone', { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }],
    ['fork mode off alone', { CLAUDE_CODE_FORK_SUBAGENT: '0' }],
  ])('does not fail with %s in this shell', (_label, launch) => {
    expectPass(doctorRun({ JEV_GATE_CONFIG: configFile({ version: 5, mode: 'auto' }), ...launch }));
  });

  it.each(['settings.json', 'settings.local.json'] as const)('reads the profile from the project %s env, as a session started there would', (file) => {
    const cwd = projectWith(file, { CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
    expectPass(doctorRun({ JEV_GATE_CONFIG: configFile({ version: 5, mode: 'auto' }) }, cwd));
  });

  it('lets project-local settings win over project settings', () => {
    const cwd = projectWith('settings.json', { CLAUDE_CODE_FORK_SUBAGENT: '0' });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_CODE_FORK_SUBAGENT: '1' } }));
    expect(expectFail(doctorRun({ JEV_GATE_CONFIG: configFile({ version: 5, mode: 'auto' }) }, cwd))).toContain('fork=1');
  });

  it('fails in auto mode under a subagent model override, which every owned Agent call refuses', () => {
    const r = doctorRun({ JEV_GATE_CONFIG: configFile({ version: 5, mode: 'auto' }), CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_SUBAGENT_MODEL: 'opus' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[fail\] CLAUDE_CODE_SUBAGENT_MODEL is a concrete override; mode=auto stays native on every prompt as host_unsupported/);
    const off = doctorRun({ JEV_GATE_CONFIG: configFile({ version: 5, mode: 'off' }), CLAUDE_CODE_SUBAGENT_MODEL: 'opus' });
    expect(off.stdout).toMatch(/\[warn\] CLAUDE_CODE_SUBAGENT_MODEL is a concrete override; eligible calls are preserved/);
  });

  it('reads the profile from the user settings env too, and lets it win over the shell', () => {
    const cfg = configFile({ version: 5, mode: 'auto' });
    const profile = withSettingsEnv({ CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
    expectPass(doctorRun({ JEV_GATE_CONFIG: cfg, HOME: profile }));
    const forking = withSettingsEnv({ CLAUDE_CODE_FORK_SUBAGENT: '1' });
    expect(expectFail(doctorRun({ JEV_GATE_CONFIG: cfg, HOME: forking, CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }))).toContain('fork=1');
  });

  it('reads the settings file under CLAUDE_CONFIG_DIR when that is set', () => {
    const dir = join(withSettingsEnv({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }), '.claude');
    expectPass(doctorRun({ JEV_GATE_CONFIG: configFile({ version: 5, mode: 'auto' }), CLAUDE_CONFIG_DIR: dir }));
  });

  it('does not fail when the gate is off or native, and keeps the informational line', () => {
    for (const mode of ['off', 'native']) {
      const r = doctorRun({ JEV_GATE_CONFIG: configFile({ version: 5, mode }) });
      expectPass(r);
      expect(r.stdout, mode).toContain('[info] launch profile not set');
    }
  });
});
