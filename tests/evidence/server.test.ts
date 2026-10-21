import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createServer, SERVER_VERSION } from '../../src/evidence/server.js';
import { CODEX_SANDBOX_META } from '../../src/codex/workspace.js';

const root = join(__dirname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'jev-mcp-server-'));
let server: string;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// The bundle under test is built from this tree under a path with spaces and no node_modules.
beforeAll(() => {
  server = join(tmp, 'plugin root', 'server.mjs');
  const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-evidence.mjs'), server], { encoding: 'utf8' });
  expect(build.status, build.stderr).toBe(0);
}, 60_000);

const inMemory = async (deps: Parameters<typeof createServer>[0]): Promise<Client> => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(a);
  const client = new Client({ name: 'mcp-server-test', version: '0' });
  await client.connect(b);
  clients.push(client);
  return client;
};

describe('the plugin MCP server', () => {
  it('ships one version across the server and the package', () => {
    expect((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version).toBe(SERVER_VERSION);
  });

  it('lists no tool from the built bundle outside Codex, and refuses an unknown tool as a protocol error', async () => {
    const cwd = join(tmp, 'other cwd');
    mkdirSync(cwd, { recursive: true });
    const client = new Client({ name: 'mcp-server-test', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], cwd, env: { PATH: process.env['PATH'] ?? '', HOME: tmp }, stderr: 'pipe' }));
    clients.push(client);
    expect((await client.listTools()).tools).toEqual([]);
    await expect(client.callTool({ name: 'jev_find', arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });

  it('lists only jev_agent with a Codex connection and passes its call to the connection', async () => {
    const seen: unknown[] = [];
    const client = await inMemory({ dispatch: async (args, meta) => { seen.push(args, meta); return 'dispatched'; } });
    expect(client.getServerCapabilities()?.experimental).toHaveProperty(CODEX_SANDBOX_META);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['jev_agent']);
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    const reply = await client.callTool({ name: 'jev_agent', arguments: { action: 'status', agent_id: 'w' }, _meta: { threadId: 't' } });
    expect(reply.content).toEqual([{ type: 'text', text: 'dispatched' }]);
    expect(seen).toEqual([{ action: 'status', agent_id: 'w' }, { threadId: 't' }]);
  });

  it('lists no tool and advertises no workspace capability without a connection', async () => {
    const client = await inMemory({});
    expect(client.getServerCapabilities()?.experimental).toBeUndefined();
    expect((await client.listTools()).tools).toEqual([]);
    await expect(client.callTool({ name: 'jev_agent', arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });
});
