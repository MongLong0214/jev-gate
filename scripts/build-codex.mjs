import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await build({
  entryPoints: {
    hook: join(root, 'src/codex/hook.ts'),
    server: join(root, 'src/evidence/server.ts'),
    cli: join(root, 'src/codex/cli.ts'),
  },
  outdir: process.argv[2] ?? join(root, 'plugins/codex/dist'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
