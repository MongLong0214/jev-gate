import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexRpc } from '../../src/codex/rpc.js';
import type { Obj } from '../../src/codex/source.js';

const command = JSON.parse(readFileSync(new URL('../../plugins/codex/hooks/hooks.json', import.meta.url), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command as string;

describe.skipIf(process.env['JEV_CODEX_E2E'] !== '1')('native cached hook command during upgrade (#310)', () => {
  it.each(['legacy', 'bootstrap'])('%s command before and after its version is pruned', async kind => {
    const temp = mkdtempSync(join(tmpdir(), 'jev-native-hook upgrade '));
    const home = join(temp, 'home'); mkdirSync(home);
    const evidence = join(temp, 'executed.jsonl');
    const bundle = (version: string) => {
      const root = join(home, 'plugins/cache/test-market/jev-gate', version);
      mkdirSync(join(root, '.codex-plugin'), { recursive: true }); mkdirSync(join(root, 'dist'));
      writeFileSync(join(root, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'jev-gate', version }));
      writeFileSync(join(root, 'dist/hook.mjs'), `import {appendFileSync} from 'node:fs';\nexport async function runCodexHook({stdin}) { for await(const chunk of stdin) {} appendFileSync(${JSON.stringify(evidence)}, ${JSON.stringify(version + '\n')}); return {}; }\nif(process.argv[1]?.endsWith('/hook.mjs')) runCodexHook({stdin:process.stdin}).then(r=>process.stdout.write(JSON.stringify(r)+'\\n'));`);
      return root;
    };
    const old = bundle('0.8.31');
    writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: kind === 'legacy' ? 'node "$PLUGIN_ROOT/dist/hook.mjs"' : command, timeout: 5 }] }] } }));
    const upstream = createServer(async (req, res) => {
      for await (const _ of req) { /* Scripted local response; no paid inference. */ }
      if (req.headers['upgrade']) { res.writeHead(426); res.end(); return; }
      if (req.method === 'GET') { res.end('{"models":[]}'); return; }
      const item = { type: 'message', id: 'msg_upgrade', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'fixture complete', annotations: [] }] };
      const response = { id: 'resp_upgrade', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    writeFileSync(join(home, 'config.toml'), `model = "gpt-6.1-sol"\nopenai_base_url = "http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1"\n[features]\nplugins = false\nhooks = true\n`);
    writeFileSync(join(home, 'auth.json'), '{"OPENAI_API_KEY":"fake-native-key"}', { mode: 0o600 });
    // Trust bypass is restricted to this disposable home and these local fixtures.
    const child = spawn('codex', ['--no-daemon', '--dangerously-bypass-hook-trust', 'app-server', '--stdio'], { cwd: temp, env: { PATH: process.env['PATH'], HOME: home, CODEX_HOME: home, PLUGIN_ROOT: old } });
    let stderr = ''; child.stderr.on('data', b => { stderr += String(b); });
    const rpc = new CodexRpc(child.stdout, child.stdin); const events: Obj[] = [];
    rpc.onNotification = m => events.push(m);
    try {
      await rpc.request('initialize', { clientInfo: { name: 'jev-hook-upgrade-fixture', version: '1' }, capabilities: { experimentalApi: true } }); rpc.send({ method: 'initialized' });
      const listed = await rpc.request('hooks/list', { cwds: [temp] });
      const hooks = (listed['data'] as Array<{ hooks: Obj[] }>).flatMap(d => d.hooks);
      expect(hooks.length, JSON.stringify(listed) + stderr).toBeGreaterThan(0);
      await rpc.request('config/batchWrite', { edits: hooks.map(h => ({ keyPath: `hooks.state.${JSON.stringify(h['key'])}`, value: { trusted_hash: h['currentHash'] }, mergeStrategy: 'upsert' })) });
      const started = await rpc.request('thread/start', { cwd: temp, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' });
      const threadId = String((started['thread'] as Obj)['id']);
      const turn = async () => {
        const at = events.length;
        await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Give the scripted answer.', text_elements: [] }] });
        await vi.waitFor(() => expect(events.slice(at).some(m => m['method'] === 'turn/completed')).toBe(true), { timeout: 15_000 });
        const rows = events.slice(at);
        expect(((rows.find(m => m['method'] === 'turn/completed')!['params'] as Obj)['turn'] as Obj)['status'], stderr).toBe('completed');
        const hooks = rows.filter(m => m['method'] === 'hook/completed').map(m => (m['params'] as Obj)['run'] as Obj);
        expect(hooks.length, JSON.stringify(rows)).toBeGreaterThan(0);
        return hooks;
      };
      expect((await turn()).map(h => h['status'])).not.toContain('failed');
      expect(readFileSync(evidence, 'utf8')).toBe('0.8.31\n');
      bundle('0.8.32'); rmSync(old, { recursive: true });
      const after = await turn();
      if (kind === 'legacy') {
        expect(after.map(h => h['status'])).toContain('failed');
        expect(readFileSync(evidence, 'utf8')).toBe('0.8.31\n');
      } else {
        expect(after.map(h => h['status'])).not.toContain('failed');
        expect(readFileSync(evidence, 'utf8')).toBe('0.8.31\n0.8.32\n');
      }
    } finally {
      rpc.close(); child.kill('SIGTERM');
      await new Promise<void>(r => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', () => r()); });
      upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r()));
      rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 45_000);
});
