import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexTraceDir } from '../codex-paths.js';
import { openTraceDir, type TraceWriter } from '../trace.js';
import { foldCodexOutput } from './output.js';
import { connectionRequest, ensureConnection } from './connection.js';

type Rec = Record<string, unknown>;
const record = (v: unknown): Rec | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null;
const token = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9_.:/+@-]{1,160}$/.test(v) && !/(sk-|jv_live_)/i.test(v) ? v : null;
const EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt']);
const LIMIT = 2 * 1024 * 1024;

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
  const response = record(input['tool_response']);
  const base = {
    host: 'codex', mode: 'native', managed: !!env['JEV_CODEX_BRIDGE_URL'], event, session_id: session,
    prompt_id: token(input['turn_id']), tool_use_id: token(input['tool_use_id']),
    tool_name: tool, agent_id: token(input['agent_id']), agent_type: token(input['agent_type']),
    // The hook's model is the emitting session's model. It is never promoted to a spawned child's model.
    model: token(input['model']),
    exit_code: Number.isSafeInteger(response?.['exit_code']) ? response!['exit_code'] : null,
    interrupted: event === 'Interrupt',
  };
  if (!trace?.write('codex_event', base).ok) return {};
  if (event === 'PostToolUse' && tool === 'Bash' && env['JEV_CODEX_OUTPUT'] !== 'off') {
    const folded = foldCodexOutput(record(input['tool_input'])?.['command'], input['tool_response']);
    // Unrelated commands do not create a misleading Output run.
    if (!folded.applied && folded.reason === 'command') return {};
    const recorded = trace.write('codex_output', { ...base, applied: folded.applied, ...(folded.applied
      ? { before_bytes: folded.before, after_bytes: folded.after, runs: folded.runs }
      : { reason: folded.reason }) });
    if (!recorded.ok) return {};
    // Native PostToolUse replaces the completed tool result with stopReason and continues the model.
    if (folded.applied) return { continue: false, stopReason: folded.text };
  }
  if (event === 'SessionStart' && env['JEV_CODEX_BRIDGE_URL']) return { hookSpecificOutput: { hookEventName: event, additionalContext:
    'Jev Gate is connected to the native Codex session adapter. Gate A/B, plans, contract acceptance, root guard and Lean use the shared policies; Router uses official turn settings; Compact uses the native compaction lifecycle. Follow the current turn guidance and use jev_agent for owned dispatches. Native permissions and the user request remain authoritative. Do not claim unobserved policies or savings ran.' } };
  if (event === 'SessionStart') return { hookSpecificOutput: { hookEventName: event, additionalContext:
    'Jev Gate native Codex plugin: jev_evidence provides repository evidence and hooks record lifecycle metadata and fold complete passing Vitest logs. The installed plugin connects ordinary native Codex automatically. A session already open during installation retains its previous provider; use a fresh native session once connection is ready. This startup notice does not establish actual Gate, Lean, Router or Compact application; inspect recorded requests and never claim unobserved policies ran. See the Jev Gate skill for setup.' } };
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
    const opened = (deps.openTrace ?? openTraceDir)(codexTraceDir(deps.env));
    const recorded = handleCodexEvent(input, deps.env, opened.ok ? opened.writer : undefined);
    const bridge = deps.env['JEV_CODEX_BRIDGE_URL'];
    const secret = deps.env['JEV_CODEX_BRIDGE_TOKEN'];
    if (!bridge || !secret) {
      if (deps.env['JEV_CODEX_AUTO_CONNECT'] === '0') return recorded;
      if (input['hook_event_name'] === 'SessionStart' && typeof input['model'] === 'string' && typeof input['cwd'] === 'string') await ensureConnection(dirname(dirname(fileURLToPath(import.meta.url))), deps.env);
      const policy = await connectionRequest(deps.env, '/hook', input, AbortSignal.timeout(4200));
      if (policy && Object.keys(policy).length) return policy;
      if (input['hook_event_name'] === 'SessionStart' && policy) return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Jev Gate native hooks and jev_agent dispatch are available. Follow the current Gate or Lean guidance and use jev_agent for owned dispatches. Router and Compact apply only when actual model requests pass through the local connection; a host already running before installation retains its previous provider until restarted. Native permissions and user constraints remain authoritative. Do not claim unobserved policies ran.' } };
      return recorded;
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
