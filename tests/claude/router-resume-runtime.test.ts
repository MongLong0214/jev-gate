import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// One process per turn, as `-p --resume` runs it: the Router's root context must come from the plugin store, and a
// turn that fails must not erase the last answer.
describe.skipIf(process.env['JEV_CLAUDE_E2E'] !== '1')('Claude Router root context across processes', () => {
  it('asks with the last answer and requests after a failed turn and a resume', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'jev-router-resume-'));
    const home = join(temp, 'home'); const config = join(home, '.claude'); const cwd = join(temp, 'project'); const trace = join(temp, 'trace');
    mkdirSync(config, { recursive: true }); mkdirSync(cwd);
    let phase: 'answer' | 'fail' = 'answer';
    const tasks: Array<{ text: string; previous_reply?: string; recent_requests: Array<{ text: string }> }> = [];
    const api = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let bytes = Buffer.concat(chunks); if (req.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
      const body = JSON.parse(bytes.toString() || '{}');
      if (req.url === '/jev') {
        tasks.push(body.state.task);
        const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { type: string; criteria: string[] | Record<string, string> }>).map(([name, q]) => {
          if (q.type === 'noul') return [name, { type: 'noul', noul: .1 }];
          if (q.type === 'choice') { const keys = Object.keys(q.criteria); return [name, { type: 'choice', choice: keys[0], confidence: .99, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? .99 : .01 / (keys.length - 1)])) }]; }
          return [name, { type: 'score', probabilities: Object.fromEntries((q.criteria as string[]).map((_, i) => [i, i === 0 ? 1 : 0])) }];
        }));
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 30, output_tokens: 10 } })); return;
      }
      if (req.url?.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":100}'); return; }
      if (!req.url?.includes('/v1/messages')) { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
      if (phase === 'fail') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture failure' } })); return; }
      res.setHeader('content-type', 'text/event-stream');
      const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      event('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Renamed. Shall I also update the docs?' } });
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      event('message_stop', { type: 'message_stop' }); res.end();
    });
    try {
      await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE_|ANTHROPIC_|TYPESAFE_|JEV_|XDG_)/.test(name)));
      Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(home, '.config'), ANTHROPIC_API_KEY: 'fake-native-key', ANTHROPIC_BASE_URL: url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
        TYPESAFE_API_KEY: 'fake-local-jev-key', JEV_GATE_MODE: 'off', JEV_DASHBOARD_NO_OPEN: '1', JEV_GATE_ONBOARDING: '0', JEV_GATE_TRACE_DIR: trace });
      const root = join(__dirname, '../..'); const plugin = join(temp, 'plugin'); mkdirSync(plugin);
      const packed = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), temp], { encoding: 'utf8' }); expect(packed.status, packed.stderr).toBe(0);
      const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
      expect(spawnSync('unzip', ['-q', join(temp, `jev-gate-${version}.zip`), '-d', plugin]).status).toBe(0);
      const client = join(plugin, 'mods/router/hooks/client.ts'); writeFileSync(client, readFileSync(client, 'utf8').replace('https://api.typesafe.ai/v1/systemone', `${url}/jev`));
      writeFileSync(join(config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'jev-gate@inline': { options: { routerEnabled: true } } } }));
      const session = randomUUID();
      const run = (extra: string[], prompt: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn('claude', ['--plugin-dir', plugin, '--model', 'claude-opus-5-5', '--effort', 'xhigh', ...extra, '-p', prompt], { cwd, env });
        child.stdin.end(); let output = '';
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
      });
      const first = await run(['--session-id', session], 'Rename the parser in src/a.ts');
      expect(first.code, first.output).toBe(0);
      phase = 'fail'; await run(['--resume', session], 'Also the tests');
      phase = 'answer'; const resumed = await run(['--resume', session], 'ㅇㅇ');
      expect(resumed.code, resumed.output).toBe(0);
      const records = readdirSync(trace).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8'))).filter(r => r.phase === 'mod_router').sort((a, b) => a.written_at.localeCompare(b.written_at));
      const diagnostic = JSON.stringify({ tasks, records: records.filter(r => /^(root|turn_end|context_restore|session_end)/.test(r.event)) });
      expect(tasks.map(t => t.text), diagnostic).toEqual(['Rename the parser in src/a.ts', 'Also the tests', 'ㅇㅇ']);
      // The failed turn kept the answer before it, and each new process restored it with the requests.
      expect(tasks.slice(1).map(t => t.previous_reply), diagnostic).toEqual(['Renamed. Shall I also update the docs?', 'Renamed. Shall I also update the docs?']);
      expect(tasks[2]!.recent_requests.map(r => r.text), diagnostic).toEqual(['Rename the parser in src/a.ts', 'Also the tests']);
      expect(records.filter(r => r.event === 'turn_end' && r.scope === 'root').map(r => r.reason), diagnostic).toEqual(['answer', 'error', 'answer']);
      expect(records.filter(r => r.event === 'context_restored'), diagnostic).toHaveLength(2);
      // #332: every record names the hook release that wrote it.
      expect(new Set(records.map(r => r.hook_version).filter(Boolean)), diagnostic).toEqual(new Set([version]));
    } finally {
      api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
      rmSync(temp, { recursive: true, force: true });
    }
  }, 120_000);
});
