import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await build({
  entryPoints: {
    hook: join(root, 'src/codex/hook.ts'),
    server: join(root, 'src/evidence/server.ts'),
    cli: join(root, 'src/codex/cli.ts'),
    worktree: join(root, 'src/worktree-cli.ts'),
  },
  outdir: process.argv[2] ?? join(root, 'plugins/codex/dist'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  define: { __JEV_HOOK_AUTORUN__: 'false', __JEV_AGENT_INSTRUCTIONS__: JSON.stringify(Object.fromEntries(['planner', 'planner-frontier', 'worker-fast', 'worker', 'worker-deep', 'worker-frontier', 'executor'].map(name => [
    `jev-gate:${name}`, readFileSync(join(root, 'agents', `${name}.md`), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''),
  ]))) },
  banner: { js: "import { createRequire as __jevCreateRequire } from 'node:module'; const require = __jevCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
