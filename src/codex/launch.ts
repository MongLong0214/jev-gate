import { StringDecoder } from 'node:string_decoder';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { CodexRpc } from './rpc.js';
import { CodexPolicy } from './policy.js';
import { obj } from './source.js';
import { loadCodexPolicy } from './config.js';
import { extractCodexCompact, compactResponse } from './compact.js';
import { codexTraceDir } from '../codex-paths.js';
import { openTraceDir } from '../trace.js';
import type { Env } from '../config.js';

/** Only the official host's discovery for the same authenticated workspace may redirect its credentials. */
export const nativeWorkspaceUpstream = (result: unknown, accountId: string): { origin: string; override: string } | null => {
  const routing = obj(obj(result)?.['workspaceRouting']);
  if (!routing) return null;
  if (routing['chatgptAccountId'] !== accountId || typeof routing['backendOrigin'] !== 'string' || !['NO_CONSTRAINT', 'us', 'us_cr'].includes(String(routing['accountRoutingOverride']))) throw new Error('invalid native workspace routing');
  const origin = new URL(routing['backendOrigin']);
  if (origin.protocol !== 'https:' || !origin.hostname || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid native workspace routing');
  return { origin: origin.origin, override: String(routing['accountRoutingOverride']) };
};

const equal = (a: unknown, b: string): boolean => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const body = async (request: IncomingMessage, max: number): Promise<Buffer> => {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of request) { size += c.length; if (size > max) throw new Error('request too large'); chunks.push(Buffer.from(c)); }
  return Buffer.concat(chunks);
};
export interface CodexLaunchOptions {
  env: Env; cwd: string; serverArgs?: string[]; fetchImpl?: typeof fetch;
  bypassHookTrust?: boolean;
  nativeAuth?: boolean;
  profiles?: Record<string, string>;
  connection?: { token: string; marker: string; port: number; ready?: () => boolean; restart?: () => void };
}
/** Official App Server plus local transport. Persistent automatic connection settings are owned by connection.ts. */
export const startCodexSession = async (options: CodexLaunchOptions): Promise<{ url: string; token: string; policy: CodexPolicy; rpc: CodexRpc; close: () => Promise<void> }> => {
  const token = options.connection?.token ?? randomBytes(32).toString('hex');
  const marker = options.connection?.marker ?? `[jev-gate compact ${randomBytes(24).toString('hex')}] Produce a factual compaction summary of the preceding conversation.`;
  const config = loadCodexPolicy(options.env);
  const trace = openTraceDir(codexTraceDir(options.env));
  let child: ChildProcessWithoutNullStreams | undefined;
  let rpc: CodexRpc | undefined; let policy: CodexPolicy | undefined; let client: WebSocket | undefined;
  const proxyHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'x-jev-gate-session']);
  const requests = new Set<ReturnType<typeof httpRequest>>();
  const server = createServer(async (req, res) => {
    try {
      const path = req.url?.split('?')[0];
      if (options.connection && path === '/restart' && req.method === 'POST') {
        if (!equal(req.headers.authorization, `Bearer ${token}`)) { res.writeHead(401); res.end(); return; }
        res.writeHead(204); res.end(); setTimeout(() => options.connection?.restart?.(), 20); return;
      }
      if (options.connection && path === '/credentials' && req.method === 'POST') {
        const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
        const first = `Bearer ${token}.`;
        if (!equal(header.slice(0, first.length), first)) { res.writeHead(401); res.end(); return; }
        const key = Buffer.from(header.slice(first.length), 'base64url').toString('utf8');
        if (key.length > 8192 || !key || /[\r\n\0]/.test(key)) { res.writeHead(400); res.end(); return; }
        policy?.supplyKey(key); res.writeHead(204); res.end(); return;
      }
      if (options.connection && equal(req.headers.authorization, `Bearer ${token}`) && path === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ready: options.connection.ready?.() ?? !!policy })); return;
      }
      if (options.connection && path === '/agent' && req.method === 'POST') {
        if (!equal(req.headers.authorization, `Bearer ${token}`)) { res.writeHead(401); res.end(); return; }
        const input = obj(JSON.parse((await body(req, 2 * 1024 * 1024)).toString('utf8')));
        res.once('close', () => { if (!res.writableEnded && input) policy?.cancelCaller(input['meta']); });
        const output = input && policy ? await policy.dispatch(input['arguments'], input['meta']) : 'Native connection unavailable. No worker was started.';
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ output })); return;
      }
      if (req.url === '/hook' && req.method === 'POST') {
        if (!equal(req.headers.authorization, `Bearer ${token}`)) { res.writeHead(401); res.end(); return; }
        const input = obj(JSON.parse((await body(req, 2 * 1024 * 1024)).toString('utf8')));
        const disconnected = new AbortController();
        const abort = () => { if (!res.writableEnded) disconnected.abort(); };
        res.once('close', abort);
        const result = input && policy ? await (options.connection ? policy.externalHook(input, AbortSignal.any([disconnected.signal, AbortSignal.timeout(3900)])) : policy.nativeHook(input, AbortSignal.any([disconnected.signal, AbortSignal.timeout(3900)]))) : {};
        res.removeListener('close', abort);
        if (disconnected.signal.aborted) return;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (!equal(req.headers['x-jev-gate-session'], token)) { res.writeHead(401); res.end(); return; }
      if (!/^\/(responses(?:\/compact)?|models)(?:\?.*)?$/.test(req.url ?? '') || !['GET', 'POST'].includes(req.method ?? '')) { res.writeHead(404); res.end(); return; }
      const raw = await body(req, 32 * 1024 * 1024);
      let decoded = raw;
      if (req.headers['content-encoding'] === 'zstd') decoded = (createRequire(import.meta.url)('node:zlib') as { zstdDecompressSync: (b: Buffer, o: { maxOutputLength: number }) => Buffer }).zstdDecompressSync(raw, { maxOutputLength: 32 * 1024 * 1024 });
      const sessionId = policy?.requestSession(req.headers['x-codex-turn-metadata'], req.headers['session-id']) ?? null;
      let payload = raw;
      let modified = false;
      if (req.method === 'POST' && (path === '/responses' || path === '/responses/compact')) {
        if ((!sessionId || !policy?.hooksReady(sessionId)) && !options.connection) { res.writeHead(412); res.end('Trust the installed Jev Gate hooks in Codex /hooks before starting a managed session.'); return; }
        if (sessionId && policy) {
          const parsed = obj(JSON.parse(decoded.toString('utf8'))) ?? {};
          if (options.connection && path === '/responses' && !extractCodexCompact(parsed['input'], marker, config.compact.budgetChars).ok) {
            const cancelled = new AbortController(); res.once('close', () => { if (!res.writableEnded) cancelled.abort(); });
            const selected = await policy.externalRequest(sessionId, parsed, cancelled.signal);
            if (selected.stop) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.end(compactResponse(selected.stop)); return; }
            payload = Buffer.from(JSON.stringify(selected.request)); modified = true;
          } else policy.observeRequest(sessionId, parsed);
        }
      }
      if (config.compact.enabled && req.method === 'POST' && path === '/responses') {
        const parsed = obj(JSON.parse(decoded.toString('utf8')));
        const compact = extractCodexCompact(parsed?.['input'], marker, config.compact.budgetChars);
        if (compact.ok && sessionId && policy?.canCompact(sessionId)) {
          const session = sessionId;
          const run = `${Date.now()}-${randomBytes(4).toString('hex')}`;
          if (trace.ok) trace.writer.write('codex_compact', { host: 'codex', session_id: session, run_id: run, stage: 'selected', applied: false, before_bytes: compact.before, after_bytes: compact.after, summarizer_request: false });
          if (session) policy?.selectedCompact(session, compact.summary, run, compact.before, compact.after);
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.end(compactResponse(compact.summary)); return;
        }
      }
      // Authorization goes only to the fixed native OpenAI endpoints, or the explicit owner's compatible endpoint.
      const configured = options.env['JEV_CODEX_UPSTREAM'];
      const account = req.headers['chatgpt-account-id'];
      const routing = !configured && typeof account === 'string' ? nativeWorkspaceUpstream(await rpc!.request('account/read', { refreshToken: false }, 5000), account) : null;
      const base = new URL(configured ?? (account ? `${routing?.origin ?? 'https://chatgpt.com'}/backend-api/codex/` : 'https://api.openai.com/v1/'));
      if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('invalid upstream');
      base.pathname = base.pathname.replace(/\/$/, '') + req.url!.split('?')[0]; base.search = req.url!.includes('?') ? req.url!.slice(req.url!.indexOf('?')) : '';
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !proxyHeaders.has(k)));
      if (modified) delete headers['content-encoding'];
      if (routing) {
        delete headers['x-openai-account-routing-override'];
        if (routing.override !== 'NO_CONSTRAINT') headers['x-openai-account-routing-override'] = routing.override;
      }
      const upstream = (base.protocol === 'https:' ? httpsRequest : httpRequest)(base, { method: req.method, headers }, response => {
        const output = Object.fromEntries(Object.entries(response.headers).filter(([k]) => !['connection', 'transfer-encoding'].includes(k)));
        res.writeHead(response.statusCode ?? 502, output); response.pipe(res);
        if (options.connection && sessionId && response.statusCode === 200 && String(response.headers['content-type']).includes('text/event-stream')) {
          let buffer = ''; const decoder = new StringDecoder('utf8');
          response.on('data', chunk => {
            buffer += decoder.write(Buffer.from(chunk));
            if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { buffer = ''; return; }
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
              try { const value = obj(JSON.parse(data)); if (value?.['type'] === 'response.completed') policy?.observeUsage(sessionId, obj(value['response']) ?? {}); } catch { /* Unknown events are forwarded unchanged. */ }
            }
          });
        }
      });
      requests.add(upstream); upstream.once('close', () => requests.delete(upstream));
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      upstream.end(payload);
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/' || !equal(req.headers.authorization, `Bearer ${token}`) || client) { socket.destroy(); return; }
    ws.handleUpgrade(req, socket, head, c => { client = c; ws.emit('connection', c, req); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.connection?.port ?? 0, '127.0.0.1', () => resolve()); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('session listener unavailable');
  const base = `http://127.0.0.1:${address.port}`;
  const provider = ['-c', 'model_provider="jev-gate-native"', '-c', 'model_providers.jev-gate-native.name="Jev Gate / native Codex"', '-c', `model_providers.jev-gate-native.base_url="${base}"`,
    '-c', 'model_providers.jev-gate-native.wire_api="responses"', '-c', `model_providers.jev-gate-native.requires_openai_auth=${options.nativeAuth !== false}`, '-c', 'model_providers.jev-gate-native.supports_websockets=false',
    '-c', 'model_providers.jev-gate-native.env_http_headers={"x-jev-gate-session"="JEV_CODEX_BRIDGE_TOKEN"}', ...(config.compact.enabled ? ['-c', `compact_prompt=${JSON.stringify(marker)}`] : [])];
  child = spawn('codex', [...(options.bypassHookTrust ? ['--dangerously-bypass-hook-trust'] : []), 'app-server', '--stdio', ...(options.serverArgs ?? []), ...provider], { cwd: options.cwd,
    env: { ...options.env, JEV_CODEX_BRIDGE_URL: base, JEV_CODEX_BRIDGE_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  rpc = new CodexRpc(child.stdout, child.stdin);
  policy = new CodexPolicy(rpc, options.env, options.fetchImpl, options.profiles, options.bypassHookTrust);
  child.stderr.pipe(process.stderr, { end: false });
  rpc.emit = message => { if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); };
  ws.on('connection', c => {
    c.on('message', (data, binary) => {
      if (binary) { c.close(1003); return; }
      try { const m = obj(JSON.parse(data.toString())); if (!m) throw new Error('invalid message'); void policy!.client(m).catch(() => {
        if ('id' in m && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ id: m['id'], error: { code: -32600, message: 'Jev Codex session rejected the request. Enable exactly one Jev Gate installation in /plugins and trust its hooks in /hooks; check policy configuration.' } }));
      }); } catch { c.close(1003); }
    });
    c.once('close', () => { policy?.close(); rpc?.close(); child?.kill('SIGTERM'); });
  });
  child.once('error', () => { rpc?.close(); client?.close(1011); });
  child.once('exit', () => { rpc?.close(); client?.close(1011); });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    policy?.close(); rpc?.close(); client?.terminate(); for (const r of requests) r.destroy(); child?.kill('SIGTERM');
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); ws.close();
  })();
  try {
    if (options.connection) {
      await rpc.request('initialize', { clientInfo: { name: 'jev-gate-native-connection', version: '0.7.1' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized' }); await policy.initialize();
    }
    return { url: `ws://127.0.0.1:${address.port}`, token, policy, rpc, close };
  } catch (error) { await close(); throw error; }
};

export const nativeLaunchOptions = (args: string[], originalCwd: string): { cwd: string; serverArgs: string[] } => {
  if (args.some(a => /^(--remote(?:=|$)|--remote-auth-token-env(?:=|$)|--oss$|--local-provider(?:=|$)|--profile(?:=|$)|-p$|--add-dir(?:=|$)|--worktree$)/.test(a)) || ['exec', 'e', 'review', 'app-server', 'login', 'logout', 'plugin', 'mcp', 'cloud', 'app', 'agents'].includes(args[0] ?? '')) throw new Error('This launcher requires native terminal arguments. Provider, profile, worktree and additional-root options must be configured on the native host before connecting.');
  const serverArgs: string[] = [];
  const overrides: Record<string, string> = { '-m': 'model', '--model': 'model', '-s': 'sandbox_mode', '--sandbox': 'sandbox_mode', '-a': 'approval_policy', '--ask-for-approval': 'approval_policy' };
  let cwd = originalCwd;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (['-c', '--config', '--enable', '--disable'].includes(a)) { if (!args[i + 1]) throw new Error('missing CLI value'); serverArgs.push(a, args[++i]!); }
    else if (overrides[a]) { if (!args[i + 1]) throw new Error('missing CLI value'); serverArgs.push('-c', `${overrides[a]}=${JSON.stringify(args[++i])}`); }
    else if (['-C', '--cd'].includes(a)) { if (!args[i + 1]) throw new Error('missing cwd'); cwd = resolve(originalCwd, args[++i]!); }
    else if (a.startsWith('--config=')) serverArgs.push('-c', a.slice('--config='.length));
    else if (a.startsWith('--model=')) serverArgs.push('-c', `model=${JSON.stringify(a.slice('--model='.length))}`);
    else if (a.startsWith('--sandbox=')) serverArgs.push('-c', `sandbox_mode=${JSON.stringify(a.slice('--sandbox='.length))}`);
    else if (a.startsWith('--ask-for-approval=')) serverArgs.push('-c', `approval_policy=${JSON.stringify(a.slice('--ask-for-approval='.length))}`);
    else if (a.startsWith('--cd=')) cwd = resolve(originalCwd, a.slice('--cd='.length));
    else if (a === '--dangerously-bypass-approvals-and-sandbox') serverArgs.push('-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"');
    else if (a === '--approve-for-me') serverArgs.push('-c', 'approvals_reviewer="auto_review"', '-c', 'sandbox_mode="workspace-write"');
    else if (a === '--search') serverArgs.push('-c', 'web_search="live"');
    else if (a === '--strict-config') serverArgs.push(a);
  }
  return { cwd, serverArgs };
};
export const launchCodex = async (args: string[], env: Env): Promise<number> => {
  const { cwd, serverArgs } = nativeLaunchOptions(args, process.cwd());
  const session = await startCodexSession({ env, cwd, serverArgs, bypassHookTrust: args.includes('--dangerously-bypass-hook-trust') });
  const child = spawn('codex', ['--remote', session.url, '--remote-auth-token-env', 'JEV_CODEX_BRIDGE_TOKEN', ...args], { cwd, env: { ...env, JEV_CODEX_BRIDGE_TOKEN: session.token }, stdio: 'inherit' });
  const stop = (): void => { child.kill('SIGTERM'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try { return await new Promise<number>(resolve => { child.once('exit', code => resolve(code ?? 1)); child.once('error', () => resolve(1)); }); }
  finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); await session.close(); }
};
