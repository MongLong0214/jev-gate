import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OWNED_AGENT_PROFILES } from '../src/agents.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { modelFamilyOf, modelsAgree } from '../src/cli.js';
import { frontmatterEdits, frontmatterModel, parseFrontmatter } from '../src/claude-models.js';

const root = join(__dirname, '..');

// #48 P0-2: the packet's explicit requirement -- the committed agents/*.md files must already match the table doctor
// and gen-agents.mjs both read (OWNED_AGENT_PROFILES + DEFAULT_CONFIG.models), so this is a live check on the
// checked-in files, not a fixture. If someone hand-edits an agent's frontmatter without running gen:agents, this fails.
describe('committed agents/*.md match OWNED_AGENT_PROFILES + DEFAULT_CONFIG.models (#48 P0-2)', () => {
  for (const profile of OWNED_AGENT_PROFILES) {
    it(`agents/${profile.file}`, () => {
      const text = readFileSync(join(root, 'agents', profile.file), 'utf8');
      const fm = parseFrontmatter(text);
      expect(fm.error).toBeNull();
      expect(fm.fields['model']).toBe(DEFAULT_CONFIG.models[profile.tier]);
      if (profile.effort === null) expect(fm.fields['effort']).toBeUndefined();
      else expect(fm.fields['effort']).toBe(profile.effort);
      expect(fm.fields['tools']).toBeUndefined();
      expect(fm.fields['disallowedTools']).toBe(profile.disallowedTools.join(', '));
      expect(fm.fields['omitClaudeMd']).toBe('true');
      expect(fm.fields['skills']).toBeUndefined();
    });
  }

  it('enables the frontier profile by default under the open policy', () => {
    expect(DEFAULT_CONFIG.models.frontier).toBe('claude-fable-5-1');
  });
});

describe('modelFamilyOf / modelsAgree (#48 P0-2)', () => {
  it('recognizes each family case-insensitively as a substring', () => {
    expect(modelFamilyOf('opus')).toBe('opus');
    expect(modelFamilyOf('claude-opus-4-6-20260301')).toBe('opus');
    expect(modelFamilyOf('CLAUDE-OPUS-4-6')).toBe('opus');
    expect(modelFamilyOf('fable')).toBe('fable');
    expect(modelFamilyOf('haiku')).toBe('haiku');
    expect(modelFamilyOf('sonnet')).toBe('sonnet');
  });

  it('returns null for a string naming no known family', () => {
    expect(modelFamilyOf('some-other-model')).toBeNull();
  });

  it('agrees by family when both sides name one, even with different exact strings', () => {
    expect(modelsAgree('opus', 'claude-opus-4-6-20260301')).toBe(true);
    expect(modelsAgree('claude-opus-4-6-20260301', 'opus')).toBe(true);
  });

  it('disagrees across different families', () => {
    expect(modelsAgree('opus', 'sonnet')).toBe(false);
    expect(modelsAgree('fable', 'opus')).toBe(false);
  });

  it('falls back to exact string comparison when either side names no known family', () => {
    expect(modelsAgree('some-other-model', 'some-other-model')).toBe(true);
    expect(modelsAgree('some-other-model', 'some-other-model-2')).toBe(false);
    expect(modelsAgree('some-other-model', 'opus')).toBe(false);
  });
});

describe('parseFrontmatter', () => {
  it('parses fields from a well-formed block', () => {
    const fm = parseFrontmatter('---\nname: x\nmodel: opus\n---\nbody\n');
    expect(fm.error).toBeNull();
    expect(fm.fields).toMatchObject({ name: 'x', model: 'opus' });
  });

  it('errors when the file does not start with a frontmatter block', () => {
    expect(parseFrontmatter('body only\n').error).toBe('no frontmatter on line 1');
  });

  it('errors when the frontmatter block is unterminated', () => {
    expect(parseFrontmatter('---\nname: x\nbody\n').error).toBe('unterminated frontmatter');
  });

  it('reads an agent file\'s model: absent or inherit inherits, a broken block is unknown', () => {
    expect(frontmatterModel('---\nname: x\nmodel: "sonnet"\n---\n')).toBe('sonnet');
    expect(frontmatterModel('---\nname: x\n---\n')).toBe('inherit');
    expect(frontmatterModel('---\nmodel: inherit\n---\n')).toBe('inherit');
    expect(frontmatterModel('no block')).toBeNull();
    // A host default subagent model is what a file with no `model:` runs; an explicit inherit stays the file's own.
    expect(frontmatterModel('---\nname: x\n---\n', 'haiku')).toBe('haiku');
    expect(frontmatterModel('---\nmodel: inherit\n---\n', 'haiku')).toBe('inherit');
  });

  it('reads whether an agent file\'s tools can edit', () => {
    expect(frontmatterEdits('---\nname: x\n---\n')).toBe(true);
    expect(frontmatterEdits('---\ntools: Read, Grep, Glob\n---\n')).toBe(false);
    expect(frontmatterEdits('---\ntools: [Read, "Edit(src/**)"]\n---\n')).toBe(true);
    expect(frontmatterEdits('---\ndisallowedTools: Edit, Write, NotebookEdit, MultiEdit, Bash\n---\n')).toBe(false);
    expect(frontmatterEdits('---\ndisallowedTools: Edit(docs/**), Write, NotebookEdit\n---\n')).toBe(true);
  });

  it('reads Bash as a tool that can edit: whole Bash edits, Bash by command pattern is unknown', () => {
    expect(frontmatterEdits('---\nmodel: opus\ntools: Read, Bash\n---\n')).toBe(true);
    expect(frontmatterEdits('---\ntools: Read, Grep, Glob, Bash\n---\n')).toBe(true);
    expect(frontmatterEdits('---\ndisallowedTools: Edit, Write, NotebookEdit, MultiEdit\n---\n')).toBe(true);
    expect(frontmatterEdits('---\ntools: Read, Bash(git status)\n---\n')).toBeNull();
  });

  it('reads a YAML block list of tools, indented or not', () => {
    expect(frontmatterEdits('---\ntools:\n  - Read\n  - Edit\nmodel: sonnet\n---\n')).toBe(true);
    expect(frontmatterEdits('---\ntools:\n- Read\n- "Edit"\n---\n')).toBe(true);
    expect(frontmatterEdits('---\ntools:\n  - Read\n  - Grep\n---\n')).toBe(false);
    expect(frontmatterEdits('---\ntools:\n  - Read\ndisallowedTools:\n  - Bash\n---\n')).toBe(false);
    expect(frontmatterEdits('---\ntools:\n---\n')).toBeNull();
    expect(parseFrontmatter('---\ntools:\n  - Read\nmodel: opus\n---\n')).toMatchObject({ fields: { tools: '', model: 'opus' }, lists: { tools: ['Read'] }, error: null });
  });

  it('keeps a block list across comment and blank lines, and reads an item past its trailing comment', () => {
    expect(frontmatterEdits('---\ntools:\n  - Read\n  # note\n  - Write\n---\n')).toBe(true);
    expect(frontmatterEdits('---\ntools:\n  - Read\n\n  - Write\n---\n')).toBe(true);
    expect(frontmatterEdits('---\ntools:\n  - Read\n  - "Write" # comment\n---\n')).toBe(true);
    expect(frontmatterEdits('---\ntools:\n  - Read\n  - Write # comment\n---\n')).toBe(true);
    expect(parseFrontmatter('---\ntools:\n  - Read # a\n  # b\n\n  - "Bash # c"\n  - \'Grep\' # d\nmodel: opus\n---\n'))
      .toMatchObject({ fields: { tools: '', model: 'opus' }, lists: { tools: ['Read', '"Bash # c"', "'Grep'"] }, error: null });
  });
});

// Exercise installed CLI behavior, including its exit status, against disposable complete plugin roots.
describe('doctor: checkModelAuthority (#48 P0-2)', () => {
  let tmp: string;
  let sharedDist: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jev-cli-doctor-'));
    sharedDist = join(tmp, 'shared-dist');
    const r = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json'), '--outDir', sharedDist], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const codex = spawnSync(process.execPath, [join(root, 'scripts/build-codex.mjs'), join(sharedDist, 'codex')], { encoding: 'utf8' });
    expect(codex.status, codex.stdout + codex.stderr).toBe(0);
  }, 60_000);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  let caseNum = 0;
  /** A fresh plugin root sharing the one compiled dist, with its own copy of agents/ so a test can mutate one file. */
  const preparePluginRoot = (mutate?: { file: string; content: string }): string => {
    const pluginRoot = join(tmp, `case-${String(caseNum++)}`);
    mkdirSync(pluginRoot, { recursive: true });
    cpSync(sharedDist, join(pluginRoot, 'dist'), { recursive: true });
    for (const rel of ['.claude-plugin', 'hooks', 'agents', 'mods', 'src']) cpSync(join(root, rel), join(pluginRoot, rel), { recursive: true });
    mkdirSync(join(pluginRoot, 'plugins/evidence/dist'), { recursive: true });
    writeFileSync(join(pluginRoot, 'plugins/evidence/dist/server.mjs'), '// Fake packaged entry; Doctor does not execute it.\n');
    if (mutate) writeFileSync(join(pluginRoot, 'agents', mutate.file), mutate.content);
    return pluginRoot;
  };

  const runDoctor = (pluginRoot: string, extraEnv: Record<string, string> = {}): { status: number | null; stdout: string } => {
    const home = mkdtempSync(join(tmpdir(), 'jev-cli-doctor-home-'));
    // PATH=/nonexistent (as tests/pack.test.ts also does): `claude` is not found, so checkClaude() warns cleanly
    // instead of running a real CLI, and no network or auth call happens.
    const r = spawnSync(process.execPath, [join(pluginRoot, 'dist', 'cli.js'), 'doctor', '--verbose'], { encoding: 'utf8', env: { PATH: '/nonexistent', HOME: home, ...extraEnv } });
    return { status: r.status, stdout: r.stdout };
  };

  it.each(['claude', 'codex'])('C3: %s doctor CLI never prints cookie-bearing legacy rejection or failure prose', host => {
    const pluginRoot = preparePluginRoot(), trace = join(tmp, `legacy-${host}`), home = join(tmp, `legacy-home-${host}`);
    mkdirSync(trace); mkdirSync(home);
    const canary = 'sessionid=canary123', reason = `check curl --cookie ${canary}: result malformed`;
    const records = [{ phase: 'post', subagent_type: 'jev-gate:worker', verdict: 'invalid', verdict_reason: reason },
      { phase: 'background_terminal', status: 'failed', verdict_reason: reason },
      { phase: 'failure', error_first_line: reason, failure_category: reason, verdict_reason: reason }];
    records.forEach((r, i) => writeFileSync(join(trace, `legacy-${i}.json`), JSON.stringify({ host, session_id: 'legacy', written_at: new Date().toISOString(), ...r })));
    const entry = host === 'codex' ? join(pluginRoot, 'dist/codex/cli.mjs') : join(pluginRoot, 'dist/cli.js');
    const result = spawnSync(process.execPath, [entry, 'doctor', '--verbose'], { encoding: 'utf8',
      env: { PATH: '/nonexistent', HOME: home, JEV_GATE_TRACE_DIR: trace, JEV_CODEX_TRACE_DIR: trace } });
    // No host CLI or installed package is supplied; the activity output still runs, without authentication or inference.
    expect(result.status).toBe(1);
    expect(result.stdout, result.stderr).toContain('invalid_reply'); expect(result.stdout).toContain('worker_result_unknown');
    expect(result.stdout + result.stderr).not.toContain(canary);
  });

  it('prints every Gate cleanup reason from activity fixtures', () => {
    const pluginRoot = preparePluginRoot(), trace = join(tmp, 'cleanup-reasons'); mkdirSync(trace);
    const gateA = ['admission_needs_context', 'admission_context_unclear', 'admission_context_low_confidence'];
    const worker = ['worker_check_failed', 'worker_check_not_run', 'worker_check_duplicate', 'worker_checks_missing', 'worker_checks_unverified', 'worker_no_result', 'worker_failed', 'worker_cancelled'];
    const records = [
      ...gateA.map(reason => ({ phase: 'admission_result', decision: { shape: 'direct', reason } })),
      { phase: 'pre_result', role: 'worker', decision: { tier: 'standard', reason: 'route_not_fast' } },
      ...worker.map(verdict_reason => ({ phase: 'post', subagent_type: 'jev-gate:worker', verdict: 'incomplete', verdict_reason })),
      { phase: 'background_terminal', status: 'cancelled', verdict_reason: 'worker_cancelled' },
    ];
    records.forEach((r, i) => writeFileSync(join(trace, `reason-${i}.json`), JSON.stringify({ session_id: 's', written_at: new Date().toISOString(), ...r })));
    const { stdout } = runDoctor(pluginRoot, { JEV_GATE_TRACE_DIR: trace });
    for (const reason of [...gateA, 'route_not_fast', ...worker]) expect(stdout).toContain(reason);
    expect(stdout).toContain('cancelled 1');
  });

  it('OK: unmodified plugin, default config -- no model-authority disagreement for any owned agent', () => {
    const pluginRoot = preparePluginRoot();
    const { stdout } = runDoctor(pluginRoot);
    expect(stdout).not.toMatch(/a gated dispatch of .* runs .* \(config models\./);
  });

  it('FAIL: packaging drift -- installed frontmatter model differs from the table (existing check, now derived)', () => {
    const original = readFileSync(join(root, 'agents', 'worker-frontier.md'), 'utf8');
    const mutated = original.replace(/^model:.*$/m, 'model: haiku');
    expect(mutated).not.toBe(original);
    const pluginRoot = preparePluginRoot({ file: 'worker-frontier.md', content: mutated });
    const { status, stdout } = runDoctor(pluginRoot);
    expect(status).toBe(1);
    expect(stdout).toMatch(/\[fail\] agents\/worker-frontier\.md:.*model=haiku \(expected claude-fable-5-1\)/);
  });

  it('FAIL: a packaged agent reintroduces a restrictive tool list, or drifts from its withheld tools', () => {
    const original = readFileSync(join(root, 'agents', 'worker.md'), 'utf8');
    const mutated = original.replace(/^disallowedTools:.*$/m, 'tools: Read, Bash\ndisallowedTools: Agent').replace('omitClaudeMd: true\n', '');
    expect(mutated).not.toBe(original);
    const { status, stdout } = runDoctor(preparePluginRoot({ file: 'worker.md', content: mutated }));
    expect(status).toBe(1);
    expect(stdout).toContain('tools must be absent so host tools are inherited');
    expect(stdout).toContain('disallowedTools=Agent (expected Agent, SendMessage, Skill, Artifact, ArtifactComments, ArtifactData)');
    expect(stdout).toContain('omitClaudeMd must be true');
  });

  it('FAIL: effective config models.frontier disagrees by family with installed frontmatter', () => {
    const pluginRoot = preparePluginRoot();
    const home = mkdtempSync(join(tmpdir(), 'jev-cli-doctor-home-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ version: 5, mode: 'native', models: { frontier: 'sonnet' } }));
    const { status, stdout } = runDoctor(pluginRoot, { JEV_GATE_CONFIG: configPath, HOME: home });
    expect(status).toBe(1);
    expect(stdout).toContain('a gated dispatch of jev-gate:worker-frontier runs sonnet (config models.frontier), a direct or ungated one runs claude-fable-5-1 (frontmatter)');
  });

  it('OK: effective config models.frontier equals installed frontmatter exactly', () => {
    const pluginRoot = preparePluginRoot();
    const home = mkdtempSync(join(tmpdir(), 'jev-cli-doctor-home-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ version: 5, mode: 'native', models: { frontier: 'claude-fable-5-1' } }));
    const { stdout } = runDoctor(pluginRoot, { JEV_GATE_CONFIG: configPath, HOME: home });
    expect(stdout).not.toMatch(/a gated dispatch of jev-gate:worker-frontier runs/);
  });

  it('OK: config names an alias of the same family as frontmatter, not the identical string', () => {
    const pluginRoot = preparePluginRoot();
    const home = mkdtempSync(join(tmpdir(), 'jev-cli-doctor-home-'));
    const configPath = join(home, 'config.json');
    // Frontmatter says the bare family name "opus"; config names a concrete dated alias of the same family.
    writeFileSync(configPath, JSON.stringify({ version: 5, mode: 'native', models: { frontier: 'fable' } }));
    const { stdout } = runDoctor(pluginRoot, { JEV_GATE_CONFIG: configPath, HOME: home });
    expect(stdout).not.toMatch(/a gated dispatch of jev-gate:worker-frontier runs/);
  });

  /**
   * gen-agents.mjs resolves its own root from its file location, not cwd, and reads that root's dist/agents.js and
   * dist/config.js. #53 review: it runs from a copy inside a prepared plugin root, against the throwaway build above,
   * so the test neither needs this checkout's own `npm run build` (CI runs the tests first) nor rewrites its agents/.
   */
  describe('scripts/gen-agents.mjs --check (#48 P0-2)', () => {
    const genAgents = (pluginRoot: string, args: string[] = []) => {
      mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
      cpSync(join(root, 'scripts', 'gen-agents.mjs'), join(pluginRoot, 'scripts', 'gen-agents.mjs'));
      return spawnSync(process.execPath, [join(pluginRoot, 'scripts', 'gen-agents.mjs'), ...args], { encoding: 'utf8' });
    };

    it('reports no drift on the repository as checked in', () => {
      const r = genAgents(preparePluginRoot(), ['--check']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).not.toContain('drifts from the table');
    });

    it('detects a hand-edited model line, exits 1, and leaves the file untouched; without --check it writes the fix back', () => {
      const original = readFileSync(join(root, 'agents', 'worker-frontier.md'), 'utf8');
      const pluginRoot = preparePluginRoot({ file: 'worker-frontier.md', content: original.replace(/^model:.*$/m, 'model: haiku') });
      const path = join(pluginRoot, 'agents', 'worker-frontier.md');
      const check = genAgents(pluginRoot, ['--check']);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('worker-frontier.md drifts from the table (model: claude-fable-5-1, effort: xhigh)');
      expect(readFileSync(path, 'utf8')).not.toBe(original); // --check must not write

      const write = genAgents(pluginRoot);
      expect(write.status).toBe(0);
      expect(write.stdout).toContain('wrote worker-frontier.md');
      expect(readFileSync(path, 'utf8')).toBe(original); // byte-for-byte restored: only the model line moved
    });
  });
});
