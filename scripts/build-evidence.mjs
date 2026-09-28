// Bundles the jev_evidence MCP server (#77) and the SDK it runs on into one file under plugins/evidence/dist, outside
// dist/, so the legacy and lean archives never carry it and the installed plugin needs no node_modules.
// Usage: node scripts/build-evidence.mjs [outfile]
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await build({
  entryPoints: [join(root, 'src/evidence/server.ts')],
  outfile: resolve(process.argv[2] ?? join(root, 'plugins/evidence/dist/server.mjs')),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // The SDK's CommonJS dependencies call require(); an ES module bundle has none of its own.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
