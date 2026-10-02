import { spawn, spawnSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { choice } from '../router/fake-engine.js';
import { saveApiKey } from '../../src/credentials.js';
import { readJob } from '../../src/job.js';

// Exercise the real Agent validator BEFORE the native agent.spawn boundary. A direct Function Hooks kit call misses it.
describe.skipIf(process.env['JEV_CLAUDE_E2E'] !== '1')('installed Claude Gate B model dispatch', () => {
  it.each([
    { scope: 'worker', selected: '__keep__', actual: 'claude-haiku-4-5', effort: undefined, allowFable: false, admission: true },
    { scope: 'worker', selected: '__keep__', actual: 'claude-haiku-4-5', effort: undefined, allowFable: false, admission: true, documentation: true },
    { scope: 'worker', selected: '__keep__', actual: 'claude-sonnet-5-5', effort: 'high', allowFable: false },
    { scope: 'worker', selected: 'claude-opus-5', actual: 'claude-opus-5', effort: 'high', allowFable: false },
    { scope: 'worker', selected: 'claude-opus-5-5', actual: 'claude-opus-5-5', effort: 'max', allowFable: false },
    { scope: 'worker', selected: 'claude-haiku-4-5-20251001', actual: 'claude-haiku-4-5-20251001', effort: undefined, allowFable: false },
    { scope: 'worker', selected: 'claude-fable-5-1', actual: 'claude-fable-5-1', effort: 'max', allowFable: true },
    { scope: 'root', selected: 'claude-sonnet-5-5', actual: 'claude-sonnet-5-5', effort: 'high', allowFable: false },
    { scope: 'root', selected: 'claude-sonnet-5-5', actual: 'claude-sonnet-5-5', effort: 'high', allowFable: false, probability: .7 },
    { scope: 'root', selected: 'claude-sonnet-5-5', actual: 'claude-sonnet-5-5', effort: 'high', allowFable: false, incoming: 'max', splitEffort: true },
    { scope: 'root', selected: 'claude-haiku-4-5-20251001', actual: 'claude-opus-5-5', effort: 'high', allowFable: false },
    { scope: 'root', selected: 'claude-sonnet-5-5', actual: 'claude-sonnet-5-5', effort: 'medium', allowFable: false, sequence: [
      { selected: 'claude-sonnet-5-5', actual: 'claude-sonnet-5-5', effort: 'medium' },
      { selected: 'claude-sonnet-5-5', actual: 'claude-sonnet-5-5', effort: 'medium' },
      { selected: 'claude-opus-5-5', actual: 'claude-opus-5-5', effort: 'max' },
    ] },
    { scope: 'root', selected: 'claude-sonnet-5-5', actual: 'claude-sonnet-5-5', effort: 'medium', allowFable: false, sequence: [
      { selected: 'claude-sonnet-5-5', actual: 'claude-sonnet-5-5', effort: 'medium' },
      { selected: 'claude-haiku-4-5-20251001', actual: 'claude-opus-5-5', effort: 'high' },
      { selected: 'claude-opus-5-5', actual: 'claude-opus-5-5', effort: 'max' },
    ] },
  ])('sends the selected pair through the native $scope boundary: $selected', async scenario => {
    const temp = mkdtempSync('/tmp/jev-agent-model-runtime-'); const root = join(__dirname, '../..');
    const home = join(temp, 'home'); const plugin = join(temp, 'plugin'); mkdirSync(home); mkdirSync(plugin); mkdirSync(join(home, '.claude'));
    const packed = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), temp], { encoding: 'utf8' }); expect(packed.status, packed.stderr).toBe(0);
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    expect(spawnSync('unzip', ['-q', join(temp, `jev-gate-${version}.zip`), '-d', plugin]).status).toBe(0);
    const manifestPath = join(plugin, '.claude-plugin/plugin.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.userConfig.routerEnabled.default = scenario.scope === 'root'; manifest.userConfig.routerAllowFable.default = scenario.allowFable;
    if (scenario.scope === 'root') manifest.userConfig.gateMode.default = 'off';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    // Automatic admission uses the supported background runtime. Pinning the legacy foreground
    // environment here can race the host's settings reload and miss Gate's dispatch ownership.
    const backgroundDisabled = scenario.admission ? '0' : '1';
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: backgroundDisabled } }));
    const cfg = join(temp, 'config.json'); writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'auto', delegationDepthFloor: 0, admittedShape: 'single', workerIsolation: 'none', maxParallelWorkers: 1, guardAllowTools: [] }));
    const trace = join(temp, 'trace'); const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([n]) => !/^(CLAUDE_|ANTHROPIC_|TYPESAFE_|JEV_|XDG_)/.test(n)));
    Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), JEV_GATE_CONFIG: cfg, JEV_GATE_STATE_DIR: join(temp, 'state'), JEV_GATE_MODE: 'auto', JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated', JEV_GATE_ONBOARDING: '0', JEV_DASHBOARD_NO_OPEN: '1', JEV_GATE_TRACE_DIR: trace, TYPESAFE_API_KEY: 'fake-local-jev-key', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: backgroundDisabled });
    saveApiKey(env, 'fake-local-jev-key');
    if (scenario.scope === 'root') env.JEV_GATE_MODE = 'off';
    if (scenario.admission) { delete env.JEV_GATE_EXPERIMENT_ADMISSION; mkdirSync(join(temp, 'src')); writeFileSync(join(temp, 'src/lookup.ts'), 'export function parseRecord() {}\nparseRecord();\n'); }
    if (scenario.documentation) writeFileSync(join(temp, 'PR.md'), 'Obsolete PR description\n');
    // Fable authorization must propagate from the native plugin option, not a fixture-only env override.
    const allocations: Record<string, unknown>[] = []; const admissions: Record<string, unknown>[] = []; const workerRequests: Array<{ model: string; output_config?: { effort?: string } }> = []; const toolResults: unknown[] = []; let mainCalls = 0; let output = '';
    const documentWrite = `node -e 'const fs=require("node:fs");const source=fs.readFileSync("src/lookup.ts","utf8");if(!source.includes("export function parseRecord"))throw new Error("source mismatch");fs.writeFileSync("PR.md","Documents parseRecord in src/lookup.ts; no API behavior changes.\\n");process.stdout.write(fs.readFileSync("PR.md","utf8"))'`;
    const documentCheck = `node -e 'const fs=require("node:fs");if(!fs.readFileSync("src/lookup.ts","utf8").includes("export function parseRecord")||fs.readFileSync("PR.md","utf8")!=="Documents parseRecord in src/lookup.ts; no API behavior changes.\\n")throw new Error("description mismatch");console.log("PR description verified")'`;
    const answer = (res: ServerResponse, model: string, text: string, tool?: unknown) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      event('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'fixture_dispatch', name: scenario.scope === 'root' || typeof (tool as Record<string, unknown>).command === 'string' ? 'Bash' : 'Agent', input: {} } : { type: 'text', text: '' } });
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool) } : { type: 'text_delta', text } });
      event('content_block_stop', { type: 'content_block_stop', index: 0 }); event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }); event('message_stop', { type: 'message_stop' }); res.end();
    };
    const api = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part)); let raw = Buffer.concat(chunks); if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
      let body: Record<string, any>; try { body = JSON.parse(raw.toString()); } catch { res.end('{}'); return; }
      if (req.url === '/jev') {
        if (body.questions.model) allocations.push(body);
        if (body.questions.bounded_tool_work) admissions.push(body);
        const selection = scenario.sequence?.[allocations.length - 1] ?? scenario;
        const answers = Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([name, q]) => {
          if (q.type === 'noul') return [name, { type: 'noul', noul: .1 }];
          if (name === 'tool_calls') return [name, { type: 'score', score: 1, confidence: 1, probabilities: Object.fromEntries(q.criteria.map((_: string, i: number) => [i, i === 1 ? 1 : 0])) }];
          if (q.type === 'choice') return [name, choice(Object.keys(q.criteria), [name === 'model' ? selection.selected in q.criteria ? selection.selected : '__keep__' : name === 'control' ? 'task_clear' : name === 'action_risk' ? 'ordinary' : Object.keys(q.criteria)[0]!, name === 'model' ? scenario.probability ?? .99 : .99])];
          const at = (q.criteria as string[]).findIndex(s => s.startsWith(selection.effort === 'max' ? 'Maximum sustained' : selection.effort === 'medium' ? 'Ordinary reasoning' : 'Strong reasoning'));
          if (scenario.splitEffort) return [name, { type: 'score', probabilities: Object.fromEntries(q.criteria.map((s: string, i: number) => [i, s.startsWith('Ordinary reasoning') ? .45 : i === at ? .55 : 0])) }];
          return [name, { type: 'score', probabilities: Object.fromEntries(q.criteria.map((_: string, i: number) => [i, i === at ? 1 : 0])) }];
        })); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 30, output_tokens: 10 } })); return;
      }
      if (req.url?.includes('count_tokens')) { res.end('{"input_tokens":10}'); return; }
      if (!req.url?.includes('/v1/messages')) { res.end('{}'); return; }
      for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'tool_result') toolResults.push(block.content);
      if (scenario.scope === 'root') {
        workerRequests.push(body as { model: string; output_config?: { effort?: string } });
        if (scenario.actual.includes('haiku')) expect(body.thinking?.type).not.toBe('adaptive');
        answer(res, body.model, 'MAIN_FINISHED', ++mainCalls % 2 === 1 ? { command: "printf 'observed fixture\\n'", description: 'Observe a real tool step' } : undefined);
      }
      else if (JSON.stringify(body.messages?.[0]).includes('AGENT_MODEL_FIXTURE')) {
        workerRequests.push(body as { model: string; output_config?: { effort?: string } });
        const tool = !scenario.admission ? undefined : scenario.documentation ? workerRequests.length === 1 ? { command: documentWrite, description: 'Update the local PR description fixture against current source' } : workerRequests.length === 2 ? { command: documentCheck, description: 'Verify the updated description after the write' } : undefined : workerRequests.length === 1 ? { command: "rg -n --with-filename 'parseRecord' src/lookup.ts", description: 'Find exact declarations and callers' } : undefined;
        answer(res, body.model, JSON.stringify({ status: 'done', summary: scenario.documentation ? 'Updated PR.md against src/lookup.ts' : 'src/lookup.ts:1 declaration, src/lookup.ts:2 caller', changed_files: scenario.documentation ? ['PR.md'] : [], interfaces: [], checks: scenario.documentation ? [{ check_id: documentCheck, result: 'pass' }] : [], blockers: [] }), tool);
      }
      else if (scenario.admission && mainCalls === 0) { mainCalls++; answer(res, body.model, 'PRIMED'); }
      else answer(res, body.model, 'MAIN_FINISHED', ++mainCalls === (scenario.admission ? 2 : 1) ? { subagent_type: scenario.admission ? 'jev-gate:worker-fast' : 'jev-gate:worker', description: 'Native model allocation', prompt: 'AGENT_MODEL_FIXTURE', run_in_background: false } : undefined);
    });
    await new Promise<void>(r => api.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    // Redirect only the unpacked fixture transport; production still uses its fixed endpoint.
    const client = join(plugin, 'dist/jev.js'); writeFileSync(client, readFileSync(client, 'utf8').replace('https://api.typesafe.ai/v1/systemone', url + '/jev'));
    const routerClient = join(plugin, 'mods/router/hooks/client.ts'); writeFileSync(routerClient, readFileSync(routerClient, 'utf8').replace('https://api.typesafe.ai/v1/systemone', url + '/jev'));
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const prompt = scenario.documentation ? 'PR 본문 지금 코드에 맞게 고쳐줘' : scenario.admission ? 'Find all parseRecord declarations and callers in src/lookup.ts. Return paths and line numbers. Do not edit.' : scenario.scope === 'root' ? 'Run the stated local printf check and explain the result.' : 'Use the worker for this fixture.';
        const child = spawn('claude', ['--plugin-dir', plugin, '-p', ...(scenario.sequence || scenario.admission ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'] : [prompt]), '--model', 'claude-opus-5-5', '--effort', scenario.incoming ?? 'xhigh', '--max-turns', '4', '--allowedTools', scenario.scope === 'root' ? 'Bash' : scenario.admission ? 'Agent,Bash' : 'Agent'], { env: { ...env, ANTHROPIC_API_KEY: 'fake-local-model-key', ANTHROPIC_BASE_URL: url }, cwd: temp });
        let buffered = ''; let completed = 0;
        const send = (text: string) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
        if (scenario.sequence || scenario.admission) send(scenario.admission ? 'Reply READY.' : prompt); else child.stdin.end();
        child.stdout.on('data', c => { output += c; if (!scenario.sequence && !scenario.admission) return; buffered += String(c); let end: number;
          while ((end = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, end); buffered = buffered.slice(end + 1); let row: any; try { row = JSON.parse(line); } catch { continue; }
            if (row.type === 'result') { if (scenario.admission) { if (++completed === 1) send(prompt); else { const job = readJob(env, row.session_id); if (job.ok && job.value?.current.outcome === 'completed') child.stdin.end(); } continue; } if (++completed < scenario.sequence!.length) send(completed === 1 ? 'Continue: locate the exact file and run the local printf check.' : 'Continue: investigate the concurrency failure while preserving the API; run the local printf check.'); else child.stdin.end(); }
          }
        }); child.stderr.on('data', c => { output += c; }); const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
        child.on('error', e => { clearTimeout(timer); reject(e); }); child.on('close', code => { clearTimeout(timer); resolve(code); });
      });
      const traces = readdirSync(trace).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8')));
      const diagnostic = JSON.stringify({ output, toolResults, workers: workerRequests.map(r => ({ model: r.model, effort: r.output_config?.effort })), traces: traces.filter(r => r.phase === 'mod_router' || r.phase === 'pre_result' || r.phase === 'admission_result' || r.phase.startsWith('background_')) });
      expect(code, diagnostic).toBe(0); expect(allocations, diagnostic).toHaveLength(scenario.sequence?.length ?? 1); expect(workerRequests, diagnostic).toHaveLength(scenario.documentation ? 3 : scenario.sequence ? 6 : scenario.scope === 'root' || scenario.admission ? 2 : 1);
      for (const [i, request] of workerRequests.entries()) { const expected = scenario.sequence?.[Math.floor(i / 2)] ?? scenario; expect(request.model, diagnostic).toBe(expected.actual); expect(request.output_config?.effort, diagnostic).toBe(expected.effort); }
      if (scenario.admission) {
        expect(admissions, diagnostic).toHaveLength(1);
        if (scenario.documentation) {
          expect(readFileSync(join(temp, 'PR.md'), 'utf8'), diagnostic).toBe('Documents parseRecord in src/lookup.ts; no API behavior changes.\n');
          expect(JSON.stringify(toolResults), diagnostic).toContain('Documents parseRecord');
        } else { expect(JSON.stringify(toolResults), diagnostic).toContain('src/lookup.ts:1:'); expect(JSON.stringify(toolResults), diagnostic).toContain('src/lookup.ts:2:'); }
        const admission = traces.find(r => r.phase === 'admission_result' && r.attempted);
        expect(admission, diagnostic).toMatchObject({ policy_basis: 'bounded_tool_worker', selected_execution: 'single', attempted: true });
        expect(traces, diagnostic).toContainEqual(expect.objectContaining({ phase: 'background_terminal', status: 'completed', execution_prompt_id: admission.prompt_id }));
        const job = readJob(env, admission.session_id);
        expect(job.ok && job.value?.current.prompt_id, diagnostic).toBe(admission.prompt_id);
        expect(job.ok && job.value?.current.active, diagnostic).toEqual({});
        expect(job.ok && job.value?.current.receipts, diagnostic).toEqual([expect.objectContaining({ verdict: 'accept' })]);
      }
      if (scenario.scope === 'root') {
        const router = traces.filter(r => r.phase === 'mod_router');
        expect(router.filter(r => r.event === 'root'), diagnostic).toHaveLength(scenario.sequence?.length ?? 1);
        expect(router.filter(r => r.event === 'root_result').length, diagnostic).toBe(scenario.sequence ? 6 : 2);
        expect(new Set(router.filter(r => r.event === 'root').map(r => r.turn)).size, diagnostic).toBe(scenario.sequence?.length ?? 1);
        expect(new Set(router.map(r => r.session_id)).size, diagnostic).toBe(1);
        expect(router.some(r => r.scope === 'child'), diagnostic).toBe(false);
        expect(toolResults.some(v => JSON.stringify(v).includes('observed fixture')), diagnostic).toBe(true);
      }
      expect(output).not.toContain('schema validation'); expect(diagnostic).not.toContain('fake-local-jev-key');
    } finally { api.closeAllConnections(); await new Promise<void>(r => api.close(() => r())); rmSync(temp, { recursive: true, force: true }); }
  }, 40_000);
});
