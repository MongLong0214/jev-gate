import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexRpc } from '../../src/codex/rpc.js';
import type { Obj } from '../../src/codex/source.js';

// Real installed native binary, disposable home, scripted local responses; no account or inference.
describe.skipIf(process.env['JEV_CODEX_E2E'] !== '1')('native cache ownership contract (#365, #369)', () => {
  it.each([false, true])('owns effort updates only with its native experimental feature (enabled=%s)', async enabled => {
    const root = mkdtempSync(join(tmpdir(), 'jev-native-cache-')), home = join(root, 'home'); mkdirSync(home);
    const requests: Obj[] = [];
    let failCompact = false;
    const upstream = createServer(async (req, res) => {
      let body = ''; for await (const b of req) body += String(b);
      if (req.method !== 'POST') { res.end('{"models":[]}'); return; }
      const input = JSON.parse(body); requests.push(input);
      const metadata = JSON.parse(String(req.headers['x-codex-turn-metadata'] ?? '{}'));
      const compact = metadata.request_kind === 'compaction' || req.url?.includes('/compact');
      if (compact && failCompact) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"local compaction fixture failure"}}'); return; }
      const id = `resp_${requests.length}`;
      const item = compact ? { type: 'compaction', encrypted_content: 'local-opaque-checkpoint' }
        : { type: 'message', id: `msg_${requests.length}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'fixture complete', annotations: [] }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [{ type: 'response.created', response: { id, status: 'in_progress', output: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, status: 'completed', model: input.model, output: [item], usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } } }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    // Built-in OpenAI tries WS first. Deliberately select its documented SSE
    // fallback rather than waiting for a fake server's invalid-upgrade retries.
    upstream.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
    writeFileSync(join(home, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\nopenai_base_url = ${JSON.stringify(base)}\n[features]\nplugins = false\nhooks = false\nreasoning_effort_override = ${enabled}\n`);
    writeFileSync(join(home, 'auth.json'), '{"OPENAI_API_KEY":"fake-local-native-key"}', { mode: 0o600 });
    const native = () => {
      const child = spawn('codex', ['--no-daemon', 'app-server', '--stdio'], { cwd: root, env: { PATH: process.env['PATH'], HOME: home, CODEX_HOME: home, XDG_CONFIG_HOME: join(root, 'config') } });
      child.stderr.resume(); const rpc = new CodexRpc(child.stdout, child.stdin), events: Obj[] = [];
      rpc.onNotification = m => events.push(m);
      return { rpc, events, close: async () => { rpc.close(); child.kill('SIGTERM'); if (child.exitCode === null && child.signalCode === null) await new Promise<void>(r => child.once('exit', () => r())); } };
    };
    const init = async (n: ReturnType<typeof native>) => { await n.rpc.request('initialize', { clientInfo: { name: 'cache-contract-fixture', version: '1' }, capabilities: { experimentalApi: true } }); n.rpc.send({ method: 'initialized' }); };
    const turn = async (n: ReturnType<typeof native>, id: string, effort: string, model?: string) => {
      const at = n.events.length;
      await n.rpc.request('turn/start', { threadId: id, effort, ...(model ? { model } : {}), input: [{ type: 'text', text: `Answer the ${effort} fixture.`, text_elements: [] }] });
      await vi.waitFor(() => expect(n.events.slice(at).some(e => e['method'] === 'turn/completed')).toBe(true), { timeout: 10_000 });
      const event = n.events.slice(at).find(e => e['method'] === 'turn/completed')!;
      expect(((event['params'] as Obj)['turn'] as Obj)['status']).toBe('completed');
    };
    const first = native(); let resumed: ReturnType<typeof native> | undefined;
    const updates = (r: Obj) => (r['input'] as Obj[]).filter(i => i['type'] === 'configuration_update');
    try {
      await init(first);
      const start = await first.rpc.request('thread/start', { cwd: root, ephemeral: false, approvalPolicy: 'never', sandbox: 'read-only' });
      const id = String((start['thread'] as Obj)['id']);
      await turn(first, id, 'low'); await turn(first, id, 'high');
      expect(requests).toHaveLength(2);
      expect(requests.map(r => (r['reasoning'] as Obj)['effort'])).toEqual(enabled ? ['low', 'low'] : ['low', 'high']);
      // Native prewarm can establish the initial pin before the first sample,
      // so a redundant initial low update is not required. The changed update
      // must append to exactly the surviving native updates.
      const initial = updates(requests[0]!);
      expect([[], [{ type: 'configuration_update', reasoning: { effort: 'low' } }]]).toContainEqual(initial);
      expect(updates(requests[1]!)).toEqual(enabled ? [...initial, { type: 'configuration_update', reasoning: { effort: 'high' } }] : []);
      // Public user input cannot impersonate a trusted native history operation.
      for (const type of ['configuration_update', 'drop_message', 'reposition']) {
        await expect(first.rpc.request('turn/start', { threadId: id, input: [{ type, reasoning: { effort: 'low' } }] })).rejects.toThrow();
      }
      expect(requests).toHaveLength(2);
      for (const r of requests) for (const key of ['drop_message', 'reposition', 'prompt_cache_options']) expect(r).not.toHaveProperty(key);
      if (enabled) expect((requests[1]!['input'] as Obj[]).slice(0, (requests[0]!['input'] as Obj[]).length)).toEqual(requests[0]!['input']);
      await first.close(); resumed = native(); await init(resumed);
      await resumed.rpc.request('thread/resume', { threadId: id, approvalPolicy: 'never', sandbox: 'read-only' });
      await turn(resumed, id, 'high');
      // Surviving updates stay exact. Native prewarm/replay owns whether a
      // redundant refresh is needed; the proxy does not synthesize that item.
      const prior = updates(requests[1]!), replay = updates(requests[2]!);
      expect(replay.slice(0, prior.length)).toEqual(prior);
      expect(enabled ? [[], [{ type: 'configuration_update', reasoning: { effort: 'high' } }]] : [[]]).toContainEqual(replay.slice(prior.length));
      expect((await resumed.rpc.request('thread/read', { threadId: id, includeTurns: true }))['thread']).toMatchObject({ turns: [{}, {}, {}] });
      // A public supported model and a catalogued unsupported model must take
      // different native paths. The plugin must not force-enable either path.
      await turn(resumed, id, 'high', 'gpt-5.6-luna');
      await turn(resumed, id, 'low');
      expect(requests.slice(-2).map(r => (r['reasoning'] as Obj)['effort'])).toEqual(['high', 'low']);
      expect(requests.slice(-2).map(updates)).toEqual([[], []]);
      await turn(resumed, id, 'medium', 'gpt-6.1-sol');
      expect((requests.at(-1)!['reasoning'] as Obj)['effort']).toBe('medium');
      if (enabled) expect(updates(requests.at(-1)!).at(-1)).toEqual({ type: 'configuration_update', reasoning: { effort: 'medium' } });

      const beforeFailure = updates(requests.at(-1)!);
      const atFailure = resumed.events.length;
      failCompact = true;
      await resumed.rpc.request('thread/compact/start', { threadId: id });
      await vi.waitFor(() => expect(resumed!.events.slice(atFailure).some(e => e['method'] === 'error')).toBe(true), { timeout: 10_000 });
      failCompact = false;
      await turn(resumed, id, 'medium');
      expect(updates(requests.at(-1)!)).toEqual(beforeFailure);
      expect((requests.at(-1)!['input'] as Obj[]).some(i => i['type'] === 'compaction')).toBe(false);

      const atSuccess = resumed.events.length;
      await resumed.rpc.request('thread/compact/start', { threadId: id });
      await vi.waitFor(() => expect(resumed!.events.slice(atSuccess).some(e => e['method'] === 'item/completed' && ((e['params'] as Obj)['item'] as Obj)?.['type'] === 'contextCompaction')).toBe(true), { timeout: 10_000 });
      await turn(resumed, id, 'high');
      expect(requests.at(-1)!['input']).toContainEqual(expect.objectContaining({ type: 'compaction', encrypted_content: 'local-opaque-checkpoint' }));
      // Successful native compaction retires old updates. A new native pin may
      // be established before this request; any surviving update is current.
      for (const u of updates(requests.at(-1)!)) expect(u).toEqual({ type: 'configuration_update', reasoning: { effort: 'high' } });
      const last = requests.at(-1)!;
      expect((updates(last).at(-1)?.['reasoning'] as Obj | undefined)?.['effort'] ?? (last['reasoning'] as Obj)['effort']).toBe('high');
    } finally { await first.close(); await resumed?.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }, 40_000);
});
