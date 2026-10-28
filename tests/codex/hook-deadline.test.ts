import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { runCodexHook, type CodexHookDeps } from '../../src/codex/hook.js';
import { connectionRequest, ensureConnection } from '../../src/codex/connection.js';

const helper = async (answer: (path: string, res: ServerResponse) => void) => {
  const server = createServer((req, res) => { req.resume(); answer(req.url!, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
};
const owner = (home: string, url: string, root = home) => {
  mkdirSync(join(home, 'jev-gate/connection'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'jev-gate/connection/owner.json'), JSON.stringify({ version: 1, pid: process.pid, port: Number(new URL(url).port), token: 'a'.repeat(64), root, original: {}, installed: {} }), { mode: 0o600 });
};
async function* stdin(event: string) { yield JSON.stringify({ hook_event_name: event, session_id: 'deadline-test', model: 'native', cwd: '/test' }); }
const openTrace = () => ({ ok: false as const, error: 'recording_disabled' as const });
const manifest = JSON.parse(readFileSync(new URL('../../plugins/codex/hooks/hooks.json', import.meta.url), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>> };

describe('native hook total deadline (#305)', () => {
  it.each(['SessionEnd', 'Interrupt', 'PreToolUse'])('returns before the native %s deadline when the bridge never answers', async event => {
    const server = await helper(() => undefined);
    try {
      const start = performance.now();
      expect(await runCodexHook({ stdin: stdin(event), env: { JEV_CODEX_BRIDGE_URL: server.url, JEV_CODEX_BRIDGE_TOKEN: 'isolated-test' }, openTrace })).toEqual({});
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThan(1000); // The real HTTP request was pending, rather than skipped.
      expect(elapsed).toBeLessThan(manifest.hooks[event]![0]!.hooks[0]!.timeout * 1000 - 300);
    } finally { await server.close(); }
  });

  it('shares the startup health/provision time with the subsequent helper request', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-hook-deadline-'));
    const paths: string[] = [];
    const server = await helper((path, res) => {
      paths.push(path);
      if (path === '/health') void delay(180).then(() => res.end('{"ready":true}'));
      if (path === '/credentials') void delay(350).then(() => res.end('{}'));
    });
    try {
      // Exercise startup from a packaged layout so ensureConnection sees its
      // manifest. Everything, including owner/config/credentials, stays isolated.
      mkdirSync(join(home, '.codex-plugin'));
      writeFileSync(join(home, '.codex-plugin/plugin.json'), '{"version":"0.8.33"}');
      const bundle = join(home, 'dist/hook.mjs');
      await build({ entryPoints: [new URL('../../src/codex/hook.ts', import.meta.url).pathname], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
      const packaged = await import(pathToFileURL(bundle).href) as { runCodexHook: (deps: CodexHookDeps) => Promise<unknown> };
      owner(home, server.url);
      const start = performance.now();
      await packaged.runCodexHook({ stdin: stdin('SessionStart'), env: { HOME: home, CODEX_HOME: home, TYPESAFE_API_KEY: 'isolated-test-key' }, openTrace });
      expect(paths).toEqual(['/health', '/credentials', '/hook']);
      expect(performance.now() - start).toBeLessThan(4600);
    } finally { await server.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it('does not spend a fresh credential timeout after the caller deadline', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-provision-deadline-'));
    const paths: string[] = [];
    const server = await helper((path) => { paths.push(path); });
    try {
      owner(home, server.url);
      const start = performance.now();
      expect(await connectionRequest({ HOME: home, CODEX_HOME: home, TYPESAFE_API_KEY: 'isolated-provision-key' }, '/hook', {}, AbortSignal.timeout(100))).toEqual({ ok: false, reason: 'timeout', stage: 'credentials' });
      expect(performance.now() - start).toBeLessThan(400);
      expect(paths).toEqual(['/credentials']);
    } finally { await server.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it('stops startup polling at the caller deadline without launching after cancellation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-start-deadline-'));
    const server = await helper(() => undefined);
    try {
      mkdirSync(join(home, '.codex-plugin'));
      writeFileSync(join(home, '.codex-plugin/plugin.json'), '{"version":"0.8.33"}');
      owner(home, server.url);
      const start = performance.now();
      expect(await ensureConnection(home, { HOME: home, CODEX_HOME: home }, AbortSignal.timeout(100))).toBe(false);
      expect(performance.now() - start).toBeLessThan(400);
    } finally { await server.close(); rmSync(home, { recursive: true, force: true }); }
  });
});
