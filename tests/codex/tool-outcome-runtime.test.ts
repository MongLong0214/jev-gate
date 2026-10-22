import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startCodexSession } from '../../src/codex/launch.js';
import type { Obj } from '../../src/codex/source.js';

describe.skipIf(process.env['JEV_CODEX_E2E'] !== '1')('native code-mode routing outcomes (#300)', () => {
  it('forwards an outer failure but never promotes script completion to nested command success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-native-outcome-')), home = join(root, 'home'); mkdirSync(home);
    writeFileSync(join(home, 'auth.json'), '{"OPENAI_API_KEY":"fake-native-key"}', { mode: 0o600 });
    writeFileSync(join(home, 'config.toml'), 'model="gpt-6.1-sol"\nmodel_reasoning_effort="high"\n');
    const config = join(root, 'policy.json');
    writeFileSync(config, JSON.stringify({ gate: { mode: 'off' }, compact: { enabled: false } }));
    const requests: Obj[] = [], judgments: Obj[] = [];
    const upstream = createServer(async (req, res) => {
      let raw = ''; for await (const b of req) raw += String(b);
      if (req.method === 'GET') { res.end('{"models":[]}'); return; }
      const body = JSON.parse(raw) as Obj; requests.push(body);
      const id = `response_${requests.length}`;
      const message = (text: string, phase: string) => ({ type: 'message', id: `${id}_message`, role: 'assistant', phase, content: [{ type: 'output_text', text, annotations: [] }] });
      const output = requests.length <= 2 ? [
        message('Continue verifying the original fixture contract after the observed tool outcome.', 'commentary'),
        { type: 'custom_tool_call', id: `${id}_tool`, call_id: `${id}_call`, name: 'exec', input: requests.length === 1
          ? 'throw new Error("PRIVATE_SCRIPT_FAILURE");'
          : 'text(await tools.exec_command({cmd:"exit 7",login:false}));' },
      ] : [message('Fixture complete.', 'final_answer')];
      const response = { id, model: body.model, status: 'completed', output, usage: { input_tokens: 1000, output_tokens: 20, total_tokens: 1020 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        ...output.flatMap((item, output_index) => [{ type: 'response.output_item.added', output_index, item }, { type: 'response.output_item.done', output_index, item }]),
        { type: 'response.completed', response }];
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    const judge = vi.fn(async (_url, init) => {
      const q = JSON.parse(String(init?.body)); judgments.push(q);
      return Response.json({ model: q.model, answers: Object.fromEntries(Object.entries(q.questions as Record<string, { type: string; criteria: unknown[] | Obj }>).map(([id, question]) => {
        const values = Array.isArray(question.criteria) ? question.criteria.map((_, i) => String(i)) : Object.keys(question.criteria);
        const pick = id === 'control' ? 'task_clear' : id === 'action_risk' ? 'ordinary' : values[0]!;
        const probabilities = Object.fromEntries(values.map(value => [value, value === pick ? 1 : 0]));
        return [id, question.type === 'score' ? { type: 'score', score: Number(pick), probabilities } : { type: 'choice', choice: pick, confidence: 1, probabilities }];
      })) });
    });
    const gateway = await startCodexSession({ cwd: root, nativeAuth: false, serverArgs: ['-c', 'features.plugins=false', '-c', 'features.hooks=false'],
      env: { PATH: process.env['PATH'], HOME: home, CODEX_HOME: home, TYPESAFE_API_KEY: 'fake-jev-key', JEV_CODEX_CONFIG: config,
        JEV_CODEX_TRACE_DIR: join(root, 'trace'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1` },
      fetchImpl: judge, connection: { token: 'a'.repeat(64), port: 0 } });
    try {
      gateway.policy.catalog = [{ model: 'gpt-6.1-sol', description: 'Workhorse for coding and advanced reasoning.', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) }];
      gateway.policy.catalogComplete = true;
      const events: Obj[] = [], previous = gateway.rpc.onNotification;
      gateway.rpc.onNotification = m => { previous(m); events.push(m); };
      const started = await gateway.rpc.request('thread/start', { cwd: root, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' });
      const id = String((started.thread as Obj).id), prompt = 'Verify this native tool outcome fixture.';
      await gateway.policy.externalHook({ hook_event_name: 'SessionStart', session_id: id, cwd: root, model: started.model });
      await gateway.policy.externalHook({ hook_event_name: 'UserPromptSubmit', session_id: id, turn_id: 'fixture', prompt });
      await gateway.rpc.request('turn/start', { threadId: id, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      await vi.waitFor(() => expect(events.some(m => m.method === 'turn/completed' && (m.params as Obj).threadId === id && ((m.params as Obj).turn as Obj).status === 'completed')).toBe(true), { timeout: 15_000 });
      expect(requests).toHaveLength(3); expect(judgments).toHaveLength(3);
      const context = (index: number) => ((judgments[index]!.state as Obj).execution as Obj).context;
      expect(context(1)).toMatchObject({ tools: [{ name: 'exec', state: 'error' }], outcome_coverage: 'native_status' });
      expect(context(2)).toMatchObject({ tools: [{ name: 'exec', state: 'error' }, { name: 'exec', state: 'done' }], outcome_coverage: 'partial_native_status' });
      // This is an actual failed nested command inside an otherwise completed JS script.
      expect(events.some(m => m.method === 'item/completed' && ((m.params as Obj).item as Obj).type === 'commandExecution' && ((m.params as Obj).item as Obj).exitCode === 7)).toBe(true);
      expect(JSON.stringify(judgments)).not.toContain('PRIVATE_SCRIPT_FAILURE');
      expect(JSON.stringify(judgments)).not.toContain('exit 7');
    } finally { await gateway.close(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
  }, 35_000);
});
