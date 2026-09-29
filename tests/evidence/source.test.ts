import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createEvidenceService } from '../../src/evidence/service.js';
import { loadConfig } from '../../src/evidence/source.js';
import { config, configFile, git, live, repo, tmp, write } from './repo.js';

const SYMBOL = 'parseWidget';
const body = `export const ${SYMBOL} = () => 1;\n`;

/** Every kind of path the inventory must list, skip or refuse, each holding the same symbol. */
const fixture = (): string => {
  const outside = mkdtempSync(join(tmp, 'outside-'));
  writeFileSync(join(outside, 'secret.ts'), body);
  const root = repo({
    '.gitignore': 'src/ignored.ts\n',
    'src/app.ts': body,
    'src/untracked.ts': body,
    'src/ignored.ts': body,
    'src/with space.ts': body,
    'src/new\nline.ts': body,
    'src/-dash.ts': body,
    'src-old/app.ts': body,
    'src/.env': body,
    'src/.env.local': body,
    'src/id_rsa': body,
    'src/deploy.pem': body,
    'node_modules/pkg/index.js': body,
    'dist/app.js': body,
    'src/bin.dat': Buffer.concat([Buffer.from(body), Buffer.from([0, 1, 2])]),
    'src/latin1.ts': Buffer.concat([Buffer.from(body), Buffer.from([0xff, 0xfe, 0x0a])]),
  });
  git(root, 'add', 'src/app.ts', '.gitignore');
  symlinkSync(join(outside, 'secret.ts'), join(root, 'src/link.ts'));
  symlinkSync(outside, join(root, 'src/linkdir'));
  // A nested repository (an unregistered submodule) is listed as a directory and never read.
  mkdirSync(join(root, 'nested'));
  git(join(root, 'nested'), 'init', '-q');
  write(root, 'nested/inner.ts', body);
  return root;
};

describe('inventory and access', () => {
  it('reads tracked and non-ignored untracked text files only, whatever their names, and nothing it must exclude', async () => {
    const root = fixture();
    const before = git(root, 'status', '--porcelain', '-uall');
    const cfg = await config(root);
    expect(cfg.projectRoot).toBe(realpathSync(root));
    const fetchImpl = vi.fn();
    const svc = createEvidenceService(cfg, { apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const { result, isError } = await svc.run({ goal: 'where is the widget parser', exactSymbols: [SYMBOL], limit: 16 }, live());
    expect(isError).toBe(false);
    expect(result.projectRoot).toBe(realpathSync(root));
    expect(result.items.map((i) => i.source.path).sort()).toEqual(['src-old/app.ts', 'src/-dash.ts', 'src/app.ts', 'src/new\nline.ts', 'src/untracked.ts', 'src/with space.ts'].sort());
    expect(result.items.every((i) => i.text === body && i.origin === 'local' && i.judgement === 'unjudged' && i.probabilities === undefined)).toBe(true);
    // Listed and eligible: .gitignore, the six hits, bin.dat, latin1.ts, link.ts, linkdir. Skipped: those four and nested/.
    expect(result.coverage).toMatchObject({ inventoryComplete: true, filesTotal: 11, readFiles: 7, skippedFiles: 5, sourceIncomplete: false });
    expect(result).toMatchObject({ status: 'ok', backend: 'local', reasonCodes: [], next: null });
    expect(fetchImpl).not.toHaveBeenCalled();

    // `src` holds src/*, never src-old/*.
    const narrowed = (await svc.run({ goal: 'widget', exactSymbols: [SYMBOL], roots: ['src'], limit: 16 }, live())).result;
    expect(narrowed.items.map((i) => i.source.path)).not.toContain('src-old/app.ts');
    expect(narrowed.items).toHaveLength(5);
    expect(git(root, 'status', '--porcelain', '-uall')).toBe(before);
  });

  it('refuses traversal, roots outside the allowed ones, excluded roots and sources that escape', async () => {
    const root = fixture();
    const svc = createEvidenceService(await config(root, { allowedRoots: ['src'] }), { apiKey: null });
    const reason = async (raw: unknown): Promise<string[]> => (await svc.run(raw, live())).result.reasonCodes;
    for (const roots of [['../x'], ['src/../../etc'], ['/etc'], ['src\\x']]) expect(await reason({ goal: 'widget', roots })).toEqual(['invalid_input']);
    expect(await reason({ goal: 'widget', roots: ['src-old'] })).toEqual(['out_of_scope']);
    expect(await reason({ goal: 'widget', roots: ['src/.env'] })).toEqual(['out_of_scope']);
    const sha = '0'.repeat(64);
    expect(await reason({ goal: 'widget', sources: [{ path: '../outside/secret.ts', startLine: 1, endLine: 1, fileSha256: sha }] })).toEqual(['invalid_input']);
    expect(await reason({ goal: 'widget', sources: [{ path: 'src-old/app.ts', startLine: 1, endLine: 1, fileSha256: sha }] })).toEqual(['out_of_scope']);
    expect(await reason({ goal: 'widget', sources: [{ path: 'src/id_rsa', startLine: 1, endLine: 1, fileSha256: sha }] })).toEqual(['out_of_scope']);
    // A symlink is readable by no route: its reference comes back stale, never with the target's text.
    const link = (await svc.run({ goal: 'widget', sources: [{ path: 'src/link.ts', startLine: 1, endLine: 1, fileSha256: sha }] }, live())).result;
    expect(link.items).toEqual([{ source: { path: 'src/link.ts', startLine: 1, endLine: 1, fileSha256: sha }, textState: 'stale', origin: 'local', judgement: 'unjudged' }]);
  });

  it('loads one absolute config and refuses anything else before any source is touched', async () => {
    const root = repo({ 'a.ts': body });
    const bad = async (env: Record<string, string | undefined>): Promise<string> => {
      const r = await loadConfig(env);
      return r.ok ? 'ok' : r.reason;
    };
    expect(await bad({})).toBe('unavailable_config');
    expect(await bad({ JEV_EVIDENCE_CONFIG: 'relative.json' })).toBe('unavailable_config');
    expect(await bad({ JEV_EVIDENCE_CONFIG: configFile('{not json') })).toBe('unavailable_config');
    expect(await bad({ JEV_EVIDENCE_CONFIG: configFile({ projectRoot: root, allowedRoots: ['.'], apiKey: 'k' }) })).toBe('unavailable_config');
    expect(await bad({ JEV_EVIDENCE_CONFIG: configFile({ projectRoot: root, allowedRoots: ['../up'] }) })).toBe('unavailable_config');
    expect(await bad({ JEV_EVIDENCE_CONFIG: configFile({ projectRoot: root, allowedRoots: ['.'], remote: 'yes' }) })).toBe('unavailable_config');
    // Not a Git worktree root: neither a plain directory nor a subdirectory of a repository.
    const plain = mkdtempSync(join(tmp, 'plain-'));
    expect(await bad({ JEV_EVIDENCE_CONFIG: configFile({ projectRoot: plain, allowedRoots: ['.'] }) })).toBe('unsupported_inventory');
    mkdirSync(join(root, 'sub'));
    expect(await bad({ JEV_EVIDENCE_CONFIG: configFile({ projectRoot: join(root, 'sub'), allowedRoots: ['.'] }) })).toBe('unsupported_inventory');
    expect(await bad({ JEV_EVIDENCE_CONFIG: configFile({ projectRoot: root, allowedRoots: ['.'] }) })).toBe('ok');

    // No config file: the Git worktree holding the session's directory, all of it, remote on; a file still decides.
    const session = await loadConfig({ CLAUDE_PROJECT_DIR: join(root, 'sub'), PWD: plain });
    expect(session).toEqual({ ok: true, config: { projectRoot: realpathSync(root), allowedRoots: [''], excludeGlobs: [], remote: true } });
    expect(await loadConfig({ PWD: root })).toEqual(session);
    expect(await bad({ CLAUDE_PROJECT_DIR: plain })).toBe('unsupported_inventory');
    expect(await bad({ CLAUDE_PROJECT_DIR: 'relative' })).toBe('unavailable_config');
    expect(await bad({ CLAUDE_PROJECT_DIR: root, JEV_EVIDENCE_CONFIG: '' })).toBe('unavailable_config');
    // A worktree the session directory is not inside is not the session's.
    const away = repo({ 'b.ts': body });
    git(plain, 'init', '-q');
    git(plain, 'config', 'core.worktree', away);
    expect(await bad({ CLAUDE_PROJECT_DIR: plain })).toBe('unsupported_inventory');
    expect(await loadConfig({ CLAUDE_PROJECT_DIR: root, JEV_EVIDENCE_CONFIG: configFile({ projectRoot: root, allowedRoots: ['sub'], remote: false }) })).toMatchObject({ ok: true, config: { allowedRoots: ['sub'], remote: false } });

    const fetchImpl = vi.fn();
    const none = await createEvidenceService(null, { apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch }).run({ goal: 'widget' }, live());
    expect(none).toMatchObject({ isError: true, result: { projectRoot: null, status: 'unavailable', reasonCodes: ['unavailable_config'], items: [] } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
