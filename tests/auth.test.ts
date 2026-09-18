import { describe, expect, it } from 'vitest';

import { isSubscriptionOAuth, parseAuthStatus, subagentModelOverride } from '../src/auth.js';

const good = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'team' });

describe('parseAuthStatus', () => {
  it('accepts the verified schema only with normal termination', () => {
    const r = parseAuthStatus({ status: 0, signal: null, stdout: good, error: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(isSubscriptionOAuth(r.status)).toBe(true);
  });

  it('regression: null output with exit 7 is a failure, not a pass', () => {
    expect(parseAuthStatus({ status: 7, signal: null, stdout: 'null\n', error: null })).toMatchObject({ ok: false });
    expect(parseAuthStatus({ status: 0, signal: null, stdout: 'null\n', error: null })).toMatchObject({ ok: false });
  });

  it('valid-looking object with nonzero exit, a signal, or a spawn error is not verification', () => {
    expect(parseAuthStatus({ status: 1, signal: null, stdout: good, error: null })).toMatchObject({ ok: false });
    expect(parseAuthStatus({ status: null, signal: 'SIGTERM', stdout: good, error: null })).toMatchObject({ ok: false });
    expect(parseAuthStatus({ status: null, signal: null, stdout: '', error: 'ENOENT' })).toMatchObject({ ok: false });
    expect(parseAuthStatus({ status: 0, signal: null, stdout: JSON.stringify({ authMethod: 'claude.ai' }), error: null })).toMatchObject({ ok: false });
  });

  it('other auth methods parse but are not the supported OAuth condition', () => {
    const r = parseAuthStatus({ status: 0, signal: null, stdout: JSON.stringify({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' }), error: null });
    expect(r.ok && isSubscriptionOAuth(r.status)).toBe(false);
  });
});

describe('subagentModelOverride', () => {
  it('treats inherit and empty as harmless and concrete values or FORCE as overrides', () => {
    expect(subagentModelOverride({})).toEqual({ concrete: false, force: false, value: null });
    expect(subagentModelOverride({ CLAUDE_CODE_SUBAGENT_MODEL: 'inherit' })).toMatchObject({ concrete: false, force: false });
    expect(subagentModelOverride({ CLAUDE_CODE_SUBAGENT_MODEL: '  ' })).toMatchObject({ concrete: false });
    expect(subagentModelOverride({ CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' })).toMatchObject({ concrete: true, value: 'haiku' });
    expect(subagentModelOverride({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' })).toMatchObject({ force: true });
  });
});
