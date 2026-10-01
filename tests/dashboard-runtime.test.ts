import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { ensureDashboard } from '../src/dashboard-launch.js';
import { setDashboard } from '../src/dashboard-settings.js';
import { credentialsDir, readPrivateJson } from '../src/credentials.js';

// Packaged detached child + native browser opener. Isolated homes, no owner's browser or credentials.
describe.skipIf(process.env['JEV_DASHBOARD_E2E'] !== '1')('packaged automatic dashboard', () => {
  it('opens once, reuses across hosts, recovers a stale lock and shuts down when switched off', async () => {
    const temp=mkdtempSync(join(tmpdir(),'jev-dashboard-runtime-'));const root=join(__dirname,'..');const home=join(temp,'home');mkdirSync(home);
    const env={HOME:home,XDG_CONFIG_HOME:join(home,'.config'),XDG_STATE_HOME:join(home,'.local/state'),PATH:join(temp,'bin')+':'+process.env.PATH};
    const opened=join(temp,'opened.txt');mkdirSync(join(temp,'bin'));
    for(const name of ['open','xdg-open'])writeFileSync(join(temp,'bin',name),`#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`,{mode:0o700});
    const runtime=join(credentialsDir(env),'dashboard-runtime.json');
    try {
      const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
      for(const [profile,name]of [['legacy','jev-gate'],['codex','jev-gate-codex']]){
        const packed=spawnSync(process.execPath,[join(root,'scripts/pack.mjs'),temp,'--profile',profile!],{encoding:'utf8'});expect(packed.status,packed.stderr).toBe(0);
        const plugin=join(temp,profile!);mkdirSync(plugin);expect(spawnSync('unzip',['-q',join(temp,`${name}-${version}.zip`),'-d',plugin]).status).toBe(0);
      }
      mkdirSync(credentialsDir(env),{recursive:true,mode:0o700});writeFileSync(join(credentialsDir(env),'dashboard.lock'),'2147483647',{mode:0o600});
      const starts=await Promise.all([ensureDashboard(join(temp,'legacy'),env),ensureDashboard(join(temp,'codex'),env)]);expect(starts.some(Boolean)).toBe(true);
      const first=readPrivateJson(runtime)!;expect(first['url']).toMatch(/^http:\/\/127\.0\.0\.1:/);
      await vi.waitFor(()=>expect(existsSync(opened)).toBe(true));expect(readFileSync(opened,'utf8').trim().split('\n')).toHaveLength(1);
      expect(await ensureDashboard(join(temp,'codex'),env)).toBe(true);expect(readPrivateJson(runtime)?.['token']).toBe(first['token']);
      const page=await fetch(String(first['url']));expect(page.status).toBe(200);expect(await page.text()).toContain('now-strip');
      expect(readFileSync(opened,'utf8').trim().split('\n')).toHaveLength(1);
      setDashboard(env,false);await vi.waitFor(()=>expect(readPrivateJson(runtime)).toBeNull(),{timeout:5000});
      expect(await ensureDashboard(join(temp,'legacy'),env)).toBe(false);
    } finally {
      const state=readPrivateJson(runtime);if(state?.['url'])await fetch(`${state['url']}api/shutdown`,{method:'POST',headers:{authorization:`Bearer ${state['token']}`}}).catch(()=>undefined);
      rmSync(temp,{recursive:true,force:true});
    }
  },15000);
  it.each(['legacy', 'codex'])('starts the dashboard from the actual %s packaged MCP entrypoint', async profile => {
    const temp = mkdtempSync(join(tmpdir(), 'jev-mcp-dashboard-'));
    const root = join(__dirname, '..'), home = join(temp, 'home'), plugin = join(temp, 'plugin'), bin = join(temp, 'bin');
    mkdirSync(home); mkdirSync(plugin); mkdirSync(bin);
    const opened = join(temp, 'opened.txt');
    for (const name of ['open', 'xdg-open']) writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`, { mode: 0o700 });
    const env = { HOME: home, PATH: bin + ':' + process.env.PATH, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
      TYPESAFE_API_KEY: 'local-test-key', CLAUDE_PLUGIN_ROOT: plugin, JEV_CODEX_AUTO_CONNECT: '0', JEV_CODEX_WORKSPACE: root };
    const runtime = join(credentialsDir(env), 'dashboard-runtime.json');
    const client = new Client({ name: 'dashboard-runtime-test', version: '1' });
    try {
      const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
      const packed = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), temp, '--profile', profile], { encoding: 'utf8' });
      expect(packed.status, packed.stderr).toBe(0);
      const name = profile === 'codex' ? 'jev-gate-codex' : 'jev-gate';
      expect(spawnSync('unzip', ['-q', join(temp, `${name}-${version}.zip`), '-d', plugin]).status).toBe(0);
      const entry = profile === 'codex' ? join(plugin, 'dist/server.mjs') : join(plugin, 'plugins/evidence/dist/server.mjs');
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, ...(profile === 'codex' ? ['--codex'] : [])], cwd: root, env, stderr: 'pipe' }));
      await vi.waitFor(() => expect(readPrivateJson(runtime)?.['url']).toMatch(/^http:\/\/127\.0\.0\.1:/), { timeout: 6000 });
      const state = readPrivateJson(runtime)!;
      expect((await fetch(String(state['url']))).status).toBe(200);
      await vi.waitFor(() => expect(existsSync(opened)).toBe(true));
      expect(readFileSync(opened, 'utf8').trim().split('\n')).toEqual([state['url']]);
      await client.listTools(); // Dashboard startup must not corrupt the MCP protocol on stdout.
    } finally {
      await client.close().catch(() => undefined);
      setDashboard(env, false);
      await vi.waitFor(() => expect(readPrivateJson(runtime)).toBeNull(), { timeout: 5000 });
      rmSync(temp, { recursive: true, force: true });
    }
  }, 15000);

});
