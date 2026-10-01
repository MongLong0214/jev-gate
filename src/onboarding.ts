import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { closeSync, constants, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from './config.js';
import { credentialsDir, privateDirectory, readPrivateJson, resolveApiKey, saveApiKey, validApiKey, writePrivateJson } from './credentials.js';

const escape = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const page = (nonce: string, note: string): string => `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jev Gate</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#10151b;color:#eef2f6;font:17px system-ui;display:grid;place-items:center;min-height:100vh;padding:24px}main{width:min(100%,520px)}h1{font-size:32px}p{line-height:1.65;color:#b8c4d2}label{display:block;margin-top:28px}input,button{width:100%;padding:14px;margin-top:12px;border-radius:8px;font:inherit}input{background:#1e2834;color:white;border:1px solid #4a5c70}button{background:#82e4c4;color:#10261e;border:0;cursor:pointer}small{display:block;color:#9baebe;margin-top:18px;line-height:1.6}#status{min-height:28px}</style>
<main><h1>Jev Gate</h1><p>API 키를 한 번 입력하면 Claude Code와 Codex에서 함께 사용합니다.<br>Enter your Jev API key once for Claude Code and Codex.</p><form><label for="key">Jev API key</label><input id="key" type="password" autocomplete="off" required minlength="8" maxlength="1024"><button>저장 / Save</button></form><p id="status" role="status"></p><small>${escape(note)}</small><small>키는 이 컴퓨터의 사용자 전용 파일에 저장됩니다. Jev 판단 요청은 작업 내용이나 선택된 소스 일부를 TypeSafe로 보낼 수 있습니다. 키를 저장하는 과정에서는 API를 호출하지 않습니다.<br>The key stays in a private local file. Jev judgments can send task content or selected source to TypeSafe. Saving does not call the API or verify account access.</small></main>
<script nonce="${nonce}">document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const input=document.querySelector('input'),button=document.querySelector('button'),status=document.querySelector('#status');button.disabled=true;try{const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({apiKey:input.value})});input.value='';status.textContent=r.ok?'키가 저장되었습니다. 이 창을 닫아도 됩니다. / Key saved. You can close this window.':'저장하지 못했습니다. 키 형식과 로컬 파일 권한을 확인하세요. / Could not save. Check key format and local file permissions.';if(r.ok)button.textContent='저장됨 / Saved';else button.disabled=false}catch{status.textContent='호스트를 다시 열면 입력 화면이 다시 연결됩니다. / Reopen your coding host to reconnect.';button.disabled=false}});</script></html>`;

export interface Onboarding { url: string; close: () => Promise<void> }
export const openSetupBrowser = (url: string): void => {
  const argv = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url];
  const child = spawn(argv[0]!, argv.slice(1), { stdio: 'ignore', detached: true });
  child.on('error', () => undefined); child.unref();
};

/** Lives inside the existing MCP process. No extra daemon, remote form, key in a URL, or model-visible tool. */
export const startOnboarding = async (env: Env, options: { note?: string; open?: (url: string) => void } = {}): Promise<Onboarding | null> => {
  if (resolveApiKey(env) || env['JEV_GATE_ONBOARDING'] === '0') return null;
  // An invalid explicit value is an owner choice, not permission to replace it with a stored key.
  if (['TYPESAFE_API_KEY', 'CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY'].some(k => env[k]?.trim())) return null;
  let dir: string;
  try { dir = credentialsDir(env); privateDirectory(dir); } catch { return null; }
  const ownerPath = join(dir, 'setup.json'); const lock = join(dir, 'setup.lock');
  let fd: number | undefined;
  let server: Server | undefined;
  try {
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const stat = lstatSync(lock);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 32) return null;
      const pid = Number(readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
      try { process.kill(pid, 0); return null; }
      catch (dead) { if ((dead as NodeJS.ErrnoException).code !== 'ESRCH') return null; }
      rmSync(lock); fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    }
    writeFileSync(fd, String(process.pid));
    const owner = readPrivateJson(ownerPath);
    if (typeof owner?.['port'] === 'number' && Number.isInteger(owner['port']) && owner['port'] > 0 && owner['port'] <= 65535 && typeof owner['token'] === 'string' && /^[a-f0-9]{64}$/.test(owner['token'])) {
      const url = `http://127.0.0.1:${owner['port']}/${owner['token']}`;
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(300) });
        if (r.ok && await r.text() === 'jev-gate-setup') return { url, close: async () => undefined };
      } catch { /* A stopped/crashed MCP is replaced by this one. */ }
    }
    const token = randomBytes(32).toString('hex'); const nonce = randomBytes(18).toString('base64');
    let origin = '';
    server = createServer(async (req, res) => {
      res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
      if (req.headers.host !== origin.slice(7) || req.url !== `/${token}` && req.url !== `/${token}/health`) { res.writeHead(404); res.end(); return; }
      if (req.method === 'GET' && req.url.endsWith('/health')) { res.end('jev-gate-setup'); return; }
      if (req.method === 'GET') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page(nonce, options.note ?? 'Native hook trust and session loading remain controlled by your coding host.')); return; }
      if (req.method !== 'POST' || req.url !== `/${token}` || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') { res.writeHead(403); res.end(); return; }
      try {
        let body = ''; let bytes = 0;
        for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > 4096) { res.writeHead(413); res.end(); return; } body += String(chunk); }
        const value: unknown = JSON.parse(body);
        const key = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)['apiKey'] : undefined;
        if (!validApiKey(key)) { res.writeHead(400); res.end(); return; }
        saveApiKey(env, key); res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
    server.requestTimeout = 5000; server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port; origin = `http://127.0.0.1:${port}`;
    writePrivateJson(ownerPath, { pid: process.pid, port, token });
    const url = `${origin}/${token}`;
    try { if (env['JEV_GATE_NO_BROWSER'] !== '1') (options.open ?? openSetupBrowser)(url); } catch { /* A headless host still gets the local URL on stderr. */ }
    const owned = server;
    return { url, close: async () => {
      if (readPrivateJson(ownerPath)?.['token'] === token) rmSync(ownerPath, { force: true });
      owned.closeAllConnections(); await new Promise<void>(resolve => owned.close(() => resolve()));
    } };
  } catch { server?.close(); return null; }
  finally { if (fd !== undefined) { closeSync(fd); rmSync(lock, { force: true }); } }
};
