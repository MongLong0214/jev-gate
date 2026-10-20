import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { looksSecret as routerLooksSecret, SECRET_PATTERNS as ROUTER } from '../../mods/router/hooks/secret.ts';
import { looksSecret as sourceLooksSecret, SECRET_PATTERNS as SOURCE } from '../../src/outbound-text.js';

/**
 * The Router cannot import the Node side of the repository, so it carries a copy of the shared credential screen. A
 * copy that drifts screens one feature's outbound text differently from the other's; this keeps them identical.
 */
describe('credential screen parity', () => {
  it('F1: mirrors the complete assignment screen as well as the prefix patterns', () => {
    const source = readFileSync(new URL('../../src/outbound-text.ts', import.meta.url), 'utf8');
    const router = readFileSync(new URL('../../src/router-secret.ts', import.meta.url), 'utf8');
    expect(router.slice(router.indexOf('export const SECRET_PATTERNS')).trim()).toBe(
      source.slice(source.indexOf('export const SECRET_PATTERNS'), source.indexOf('\n/**\n * The provider')).trim(),
    );
  });

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

  it.each([
    { text: '{"password":"canary-pw-123","api_key":"canary-key-456"}', secret: true },
    { text: "'api_key' => 'canary-key-456'", secret: true },
    { text: '`password`: `canary-pw-123`', secret: true },
    { text: 'aws_secret_access_key=canary-secret-123', secret: true },
    { text: 'password canary-pw-123', secret: true },
    ...['github_pat_', 'sk_live_', 'rk_live_'].map(prefix => ({ text: prefix + 'a1'.repeat(20), secret: true })),
    { text: 'AIza' + 'a'.repeat(35), secret: true },
    { text: 'npm_' + 'a1'.repeat(18), secret: true },
    { text: 'eyJhbGciOiJIUzI1NiJ9.e30.c3ludGhldGlj', secret: true },
    ...['password reset flow', 'the token budget', 'token: number', 'apiKey?: string', 'secret sauce',
      '{"password":""}', '{"password":"<redacted>"}', '{"token":"changeme"}',
      'password=***', 'password=xxx', 'password=${PASSWORD}', 'api_key=$API_KEY'].map(text => ({ text, secret: false })),
  ])('F1: screens new formats and placeholders identically: $text', ({ text, secret }) => {
    expect(sourceLooksSecret(text)).toBe(secret);
    expect(routerLooksSecret(text)).toBe(secret);
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
