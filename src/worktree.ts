import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface WorkerWorktree { path: string; branch: string; baseline: string }

export const hasWorktreeHead = (cwd: string, env: NodeJS.ProcessEnv): boolean => {
  const r = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_'))),
    encoding: 'utf8', timeout: 1000 });
  return r.status === 0;
};

/** Capture working files with a private index; never change the caller's HEAD, index or files. */
export const createWorkerWorktree = (cwd: string, root: string, env: NodeJS.ProcessEnv = process.env, snapshot = true): WorkerWorktree => {
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (args: string[], input?: string, extra: NodeJS.ProcessEnv = {}): string => {
    const out = spawnSync('git', args, { cwd, env: { ...cleanEnv, ...extra }, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (out.status !== 0) throw new Error('worktree operation failed');
    return out.stdout.trim();
  };
  const top = realpathSync(git(['rev-parse', '--show-toplevel']));
  const head = git(['rev-parse', '--verify', 'HEAD']);
  cwd = top;
  root = resolve(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('worktree root unavailable');
  root = realpathSync(root);
  try { writeFileSync(join(root, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const temporary = mkdtempSync(join(root, '.snapshot-'));
  const branch = `jev-worker-${randomUUID()}`;
  const path = join(root, branch);
  let baseline = head;
  try {
    if (snapshot) {
      const index = { GIT_INDEX_FILE: join(temporary, 'index') };
      git(['read-tree', head], undefined, index);
      const excluded = relative(top, root);
      git(['add', '-A', '--', '.', ...(!excluded.startsWith('..') && excluded !== '' ? [`:(top,exclude,literal)${excluded}`] : [])], undefined, index);
      const tree = git(['write-tree'], undefined, index);
      if (tree !== git(['rev-parse', `${head}^{tree}`])) {
        baseline = git(['commit-tree', tree, '-p', head], 'Jev Gate working snapshot\n', {
          GIT_AUTHOR_NAME: 'Jev Gate', GIT_AUTHOR_EMAIL: 'snapshot@jev-gate.local',
          GIT_COMMITTER_NAME: 'Jev Gate', GIT_COMMITTER_EMAIL: 'snapshot@jev-gate.local',
        });
      }
    }
    git(['worktree', 'add', '-b', branch, path, baseline]);
    return { path, branch, baseline };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
};
