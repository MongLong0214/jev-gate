import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CODEX_SANDBOX_META, codexCallerWorkspace } from '../../src/codex/workspace.js';

const metadata = (cwd: string, thread = 'thread') => ({ threadId: thread, sessionId: 'different-native-runtime-id', [CODEX_SANDBOX_META]: { sandboxCwd: pathToFileURL(cwd).href } });

describe('automatic native Codex workspace', () => {
  it('uses host thread identity and a local file URI with spaces, without conflating runtime session id', () => {
    expect(codexCallerWorkspace(metadata('/tmp/project with spaces'))).toEqual({ session: 'thread', cwd: '/tmp/project with spaces' });
  });
  it.each([undefined, {}, { threadId: 'thread', cwd: '/tmp/wrong' }, { ...metadata('/tmp/right'), [CODEX_SANDBOX_META]: { sandboxCwd: 'https://example.com/project' } }, { ...metadata('/tmp/right'), [CODEX_SANDBOX_META]: { sandboxCwd: 'file://remote-host/project' } }, { ...metadata('/tmp/right'), threadId: '../escape' }])('refuses unknown or non-local scope (%#)', meta => {
    expect(codexCallerWorkspace(meta)).toBeNull();
  });
});
