import { createServer, type Server } from 'node:http';
import { watch, type FSWatcher } from 'node:fs';
import type { Socket } from 'node:net';

import { loadActivity, type ActivitySnapshot } from './activity.js';
import type { Env } from './config.js';

const PAGE = `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev 실시간</title>
<style>
  :root { color-scheme: light dark; --ink: #1c1915; --muted: #5c564c; --line: #e4ddd2; --paper: #f6f3ec; --card: #fff; --asked: #0f6b4c; --glow: rgba(15,107,76,.45); --arrive: #e5f4ec; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #f3efe6; --muted: #b7ad9f; --line: #3a342c; --paper: #141210; --card: #221e19; --asked: #8ddebe; --glow: rgba(141,222,190,.45); --arrive: #1c3329; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; background: var(--paper); color: var(--ink); }
  main { max-width: 720px; margin: 0 auto; padding: 28px 20px 72px; }
  .kicker { margin: 0 0 8px; color: var(--muted); font-size: 13px; letter-spacing: 0.04em; }
  .kicker.working { color: var(--asked); }
  h1 { font-size: clamp(32px, 8vw, 52px); line-height: 1.05; font-weight: 680; letter-spacing: -0.04em; margin: 0; }
  .clock { margin: 10px 0 0; font-variant-numeric: tabular-nums; font-size: 22px; font-weight: 620; }
  .detail { margin: 8px 0 0; color: var(--muted); max-width: 62ch; }
  ol { list-style: none; margin: 28px 0 0; padding: 0; }
  ol li { display: grid; grid-template-columns: 18px 1fr; gap: 12px; padding: 0 0 18px; }
  ol li .rail { display: flex; flex-direction: column; align-items: center; }
  ol li .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--line); margin-top: 4px; flex: none; }
  ol li .stem { width: 2px; flex: 1; background: var(--line); margin-top: 4px; }
  ol li:last-child .stem { background: transparent; }
  ol li.active .dot { background: var(--asked); animation: pulse 1.2s ease-out infinite; }
  ol li.changed { animation: arrive 0.7s ease; }
  ol li strong { display: block; font-size: 15px; }
  ol li p { margin: 2px 0 0; color: var(--muted); }
  ol li time { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; }
  h2 { margin: 28px 0 8px; font-size: 13px; font-weight: 600; color: var(--muted); }
  .earlier { list-style: none; margin: 0; padding: 0; }
  .earlier li { display: block; padding: 8px 0; border-top: 1px solid var(--line); }
  .earlier b { font-weight: 620; }
  .notes { margin: 28px 0 0; padding: 0; list-style: none; color: var(--muted); font-size: 12px; }
  .notes li { display: block; margin: 4px 0; }
  .err { color: #9a3412; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 var(--glow); }
    100% { box-shadow: 0 0 0 14px transparent; }
  }
  @keyframes arrive { from { background: var(--arrive); } to { background: transparent; } }
</style>
<main>
  <p class="kicker" id="kicker">연결 중</p>
  <h1 id="headline" aria-live="polite">기록을 읽는 중</h1>
  <p class="clock" id="clock"></p>
  <p class="detail" id="detail">호출이 기록되는 즉시 이 단계가 바뀝니다. Jev를 새로 부르지 않습니다.</p>
  <ol id="steps"></ol>
  <h2 id="earlier-label" hidden>바로 이전</h2>
  <ul class="earlier" id="earlier"></ul>
  <ul class="notes" id="notes"></ul>
</main>
<script>
const el = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};
const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
};
let view = null;
let seen = new Map();
const paintClock = () => {
  const clock = document.getElementById('clock');
  if (!view) return;
  const ago = (sec) => {
    if (sec < 60) return sec + '초';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + '분 ' + (sec % 60) + '초';
    const hour = Math.floor(min / 60);
    return hour + '시간 ' + (min % 60) + '분 ' + (sec % 60) + '초';
  };
  if (view.mode === 'working' && view.since) {
    const ms = Math.max(0, Date.now() - Date.parse(view.since));
    clock.textContent = (ms / 1000).toFixed(1) + '초째 응답을 기다리는 중';
  } else if (view.lastAt) {
    const sec = Math.max(0, Math.round((Date.now() - Date.parse(view.lastAt)) / 1000));
    clock.textContent = '마지막 처리 후 ' + ago(sec);
  } else {
    clock.textContent = '';
  }
};
const render = (data) => {
  const live = data.live;
  if (!live) return;
  view = live;
  const kicker = document.getElementById('kicker');
  kicker.textContent = live.mode === 'working' ? ('처리 중' + (live.stage ? ' · ' + live.stage : '')) : '대기 중';
  kicker.className = 'kicker' + (live.mode === 'working' ? ' working' : '');
  document.getElementById('headline').textContent = live.headline || '';
  document.getElementById('detail').textContent = live.detail || '';
  const steps = document.getElementById('steps');
  steps.replaceChildren();
  const next = new Map();
  for (const step of live.steps || []) {
    const changed = seen.size > 0 && seen.get(step.id) !== step.state;
    const li = el('li', step.state + (changed ? ' changed' : ''));
    const rail = el('div', 'rail');
    rail.append(el('span', 'dot'), el('span', 'stem'));
    const body = el('div');
    body.append(el('strong', '', step.title || ''), el('p', '', step.line || ''));
    const stamp = when(step.at);
    if (stamp) body.append(el('time', '', stamp));
    li.append(rail, body);
    steps.append(li);
    next.set(step.id, step.state);
  }
  seen = next;
  const earlier = document.getElementById('earlier');
  earlier.replaceChildren();
  const rows = live.earlier || [];
  document.getElementById('earlier-label').hidden = rows.length === 0;
  for (const row of rows) {
    const li = document.createElement('li');
    li.append(el('b', '', (row.title || '') + ' '), el('span', '', row.detail || ''));
    earlier.append(li);
  }
  const notes = document.getElementById('notes');
  notes.replaceChildren();
  for (const note of data.notes || []) notes.append(el('li', '', note));
  const where = document.createElement('li');
  where.textContent = '게이트 추적: ' + (data.traceDir || '없음') + ' · 라우터 디버그: ' + (data.debugDir || '없음');
  notes.append(where);
  paintClock();
};
const fail = (text) => {
  document.getElementById('kicker').textContent = '연결 끊김';
  document.getElementById('headline').textContent = '기록을 읽지 못했습니다';
  document.getElementById('detail').textContent = text;
};
let lastSig = '';
const source = new EventSource('/api/live');
source.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    if (!data.live || data.live.sig === lastSig) return;
    lastSig = data.live.sig;
    render(data);
  } catch (error) {
    fail(error && error.message ? error.message : '오류');
  }
};
source.onerror = () => {
  document.getElementById('kicker').textContent = '다시 연결하는 중';
};
setInterval(paintClock, 100);
</script>
`;

export interface DashboardSources {
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
            if (body.live.sig === last) return;
            last = body.live.sig;
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
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
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
