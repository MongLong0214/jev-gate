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
import { claudeConfigDir, claudeTraceDir } from './claude-setup.js';
import { codexTraceDir } from './codex-paths.js';
import { readSettingsEnvVar } from './host-window.js';
import { recordingStatus, setRecording } from './recording.js';
import { dashboardStatus, setDashboard } from './dashboard-settings.js';
import { JEV_FAVICON } from './dashboard-brand.js';

const PAGE = DASHBOARD_PAGE;

export interface DashboardSources {
  host?: Host;
  traceDir: string | null;
  traceDirs?: readonly { host: Host; dir: string }[] | undefined;
  debugDir: string | null;
  env: Env;
}

/** Ordinary launches discover both native hosts. No shared directory or environment export is required. */
export const dashboardSources = (env: Env, host?: Host): DashboardSources => {
  const configured = (key: string): string | undefined => {
    const setting = readSettingsEnvVar(env, process.cwd(), key);
    return env[key] || (setting && 'value' in setting ? setting.value : undefined);
  };
  const claude = configured('JEV_GATE_TRACE_DIR') || claudeTraceDir(env);
  const codex = codexTraceDir({ ...env, JEV_GATE_TRACE_DIR: undefined });
  return { env, ...(host ? { host } : {}), traceDir: null,
    traceDirs: [{ host: 'claude' as const, dir: claude }, { host: 'codex' as const, dir: codex }].filter(source => !host || source.host === host),
    debugDir: host === 'codex' ? null : configured('CLAUDE_CODE_DEBUG_LOGS_DIR') || join(claudeConfigDir(env), 'debug') };
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
};

/** Running code is captured at module load. Only the host's installed version can change. */
export interface DashboardVersions {
  running: string | null;
  installed: string | null;
}
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ownAtStartup = ['.claude-plugin', '.codex-plugin'].map(kind => readJson(join(PLUGIN_ROOT, kind, 'plugin.json')))
  .find(value => isRecord(value) && typeof value['version'] === 'string');
const RUNNING_VERSION = isRecord(ownAtStartup) && typeof ownAtStartup['version'] === 'string' ? ownAtStartup['version'] : null;
export const readVersions = (env: Env, host?: Host): DashboardVersions => {
  const running = RUNNING_VERSION;
  // Codex does not use Claude's install registry; its installation remains unknown here.
  if (host === 'codex' || !host && isRecord(readJson(join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json')))) return { running, installed: null };
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

const snapshot = (sources: DashboardSources) => ({ ...loadActivity({ ...sources, now: new Date() }), version: readVersions(sources.env, sources.host), recording: recordingStatus(sources.env), dashboard: dashboardStatus(sources.env) });

export const startDashboard = (sources: DashboardSources, port: number, runtime: { token?: string } = {}): Promise<{ url: string; port: number; close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server: Server = createServer(async (req, res) => {
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) { res.writeHead(403); res.end(); return; }
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      const path = req.url?.split('?')[0];
      if (path === '/api/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ service: 'jev-gate-dashboard', token: runtime.token ?? null })); return;
      }
      if (path === '/api/shutdown' && req.method === 'POST') {
        if (!runtime.token || req.headers.authorization !== `Bearer ${runtime.token}`) { res.writeHead(403); res.end(); return; }
        res.end(); setTimeout(() => { for (const socket of sockets) socket.destroy(); server.close(); }, 25); return;
      }
      if ((path === '/api/recording' || path === '/api/dashboard') && req.method === 'POST') {
        // Preferences require an explicit same-origin local UI action.
        const origin = `http://${req.headers.host}`;
        if (req.headers.origin !== origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '') || req.headers['content-type'] !== 'application/json') { res.writeHead(403); res.end(); return; }
        try {
          let body = ''; for await (const part of req) { body += part; if (body.length > 256) { res.writeHead(413); res.end(); return; } }
          const input = JSON.parse(body) as { enabled?: unknown };
          if (typeof input.enabled !== 'boolean') { res.writeHead(400); res.end(); return; }
          const recording = path === '/api/recording';
          (recording ? setRecording : setDashboard)(sources.env, input.enabled);
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify((recording ? recordingStatus : dashboardStatus)(sources.env)));
        } catch { res.writeHead(500); res.end(); }
        return;
      }
      if (req.method === 'GET' && (path === '/favicon.ico' || path === '/favicon.svg')) {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        res.end(JEV_FAVICON);
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
            const next = `${body.live.sig}:${body.operations.sig}:${body.unreadable}:${JSON.stringify(body.version)}:${JSON.stringify(body.recording)}:${JSON.stringify(body.dashboard)}`;
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
        for (const dir of [sources.traceDir, ...(sources.traceDirs?.map(source => source.dir) ?? []), sources.debugDir]) {
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
