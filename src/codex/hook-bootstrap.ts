import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Codex prunes old plugin versions while another host can still hold their
// command. This launcher is embedded in that command, outside the pruned file.
async function main(): Promise<void> {
  const root = process.env['PLUGIN_ROOT'];
  if (!root || !isAbsolute(root)) throw new Error('missing plugin root');
  let entry = join(root, 'dist/hook.mjs');
  if (!existsSync(entry)) {
    const base = dirname(root);
    if (basename(base) !== 'jev-gate' || basename(dirname(dirname(base))) !== 'cache') throw new Error('not an installed cache');
    const candidates = readdirSync(base, { withFileTypes: true }).filter(item => item.isDirectory() && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(item.name)).flatMap(item => {
      const dir = join(base, item.name);
      try {
        const manifest = JSON.parse(readFileSync(join(dir, '.codex-plugin/plugin.json'), 'utf8')) as { name?: unknown; version?: unknown };
        return manifest.name === 'jev-gate' && manifest.version === item.name && existsSync(join(dir, 'dist/hook.mjs')) ? [join(dir, 'dist/hook.mjs')] : [];
      } catch { return []; }
    });
    // Never guess between multiple installations or load an unrelated plugin.
    if (candidates.length !== 1) throw new Error('no unambiguous installed hook');
    entry = candidates[0]!;
  }
  const { runCodexHook } = await import(pathToFileURL(entry).href) as typeof import('./hook.js');
  const result = await runCodexHook({ stdin: process.stdin, env: process.env });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// A closed host pipe and missing/corrupt installation preserve native execution.
process.stdout.on('error', () => {});
void main().catch(() => { process.stdout.write('{}\n'); });
