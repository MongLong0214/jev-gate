import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OWNED_AGENT_PROFILES } from '../src/agents.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { modelFamilyOf, modelsAgree, parseFrontmatter } from '../src/cli.js';

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
      expect(fm.fields['disallowedTools']).toBeUndefined();
    });
  }

  it('lean executor also inherits all host tools', () => {
    const fm = parseFrontmatter(readFileSync(join(root, 'agents/executor.md'), 'utf8'));
    expect(fm.error).toBeNull();
    expect(fm.fields['model']).toBe('inherit');
    expect(fm.fields['tools']).toBeUndefined();
    expect(fm.fields['disallowedTools']).toBeUndefined();
  });

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
  }, 60_000);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  let caseNum = 0;
  /** A fresh plugin root sharing the one compiled dist, with its own copy of agents/ so a test can mutate one file. */
  const preparePluginRoot = (mutate?: { file: string; content: string }): string => {
    const pluginRoot = join(tmp, `case-${String(caseNum++)}`);
    mkdirSync(pluginRoot, { recursive: true });
    cpSync(sharedDist, join(pluginRoot, 'dist'), { recursive: true });
    for (const rel of ['.claude-plugin', 'hooks', 'agents', 'mods', 'src', 'plugins/evidence/skills']) cpSync(join(root, rel), join(pluginRoot, rel), { recursive: true });
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

  it('FAIL: a packaged agent reintroduces a restrictive tool list', () => {
    const original = readFileSync(join(root, 'agents', 'worker.md'), 'utf8');
    const pluginRoot = preparePluginRoot({ file: 'worker.md', content: original.replace('background: false', 'background: false\ntools: Read, Bash\ndisallowedTools: Agent') });
    const { status, stdout } = runDoctor(pluginRoot);
    expect(status).toBe(1);
    expect(stdout).toContain('tools must be absent so host tools are inherited');
    expect(stdout).toContain('disallowedTools must be absent so host tools are inherited');
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
