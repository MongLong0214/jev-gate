import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startCodexSession } from '../../src/codex/launch.js';

it.skipIf(process.env['JEV_CODEX_E2E'] !== '1')('matches native clean EOF, reset and cancellation outcomes to the exact request without replay (#404)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-native-terminal-'));
  writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n');});`, { mode: 0o755 });
  writeFileSync(join(root, 'policy.json'), '{}');
  let mode = ''; let sent = 0;
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'FIXTURE_DONE', annotations: [] }] };
  const created = 'data: ' + JSON.stringify({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } }) + '\n\n';
  const completed = 'data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) + '\n\n' + 'data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_fixture', model: 'gpt-6.1-sol', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }) + '\n\n';
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) { /* Only synthetic native requests. */ }
    if (!req.url?.endsWith('/responses')) { res.end('{"models":[]}'); return; }
    sent++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(created);
    if (mode.endsWith('reset')) setTimeout(() => res.destroy(), 50);
    else setTimeout(() => res.end(mode.includes('eof') ? '' : completed), mode === 'client_cut' ? 180 : 30);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  const session = await startCodexSession({ cwd: root, env: { HOME: root, PATH: root, JEV_GATE_ONBOARDING: '0', JEV_DASHBOARD_NO_OPEN: '1', JEV_CODEX_CONFIG: join(root, 'policy.json'), JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_TRACE_DIR: join(root, 'trace'), JEV_CODEX_UPSTREAM: origin }, connection: { token: 'a'.repeat(64), port: 0 } });
  await session.policy.externalHook({ hook_event_name: 'SessionStart', session_id: 's', cwd: root, model: 'gpt-6.1-sol' });
  await session.policy.externalHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: root, turn_id: 'p', prompt: 'Return the synthetic fixture marker.' });
  vi.spyOn(session.policy, 'requestSession').mockReturnValue('s');
  const submitted = vi.spyOn(session.policy, 'observeRequest'), failed = vi.spyOn(session.policy, 'observeRequestFailure'), cancelled = vi.spyOn(session.policy, 'observeRequestCancellation'), observed = vi.spyOn(session.policy, 'observeUsage');
  const proxy = session.url.replace('ws:', 'http:') + `/native/${session.token}`;
  const relay = createServer((req, res) => {
    const target = new URL(proxy + (req.url ?? ''));
    const next = request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, back => {
      res.writeHead(back.statusCode ?? 502, back.headers); back.pipe(res);
      setTimeout(() => res.destroy(), 30); back.on('error', () => res.destroy());
    });
    next.on('error', () => res.destroy()); res.on('close', () => { if (!res.writableEnded) next.destroy(); }); req.pipe(next);
  });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  try {
    for (const scenario of ['direct_healthy', 'proxy_healthy', 'direct_reset', 'proxy_reset', 'client_cut', 'proxy_eof']) {
      mode = scenario; submitted.mockClear(); failed.mockClear(); cancelled.mockClear(); observed.mockClear();
      const home = join(root, scenario); mkdirSync(home); const before = sent;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENAI_|CODEX_|JEV_|TYPESAFE_|ANTHROPIC_|CLAUDE_|XDG_)/.test(key)));
      Object.assign(env, { HOME: home, CODEX_HOME: home, XDG_CONFIG_HOME: join(home, 'config') });
      const base = scenario.startsWith('direct') ? origin : scenario === 'client_cut' ? `http://127.0.0.1:${(relay.address() as { port: number }).port}` : proxy;
      const child = spawn('codex', ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--model', 'gpt-6.1-sol', '-c', 'model_provider="fixture"', '-c', 'model_providers.fixture.name="Fixture"', '-c', `model_providers.fixture.base_url=${JSON.stringify(base)}`, '-c', 'model_providers.fixture.wire_api="responses"', '-c', 'model_providers.fixture.requires_openai_auth=false', '-c', 'model_providers.fixture.supports_websockets=false', '-c', 'model_providers.fixture.request_max_retries=0', '-c', 'model_providers.fixture.stream_max_retries=0', 'Return the synthetic fixture marker.'], { cwd: home, env });
      child.stdin.end(); let output = ''; child.stdout.on('data', b => { output += String(b); }); child.stderr.on('data', b => { output += String(b); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 18_000);
      let code: number | null;
      try { code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }); } finally { clearTimeout(timer); }
      const healthy = scenario.endsWith('healthy') || scenario.endsWith('completed');
      const diagnostic = JSON.stringify({ scenario, code, output });
      expect(code, diagnostic).toBe(healthy ? 0 : 1);
      expect(sent - before, diagnostic).toBe(1);
      if (healthy) expect(output, diagnostic).toContain('FIXTURE_DONE');
      else expect(output, diagnostic).toContain(scenario.includes('eof') ? 'stream closed before response.completed' : 'error decoding response body');
      if (scenario.startsWith('direct')) { expect(submitted).not.toHaveBeenCalled(); continue; }
      await vi.waitFor(() => expect(failed.mock.calls.length + cancelled.mock.calls.length + observed.mock.calls.length, diagnostic).toBe(1));
      expect(submitted, diagnostic).toHaveBeenCalledTimes(1);
      const exact = submitted.mock.results[0]?.value;
      expect(exact, diagnostic).toMatchObject({ requestId: expect.any(String), prompt: 'p' });
      if (healthy) { expect(observed.mock.calls[0]?.[2], diagnostic).toEqual(exact); expect(failed).not.toHaveBeenCalled(); expect(cancelled).not.toHaveBeenCalled(); }
      else if (scenario === 'client_cut') { expect(cancelled.mock.calls[0]?.[1], diagnostic).toEqual(exact); expect(failed).not.toHaveBeenCalled(); expect(observed).not.toHaveBeenCalled(); }
      else {
        expect(failed.mock.calls[0]?.[1], diagnostic).toEqual(exact);
        expect(failed.mock.calls[0]?.[2], diagnostic).toEqual({ stage: scenario.includes('eof') ? 'eof' : 'stream', status: 200, elapsed_ms: expect.any(Number) });
        expect(cancelled).not.toHaveBeenCalled(); expect(observed).not.toHaveBeenCalled();
      }
    }
  } finally {
    await session.close(); relay.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => relay.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
