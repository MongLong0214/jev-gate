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
  it('refuses optional grants and unknown workspace expressions rather than expanding them', () => {
    expect(capturedPermissions(meta(profile([{ ...entry('/tmp/a', 'write'), missing_path_behavior: 'skip' }])))).toBeNull();
    expect(capturedPermissions(meta(profile([{ path: { type: 'special', value: { kind: 'project_roots', subpath: '../escape' } }, access: 'write' }])))).toBeNull();
    expect(capturedPermissions(meta(profile([{ ...entry('/tmp/secret', 'deny'), missing_path_behavior: 'skip' }])))?.config).toMatchObject({ 'permissions.jev-captured': { filesystem: { '/tmp/secret': 'deny' } } });
  });
});
