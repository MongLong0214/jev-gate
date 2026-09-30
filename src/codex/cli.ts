import { realpathSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexTraceDir } from '../codex-paths.js';
import { CODEX_CAPABILITIES } from '../host-support.js';
import { loadConfig } from '../evidence/source.js';
import { startDashboard } from '../dashboard.js';

export const codexDoctor = async (root: string, env: NodeJS.ProcessEnv, cwd: string): Promise<{ ok: boolean; lines: string[] }> => {
  const lines: string[] = [];
  let ok = true;
  const check = (pass: boolean, text: string): void => { if (!pass) ok = false; lines.push(`[${pass ? 'ok' : 'fail'}] ${text}`); };
  check(Number(process.versions.node.split('.')[0]) >= 22, `Node ${process.versions.node} (22+ required)`);
  const version = spawnSync('codex', ['--version'], { env, encoding: 'utf8', timeout: 3000 });
  const v = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(version.stdout ?? '');
  check(version.status === 0 && !!v && (Number(v[1]) > 0 || Number(v[2]) >= 158), `Codex ${v ? v.slice(1).join('.') : 'unavailable'} (tested with 0.158.0; older hosts are unsupported)`);
  for (const path of ['.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'dist/hook.mjs', 'dist/server.mjs', 'skills/jev-gate/SKILL.md']) check(existsSync(join(root, path)), path);
  try {
    const path = codexTraceDir(env);
    const exists = existsSync(path);
    const valid = !exists || (lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink());
    check(valid, `trace: ${path}`);
    lines.push(`[info] recorded files: ${valid && exists ? readdirSync(path).filter(f => f.endsWith('.json')).length : 0}`);
  } catch { check(false, 'trace: set an absolute JEV_CODEX_TRACE_DIR'); }
  const load = await loadConfig(env, { host: 'codex', cwd: env['JEV_CODEX_WORKSPACE'] ?? '' });
  check(load.ok, 'Evidence workspace configuration (JEV_CODEX_WORKSPACE or JEV_EVIDENCE_CONFIG required)');
  if (!load.ok) lines.push(`[info] Start in your project with JEV_CODEX_WORKSPACE set to its absolute path. Current directory: ${cwd}`);
  lines.push(`[info] Evidence scope: ${load.ok ? load.config.projectRoot : load.detail}`);
  lines.push(`[info] Evidence remote: ${load.ok && load.config.remote ? 'on' : 'off'}; TYPESAFE_API_KEY: ${env['TYPESAFE_API_KEY'] ? 'present' : 'absent'}`);
  lines.push('[info] No source was scanned and no request was sent.');
  lines.push(`[info] hooks: ${env['JEV_CODEX_ENABLED'] === '0' ? 'disabled by JEV_CODEX_ENABLED=0' : 'enabled by configuration; use /hooks in Codex to review trust and execution'}`);
  lines.push(`[info] output folding: ${env['JEV_CODEX_OUTPUT'] === 'off' ? 'off' : 'on'}`);
  for (const [feature, capability] of Object.entries(CODEX_CAPABILITIES)) lines.push(`[${capability.mode}] ${feature}: ${capability.en}`);
  lines.push('[info] This checks local readiness, not plugin installation, hook trust, or measured savings.');
  return { ok, lines };
};

const main = async (): Promise<void> => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const argv = process.argv.slice(2);
  if (argv[0] === 'doctor') {
    const result = await codexDoctor(root, process.env, process.cwd());
    process.stdout.write(`${result.lines.join('\n')}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } else if (argv[0] === 'dashboard') {
    const i = argv.indexOf('--port');
    const port = i === -1 ? 4731 : Number(argv[i + 1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port requires an integer from 0 to 65535');
    const server = await startDashboard({ traceDir: codexTraceDir(process.env), debugDir: null, env: process.env, host: 'codex' }, port);
    process.stdout.write(`Codex dashboard: ${server.url}\nLocal records only. Ctrl-C stops the server.\n`);
    if (process.platform === 'darwin' && process.env['JEV_DASHBOARD_NO_OPEN'] !== '1') {
      const child = spawn('open', [server.url], { stdio: 'ignore', detached: true }); child.on('error', () => undefined); child.unref();
    }
  } else {
    process.stdout.write('usage: node <plugin>/dist/cli.mjs doctor\n       node <plugin>/dist/cli.mjs dashboard [--port 4731]\n');
    process.exitCode = 2;
  }
};
let direct = false;
try { direct = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported */ }
if (direct) void main().catch(() => { process.stderr.write('jev-gate codex: command failed; check the port and absolute trace directory.\n'); process.exitCode = 1; });
