import { createServer, type Server } from 'node:http';
import { readFileSync, lstatSync, watch, type FSWatcher } from 'node:fs';
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
import { TraceDirectoryReader, traceDirectoryIdentity } from './explain.js';
import { ClaudeWorkerActivityReader } from './claude-worker-activity.js';

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

export const startDashboard = (sources: DashboardSources, port: number, runtime: { token?: string; openBrowser?: (url: string) => void; reconnectGraceMs?: number } = {}): Promise<{ url: string; port: number; close: () => Promise<void>; ensureOpen: () => void }> =>
  new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const traceReader = new TraceDirectoryReader();
    const workerReader = new ClaudeWorkerActivityReader();
    const subscribers = new Set<() => void>();
    const viewers = new Map<string, number>(); // Infinity while connected; a short lease during reconnect.
    let viewerSequence = 0;
    let openingUntil = 0;
    let loadingUntil = runtime.reconnectGraceMs ? Date.now() + runtime.reconnectGraceMs : 0;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let url = '';
    const scheduleOpen = (delay: number): void => {
      if (!runtime.openBrowser || disposed) return;
      clearTimeout(openTimer); openTimer = setTimeout(ensureOpen, delay); openTimer.unref();
    };
    const ensureOpen = (): void => {
      if (!runtime.openBrowser || disposed || !dashboardStatus(sources.env).enabled) return;
      if (subscribers.size) return;
      const now = Date.now();
      for (const [id, expires] of viewers) if (expires <= now) viewers.delete(id);
      if (viewers.size) {
        const expires = Math.min(...viewers.values());
        if (Number.isFinite(expires)) scheduleOpen(Math.max(1, expires - now));
        return;
      }
      if (loadingUntil > now) { scheduleOpen(loadingUntil - now); return; }
      if (openingUntil > now) return;
      // One owner reserves an in-flight launch, including simultaneous host startup requests.
      openingUntil = now + 30_000;
      runtime.openBrowser(url);
    };
    const watchers = new Map<string, { watcher: FSWatcher; identity: string }>();
    const directoryIdentities = new Map<string, string | null>();
    const directories = new Set([sources.traceDir, ...(sources.traceDirs?.map(source => source.dir) ?? []), sources.debugDir].filter((dir): dir is string => !!dir).map(dir => join(dir, '.')));
    let activity: ActivitySnapshot | null = null;
    let scannedAt = 0;
    let changed = false;
    let watchedAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const broadcast = (): void => { for (const publish of subscribers) publish(); };
    const kick = (dir: string, name?: string): void => {
      traceReader.invalidate(dir, name); changed = true;
      if (!timer) timer = setTimeout(() => { timer = null; broadcast(); }, 100);
    };
    const syncWatchers = (force = false): void => {
      if (!force && Date.now() - watchedAt < 2000) return;
      watchedAt = Date.now();
      const currentDirectories = new Set([...directories, ...workerReader.directories()]);
      for (const [dir, { watcher }] of watchers) if (!currentDirectories.has(dir)) { watcher.close(); watchers.delete(dir); directoryIdentities.delete(dir); }
      for (const dir of currentDirectories) {
        let identity: string | null = null;
        try { const stat = lstatSync(dir); if (stat.isDirectory() && !stat.isSymbolicLink()) identity = traceDirectoryIdentity(stat); } catch { /* It may appear later. */ }
        const existing = watchers.get(dir);
        if (existing?.identity === identity) continue;
        if (existing) { existing.watcher.close(); watchers.delete(dir); }
        if (directoryIdentities.get(dir) !== identity) { directoryIdentities.set(dir, identity); kick(dir); }
        if (identity) try {
          const watcher = watch(dir, (_event, name) => kick(dir, name?.toString()));
          watcher.on('error', () => { watcher.close(); watchers.delete(dir); kick(dir); });
          watchers.set(dir, { watcher, identity });
        } catch { /* Retry on the next poll; reconciliation still reads available files. */ }
      }
    };
    const snapshot = () => {
      syncWatchers();
      const time = Date.now();
      const pending = activity?.live.mode === 'working' || activity?.operations.feed.some(step => step.state === 'active') || activity?.workerActivity?.items.some(worker => worker.state === 'active');
      if (!activity || changed && time - scannedAt >= 100 || time - scannedAt >= (pending ? 2000 : 30_000)) {
        activity = loadActivity({ ...sources, traceReader, workerReader, now: new Date() });
        scannedAt = Date.now(); changed = false;
        syncWatchers(true);
      }
      return { ...activity, version: readVersions(sources.env, sources.host), recording: recordingStatus(sources.env), dashboard: dashboardStatus(sources.env) };
    };
    const scan = setInterval(broadcast, 400);
    scan.unref();
    const dispose = (): void => {
      disposed = true; clearTimeout(openTimer);
      if (timer) clearTimeout(timer);
      clearInterval(scan);
      for (const { watcher } of watchers.values()) watcher.close();
      watchers.clear(); subscribers.clear(); viewers.clear();
    };
    const server: Server = createServer(async (req, res) => {
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) { res.writeHead(403); res.end(); return; }
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      const path = req.url?.split('?')[0];
      if (path === '/api/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ service: 'jev-gate-dashboard', token: runtime.token ?? null })); return;
      }
      if (path === '/api/open' && req.method === 'POST') {
        if (!runtime.token || req.headers.authorization !== `Bearer ${runtime.token}`) { res.writeHead(403); res.end(); return; }
        ensureOpen(); res.end(); return;
      }
      if (path === '/api/viewer-close' && req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end(); return; }
        const viewer = new URL(req.url!, `http://${req.headers.host}`).searchParams.get('viewer');
        if (viewer) viewers.delete(viewer);
        scheduleOpen(1000); res.end(); return;
      }
      if (path === '/api/shutdown' && req.method === 'POST') {
        if (!runtime.token || req.headers.authorization !== `Bearer ${runtime.token}`) { res.writeHead(403); res.end(); return; }
        // Release the listener before the shutdown receipt lets a replacement reuse its port.
        // Existing streams get a short response flush window without accepting new connections.
        dispose(); res.end(); server.close(); setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 25); return;
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
        const body = JSON.stringify(snapshot());
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && path === '/api/worker-history') {
        const query = new URL(req.url!, `http://${req.headers.host}`).searchParams;
        const rawOffset = query.get('offset') ?? '0', offset = Number(rawOffset);
        if (!/^\d{1,12}$/.test(rawOffset) || !Number.isSafeInteger(offset)) { res.writeHead(400); res.end(); return; }
        snapshot(); // Refresh the set of identities already observed by Jev Gate.
        const session = query.get('session'), agent = query.get('agent');
        if (Boolean(session) !== Boolean(agent) || session && !/^[A-Za-z0-9_-]{1,100}$/.test(session) || agent && !/^[A-Za-z0-9_-]{1,100}$/.test(agent)) { res.writeHead(400); res.end(); return; }
        const controller = new AbortController();
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        const body = session && agent ? await workerReader.history(session, agent, offset, sources.env, new Date(), controller.signal) : workerReader.list(offset, new Date());
        if (controller.signal.aborted) return;
        res.writeHead(body ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body ?? { error: 'unobserved_agent' })); return;
      }
      if (req.method === 'GET' && path === '/api/live') {
        const identity = new URL(req.url!, `http://${req.headers.host}`).searchParams.get('viewer');
        const viewer = identity && /^[a-f0-9-]{36}$/.test(identity) ? identity : `legacy-${++viewerSequence}`;
        viewers.set(viewer, Infinity); openingUntil = 0; loadingUntil = 0; clearTimeout(openTimer);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write('retry: 500\n');
        let last = '';
        let heartbeatAt = Date.now();
        let closed = false;
        const publish = (): void => {
          if (closed) return;
          try {
            const body = snapshot();
            const next = `${body.live.sig}:${body.operations.sig}:${body.workerActivity?.sig}:${body.unreadable}:${JSON.stringify(body.version)}:${JSON.stringify(body.recording)}:${JSON.stringify(body.dashboard)}`;
            if (next === last) {
              if (Date.now() - heartbeatAt >= 5000) {
                heartbeatAt = Date.now();
                res.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date(heartbeatAt).toISOString() })}\n\n`);
              }
              return;
            }
            last = next;
            heartbeatAt = Date.now();
            res.write(`data: ${JSON.stringify(body)}\n\n`);
          } catch {
            // A bad directory read skips this tick. The next one tries again.
          }
        };
        subscribers.add(publish);
        publish();
        const stop = (): void => {
          if (closed) return;
          closed = true;
          subscribers.delete(publish);
          if (viewers.has(viewer)) viewers.set(viewer, Date.now() + 15_000);
          scheduleOpen(viewers.has(viewer) ? 15_000 : 1000);
        };
        req.on('close', stop);
        res.on('error', stop);
        return;
      }
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        // A reload may close its stream before the replacement page has started its script.
        loadingUntil = Date.now() + 10_000;
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
    server.on('close', dispose);
    server.on('error', err => { dispose(); reject(err); });
    // Loopback only. The records stay on this machine.
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address !== null ? address.port : port;
      url = `http://127.0.0.1:${actual}/`;
      resolve({
        url,
        port: actual,
        ensureOpen,
        close: () =>
          new Promise((done, fail) => {
            dispose();
            for (const socket of sockets) socket.destroy();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
