import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexRpc } from '../../src/codex/rpc.js';
import { saveApiKey } from '../../src/credentials.js';

type Obj = Record<string, unknown>;
const root = join(__dirname, '../..');

describe.skipIf(process.env['JEV_CODEX_E2E'] !== '1')('ordinary native Codex automatic connection', () => {
  it('automatically configures the next native session, routes its actual request, and restores only owned settings on removal', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'jev-native-auto-'));
    const codexHome = join(temp, 'codex home'); const workspace = join(temp, 'working project');
    const plugin = join(temp, 'plugin'); const trace = join(temp, 'trace'); const preload = join(temp, 'fake-jev.mjs');
    mkdirSync(codexHome); mkdirSync(workspace);
    expect(spawnSync('git', ['init', '-q'], { cwd: workspace }).status).toBe(0);
    const requests: Obj[] = []; let mode = 'simple'; let step = 0;
    mkdirSync(join(workspace, '.bin'));
    const log = '\n RUN  v5.0.1 /fixture\n\n ✓ fixture.test.ts (1 test) 1ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n   Start at  10:20:30\n   Duration  10ms\n';
    writeFileSync(join(workspace, '.bin/vitest'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(log)});`, { mode: 0o755 });
    const flatten = (v: unknown): Obj[] => Array.isArray(v) ? v.flatMap(t => (t as Obj)['type'] === 'namespace' ? flatten((t as Obj)['tools']).map(f => ({ ...f, namespace: (t as Obj)['name'] })) : [t as Obj]) : [];
    const upstream = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += String(chunk);
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[],"data":[]}'); return; }
      const input = JSON.parse(body) as Obj; requests.push(input);
      const id = `response_${requests.length}`;
      const tools = [...flatten(input['tools']), ...(Array.isArray(input['input']) ? input['input'].flatMap(v => (v as Obj)['type'] === 'additional_tools' ? flatten((v as Obj)['tools']) : []) : [])];
      const final = (text: string): Obj => ({ type: 'message', id: `${id}_message`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
      const fn = (suffix: string, args: Obj): Obj => { const tool = tools.find(t => String(t['name']).endsWith(suffix)); return tool ? { type: 'function_call', id: `${id}_fn`, call_id: `${id}_call`, name: tool['name'], ...(tool['namespace'] ? { namespace: tool['namespace'] } : {}), arguments: JSON.stringify(args) } : { type: 'custom_tool_call', id: `${id}_fn`, call_id: `${id}_call`, name: 'exec', input: `text(await tools.${suffix === 'jev_agent' ? 'mcp__jev_gate_evidence__jev_agent' : suffix}(${JSON.stringify(args)}));` }; };
      let item = final('native fixture complete');
      if (mode === 'gate') {
        step++;
        if (step === 2) item = fn('exec_command', { cmd: 'touch guard-must-not-exist', login: false });
        if (step === 3) item = fn('jev_agent', { run_in_background: false, subagent_type: 'jev-gate:worker', prompt: 'Investigate the fixture and run vitest run.' });
        if (step === 4) item = fn('exec_command', { cmd: 'vitest run', login: false, max_output_tokens: 8000 });
        if (step === 5) item = final('```json\n' + JSON.stringify({ status: 'done', summary: 'Fixture checked', changed_files: [], interfaces: [], checks: [{ check_id: 'vitest run', result: 'pass', note: 'observed check' }], blockers: [] }) + '\n```');
      } else if (mode === 'lean') {
        step++;
        if (step === 1) item = final('Old unrelated narrative. '.repeat(300));
        if (step === 2) item = fn('jev_agent', { run_in_background: false, subagent_type: 'jev-gate:executor', prompt: JSON.stringify(input['input']).match(/jev-lean-[a-f0-9]{16}/)?.[0] ?? 'missing marker' });
        if (step === 3) item = fn('exec_command', { cmd: 'vitest run', login: false, max_output_tokens: 8000 });
      } else if (mode === 'compact') { step++; if (step === 1) item = final('Old unrelated narrative. '.repeat(6000)); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [{ type: 'response.created', response: { id, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 150000, output_tokens: 3, total_tokens: 150003 } } }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
    writeFileSync(preload, `const original=globalThis.fetch;globalThis.fetch=async(url,init)=>{if(String(url)!=='https://api.typesafe.ai/v1/systemone')return original(url,init);const r=JSON.parse(init.body);const answers={};for(const [k,q] of Object.entries(r.questions)){const score=k==='tool_calls'?4:k==='size'?2:0;const picks={work_shape:'sustained_task',handoff_scope:'self_contained',control:'task_clear',action_risk:'ordinary'};const pick=k.startsWith('relation_')?'omit':picks[k]??Object.keys(q.criteria??{})[0];answers[k]=q.type==='score'?{type:'score',score,confidence:1,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[i,i===score?1:0]))}:q.type==='noul'?{type:'noul',noul:0}:{type:'choice',choice:pick,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(v=>[v,v===pick?1:0]))};}return new Response(JSON.stringify({model:r.model,answers}),{headers:{'content-type':'application/json'}})};`);
    cpSync(join(root, 'plugins/codex'), plugin, { recursive: true, filter: p => !p.includes('/dist/') && !p.endsWith('/dist') });
    const built = spawnSync(process.execPath, [join(root, 'scripts/build-codex.mjs'), join(plugin, 'dist')], { encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
    const policyFile = join(temp, 'policy.json'); writeFileSync(policyFile, '{}');
    const fixtureEnv = { PATH: `${join(workspace, '.bin')}:${process.env['PATH'] ?? ''}`, XDG_CONFIG_HOME: join(temp, 'config'), JEV_GATE_ONBOARDING: '0', JEV_DASHBOARD_NO_OPEN: '1', JEV_CODEX_CONFIG: policyFile, JEV_GATE_STATE_DIR: join(temp, 'state'), JEV_CODEX_UPSTREAM: base, JEV_CODEX_CONNECTION_TEST_NO_AUTH: '1', NODE_OPTIONS: `--import ${preload}` };
    saveApiKey(fixtureEnv, 'fake-local-jev-key');
    const mcpFile = join(plugin, '.mcp.json'); const mcp = JSON.parse(readFileSync(mcpFile, 'utf8')) as { mcpServers: Record<string, Obj> };
    mcp.mcpServers['jev_gate_evidence']!['env'] = fixtureEnv;
    writeFileSync(mcpFile, JSON.stringify(mcp));
    const marketFile = join(plugin, '.agents/plugins/marketplace.json'); const market = JSON.parse(readFileSync(marketFile, 'utf8')) as Obj;
    market['name'] = 'jev-auto-fixture';
    writeFileSync(marketFile, JSON.stringify(market));
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome, JEV_CODEX_TRACE_DIR: trace, ...fixtureEnv };
    delete env['JEV_CODEX_WORKSPACE']; delete env['JEV_EVIDENCE_CONFIG']; delete env['JEV_CODEX_BRIDGE_URL']; delete env['JEV_CODEX_BRIDGE_TOKEN'];
    delete env['TYPESAFE_API_KEY']; delete env['CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY'];
    const cli = (args: string[]) => spawnSync('codex', args, { env, cwd: workspace, encoding: 'utf8', timeout: 20_000 });
    const config = join(codexHome, 'config.toml');
    writeFileSync(config, `# Preserve this owner comment\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\nopenai_base_url = ${JSON.stringify(base)}\n[shell_environment_policy]\ninherit = "all"\n[features]\nplugins = true\nhooks = true\n`);
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fake-local-native-key' }), { mode: 0o600 });
    const ownerPath = join(codexHome, 'jev-gate/connection/owner.json');
    let installed = false;
    const run = async (): Promise<{ code: number | null; output: string }> => {
      let output = '';
      const child = spawn('codex', ['--no-daemon', '--dangerously-bypass-hook-trust', 'exec', '--skip-git-repo-check', '--ephemeral', '--json', '-C', workspace, 'Explain this fixture in one line.'], { env, cwd: workspace });
      child.stdin.end(); child.stdout.on('data', b => { output += String(b); }); child.stderr.on('data', b => { output += String(b); });
      const timer = setTimeout(() => child.kill('SIGTERM'), 25_000);
      try { return { code: await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }), output }; } finally { clearTimeout(timer); }
    };
    try {
      const added = cli(['plugin', 'marketplace', 'add', plugin]); expect(added.status, added.stderr).toBe(0);
      const addedPlugin = cli(['plugin', 'add', 'jev-gate@jev-auto-fixture']); expect(addedPlugin.status, addedPlugin.stderr).toBe(0); installed = true;
      const warm = await run(); expect(warm.code, warm.output).toBe(0);
      expect(existsSync(ownerPath), warm.output).toBe(true);
      expect(readFileSync(config, 'utf8')).toContain('model_provider = "jev-gate-native"');
      const at = requests.length; const connected = await run(); expect(connected.code, connected.output).toBe(0);
      expect(requests.slice(at).some(r => (r['reasoning'] as Obj)?.['effort'] === 'low'), JSON.stringify({ requests: requests.slice(at), output: connected.output })).toBe(true);
      const rows = readdirSync(trace).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8')) as Obj);
      expect(rows.some(r => r['phase'] === 'codex_route_applied' && r['applied'] === true)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain('fake-local-');
      const previousOwner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid: number };
      process.kill(previousOwner.pid, 'SIGKILL');
      const recovered = await run(); expect(recovered.code, recovered.output).toBe(0);
      const recoveredOwner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid: number };
      expect(recoveredOwner.pid).not.toBe(previousOwner.pid);
      const concurrent = await Promise.all([run(), run()]);
      for (const result of concurrent) expect(result.code, result.output).toBe(0);
      expect((JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid: number }).pid).toBe(recoveredOwner.pid);
      // A normal App Server is the app/IDE backend. No Jev launcher, remote UI bridge or provider CLI override.
      const native = spawn('codex', ['--dangerously-bypass-hook-trust', 'app-server', '--stdio'], { env, cwd: workspace });
      let nativeErrors = ''; native.stderr.on('data', b => { nativeErrors += String(b); });
      const rpc = new CodexRpc(native.stdout, native.stdin); const events: Obj[] = [];
      rpc.onNotification = m => events.push(m);
      try {
        await rpc.request('initialize', { clientInfo: { name: 'ordinary-native-fixture', version: '1' }, capabilities: { experimentalApi: true } }); rpc.send({ method: 'initialized' });
        // Simulate the user's native hook trust approval only in this disposable Codex home.
        const listed = await rpc.request('hooks/list', { cwds: [workspace] });
        const hooks = (listed['data'] as Array<{ hooks: Obj[] }>).flatMap(v => v.hooks).filter(h => h['source'] === 'plugin');
        await rpc.request('config/batchWrite', { edits: hooks.map(h => ({ keyPath: `hooks.state.${JSON.stringify(h['key'])}`, value: { trusted_hash: h['currentHash'] }, mergeStrategy: 'upsert' })) });
        const turn = async (id: string, text: string): Promise<void> => {
          const at = events.length;
          await rpc.request('turn/start', { threadId: id, input: [{ type: 'text', text, text_elements: [] }] });
          const until = Date.now() + 20_000;
          while (!events.slice(at).some(m => m['method'] === 'turn/completed' && (m['params'] as Obj)['threadId'] === id) && Date.now() < until) await new Promise<void>(resolve => setTimeout(resolve, 20));
          expect(events.slice(at).some(m => m['method'] === 'turn/completed' && (m['params'] as Obj)['threadId'] === id), nativeErrors).toBe(true);
        };
        const start = async (): Promise<string> => String(((await rpc.request('thread/start', { cwd: workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' }))['thread'] as Obj)['id']);
        mode = 'gate'; step = 0; const gate = await start();
        await turn(gate, 'Seed the native context.');
        await turn(gate, 'Investigate the fixture and run vitest run.');
        expect(existsSync(join(workspace, 'guard-must-not-exist'))).toBe(false);
        const gateRows = readdirSync(trace).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8')) as Obj);
        expect(gateRows.some(r => r['phase'] === 'post'), nativeErrors).toBe(true);
        expect(JSON.stringify(requests.at(-1)?.['input']), nativeErrors).toContain('confirmed command pass 1');
        writeFileSync(policyFile, JSON.stringify({ gate: { mode: 'lean' } }));
        mode = 'lean'; step = 0; const lean = await start();
        await turn(lean, 'Seed the prior context.'); await turn(lean, 'Implement the fixture check in a fresh executor.');
        const leanRows = readdirSync(trace).map(f => JSON.parse(readFileSync(join(trace, f), 'utf8')) as Obj);
        expect(leanRows.some(r => r['session_id'] === lean && r['phase'] === 'lean_dispatch' && r['applied'] === true), nativeErrors).toBe(true);
        writeFileSync(policyFile, JSON.stringify({ gate: { mode: 'off' }, router: { enabled: false }, compact: { manual: true } }));
        mode = 'compact'; step = 0; const compact = await start();
        await turn(compact, 'Preserve the exact userConstraintNeedle.'); await turn(compact, 'Give a short answer.');
        const beforeCompact = requests.length; await rpc.request('thread/compact/start', { threadId: compact });
        const until = Date.now() + 10_000;
        while (!readdirSync(trace).some(f => f.startsWith('codex_compact') && JSON.parse(readFileSync(join(trace, f), 'utf8')).stage === 'installed') && Date.now() < until) await new Promise<void>(resolve => setTimeout(resolve, 20));
        expect(readdirSync(trace).some(f => f.startsWith('codex_compact') && JSON.parse(readFileSync(join(trace, f), 'utf8')).stage === 'installed'), nativeErrors).toBe(true);
        expect(requests.length).toBe(beforeCompact);
      } finally { rpc.close(); native.kill('SIGTERM'); }
      writeFileSync(config, readFileSync(config, 'utf8') + '\n# Owner edit while connected\n');
      const removed = cli(['plugin', 'remove', 'jev-gate@jev-auto-fixture']); expect(removed.status, removed.stderr).toBe(0); installed = false;
      const until = Date.now() + 10_000;
      while (readFileSync(config, 'utf8').includes('model_provider = "jev-gate-native"') && Date.now() < until) await new Promise<void>(resolve => setTimeout(resolve, 100));
      const restored = readFileSync(config, 'utf8');
      expect(restored).not.toContain('model_provider = "jev-gate-native"');
      expect(restored).toContain('model_reasoning_effort = "high"'); expect(restored).toContain('# Preserve this owner comment'); expect(restored).toContain('# Owner edit while connected');
    } finally {
      if (installed) cli(['plugin', 'remove', 'jev-gate@jev-auto-fixture']);
      if (existsSync(ownerPath)) { const state = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid: number }; try { process.kill(state.pid, 'SIGTERM'); } catch { /* Already exited after removal. */ } }
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 150_000);
});
