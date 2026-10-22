import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { activityEngine, type LoadedActivity } from './activity-engine.js';
import { DASHBOARD_PAGE } from './dashboard-page.js';
import type { Env } from './config.js';
import type { Host } from './host-support.js';
import { claudeTraceDir } from './claude-setup.js';
import { codexTraceDir } from './codex-paths.js';
import { readSettingsEnvVar } from './host-window.js';
import { recordingPath, recordingStatus, setRecording } from './recording.js';
import { dashboardSettingsPath, dashboardStatus, setDashboard } from './dashboard-settings.js';
import { JEV_FAVICON } from './dashboard-brand.js';
import { releaseChecker, type ReleaseInfo } from './release-info.js';
import { credentialsPath } from './credentials.js';
import { livenessPath } from './liveness.js';
import { watchDashboardPath } from './dashboard-watch.js';

const PAGE = DASHBOARD_PAGE;

/** Reconnect leases kept at once. A stream opened without `?viewer=` gets a new id each time, so without a bound every
 * reconnect left one lease behind until a browser launch check ran, and without `openBrowser` that check never ran. */
export const VIEWER_LEASES = 64;
/** Drops expired reconnect leases, and the oldest ones beyond `VIEWER_LEASES`. Connected viewers (Infinity) stay. A lease
 * is set by deleting and re-adding its id, so map order is lease order. */
export const pruneViewers = (viewers: Map<string, number>, now: number): void => {
  let leases = 0;
  for (const expires of viewers.values()) if (Number.isFinite(expires)) leases++;
  for (const [id, expires] of viewers) {
    if (Number.isFinite(expires) && (expires <= now || leases > VIEWER_LEASES)) { viewers.delete(id); leases--; }
  }
};
/** Coalesce one frame of notifications, without queuing values behind a one-second playback budget. Rebuilds stay shared. */
export const rebuildWait = (lastMs: number): number => Math.min(100, Math.max(16, lastMs));

export interface DashboardSources {
  host?: Host;
  traceDir: string | null;
  traceDirs?: readonly { host: Host; dir: string }[] | undefined;
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
    traceDirs: [{ host: 'claude' as const, dir: claude }, { host: 'codex' as const, dir: codex }].filter(source => !host || source.host === host) };
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
  release?: ReleaseInfo;
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
      const versions = entries.flatMap(e => isRecord(e) && typeof e['version'] === 'string' ? [e['version']] : []);
      // Conflicting scopes must not silently select a different installed package.
      for (const version of versions) {
        if (installed !== null && installed !== version) return { running, installed: null };
        installed = version;
      }
    }
  }
  return { running, installed };
};

export const startDashboard = (sources: DashboardSources, port: number, runtime: { token?: string; openBrowser?: (url: string) => void; reconnectGraceMs?: number; releaseFetch?: typeof fetch } = {}): Promise<{ url: string; port: number; close: () => Promise<void>; closed: Promise<void>; ensureOpen: () => void }> =>
  new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const engine = activityEngine(sources);
    const controller = new AbortController();
    const releases = releaseChecker(runtime.releaseFetch, Date.now, controller.signal);
    const versions = (): DashboardVersions => ({ ...readVersions(sources.env, sources.host), release: releases.current() });
    const subscribers = new Set<(extra: string, heartbeat?: boolean) => void>();
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
      pruneViewers(viewers, now);
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
    const directories = new Set([sources.traceDir, ...(sources.traceDirs?.map(source => source.dir) ?? [])].filter((dir): dir is string => !!dir).map(dir => join(dir, '.')));
    let loaded: LoadedActivity | null = null;
    let loading: Promise<void> | null = null;
    let startedAt = 0;
    let retryAt = 0;
    let changed = true;
    let timer: ReturnType<typeof setTimeout> | null = null, due: ReturnType<typeof setTimeout> | null = null;
    let step: { base: string; key: string; patch: string } | null = null;
    let whole: { key: string; json: string } | null = null, wholeLoading: Promise<void> | null = null;
    const extras = (): string => `"version":${JSON.stringify(versions())},"recording":${JSON.stringify(recordingStatus(sources.env))},"dashboard":${JSON.stringify(dashboardStatus(sources.env))}`;
    let extra = extras();
    // A frame is the activity plus the preferences and versions shown beside it; both parts are in its key.
    const frameKey = (activity: string, extra: string): string => `${activity}|${extra}`;
    const wholeFrame = (extra: string): string | null => whole ? `${whole.json.slice(0, -1)},"frame":${JSON.stringify(frameKey(whole.key, extra))},${extra}}` : null;
    /** The whole frame is serialized on the activity thread only when a viewer or a snapshot request needs it. */
    const ensureWhole = (): Promise<void> => {
      if (!loaded || whole?.key === loaded.key) return Promise.resolve();
      return wholeLoading ??= engine.full().then(next => { if (next) whole = next; }, () => { /* The next rebuild retries. */ })
        .finally(() => { wholeLoading = null; broadcast(); });
    };
    const broadcast = (heartbeat = false): void => {
      if (disposed || !subscribers.size) return;
      for (const publish of subscribers) publish(extra, heartbeat);
    };
    // Removing a large directory notifies once per file; the names go to the activity thread in one message.
    const invalidations = new Map<string, Set<string> | null>(); // null: the whole directory
    const reconciliations = new Set<string>();
    const flush = (): void => {
      for (const [dir, names] of invalidations) engine.invalidate(dir, names ? [...names] : undefined).catch(() => { /* A replaced thread starts from a full read. */ });
      invalidations.clear();
      for (const dir of reconciliations) engine.reconcile(dir).catch(() => { /* A replaced thread starts from a full read. */ });
      reconciliations.clear();
    };
    const kick = (dir: string, name?: string): void => {
      if (disposed) return;
      const names = invalidations.get(dir);
      if (name === undefined) invalidations.set(dir, null);
      else if (names !== null) invalidations.set(dir, (names ?? new Set<string>()).add(name));
      changed = true;
      schedule();
    };
    /** Rebuilds run on the activity thread, one at a time, and every caller shares the one in flight.
     * Coalesce nearby notifications for at most 100 ms; a later record never waits behind playback. */
    const wait = (): number => rebuildWait(loaded?.ms ?? 0);
    const schedule = (): void => {
      if (disposed || !subscribers.size || loading || timer) return;
      // Coalesce file bursts, but do not postpone the first frame or a record behind another completed rebuild.
      const delay = Math.max(retryAt - Date.now(), startedAt ? Math.max(20, startedAt + wait() - Date.now()) : 0);
      timer = setTimeout(() => { timer = null; void refresh(); }, delay); timer.unref();
    };
    const expiry = (): void => {
      if (due) clearTimeout(due); due = null;
      if (disposed || !subscribers.size || !loaded || !Number.isFinite(loaded.until)) return;
      due = setTimeout(() => { due = null; changed = true; schedule(); }, Math.min(2_147_483_647, Math.max(1, loaded.until - Date.now()))); due.unref();
    };
    const refresh = (): Promise<void> => {
      if (disposed) return Promise.resolve();
      const elapsed = Date.now() - startedAt;
      if (!loading && (!startedAt || changed && elapsed >= wait() || Date.now() >= (loaded?.until ?? 0))) {
        startedAt = Date.now(); changed = false; flush();
        loading = engine.load().then(next => {
          if (disposed) return;
          retryAt = 0;
          if (next.patch && next.base) step = { base: next.base, key: next.key, patch: next.patch };
          loaded = next;
        }, () => { changed = true; retryAt = Date.now() + 1000; /* Keep the last frame and avoid a failing-reader spin. */ })
          .finally(() => { loading = null; if (!disposed) { broadcast(); expiry(); if (changed) schedule(); } });
      } else if (!loading && changed) schedule();
      return loading ?? Promise.resolve();
    };
    const preferencesChanged = (): void => { if (!disposed) { extra = extras(); changed = true; broadcast(); schedule(); } };
    const traceWatchers = [...directories].map(dir => watchDashboardPath(dir, true, name => kick(dir, name), () => { reconciliations.add(dir); changed = true; schedule(); }));
    const watchers = [
      ...traceWatchers,
      ...[recordingPath(sources.env), dashboardSettingsPath(sources.env), credentialsPath(sources.env),
        join(sources.env['HOME'] ?? homedir(), '.claude/plugins/installed_plugins.json'),
        ...['.claude-plugin', '.codex-plugin'].map(kind => join(PLUGIN_ROOT, kind, 'plugin.json'))]
        .map(path => watchDashboardPath(path, false, preferencesChanged)),
      ...(sources.host === 'codex' ? [] : [watchDashboardPath(livenessPath(sources.env), false, () => { changed = true; schedule(); })]),
    ];
    // A quiet stream only sends a small heartbeat. A constant number of metadata checks covers OS notifications
    // missed during watcher registration or a busy batch, without loading or rereading an unchanged history.
    const heartbeat = setInterval(() => broadcast(true), 5000); heartbeat.unref();
    let checks = 0;
    const reconcile = setInterval(() => {
      for (const watcher of watchers) watcher.reconcile();
      // Rare filename reconciliation also covers a filesystem with unchanged directory timestamps.
      if (++checks % 60 === 0) {
        extra = extras();
        if (subscribers.size) { changed = true; schedule(); }
      }
    }, 500); reconcile.unref();
    let engineClosed: Promise<void> | undefined;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true; clearTimeout(openTimer);
      if (timer) clearTimeout(timer);
      if (due) clearTimeout(due);
      clearInterval(heartbeat); clearInterval(reconcile); controller.abort();
      for (const watcher of watchers) watcher.close();
      subscribers.clear(); viewers.clear(); invalidations.clear(); reconciliations.clear();
      engineClosed = engine.close();
    };
    const server: Server = createServer(async (req, res) => {
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) { res.writeHead(403); res.end(); return; }
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      const path = req.url?.split('?')[0];
      if (path === '/api/version' && req.method === 'GET') {
        await releases.refresh();
        extra = extras(); broadcast();
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(versions())); return;
      }
      if (path === '/api/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        // Public liveness never discloses the capability; an owner probe already possesses it.
        const owner = runtime.token && req.headers.authorization === `Bearer ${runtime.token}`;
        res.end(JSON.stringify({ service: 'jev-gate-dashboard', ...(owner ? { token: runtime.token } : {}) })); return;
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
          preferencesChanged();
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
        // An open stream keeps the frame current, so answer with it at once; its `at` tells when it was built. Waiting for
        // the rebuild in flight held the answer for up to a whole rebuild while records kept arriving (#215).
        if (!loaded || !subscribers.size) {
          await refresh();
          // Without a viewer nothing else catches up on new records, so the request waits out the rebuild pause once.
          // A timer can wake a millisecond before Date.now() reaches its delay, and the refresh then skipped the rebuild (#266).
          if (changed && loaded) { for (const at = startedAt + wait(); Date.now() < at;) await new Promise(resolve => setTimeout(resolve, at - Date.now())); await refresh(); }
        }
        await ensureWhole();
        extra = extras();
        const body = wholeFrame(extra);
        res.writeHead(body ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body ?? JSON.stringify({ error: 'activity_unavailable' }));
        return;
      }
      if (req.method === 'GET' && path === '/api/step') {
        // The detail fields of the one stage a viewer opened; frames leave them out.
        const query = new URL(req.url!, `http://${req.headers.host}`).searchParams, run = query.get('run') ?? '', id = query.get('step') ?? '';
        const body = run && id && run.length <= 200 && id.length <= 200 ? await engine.step(run, id).catch(() => null) : null;
        res.writeHead(body ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body ?? JSON.stringify({ error: 'step_unavailable' }));
        return;
      }
      if (req.method === 'GET' && path === '/api/live') {
        const identity = new URL(req.url!, `http://${req.headers.host}`).searchParams.get('viewer');
        const viewer = identity && /^[a-f0-9-]{36}$/.test(identity) ? identity : `legacy-${++viewerSequence}`;
        viewers.delete(viewer); viewers.set(viewer, Infinity); pruneViewers(viewers, Date.now()); openingUntil = 0; loadingUntil = 0; clearTimeout(openTimer);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        // The first frame may wait for a rebuild; the retry field goes out with it so a frame stays one chunk.
        res.flushHeaders();
        let prefix = 'retry: 500\n';
        // What this viewer holds: the activity key and the preference/version part of its frame.
        let held: { activity: string; extra: string } | null = null;
        let heartbeatAt = Date.now();
        let closed = false;
        let blocked = false;
        const send = (text: string): void => { heartbeatAt = Date.now(); blocked = !res.write(`${prefix}${text}\n\n`); prefix = ''; };
        const publish = (extra: string, heartbeat = false): void => {
          if (closed || blocked) return;
          const activity = loaded?.key;
          if (activity && held && (held.activity === activity || step?.base === held.activity && step.key === activity)) {
            if (held.activity === activity && held.extra === extra) {
              // A first rebuild can take seconds; the heartbeat shows the stream is alive meanwhile.
              if (heartbeat || Date.now() - heartbeatAt >= 5000) send(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}`);
              return;
            }
            // Only the change goes out: a patch between consecutive rebuilds, and the preferences only when they moved.
            const moved = held.activity !== activity;
            send(`event: patch\ndata: {"base":${JSON.stringify(frameKey(held.activity, held.extra))},"frame":${JSON.stringify(frameKey(activity, extra))}${held.extra === extra ? '' : `,"extra":{${extra}}`}${moved ? `,"p":${step!.patch}` : ''}}`);
            held = { activity, extra };
            return;
          }
          if (activity && whole?.key === activity) { send(`data: ${wholeFrame(extra)}`); held = { activity, extra }; return; }
          if (activity) void ensureWhole();
          if (heartbeat || Date.now() - heartbeatAt >= 5000) send(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}`);
        };
        subscribers.add(publish);
        void refresh();
        publish(extra); expiry();
        const stop = (): void => {
          if (closed) return;
          closed = true;
          subscribers.delete(publish);
          if (!subscribers.size) { if (due) clearTimeout(due); due = null; if (timer) clearTimeout(timer); timer = null; }
          const leased = viewers.delete(viewer);
          if (leased) viewers.set(viewer, Date.now() + 15_000);
          pruneViewers(viewers, Date.now());
          scheduleOpen(leased ? 15_000 : 1000);
        };
        req.on('close', stop);
        res.on('error', stop);
        // A slow tab gets the current frame after draining, instead of retaining every intermediate patch in memory.
        res.on('drain', () => { blocked = false; publish(extra); });
        return;
      }
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        // A reload may close its stream before the replacement page has started its script.
        loadingUntil = Date.now() + 10_000;
        // The version badge's text sets its width, so it is in the first frame rather than arriving after it.
        await releases.refresh();
        extra = extras(); broadcast();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'" });
        res.end(PAGE.replace('/*JEV_VERSION*/null', JSON.stringify(versions()).replace(/</g, '\\u003c')));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    let completed = (): void => undefined;
    const closed = new Promise<void>(done => { completed = done; });
    server.on('close', () => { dispose(); void engineClosed?.finally(completed); });
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
        closed,
        close: async () => {
          dispose();
          for (const socket of sockets) socket.destroy();
          if (server.listening) server.close();
          await closed;
        },
      });
    });
  });
