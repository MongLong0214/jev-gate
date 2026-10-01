import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { CODEX_SANDBOX_META, codexCallerWorkspace } from './workspace.js';
import { obj, type Obj } from './source.js';

/** Round-trip the native MCP permission snapshot into a named native profile, never a guessed sandbox mode. */
export const capturedPermissions = (meta: unknown, planner: boolean): { cwd: string; config: Obj; permissions: string } | null => {
  const caller = codexCallerWorkspace(meta);
  const profile = obj(obj(obj(meta)?.[CODEX_SANDBOX_META])?.['permissionProfile']);
  if (!caller || !profile || Object.keys(profile).some(k => !['type', 'network', 'file_system'].includes(k)) || !['managed', 'disabled'].includes(String(profile['type']))) return null;
  if (profile['type'] === 'disabled') return planner
    ? { cwd: caller.cwd, permissions: ':read-only', config: {} }
    : { cwd: caller.cwd, permissions: ':danger-full-access', config: {} };
  if (!['enabled', 'restricted'].includes(String(profile['network']))) return null;
  const fs = obj(profile['file_system']);
  if (!fs || !['restricted', 'unrestricted'].includes(String(fs['type']))) return null;
  const filesystem: Obj = Object.create(null) as Obj;
  if (fs['type'] === 'unrestricted') filesystem[':root'] = planner ? 'read' : 'write';
  else {
    if (!Array.isArray(fs['entries']) || fs['entries'].length > 2048) return null;
    for (const value of fs['entries']) {
      const entry = obj(value); const path = obj(entry?.['path']);
      if (!entry || !path || !['read', 'write', 'deny', 'none'].includes(String(entry['access']))) return null;
      // Optional missing entries cannot be safely widened into an unconditional grant.
      if (entry['missing_path_behavior'] !== undefined && !(entry['missing_path_behavior'] === 'skip' && ['deny', 'none'].includes(String(entry['access'])))) return null;
      const access = entry['access'] === 'none' ? 'deny' : planner && entry['access'] === 'write' ? 'read' : entry['access'];
      let key: string; let subpath: string | undefined;
      if (path['type'] === 'path' && typeof path['path'] === 'string') {
        try { key = path['path'].startsWith('file:') ? fileURLToPath(path['path']) : path['path']; } catch { return null; }
        if (!isAbsolute(key) || key.includes('\0')) return null;
      } else if (path['type'] === 'glob_pattern' && typeof path['pattern'] === 'string' && isAbsolute(path['pattern'])) key = path['pattern'];
      else if (path['type'] === 'special') {
        const special = obj(path['value']); const kind = special?.['kind'];
        if (!['root', 'minimal', 'project_roots', 'tmpdir', 'slash_tmp'].includes(String(kind))) return null;
        key = kind === 'project_roots' ? ':workspace_roots' : `:${String(kind)}`;
        if (kind === 'project_roots') subpath = typeof special?.['subpath'] === 'string' ? special['subpath'] : '.';
      } else return null;
      if (!key || key.length > 16 * 1024 || key === 'glob_scan_max_depth' || key.includes('\0')) return null;
      if (subpath !== undefined) {
        if (isAbsolute(subpath) || subpath.split(/[\\/]/).includes('..')) return null;
        const scoped = obj(filesystem[key]);
        // A conflicting duplicate cannot be represented losslessly by the native TOML map.
        if (filesystem[key] !== undefined && !scoped || scoped && scoped[subpath] !== undefined && scoped[subpath] !== access) return null;
        filesystem[key] = { ...scoped, [subpath]: access };
      } else {
        if (filesystem[key] !== undefined && filesystem[key] !== access) return null;
        filesystem[key] = access;
      }
    }
    if (fs['glob_scan_max_depth'] !== undefined) {
      if (!Number.isSafeInteger(fs['glob_scan_max_depth']) || Number(fs['glob_scan_max_depth']) < 1) return null;
      filesystem['glob_scan_max_depth'] = fs['glob_scan_max_depth'];
    }
  }
  return { cwd: caller.cwd, permissions: 'jev-captured', config: { 'permissions.jev-captured': { filesystem, network: { enabled: !planner && profile['network'] === 'enabled' } } } };
};
