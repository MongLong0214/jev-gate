import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The host sends a turn's effort from its first request to its last: a step that names another one mid-turn is still
// sent on the first. Four turns of 2026-11-11 to 11-13 returned from Haiku to Opus or Fable by baseline_reach and ran
// 19 requests on the switch's effort while the Router's record named the baseline's. Each fixture answer needs its own
// message id: the host folds answers that share one into a single message, and the turn then never has an answered
// request to hold an effort from.
describe.skipIf(process.env['JEV_CLAUDE_E2E'] !== '1')('Claude Router root switch that returns mid-turn', () => {
  it.each([
    // The cache is warm at low: Opus itself would run this turn at medium, so the switch on medium is taken.
    { name: 'returns on the effort the turn started on, and records it', first: 'low', second: 'medium', reason: 'cost_allows',
      sent: [...Array<string>(5).fill('claude-haiku-5-5:medium'), ...Array<string>(3).fill('claude-opus-5-5:medium')] },
    // The cache is warm at xhigh, which Opus keeps: a return on low would run it below that, so the switch is held.
    { name: 'holds a switch whose effort the baseline would not run', first: 'xhigh', second: 'low', reason: 'return_effort',
      sent: Array<string>(8).fill('claude-opus-5-5:xhigh') },
  ])('$name', async scenario => {
    const temp = mkdtempSync(join(tmpdir(), 'jev-router-return-'));
    const home = join(temp, 'home'); const config = join(home, '.claude'); const cwd = join(temp, 'project'); const trace = join(temp, 'trace');
    mkdirSync(config, { recursive: true }); mkdirSync(cwd);
    const STEPS = [2, 8]; const LEVELS: Record<string, string> = { low: 'Light reasoning', medium: 'Ordinary reasoning', high: 'Strong reasoning', xhigh: 'Exceptional reasoning' };
    const requests: Array<{ turn: number; model: string; effort: string | undefined }> = []; let turn = 0; let step = 0;
    const api = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let bytes = Buffer.concat(chunks); if (req.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
      const body = JSON.parse(bytes.toString() || '{}');
      if (req.url === '/jev') {
        const want = LEVELS[turn === 0 ? scenario.first : scenario.second]!;
        const pick = (keys: string[], key: string) => ({ type: 'choice', choice: key, confidence: .99, probabilities: Object.fromEntries(keys.map(k => [k, k === key ? .99 : .01 / (keys.length - 1)])) });
        const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { type: string; criteria: string[] | Record<string, string> }>).map(([name, q]) => {
          if (q.type === 'noul') return [name, { type: 'noul', noul: .1 }];
          if (q.type === 'choice') { const keys = Object.keys(q.criteria); return [name, pick(keys, name === 'capability' ? 'mechanical' : name === 'control' ? 'task_clear' : name === 'action_risk' ? 'ordinary' : keys[0]!)]; }
          const at = (q.criteria as string[]).findIndex(text => text.startsWith(want));
          return [name, { type: 'score', probabilities: Object.fromEntries((q.criteria as string[]).map((_, i) => [i, i === at ? 1 : 0])) }];
        }));
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 30, output_tokens: 10 } })); return;
      }
      if (req.url?.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":10}'); return; }
      if (!req.url?.includes('/v1/messages')) { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
      requests.push({ turn, model: body.model, effort: body.output_config?.effort }); step += 1;
      const tool = step < STEPS[turn]!;
      res.setHeader('content-type', 'text/event-stream');
      const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      event('message_start', { type: 'message_start', message: { id: `msg_fixture_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1 } } } });
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: `fx_${requests.length}`, name: 'Bash', input: {} } : { type: 'text', text: '' } });
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: `printf 'observed ${requests.length}\\n'`, description: 'Observe a real tool step' }) } : { type: 'text_delta', text: 'Done.' } });
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      event('message_stop', { type: 'message_stop' }); res.end();
    });
    try {
      await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE_|ANTHROPIC_|TYPESAFE_|JEV_|XDG_)/.test(name)));
      Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(home, '.config'), ANTHROPIC_API_KEY: 'fake-native-key', ANTHROPIC_BASE_URL: url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', TYPESAFE_API_KEY: 'fake-local-jev-key', JEV_GATE_MODE: 'off', JEV_DASHBOARD_NO_OPEN: '1', JEV_GATE_ONBOARDING: '0', JEV_GATE_TRACE_DIR: trace });
      const root = join(__dirname, '../..'); const plugin = join(temp, 'plugin'); mkdirSync(plugin);
      const packed = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), temp], { encoding: 'utf8' }); expect(packed.status, packed.stderr).toBe(0);
      const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
      expect(spawnSync('unzip', ['-q', join(temp, `jev-gate-${version}.zip`), '-d', plugin]).status).toBe(0);
      const client = join(plugin, 'mods/router/hooks/client.ts'); writeFileSync(client, readFileSync(client, 'utf8').replace('https://api.typesafe.ai/v1/systemone', `${url}/jev`));
      writeFileSync(join(config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'jev-gate@inline': { options: { routerEnabled: true } } } }));
      let output = '';
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn('claude', ['--plugin-dir', plugin, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--max-turns', '20', '--allowedTools', 'Bash'], { cwd, env });
        const send = (text: string) => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
        let buffered = '';
        child.stdout.on('data', chunk => {
          output += chunk; buffered += String(chunk);
          for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
            const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
            let row: { type?: string }; try { row = JSON.parse(line); } catch { continue; }
            if (row.type !== 'result') continue;
            turn += 1; step = 0;
            if (turn < STEPS.length) send('Continue: locate the exact file and run the local printf check.'); else child.stdin.end();
          }
        });
        child.stderr.on('data', chunk => { output += chunk; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 80_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', exit => { clearTimeout(timer); resolve(exit); });
        send('Run the stated local printf check and explain the result.');
      });
      const records = readdirSync(trace).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8'))).filter(r => r.phase === 'mod_router').sort((a, b) => a.written_at.localeCompare(b.written_at));
      const decision = records.filter(r => r.event === 'root')[1];
      const named = records.filter(r => r.event === 'model_request' && r.turn === decision?.turn).sort((a, b) => a.index - b.index).map(r => `${r.requested}:${r.requested_effort}`);
      const diagnostic = JSON.stringify({ requests, named, decision: decision && { cost_reason: decision.cost_reason, patch: decision.patch, proposed_patch: decision.proposed_patch }, stops: records.filter(r => r.event === 'root_stop'), output: output.slice(-600) });
      expect(code, diagnostic).toBe(0);
      expect(decision, diagnostic).toMatchObject({ cost_reason: scenario.reason, proposed_patch: { model: 'claude-haiku-5-5', effort: scenario.second } });
      // What the host sent on the second turn, and what the Router's record says it asked for: the same pairs.
      expect(requests.filter(r => r.turn === 1).map(r => `${r.model}:${r.effort}`), diagnostic).toEqual(scenario.sent);
      expect(named, diagnostic).toEqual(scenario.sent);
      expect(records.filter(r => r.event === 'root_stop' && r.turn === decision.turn).map(r => `${r.index}:${r.reason}`), diagnostic).toEqual(scenario.reason === 'cost_allows' ? ['5:baseline_reach'] : []);
    } finally {
      api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
      rmSync(temp, { recursive: true, force: true });
    }
  }, 120_000);
});
