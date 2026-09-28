import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { SERVER_VERSION, TOOL_NAME } from '../../src/evidence/server.js';
import type { EvidenceResult } from '../../src/evidence/types.js';
import { configFile, repo, tmp } from './repo.js';

const root = join(__dirname, '..', '..');
const hasZip = spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0;
let server: string;
let project: string;
let cfg: string;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

// The archive under test is built from this tree, packed, and unpacked under a path with spaces and no node_modules.
beforeAll(() => {
  const pluginRoot = join(tmp, 'plugin root');
  cpSync(join(root, 'plugins', 'evidence'), join(pluginRoot, 'plugins', 'evidence'), { recursive: true, filter: (p) => !p.includes(`${join('evidence', 'dist')}`) });
  cpSync(join(root, 'package.json'), join(pluginRoot, 'package.json'));
  const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-evidence.mjs'), join(pluginRoot, 'plugins', 'evidence', 'dist', 'server.mjs')], { encoding: 'utf8' });
  expect(build.status, build.stderr).toBe(0);
  const outDir = join(tmp, 'pack out');
  const pack = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), outDir, '--root', pluginRoot, '--profile', 'evidence'], { encoding: 'utf8' });
  expect(pack.status, pack.stderr).toBe(0);
  const archive = join(outDir, `jev-gate-evidence-${SERVER_VERSION}.zip`);
  if (hasZip) {
    expect(spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).stdout.trim().split('\n').sort()).toEqual(['.claude-plugin/plugin.json', 'README.md', 'dist/server.mjs', 'skills/evidence/SKILL.md']);
    const dest = join(tmp, 'installed here', 'jev evidence');
    mkdirSync(dest, { recursive: true });
    expect(spawnSync('unzip', ['-q', archive, '-d', dest]).status).toBe(0);
    server = join(dest, 'dist', 'server.mjs');
  } else server = join(pluginRoot, 'plugins', 'evidence', 'dist', 'server.mjs');
  project = realpathSync(repo({ 'src/alpha.ts': 'export const findMe = 1;\n', 'src/beta.ts': 'import { findMe } from "./alpha";\nexport const other = findMe + 1;\n' }));
  cfg = configFile({ projectRoot: project, allowedRoots: ['src'] });
}, 60_000);

const otherCwd = (): string => {
  const dir = join(tmp, 'other cwd');
  mkdirSync(dir, { recursive: true });
  return dir;
};
const connect = async (env: Record<string, string>): Promise<Client> => {
  const client = new Client({ name: 'evidence-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], cwd: otherCwd(), env: { PATH: process.env['PATH'] ?? '', ...env }, stderr: 'pipe' }));
  clients.push(client);
  return client;
};
const call = async (client: Client, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ isError: boolean; body: EvidenceResult & { detail?: string } }> => {
  const r = await client.callTool({ name: TOOL_NAME, arguments: args }, undefined, signal ? { signal } : {});
  const content = r.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(r.structuredContent).toBeUndefined();
  return { isError: r.isError === true, body: JSON.parse(content[0]!.text) as EvidenceResult & { detail?: string } };
};

describe('jev_evidence over stdio (#77)', () => {
  it('ships one version across the server, its manifest and the package', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'plugins', 'evidence', '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; version: string };
    expect(manifest).toMatchObject({ name: 'jev-gate-evidence', version: SERVER_VERSION });
    expect((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version).toBe(SERVER_VERSION);
    expect(readFileSync(join(root, 'plugins', 'evidence', 'skills', 'evidence', 'SKILL.md'), 'utf8')).toMatch(/^disable-model-invocation: true$/m);
  });

  it('lists exactly one read-only tool and answers search, next page and exact read-back from the unpacked archive', async () => {
    const client = await connect({ JEV_EVIDENCE_CONFIG: cfg });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([TOOL_NAME]);
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tools[0]!.outputSchema).toBeUndefined();

    const first = await call(client, { goal: 'where is findMe used', exactSymbols: ['findMe'], limit: 1 });
    expect(first.isError).toBe(false);
    expect(first.body).toMatchObject({ projectRoot: project, backend: 'local', status: 'partial', reasonCodes: [] });
    expect(first.body.items).toHaveLength(1);
    expect(first.body.next).not.toBeNull();
    const second = await call(client, { goal: 'where is findMe used', exactSymbols: ['findMe'], limit: 1, ...first.body.next });
    expect(second.body.items.map((i) => i.source.path)).toEqual(['src/beta.ts']);
    expect(second.body.next).toBeNull();

    const back = await call(client, { goal: 'read it back', sources: [second.body.items[0]!.source] });
    expect(back.body.items[0]).toMatchObject({ textState: 'included', text: readFileSync(join(project, 'src', 'beta.ts'), 'utf8') });
  });

  it('keeps input errors as tool errors with a fixed detail, and an unknown tool as a protocol error', async () => {
    const client = await connect({ JEV_EVIDENCE_CONFIG: cfg });
    const bad = await call(client, { goal: 'x', sources: [{ path: 'src/alpha.ts', startLine: 1, endLine: 1, fileSha256: '0'.repeat(64) }], limit: 2 });
    expect(bad).toMatchObject({ isError: true, body: { status: 'unavailable', reasonCodes: ['invalid_input'], detail: 'sources cannot be combined with limit' } });
    const outside = await call(client, { goal: 'x', roots: ['../'] });
    expect(outside.isError).toBe(true);
    await expect(client.callTool({ name: 'jev_find', arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });

  it('starts without a config, lists the tool, and refuses every call before reading a source', async () => {
    const client = await connect({});
    expect((await client.listTools()).tools).toHaveLength(1);
    const r = await call(client, { goal: 'x', exactSymbols: ['findMe'] });
    expect(r).toMatchObject({ isError: true, body: { projectRoot: null, items: [], reasonCodes: ['unavailable_config'] } });
  });

  it('turns a cancelled call into no result, and the next call on the same server still answers', async () => {
    const client = await connect({ JEV_EVIDENCE_CONFIG: cfg });
    const abort = new AbortController();
    const pending = call(client, { goal: 'x', mode: 'audit' }, abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect((await call(client, { goal: 'x', exactSymbols: ['other'] })).body.items).toHaveLength(1);
  });

  it('diagnoses with --doctor from the config alone', () => {
    const run = (env: Record<string, string>) => spawnSync(process.execPath, [server, '--doctor'], { cwd: otherCwd(), encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...env } });
    const ok = run({ JEV_EVIDENCE_CONFIG: cfg, TYPESAFE_API_KEY: 'sk-never-printed' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`config: ok ${project}`);
    expect(ok.stdout).toContain('TYPESAFE_API_KEY: present');
    expect(ok.stdout).not.toContain('sk-never-printed');
    expect(ok.stdout).not.toContain('findMe');
    const missing = run({});
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('config: unavailable (unavailable_config)');
    expect(readdirSync(project).sort()).toEqual(['.git', 'src']);
  });
});
