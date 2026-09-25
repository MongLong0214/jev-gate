// Builds a distributable local plugin archive (#18): compiled hook + modules, manifest, hooks, agents, docs.
// Usage: node scripts/pack.mjs [outDir] [--root <pluginRoot>] [--profile legacy|lean]
//   legacy (default) → <outDir>/jev-gate-<version>.zip       six routing roles, the V5 hook set
//   lean   (JGL-04)  → <outDir>/jev-gate-lean-<version>.zip  one executor, the lean hook set, `--lean` entrypoint
// Requires `npm run build` first (which clears dist, so a deleted module cannot reappear here) and the `zip` CLI.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const root = flag('root') ? resolve(flag('root')) : dirname(dirname(fileURLToPath(import.meta.url)));
const profile = flag('profile') ?? 'legacy';
if (profile !== 'legacy' && profile !== 'lean') {
  process.stderr.write(`pack: unknown profile ${profile}\n`);
  process.exit(1);
}
const consumed = new Set();
for (const name of ['root', 'profile']) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) {
    consumed.add(i);
    consumed.add(i + 1);
  }
}
const positional = args.filter((_, i) => !consumed.has(i));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outDir = resolve(positional[0] ?? join(root, 'dist-pack'));

const LEGACY_AGENTS = ['worker-fast', 'worker', 'worker-deep', 'worker-frontier', 'planner', 'planner-frontier'];
const LEAN_AGENTS = ['executor'];
const agents = profile === 'lean' ? LEAN_AGENTS : LEGACY_AGENTS;

const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => walk(join(p, n))) : [p]);

// [source path relative to root, path inside the archive]. The hook set is the only file that is renamed.
const entries = [
  ['.claude-plugin/plugin.json', '.claude-plugin/plugin.json'],
  [profile === 'lean' ? 'hooks/lean.json' : 'hooks/hooks.json', 'hooks/hooks.json'],
  ...agents.map((a) => [`agents/${a}.md`, `agents/${a}.md`]),
  ...['README.md', 'AGENTS.md', '.env.example', 'package.json'].map((f) => [f, f]),
];
const missing = entries.map(([src]) => src).filter((rel) => !existsSync(join(root, rel)));
if (!existsSync(join(root, 'dist/hook.js'))) missing.push('dist/hook.js');
if (missing.length) {
  process.stderr.write(`pack: missing ${missing.join(', ')} — run npm run build first\n`);
  process.exit(1);
}
for (const p of walk(join(root, 'dist'))) {
  const rel = relative(root, p);
  if (!rel.endsWith('.tsbuildinfo')) entries.push([rel, rel]);
}

const name = profile === 'lean' ? `jev-gate-lean-${pkg.version}` : `jev-gate-${pkg.version}`;
const stage = join(outDir, `.stage-${name}`);
rmSync(stage, { recursive: true, force: true });
for (const [src, dest] of entries) {
  const target = join(stage, dest);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, src), target);
}
mkdirSync(outDir, { recursive: true });
const archive = join(outDir, `${name}.zip`);
rmSync(archive, { force: true });
const zip = spawnSync('zip', ['-q', '-X', '-r', archive, '.'], { cwd: stage, encoding: 'utf8' });
rmSync(stage, { recursive: true, force: true });
if (zip.error || zip.status !== 0) {
  process.stderr.write(`pack: zip failed: ${zip.error?.message ?? zip.stderr}\n`);
  process.exit(1);
}
process.stdout.write(`${archive}\n${entries.length} files\n`);
