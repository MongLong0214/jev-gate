import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexTraceDir } from '../codex-paths.js';
import { openTraceDir, type TraceWriter } from '../trace.js';
import { looksSecret } from '../outbound-text.js';
import { PROVIDER, connectionOwner, connectionRequest, ensureConnection, helperRequest, recordConnectionFailure, type ConnectionFailure } from './connection.js';
import { toolOutcome } from './tool-outcome.js';
export { toolOutcome } from './tool-outcome.js';

type Rec = Record<string, unknown>;
const record = (v: unknown): Rec | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null;
// Metadata identifiers reject even truncated/embedded sk- fragments. Prose screening keeps prefix mentions and task-id usable.
const token = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9_.:/+@-]{1,160}$/.test(v) && !looksSecret(v) && !v.toLowerCase().includes('sk-') ? v : null;
const EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'PreCompact', 'PostCompact']);
const LIMIT = 2 * 1024 * 1024;

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
    ...(['PreCompact', 'PostCompact'].includes(event) ? { trigger: ['manual', 'auto'].includes(String(input['trigger'])) ? input['trigger'] : null } : {}),
    ...toolOutcome(input['tool_response']),
    interrupted: event === 'Interrupt',
    // Start metadata names the historical provider, not the loaded inference endpoint.
    ...routing,
  };
  const eventRecord = trace?.write('codex_event', base);
  if (!eventRecord || !eventRecord.ok && eventRecord.error !== 'recording_disabled') return {};
  if (event === 'SessionStart' && env['JEV_CODEX_BRIDGE_URL']) return { hookSpecificOutput: { hookEventName: event, additionalContext:
    'Jev Gate is connected to the native Codex session adapter. Gate A/B and contract acceptance use the shared policies; Router uses official turn settings. Follow the current turn guidance and use jev_agent for owned dispatches. Native permissions and the user request remain authoritative. Do not claim unobserved policies or savings ran.' } };
  if (event === 'SessionStart') return { hookSpecificOutput: { hookEventName: event, additionalContext:
    'Jev Gate native Codex plugin: hooks record lifecycle metadata. The installed plugin connects ordinary native Codex automatically. A session already open during installation retains its previous provider; use a fresh native session once connection is ready. This startup notice does not establish actual Gate or Router application; inspect recorded requests and never claim unobserved policies ran. See the Jev Gate skill for setup.' } };
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
  const startedAt = performance.now();
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
    // Native hooks allow 3s for termination events and 5s otherwise. Leave 800ms for
    // process startup and stdout, and share the remaining budget across every await.
    const budget = input['hook_event_name'] === 'SessionEnd' || input['hook_event_name'] === 'Interrupt' ? 2200 : 4200;
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(budget - (performance.now() - startedAt))));
    const bridge = deps.env['JEV_CODEX_BRIDGE_URL'];
    const secret = deps.env['JEV_CODEX_BRIDGE_TOKEN'];
    const startup = (!bridge || !secret) && deps.env['JEV_CODEX_AUTO_CONNECT'] !== '0' && input['hook_event_name'] === 'SessionStart' && input['source'] === 'startup';
    const started = startup ? startedSession(input) : null;
    const provider = started?.['model_provider'];
    // Built-in openai can use either endpoint, and a resumed rollout can name an
    // earlier provider. Only actual proxy requests prove routing.
    const owner = startup ? connectionOwner(deps.env) : null;
    const routing = startup && (provider !== PROVIDER || !started)
      ? { routed: owner === 'absent' ? false : 'unknown', model_provider: token(provider) } : undefined;
    const opened = (deps.openTrace ?? openTraceDir)(codexTraceDir(deps.env), deps.env);
    const recorded = handleCodexEvent(input, deps.env, opened.ok ? opened.writer : undefined, routing);
    // The user sees these; the model does not. `codex exec` keeps its model and effort, so it needs no notice.
    const notice = routing?.routed === false ? { systemMessage: `Jev Gate: this session started ${routing.model_provider ? `on model provider ${JSON.stringify(routing.model_provider)} ` : ''}without the Jev Gate connection, so Router does not apply to it. Start a new session once the connection is ready.` }
      : routing ? { systemMessage: 'Jev Gate: whether this session loaded the connection is unknown until a model request is observed. Start metadata and a running helper do not establish Router application.' }
      : started && started['originator'] !== 'codex_exec' ? { systemMessage: 'Jev Gate: Router may change the model and effort of this interactive session, including a model given with -m/--model; Codex reports no signal that separates it from config defaults. codex exec keeps its model and effort.' } : {};
    const automatic = !bridge || !secret;
    if (automatic) {
      if (deps.env['JEV_CODEX_AUTO_CONNECT'] === '0') return recorded;
      if (input['hook_event_name'] === 'SessionStart' && typeof input['model'] === 'string' && typeof input['cwd'] === 'string') await ensureConnection(dirname(dirname(fileURLToPath(import.meta.url))), deps.env, signal);
    } else {
      const url = new URL(bridge);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return recorded;
    }
    const reply = automatic ? await connectionRequest(deps.env, '/hook', input, signal) : await helperRequest(new URL('/hook', bridge).href, secret, input, signal);
    if (!reply.ok) {
      if (opened.ok) recordOnce(codexTraceDir(deps.env), opened.writer, reply.reason, {
        session_id: token(input['session_id']), prompt_id: token(input['turn_id']), tool_use_id: token(input['tool_use_id']),
        event: token(input['hook_event_name']), tool_name: token(input['tool_name']), connection_stage: reply.stage,
        elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)), budget_ms: budget,
        ...(reply.status !== undefined ? { connection_status: reply.status } : {}),
      });
      return { ...recorded, ...notice };
    }
    if (Object.keys(reply.value).length) return { ...reply.value, ...notice };
    if (automatic && input['hook_event_name'] === 'SessionStart') return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Jev Gate native hooks and jev_agent dispatch are available. Follow the current Gate guidance and use jev_agent for owned dispatches. Router applies only when actual model requests pass through the local connection; a host already running before installation retains its previous endpoint until restarted. Native permissions and user constraints remain authoritative. Do not claim unobserved policies ran.' }, ...notice };
    return { ...recorded, ...notice };
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
