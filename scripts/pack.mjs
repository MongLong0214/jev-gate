// Builds a distributable local plugin archive (#18): compiled hook + modules, manifest, hooks, owned agents, docs.
// Usage: node scripts/pack.mjs [outDir]   → <outDir>/jev-gate-<version>.zip  (requires `npm run build` first and the `zip` CLI)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outDir = resolve(process.argv[2] ?? join(root, 'dist-pack'));
const INCLUDE = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'agents', 'dist', 'README.md', 'AGENTS.md', '.env.example', 'package.json'];

const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => walk(join(p, n))) : [p]);
const missing = INCLUDE.filter((rel) => !existsSync(join(root, rel)));
if (missing.length) {
  process.stderr.write(`pack: missing ${missing.join(', ')} — run npm run build first\n`);
  process.exit(1);
}
const files = INCLUDE.flatMap((rel) => walk(join(root, rel))).map((p) => relative(root, p)).filter((p) => !p.endsWith('.tsbuildinfo'));
if (!files.includes('dist/hook.js') || !files.includes('agents/worker.md') || !files.includes('agents/planner.md')) {
  process.stderr.write('pack: dist/hook.js or owned agents missing\n');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const archive = join(outDir, `jev-gate-${pkg.version}.zip`);
rmSync(archive, { force: true });
const zip = spawnSync('zip', ['-q', '-X', archive, ...files], { cwd: root, encoding: 'utf8' });
if (zip.error || zip.status !== 0) {
  process.stderr.write(`pack: zip failed: ${zip.error?.message ?? zip.stderr}\n`);
  process.exit(1);
}
process.stdout.write(`${archive}\n${files.length} files\n`);
