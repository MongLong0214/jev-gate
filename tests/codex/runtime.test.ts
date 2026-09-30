import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadActivity } from '../../src/activity.js';

// Real Codex process + real plugin + real MCP + fake local model. Never uses a model key/login.
// Explicit opt-in: this exercises Codex's installer and removes only its uniquely named test installation.
const required = process.env['JEV_CODEX_E2E'] === '1';
const root = join(__dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'jev-codex-runtime-'));
const plugin = join(tmp, 'plugin with spaces');
const workspace = join(tmp, 'workspace');
const market = `jev-test-${Date.now()}`;
const log = `\n RUN  v5.0.1 /fixture\n\n${'fixture repeat detail\n'.repeat(100)} ✓ a.test.ts (1 test) 1ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n   Start at  10:20:30\n   Duration  10ms\n`;
let installed = false;
let marketAdded = false;
const isolation: string[] = [];
afterAll(() => {
  if (installed) {
    const removed = spawnSync('codex', ['plugin', 'remove', `jev-gate@${market}`], { encoding: 'utf8', timeout: 15_000 });
    expect(removed.status, removed.stderr).toBe(0);
  }
  if (marketAdded) {
    const removed = spawnSync('codex', ['plugin', 'marketplace', 'remove', market], { encoding: 'utf8', timeout: 15_000 });
    expect(removed.status, removed.stderr).toBe(0);
  }
  rmSync(tmp, { recursive: true, force: true });
});

type Rec = Record<string, unknown>;
const functions = (tools: unknown): Rec[] => Array.isArray(tools) ? tools.flatMap(t => t && typeof t === 'object'
  ? (t as Rec)['type'] === 'namespace' ? functions((t as Rec)['tools']).map(f => ({ ...f, namespace: (t as Rec)['name'] })) : [t as Rec] : []) : [];

describe.skipIf(!required)('real Codex native plugin runtime', () => {
  beforeAll(() => {
    const available = spawnSync('codex', ['--version'], { encoding: 'utf8' });
    expect(available.status, 'Install Codex CLI 0.158.0+ to run the native runtime tests').toBe(0);
    // Keep existing user hooks and MCPs out of this disposable, scripted-model invocation.
    const userHooks = join(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'hooks.json');
    const hookStates: string[] = [];
    if (existsSync(userHooks)) {
      const parsed = JSON.parse(readFileSync(userHooks, 'utf8')) as { hooks?: Record<string, Array<{ hooks: unknown[] }>> };
      for (const [event, groups] of Object.entries(parsed.hooks ?? {})) groups.forEach((group, i) => group.hooks.forEach((_, j) => {
        const snake = event.replace(/[A-Z]/g, (c, index: number) => `${index ? '_' : ''}${c.toLowerCase()}`);
        hookStates.push(`${JSON.stringify(`${userHooks}:${snake}:${i}:${j}`)}={enabled=false}`);
      }));
    }
    if (hookStates.length) isolation.push(`hooks.state={${hookStates.join(',')}}`);
    const servers = spawnSync('codex', ['mcp', 'list', '--json'], { encoding: 'utf8', timeout: 10_000 });
    expect(servers.status).toBe(0);
    isolation.push(`mcp_servers={${(JSON.parse(servers.stdout) as Array<{name: string; transport: {type: string}}>).map(s => `${JSON.stringify(s.name)}={enabled=false,${s.transport.type === 'stdio' ? 'command="node"' : 'url="http://127.0.0.1:1"'}}`).join(',')}}`);
    const existing = spawnSync('codex', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 10_000 });
    expect(existing.status).toBe(0);
    const plugins = JSON.parse(existing.stdout) as { installed?: Array<{ pluginId: string }> };
    for (const p of plugins.installed ?? []) isolation.push(`plugins.${JSON.stringify(p.pluginId)}.enabled=false`);
    const staged = join(tmp, 'source');
    const stagedPlugin = join(staged, 'plugins/codex');
    cpSync(join(root, 'plugins/codex'), stagedPlugin, { recursive: true, filter: p => !p.includes('/dist/') && !p.endsWith('/dist') });
    const built = spawnSync(process.execPath, [join(root, 'scripts/build-codex.mjs'), join(stagedPlugin, 'dist')], { encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
    cpSync(join(root, 'package.json'), join(staged, 'package.json'));
    const packed = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), join(tmp, 'archives'), '--profile', 'codex', '--root', staged], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    const archive = readdirSync(join(tmp, 'archives')).find(f => f.endsWith('.zip'))!;
    mkdirSync(plugin);
    expect(spawnSync('unzip', ['-q', join(tmp, 'archives', archive), '-d', plugin]).status).toBe(0);
    mkdirSync(workspace); mkdirSync(join(workspace, '.bin'));
    expect(spawnSync('git', ['init', '-q'], { cwd: workspace }).status).toBe(0);
    writeFileSync(join(workspace, 'source.ts'), 'export const runtimeEvidenceNeedle = 42;\n');
    writeFileSync(join(workspace, '.bin/vitest'), `#!${process.execPath}\nconst text = ${JSON.stringify(log)}; const fail = process.argv.includes("fail"); process.stdout.write(fail ? text.replaceAll("1 passed", "1 failed") : text); process.exitCode = fail ? 1 : 0;\n`, { mode: 0o755 });
    const marketplace = JSON.parse(readFileSync(join(plugin, '.agents/plugins/marketplace.json'), 'utf8')) as Rec;
    marketplace['name'] = market;
    writeFileSync(join(plugin, '.agents/plugins/marketplace.json'), JSON.stringify(marketplace));
    const registered = spawnSync('codex', ['plugin', 'marketplace', 'add', plugin], { encoding: 'utf8', timeout: 20_000 });
    expect(registered.status, registered.stderr).toBe(0);
    marketAdded = true;
    const added = spawnSync('codex', ['plugin', 'add', `jev-gate@${market}`, '--json',
      '-c', `marketplaces.${JSON.stringify(market)}.source_type="local"`,
      '-c', `marketplaces.${JSON.stringify(market)}.source=${JSON.stringify(plugin)}`], { encoding: 'utf8', timeout: 20_000 });
    expect(added.status, added.stderr).toBe(0);
    installed = true;
  }, 60_000);

  const run = async (trust: boolean, scenario = 'passing'): Promise<{ requests: Rec[]; output: string; code: number | null; trace: string }> => {
    const requests: Rec[] = [];
    const trace = join(tmp, `${trust ? 'trusted' : 'untrusted'} ${scenario} traces`);
    if (scenario === 'recording-unavailable') writeFileSync(trace, 'not a directory');
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[]}'); return; }
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      let body: Buffer = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'zstd') {
        // Node 22.15+ / 24; the plugin itself still targets Node 22.
        const zlib = createRequire(import.meta.url)('node:zlib') as { zstdDecompressSync: (b: Buffer) => Buffer };
        body = zlib.zstdDecompressSync(body);
      }
      const request = JSON.parse(body.toString()) as Rec;
      requests.push(request);
      const tool = functions(request['tools']).find(t => String(t['name']).endsWith('jev_evidence'));
      const index = requests.length;
      const item: Rec = index === 1
        ? { id: `fc_${index}`, type: 'function_call', call_id: `call_${index}`, name: 'exec_command', arguments: JSON.stringify({ cmd: scenario === 'failed' ? 'vitest run fail' : 'vitest run', login: false, max_output_tokens: 8000 }) }
        : index === 2 && tool
          ? { id: `fc_${index}`, type: 'function_call', call_id: `call_${index}`, name: tool['name'], ...(tool['namespace'] ? { namespace: tool['namespace'] } : {}), arguments: JSON.stringify({ goal: 'Locate fixture evidence', exactSymbols: ['runtimeEvidenceNeedle'] }) }
          : { id: 'msg_final', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture complete', annotations: [] }] };
      const response = { id: `resp_${index}`, object: 'response', created_at: 1, model: 'jev-test-model', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const config = [
      ...isolation,
      'features.plugins=true', 'features.hooks=true',
      'model_provider="jev_test"', 'model="jev-test-model"', 'model_providers.jev_test.name="Local fixture"',
      `model_providers.jev_test.base_url="http://127.0.0.1:${address.port}/v1"`,
      'model_providers.jev_test.wire_api="responses"', 'model_providers.jev_test.requires_openai_auth=false',
      `marketplaces.${JSON.stringify(market)}.source_type="local"`,
      `marketplaces.${JSON.stringify(market)}.source=${JSON.stringify(plugin)}`,
      `plugins.${JSON.stringify(`jev-gate@${market}`)}.enabled=true`,
      `plugins.${JSON.stringify(`jev-gate@${market}`)}.mcp_servers.evidence.enabled=true`,
      'shell_environment_policy.inherit="all"',
    ];
    const args = ['--no-daemon', ...(trust ? ['--dangerously-bypass-hook-trust'] : []), 'exec', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--json', '-C', workspace, ...config.flatMap(c => ['-c', c]), 'Run the local fixture tools, then finish.'];
    let output = '';
    const child = spawn('codex', args, { env: { HOME: process.env['HOME'] ?? '', ...(process.env['CODEX_HOME'] ? { CODEX_HOME: process.env['CODEX_HOME'] } : {}), PATH: `${join(workspace, '.bin')}:${process.env['PATH'] ?? ''}`, JEV_CODEX_TRACE_DIR: trace, ...(scenario === 'missing-workspace' ? {} : { JEV_CODEX_WORKSPACE: workspace }), JEV_CODEX_ENABLED: scenario === 'hooks-disabled' ? '0' : '1', JEV_CODEX_OUTPUT: scenario === 'disabled' ? 'off' : 'on', CLAUDE_PROJECT_DIR: '/wrong-workspace', PWD: '/wrong-workspace' } });
    child.stdin.end(); child.stdout.on('data', b => { output += String(b); }); child.stderr.on('data', b => { output += String(b); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 40_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      return { requests, output, code, trace };
    } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };

  it('loads plugin MCP and trusted hooks, folds the actual model-visible result and records both paths', async () => {
    const result = await run(true);
    expect(result.code, result.output).toBe(0);
    expect(result.requests.length, result.output).toBeGreaterThanOrEqual(3);
    expect(functions(result.requests[0]!['tools']).some(t => String(t['name']).endsWith('jev_evidence')), result.output).toBe(true);
    expect(JSON.stringify(result.requests[0])).toContain('Find exact repository evidence with Jev');
    const second = JSON.stringify(result.requests[1]!['input']);
    expect(second.includes('100 times in a row'), JSON.stringify({records: existsSync(result.trace) ? readdirSync(result.trace).map(f => JSON.parse(readFileSync(join(result.trace, f), 'utf8'))) : [], errors: result.output.split('\n').filter(l => /hook|ERROR|WARN/i.test(l))})).toBe(true);
    expect(second).toContain('[jev-gate output]');
    const last = JSON.stringify(result.requests.at(-1)!['input']);
    expect(last).toContain('runtimeEvidenceNeedle');
    expect(last).not.toContain('/wrong-workspace');
    const records = readdirSync(result.trace).map(f => JSON.parse(readFileSync(join(result.trace, f), 'utf8')) as Rec);
    expect(records.some(r => r['phase'] === 'evidence_result')).toBe(true);
    expect(records.some(r => r['phase'] === 'codex_output' && r['applied'] === true)).toBe(true);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) expect(records.some(r => r['event'] === event), event).toBe(true);
    const snapshot = loadActivity({ traceDir: result.trace, debugDir: null, env: {}, host: 'codex' });
    expect(snapshot.operations.features.find(f => f.id === 'evidence')?.state).toBe('observed');
    expect(snapshot.operations.features.find(f => f.id === 'admission')?.state).toBe('unsupported');
    expect(JSON.stringify(records)).not.toContain('runtimeEvidenceNeedle');
    expect(JSON.stringify(snapshot)).not.toContain('fixture repeat detail');
  }, 60_000);

  it('honors Codex hook trust: untrusted hooks do not fold or manufacture execution records', async () => {
    const result = await run(false);
    expect(result.code, result.output).toBe(0);
    expect(JSON.stringify(result.requests[1]?.['input'])).not.toContain('100 times in a row');
    const snapshot = loadActivity({ traceDir: result.trace, debugDir: null, env: {}, host: 'codex' });
    expect(snapshot.operations.features.find(f => f.id === 'output')?.count).toBe(0);
    expect(snapshot.operations.features.find(f => f.id === 'workers')?.count).toBe(0);
  }, 60_000);

  it.each(['failed', 'disabled'])('preserves actual model-visible output when %s', async scenario => {
    const result = await run(true, scenario);
    expect(result.code, result.output).toBe(0);
    const input = JSON.stringify(result.requests[1]?.['input']);
    expect(input).not.toContain('[jev-gate output]');
    expect(input.split('fixture repeat detail').length - 1).toBe(100);
    if (scenario === 'failed') expect(input).toContain('Process exited with code 1');
    const snapshot = loadActivity({ traceDir: result.trace, debugDir: null, env: {}, host: 'codex' });
    expect(snapshot.operations.features.find(f => f.id === 'workers')?.count).toBeGreaterThan(0);
    expect(snapshot.operations.features.find(f => f.id === 'output')?.count).toBe(scenario === 'disabled' ? 0 : 1);
  }, 60_000);

  it('refuses Evidence without an explicit workspace instead of searching the plugin cache or inherited PWD', async () => {
    const result = await run(true, 'missing-workspace');
    expect(result.code, result.output).toBe(0);
    const last = JSON.stringify(result.requests.at(-1)?.['input']);
    expect(last).toContain('unavailable_config');
    expect(last).not.toContain('export const runtimeEvidenceNeedle');
    const rows = readdirSync(result.trace).map(f => JSON.parse(readFileSync(join(result.trace, f), 'utf8')) as Rec);
    expect(rows.some(r => r['phase'] === 'evidence_result')).toBe(true);
  }, 60_000);

  it.each(['recording-unavailable', 'hooks-disabled'])('preserves native output and the separate MCP when %s', async scenario => {
    const result = await run(true, scenario);
    expect(result.code, result.output).toBe(0);
    const input = JSON.stringify(result.requests[1]?.['input']);
    expect(input).not.toContain('[jev-gate output]');
    expect(input.split('fixture repeat detail').length - 1).toBe(100);
    expect(JSON.stringify(result.requests.at(-1)?.['input'])).toContain('runtimeEvidenceNeedle');
    if (scenario === 'recording-unavailable') expect(readFileSync(result.trace, 'utf8')).toBe('not a directory');
    else {
      const rows = readdirSync(result.trace).map(f => JSON.parse(readFileSync(join(result.trace, f), 'utf8')) as Rec);
      expect(rows.some(r => r['phase'] === 'evidence_result')).toBe(true);
      expect(rows.some(r => String(r['phase']).startsWith('codex_'))).toBe(false);
    }
  }, 60_000);

});
