import { spawn, spawnSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJob } from '../../src/job.js';
import { saveApiKey } from '../../src/credentials.js';
import { choice } from '../router/fake-engine.js';

// Native CLI, native background completion and a real local Bash check. The only model is a local fixture HTTP server.
describe.skipIf(process.env['JEV_CLAUDE_E2E'] !== '1')('responsive installed Claude worker', () => {
  it.each([{ scenario: 'complete', functions: false }, { scenario: 'cancel', functions: false }, { scenario: 'complete', functions: true }, { scenario: 'cancel', functions: true }])('answers a second prompt during a delayed worker and settles its original result: $scenario / native policies $functions', async ({ scenario, functions }) => {
    const temp = mkdtempSync('/tmp/jev-background-runtime-');
    const home = join(temp, 'home'); const plugin = join(temp, 'plugin'); mkdirSync(home); mkdirSync(plugin); mkdirSync(join(home, '.claude'));
    const root = join(__dirname, '../..');
    const pack = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), temp], { encoding: 'utf8' }); expect(pack.status, pack.stderr).toBe(0);
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    expect(spawnSync('unzip', ['-q', join(temp, `jev-gate-${version}.zip`), '-d', plugin]).status).toBe(0);
    const manifestPath = join(plugin, '.claude-plugin/plugin.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.userConfig.routerEnabled.default = false; writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' } }));
    const mode = functions ? 'auto' : 'native';
    const cfg = join(temp, 'config.json'); writeFileSync(cfg, JSON.stringify({ version: 5, mode, admittedShape: 'single', workerIsolation: 'none', maxParallelWorkers: 1, guardAllowTools: [] }));
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE_|ANTHROPIC_|TYPESAFE_|JEV_|XDG_)/.test(name)));
    Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), JEV_GATE_CONFIG: cfg, JEV_GATE_STATE_DIR: join(temp, 'state'), JEV_GATE_MODE: mode, JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated', JEV_GATE_ONBOARDING: '0', JEV_DASHBOARD_NO_OPEN: '1', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: functions ? '1' : '0' });
    if (functions) saveApiKey(env, 'fake-local-background-jev-key');
    const command = "printf 'worker evidence\\n'";
    const report = JSON.stringify({ status: 'done', summary: 'original work verified', changed_files: [], interfaces: [], checks: [{ check_id: command, result: 'pass', note: 'observed command' }], blockers: [] });
    let mainCalls = 0; let workerCalls = 0; let allocationCalls = 0; let held: { res: ServerResponse; model: string } | undefined;
    const pairs: Array<{ model: unknown; effort: unknown }> = [];
    let output = ''; let session = ''; let originalPrompt: string | null = null; let questionSeenWhileRunning = false;
    let child: ReturnType<typeof spawn> | undefined;
    const answer = (res: ServerResponse, model: string, text: string, tool?: { name: string; id: string; input: unknown }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type: string, body: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(body)}\n\n`);
      event('message_start', { type: 'message_start', message: { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: tool.id, name: tool.name, input: {} } : { type: 'text', text: '' } });
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text } });
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      event('message_stop', { type: 'message_stop' }); res.end();
    };
    const api = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); let raw = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
      let body: Record<string, unknown>; try { body = JSON.parse(raw.toString()); } catch { res.end('{}'); return; }
      if (req.url === '/jev') {
        const questions = body['questions'] as Record<string, { type: string; criteria: string[] | Record<string, string> }>;
        if (questions['model']) allocationCalls++;
        const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, q.type === 'noul' ? { type: 'noul', noul: .1 } : q.type === 'choice' ? choice(Object.keys(q.criteria), [name === 'model' ? '__keep__' : name === 'control' ? 'task_clear' : name === 'action_risk' ? 'ordinary' : Object.keys(q.criteria)[0]!, .99]) : { type: 'score', probabilities: Object.fromEntries((q.criteria as string[]).map((s, i) => [i, s.startsWith('Strong reasoning') ? 1 : 0])) }]));
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body['model'], answers })); return;
      }
      if (req.url?.includes('count_tokens')) { res.end('{"input_tokens":10}'); return; }
      if (!req.url?.includes('/v1/messages')) { res.end('{}'); return; }
      const model = String(body['model']);
      const worker = JSON.stringify((body['messages'] as unknown[])?.[0]).includes('BACKGROUND_WORKER_FIXTURE');
      if (worker) {
        pairs.push({ model, effort: (body['output_config'] as Record<string, unknown>)?.['effort'] });
        if (++workerCalls === 1) held = { res, model };
        else answer(res, model, report);
        return;
      }
      mainCalls++;
      if (mainCalls === 1) answer(res, model, '', { name: 'Agent', id: 'dispatch_fixture', input: { subagent_type: 'jev-gate:worker', description: 'Native delayed worker', prompt: 'BACKGROUND_WORKER_FIXTURE', run_in_background: false } });
      else if (mainCalls === 2) {
        const job = readJob(env, session); if (job.ok && job.value) originalPrompt = job.value.current.prompt_id;
        answer(res, model, 'MAIN_READY');
        setTimeout(() => child!.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Explain this feature while the original worker continues.' } }) + '\n'), 50);
      } else if (mainCalls === 3) {
        const job = readJob(env, session);
        questionSeenWhileRunning = !!(held && job.ok && job.value?.current.prompt_id === originalPrompt && Object.keys(job.value.current.active).length === 1 && job.value.current.receipts.length === 0 && job.value.current.outcome === null);
        answer(res, model, 'SECOND_QUESTION_ANSWERED');
        setTimeout(() => { if (scenario === 'cancel') child!.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Cancel the original worker now.' } }) + '\n'); else if (held) answer(held.res, held.model, '', { name: 'Bash', id: 'worker_check', input: { command, description: 'Run the actual fixture check' } }); }, 300);
      } else if (scenario === 'cancel' && mainCalls === 4) {
        const job = readJob(env, session); const agentId = job.ok && job.value ? job.value.current.active['dispatch_fixture']?.background_execution?.agent_id : null;
        answer(res, model, '', { name: 'TaskStop', id: 'cancel_fixture', input: { task_id: agentId } });
      } else { answer(res, model, scenario === 'cancel' ? 'ORIGINAL_WORKER_CANCELLED' : 'ORIGINAL_RESULT_ACCEPTED'); setTimeout(() => child!.stdin!.end(), 100); }
    });
    await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
    const client = join(plugin, 'dist/jev.js'); writeFileSync(client, readFileSync(client, 'utf8').replace('https://api.typesafe.ai/v1/systemone', `http://127.0.0.1:${(api.address() as { port: number }).port}/jev`));
    try {
      const result = await new Promise<number | null>((resolve, reject) => {
        child = spawn('claude', ['--plugin-dir', plugin, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5', '--allowedTools', 'Agent', 'Bash', 'TaskStop'], { env: { ...env, ANTHROPIC_API_KEY: 'fake-local-model-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.address() as { port: number }).port}` }, cwd: temp });
        child.stdout!.on('data', c => { output += String(c); const match = /"session_id":"([a-f0-9-]+)"/.exec(output); if (match) session = match[1]!; });
        child.stderr!.on('data', c => { output += String(c); });
        child.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Run the original fixture work in a worker.' } }) + '\n');
        const timer = setTimeout(() => child!.kill('SIGKILL'), 30_000);
        child.on('error', e => { clearTimeout(timer); reject(e); }); child.on('close', code => { clearTimeout(timer); resolve(code); });
      });
      expect(result, output.slice(-8000)).toBe(0); expect(questionSeenWhileRunning, JSON.stringify({ output: output.slice(0, 16000) })).toBe(true);
      if (functions) { expect(allocationCalls).toBe(1); expect(pairs.length).toBeGreaterThan(0); for (const pair of pairs) expect(pair).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' }); }
      const state = readJob(env, session); expect(state.ok && state.value).toBeTruthy(); if (!state.ok || !state.value) throw new Error('state absent');
      expect(state.value.current.prompt_id).toBe(originalPrompt); expect(state.value.current.receipts, JSON.stringify({ state: state.value.current, output: output.slice(-18000) })).toHaveLength(1);
      if (scenario === 'cancel') {
        expect(state.value.current.receipts[0]?.verdict).not.toBe('accept'); expect(state.value.current.active).toEqual({}); expect(state.value.current.outcome).toBe('incomplete'); return;
      }
      expect(state.value.current.receipts[0], JSON.stringify({ receipt: state.value.current.receipts[0], output: output.slice(-18000) })).toMatchObject({ verdict: 'accept', verification: { transcript: 'read', contradicted: [], unobserved: [], stale: [] } });
      expect(state.value.current.active).toEqual({}); expect(state.value.current.outcome).toBe('completed');
      expect(output.indexOf('SECOND_QUESTION_ANSWERED')).toBeLessThan(output.indexOf('original work verified'));
    } finally {
      child?.kill('SIGKILL'); api.closeAllConnections(); await new Promise<void>(r => api.close(() => r())); rmSync(temp, { recursive: true, force: true });
    }
  }, 45_000);
});
