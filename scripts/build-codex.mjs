import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bootstrap = await build({ entryPoints: [join(root, 'src/codex/hook-bootstrap.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true, write: false });
const command = `node --input-type=module -e '${bootstrap.outputFiles[0].text.trim().replaceAll("'", "'\\''")}'`;
const hooksPath = join(root, 'plugins/codex/hooks/hooks.json');
const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const hook of group.hooks) hook.command = command;
writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + '\n');
await build({
  entryPoints: {
    hook: join(root, 'src/codex/hook.ts'),
    server: join(root, 'src/evidence/server.ts'),
    cli: join(root, 'src/codex/cli.ts'),
    worktree: join(root, 'src/worktree-cli.ts'),
    // The dashboard rebuilds history on this thread; the CLI bundle starts it from its own directory.
    'activity-worker': join(root, 'src/activity-worker.ts'),
  },
  outdir: process.argv[2] ?? join(root, 'plugins/codex/dist'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  define: { __JEV_HOOK_AUTORUN__: 'false', __JEV_AGENT_INSTRUCTIONS__: JSON.stringify(Object.fromEntries(['worker-fast', 'worker', 'worker-deep', 'worker-frontier'].map(name => [
    `jev-gate:${name}`, readFileSync(join(root, 'agents', `${name}.md`), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''),
  ]))) },
  banner: { js: "import { createRequire as __jevCreateRequire } from 'node:module'; const require = __jevCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
