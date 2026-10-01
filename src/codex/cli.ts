import { realpathSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexTraceDir } from '../codex-paths.js';
import { CODEX_CAPABILITIES } from '../host-support.js';
import { loadConfig } from '../evidence/source.js';
import { startDashboard, dashboardSources } from '../dashboard.js';
import { ensureDashboard, serveAutomaticDashboard } from '../dashboard-launch.js';
import { dashboardPreferenceCommand } from '../dashboard-settings.js';
import { recordingCommand } from '../recording.js';
import { launchCodex } from './launch.js';
import { loadCodexPolicy } from './config.js';
import { serveConnection } from './connection.js';
import { withApiKey } from '../credentials.js';

export const codexDoctor = async (root: string, env: NodeJS.ProcessEnv, cwd: string): Promise<{ ok: boolean; lines: string[] }> => {
  env = withApiKey(env);
  const lines: string[] = [];
  let ok = true;
  const check = (pass: boolean, text: string): void => { if (!pass) ok = false; lines.push(`[${pass ? 'ok' : 'fail'}] ${text}`); };
  const [major, minor] = process.versions.node.split('.').map(Number);
  check(major! > 22 || major === 22 && minor! >= 15, `Node ${process.versions.node} (22.15+ required for native compressed Responses)`);
  const version = spawnSync('codex', ['--version'], { env, encoding: 'utf8', timeout: 3000 });
  const v = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(version.stdout ?? '');
  check(version.status === 0 && !!v && (Number(v[1]) > 0 || Number(v[2]) >= 158), `Codex ${v ? v.slice(1).join('.') : 'unavailable'} (tested with 0.158.0 and 0.159.2; older hosts are unsupported)`);
  for (const path of ['.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'dist/hook.mjs', 'dist/server.mjs', 'skills/jev-gate/SKILL.md']) check(existsSync(join(root, path)), path);
  try {
    const path = codexTraceDir(env);
    const exists = existsSync(path);
    const valid = !exists || (lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink());
    check(valid, `trace: ${path}`);
    lines.push(`[info] recorded files: ${valid && exists ? readdirSync(path).filter(f => f.endsWith('.json')).length : 0}`);
  } catch { check(false, 'trace: set an absolute JEV_CODEX_TRACE_DIR'); }
  const load = await loadConfig(env, { host: 'codex', cwd: env['JEV_CODEX_WORKSPACE'] ?? '' });
  const automatic = env['JEV_CODEX_WORKSPACE'] === undefined && env['JEV_EVIDENCE_CONFIG'] === undefined;
  check(automatic || load.ok, automatic ? 'Evidence workspace: selected automatically from native MCP call metadata' : 'Evidence workspace override');
  lines.push(`[info] Evidence scope: ${automatic ? 'the calling native thread\'s Git worktree; no workspace export is required' : load.ok ? load.config.projectRoot : load.detail}`);
  if (!automatic && !load.ok) lines.push(`[info] Invalid explicit override; current directory ${cwd} is not substituted.`);
  lines.push(`[info] Evidence remote: ${automatic || load.ok && load.config.remote ? 'on' : 'off'}; TYPESAFE_API_KEY: ${env['TYPESAFE_API_KEY'] ? 'present' : 'absent'}`);
  lines.push('[info] No source was scanned and no request was sent.');
  lines.push(`[info] hooks: ${env['JEV_CODEX_ENABLED'] === '0' ? 'disabled by JEV_CODEX_ENABLED=0' : 'enabled by configuration; use /hooks in Codex to review trust and execution'}`);
  lines.push(`[info] output folding: ${env['JEV_CODEX_OUTPUT'] === 'off' ? 'off' : 'on'}`);
  try { const policy = loadCodexPolicy(env); check(true, `policy: Gate ${policy.gate.mode}; Router ${policy.router.enabled ? 'on' : 'off'}; Compact ${policy.compact.enabled ? 'on' : 'off'}`); }
  catch { check(false, 'policy: invalid Codex policy configuration'); }
  lines.push('[info] The installed plugin connects ordinary Codex automatically; a host that already loaded its provider needs a fresh native session. Hook trust and authentication remain native. Doctor readiness is not proof of policy execution.');
  for (const [feature, capability] of Object.entries(CODEX_CAPABILITIES)) lines.push(`[${capability.mode}] ${feature}: ${capability.en}`);
  lines.push('[info] This checks local readiness, not plugin installation, hook trust, or measured savings.');
  return { ok, lines };
};

const main = async (): Promise<void> => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const argv = process.argv.slice(2);
  if (argv[0] === 'dashboard-serve') {
    await serveAutomaticDashboard(root, process.env, argv[1] ?? '');
  } else if (argv[0] === 'connection-serve') {
    await serveConnection(root, process.env);
  } else if (argv[0] === 'codex') {
    process.exitCode = await launchCodex(argv.slice(1), process.env);
  } else if (argv[0] === 'doctor') {
    const result = await codexDoctor(root, process.env, process.cwd());
    process.stdout.write(`${result.lines.join('\n')}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } else if (argv[0] === 'dashboard') {
    if (['on', 'off', 'status'].includes(argv[1] ?? '')) {
      process.stdout.write(dashboardPreferenceCommand(process.env, argv[1]!) + '\n');
      if (argv[1] === 'on') await ensureDashboard(root, process.env);
      return;
    }
    const i = argv.indexOf('--port');
    const port = i === -1 ? 4731 : Number(argv[i + 1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port requires an integer from 0 to 65535');
    const server = await startDashboard(dashboardSources(process.env), port);
    process.stdout.write(`Codex dashboard: ${server.url}\nLocal records only. Ctrl-C stops the server.\n`);
    if (process.platform === 'darwin' && process.env['JEV_DASHBOARD_NO_OPEN'] !== '1') {
      const child = spawn('open', [server.url], { stdio: 'ignore', detached: true }); child.on('error', () => undefined); child.unref();
    }
  } else if (argv[0] === 'recording') {
    process.stdout.write(recordingCommand(process.env, argv[1]) + '\n');
  } else {
    process.stdout.write('usage: node <plugin>/dist/cli.mjs codex [native terminal options]\n       node <plugin>/dist/cli.mjs doctor\n       node <plugin>/dist/cli.mjs dashboard [on|off|status] [--port 4731]\n       node <plugin>/dist/cli.mjs recording on|off|status\n');
    process.exitCode = 2;
  }
};
let direct = false;
try { direct = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported */ }
if (direct) void main().catch(() => { process.stderr.write('jev-gate codex: command failed; check Codex installation, hook trust, policy configuration and CLI arguments.\n'); process.exitCode = 1; });
