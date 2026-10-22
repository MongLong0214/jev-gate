import { lstatSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, relative } from 'node:path';

/** Watch a directory's contents or one file, including creation and atomic replacement. A missing path is followed
 * from its nearest existing parent; no polling of every descendant is needed while a host has not recorded yet. */
export const watchDashboardPath = (path: string, directory: boolean, changed: (name?: string) => void, reconciled: () => void = changed) => {
  let watchers: FSWatcher[] = [], binding = '', stamp = '', knownIdentity = '', closed = false;
  const sync = (notify = true): void => {
    if (closed) return;
    let identity = '', nextStamp = '';
    try {
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())) {
        identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        nextStamp = `${identity}:${stat.mtimeMs}:${stat.ctimeMs}:${directory ? '' : stat.size}`;
      }
    } catch { /* A parent watcher follows a path that appears later. */ }
    const moved = nextStamp !== stamp, replaced = identity !== knownIdentity;
    stamp = nextStamp; knownIdentity = identity;
    let parent = dirname(path);
    for (;;) {
      try { const stat = lstatSync(parent); if (stat.isDirectory() && !stat.isSymbolicLink()) break; } catch { /* Keep walking. */ }
      const next = dirname(parent); if (next === parent) break; parent = next;
    }
    const key = `${parent}|${identity}`;
    if (key !== binding) {
      for (const watcher of watchers) watcher.close(); watchers = []; binding = key;
      const add = (dir: string, callback: (name?: string) => void): void => {
        try {
          const watcher = watch(dir, (_event, name) => callback(name?.toString()));
          watcher.on('error', () => { watcher.close(); binding = ''; changed(); });
          watchers.push(watcher);
        } catch { binding = ''; /* The bounded reconciliation retries an unavailable OS watcher. */ }
      };
      const child = relative(parent, path).split(/[\\/]/)[0] || basename(path);
      add(parent, name => { if (name === undefined || name === child) { sync(false); changed(); } });
      if (directory && identity) add(path, name => changed(name));
    }
    // An unnotified append needs a name reconciliation, not an explicit invalidation that rereads every immutable file.
    if (notify && moved) (directory && !replaced ? reconciled : changed)();
  };
  sync(false);
  return { reconcile: (notify = true): void => sync(notify), close: (): void => { closed = true; for (const watcher of watchers) watcher.close(); watchers = []; } };
};
