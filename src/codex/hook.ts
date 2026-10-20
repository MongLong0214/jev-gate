import { createHash } from 'node:crypto';
import { closeSync, openSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexTraceDir } from '../codex-paths.js';
import { openTraceDir, type TraceWriter } from '../trace.js';
import { connectionRequest, ensureConnection, helperRequest, recordConnectionFailure, type ConnectionFailure } from './connection.js';

type Rec = Record<string, unknown>;
const record = (v: unknown): Rec | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null;
const token = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9_.:/+@-]{1,160}$/.test(v) && !/(sk-|jv_live_)/i.test(v) ? v : null;
const EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt']);
const LIMIT = 2 * 1024 * 1024;

/** Only explicit structured status or the anchored native exec envelope; never infer from command output. */
export const toolOutcome = (value: unknown): { exit_code: number | null; is_error: boolean } => {
  const response = record(value);
  let code = Number.isSafeInteger(response?.['exit_code']) ? response!['exit_code'] as number : null;
  if (typeof value === 'string') {
    const match = /^Chunk ID: [A-Za-z0-9_-]+\nWall time: [\d.]+ seconds\nProcess exited with code (-?\d+)\n(?:Final output:|Output:)\n/.exec(value);
    if (match && Number.isSafeInteger(Number(match[1]))) code = Number(match[1]);
  }
  return { exit_code: code, is_error: response?.['isError'] === true || response?.['is_error'] === true || code !== null && code !== 0 };
};

export interface CodexHookDeps {
  stdin: AsyncIterable<string | Uint8Array>;
  env: Readonly<Record<string, string | undefined>>;
  openTrace?: typeof openTraceDir;
}

/** No permissions, prompts, source, tool input/output, transcript or environment dumps enter the recorder. */
export const handleCodexEvent = (input: Rec, env: CodexHookDeps['env'], trace?: TraceWriter): Rec => {
  const event = token(input['hook_event_name']);
  const session = token(input['session_id']);
  if (!event || !EVENTS.has(event) || !session) return {};
  const tool = token(input['tool_name']);
  const base = {
    host: 'codex', mode: 'native', managed: !!env['JEV_CODEX_BRIDGE_URL'], event, session_id: session,
    prompt_id: token(input['turn_id']), tool_use_id: token(input['tool_use_id']),
    tool_name: tool, agent_id: token(input['agent_id']), agent_type: token(input['agent_type']),
    // The hook's model is the emitting session's model. It is never promoted to a spawned child's model.
    model: token(input['model']),
    ...toolOutcome(input['tool_response']),
    interrupted: event === 'Interrupt',
  };
  const eventRecord = trace?.write('codex_event', base);
  if (!eventRecord || !eventRecord.ok && eventRecord.error !== 'recording_disabled') return {};
  if (event === 'SessionStart' && env['JEV_CODEX_BRIDGE_URL']) return { hookSpecificOutput: { hookEventName: event, additionalContext:
    'Jev Gate is connected to the native Codex session adapter. Gate A/B, plans, contract acceptance and root guard use the shared policies; Router uses official turn settings; Compact uses the native compaction lifecycle. Follow the current turn guidance and use jev_agent for owned dispatches. Native permissions and the user request remain authoritative. Do not claim unobserved policies or savings ran.' } };
  if (event === 'SessionStart') return { hookSpecificOutput: { hookEventName: event, additionalContext:
    'Jev Gate native Codex plugin: jev_evidence provides repository evidence and hooks record lifecycle metadata. The installed plugin connects ordinary native Codex automatically. A session already open during installation retains its previous provider; use a fresh native session once connection is ready. This startup notice does not establish actual Gate, Router or Compact application; inspect recorded requests and never claim unobserved policies ran. See the Jev Gate skill for setup.' } };
  return {};
};

/**
 * #287: a hook records a connection failure once per (session, reason), so a session that stays disconnected adds no row per event.
 * Like the compact Mod's `compact_asked-<session>.asked`, the claim is a marker beside the records, created exclusively across hook
 * processes and removed by trace retention with its row; a row that could not be written gives its claim back.
 */
const recordOnce = (dir: string, trace: TraceWriter, reason: ConnectionFailure, fields: { session_id: string | null } & Rec): void => {
  const marker = join(dir, `connection_failed-${createHash('sha256').update(`${fields.session_id ?? ''}\0${reason}`, 'utf8').digest('hex').slice(0, 32)}.seen`);
  try { closeSync(openSync(marker, 'wx', 0o600)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return; }
  if (!recordConnectionFailure(trace, reason, fields)) rmSync(marker, { force: true });
};

export const runCodexHook = async (deps: CodexHookDeps): Promise<Rec> => {
  try {
    if (deps.env['JEV_CODEX_ENABLED'] === '0') return {};
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of deps.stdin) {
      const b = Buffer.from(chunk); bytes += b.length;
      if (bytes > LIMIT) return {};
      chunks.push(b);
    }
    const input = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!input) return {};
    const opened = (deps.openTrace ?? openTraceDir)(codexTraceDir(deps.env), deps.env);
    const recorded = handleCodexEvent(input, deps.env, opened.ok ? opened.writer : undefined);
    const bridge = deps.env['JEV_CODEX_BRIDGE_URL'];
    const secret = deps.env['JEV_CODEX_BRIDGE_TOKEN'];
    const automatic = !bridge || !secret;
    if (automatic) {
      if (deps.env['JEV_CODEX_AUTO_CONNECT'] === '0') return recorded;
      if (input['hook_event_name'] === 'SessionStart' && typeof input['model'] === 'string' && typeof input['cwd'] === 'string') await ensureConnection(dirname(dirname(fileURLToPath(import.meta.url))), deps.env);
    } else {
      const url = new URL(bridge);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return recorded;
    }
    const reply = automatic ? await connectionRequest(deps.env, '/hook', input, AbortSignal.timeout(4200)) : await helperRequest(new URL('/hook', bridge).href, secret, input, AbortSignal.timeout(4200));
    if (!reply.ok) {
      if (opened.ok) recordOnce(codexTraceDir(deps.env), opened.writer, reply.reason, { session_id: token(input['session_id']), event: token(input['hook_event_name']), tool_name: token(input['tool_name']) });
      return recorded;
    }
    if (Object.keys(reply.value).length) return reply.value;
    if (automatic && input['hook_event_name'] === 'SessionStart') return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Jev Gate native hooks and jev_agent dispatch are available. Follow the current Gate guidance and use jev_agent for owned dispatches. Router and Compact apply only when actual model requests pass through the local connection; a host already running before installation retains its previous provider until restarted. Native permissions and user constraints remain authoritative. Do not claim unobserved policies ran.' } };
    return recorded;
  } catch {
    // Hook failures preserve native behavior. No exception messages containing input reach stdout/stderr.
    return {};
  }
};

const main = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (main) void runCodexHook({ stdin: process.stdin, env: process.env }).then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); });
