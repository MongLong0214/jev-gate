// Render the real dashboard with synthetic metadata only. No installed server, user files or credentials.
// Run: node scripts/readme-dashboard.mjs
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const clients = new Set();
let browser, server;
try {
  await build({ entryPoints: [join(root, 'src/dashboard-page.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(scratch, 'page.mjs') });
  const { DASHBOARD_PAGE } = await import(pathToFileURL(join(scratch, 'page.mjs')).href);
  const runs = Array.from({ length: 8 }, (_, i) => {
    const host = i % 3 === 1 ? 'codex' : 'claude', features = ids;
    const steps = features.map((feature, j) => {
      const worker = feature === 'workers', model = host === 'codex' ? 'gpt-6-luna' : 'claude-sonnet-5';
      const choice = feature === 'router' ? (host === 'codex' ? 'gpt-6-luna · low' : 'sonnet · high') : feature === 'admission' ? 'orchestrated' : feature === 'allocation' ? 'standard' : '12 / 16';
      return { id: `sample-${i}-${feature}`, feature, lane: worker ? 'policy' : 'jev', at: ago(i * 2500 + (4 - j) * 300), state: 'done',
        title: `${names[j]} · ${worker ? 'Contract accepted' : 'Recorded decision'}`, summary: worker ? 'Required checks passed once' : 'Synthetic sample decision', details: [],
        ...(worker ? { outcome: 'accepted' } : { durationMs: 63 + (i * 13 + j * 17) % 170, receipt: { status: 200, code: null, model: 'jev-1.14.0', input: 1200 + i * 80, output: 16, costUsd: .00006, choice, confidence: .93, threshold: .6, direction: null },
          judgements: [{ question: feature === 'router' ? 'capability' : feature === 'allocation' ? 'fully_specified' : feature === 'compact' ? 'task_context' : 'bounded_tool_work', value: feature === 'router' ? 'routine' : 'true', confidence: .93, probabilities: [{ label: feature === 'router' ? 'routine' : 'true', value: .93 }, { label: feature === 'router' ? 'complex' : 'false', value: .07 }] }] }),
        ...(feature === 'router' ? { model: { selected: model, observed: model, status: 'confirmed', selectedEffort: host === 'codex' ? 'low' : 'high', observedEffort: host === 'codex' ? 'low' : 'high' }, routing: { scope: 'root', baseline: host === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5', modelReason: 'upgrade_allowed', effortReason: 'same_value' } } : {}),
      };
    });
    if (i === 0) steps.push({ id: 'sample-running', feature: 'workers', lane: 'host', lifecycle: true, at: ago(0), startedAt: ago(1200), state: 'active', title: 'Worker · running checks', summary: 'Synthetic sample', details: [] });
    return { id: `sample-run-${i}`, host, title: ['Verify the dashboard layout', 'Update the CLI help', 'Review the response parser', 'Run the focused checks', 'Inspect routing results', 'Refresh the compaction digest', 'Check the worker contract', 'Compare model observations'][i], source: 'gate', mode: 'auto', firstAt: ago(24000 + i * 2500), lastAt: steps.at(-1).at, state: i === 0 ? 'active' : 'done', steps };
  });
  const feed = runs.flatMap(r => r.steps.map(s => ({ ...s, host: r.host, runId: r.id, runTitle: r.title }))).sort((a, b) => b.at.localeCompare(a.at));
  const calls = feed.filter(s => s.durationMs !== undefined), values = calls.map(s => s.durationMs).sort((a, b) => a - b);
  const today = {};
  for (const s of calls) { const t = today[s.host] ??= { calls: 0, input: 0, costUsd: 0, unpriced: 0 }; t.calls++; t.input += s.receipt.input; t.costUsd += s.receipt.costUsd; }
  const activity = ids.map((feature, i) => ({ feature, level: 'ok', metrics: { fired: 32 + i * 8, applied: 12 + i * 3, regression: 0, effect: null, accepted: 12, rejected: 0, pending: 1, cancelled: 0, restored: 8, budgetUsed: 12000, budget: 16000 } }));
  const frame = { at: ago(0), host: 'mixed', unreadable: 0, recording: { enabled: true }, dashboard: { enabled: true }, version: { running: version, installed: version, release: { latest: version } },
    activity24h: { all: activity, claude: activity, codex: activity.filter(a => a.feature !== 'compact') },
    operations: { runs, feed, active: 1, attention: 0, requests: calls.length, features: ids.map((id, i) => ({ id, label: names[i], source: 'trace', count: feed.filter(s => s.feature === id && !s.lifecycle).length, state: 'observed', lastAt: feed.find(s => s.feature === id).at })),
      latency: { measured: values.length, p50: values[Math.ceil(values.length / 2) - 1], p95: values[Math.ceil(values.length * .95) - 1], fastest: values[0], latest: calls[0].durationMs, recent: calls.slice(0, 16).reverse().map(s => ({ at: s.at, ms: s.durationMs })), today } } };
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/live') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify(frame)}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); }
    else if (url.pathname === '/api/step') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(runs.find(r => r.id === url.searchParams.get('run'))?.steps.find(s => s.id === url.searchParams.get('step')) ?? {})); }
    else if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(DASHBOARD_PAGE.replace('/*JEV_VERSION*/null', JSON.stringify(frame.version))); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, ...(process.env.JEV_CHROMIUM_PATH ? { executablePath: process.env.JEV_CHROMIUM_PATH } : existsSync(chrome) ? { executablePath: chrome } : {}) });
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('#pipeline .node');
    await page.locator('#language').click();
    if (theme === 'light') await page.locator('#theme').click();
    await page.locator('#pipeline [data-feature=router]').click();
    await page.locator('#pipeline [data-feature=router]').click(); // Retain all runs while inspecting Router.
    await page.waitForTimeout(350);
    const geometry = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('#pipeline .node')].map(n => { const b = n.getBoundingClientRect(), d = n.querySelector('.t i').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.bottom, dx: d.x + d.width / 2, dy: d.y + d.height / 2 }; });
      const rail = document.querySelector('#pipeline .ln').getBoundingClientRect();
      return { nodes, rail: rail.y + 1, height: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    if (errors.length || geometry.overflow || new Set(geometry.nodes.map(n => n.y)).size !== 1) throw Error('Preview did not render a five-stage row');
    const png = await page.screenshot({ fullPage: true, animations: 'disabled' });
    const accent = theme === 'dark' ? '#ff6b88' : '#bd254e', bg = theme === 'dark' ? '#0c0c0f' : '#f6f3f4', faint = theme === 'dark' ? '#918e9b' : '#6c5f70';
    const halos = geometry.nodes.map((n, i) => `<circle class="halo" cx="${n.dx}" cy="${n.dy}" r="5" style="animation-delay:-${i * .25}s"/>`).join('');
    const router = geometry.nodes[3], distance = geometry.rail - router.y;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="${geometry.height + 24}" viewBox="0 0 1280 ${geometry.height + 24}" role="img" aria-labelledby="title desc">
<title id="title">Jev Gate dashboard</title><desc id="desc">Synthetic sample rendered from the current dashboard: Gate A, Gate B, Worker, Router and Compact, live Jev responses, execution records and stage details. No production data.</desc>
<style>.halo{fill:none;stroke:${accent};transform-box:fill-box;transform-origin:center;animation:halo 1.4s ease-out infinite}@keyframes halo{from{transform:scale(.5);opacity:.9}to{transform:scale(1.6);opacity:0}}.trip{fill:${accent};animation:trip 2.4s ease-in-out infinite}@keyframes trip{0%,15%{transform:translateY(0);opacity:0}20%{opacity:1}45%,55%{transform:translateY(${distance}px);opacity:1}80%{transform:translateY(0);opacity:1}85%,100%{opacity:0}}@media(prefers-reduced-motion:reduce){.halo,.trip{animation:none;display:none}}</style>
<rect width="100%" height="100%" fill="${bg}"/><image width="1280" height="${geometry.height}" href="data:image/png;base64,${png.toString('base64')}"/>
${halos}<circle class="trip" cx="${router.x}" cy="${router.y}" r="3"/>
<text x="1256" y="${geometry.height + 16}" text-anchor="end" fill="${faint}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="12">Sample data</text></svg>\n`;
    const path = join(root, 'assets/readme', theme === 'dark' ? 'dashboard-dark.svg' : 'dashboard.svg');
    writeFileSync(path, svg);
    console.log(`Rendered ${theme} preview: ${geometry.nodes.length} stages, 1280 × ${geometry.height + 24}`);
    await page.close();
  }
} finally {
  await browser?.close();
  for (const client of clients) client.end();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  rmSync(scratch, { recursive: true, force: true });
}
