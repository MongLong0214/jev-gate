import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capturedPermissions } from '../../src/codex/permissions.js';
import { CODEX_SANDBOX_META } from '../../src/codex/workspace.js';

const meta = (profile: unknown) => ({ threadId: 'caller', [CODEX_SANDBOX_META]: { sandboxCwd: 'file:///tmp/project%20space', permissionProfile: profile } });
const entry = (path: string, access: string) => ({ path: { type: 'path', path }, access });
const profile = (entries: unknown[]) => ({ type: 'managed', network: 'restricted', file_system: { type: 'restricted', entries } });
describe('native caller permission inheritance', () => {
  it('preserves scoped grants and denies, including native protected Git metadata', () => {
    const p = profile([entry('/', 'read'), entry('/tmp/project space', 'write'), entry('/tmp/project space/.git', 'deny')]);
    expect(capturedPermissions(meta(p))).toEqual({ cwd: '/tmp/project space', permissions: 'jev-captured', config: { 'permissions.jev-captured': { filesystem: { '/': 'read', '/tmp/project space': 'write', '/tmp/project space/.git': 'deny' }, network: { enabled: false } } } });
  });
  it('never infers unrestricted access from missing or unsupported native state', () => {
    for (const p of [undefined, {}, { type: 'external', network: 'enabled' }, profile([{ path: { type: 'unknown' }, access: 'write' }]), profile([entry('relative', 'write')]), profile([entry('/tmp/a', 'read'), entry('/tmp/a', 'write')])]) expect(capturedPermissions(meta(p))).toBeNull();
  });
  it('copies unrestricted access only from an actually disabled parent', () => {
    expect(capturedPermissions(meta({ type: 'disabled' }))?.permissions).toBe(':danger-full-access');
  });
  it('refuses optional grants it cannot check and unknown workspace expressions rather than expanding them', () => {
    expect(capturedPermissions(meta(profile([{ path: { type: 'special', value: { kind: 'tmpdir' } }, access: 'write', missing_path_behavior: 'skip' }])))).toBeNull();
    expect(capturedPermissions(meta(profile([{ ...entry('/tmp/a', 'write'), missing_path_behavior: 'ask' }])))).toBeNull();
    expect(capturedPermissions(meta(profile([{ path: { type: 'special', value: { kind: 'project_roots', subpath: '../escape' } }, access: 'write' }])))).toBeNull();
    expect(capturedPermissions(meta(profile([{ ...entry('/tmp/secret', 'deny'), missing_path_behavior: 'skip' }])))?.config).toMatchObject({ 'permissions.jev-captured': { filesystem: { '/tmp/secret': 'deny' } } });
  });
  it('applies a skipped grant only where its path exists, as Codex 0.162.1 sends it for protected metadata under a writable root (#287)', () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-skip-'));
    try {
      mkdirSync(join(root, '.git')); mkdirSync(join(root, '.codex'));
      // Real shape: {"path":{"type":"path","path":"<root>/.git"},"access":"read","missing_path_behavior":"skip"}; .agents and .aws are absent here.
      const skip = (name: string) => ({ path: { type: 'path', path: join(root, name) }, access: 'read', missing_path_behavior: 'skip' });
      const p = profile([entry('/', 'read'), entry(root, 'write'), skip('.git'), skip('.agents'), skip('.codex'), skip('.aws'), { ...entry(join(root, '.env'), 'none'), missing_path_behavior: 'skip' }]);
      expect(capturedPermissions(meta(p))?.config).toEqual({ 'permissions.jev-captured': { filesystem: { '/': 'read', [root]: 'write', [join(root, '.git')]: 'read', [join(root, '.codex')]: 'read', [join(root, '.env')]: 'deny' }, network: { enabled: false } } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
