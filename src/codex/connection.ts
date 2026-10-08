import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { startCodexSession } from './launch.js';
import { obj, type Obj } from './source.js';
import type { Env } from '../config.js';
import type { CodexRpc } from './rpc.js';
import { resolveApiKey, withApiKey } from '../credentials.js';

const PROVIDER = 'jev-gate-native';
export interface Connection { version: 1; pid: number; port: number; token: string; marker: string; root: string; original: Obj; installed: Obj }
const home = (env: Env): string => {
  const path = env['CODEX_HOME'] ?? join(env['HOME'] ?? homedir(), '.codex');
  if (!isAbsolute(path)) throw new Error('Codex home must be absolute');
  return path;
};
const directory = (env: Env): string => join(home(env), 'jev-gate', 'connection');
const statePath = (env: Env): string => join(directory(env), 'owner.json');
const privateDir = (env: Env): void => {
  for (const path of [join(home(env), 'jev-gate'), directory(env)]) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error('connection directory must be private');
  }
};
const read = (env: Env): Connection | null => {
  try {
    const path = statePath(env); const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || stat.mode & 0o077) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: Obj | null; try { value = obj(JSON.parse(readFileSync(fd, 'utf8'))); } finally { closeSync(fd); }
    if (value?.['version'] !== 1 || !Number.isSafeInteger(value['pid']) || Number(value['pid']) < 1 || !Number.isSafeInteger(value['port']) || Number(value['port']) < 1 || Number(value['port']) > 65535 || typeof value['token'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['token']) || typeof value['marker'] !== 'string' || typeof value['root'] !== 'string' || !isAbsolute(value['root']) || !obj(value['original']) || !obj(value['installed'])) return null;
    return value as unknown as Connection;
  } catch { return null; }
};
const write = (env: Env, value: Connection): void => {
  privateDir(env); const path = statePath(env); const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } finally { rmSync(tmp, { force: true }); }
};
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : obj(v) ? Object.fromEntries(Object.entries(v as Obj).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)])) : v ?? null;
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const valueAt = (config: Obj, key: string): unknown => key.split('.').reduce<unknown>((v, part) => obj(v)?.[part], config);
const userConfig = async (rpc: CodexRpc): Promise<{ config: Obj; path: string; version: string }> => {
  const result = await rpc.request('config/read', { includeLayers: true });
  const layers = Array.isArray(result['layers']) ? result['layers'] : [];
  const layer = layers.map(obj).find(v => obj(v?.['name'])?.['type'] === 'user' && !obj(v?.['name'])?.['profile']);
  const path = obj(layer?.['name'])?.['file'];
  if (!layer || typeof path !== 'string' || typeof layer['version'] !== 'string' || !obj(layer['config'])) throw new Error('native user config unavailable');
  return { config: obj(layer['config'])!, path, version: layer['version'] };
};

/** Codex's own revision-checked writer preserves unrelated values and comments. No key or trust grant is written. */
export const installConnection = async (rpc: CodexRpc, connection: Connection, env: Env): Promise<void> => {
  const user = await userConfig(rpc);
  const current = user.config['model_provider'];
  const previous = read(env);
  if (current !== undefined && current !== 'openai' && current !== PROVIDER) throw new Error('custom provider is preserved');
  if (current === PROVIDER && !previous) throw new Error('provider ownership unavailable');
  const values: Obj = {
    model_provider: PROVIDER,
    [`model_providers.${PROVIDER}`]: { name: 'Jev Gate / native Codex', base_url: `http://127.0.0.1:${connection.port}`, wire_api: 'responses', requires_openai_auth: env['JEV_CODEX_CONNECTION_TEST_NO_AUTH'] !== '1', supports_websockets: false, http_headers: { 'x-jev-gate-session': connection.token } },
    compact_prompt: connection.marker,
  };
  for (const key of Object.keys(values)) {
    const actual = valueAt(user.config, key);
    if (previous && key in previous.installed && !equal(actual, previous.installed[key]) && !equal(actual, previous.original[key])) throw new Error('owner modified the connection settings');
    connection.original[key] = previous && Object.hasOwn(previous.original, key) ? previous.original[key] : actual ?? null;
  }
  connection.installed = values;
  write(env, connection); // Recovery facts precede the transaction.
  await rpc.request('config/batchWrite', { filePath: user.path, expectedVersion: user.version, reloadUserConfig: false, edits: Object.entries(values).map(([keyPath, value]) => ({ keyPath, value, mergeStrategy: 'replace' })) });
};
export const restoreConnection = async (rpc: CodexRpc, env: Env): Promise<void> => {
  const state = read(env); if (!state) return;
  const user = await userConfig(rpc);
  const edits = Object.entries(state.installed).filter(([key, value]) => equal(valueAt(user.config, key), value)).map(([keyPath]) => ({ keyPath, value: state.original[keyPath] ?? null, mergeStrategy: 'replace' }));
  if (edits.length) await rpc.request('config/batchWrite', { filePath: user.path, expectedVersion: user.version, reloadUserConfig: false, edits });
};

export const connectionRequest = async (env: Env, path: '/hook' | '/agent', input: Obj, signal?: AbortSignal): Promise<Obj | null> => {
  const state = read(env); if (!state) return null;
  try {
    await provision(state, env);
    const response = await fetch(`http://127.0.0.1:${state.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input), ...(signal ? { signal } : {}) });
    return response.ok ? obj(await response.json()) : null;
  } catch { return null; }
};
const healthy = async (state: Connection): Promise<boolean> => {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, { headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(250) });
    return response.ok && obj(await response.json())?.['ready'] === true;
  } catch { return false; }
};
/** Doctor never provisions credentials, starts a helper, edits config or grants hook trust. */
export const connectionDiagnostic = async (env: Env): Promise<{ state: 'disabled' | 'absent' | 'invalid' | 'ready' | 'unreachable'; version: string | null }> => {
  if (!enabled(env)) return { state: 'disabled', version: null };
  const state = read(env);
  if (!state) return { state: existsSync(statePath(env)) ? 'invalid' : 'absent', version: null };
  return { state: await healthy(state) ? 'ready' : 'unreachable', version: (await import('../release-info.js')).packageVersion(state.root, 'codex') };
};
const enabled = (env: Env): boolean => env['JEV_CODEX_AUTO_CONNECT'] !== '0' && env['JEV_CODEX_ENABLED'] !== '0' && !env['JEV_CODEX_BRIDGE_URL'];
const packageVersion = (root: string): number => {
  try { const v = obj(JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8')))?.['version']; const m = typeof v === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(v); return m ? Number(m[1]) * 1_000_000 + Number(m[2]) * 1000 + Number(m[3]) : -1; }
  catch { return -1; }
};
let provisioned: string | null = null;
const provision = async (state: Connection, env: Env): Promise<void> => {
  const key = resolveApiKey(env);
  if (!key || provisioned === `${state.pid}:${key}`) return;
  const response = await fetch(`http://127.0.0.1:${state.port}/credentials`, { method: 'POST', headers: { authorization: `Bearer ${state.token}.${Buffer.from(key).toString('base64url')}` }, signal: AbortSignal.timeout(500) });
  if (response.ok) provisioned = `${state.pid}:${key}`;
};
/** Called by the installed MCP and trusted startup hook; the user keeps using the ordinary native host. */
export const ensureConnection = async (root: string, env: Env): Promise<boolean> => {
  if (!enabled(env) || !existsSync(join(root, '.codex-plugin', 'plugin.json'))) return false;
  const previous = read(env);
  if (previous && await healthy(previous)) {
    if (previous.root === root || packageVersion(root) <= packageVersion(previous.root)) { await provision(previous, env); return true; }
    // Only a newer installed package can replace an older helper. Old MCP clients cannot downgrade it.
    try { await fetch(`http://127.0.0.1:${previous.port}/restart`, { method: 'POST', headers: { authorization: `Bearer ${previous.token}` }, signal: AbortSignal.timeout(500) }); }
    catch { return false; }
    return false; // The next supervisor/startup attempt starts the new package after the old lock is released.
  }
  const child = spawn(process.execPath, [join(root, 'dist', 'cli.mjs'), 'connection-serve'], { cwd: root, env, detached: true, stdio: 'ignore' });
  child.on('error', () => undefined); child.unref();
  const until = Date.now() + 3200;
  do {
    const state = read(env); if (state && await healthy(state)) { await provision(state, env); return true; }
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  } while (Date.now() < until);
  return false;
};

/** One local helper per Codex home; active MCP clients restart it if it exits. It owns no UI or model harness. */
export const serveConnection = async (root: string, env: Env): Promise<void> => {
  env = withApiKey(env);
  privateDir(env); const lock = join(directory(env), 'service.lock');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch {
    try {
      const stat = lstatSync(lock); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) return;
      let pid = 0;
      try { const fd = openSync(join(lock, 'pid'), constants.O_RDONLY | constants.O_NOFOLLOW); try { const raw = readFileSync(fd, 'utf8'); if (raw.length < 20) pid = Number(raw); } finally { closeSync(fd); } }
      catch { if (Date.now() - stat.mtimeMs < 5000) return; }
      if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return; } }
      else if (Date.now() - stat.mtimeMs < 5000) return;
      rmSync(lock, { recursive: true }); mkdirSync(lock, { mode: 0o700 });
    } catch { return; }
  }
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' });
  const previous = read(env);
  const state: Connection = { version: 1, pid: process.pid, port: previous?.port ?? 0, token: previous?.token ?? randomBytes(32).toString('hex'), marker: previous?.marker ?? `[jev-gate compact ${randomBytes(24).toString('hex')}] Produce a factual compaction summary of the preceding conversation.`, root, original: {}, installed: {} };
  let session: Awaited<ReturnType<typeof startCodexSession>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closing = false;
  let ready = false;
  const close = async (): Promise<void> => { if (closing) return; closing = true; if (timer) clearInterval(timer); await session?.close(); rmSync(lock, { recursive: true, force: true }); };
  const installedPlugins = async (): Promise<number> => {
    const result = await session!.rpc.request('plugin/installed', {}, 5000);
    const user = await userConfig(session!.rpc);
    const plugins = obj(user.config['plugins']);
    const enabledPlugins = (Array.isArray(result['marketplaces']) ? result['marketplaces'] : []).flatMap(m => Array.isArray(obj(m)?.['plugins']) ? obj(m)!['plugins'] as unknown[] : []).map(obj).filter(plugin => {
      const setting = obj(plugins?.[String(plugin?.['id'])]);
      return plugin?.['name'] === 'jev-gate' && plugin['installed'] === true && plugin['enabled'] === true && setting?.['enabled'] !== false;
    });
    if (enabledPlugins.length !== 1) return 0;
    const plugin = enabledPlugins[0]!;
    const version = obj(JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8')))?.['version'];
    return plugin['localVersion'] === null || plugin['localVersion'] === undefined || plugin['localVersion'] === version ? 1 : 0;
  };
  try {
    session = await startCodexSession({ env, cwd: home(env), ...(env['JEV_CODEX_CONNECTION_TEST_NO_AUTH'] === '1' ? { nativeAuth: false } : {}), connection: { token: state.token, marker: state.marker, port: state.port, ready: () => ready, restart: () => { void close(); } } });
    state.port = Number(new URL(session.url).port);
    const user = await userConfig(session.rpc);
    if (!env['JEV_CODEX_UPSTREAM']) {
      const upstream = env['OPENAI_BASE_URL'] ?? user.config['openai_base_url'];
      if (typeof upstream === 'string') env['JEV_CODEX_UPSTREAM'] = upstream;
    }
    if (await installedPlugins() !== 1) throw new Error('one enabled native installation required');
    await installConnection(session.rpc, state, env);
    write(env, state);
    ready = true;
    const stop = (): void => { void close(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    let checking = false;
    timer = setInterval(() => {
      if (checking || closing) return; checking = true;
      void (async () => {
        if (!existsSync(join(root, '.codex-plugin', 'plugin.json')) || await installedPlugins() !== 1) { await restoreConnection(session!.rpc, env); await close(); }
      })().catch(() => undefined).finally(() => { checking = false; });
    }, 5000);
    await new Promise<void>(resolve => { session!.rpc.onClose = () => { void close().finally(resolve); }; });
  } catch { if (session) try { await restoreConnection(session.rpc, env); } catch { /* Never rewrite without native revision checks. */ } await close(); }
};
