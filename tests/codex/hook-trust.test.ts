import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodexPolicy } from '../../src/codex/policy.js';
import type { CodexRpc } from '../../src/codex/rpc.js';
import type { Obj } from '../../src/codex/source.js';

it.each([false, true])('keeps native declaration/content approval fields distinct (composite: %s)', async composite => {
  const root = mkdtempSync(join(tmpdir(), 'jev-hook-trust-'));
  const declaration = `sha256:${'a'.repeat(64)}`, content = `sha256:${'b'.repeat(64)}`;
  const hash = composite ? `${declaration}/${content}` : declaration;
  const hooks = ['sessionStart', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop'].map(eventName => ({ key: eventName, eventName, source: 'plugin', pluginId: 'jev-gate@fixture', enabled: true, currentHash: hash, trustStatus: 'untrusted' }));
  const forward = vi.fn();
  const rpc = { request: vi.fn(async (method: string) => method === 'hooks/list' ? { data: [{ hooks }] } : { config: {} }), forward } as unknown as CodexRpc;
  const env = { HOME: root, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root };
  try {
    const message = { id: 1, method: 'thread/start', params: { cwd: root } };
    const normal = new CodexPolicy(rpc, env);
    await expect(normal.client(message)).rejects.toThrow('Trust and enable');
    expect(forward).not.toHaveBeenCalled(); normal.close();
    // Only the caller's explicit native trust bypass permits a scoped grant.
    const bypass = new CodexPolicy(rpc, env, undefined, undefined, true);
    await bypass.client(message);
    const config = (forward.mock.calls[0]![0]['params'] as Obj)['config'] as Obj;
    expect(config['hooks.state']).toEqual(Object.fromEntries(hooks.map(h => [h.key, { trusted_hash: declaration, ...(composite ? { trusted_content_hash: content } : {}) }])));
    expect(rpc.request).not.toHaveBeenCalledWith('config/batchWrite', expect.anything());
    bypass.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
