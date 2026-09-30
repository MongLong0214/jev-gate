import { createServer, type Server } from 'node:http';
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadActivity, type ActivitySnapshot } from './activity.js';
import { DASHBOARD_PAGE } from './dashboard-page.js';
import type { Env } from './config.js';
import type { Host } from './host-support.js';

const PAGE = DASHBOARD_PAGE;

export interface DashboardSources {
  host?: Host;
  traceDir: string | null;
  debugDir: string | null;
  env: Env;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
};

/**
 * #118: the dashboard process is the build it was started from and never reloads; the plugin the host runs is whatever
 * `installed_plugins.json` says. Both are read on every snapshot so an update shows up as a mismatch on the next
 * repaint instead of as silently stale cards. `null` means "could not read", never "same".
 */
export interface DashboardVersions {
  running: string | null;
  installed: string | null;
}
export const readVersions = (env: Env, pluginRoot: string = dirname(dirname(fileURLToPath(import.meta.url)))): DashboardVersions => {
  const own = readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
  const running = isRecord(own) && typeof own['version'] === 'string' ? own['version'] : null;
  const home = env['HOME'] ?? homedir();
  const registry = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  let installed: string | null = null;
  const plugins = isRecord(registry) ? registry['plugins'] : null;
  if (isRecord(plugins)) {
    for (const [key, entries] of Object.entries(plugins)) {
      if (!key.startsWith('jev-gate@') || !Array.isArray(entries)) continue;
      const first = entries.find((e) => isRecord(e) && typeof e['version'] === 'string');
      if (isRecord(first)) installed = first['version'] as string;
    }
  }
  return { running, installed };
};

const snapshot = (sources: DashboardSources): ActivitySnapshot & { version: DashboardVersions } => ({ ...loadActivity({ ...sources, now: new Date() }), version: readVersions(sources.env) });

export const startDashboard = (sources: DashboardSources, port: number): Promise<{ url: string; port: number; close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server: Server = createServer((req, res) => {
      const path = req.url?.split('?')[0];
      if (req.method === 'GET' && path === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && path === '/api/snapshot') {
        const body = JSON.stringify(snapshot(sources));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && path === '/api/live') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        let last = '';
        let timer: ReturnType<typeof setTimeout> | null = null;
        let closed = false;
        const publish = (): void => {
          if (closed) return;
          try {
            const body = snapshot(sources);
            const next = `${body.live.sig}:${body.operations.sig}:${body.unreadable}`;
            if (next === last) return;
            last = next;
            res.write(`data: ${JSON.stringify(body)}\n\n`);
          } catch {
            // A bad directory read skips this tick. The next one tries again.
          }
        };
        const kick = (): void => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(publish, 16);
        };
        const watchers: FSWatcher[] = [];
        for (const dir of [sources.traceDir, sources.debugDir]) {
          if (!dir) continue;
          try {
            watchers.push(watch(dir, kick));
          } catch {
            // The backup scan below still notices new files.
          }
        }
        const scan = setInterval(publish, 400);
        scan.unref();
        publish();
        const stop = (): void => {
          if (closed) return;
          closed = true;
          if (timer) clearTimeout(timer);
          clearInterval(scan);
          for (const w of watchers) w.close();
        };
        req.on('close', stop);
        res.on('error', stop);
        return;
      }
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'" });
        res.end(PAGE);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('error', reject);
    // Loopback only. The records stay on this machine.
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}/`,
        port: actual,
        close: () =>
          new Promise((done, fail) => {
            for (const socket of sockets) socket.destroy();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
