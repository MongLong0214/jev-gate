import { lstatSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, relative } from 'node:path';

/** Watch a directory's contents or one file, including creation and atomic replacement. A missing path is followed
 * from its nearest existing parent; no polling of every descendant is needed while a host has not recorded yet. */
export const watchDashboardPath = (path: string, directory: boolean, changed: (name?: string) => void) => {
  let watchers: FSWatcher[] = [], binding = '', stamp = '', closed = false;
  const sync = (notify = true): void => {
    if (closed) return;
    let identity = '', nextStamp = '';
    try {
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())) {
        identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        // Immutable traces are reconciled by filename in the activity reader. A directory's mtime moving after an
        // already observed append must not invalidate and reread its entire history at the next safety check.
        nextStamp = directory ? identity : `${identity}:${stat.mtimeMs}:${stat.size}`;
      }
    } catch { /* A parent watcher follows a path that appears later. */ }
    const moved = nextStamp !== stamp; stamp = nextStamp;
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
    if (notify && moved) changed();
  };
  sync(false);
  return { reconcile: (): void => sync(), close: (): void => { closed = true; for (const watcher of watchers) watcher.close(); watchers = []; } };
};
