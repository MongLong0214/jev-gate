import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialsDir, credentialsPath, resolveApiKey, saveApiKey, withApiKey } from '../src/credentials.js';
import { claudeDefaults, prepareClaude } from '../src/claude-setup.js';
import { startOnboarding, type Onboarding } from '../src/onboarding.js';

const dirs: string[] = []; const pages: Onboarding[] = [];
const fixture = () => { const home = mkdtempSync(join(tmpdir(), 'jev-setup-')); dirs.push(home); return { HOME: home }; };
afterEach(async () => { for (const page of pages.splice(0)) await page.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('one Jev key for both installed hosts', () => {
  it('stores privately and resolves after a host restart without a shell export', () => {
    const env = fixture(); const key = 'fake-shared-jev-key'; saveApiKey(env, key);
    expect(resolveApiKey({ ...env, CODEX_HOME: join(env.HOME, 'codex') })).toBe(key);
    expect(resolveApiKey({ ...env, CLAUDE_CONFIG_DIR: join(env.HOME, 'claude') })).toBe(key);
    expect(withApiKey(env)['TYPESAFE_API_KEY']).toBe(key);
    expect(lstatSync(credentialsDir(env)).mode & 0o777).toBe(0o700);
    expect(lstatSync(credentialsPath(env)).mode & 0o777).toBe(0o600);
    saveApiKey(env, 'fake-replacement-key'); expect(resolveApiKey(env)).toBe('fake-replacement-key');
  });
  it('keeps explicit option/environment keys authoritative, including invalid inputs', () => {
    const env = fixture(); saveApiKey(env, 'fake-shared-key');
    expect(resolveApiKey({ ...env, TYPESAFE_API_KEY: 'fake-environment-key' })).toBe('fake-environment-key');
    expect(resolveApiKey({ ...env, TYPESAFE_API_KEY: 'fake-environment-key', CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY: 'fake-option-key' })).toBe('fake-option-key');
    expect(resolveApiKey({ ...env, TYPESAFE_API_KEY: 'invalid\nheader' })).toBeUndefined();
    expect(resolveApiKey({ ...env, CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY: 'bad', TYPESAFE_API_KEY: 'fake-valid-key' })).toBeUndefined();
    expect(resolveApiKey({ ...env, TYPESAFE_API_KEY: '' })).toBe('fake-shared-key');
  });
  it('refuses symlinks, readable credentials, malformed files and invalid keys', () => {
    const env = fixture(); saveApiKey(env, 'fake-shared-key');
    chmodSync(credentialsPath(env), 0o644); expect(resolveApiKey(env)).toBeUndefined();
    chmodSync(credentialsPath(env), 0o600); writeFileSync(credentialsPath(env), '{broken'); expect(resolveApiKey(env)).toBeUndefined();
    const outside = join(env.HOME, 'outside.json'); writeFileSync(outside, '{"apiKey":"fake-outside-key"}', { mode: 0o600 });
    rmSync(credentialsPath(env)); symlinkSync(outside, credentialsPath(env));
    expect(resolveApiKey(env)).toBeUndefined(); expect(() => saveApiKey(env, 'fake-new-key')).toThrow();
    expect(() => saveApiKey(env, 'key\r\nvalue')).toThrow(); expect(readFileSync(outside, 'utf8')).toContain('fake-outside-key');
  });
});

describe('Claude automatic initialization', () => {
  it('prepares a fresh installation once and preserves permissions, options and unrelated plugins', () => {
    const env = fixture(); const dir = join(env.HOME, '.claude'); mkdirSync(dir);
    const path = join(dir, 'settings.json');
    const permissions = { deny: ['Read(.env)'], allow: ['Bash(npm test)'] };
    writeFileSync(path, JSON.stringify({ permissions, pluginConfigs: { 'jev-gate@jev-gate': { gateMode: 'off' } }, enabledPlugins: { 'jev-gate@jev-gate': true, 'other@market': true, 'jev-gate-router@jev-gate': true } }));
    const first = prepareClaude(env); expect(first).toMatchObject({ changed: true, restartRequired: true, conflicts: [] });
    const after = readFileSync(path, 'utf8'); const settings = JSON.parse(after);
    expect(settings).toMatchObject({ permissions, env: claudeDefaults(env), pluginConfigs: { 'jev-gate@jev-gate': { gateMode: 'off' } }, enabledPlugins: { 'other@market': true, 'jev-gate-router@jev-gate': false } });
    const second = prepareClaude({ ...env, ...settings.env }); expect(second).toEqual({ changed: false, restartRequired: false, conflicts: [] });
    expect(readFileSync(path, 'utf8')).toBe(after);
    expect(after).not.toContain('TYPESAFE_API_KEY'); expect(existsSync(join(dir, '.jev-gate-setup.lock'))).toBe(false);
  });
  it('preserves explicit off/fork settings and reports conflicts rather than overriding native choices', () => {
    const env = fixture(); const dir = join(env.HOME, '.claude'); mkdirSync(dir);
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0', CLAUDE_CODE_FORK_SUBAGENT: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }, model: 'opus' }));
    expect(prepareClaude(env).conflicts).toEqual(['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS', 'CLAUDE_CODE_FORK_SUBAGENT']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0', CLAUDE_CODE_FORK_SUBAGENT: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }, model: 'opus' });
  });
  it('does not overwrite malformed settings or follow a symlink and recovers a dead initializer lock', () => {
    const env = fixture(); const dir = join(env.HOME, '.claude'); mkdirSync(dir);
    const path = join(dir, 'settings.json'); writeFileSync(path, '{broken');
    expect(prepareClaude(env).error).toBe('initialization_failed'); expect(readFileSync(path, 'utf8')).toBe('{broken');
    const outside = join(env.HOME, 'outside'); writeFileSync(outside, '{}'); rmSync(path); symlinkSync(outside, path);
    expect(prepareClaude(env).error).toBe('initialization_failed'); expect(readFileSync(outside, 'utf8')).toBe('{}');
    rmSync(path); writeFileSync(join(dir, '.jev-gate-setup.lock'), '2147483647');
    expect(prepareClaude(env).changed).toBe(true);
  });
});

describe('automatic local key entry', () => {
  it('opens one authenticated local page and rejects cross-site/oversized input without echoing the key', async () => {
    const env = fixture(); const opened: string[] = [];
    const first = await startOnboarding(env, { open: url => opened.push(url), note: '<restart once>' }); expect(first).not.toBeNull(); pages.push(first!);
    const second = await startOnboarding(env, { open: url => opened.push(url) }); expect(second?.url).toBe(first!.url); expect(opened).toHaveLength(1);
    const url = first!.url; const origin = new URL(url).origin;
    const html = await fetch(url); expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await html.text()).toContain('&lt;restart once&gt;');
    expect((await fetch(origin + '/wrong-token')).status).toBe(404);
    const post = (body: string, requestOrigin = origin) => fetch(url, { method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body });
    expect((await post('{"apiKey":"fake-injected-key"}', 'https://external.invalid')).status).toBe(403); expect(resolveApiKey(env)).toBeUndefined();
    expect((await post(JSON.stringify({ apiKey: 'x'.repeat(5000) }))).status).toBe(413);
    expect((await post('{"apiKey":"bad"}')).status).toBe(400);
    const saved = await post('{"apiKey":"fake-onboarding-key"}'); expect(saved.status).toBe(204); expect(await saved.text()).toBe('');
    expect(resolveApiKey(env)).toBe('fake-onboarding-key'); expect(await startOnboarding(env, { open: () => { throw new Error('unexpected browser'); } })).toBeNull();
    expect(await (await fetch(url)).text()).not.toContain('fake-onboarding-key');
  });
  it('keeps disabled onboarding and invalid explicit input free of file/browser side effects', async () => {
    const env = fixture(); const open = () => { throw new Error('unexpected browser'); };
    expect(await startOnboarding({ ...env, JEV_GATE_ONBOARDING: '0' }, { open })).toBeNull();
    expect(await startOnboarding({ ...env, TYPESAFE_API_KEY: 'bad' }, { open })).toBeNull();
    expect(existsSync(credentialsDir(env))).toBe(false);
  });
});
