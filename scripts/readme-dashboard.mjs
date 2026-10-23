// Record the real dashboard with synthetic metadata only. No installed server, user files or credentials.
// Run: node scripts/readme-dashboard.mjs (needs img2webp and cwebp from libwebp)
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'jev-readme-dashboard-'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const stamp = new Date(), ago = ms => new Date(+stamp - ms).toISOString();
const ids = ['admission', 'allocation', 'workers', 'router', 'compact'];
const names = ['Gate A', 'Gate B', 'Worker', 'Router', 'Compact'];
// Router judges every request, so it dominates the live stream as it does on a real host.
const stream = ['router', 'admission', 'router', 'compact', 'router', 'allocation', 'router', 'admission'];
const WARMUP_MS = 2500, RECORD_MS = 8000;
const clients = new Set();
let browser, server, timer;
const step = (i, feature, j, at, host) => {
  const worker = feature === 'workers', model = host === 'codex' ? 'gpt-6-luna' : 'claude-sonnet-5';
  const choice = feature === 'router' ? (host === 'codex' ? 'gpt-6-luna · low' : 'sonnet · high') : feature === 'admission' ? 'orchestrated' : feature === 'allocation' ? 'standard' : '12 / 16';
  return { id: `sample-${i}-${feature}`, feature, lane: worker ? 'policy' : 'jev', at, state: 'done',
    title: `${names[ids.indexOf(feature)]} · ${worker ? 'Contract accepted' : 'Recorded decision'}`, summary: worker ? 'Required checks passed once' : 'Synthetic sample decision', details: [],
    ...(worker ? { outcome: 'accepted' } : { durationMs: 63 + (i * 13 + j * 17) % 170, receipt: { status: 200, code: null, model: 'jev-1.14.0', input: 1200 + (i % 8) * 80, output: 16, costUsd: .00006, choice, confidence: .93, threshold: .6, direction: null },
      judgements: [{ question: feature === 'router' ? 'capability' : feature === 'allocation' ? 'fully_specified' : feature === 'compact' ? 'task_context' : 'bounded_tool_work', value: feature === 'router' ? 'routine' : 'true', confidence: .93, probabilities: [{ label: feature === 'router' ? 'routine' : 'true', value: .93 }, { label: feature === 'router' ? 'complex' : 'false', value: .07 }] }] }),
    ...(feature === 'router' ? { model: { selected: model, observed: model, status: 'confirmed', selectedEffort: host === 'codex' ? 'low' : 'high', observedEffort: host === 'codex' ? 'low' : 'high' }, routing: { scope: 'root', baseline: host === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5', modelReason: 'upgrade_allowed', effortReason: 'same_value' } } : {}),
  };
};
const runs = Array.from({ length: 8 }, (_, i) => {
  const host = i % 3 === 1 ? 'codex' : 'claude';
  const steps = ids.map((feature, j) => step(i, feature, j, ago(i * 2500 + (4 - j) * 300), host));
  if (i === 0) steps.push({ id: 'sample-running', feature: 'workers', lane: 'host', lifecycle: true, at: ago(0), startedAt: ago(1200), state: 'active', title: 'Worker · running checks', summary: 'Synthetic sample', details: [] });
  return { id: `sample-run-${i}`, host, title: ['Verify the dashboard layout', 'Update the CLI help', 'Review the response parser', 'Run the focused checks', 'Inspect routing results', 'Refresh the compaction digest', 'Check the worker contract', 'Compare model observations'][i], source: 'gate', mode: 'auto', firstAt: ago(24000 + i * 2500), lastAt: steps.at(-1).at, state: i === 0 ? 'active' : 'done', steps };
});
const activity = ids.map((feature, i) => ({ feature, level: 'ok', metrics: { fired: 32 + i * 8, applied: 12 + i * 3, regression: 0, effect: null, accepted: 12, rejected: 0, pending: 1, cancelled: 0, restored: 8, budgetUsed: 12000, budget: 16000 } }));
const frame = () => {
  const feed = runs.flatMap(r => r.steps.map(s => ({ ...s, host: r.host, runId: r.id, runTitle: r.title }))).sort((a, b) => b.at.localeCompare(a.at));
  const calls = feed.filter(s => s.durationMs !== undefined), values = calls.map(s => s.durationMs).sort((a, b) => a - b);
  const today = {};
  for (const s of calls) { const t = today[s.host] ??= { calls: 0, input: 0, costUsd: 0, unpriced: 0 }; t.calls++; t.input += s.receipt.input; t.costUsd += s.receipt.costUsd; }
  return { at: new Date().toISOString(), host: 'mixed', unreadable: 0, recording: { enabled: true }, dashboard: { enabled: true }, version: { running: version, installed: version, release: { latest: version } },
    activity24h: { all: activity, claude: activity, codex: activity },
    operations: { runs, feed, active: 1, attention: 0, requests: calls.length, features: ids.map((id, i) => ({ id, label: names[i], source: 'trace', count: feed.filter(s => s.feature === id && !s.lifecycle).length, state: 'observed', lastAt: feed.find(s => s.feature === id).at })),
      latency: { measured: values.length, p50: values[Math.ceil(values.length / 2) - 1], p95: values[Math.ceil(values.length * .95) - 1], fastest: values[0], latest: calls[0].durationMs, recent: calls.slice(0, 16).reverse().map(s => ({ at: s.at, ms: s.durationMs })), today } } };
};
// One synthetic Jev call every 150–450 ms, sent as a full frame like a reconnecting viewer receives.
let n = 0;
const add = at => {
  const feature = stream[n % stream.length], run = runs[n % 3], s = step(100 + n, feature, n, new Date(at).toISOString(), run.host);
  s.id = `live-${n++}`; s.durationMs = 90 + Math.round(Math.random() * 230);
  run.steps.push(s); run.lastAt = s.at;
  activity[ids.indexOf(feature)].metrics.fired++;
};
// A busy host already has a minute of calls on screen when the viewer opens.
for (let at = Date.now() - 60000; at < Date.now(); at += 150 + Math.random() * 300) add(at);
const live = () => {
  add(Date.now());
  const data = `data: ${JSON.stringify(frame())}\n\n`;
  for (const client of clients) client.write(data);
  timer = setTimeout(live, 150 + Math.random() * 300);
};
try {
  await build({ entryPoints: [join(root, 'src/dashboard-page.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(scratch, 'page.mjs') });
  const { DASHBOARD_PAGE } = await import(pathToFileURL(join(scratch, 'page.mjs')).href);
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/live') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify(frame())}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); }
    else if (url.pathname === '/api/step') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(runs.find(r => r.id === url.searchParams.get('run'))?.steps.find(s => s.id === url.searchParams.get('step')) ?? {})); }
    else if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(DASHBOARD_PAGE.replace('/*JEV_VERSION*/null', JSON.stringify(frame().version))); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  live();
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, ...(process.env.JEV_CHROMIUM_PATH ? { executablePath: process.env.JEV_CHROMIUM_PATH } : existsSync(chrome) ? { executablePath: chrome } : {}) });
  const recordings = [];
  for (const theme of ['light', 'dark']) {
    const dir = join(scratch, theme);
    mkdirSync(dir);
    const page = await browser.newPage({ viewport: { width: 1280, height: 910 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('#stages button.st');
    await page.locator('#language').click();
    if (theme === 'light') await page.locator('#theme').click();
    await page.waitForTimeout(WARMUP_MS);
    const geometry = await page.evaluate(() => ({ stages: document.querySelectorAll('#stages button.st:not([hidden])').length, dots: document.querySelectorAll('#dots .dot').length, overflow: document.documentElement.scrollWidth > innerWidth }));
    if (errors.length || geometry.overflow || geometry.stages !== 5 || !geometry.dots) throw Error('Preview did not render five stages and the call scatter');
    // Each frame keeps the real time until the next one, so the loop plays at the page's own speed.
    const frames = [], start = Date.now();
    while (Date.now() - start < RECORD_MS) {
      const file = join(dir, `${String(frames.length).padStart(4, '0')}.png`);
      await page.screenshot({ path: file });
      frames.push({ file, at: Date.now() });
    }
    await page.close();
    recordings.push({ theme, frames });
    console.log(`Recorded ${theme} preview: ${geometry.stages} stages, ${geometry.dots} calls on screen, ${frames.length} frames in ${RECORD_MS / 1000} s`);
  }
  // Encoding blocks the event loop, so it waits until the live stream is no longer needed.
  for (const { theme, frames } of recordings) {
    const suffix = theme === 'dark' ? '-dark' : '';
    execFileSync('img2webp', ['-loop', '0', '-lossy', '-q', '70', '-m', '6', ...frames.slice(0, -1).flatMap((f, i) => ['-d', String(frames[i + 1].at - f.at), f.file]), '-o', join(root, `assets/readme/dashboard${suffix}.webp`)], { stdio: 'ignore' });
    // The README shows this still frame under prefers-reduced-motion.
    execFileSync('cwebp', ['-q', '80', frames.at(-1).file, '-o', join(root, `assets/readme/dashboard-still${suffix}.webp`)], { stdio: 'ignore' });
  }
} finally {
  clearTimeout(timer);
  await browser?.close();
  for (const client of clients) client.end();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  rmSync(scratch, { recursive: true, force: true });
}
