import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCompatibility, claudeModelInventory, parseClaudeInventory } from '../src/doctor-models.js';
import { codexCompatibility, codexModelInventory } from '../src/codex/doctor-models.js';
import { claudeDoctor, parseFrontmatter } from '../src/cli.js';
import { codexDoctor } from '../src/codex/cli.js';
import { storageIssue, moduleIssues, renderDoctor } from '../src/doctor.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'jev-doctor-test-')); dirs.push(path); return path; };
const claudeModels = [{ value: 'haiku', resolvedModel: 'claude-haiku-5-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }];
const codexModel = (model = 'gpt-6-luna', efforts = ['low', 'medium', 'high', 'xhigh', 'max']) => ({ model, description: 'Fast and affordable model for easier tasks', supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) });
function fixture(host: 'claude' | 'codex', rows: unknown[], delayedVersion = false) {
  const dir = temporary(), log = join(dir, 'rpc.log');
  const script = `#!${process.execPath}\nif(process.argv.includes('--version')&&${delayedVersion}){setTimeout(()=>{},60000)}else{const fs=require('node:fs'),readline=require('node:readline');const rows=${JSON.stringify(rows)};readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(process.env.PROBE_LOG,JSON.stringify(r)+'\\n');if(r.type==='control_request')process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:r.request_id,response:{models:rows}}})+'\\n');else if(r.id)process.stdout.write(JSON.stringify({id:r.id,result:r.method==='initialize'?{}:{data:rows,nextCursor:null}})+'\\n')});}`;
  writeFileSync(join(dir, host), script); chmodSync(join(dir, host), 0o700);
  return { dir, log, env: { PATH: `${dir}:${dirname(process.execPath)}`, HOME: dir, CODEX_HOME: dir, XDG_STATE_HOME: join(dir, 'state'), PROBE_LOG: log } };
}
describe('Doctor native model and effort compatibility', () => {
  it('rejects Haiku 5.5 on a pre-2.1.293 CLI even if a synthetic inventory advertises it', () => {
    const row = claudeCompatibility(parseClaudeInventory(claudeModels), '2.1.292', [], false).find(v => v.model === 'claude-haiku-5-5')!;
    expect(row.state).toBe('incompatible'); expect(row.reason).toContain('2.1.293');
  });
  it('detects a stale haiku alias resolving to 4.5 and does not approve its effort', () => {
    const inventory = parseClaudeInventory([{ value: 'haiku', resolvedModel: 'claude-haiku-4-5', supportsEffort: false }]);
    const row = claudeCompatibility(inventory, '2.1.294', [{ model: 'haiku', effort: 'low' }], false).find(v => v.model === 'haiku')!;
    expect(row.state).toBe('incompatible'); expect(row.reason).toContain('resolves to claude-haiku-4-5'); expect(row.unsupportedEfforts).toEqual(['low']);
  });
  it('checks every offered effort and keeps missing capability fields unknown', () => {
    const inventory = parseClaudeInventory(claudeModels);
    const row = claudeCompatibility(inventory, '2.1.294', [{ model: 'claude-haiku-5-5', effort: 'max' }], false).find(v => v.model === 'claude-haiku-5-5')!;
    expect(row.unsupportedEfforts).toEqual(['max']); expect(row.state).toBe('incompatible');
    const unknown = parseClaudeInventory([{ value: 'haiku', resolvedModel: 'claude-haiku-5-5' }]);
    expect(claudeCompatibility(unknown, '2.1.294', [], false).find(v => v.model === 'claude-haiku-5-5')?.state).toBe('unverified');
  });
  it('marks missing targets as incompatible only in a complete inventory', () => {
    expect(claudeCompatibility(parseClaudeInventory(claudeModels), '2.1.294', [], false).find(v => v.model === 'claude-opus-5-5')?.state).toBe('incompatible');
    expect(claudeCompatibility({ models: [], complete: false, error: 'unavailable' }, '2.1.294', [], false).find(v => v.model === 'claude-opus-5-5')?.state).toBe('unverified');
  });
  it('checks current Opus and Fable host introductions from the shared model table', () => {
    const rows = claudeCompatibility({ models: [], complete: false, error: 'unavailable' }, '2.1.256', [{ model: 'claude-fable-5-1', effort: 'max' }], true);
    expect(rows.find(r => r.model === 'claude-opus-5-5')?.reason).toContain('2.1.280');
    expect(rows.find(r => r.model === 'claude-fable-5-1')?.reason).toContain('2.1.257');
  });
  it('does not mistake an unlisted context variant for a missing base model', () => {
    const inventory = parseClaudeInventory([{ value: 'opus', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }]);
    const row = claudeCompatibility(inventory, '2.1.294', [{ model: 'claude-opus-5-5[1m]', effort: 'high' }], false).find(c => c.model.endsWith('[1m]'))!;
    expect(row.state).toBe('unverified'); expect(row.reason).toContain('context variant');
    expect(claudeCompatibility(inventory, '2.1.279', [{ model: 'claude-opus-5-5[1m]' }], false).find(c => c.model.endsWith('[1m]'))?.state).toBe('incompatible');
  });
  it('queries actual Claude control protocol without a user message or permission change', async () => {
    const fake = fixture('claude', claudeModels), inventory = await claudeModelInventory(fake.env, fake.dir);
    expect(inventory.complete).toBe(true); expect(inventory.models[0]).toEqual({ alias: 'haiku', id: 'claude-haiku-5-5', efforts: ['low', 'medium', 'high'] });
    const requests = readFileSync(fake.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests).toEqual([{ type: 'control_request', request_id: 'jev-doctor-models', request: { subtype: 'initialize' } }]);
  });
  it('queries Codex only with initialize/model-list RPCs and enumerates all supported efforts', async () => {
    const fake = fixture('codex', [codexModel()]), inventory = await codexModelInventory(fake.env, fake.dir);
    expect(inventory.complete).toBe(true); expect(inventory.models[0]?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(readFileSync(fake.log, 'utf8').trim().split('\n').map(line => JSON.parse(line).method)).toEqual(['initialize', 'initialized', 'model/list']);
    expect(codexCompatibility(inventory, fake.env).find(v => v.model === 'gpt-6-luna')?.state).toBe('compatible');
  });
  it('rejects unavailable explicit Codex targets and unsupported owned-profile efforts', () => {
    const dir = temporary(), config = join(dir, 'codex.json');
    writeFileSync(config, JSON.stringify({ gate: { models: { fast: 'missing-luna', deep: 'gpt-6-luna' } } }));
    const catalog = [codexModel('gpt-6-luna', ['low', 'medium'])];
    const rows = codexCompatibility({ catalog, models: [], complete: true, error: null }, { HOME: dir, JEV_CODEX_CONFIG: config });
    expect(rows.find(r => r.model === 'missing-luna')?.state).toBe('incompatible');
    expect(rows.find(r => r.model === 'gpt-6-luna')?.unsupportedEfforts).toContain('high');
    expect(rows.find(r => r.model === 'gpt-6-luna')?.state).toBe('incompatible');
  });
  it('never turns missing binaries, malformed catalogs or duplicate entries into an empty successful inventory', async () => {
    const dir = temporary(), env = { HOME: dir, PATH: '/nonexistent' };
    expect((await claudeModelInventory(env, dir)).complete).toBe(false);
    expect((await codexModelInventory(env, dir)).complete).toBe(false);
    expect(parseClaudeInventory([...claudeModels, ...claudeModels]).complete).toBe(false);
    expect(parseClaudeInventory('secret payload').error).toBe('invalid_response');
  });
  it('never certifies contradictory aliases or capabilities in either order', () => {
    const supported = { value: 'haiku', resolvedModel: 'claude-haiku-5-5', supportedEffortLevels: ['low', 'medium', 'high'] };
    for (const conflicting of [
      { ...supported, supportedEffortLevels: ['low'] },
      { ...supported, value: 'default', supportsEffort: false },
    ]) for (const rows of [[supported, conflicting], [conflicting, supported]]) {
      const inventory = parseClaudeInventory(rows);
      expect(inventory.complete).toBe(false);
      expect(claudeCompatibility(inventory, '2.1.294', [], false).find(c => c.model === 'claude-haiku-5-5')?.state).toBe('unverified');
    }
    const agreeing = parseClaudeInventory([supported, { ...supported, value: 'default' }]);
    expect(agreeing.complete).toBe(true);
    expect(claudeCompatibility(agreeing, '2.1.294', [], false).find(c => c.model === 'claude-haiku-5-5')?.state).toBe('compatible');
    const malformed = parseClaudeInventory([supported, {}]);
    expect(claudeCompatibility(malformed, '2.1.294', [], false).find(c => c.model === 'claude-haiku-5-5')?.state).toBe('unverified');
  });
  it.each([{ supportsEffort: 'true' }, { resolvedModel: false }, { supportedEffortLevels: ['low', 'low'] }, { supportedEffortLevels: null }, { supportsEffort: false, supportedEffortLevels: ['low'] }])('preserves unknown for malformed Claude capability fields: %j', invalid => {
    const inventory = parseClaudeInventory([{ ...claudeModels[0], ...invalid }]);
    expect(inventory.complete).toBe(false); expect(inventory.error).toBe('invalid_response');
    expect(claudeCompatibility(inventory, '2.1.294', [], false).find(c => c.model === 'claude-haiku-5-5')?.state).toBe('unverified');
  });
});
describe('Doctor reports', () => {
  it.each(['hooks/register.ts', 'mods/router/hooks/config.ts', 'src/provider-prices-data.ts', 'plugins/evidence/dist/server.mjs', 'plugins/evidence/skills/evidence/SKILL.md'])('rejects a missing declared package dependency: %s', async missing => {
    const dir = temporary(), root = join(dir, 'plugin'); mkdirSync(root);
    for (const file of ['.claude-plugin', 'hooks', 'agents', 'mods', 'src', 'plugins/evidence/dist', 'plugins/evidence/skills']) cpSync(join(__dirname, '..', file), join(root, file), { recursive: true });
    mkdirSync(join(root, 'dist')); for (const file of ['entry.js', 'hook.js']) writeFileSync(join(root, 'dist', file), '');
    const env = { HOME: dir, PATH: '/nonexistent', XDG_STATE_HOME: join(dir, 'state') };
    const before = await claudeDoctor(root, env, dir);
    expect(before.checks.filter(c => c.group === 'package' && c.level === 'fail')).toEqual([]);
    rmSync(join(root, missing));
    const after = await claudeDoctor(root, env, dir);
    expect(after.checks.filter(c => c.group === 'package' && c.level === 'fail').some(c => c.message.includes(missing))).toBe(true);
  });
  it('keeps a timed-out Codex version unknown while independently checking its native catalog', async () => {
    const fake = fixture('codex', [codexModel()], true);
    const report = (await codexDoctor(join(__dirname, '../plugins/codex'), fake.env, fake.dir)).report;
    expect(report.checks.find(c => c.group === 'host')?.level).toBe('warn');
    expect(report.checks.find(c => c.group === 'host')?.message).toContain('unverified');
    expect(report.models?.complete).toBe(true);
    expect(report.models?.compatibility.find(c => c.model === 'gpt-6-luna')?.state).toBe('compatible');
  });
  it.each(['missing-server', 'wrong-command', 'wrong-skills'])('rejects a broken Evidence discovery declaration: %s', async broken => {
    const dir = temporary(), root = join(dir, 'plugin'); mkdirSync(root);
    for (const file of ['.claude-plugin', 'hooks', 'agents', 'mods', 'src', 'plugins/evidence/dist', 'plugins/evidence/skills']) cpSync(join(__dirname, '..', file), join(root, file), { recursive: true });
    mkdirSync(join(root, 'dist')); for (const file of ['entry.js', 'hook.js']) writeFileSync(join(root, 'dist', file), '');
    const path = join(root, '.claude-plugin/plugin.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (broken === 'missing-server') delete manifest.mcpServers.evidence;
    else if (broken === 'wrong-command') manifest.mcpServers.evidence.command = 'missing-runtime';
    else manifest.skills = './missing-skills/';
    writeFileSync(path, JSON.stringify(manifest));
    const report = await claudeDoctor(root, { HOME: dir, PATH: '/nonexistent', XDG_STATE_HOME: join(dir, 'state') }, dir);
    expect(report.checks.some(c => c.group === 'package' && c.level === 'fail' && c.message.includes(broken === 'wrong-skills' ? 'Evidence skill' : 'Evidence MCP'))).toBe(true);
  });
  it('diagnoses invalid explicit keys on both hosts without printing them', async () => {
    const dir = temporary(), env = { HOME: dir, PATH: '/nonexistent', XDG_STATE_HOME: join(dir, 'state'), TYPESAFE_API_KEY: 'bad\nsecret', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0' };
    const claude = await claudeDoctor(join(__dirname, '..'), env, dir);
    const codex = (await codexDoctor(join(__dirname, '../plugins/codex'), env, dir)).report;
    for (const report of [claude, codex]) {
      expect(report.checks.some(c => c.group === 'credentials' && c.level === 'fail' && c.message.includes('invalid format'))).toBe(true);
      expect(JSON.stringify(report)).not.toContain('secret');
    }
    expect(claude.checks.some(c => c.group === 'configuration' && c.level === 'warn' && c.message.includes('Function Hooks explicitly disabled'))).toBe(true);
    for (const [pluginKey, shouldFail] of [['invalid\nsecret', true], ['valid-plugin-secret', false]] as const) {
      const overrides = { ...env, CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY: pluginKey };
      const reports = [await claudeDoctor(join(__dirname, '..'), overrides, dir), (await codexDoctor(join(__dirname, '../plugins/codex'), overrides, dir)).report];
      for (const report of reports) {
        expect(report.checks.some(c => c.group === 'credentials' && c.level === 'fail' && c.message.includes('invalid format'))).toBe(shouldFail);
        expect(JSON.stringify(report)).not.toContain('secret');
      }
    }
  });
  it('is reentrant and returns actionable JSON facts without key values or directory creation', async () => {
    const dir = temporary(), env = { HOME: dir, PATH: '/nonexistent', TYPESAFE_API_KEY: 'private-key-do-not-print', JEV_GATE_TRACE_DIR: join(dir, 'traces') };
    const first = await claudeDoctor(join(__dirname, '..'), env, dir), second = await claudeDoctor(join(__dirname, '..'), env, dir);
    expect(second.checks).toHaveLength(first.checks.length); expect(first.counts).toEqual(second.counts);
    expect(JSON.stringify(first)).not.toContain(env.TYPESAFE_API_KEY); expect(renderDoctor(first)).not.toContain(env.TYPESAFE_API_KEY);
    expect(first.checks.filter(c => c.level === 'fail' || c.level === 'warn').every(c => c.action)).toBe(true);
    expect(first.models?.complete).toBe(false);
  });
  it('accepts CRLF and rejects duplicate or false closing delimiters in frontmatter', () => {
    expect(parseFrontmatter('---\r\nname: worker\r\n---\r\n').fields.name).toBe('worker');
    expect(parseFrontmatter('---\nmodel: opus\nmodel: haiku\n---\n').error).toContain('duplicate');
    expect(parseFrontmatter('---\nmodel: opus\n---oops\n').error).toBe('unterminated frontmatter');
  });
  it('rejects a file masquerading as storage and a relative path without mutating either', () => {
    const dir = temporary(), file = join(dir, 'file'); writeFileSync(file, 'unchanged');
    expect(storageIssue(file)).toContain('not a directory'); expect(storageIssue('relative')).toContain('absolute');
    expect(readFileSync(file, 'utf8')).toBe('unchanged');
    expect(storageIssue(join(dir, 'not-created', 'trace'))).toBeNull();
  });
  it('keeps module dependency inspection inside the installed package through symlinked directories', () => {
    const dir = temporary(), root = join(dir, 'plugin'), outside = join(dir, 'workspace'); mkdirSync(root); mkdirSync(outside);
    writeFileSync(join(outside, 'private.ts'), 'export const privateSource = true;');
    symlinkSync(outside, join(root, 'linked'), 'dir');
    writeFileSync(join(root, 'entry.ts'), "import { privateSource } from './linked/private.ts';");
    expect(moduleIssues(root, 'entry.ts')).toEqual(['linked/private.ts: relative module import escapes the plugin']);
  });
});
