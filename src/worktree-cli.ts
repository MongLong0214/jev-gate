import { join } from 'node:path';
import { createWorkerWorktree } from './worktree.js';

// Claude WorktreeCreate prints only a path. Codex calls the same implementation inside its captured sandbox.
const main = async (): Promise<void> => {
  if (process.argv[2] === '--codex') {
    const cwd = process.argv[3]; const root = process.argv[4];
    if (!cwd || !root) throw new Error('worktree arguments unavailable');
    process.stdout.write(JSON.stringify(createWorkerWorktree(cwd, root)));
    return;
  }
  let input = '';
  for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 64 * 1024) throw new Error('worktree input too large'); }
  const hook = JSON.parse(input) as { cwd?: string };
  if (!hook.cwd) throw new Error('worktree cwd unavailable');
  const worktree = createWorkerWorktree(hook.cwd, join(hook.cwd, '.jev-gate-worktrees'), process.env, process.env['JEV_GATE_MODE'] !== 'off');
  process.stdout.write(worktree.path + '\n');
};
main().catch(() => { process.stderr.write('Jev Gate could not create the worker worktree. Original files are unchanged.\n'); process.exitCode = 1; });
