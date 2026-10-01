import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkerWorktree, hasWorktreeHead } from '../src/worktree.js';

describe('working snapshot isolation', () => {
  it('copies staged, unstaged, deleted and untracked inputs, preserves the root index and applies only worker changes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'jev-snapshot-'));
    const git = (args: string[], cwd = repo, input?: string): string => {
      const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
      expect(r.status, r.stderr).toBe(0); return r.stdout;
    };
    try {
      git(['init']);
      expect(hasWorktreeHead(repo, process.env)).toBe(false);
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
      writeFileSync(join(repo, 'staged.txt'), 'original\n');
      writeFileSync(join(repo, 'edit.txt'), 'original\n');
      writeFileSync(join(repo, 'deleted.txt'), 'original\n');
      git(['add', '.']); git(['commit', '-m', 'base']);
      expect(hasWorktreeHead(repo, process.env)).toBe(true);
      writeFileSync(join(repo, 'staged.txt'), 'staged\n'); git(['add', 'staged.txt']);
      writeFileSync(join(repo, 'staged.txt'), 'working after stage\n');
      writeFileSync(join(repo, 'edit.txt'), 'working\n');
      writeFileSync(join(repo, 'new.txt'), 'untracked\n');
      writeFileSync(join(repo, 'ignored.txt'), 'excluded\n'); unlinkSync(join(repo, 'deleted.txt'));
      const head = git(['rev-parse', 'HEAD']); const status = git(['status', '--porcelain']);
      const index = readFileSync(join(repo, '.git', 'index'));
      const first = createWorkerWorktree(repo, join(repo, '.jev-gate-worktrees'), { ...process.env, GIT_DIR: '/bad', GIT_INDEX_FILE: '/bad' });
      const second = createWorkerWorktree(repo, join(repo, '.jev-gate-worktrees'));
      for (const w of [first, second]) {
        expect(readFileSync(join(w.path, 'staged.txt'), 'utf8')).toBe('working after stage\n');
        expect(readFileSync(join(w.path, 'new.txt'), 'utf8')).toBe('untracked\n');
        expect(git(['ls-files'], w.path)).not.toMatch(/deleted.txt|ignored.txt|jev-gate-worktrees/);
      }
      expect(git(['rev-parse', 'HEAD'])).toBe(head); expect(readFileSync(join(repo, '.git', 'index'))).toEqual(index);
      expect(git(['status', '--porcelain'])).toBe(status);
      writeFileSync(join(first.path, 'edit.txt'), 'worker result\n'); git(['add', '.'], first.path); git(['commit', '-m', 'worker'], first.path);
      const patch = git(['diff', '--binary', first.baseline, first.branch]);
      expect(patch).not.toContain('staged.txt'); git(['apply'], repo, patch);
      expect(readFileSync(join(repo, 'edit.txt'), 'utf8')).toBe('worker result\n');
      expect(readFileSync(join(second.path, 'edit.txt'), 'utf8')).toBe('working\n');
      expect(readFileSync(join(repo, '.git', 'index'))).toEqual(index);
      const dependent = createWorkerWorktree(repo, join(repo, '.jev-gate-worktrees'));
      expect(readFileSync(join(dependent.path, 'edit.txt'), 'utf8')).toBe('worker result\n');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
