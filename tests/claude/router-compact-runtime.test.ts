import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The host compacts a turn mid-way once its context passes the window: it forks the conversation with a summary request
// on the native model and effort, then goes on in the same turn. Before v0.8.82 the Router stopped such a turn, so the
// rest ran on the baseline; a turn now continues on its own selection, a switch held for cache cost included.
describe.skipIf(process.env['JEV_CLAUDE_E2E'] !== '1')('Claude Router root turn through a host auto-compaction', () => {
  it.each([
    { name: 'keeps a routed effort on the requests after the compaction', capability: 'complex',
      before: Array<string>(3).fill('claude-opus-5-5:medium'), after: Array<string>(3).fill('claude-opus-5-5:medium') },
    // A fresh process has seen no prefix, so the downgrade is held for its unknown cost; after the compaction no model
    // has a warm cache, and the turn moves to its selection.
    { name: 'moves a switch held for its cache cost once the compaction leaves no cache warm', capability: 'mechanical',
      before: Array<string>(3).fill('claude-opus-5-5:medium'), after: Array<string>(3).fill('claude-haiku-5-5:medium') },
  ])('$name', async scenario => {
    const temp = mkdtempSync(join(tmpdir(), 'jev-router-compact-'));
    const home = join(temp, 'home'); const config = join(home, '.claude'); const cwd = join(temp, 'project'); const trace = join(temp, 'trace');
    mkdirSync(config, { recursive: true }); mkdirSync(cwd);
    const STEPS = 6; const LARGE_AT = 3;
    const requests: Array<{ compact: boolean; sent: string }> = []; let step = 0;
    const api = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let bytes = Buffer.concat(chunks); if (req.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
      const body = JSON.parse(bytes.toString() || '{}');
      if (req.url === '/jev') {
        const pick = (keys: string[], key: string) => ({ type: 'choice', choice: key, confidence: .99, probabilities: Object.fromEntries(keys.map(k => [k, k === key ? .99 : .01 / (keys.length - 1)])) });
        const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { type: string; criteria: string[] | Record<string, string> }>).map(([name, q]) => {
          if (q.type === 'noul') return [name, { type: 'noul', noul: .1 }];
          if (q.type === 'choice') { const keys = Object.keys(q.criteria); return [name, pick(keys, name === 'capability' ? scenario.capability : name === 'control' ? 'task_clear' : name === 'action_risk' ? 'ordinary' : keys[0]!)]; }
          const at = (q.criteria as string[]).findIndex(text => text.startsWith('Ordinary reasoning'));
          return [name, { type: 'score', probabilities: Object.fromEntries((q.criteria as string[]).map((_, i) => [i, i === at ? 1 : 0])) }];
        }));
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 30, output_tokens: 10 } })); return;
      }
      if (req.url?.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":10}'); return; }
      if (!req.url?.includes('/v1/messages')) { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
      // The host's compaction request forks the conversation with this instruction in its last user message.
      const compact = JSON.stringify(body.messages ?? []).includes('create a detailed summary of the conversation so far');
      requests.push({ compact, sent: `${body.model}:${body.output_config?.effort}` });
      if (!compact) step += 1;
      const tool = !compact && step < STEPS;
      const big = !compact && step === LARGE_AT;
      res.setHeader('content-type', 'text/event-stream');
      const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      event('message_start', { type: 'message_start', message: { id: `msg_fixture_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: big ? 180_000 : 0, cache_creation_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1 } } } });
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: `fx_${requests.length}`, name: 'Bash', input: {} } : { type: 'text', text: '' } });
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: `printf 'observed ${requests.length}\\n'`, description: 'Observe a real tool step' }) } : { type: 'text_delta', text: compact ? '<summary>Running the local printf checks; steps so far observed.</summary>' : 'Done.' } });
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      event('message_stop', { type: 'message_stop' }); res.end();
    });
    try {
      await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE_|ANTHROPIC_|TYPESAFE_|JEV_|XDG_)/.test(name)));
      Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(home, '.config'), ANTHROPIC_API_KEY: 'fake-native-key', ANTHROPIC_BASE_URL: url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', TYPESAFE_API_KEY: 'fake-local-jev-key', JEV_GATE_MODE: 'off', JEV_DASHBOARD_NO_OPEN: '1', JEV_GATE_ONBOARDING: '0', JEV_GATE_TRACE_DIR: trace });
      const root = join(__dirname, '../..'); const plugin = join(temp, 'plugin'); mkdirSync(plugin);
      const packed = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), temp], { encoding: 'utf8' }); expect(packed.status, packed.stderr).toBe(0);
      const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
      expect(spawnSync('unzip', ['-q', join(temp, `jev-gate-${version}.zip`), '-d', plugin]).status).toBe(0);
      const client = join(plugin, 'mods/router/hooks/client.ts'); writeFileSync(client, readFileSync(client, 'utf8').replace('https://api.typesafe.ai/v1/systemone', `${url}/jev`));
      writeFileSync(join(config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'jev-gate@inline': { options: { routerEnabled: true, compactEnabled: false } } } }));
      let output = '';
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn('claude', ['--plugin-dir', plugin, '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--max-turns', '20', '--allowedTools', 'Bash', '--', 'Run the stated local printf check and explain the result.'], { cwd, env });
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', exit => { clearTimeout(timer); resolve(exit); });
        child.stdin.end();
      });
      const records = (existsSync(trace) ? readdirSync(trace) : []).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8'))).filter(r => r.phase === 'mod_router').sort((a, b) => a.written_at.localeCompare(b.written_at));
      const diagnostic = JSON.stringify({ requests, records: records.filter(r => !['prepared', 'request', 'router', 'model_request'].includes(r.event)).map(r => ({ event: r.event, index: r.index, reason: r.reason, patch: r.patch, cost_reason: r.cost_reason, continued: r.continued, requested: r.requested, observed_effort: r.observed_effort })), output: output.slice(-600) });
      expect(code, diagnostic).toBe(0);
      // The summary request runs on the native pair; it is no turn step the Router sees.
      const at = requests.findIndex(r => r.compact);
      expect(requests.filter(r => r.compact).map(r => r.sent), diagnostic).toEqual(['claude-opus-5-5:xhigh']);
      expect(requests.slice(0, at).map(r => r.sent), diagnostic).toEqual(scenario.before);
      expect(requests.slice(at + 1).map(r => r.sent), diagnostic).toEqual(scenario.after);
      expect(records.filter(r => r.event === 'context_reset'), diagnostic).toMatchObject([{ scope: 'root', index: 3, continued: 1 }]);
      expect(records.filter(r => r.event === 'root_resume'), diagnostic).toMatchObject([{ index: 3, reason: 'context_reset' }]);
      expect(records.filter(r => r.event === 'root_stop'), diagnostic).toEqual([]);
      // The transcript's api-request rows say each request after the reset ran with the pair the host sent.
      expect(records.filter(r => r.event === 'root_result' && r.index >= 3).map(r => `${r.requested}:${r.observed_effort}`), diagnostic).toEqual(scenario.after);
    } finally {
      api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
      rmSync(temp, { recursive: true, force: true });
    }
  }, 150_000);
});
