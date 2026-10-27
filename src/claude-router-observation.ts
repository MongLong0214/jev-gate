import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routerObservation, ROUTER_OBSERVATION_WAIT_MS, type RouterObservation } from './router-observation.js';
import { normalizeUsage, usageCost } from './cost.js';
import { providerPrice } from './provider-prices.js';
import { recordingStatus } from './recording.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { subagentTranscriptPath } from './verify.js';

/** The session's main transcript, `<config>/projects/<project>/<session>.jsonl`. Hooks modules learn its path only from
 * classic events, and a plugin earlier in that chain can skip them (2.1.304: every routed result went unobserved), so the
 * session id finds it. A second match is ambiguous and reads nothing. */
export const transcriptOf = (session: string, env: NodeJS.ProcessEnv = process.env): string | null => {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(session)) return null;
  const projects = join(env['CLAUDE_CONFIG_DIR'] || join(env['HOME'] || homedir(), '.claude'), 'projects');
  try {
    const found = readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(projects, d.name, `${session}.jsonl`)).filter(p => existsSync(p));
    return found.length === 1 ? found[0]! : null;
  } catch { return null; }
};

/** Like claudeTerminal: no symlinks, regular files only, bounded tail, and no transcript text returned to the hook. */
export const readRouterObservation = (path: string, session: string, agent: string, since: number, raw: unknown, until = Infinity): RouterObservation | null => {
  if (!path || !session) return null;
  const file = agent ? subagentTranscriptPath(path, session, agent) : path;
  if (!file) return null;
  let fd: number | undefined;
  try {
    for (const dir of [dirname(file), dirname(dirname(file))]) if (lstatSync(dir).isSymbolicLink()) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd); if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - 1024 * 1024), buffer = Buffer.alloc(stat.size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return routerObservation(start ? text.slice(text.indexOf('\n') + 1) : text, session, agent, since, raw, until);
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
};

/** A late observation amends one existing result, retaining its identity and accounting multiplicity. */
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const readResult = (file: string, env: NodeJS.ProcessEnv): { text: string; record: Record<string, unknown>; raw: unknown; session: string; agent: string; since: number; until: number; model: string } | null => {
  let fd: number | undefined;
  try {
    const dir = resolve(env['JEV_GATE_TRACE_DIR'] ?? join(env['XDG_STATE_HOME'] || join(env['HOME'] || homedir(), '.local/state'), 'jev-gate/claude/traces'));
    if (dirname(file) !== dir || !/^mod_router-[0-9a-f-]{36}\.json$/.test(basename(file)) || !recordingStatus(env).enabled) return null;
    if (lstatSync(dir).isSymbolicLink() || lstatSync(dirname(dir)).isSymbolicLink()) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const text = readFileSync(fd, 'utf8'), record = object(JSON.parse(text));
    const u = object(record.accounting);
    if (record.phase !== 'mod_router' || !['root_result', 'child_result'].includes(String(record.event)) ||
      basename(file) !== `mod_router-${record.invocation_id}.json` || (typeof record.session_id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(record.session_id)) ||
      record.event === 'child_result' && (typeof record.agent_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.agent_id)) ||
      record.event === 'root_result' && record.agent_id != null || record.request_ref !== null ||
      typeof record.observed !== 'string' || u.coverage !== 'complete' ||
      typeof record.observation_since !== 'number' || !Number.isFinite(record.observation_since) || typeof record.observation_until !== 'number' || !Number.isFinite(record.observation_until) || record.observation_until < record.observation_since) return null;
    const raw = { model: record.observed, input_tokens: u.input, cache_read_input_tokens: u.read,
      cache_creation_input_tokens: u.write, output_tokens: u.output };
    if (normalizeUsage('claude', raw).coverage !== 'complete') return null;
    return { text, record, raw, session: record.session_id, agent: typeof record.agent_id === 'string' ? record.agent_id : '', since: record.observation_since, until: record.observation_until, model: record.observed };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
};

export const ROUTER_RECONCILE_MS = 10_000;
/** Runs outside the Function Hook's lifetime: Claude may not flush until that hook returns. Never calls a provider. */
export const reconcileRouterResult = async (file: string, env: NodeJS.ProcessEnv = process.env, waitMs = ROUTER_RECONCILE_MS): Promise<void> => {
  const source = readResult(file, env);
  if (!source) return;
  const { record, raw } = source;
  const deadline = Date.now() + waitMs;
  let observation: RouterObservation | null = null;
  do {
    if (!recordingStatus(env).enabled) return;
    const path = transcriptOf(source.session, env);
    if (path) observation = readRouterObservation(path, source.session, source.agent, source.since, raw, source.until);
    if (observation || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (true);
  // Another writer, removal, recording-off or a redirected file never authorizes replacing that record.
  if (readResult(file, env)?.text !== source.text) return;
  const updated: Record<string, unknown> = { ...record, observation_status: observation ? 'resolved' : 'unavailable', observation_reconciled_at: new Date().toISOString() };
  if (observation) {
    updated.observed_effort = observation.effort ?? 'unknown';
    updated.effort_evidence = observation.effort != null ? 'transcript_api_request' : 'unobserved';
    updated.request_ref = observation.request;
    updated.accounting = observation.usage;
    if ('cost' in record) {
      const u = observation.usage;
      updated.cost = usageCost(u, providerPrice('claude', source.model, u.input! + u.read! + u.write!));
    }
  }
  const tmp = join(dirname(file), `.${basename(file, '.json')}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(updated), { flag: 'wx', mode: 0o600 });
    if (readResult(file, env)?.text === source.text) renameSync(tmp, file);
  } finally { try { unlinkSync(tmp); } catch { /* renamed, or no temporary file */ } }
};

const isMain = (): boolean => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
if (isMain()) {
  const [session = '', agent = '', since = '', raw = 'null', until = 'Infinity'] = process.argv.slice(2);
  if (session === '--defer') {
    if (readResult(agent, process.env)) {
      const child = spawn(process.execPath, [process.argv[1]!, '--reconcile', agent], { detached: true, stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }).then(() => {
        child.unref(); process.stdout.write('{"started":true}');
      }, () => { process.stdout.write('{"started":false}'); });
    } else process.stdout.write('{"started":false}');
  } else if (session === '--reconcile') {
    await reconcileRouterResult(agent).catch(() => {});
  } else {
    try {
      const usage: unknown = JSON.parse(raw), deadline = Date.now() + ROUTER_OBSERVATION_WAIT_MS;
      // A new session's transcript file appears with its first rows, so it is looked up again only until it is found.
      let path: string | null = null;
      const read = (): RouterObservation | null => readRouterObservation((path ??= transcriptOf(session)) ?? '', session, agent, Number(since), usage, Number(until));
      let observation = read();
      // Claude queues transcript writes: the response can finish before its assistant row reaches disk. Bound the wait
      // within the adapter's process deadline; this reads metadata again and never repeats a model request.
      const observable = normalizeUsage('claude', usage).coverage === 'complete' &&
        typeof (usage as { model?: unknown } | null)?.model === 'string' && Number.isFinite(Number(since));
      while (!observation && observable && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
        observation = read();
      }
      process.stdout.write(JSON.stringify(observation));
    }
    catch { process.stdout.write('null'); }
  }
}
