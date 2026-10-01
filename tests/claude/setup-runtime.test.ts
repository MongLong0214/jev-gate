import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveApiKey } from '../../src/credentials.js';

// Real native initialization and dispatch with a local fake model: no paid inference, login, owner settings or cache mutation.
describe.skipIf(process.env['JEV_CLAUDE_E2E'] !== '1')('installed Claude initialization', () => {
  it('prepares a fresh host and creates a working snapshot through its native WorktreeCreate hook', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'jev-claude-setup-'));
    try {
      const root = join(__dirname, '../..'); const plugin = join(temp, 'installed plugin'); const home = join(temp, 'home');
      mkdirSync(plugin); mkdirSync(home);
      const packed = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), temp], { encoding: 'utf8' }); expect(packed.status, packed.stderr).toBe(0);
      const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
      expect(spawnSync('unzip', ['-q', join(temp, `jev-gate-${version}.zip`), '-d', plugin]).status).toBe(0);
      const config = join(home, '.claude'); mkdirSync(config);
      writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(.env)'] }, model: 'sonnet' }));
      const project = join(temp, 'project'); mkdirSync(project);
      const git = (args: string[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
      expect(git(['init']).status).toBe(0); writeFileSync(join(project, 'input.txt'), 'committed\n');
      expect(git(['add', '.']).status).toBe(0); expect(git(['commit', '-m', 'base']).status).toBe(0);
      writeFileSync(join(project, 'input.txt'), 'current working input\n'); writeFileSync(join(project, 'new.txt'), 'untracked input\n');
      const initialHead = git(['rev-parse', 'HEAD']).stdout; const initialStatus = git(['status', '--porcelain']).stdout;
      const log = join(temp, 'launch.jsonl');
      writeFileSync(join(plugin, 'record.mjs'), `import fs from 'node:fs';import {resolveApiKey} from './dist/credentials.js';for await(const c of process.stdin){}fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({functions:process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS,fork:process.env.CLAUDE_CODE_FORK_SUBAGENT,background:process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,key:!!resolveApiKey(process.env)})+'\\n');`);
      const hookFile = join(plugin, 'hooks/hooks.json'); const hooks = JSON.parse(readFileSync(hookFile, 'utf8'));
      hooks.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/record.mjs"' }] });
      const observed = join(temp, 'worktree.json');
      writeFileSync(join(plugin, 'worktree-record.mjs'), `import fs from 'node:fs';import {spawnSync} from 'node:child_process';import {join} from 'node:path';let input='';for await(const c of process.stdin)input+=c;const r=spawnSync(process.execPath,[join(process.env.CLAUDE_PLUGIN_ROOT,'dist/worktree-cli.js')],{input,encoding:'utf8'});if(r.status===0){const path=r.stdout.trim();fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({path,input:fs.readFileSync(join(path,'input.txt'),'utf8'),newFile:fs.readFileSync(join(path,'new.txt'),'utf8')}));process.stdout.write(r.stdout);}else{process.stderr.write(r.stderr);process.exitCode=1;}`);
      hooks.hooks.WorktreeCreate[0].hooks[0].command = 'node "${CLAUDE_PLUGIN_ROOT}/worktree-record.mjs"';
      writeFileSync(hookFile, JSON.stringify(hooks));
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE_|ANTHROPIC_|TYPESAFE_|JEV_|XDG_)/.test(name)));
      Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(home, '.config'), JEV_GATE_ONBOARDING: '0' });
      const run = (extra: string[] = []) => spawnSync('claude', ['--plugin-dir', plugin, ...extra, '--init-only'], { env, cwd: project, encoding: 'utf8', timeout: 25_000 });
      const first = run(); expect(first.status, first.stderr).toBe(0);
      const settings = JSON.parse(readFileSync(join(config, 'settings.json'), 'utf8'));
      expect(settings).toMatchObject({ permissions: { deny: ['Read(.env)'] }, model: 'sonnet', worktree: { baseRef: 'head' }, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } });
      saveApiKey(env, 'fake-claude-shared-key');
      const second = run(); expect(second.status, second.stderr).toBe(0);
      const rows = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.at(-1)).toEqual({ functions: '1', fork: '0', background: '1', key: true });
      expect(first.stdout + first.stderr + second.stdout + second.stderr + readFileSync(log, 'utf8')).not.toContain('fake-claude-shared-key');
      // --init-only exits before worktree creation. Exercise Agent isolation after the plugin loads, with an explicit fixture Agent permission.
      let modelCalls = 0; const toolNames: unknown[] = []; const toolResults: unknown[] = []; const paths: unknown[] = [];
      const api = createServer(async (req, res) => {
        paths.push(req.url); const chunks: Buffer[]=[]; for await (const part of req) chunks.push(Buffer.from(part)); let body=Buffer.concat(chunks); if(req.headers['content-encoding']==='gzip') body=gunzipSync(body); const raw=body.toString();
        try { const body=JSON.parse(raw); toolNames.push(body.tools?.map((t: {name:string})=>t.name)); for(const m of body.messages ?? []) for(const c of Array.isArray(m.content)?m.content:[]) if(c.type==='tool_result') toolResults.push(String(JSON.stringify(c.content)).slice(0,500)); } catch {} 
        if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return; }
        if (!req.url?.includes('/v1/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = (type: string, body: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(body)}\n\n`);
        event('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        const tool = ++modelCalls === 1;
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'tool_fixture', name: 'Agent', input: {} } : { type: 'text', text: '' } });
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ subagent_type: 'general-purpose', description: 'Check the working snapshot', prompt: 'Reply fixture complete.', isolation: 'worktree', run_in_background: false }) } : { type: 'text_delta', text: 'fixture complete' } });
        event('content_block_stop', { type: 'content_block_stop', index: 0 });
        event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
        event('message_stop', { type: 'message_stop' }); res.end();
      });
      await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
      try {
        const isolated = await new Promise<{ status: number | null; output: string }>((resolve, reject) => {
          const child = spawn('claude', ['--plugin-dir', plugin, '-p', 'Reply fixture complete.', '--model', 'claude-sonnet-5', '--max-turns', '3', '--permission-mode', 'default', '--allowedTools', 'Agent'], {
            cwd: project, env: { ...env, ANTHROPIC_API_KEY: 'fake-native-claude-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.address() as { port: number }).port}`, TYPESAFE_API_KEY: 'bad', JEV_GATE_MODE: 'auto', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
          });
          let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
          const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
          child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('close', status => { clearTimeout(timer); resolve({ status, output }); });
        });
        expect(isolated.status, isolated.output).toBe(0); expect(isolated.output).toContain('fixture complete');
      } finally { await new Promise<void>(resolve => { api.closeAllConnections(); api.close(() => resolve()); }); }
      expect(existsSync(observed), JSON.stringify({ modelCalls, paths, toolNames, toolResults })).toBe(true);
      expect(JSON.parse(readFileSync(observed, 'utf8'))).toMatchObject({ input: 'current working input\n', newFile: 'untracked input\n' });
      expect(git(['rev-parse', 'HEAD']).stdout).toBe(initialHead); expect(git(['status', '--porcelain']).stdout).toBe(initialStatus);
      const validate = spawnSync('claude', ['plugin', 'validate', join(plugin, '.claude-plugin/plugin.json'), '--strict'], { env, cwd: temp, encoding: 'utf8', timeout: 25_000 });
      expect(validate.status, validate.stdout + validate.stderr).toBe(0);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 65_000);
});
