import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexRpc } from '../../src/codex/rpc.js';
import type { Obj } from '../../src/codex/source.js';

describe.skipIf(process.env['JEV_CODEX_E2E'] !== '1')('native worker history contract (#303)', () => {
  it('rejects ephemeral turn reads and recovers the exact persistent terminal turn', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'jev-worker-history-'));
    const home = join(temp, 'home'); const codexHome = join(temp, 'codex');
    mkdirSync(home); mkdirSync(codexHome);
    const upstream = createServer(async (req, res) => {
      for await (const _ of req) { /* Consume the scripted local request. */ }
      const item = { type: 'message', id: 'msg_history', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'history recovery confirmed', annotations: [] }] };
      const response = { id: 'resp_history', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
    writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "local-fixture"\n[features]\nplugins = false\nhooks = false\n[model_providers.local-fixture]\nname = "Local scripted fixture"\nbase_url = ${JSON.stringify(base)}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
    const native = spawn('codex', ['--no-daemon', 'app-server', '--listen', 'stdio://'], {
      cwd: temp, env: { PATH: process.env['PATH'], HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let errors = ''; native.stderr.on('data', b => { errors += String(b); });
    const rpc = new CodexRpc(native.stdout, native.stdin);
    const events: Obj[] = []; rpc.onNotification = m => { events.push(m); };
    try {
      await rpc.request('initialize', { clientInfo: { name: 'jev-history-fixture', version: '1' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized' });
      const start = async (ephemeral: boolean): Promise<string> => String(((await rpc.request('thread/start', { cwd: temp, ephemeral, approvalPolicy: 'never', sandbox: 'read-only' }))['thread'] as Obj)['id']);
      const ephemeral = await start(true);
      await expect(rpc.request('thread/read', { threadId: ephemeral, includeTurns: true })).rejects.toMatchObject({ kind: 'rejected' });
      const thread = await start(false);
      const started = await rpc.request('turn/start', { threadId: thread, input: [{ type: 'text', text: 'Return the scripted answer.', text_elements: [] }] });
      const turnId = (started['turn'] as Obj)['id'];
      await vi.waitFor(() => expect(events.some(m => m['method'] === 'turn/completed' && (m['params'] as Obj)['threadId'] === thread), errors).toBe(true), { timeout: 15_000 });
      const read = await rpc.request('thread/read', { threadId: thread, includeTurns: true });
      expect((read['thread'] as Obj)['id']).toBe(thread);
      const turn = ((read['thread'] as Obj)['turns'] as Obj[]).find(t => t['id'] === turnId);
      expect(turn).toMatchObject({ status: 'completed', items: expect.arrayContaining([expect.objectContaining({ type: 'agentMessage', text: 'history recovery confirmed' })]) });
      await rpc.request('thread/archive', { threadId: thread });
    } finally {
      rpc.close(); native.kill('SIGTERM');
      await new Promise<void>(resolve => { if (native.exitCode !== null || native.signalCode !== null) resolve(); else native.once('exit', () => resolve()); });
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});
