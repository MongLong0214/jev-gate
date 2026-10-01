import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installConnection, restoreConnection, type Connection } from '../../src/codex/connection.js';
import type { CodexRpc } from '../../src/codex/rpc.js';
import type { Obj } from '../../src/codex/source.js';

const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });
const fixture = (config: Obj = { model: 'gpt-6.1-sol', model_reasoning_effort: 'high' }) => {
  const home = mkdtempSync(join(tmpdir(), 'jev-connect-unit-')); temps.push(home);
  const env = { CODEX_HOME: home }; let revision = 0;
  const requests: Obj[] = [];
  const rpc = { request: async (method: string, params: Obj) => {
    if (method === 'config/read') return { layers: [{ name: { type: 'user', file: join(home, 'config.toml') }, version: String(revision), config: structuredClone(config) }] };
    if (method !== 'config/batchWrite' || params['expectedVersion'] !== String(revision)) throw new Error('revision mismatch');
    requests.push(params); revision++;
    for (const edit of params['edits'] as Array<{ keyPath: string; value: unknown }>) {
      const parts = edit.keyPath.split('.'); const last = parts.pop()!; let target = config;
      for (const part of parts) { target[part] ??= {}; target = target[part] as Obj; }
      if (edit.value === null) delete target[last]; else target[last] = structuredClone(edit.value);
    }
    return {};
  } } as unknown as CodexRpc;
  const connection = (): Connection => ({ version: 1, pid: process.pid, port: 12345, token: 'a'.repeat(64), marker: 'owned compact prompt', root: home, original: {}, installed: {} });
  return { env, config, rpc, connection, requests, home };
};
describe('automatic connection ownership and recovery', () => {
  it('restores absent settings after multiple restarts, preserving the user model and effort', async () => {
    const f = fixture(); await installConnection(f.rpc, f.connection(), f.env);
    await installConnection(f.rpc, f.connection(), f.env); await installConnection(f.rpc, f.connection(), f.env);
    await restoreConnection(f.rpc, f.env);
    expect(f.config).toMatchObject({ model: 'gpt-6.1-sol', model_reasoning_effort: 'high' });
    expect(f.config['model_provider']).toBeUndefined(); expect(f.config['compact_prompt']).toBeUndefined();
    expect((f.config['model_providers'] as Obj)['jev-gate-native']).toBeUndefined();
    expect(readFileSync(join(f.home, 'jev-gate/connection/owner.json'), 'utf8')).not.toMatch(/TYPESAFE|OPENAI_API_KEY/);
  });
  it('restores explicit owner values and preserves changes made while connected', async () => {
    const f = fixture({ model_provider: 'openai', compact_prompt: 'owner prompt', model: 'gpt-5.6-terra' });
    await installConnection(f.rpc, f.connection(), f.env);
    f.config['compact_prompt'] = 'new owner prompt'; f.config['model_reasoning_effort'] = 'max';
    await restoreConnection(f.rpc, f.env);
    expect(f.config).toMatchObject({ model_provider: 'openai', compact_prompt: 'new owner prompt', model: 'gpt-5.6-terra', model_reasoning_effort: 'max' });
  });
  it('never replaces a custom provider or an unowned Jev provider', async () => {
    for (const provider of ['owner-endpoint', 'jev-gate-native']) {
      const f = fixture({ model_provider: provider });
      await expect(installConnection(f.rpc, f.connection(), f.env)).rejects.toThrow(); expect(f.requests).toHaveLength(0);
    }
  });
  it('refuses reconnecting over owner edits but can restore remaining owned keys', async () => {
    const f = fixture(); await installConnection(f.rpc, f.connection(), f.env);
    f.config['compact_prompt'] = 'owner edit';
    await expect(installConnection(f.rpc, f.connection(), f.env)).rejects.toThrow();
    await restoreConnection(f.rpc, f.env);
    expect(f.config['model_provider']).toBeUndefined(); expect(f.config['compact_prompt']).toBe('owner edit');
  });
  it('refuses symlinked connection state directories before editing native configuration', async () => {
    const f = fixture(); const outside = mkdtempSync(join(tmpdir(), 'jev-connect-outside-')); temps.push(outside);
    mkdirSync(join(f.home, 'jev-gate'), { mode: 0o700 }); symlinkSync(outside, join(f.home, 'jev-gate/connection'));
    await expect(installConnection(f.rpc, f.connection(), f.env)).rejects.toThrow(); expect(f.requests).toHaveLength(0);
  });
});
