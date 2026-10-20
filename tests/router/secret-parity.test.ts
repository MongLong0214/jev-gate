import { describe, expect, it } from 'vitest';

import { looksSecret as routerLooksSecret, SECRET_PATTERNS as ROUTER } from '../../mods/router/hooks/secret.ts';
import { looksSecret as sourceLooksSecret, SECRET_PATTERNS as SOURCE } from '../../src/outbound-text.js';

/**
 * The Router cannot import the Node side of the repository, so it carries a copy of the shared credential screen. A
 * copy that drifts screens one feature's outbound text differently from the other's; this keeps them identical.
 */
describe('credential screen parity', () => {
  it('holds the same patterns, in the same order, with the same flags', () => {
    expect(ROUTER.map(String)).toEqual(SOURCE.map(String));
  });

  it.each([
    'Cookie: preference=canary123', 'Set-Cookie: preference=canary123; HttpOnly',
    'connect.sid=s:canary123', 'authentication=canary123', 'authToken=canary123',
    'curl --cookie sessionid=canary123 host', 'curl --cookie="other=canary123" host',
    "curl -b 'other=canary123' host", 'curl -bother=canary123 host',
    ...['sessionid', 'session', 'sid', 'connect.sid', 'PHPSESSID', 'JSESSIONID', '_session', 'auth_cookie', 'access_token'].map(name => `${name}=canary123`),
  ])('detects cookie credentials in both screens: %s', text => {
    expect(sourceLooksSecret(text)).toBe(true);
    expect(routerLooksSecret(text)).toBe(true);
  });

  it.each(['the session ended', 'cookie banner', 'sid', 'author: documentation', 'tokenization: analysis123', 'session=short', 'cookie: banner', 'curl --cookie cookies.txt host', 'sessionid=$SESSION'])('keeps ordinary cookie prose and names: %s', text => {
    expect(sourceLooksSecret(text)).toBe(false);
    expect(routerLooksSecret(text)).toBe(false);
  });

  it('answers the same on the forms both screen and both pass', () => {
    const samples = [
      'curl -H "Authorization: Basic dTpw" host',
      `headers.set("Authorization",\n${' '.repeat(10)}"Basic dTpw");`,
      'postgres://u:%40secret@host/app',
      `Use token sk-${'a'.repeat(24)}testonlynotakey for the call`,
      'headers.set("Authorization", `Bearer ${token}`);',
      'Rename parseRow to parseRecord in src/rows.ts.',
    ];
    for (const s of samples) expect(routerLooksSecret(s), s).toBe(sourceLooksSecret(s));
  });
});
