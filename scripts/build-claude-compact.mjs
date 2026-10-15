// Bundles Compact's command-hook path (src/claude-compact.ts) into dist/compact-hook.js. It imports the Mod's digest and
// selection sources from mods/, outside the tsc rootDir, so it is bundled like the Codex and evidence entries.
// Usage: node scripts/build-claude-compact.mjs [outfile]
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await build({
  entryPoints: [join(root, 'src/claude-compact.ts')],
  outfile: resolve(process.argv[2] ?? join(root, 'dist/compact-hook.js')),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
});
