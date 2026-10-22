import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';

import { openTraceDir, pruneTraceDir, type TraceWriter } from '../trace.js';
import { codexTraceDir } from '../codex-paths.js';
import { CODEX_SANDBOX_META, codexCallerWorkspace } from '../codex/workspace.js';
import { AGENT_TOOL } from '../codex/profiles.js';
import { connectionRequest, ensureConnection, recordConnectionFailure } from '../codex/connection.js';
import { dirname } from 'node:path';
import type { Env } from '../config.js';
import { resolveApiKey, saveApiKey } from '../credentials.js';
import { claudeSetupMessage, claudeTraceDir, integratedClaudePlugin, prepareClaude } from '../claude-setup.js';
import { startOnboarding } from '../onboarding.js';
import { ensureDashboard } from '../dashboard-launch.js';

export const SERVER_VERSION = '0.8.49';

/** Claude Code lists no tool here; this process onboards the key and starts the dashboard. Codex lists only `jev_agent`. */
export const createServer = (deps: { dispatch?: (args: unknown, meta: unknown, signal: AbortSignal) => Promise<string> }): Server => {
  const server = new Server({ name: 'jev-evidence', version: SERVER_VERSION }, { capabilities: { tools: {}, ...(deps.dispatch ? { experimental: { [CODEX_SANDBOX_META]: {} } } : {}) } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...(deps.dispatch ? [{ name: AGENT_TOOL.name, description: AGENT_TOOL.description, inputSchema: AGENT_TOOL.inputSchema as Tool['inputSchema'], annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }] : [])] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (deps.dispatch && request.params.name === 'jev_agent') return { content: [{ type: 'text', text: await deps.dispatch(request.params.arguments ?? {}, request.params._meta, extra.signal) }] };
    throw new McpError(ErrorCode.InvalidParams, `unknown tool ${JSON.stringify(request.params.name.slice(0, 64))}`);
  });
  return server;
};

/** #287: an `/agent` call the local helper did not answer is returned and recorded by its closed reason, never its exception. */
export const connectionDispatch = (env: Env, trace?: TraceWriter) => async (arguments_: unknown, meta: unknown, signal: AbortSignal): Promise<string> => {
  const result = await connectionRequest(env, '/agent', { arguments: arguments_, meta }, signal);
  if (result.ok && typeof result.value['output'] === 'string') return result.value['output'];
  const reason = result.ok ? 'invalid_reply' : result.reason; const session = codexCallerWorkspace(meta)?.session;
  recordConnectionFailure(trace, reason, { ...(session ? { session_id: session } : {}), tool_name: 'jev_agent' });
  return `Native connection unavailable or interrupted (${reason}). No completion is claimed.`;
};
const main = async (): Promise<void> => {
  const env = process.env;
  const codex = process.argv.includes('--codex');
  const installed = codex || integratedClaudePlugin(env);
  let note: string | null = null;
  if (installed && !codex) note = claudeSetupMessage(prepareClaude(env));
  if (note) process.stderr.write(`jev-gate: ${note}\n`);
  // Existing native option/environment input also counts as the user's one key entry. Never print it.
  const option = env['CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY'];
  const supplied = option?.trim() ? option : env['TYPESAFE_API_KEY'];
  if (installed && supplied && resolveApiKey(env) === supplied) {
    try { if (resolveApiKey({ HOME: env['HOME'], XDG_CONFIG_HOME: env['XDG_CONFIG_HOME'] }) !== supplied) saveApiKey(env, supplied); }
    catch { process.stderr.write('jev-gate: shared key storage unavailable; the supplied key remains usable in this host.\n'); }
  }
  const onboarding = installed ? await startOnboarding(env, { note: note ?? (codex ? 'Codex owns hook trust. If prompted, review the installed hooks. A host already open during installation needs a fresh host to load the connection.' : 'Claude Code settings are prepared automatically. Existing permissions and explicit settings remain in effect.') }) : null;
  if (onboarding) process.stderr.write(`jev-gate: enter your Jev API key at ${onboarding.url}\n`);
  let traceDir = env['JEV_GATE_TRACE_DIR'];
  if (installed && !codex && !traceDir) traceDir = claudeTraceDir(env);
  try { if (codex) traceDir = codexTraceDir(env); }
  catch { traceDir = undefined; process.stderr.write('jev-evidence: invalid Codex trace directory; recording unavailable\n'); }
  const opened = traceDir ? openTraceDir(traceDir, env) : null;
  const root = installed && !codex ? env['CLAUDE_PLUGIN_ROOT']! : dirname(dirname(fileURLToPath(import.meta.url)));
  if (installed) void ensureDashboard(root, env);
  const automaticConnection = codex && env['JEV_CODEX_AUTO_CONNECT'] !== '0' && env['JEV_CODEX_ENABLED'] !== '0' && !env['JEV_CODEX_BRIDGE_URL'];
  if (automaticConnection) await ensureConnection(root, env);
  const server = createServer({ ...(automaticConnection ? { dispatch: connectionDispatch(env, opened?.ok ? opened.writer : undefined) } : {}) });
  let maintaining = false; let nextAttempt = 0;
  const supervisor = automaticConnection ? setInterval(() => {
    if (maintaining || Date.now() < nextAttempt) return;
    maintaining = true;
    void ensureConnection(root, env).then(ok => { nextAttempt = Date.now() + (ok ? 0 : 30_000); }).catch(() => { nextAttempt = Date.now() + 30_000; }).finally(() => { maintaining = false; });
  }, 2000) : null;
  supervisor?.unref();
  server.onclose = () => { if (supervisor) clearInterval(supervisor); void onboarding?.close(); };
  await server.connect(new StdioServerTransport());
  // Once per host session, off the hook path and after the tools answer: the age limit for this host's records (#231).
  if (opened?.ok && traceDir) void pruneTraceDir(traceDir);
};

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) void main();
