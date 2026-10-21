import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexRpc } from '../../src/codex/rpc.js';
import { installConnection, restoreConnection } from '../../src/codex/connection.js';
import { startCodexSession } from '../../src/codex/launch.js';
import type { Obj } from '../../src/codex/source.js';

describe.skipIf(process.env['JEV_CODEX_E2E'] !== '1')('native history with a built-in endpoint (#304)', () => {
  it('lists both provider histories through the native API and resumes each by ID through the new endpoint', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'jev-native-history-'));
    const home = join(temp, 'home'); mkdirSync(home);
    const upstream = createServer(async (req, res) => {
      for await (const _ of req) { /* Local scripted inference only. */ }
      if (req.method === 'GET') { res.end('{"models":[]}'); return; }
      const item = { type: 'message', id: 'msg_history', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'history preserved', annotations: [] }] };
      const response = { id: 'resp_history', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
    const config = join(home, 'config.toml');
    writeFileSync(config, `# Owner comment\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\nopenai_base_url = ${JSON.stringify(base)}\n[features]\nplugins = false\nhooks = false\n[model_providers.jev-gate-native]\nname = "Legacy fixture"\nbase_url = ${JSON.stringify(base)}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
    const original = readFileSync(config, 'utf8');
    writeFileSync(join(home, 'auth.json'), '{"OPENAI_API_KEY":"fake-native-key"}', { mode: 0o600 });
    const env = { PATH: process.env['PATH'], HOME: home, CODEX_HOME: home, XDG_CONFIG_HOME: join(temp, 'config'), JEV_CODEX_UPSTREAM: base, JEV_GATE_STATE_DIR: join(temp, 'state'), JEV_CODEX_TRACE_DIR: join(temp, 'trace') };
    const native = () => {
      const child = spawn('codex', ['--no-daemon', 'app-server', '--stdio'], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.resume(); const rpc = new CodexRpc(child.stdout, child.stdin); const events: Obj[] = [];
      rpc.onNotification = m => events.push(m);
      return { rpc, events, close: async () => { rpc.close(); child.kill('SIGTERM'); await new Promise<void>(r => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', () => r()); }); } };
    };
    const init = async (rpc: CodexRpc) => { await rpc.request('initialize', { clientInfo: { name: 'jev-history-fixture', version: '1' }, capabilities: { experimentalApi: true } }); rpc.send({ method: 'initialized' }); };
    const turn = async (n: ReturnType<typeof native>, id: string) => {
      const at = n.events.length;
      await n.rpc.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Give the scripted answer.', text_elements: [] }] });
      await vi.waitFor(() => expect(n.events.slice(at).some(m => m['method'] === 'turn/completed' && (m['params'] as Obj)['threadId'] === id)).toBe(true), { timeout: 15_000 });
      const completed = n.events.slice(at).find(m => m['method'] === 'turn/completed' && (m['params'] as Obj)['threadId'] === id)!;
      expect(((completed['params'] as Obj)['turn'] as Obj)['status']).toBe('completed');
    };
    const first = native(); let next: ReturnType<typeof native> | undefined;
    let gateway: Awaited<ReturnType<typeof startCodexSession>> | undefined;
    try {
      await init(first.rpc); const ids: string[] = [];
      for (const provider of ['openai', 'jev-gate-native']) {
        const started = await first.rpc.request('thread/start', { cwd: temp, ephemeral: false, modelProvider: provider, approvalPolicy: 'never', sandbox: 'read-only' });
        const id = String((started['thread'] as Obj)['id']); ids.push(id); await turn(first, id);
      }
      await first.close();
      // Reproduce an actual old installation, including native stored providers.
      writeFileSync(config, 'model_provider = "jev-gate-native"\n' + original);
      const legacyProvider = { name: 'Legacy fixture', base_url: base, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false };
      mkdirSync(join(home, 'jev-gate/connection'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'jev-gate/connection/owner.json'), JSON.stringify({ version: 1, pid: process.pid, port: 12345, token: 'a'.repeat(64), root: temp, original: { model_provider: null, 'model_providers.jev-gate-native': legacyProvider }, installed: { model_provider: 'jev-gate-native', 'model_providers.jev-gate-native': legacyProvider } }), { mode: 0o600 });
      gateway = await startCodexSession({ cwd: temp, env, connection: { token: 'a'.repeat(64), port: 0 } });
      const connection = { version: 1 as const, pid: process.pid, port: Number(new URL(gateway.url).port), token: gateway.token, root: temp, original: {}, installed: {} };
      await installConnection(gateway.rpc, connection, env);
      expect(readFileSync(config, 'utf8')).not.toContain('model_provider =');
      next = native(); await init(next.rpc);
      const list = async (providers: string[]) => (await next!.rpc.request('thread/list', { modelProviders: providers, limit: 100 }))['data'] as Obj[];
      expect((await list(['openai', 'jev-gate-native'])).map(t => t['id'])).toEqual(expect.arrayContaining(ids));
      // The native picker retains its provider filter. --all only removes cwd filtering.
      expect((await list(['openai'])).map(t => t['id'])).toContain(ids[0]);
      expect((await list(['openai'])).map(t => t['id'])).not.toContain(ids[1]);
      // Hooks are disabled in this history fixture. Seeing its requests enter the
      // gateway proves transport, not policy application or model confirmation.
      const observed = vi.spyOn(gateway.policy, 'requestSession');
      for (const id of ids) {
        const resumed = await next.rpc.request('thread/resume', { threadId: id, approvalPolicy: 'never', sandbox: 'read-only' });
        expect((resumed['thread'] as Obj)['id']).toBe(id); await turn(next, id);
        const read = await next.rpc.request('thread/read', { threadId: id, includeTurns: true });
        expect(((read['thread'] as Obj)['turns'] as Obj[])).toHaveLength(2);
      }
      expect(observed).toHaveBeenCalled();
      for (const id of ids) expect(observed.mock.calls.some(args => JSON.stringify(args).includes(id))).toBe(true);
      await restoreConnection(gateway.rpc, env); expect(readFileSync(config, 'utf8')).toBe(original);
    } finally { await first.close(); await next?.close(); await gateway?.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }, 60_000);
});
