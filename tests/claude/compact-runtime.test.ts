import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// Exercise the transcript writer with a local fake model, without login or owner configuration.
describe.skipIf(process.env['JEV_CLAUDE_E2E'] !== '1')('Claude manual compaction', () => {
  it('keeps the default-on digest across a manual compaction and another native resume', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'jev-manual-compact-'));
    const home = join(temp, 'home'); const config = join(home, '.claude'); const cwd = join(temp, 'project');
    mkdirSync(config, { recursive: true }); mkdirSync(cwd);
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ model: 'claude-sonnet-5', permissions: { allow: ['Read'] } }));
    for (let i = 0; i < 8; i++) writeFileSync(join(cwd, `note${i}.txt`), `Fixture ${i}\n${'working data\n'.repeat(1600)}\nFIXTURE_OLD_END_${i}\n`);
    let phase: 'prime' | 'compact' | 'resume' = 'prime'; let reads = 0;
    const requests: Array<{ phase: string; messages: string }> = [];
    const api = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let bytes = Buffer.concat(chunks); if (req.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
      const body = JSON.parse(bytes.toString() || '{}') as { messages?: unknown[]; tools?: Array<{ name: string }> };
      if (req.url?.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":100}'); return; }
      if (!req.url?.includes('/v1/messages')) { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
      requests.push({ phase, messages: JSON.stringify(body.messages ?? []) });
      res.setHeader('content-type', 'text/event-stream');
      const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const tool = phase === 'prime' && reads < 8 && body.tools?.some(t => t.name === 'Read'); const index = reads++;
      event('message_start', { type: 'message_start', message: { id: `msg_fixture_${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: `tool_fixture_${index}`, name: 'Read', input: {} } : { type: 'text', text: '' } });
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(cwd, `note${index}.txt`) }) } : { type: 'text_delta', text: 'fixture complete' } });
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      event('message_stop', { type: 'message_stop' }); res.end();
    });
    try {
      await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE_|ANTHROPIC_|TYPESAFE_|JEV_|XDG_)/.test(name)));
      Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(home, '.config'), ANTHROPIC_API_KEY: 'fake-native-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.address() as { port: number }).port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' });
      const session = randomUUID();
      const run = (extra: string[], prompt: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn('claude', ['--plugin-dir', join(__dirname, '../../mods/compact'), '--model', 'claude-sonnet-5', '--permission-mode', 'default', '--allowedTools', 'Read', ...extra, '-p', prompt], { cwd, env });
        child.stdin.end(); let output = '';
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
      });
      const prime = await run(['--session-id', session], 'Read the eight fixture notes, then finish.');
      expect(prime.code, prime.output).toBe(0);
      const original = requests.filter(r => r.phase === 'prime').at(-1)!.messages;
      expect(original).toContain('FIXTURE_OLD_END_0'); expect(original).toContain('FIXTURE_OLD_END_7');
      phase = 'compact'; const compact = await run(['--resume', session], '/compact');
      expect(compact.code, compact.output).toBe(0);
      expect(requests.filter(r => r.phase === 'compact')).toHaveLength(0);
      phase = 'resume'; const resumed = await run(['--resume', session], 'Reply fixture complete.');
      expect(resumed.code, resumed.output).toBe(0);
      const after = requests.filter(r => r.phase === 'resume').at(-1)!.messages;
      expect(after).toContain('[jev-gate compact]'); expect(after).not.toContain('FIXTURE_OLD_END_0');
      expect(after.length).toBeLessThan(original.length / 2);
    } finally {
      api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
      rmSync(temp, { recursive: true, force: true });
    }
  }, 80_000);
});
