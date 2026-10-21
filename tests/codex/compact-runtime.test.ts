import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startCodexSession } from '../../src/codex/launch.js';
import type { Obj } from '../../src/codex/source.js';

describe.skipIf(process.env['JEV_CODEX_E2E'] !== '1')('native Codex Jev Compact contract (#317)', () => {
  it('selects actual native tool blocks, preserves a required fact and continues through native compaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-compact-native-')), home = join(root, 'home'), trace = join(root, 'trace'); mkdirSync(home);
    writeFileSync(join(home, 'auth.json'), '{"OPENAI_API_KEY":"fake-native-key"}', { mode: 0o600 });
    writeFileSync(join(home, 'config.toml'), 'model="gpt-6.1-sol"\nmodel_reasoning_effort="high"\nmodel_context_window=250000\nmodel_auto_compact_token_limit=200000\n');
    const config = join(root, 'policy.json'); writeFileSync(config, JSON.stringify({ gate: { mode: 'off' }, router: { enabled: false } }));
    const requests: Array<{ body: Obj; native: boolean }> = [];
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += String(chunk);
      if (req.method === 'GET') { res.end('{"models":[]}'); return; }
      const metadata = JSON.parse(String(req.headers['x-codex-turn-metadata'] ?? '{}'));
      const body = JSON.parse(raw) as Obj; requests.push({ body, native: metadata.request_kind === 'compaction' || req.url?.includes('/compact') === true });
      const item = { type: 'message', id: `msg_${requests.length}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'ALPHA-731; reject empty names; preserve unicode; parseName(value).', annotations: [] }] };
      const response = { id: `resp_${requests.length}`, model: body.model, status: 'completed', output: [item], usage: { input_tokens: 9000, output_tokens: 20, total_tokens: 9020, input_tokens_details: { cached_tokens: 5000, cache_write_tokens: 0 } } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const judge = vi.fn(async (_url, init) => {
      const q = JSON.parse(String(init?.body));
      return Response.json({ model: q.model, usage: { input_tokens: 1000, output_tokens: 20 }, answers: Object.fromEntries(q.state.candidates.map((c: Obj) => {
        const choice = String(c.text).includes('ALPHA-731') ? 'keep' : 'remove';
        return [c.id, { type: 'choice', choice, confidence: .99, probabilities: { keep: choice === 'keep' ? .99 : .005, remove: choice === 'remove' ? .99 : .005, unclear: .005 } }];
      })) });
    });
    const gateway = await startCodexSession({ cwd: root, nativeAuth: false, serverArgs: ['-c', 'features.plugins=false', '-c', 'features.hooks=false'],
      env: { PATH: process.env['PATH'], HOME: home, CODEX_HOME: home, XDG_CONFIG_HOME: join(root, 'config'), TYPESAFE_API_KEY: 'fake-jev-key', JEV_CODEX_CONFIG: config, JEV_CODEX_TRACE_DIR: trace, JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` },
      fetchImpl: judge, connection: { token: 'f'.repeat(64), port: 0 } });
    try {
      const events: Obj[] = []; const prior = gateway.rpc.onNotification; gateway.rpc.onNotification = m => { prior(m); events.push(m); };
      const started = await gateway.rpc.request('thread/start', { ephemeral: true, cwd: root, approvalPolicy: 'never', sandbox: 'read-only' });
      const id = String((started.thread as Obj).id);
      const items = Array.from({ length: 16 }, (_, i) => [
        { type: 'custom_tool_call', call_id: `fixture_${i}`, name: 'exec', input: i === 1 ? 'Read parser contract.' : 'Read completed obsolete color survey.' },
        { type: 'custom_tool_call_output', call_id: `fixture_${i}`, output: [{ type: 'input_text', text: (i === 1 ? 'ALPHA-731; reject empty names; preserve unicode; parseName(value).\n' : 'Completed obsolete CSS color survey. blue green gray white beige navy violet.\n').repeat(120) + (i === 0 || i === 2 ? '' : `Read occurrence ${i}.`) }] },
      ]).flat();
      await gateway.rpc.request('thread/inject_items', { threadId: id, items });
      // This fixture registers transport metadata explicitly; installed hook trust has a separate runtime suite.
      await gateway.policy.externalHook({ hook_event_name: 'SessionStart', session_id: id, cwd: root, model: started.model });
      await gateway.policy.externalHook({ hook_event_name: 'UserPromptSubmit', session_id: id, turn_id: 'fixture', prompt: 'Implement the parser. Preserve its contract and sentinel.' });
      const turn = async () => { const at = events.length; await gateway.rpc.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'List the parser requirements without using tools.', text_elements: [] }] });
        await vi.waitFor(() => expect(events.slice(at).some(m => m.method === 'turn/completed' && (m.params as Obj).threadId === id && ((m.params as Obj).turn as Obj).status === 'completed')).toBe(true), { timeout: 15_000 }); };
      await turn();
      const first = requests[0]!.body.input as Obj[];
      expect(first.some(i => i.type === 'custom_tool_call_output' && JSON.stringify(i).includes('Jev Compact:'))).toBe(true);
      expect(JSON.stringify(first.find(i => i.call_id === 'fixture_2' && i.type === 'custom_tool_call_output'))).toContain('exact duplicate of retained call_id');
      const canonical = (first.find(i => i.call_id === 'fixture_0' && i.type === 'custom_tool_call_output')!.output as Obj[])[0]!;
      const encoded = JSON.parse(String(canonical.text).split('\n')[1]!) as { count: number; unit: string };
      expect(encoded.unit.repeat(encoded.count)).toBe((items[1]!.output as Obj[])[0]!.text);
      expect(first.find(i => i.call_id === 'fixture_1' && i.type === 'custom_tool_call_output')).toMatchObject(items[3]!);
      for (const item of items.slice(-12)) expect(first.find(i => i.call_id === item.call_id && i.type === item.type)).toMatchObject(item);
      const before = requests.length; await gateway.rpc.request('thread/compact/start', { threadId: id });
      await vi.waitFor(() => expect(requests.slice(before).some(r => r.native)).toBe(true), { timeout: 15_000 });
      await vi.waitFor(() => expect(events.some(m => m.method === 'item/completed' && ((m.params as Obj).item as Obj)?.type === 'contextCompaction')).toBe(true), { timeout: 15_000 });
      await turn();
      const rows = readdirSync(trace).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8')) as Obj);
      expect(rows.some(r => r.phase === 'codex_compact' && r.stage === 'submitted' && r.applied === true)).toBe(true);
      expect(rows.some(r => r.phase === 'codex_compact' && r.stage === 'result' && r.outcome === 'completed')).toBe(true);
      expect(judge).toHaveBeenCalled(); expect(JSON.stringify(rows)).not.toContain('fake-jev-key');
    } finally { await gateway.close(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }); }
  }, 45_000);
});
