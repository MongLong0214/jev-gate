import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { overlaps } from '../bench/paths.js';

/** The kernel resolves `..` after a symlink from the link target (native realpath; the JS one cleans `..` first); the lexical form is checked beside it. */
const physical = (path: string): string => {
  const parts = path.split('/');
  for (let n = parts.length; n > 1; n--) {
    try { return resolve(realpathSync.native(parts.slice(0, n).join('/')), ...parts.slice(n)); } catch { /* Missing: try its parent. */ }
  }
  return resolve(path);
};

export const writesInto = (targets: readonly string[], scopes: readonly string[]): boolean =>
  targets.some(t => [t, physical(t)].some(form => scopes.some(s => overlaps(s, form))));
