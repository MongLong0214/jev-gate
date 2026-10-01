import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/evidence/server.js';
import { CODEX_SANDBOX_META, codexCallerWorkspace } from '../../src/codex/workspace.js';
import { repo } from '../evidence/repo.js';

const missing = { ok: false, reason: 'unavailable_config', origin: 'session', detail: 'waiting for native scope' } as const;
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.close())); });
const metadata = (cwd: string, thread = 'thread') => ({ threadId: thread, sessionId: 'different-native-runtime-id', [CODEX_SANDBOX_META]: { sandboxCwd: pathToFileURL(cwd).href } });
const connect = async (env: Record<string, string> = {}) => {
  const server = createServer(missing, { apiKey: null, host: 'codex', callerEnv: env });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'native-workspace-test', version: '0' });
  await client.connect(b); clients.push(client);
  return client;
};
const call = async (client: Client, meta: Record<string, unknown> | undefined) => {
  const r = await client.callTool({ name: 'jev_evidence', arguments: { goal: 'Find fixture', exactSymbols: ['NATIVE_SCOPE'] }, ...(meta ? { _meta: meta } : {}) });
  return { error: r.isError, body: JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { projectRoot: string | null; items: Array<{ text: string }>; reasonCodes: string[] } };
};

describe('automatic native Codex workspace', () => {
  it('uses host thread identity and a local file URI with spaces, without conflating runtime session id', () => {
    expect(codexCallerWorkspace(metadata('/tmp/project with spaces'))).toEqual({ session: 'thread', cwd: '/tmp/project with spaces' });
  });
  it.each([undefined, {}, { threadId: 'thread', cwd: '/tmp/wrong' }, { ...metadata('/tmp/right'), [CODEX_SANDBOX_META]: { sandboxCwd: 'https://example.com/project' } }, { ...metadata('/tmp/right'), [CODEX_SANDBOX_META]: { sandboxCwd: 'file://remote-host/project' } }, { ...metadata('/tmp/right'), threadId: '../escape' }])('refuses unknown or non-local scope (%#)', meta => {
    expect(codexCallerWorkspace(meta)).toBeNull();
  });
  it('serves two simultaneous native callers from their own worktrees and never reuses the most recent scope', async () => {
    const a = repo({ 'a.ts': 'export const NATIVE_SCOPE = "first";\n' });
    const b = repo({ 'b.ts': 'export const NATIVE_SCOPE = "second";\n' });
    const client = await connect();
    const [first, second] = await Promise.all([call(client, metadata(a, 'a')), call(client, metadata(b, 'b'))]);
    expect(first.error).not.toBe(true); expect(second.error).not.toBe(true);
    expect(first.body.items[0]?.text).toContain('first'); expect(second.body.items[0]?.text).toContain('second');
    expect((await call(client, metadata(a, 'a'))).body.items[0]?.text).toContain('first');
    expect((await call(client, undefined)).body).toMatchObject({ projectRoot: null, items: [], reasonCodes: ['unavailable_config'] });
  });
  it('advertises native scope only when the owner did not supply an explicit override', async () => {
    const automatic = await connect();
    expect(automatic.getServerCapabilities()?.experimental).toHaveProperty(CODEX_SANDBOX_META);
    expect((await automatic.listTools()).tools[0]?.description).toContain('no path setting is required');
    const explicit = await connect({ JEV_EVIDENCE_CONFIG: '' });
    expect(explicit.getServerCapabilities()?.experimental).toBeUndefined();
    const project = repo({ 'a.ts': 'NATIVE_SCOPE\n' });
    expect((await call(explicit, metadata(project))).body.reasonCodes).toEqual(['unavailable_config']);
  });
});
