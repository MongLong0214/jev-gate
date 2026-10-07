import { join } from 'node:path';
import { createWorkerWorktree } from './worktree.js';
import { claudeTraceDir } from './claude-setup.js';
import { openTraceDir } from './trace.js';
import { randomUUID } from 'node:crypto';

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
  const hook = JSON.parse(input) as { cwd?: string; session_id?: string };
  if (!hook.cwd) throw new Error('worktree cwd unavailable');
  const recording = process.env['JEV_GATE_MODE'] === 'off' ? null : openTraceDir(claudeTraceDir(process.env));
  const trace = recording?.ok ? recording.writer : null;
  const base = { host: 'claude', session_id: hook.session_id ?? null, request_id: randomUUID() };
  const started = Date.now(); trace?.write('worktree_start', base);
  let worktree;
  try {
    worktree = createWorkerWorktree(hook.cwd, join(hook.cwd, '.jev-gate-worktrees'), process.env, process.env['JEV_GATE_MODE'] !== 'off');
    trace?.write('worktree_result', { ...base, ok: true, branch: worktree.branch, baseline: worktree.baseline, duration_ms: Date.now() - started });
  } catch (error) {
    trace?.write('worktree_result', { ...base, ok: false, reason: 'creation_failed', duration_ms: Date.now() - started });
    throw error;
  }
  process.stdout.write(worktree.path + '\n');
};
main().catch(() => { process.stderr.write('Jev Gate could not create the worker worktree. Original files are unchanged.\n'); process.exitCode = 1; });
