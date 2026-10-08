import { realpathSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexTraceDir } from '../codex-paths.js';
import { loadConfig } from '../evidence/source.js';
import { startDashboard, dashboardSources } from '../dashboard.js';
import { ensureDashboard, serveAutomaticDashboard } from '../dashboard-launch.js';
import { dashboardPreferenceCommand } from '../dashboard-settings.js';
import { recordingCommand } from '../recording.js';
import { launchCodex } from './launch.js';
import { loadCodexPolicy } from './config.js';
import { connectionDiagnostic, serveConnection } from './connection.js';
import { withApiKey, validApiKey } from '../credentials.js';
import { doctorChecks, finishDoctor, renderDoctor, readableFile, storageIssue, dashboardDiagnostic, versionDiagnostic, type DoctorReport } from '../doctor.js';
import { compatibilityChecks } from '../doctor-models.js';
import { codexModelInventory, codexCompatibility } from './doctor-models.js';
import { checkRelease, unknownRelease, packageVersion } from '../release-info.js';

export const codexDoctor = async (root: string, env: NodeJS.ProcessEnv, cwd: string, options: { checkUpdate?: boolean } = {}): Promise<{ ok: boolean; lines: string[]; report: DoctorReport }> => {
  const invalidKey = !!env['TYPESAFE_API_KEY']?.trim() && !validApiKey(env['TYPESAFE_API_KEY']);
  env = withApiKey(env);
  const diagnosis = doctorChecks(), say = diagnosis.say;
  const check = (pass: boolean, text: string): void => say(pass ? 'ok' : 'fail', text);
  diagnosis.group('runtime');
  const [major, minor] = process.versions.node.split('.').map(Number);
  check(major! > 22 || major === 22 && minor! >= 15, `Node ${process.versions.node} (22.15+ required for native compressed Responses)`);
  diagnosis.group('host');
  const version = spawnSync('codex', ['--version'], { env, encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 });
  const v = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec((version.stdout ?? '').trim());
  check(version.status === 0 && !!v && (Number(v[1]) > 0 || Number(v[2]) >= 158), `Codex ${v ? v.slice(1).join('.') : 'unavailable'} (minimum native integration version 0.158.0; detected version does not prove hook trust or policy application)`);
  diagnosis.group('package');
  for (const path of ['.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'dist/cli.mjs', 'dist/hook.mjs', 'dist/server.mjs', 'skills/jev-gate/SKILL.md']) check(readableFile(join(root, path)), `${path}: readable regular file required`);
  const obj = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(root, '.codex-plugin/plugin.json'), 'utf8'));
    check(obj(manifest) && manifest['name'] === 'jev-gate' && !!packageVersion(root, 'codex') && manifest['hooks'] === './hooks/hooks.json' && manifest['mcpServers'] === './.mcp.json', 'Codex plugin manifest: name, version and native discovery paths');
    const hooks: unknown = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'));
    const table = obj(hooks) && obj(hooks['hooks']) ? hooks['hooks'] : {};
    for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt']) {
      const groups = Array.isArray(table[event]) ? table[event] : [];
      const handlers = groups.flatMap((group: unknown) => obj(group) && Array.isArray(group['hooks']) ? group['hooks'] : []);
      check(groups.length === 1 && obj(groups[0]) && !('matcher' in groups[0]) && handlers.length === 1 && obj(handlers[0]) && handlers[0]['type'] === 'command' && handlers[0]['command'] === 'node "${PLUGIN_ROOT}/dist/hook.mjs"' && typeof handlers[0]['timeout'] === 'number' && handlers[0]['timeout'] > 0 && handlers[0]['timeout'] <= 5, `Codex ${event}: one unfiltered native hook with bounded timeout`);
    }
    const mcp: unknown = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    const servers = obj(mcp) && obj(mcp['mcpServers']) ? mcp['mcpServers'] : {};
    const evidence = servers['jev_gate_evidence'];
    check(obj(evidence) && evidence['command'] === 'node' && JSON.stringify(evidence['args']) === JSON.stringify(['dist/server.mjs', '--codex']) && evidence['cwd'] === '.', 'Evidence MCP: packaged server command and workspace');
    const tools = obj(evidence) && obj(evidence['tools']) ? evidence['tools'] : {};
    check(obj(tools['jev_agent']) && tools['jev_agent']['approval_mode'] === 'approve', 'Owned Agent MCP: native approval remains required');
  } catch { check(false, 'Codex package metadata: invalid JSON or unreadable file'); }
  diagnosis.group('storage');
  try {
    const path = codexTraceDir(env), issue = storageIssue(path);
    check(!issue, `trace: ${path}: ${issue ?? 'readable/writable or creatable (doctor does not create it)'}`);
    if (!issue) { try { say('info', `recorded files: ${readdirSync(path).filter(f => f.endsWith('.json')).length} (file count is not proof of policy execution)`); } catch { say('info', 'recorded files: unknown; trace directory is not present or readable yet'); } }
  } catch { check(false, 'trace: set an absolute JEV_CODEX_TRACE_DIR'); }
  diagnosis.group('configuration');
  const automatic = env['JEV_CODEX_WORKSPACE'] === undefined && env['JEV_EVIDENCE_CONFIG'] === undefined;
  if (automatic) say('info', 'Evidence workspace: selected automatically from native MCP call metadata; the calling native thread supplies its Git worktree. No workspace export is required; doctor cannot confirm a future calling thread.');
  else {
    const load = await loadConfig(env, { host: 'codex', cwd: env['JEV_CODEX_WORKSPACE'] ?? '' });
    check(load.ok, 'Evidence workspace override: explicit configuration must be valid');
    say('info', load.ok ? `Evidence scope: ${load.config.projectRoot}` : `Invalid explicit override; current directory ${cwd} is not substituted.`);
  }
  say('info', `hooks: ${env['JEV_CODEX_ENABLED'] === '0' ? 'disabled by JEV_CODEX_ENABLED=0' : 'enabled by configuration; use /hooks in Codex to review trust and execution'}`);
  say('info', `output folding: ${env['JEV_CODEX_OUTPUT'] === 'off' ? 'off' : 'on'}`);
  try {
    const policy = loadCodexPolicy(env);
    check(true, `policy: Gate ${policy.gate.mode}; Router ${policy.router.enabled ? 'on' : 'off'}; Compact ${policy.compact.enabled ? 'on' : 'off'}`);
    say('info', `Router automatic Astra: ${policy.router.allowAstra ? 'opted in' : 'off (default)'}; model/effort: ${policy.router.model ? 'on' : 'off'}/${policy.router.effort ? 'on' : 'off'}`);
    say('info', 'Account model candidates: unknown until native model/list is observed. Submitted request values do not confirm response model or actual effort.');
  } catch { check(false, 'policy: invalid Codex policy configuration'); }
  diagnosis.group('credentials');
  if (invalidKey) say('fail', 'Jev API key override has an invalid format (value hidden)', 'Correct or remove the explicit key override; it takes precedence over the private credential store.');
  say(env['TYPESAFE_API_KEY'] ? 'ok' : 'warn', `Jev API key: ${env['TYPESAFE_API_KEY'] ? 'present (format checked; API authentication not probed)' : 'absent or invalid; Jev policies preserve native behavior'}`);
  say('info', 'Native Codex authentication and hook trust: unverified by doctor; no credentials are printed or changed.');
  diagnosis.group('activity');
  try {
    const connection = await connectionDiagnostic(env);
    say(connection.state === 'ready' ? 'ok' : connection.state === 'disabled' ? 'info' : 'warn', `Native connection: ${connection.state}; helper package ${connection.version ?? 'unknown'}`,
      connection.state === 'unreachable' ? 'The helper may be busy. Check the next native session startup and its execution records; doctor does not restart active workers.' : 'Review /hooks trust and start a fresh native session after plugin installation. Doctor does not create a connection or alter the native provider.');
    if (connection.version && connection.version !== packageVersion(root, 'codex')) say('warn', 'Native connection helper and diagnosed package versions differ', 'Update the installed plugin and start a fresh native session; an already open session retains its provider.');
  } catch { say('fail', 'Native connection: invalid Codex home or unreadable owner metadata'); }
  const dashboard = await dashboardDiagnostic(env); say(dashboard.level, dashboard.message);
  say('info', 'No source was scanned and no inference was performed. Local loopback health checks are read-only. Missing execution records remain unknown.');
  diagnosis.group('version');
  const release = options.checkUpdate ? await checkRelease() : unknownRelease();
  const update = versionDiagnostic(root, 'codex', release); say(update.level, update.message);
  const inventory = await codexModelInventory(env, cwd);
  let compatibility: import('../doctor-models.js').ModelCompatibility[] = [];
  try { compatibility = codexCompatibility(inventory, env); diagnosis.checks.push(...compatibilityChecks(compatibility)); } catch { diagnosis.group('models'); say('fail', 'Cannot check model/effort mappings because the Codex policy is invalid'); }
  if (!inventory.complete) { diagnosis.group('models'); say('warn', `Native model/list is incomplete or unavailable (${inventory.error ?? 'unknown'}); absent models and account execution remain unverified`); }
  const report: DoctorReport = { ...finishDoctor('codex', root, diagnosis.checks, release), models: { source: 'native Codex App Server model/list (no thread or turn)', complete: inventory.complete, accountAccess: 'unverified', compatibility } };
  return { ok: report.ok, lines: report.checks.map(c => `[${c.level}] ${c.message}`), report };
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
    if (argv.slice(1).some(v => !['--json', '--verbose', '--check-update'].includes(v))) { process.stderr.write('doctor: use --json, --verbose or --check-update\n'); process.exitCode = 2; return; }
    const result = await codexDoctor(root, process.env, process.cwd(), { checkUpdate: argv.includes('--check-update') });
    process.stdout.write(argv.includes('--json') ? JSON.stringify(result.report) + '\n' : renderDoctor(result.report, argv.includes('--verbose')));
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
    process.stdout.write('usage: node <plugin>/dist/cli.mjs codex [native terminal options]\n       node <plugin>/dist/cli.mjs doctor [--json|--verbose] [--check-update]\n       node <plugin>/dist/cli.mjs dashboard [on|off|status] [--port 4731]\n       node <plugin>/dist/cli.mjs recording on|off|status\n');
    process.exitCode = 2;
  }
};
let direct = false;
try { direct = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported */ }
if (direct) void main().catch(() => { process.stderr.write('jev-gate codex: command failed; check Codex installation, hook trust, policy configuration and CLI arguments.\n'); process.exitCode = 1; });
