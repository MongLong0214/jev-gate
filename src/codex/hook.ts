import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexTraceDir } from '../codex-paths.js';
import { openTraceDir, type TraceWriter } from '../trace.js';
import { PROVIDER, connectionOwner, connectionRequest, ensureConnection } from './connection.js';

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

/** #282: a new session's rollout opens with session_meta, the provider and originator it started with. Only those are read. */
const startedSession = (input: Rec): Rec | null => {
  const path = input['transcript_path'];
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  try {
    const head = Buffer.alloc(256 * 1024); const fd = openSync(path, 'r');
    let size: number; try { size = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
    const line = record(JSON.parse(head.subarray(0, size).toString('utf8').split('\n', 1)[0]!));
    const meta = record(line?.['payload']);
    return line?.['type'] === 'session_meta' && meta?.['id'] === input['session_id'] ? meta : null;
  } catch { return null; }
};

export interface CodexHookDeps {
  stdin: AsyncIterable<string | Uint8Array>;
  env: Readonly<Record<string, string | undefined>>;
  openTrace?: typeof openTraceDir;
}

/** No permissions, prompts, source, tool input/output, transcript or environment dumps enter the recorder. */
export const handleCodexEvent = (input: Rec, env: CodexHookDeps['env'], trace?: TraceWriter, routing?: Rec): Rec => {
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
    // A session keeps the provider it started with: one started without the connection is never routed.
    ...routing,
  };
  const eventRecord = trace?.write('codex_event', base);
  if (!eventRecord || !eventRecord.ok && eventRecord.error !== 'recording_disabled') return {};
  if (event === 'SessionStart' && env['JEV_CODEX_BRIDGE_URL']) return { hookSpecificOutput: { hookEventName: event, additionalContext:
    'Jev Gate is connected to the native Codex session adapter. Gate A/B, plans, contract acceptance and root guard use the shared policies; Router uses official turn settings; Compact uses the native compaction lifecycle. Follow the current turn guidance and use jev_agent for owned dispatches. Native permissions and the user request remain authoritative. Do not claim unobserved policies or savings ran.' } };
  if (event === 'SessionStart') return { hookSpecificOutput: { hookEventName: event, additionalContext:
    'Jev Gate native Codex plugin: jev_evidence provides repository evidence and hooks record lifecycle metadata. The installed plugin connects ordinary native Codex automatically. A session already open during installation retains its previous provider; use a fresh native session once connection is ready. This startup notice does not establish actual Gate, Router or Compact application; inspect recorded requests and never claim unobserved policies ran. See the Jev Gate skill for setup.' } };
  return {};
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
    const bridge = deps.env['JEV_CODEX_BRIDGE_URL'];
    const secret = deps.env['JEV_CODEX_BRIDGE_TOKEN'];
    const startup = (!bridge || !secret) && deps.env['JEV_CODEX_AUTO_CONNECT'] !== '0' && input['hook_event_name'] === 'SessionStart' && input['source'] === 'startup';
    const started = startup ? startedSession(input) : null;
    const provider = started?.['model_provider'];
    // Without start metadata (an ephemeral session has no transcript, or it is unreadable or another session's) the provider is unknown, never routed;
    // only an absent connection owner, read before this hook may start one, proves the session cannot have started connected. A live helper proves nothing.
    const owner = startup && !started ? connectionOwner(deps.env) : null;
    const routing = typeof provider === 'string' && provider !== PROVIDER ? { routed: false, model_provider: token(provider) }
      : owner === 'absent' ? { routed: false, model_provider: null } : owner ? { routed: 'unknown', model_provider: null } : undefined;
    const opened = (deps.openTrace ?? openTraceDir)(codexTraceDir(deps.env), deps.env);
    const recorded = handleCodexEvent(input, deps.env, opened.ok ? opened.writer : undefined, routing);
    if (!bridge || !secret) {
      if (deps.env['JEV_CODEX_AUTO_CONNECT'] === '0') return recorded;
      if (input['hook_event_name'] === 'SessionStart' && typeof input['model'] === 'string' && typeof input['cwd'] === 'string') await ensureConnection(dirname(dirname(fileURLToPath(import.meta.url))), deps.env);
      const policy = await connectionRequest(deps.env, '/hook', input, AbortSignal.timeout(4200));
      // The user sees these; the model does not. `codex exec` keeps its model and effort, so it needs no notice.
      const notice = routing?.routed === false ? { systemMessage: `Jev Gate: this session started ${routing.model_provider ? `on model provider ${JSON.stringify(routing.model_provider)} ` : ''}without the Jev Gate connection, so Router and Compact do not apply to it. Start a new session once the connection is ready.` }
        : routing ? { systemMessage: 'Jev Gate: Codex reported no usable start metadata for this session, so whether Router and Compact apply to it is unknown. Run doctor, then start a new session once the connection is ready.' }
        : started && started['originator'] !== 'codex_exec' ? { systemMessage: 'Jev Gate: Router may change the model and effort of this interactive session, including a model given with -m/--model; Codex reports no signal that separates it from config defaults. codex exec keeps its model and effort.' } : {};
      if (policy && Object.keys(policy).length) return { ...policy, ...notice };
      if (input['hook_event_name'] === 'SessionStart' && policy) return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Jev Gate native hooks and jev_agent dispatch are available. Follow the current Gate guidance and use jev_agent for owned dispatches. Router and Compact apply only when actual model requests pass through the local connection; a host already running before installation retains its previous provider until restarted. Native permissions and user constraints remain authoritative. Do not claim unobserved policies ran.' }, ...notice };
      return { ...recorded, ...notice };
    }
    const url = new URL(bridge);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return recorded;
    try {
      const response = await fetch(new URL('/hook', url), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(4200) });
      if (!response.ok) return recorded;
      const policy = record(await response.json());
      return policy && Object.keys(policy).length ? policy : recorded;
    } catch { return recorded; }
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
