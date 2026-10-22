import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// OS notifications arrive in their own time; the test delivers them itself.
const listeners = vi.hoisted(() => new Map<string, (event: string, name?: string) => void>());
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, watch: (dir: string, callback: (event: string, name?: string) => void) => { listeners.set(dir, callback); return { on: () => undefined, close: () => listeners.delete(dir) }; } };
});
const { watchDashboardPath } = await import('../src/dashboard-watch.js');

describe('dashboard directory watch', () => {
  it('lists names again only for a directory change the OS did not name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-watch-')), names: Array<string | undefined> = [], reconciled = vi.fn();
    const watcher = watchDashboardPath(dir, true, name => names.push(name), reconciled);
    try {
      writeFileSync(join(dir, 'r1.json'), '{}');
      listeners.get(dir)!('rename', 'r1.json');
      watcher.reconcile();
      expect(names).toEqual(['r1.json']);
      expect(reconciled).not.toHaveBeenCalled();
      writeFileSync(join(dir, 'r2.json'), '{}'); // No notification: only a name reconciliation finds it.
      watcher.reconcile();
      expect(reconciled).toHaveBeenCalledOnce();
    } finally { watcher.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
