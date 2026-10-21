import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const command = JSON.parse(readFileSync(new URL('../../plugins/codex/hooks/hooks.json', import.meta.url), 'utf8')).hooks.PreToolUse[0].hooks[0].command as string;
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'jev-hook-upgrade ')); homes.push(home);
  const base = join(home, 'plugins/cache/test-market/jev-gate');
  const bundle = (version: string) => {
    const root = join(base, version); mkdirSync(join(root, 'dist'), { recursive: true }); mkdirSync(join(root, '.codex-plugin'));
    writeFileSync(join(root, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'jev-gate', version }));
    writeFileSync(join(root, 'dist/hook.mjs'), `export async function runCodexHook({stdin}) { let input=''; for await(const chunk of stdin) input+=chunk; return {systemMessage:${JSON.stringify(version)}+':'+JSON.parse(input).hook_event_name}; }`);
    return root;
  };
  const old = bundle('0.8.31');
  const env = { PATH: process.env['PATH'], HOME: home, PLUGIN_ROOT: old };
  const run = () => spawnSync('/bin/sh', ['-c', command], { env, input: '{"hook_event_name":"PreToolUse"}', encoding: 'utf8', timeout: 5000 });
  return { home, old, bundle, run, env };
}
describe('hook command survives native cache pruning (#310)', () => {
  it('keeps its loaded version, then uses the sole installed replacement after deletion', () => {
    const f = fixture(); f.bundle('0.8.32');
    expect(f.run()).toMatchObject({ status: 0, stdout: '{"systemMessage":"0.8.31:PreToolUse"}\n', stderr: '' });
    rmSync(f.old, { recursive: true });
    expect(f.run()).toMatchObject({ status: 0, stdout: '{"systemMessage":"0.8.32:PreToolUse"}\n', stderr: '' });
  });
  it.each(['missing', 'ambiguous', 'wrong-plugin', 'corrupt'])('preserves native execution for %s bundles', kind => {
    const f = fixture(); rmSync(f.old, { recursive: true });
    if (kind !== 'missing') {
      const next = f.bundle('0.8.32');
      if (kind === 'ambiguous') f.bundle('0.8.33');
      if (kind === 'wrong-plugin') writeFileSync(join(next, '.codex-plugin/plugin.json'), '{"name":"other","version":"0.8.32"}');
      if (kind === 'corrupt') writeFileSync(join(next, 'dist/hook.mjs'), 'invalid syntax %');
    }
    expect(f.run()).toMatchObject({ status: 0, stdout: '{}\n', stderr: '' });
  });
  it('exits zero when the host has closed stdout', async () => {
    const f = fixture();
    const child = spawn('/bin/sh', ['-c', command], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', b => { stderr += String(b); });
    child.stdout.destroy(); child.stdin.end('{"hook_event_name":"PreToolUse"}');
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    expect(code).toBe(0); expect(stderr).toBe('');
  });
});
