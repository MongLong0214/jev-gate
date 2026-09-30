import { createServer, type Server } from 'node:http';
import { watch, type FSWatcher } from 'node:fs';
import type { Socket } from 'node:net';

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

const snapshot = (sources: DashboardSources): ActivitySnapshot => loadActivity({ ...sources, now: new Date() });

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
        const body = JSON.stringify(snapshot(sources) satisfies ActivitySnapshot);
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
