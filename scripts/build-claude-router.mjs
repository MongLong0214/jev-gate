// Bundle the bounded transcript metadata reader for the integrated and standalone Router.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await build({
  entryPoints: [join(root, 'src/claude-router-observation.ts')],
  outfile: resolve(process.argv[2] ?? join(root, 'dist/router-observation-hook.js')),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
});
