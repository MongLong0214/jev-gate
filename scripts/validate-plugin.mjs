// Runs the host's strict validation over what a release ships: the marketplace manifest, and the plugin as packed.
// Usage: node scripts/validate-plugin.mjs   (after `npm run build`; `claude` must be on PATH)
// Since Claude Code 2.1.323 the validator type-checks every TypeScript file under the directory it is given. A checkout
// holds node_modules and the tests, which it refuses to type-check for size, so the checkout itself can no longer be
// validated; the packed archive is what a session loads, and it is small enough to check whole.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'jev-gate-validate-'));
const run = (command, args) => spawnSync(command, args, { cwd: root, stdio: 'inherit' }).status === 0;
let ok = false;
try {
  const plugin = join(temp, 'plugin');
  mkdirSync(plugin);
  ok = run(process.execPath, [join(root, 'scripts/pack.mjs'), temp]) &&
    run('unzip', ['-q', join(temp, `jev-gate-${version}.zip`), '-d', plugin]) &&
    run('claude', ['plugin', 'validate', join(root, '.claude-plugin/marketplace.json'), '--strict']) &&
    run('claude', ['plugin', 'validate', plugin, '--strict']);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
