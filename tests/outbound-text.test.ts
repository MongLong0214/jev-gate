import { describe, expect, it } from 'vitest';

import { estimateTokens, looksSecret } from '../src/outbound-text.js';

describe('outbound text — credential screen', () => {
  it('screens the conventional credential shapes and leaves ordinary text alone', () => {
    expect(looksSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(looksSecret('ghp_012345678901234567890123456789')).toBe(true);
    expect(looksSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(looksSecret('password = "hunter2hunter2hunter2"')).toBe(true);
    expect(looksSecret('const password = readPassword();')).toBe(false);
    expect(looksSecret('the sk- prefix is how those keys start')).toBe(false);
  });

  it('screens a bearer or basic credential whose token has no conventional prefix', () => {
    // Fake values: neither is a credential anywhere.
    expect(looksSecret('curl -H "Authorization: Bearer q7Zt2mVx9LpR4wKs8NcY" https://example.test')).toBe(true);
    expect(looksSecret('{"Authorization": "Basic dGVzdG9ubHk6bm90YWtleQ=="}')).toBe(true);
    expect(looksSecret('authorization=token Xk3pQ9rT5vW2yZ8m')).toBe(true);
    expect(looksSecret('export TOKEN=1; fetch(url, { headers: { Bearer q7Zt2mVx9LpR4wKs8NcY } })')).toBe(true);
    expect(looksSecret('curl -H "Authorization: Bearer $TOKEN" https://example.test')).toBe(false);
    expect(looksSecret('the bearer of this message carries basic internationalization notes')).toBe(false);
  });

  it('screens a short literal header credential and the backtick form, but not a name, placeholder or concatenation', () => {
    // `dTpw` is base64 of `u:p`: short, and still a whole credential.
    expect(looksSecret('curl -H "Authorization: Basic dTpw" https://example.test')).toBe(true);
    expect(looksSecret('headers: { Authorization: `Bearer abcdefghijklmnopqrstuvwx` }')).toBe(true);
    expect(looksSecret("const password = `hunter2hunter2hunter2`;")).toBe(true);
    expect(looksSecret('headers: { Authorization: `Bearer ${token}` }')).toBe(false);
    expect(looksSecret("headers: { Authorization: 'Bearer ' + token }")).toBe(false);
    expect(looksSecret('Authorization: Bearer <token>')).toBe(false);
    expect(looksSecret('Authorization: Basic {{credentials}}')).toBe(false);
    expect(looksSecret('set Authorization: Bearer %API_TOKEN% in the script')).toBe(false);
  });

  it('screens a literal header credential in subscript, call, template and concatenation forms', () => {
    expect(looksSecret('headers["Authorization"] = "Basic dTpw";')).toBe(true);
    expect(looksSecret('headers.set("Authorization", "Basic dTpw");')).toBe(true);
    expect(looksSecret("req.setRequestHeader('Proxy-Authorization', 'Bearer abc');")).toBe(true);
    expect(looksSecret("headers: { Authorization: `Basic ${'dTpw'}` }")).toBe(true);
    expect(looksSecret("headers: { Authorization: 'Basic ' + 'dTpw' }")).toBe(true);
    expect(looksSecret("const auth = btoa('u:p');")).toBe(true);
    expect(looksSecret("Buffer.from('testonly:notakey').toString('base64')")).toBe(true);
    expect(looksSecret('DATABASE_URL=postgres://app:testonlynotakey@db.internal:5432/app')).toBe(true);
    expect(looksSecret('headers.set("Authorization", `Bearer ${token}`);')).toBe(false);
    expect(looksSecret("headers['Authorization'] = 'Basic ' + encoded;")).toBe(false);
    expect(looksSecret('const auth = btoa(`${user}:${pass}`);')).toBe(false);
    expect(looksSecret('postgres://${USER}:${PASS}@db.internal/app and https://user@example.test/')).toBe(false);
  });

  it('screens a wrapped header call and a percent-encoded URL password, but not a printf or %NAME% placeholder', () => {
    expect(looksSecret('headers.set("Authorization",\n  "Basic dTpw");')).toBe(true);
    expect(looksSecret('const headers = {\r\n  Authorization:\r\n    "Bearer abc" };')).toBe(true);
    // Whitespace has its own bound, so ordinary call indentation and column alignment still screen.
    expect(looksSecret(`      headers.set("Authorization",\n${' '.repeat(10)}"Basic dTpw");`)).toBe(true);
    expect(looksSecret(`req.headers.set(\n\t\t\t\t"Authorization",\n\t\t\t\t\t"Bearer abc");`)).toBe(true);
    expect(looksSecret(`proxy_set_header Authorization${' '.repeat(20)}"Basic dTpw";`)).toBe(true);
    expect(looksSecret('Authorization:\u00a0Basic dTpw')).toBe(true);
    expect(looksSecret(`headers.set("Authorization",\n${' '.repeat(10)}\`Bearer \${token}\`);`)).toBe(false);
    // Past the bounds a gap is not one header: two line breaks, or more than 64 spaces in one run.
    expect(looksSecret('Authorization is described below.\n\nBasic dTpw')).toBe(false);
    expect(looksSecret(`Authorization:${' '.repeat(65)}Basic dTpw`)).toBe(false);
    expect(looksSecret('postgres://u:%40secret@host/app')).toBe(true);
    expect(looksSecret('postgres://u:%ABsecret@host/app')).toBe(true);
    expect(looksSecret('headers.set("Authorization",\n  `Bearer ${token}`);')).toBe(false);
    expect(looksSecret('postgres://u:%DB_PASS%@host/app')).toBe(false);
    expect(looksSecret('sprintf("postgres://%s:%s@%s/app", user, pass, host)')).toBe(false);
    expect(looksSecret("'postgres://%(user)s:%(pw)s@%(host)s/app' % cfg")).toBe(false);
  });
});

describe('outbound text — token estimate', () => {
  it('over-counts rather than under-counts, so the estimate never lets an oversized request through', () => {
    /**
     * Calibrated twice against the live API. The first version charged ASCII at four characters per token, which is
     * prose; real transcript content billed 1.7 bytes per token and still 400'd. ASCII is now 1.5 chars per token.
     * Verified on the real 940 KB transcript afterwards: estimate 20,875, provider billed 15,560, request accepted.
     */
    expect(estimateTokens('abcdef')).toBe(4);
    expect(estimateTokens('한글')).toBe(2);
    expect(estimateTokens('')).toBe(0);
    // Every estimate is at least as large as a 4-chars-per-token reading of the same text.
    const sample = 'const x = compute(a, b); // note\n'.repeat(50);
    expect(estimateTokens(sample)).toBeGreaterThan(Math.ceil(sample.length / 4));
  });
});
