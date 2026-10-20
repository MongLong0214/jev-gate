import { describe, expect, it } from 'vitest';

import { estimateTokens, looksSecret } from '../src/outbound-text.js';
import { looksSecret as routerLooksSecret } from '../src/router-secret.js';

describe.each([['core', looksSecret], ['router', routerLooksSecret]] as const)('outbound text — %s credential screen', (_screen, looksSecret) => {
  it.each([
    'jv_live_' + '0123456789abcdef'.repeat(4),
    'jv_live_canary', 'JV_LIVE_canary', 'prefix_jv_live_canary',
  ])('H1: screens bare Jev keys including embedded and mixed-case prefixes: %s', text => {
    expect(text).not.toMatch(/bearer/i);
    expect(looksSecret(text)).toBe(true);
  });

  it.each([
    'password', 'passwd', 'pwd', 'secret', 'client_secret', 'client-secret', 'clientSecret',
    'api_key', 'apikey', 'api-key', 'access_key', 'secret_key', 'private_key', 'token',
    'access_token', 'refresh_token', 'id_token', 'auth', 'authorization', 'credential', 'credentials',
    'aws_access_key_id', 'aws_secret_access_key', 'aws_session_token',
    'sessionid', 'session', 'sid', 'connect.sid', 'PHPSESSID', 'JSESSIONID', '_session',
    'authentication', 'authToken', 'auth_cookie',
  ])('F1: detects credential assignments for %s in every quote/separator form', key => {
    for (const keyQuote of ['', "'", '"', '`']) for (const valueQuote of ['', "'", '"', '`']) {
      for (const separator of ['=', ':', ': ', '=>']) {
        const text = `  ${keyQuote}${key}${keyQuote} \t ${separator} \t ${valueQuote}canary-pw-123${valueQuote}  `;
        expect(looksSecret(text), text).toBe(true);
      }
    }
  });

  it.each([
    { label: 'quoted JSON credentials', text: '{"password":"canary-pw-123","api_key":"canary-key-456"}' },
    { label: 'short quoted password', text: 'password="u:p"' },
    { label: 'hunter2 password', text: "password: 'hunter2'" },
    { label: 'quoted password with spaces', text: "'password': 'canary phrase 123'" },
    { label: 'Bearer header', text: 'Authorization: Bearer canary123' },
    { label: 'Basic header', text: 'Authorization: Basic dTpw' },
    { label: 'URL userinfo', text: 'https://user:pass@host' },
    { label: 'PEM private key', text: '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----' },
    { label: 'AWS access key ID', text: 'AKIAIOSFODNN7EXAMPLE' },
    { label: 'AWS temporary access key ID', text: 'ASIAIOSFODNN7EXAMPLE' },
    { label: 'AWS secret assignment', text: 'aws_secret_access_key=canary/secret+12345678901234567890123456789' },
    ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'].map(prefix => ({ label: `GitHub ${prefix}`, text: prefix + 'a1'.repeat(20) })),
    ...['xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-'].map(prefix => ({ label: `Slack ${prefix}`, text: prefix + '1234567890-canary' })),
    ...['sk_live_', 'rk_live_', 'sk-', 'sk-ant-'].map(prefix => ({ label: `API key ${prefix}`, text: prefix + 'a1'.repeat(20) })),
    { label: 'Google API key', text: 'AIza' + 'a'.repeat(35) },
    { label: 'JWT', text: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJjYW5hcnkifQ.c3ludGhldGlj' },
    { label: 'JWT short payload', text: 'eyJhbGciOiJIUzI1NiJ9.e30.c3ludGhldGlj' },
    { label: 'npm token', text: 'npm_' + 'a1'.repeat(18) },
    { label: 'netrc password line', text: 'machine host\n  login user\n  password canary-pw-123\n' },
    { label: 'Cookie header', text: 'Cookie: preference=canary123' },
    { label: 'Set-Cookie header', text: 'Set-Cookie: preference=canary123; HttpOnly' },
    { label: 'curl cookie', text: "curl -b 'other=canary123' host" },
    { label: 'session cookie', text: 'connect.sid=s:canary123' },
  ])('F1: detects $label', ({ text }) => {
    expect(looksSecret(text)).toBe(true);
  });

  it.each([
    'PASSWORD=CorrectHorseBatteryStaple',
    'api_key=abcdefghijklmnopqrstuvwxyz',
    'password=abcdefghijklmnop',
    'export API_KEY=abcdefghijklmnopqrstuv',
    'DB_PASSWORD=Sup3rSecretValue',
  ])('G1: detects unquoted strong credentials: %s', text => {
    expect(looksSecret(text)).toBe(true);
  });

  it.each([
    'password', 'passwd', 'api_key', 'apikey', 'api-key', 'apiKey', 'client_secret', 'client-secret', 'clientSecret',
    'secret_key', 'private_key', 'access_key', 'access_token', 'refresh_token', 'id_token',
    'aws_access_key_id', 'aws_secret_access_key', 'aws_session_token', 'PASSWORD', 'API_KEY',
  ])('G1: applies the strong-key rule to %s without weakening reference exclusions', key => {
    expect(looksSecret(`${key}=abcdefgh`)).toBe(true);
    expect(looksSecret(`${key}=abcdefg`)).toBe(false);
    for (const value of ['string', 'number', 'bigint', 'boolean', 'symbol', 'object', 'undefined', 'null', 'any', 'unknown', 'never', 'void',
      'hash', 'process.env.X', 'Namespace1.password', 'readPassword()', 'readPassword ()', '<redacted>', '${DB_PASSWORD}', '$API_KEY']) {
      expect(looksSecret(`${key}: ${value}`), value).toBe(false);
    }
  });

  it.each([
    { label: 'password prose', text: 'password reset flow' },
    { label: 'token prose', text: 'the token budget' },
    { label: 'secret prose', text: 'secret sauce' },
    { label: 'TypeScript token type', text: 'type Options = { token: number }' },
    { label: 'TypeScript optional key', text: 'apiKey?: string' },
    { label: 'TypeScript quoted key', text: 'type Options = { "password": string }' },
    { label: 'computed password', text: 'password = readPassword();' },
    { label: 'computed token', text: 'token = readToken();' },
    ...['', '<redacted>', '***', 'xxx', 'xxxxxxxxxxxxxxxx', 'changeme', '${PASSWORD}', '$API_KEY', '{{password}}', '%PASSWORD%', '%DB_PASS%'].map(value => ({ label: `placeholder ${value || 'empty'}`, text: JSON.stringify({ password: value }) })),
    { label: 'placeholder followed by credential', text: '{"password":"<redacted>","token":number}' },
    { label: 'Bearer reference', text: 'Authorization: Bearer $API_KEY' },
    { label: 'Basic placeholder', text: 'Authorization: Basic <credentials>' },
    { label: 'URL reference', text: 'https://user:${PASSWORD}@host' },
    { label: 'URL without password', text: 'https://user@host/path' },
    { label: 'PEM public key', text: '-----BEGIN PUBLIC KEY-----' },
    { label: 'AWS prefix only', text: 'AKIA is an AWS prefix' },
    { label: 'AWS secret reference', text: 'aws_secret_access_key=$AWS_SECRET_ACCESS_KEY' },
    ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-', 'sk_live_', 'rk_live_', 'sk-', 'sk-ant-', 'AIza', 'npm_'].map(prefix => ({ label: `prefix only ${prefix}`, text: `the ${prefix} prefix` })),
    { label: 'incomplete JWT', text: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJjYW5hcnkifQ' },
    { label: 'netrc reference', text: 'machine host\npassword $PASSWORD\n' },
    { label: 'netrc empty password', text: 'machine host\npassword\n' },
    { label: 'cookie prose', text: 'cookie banner; the session ended' },
    { label: 'cookie file', text: 'curl --cookie cookies.txt host' },
    { label: 'session reference', text: 'sessionid=$SESSION' },
  ])('F1: leaves $label alone', ({ text }) => {
    expect(looksSecret(text)).toBe(false);
  });

  it.each([
    'max token: 4000',
    'input token: 1234, output token: 99',
    'password: hash',
    'secret: foo',
    'pwd: /Users/isaac',
    'credentials: include',
    "fetch(url, { credentials: 'include' })",
    'token=abc',
    'auth: none',
    'the token: budget is tight',
    'Gate A auth: ok',
    'headers: { authorization: authValue }',
    '{ token: newToken }',
    'pass token: tokenValue to helper',
    'id_token: decoded.sub',
    'set token: process.env.API_TOKEN',
    'secret = getSecret()',
    'session: ended',
    'sid: 42',
    'password=readPassword()',
    'password: <redacted>',
    'PASSWORD=${DB_PASSWORD}',
    'api_key=$API_KEY',
  ])('F1 false-positive fix: keeps ordinary prose and references: %s', text => {
    expect(looksSecret(text)).toBe(false);
  });

  it.each([
    { text: 'token=1234567', secret: false },
    { text: 'token=12345678', secret: true },
    { text: 'secret=AbC9xYz12345', secret: true },
    { text: '"token":"canary-key-456"', secret: true },
    { text: "credentials: 'same-origin'", secret: false },
    { text: "token: 'abc-defg'", secret: false },
    { text: "token: 'abc-defghijklmn'", secret: false },
    { text: "token: 'abc-defghijklmno'", secret: true },
    { text: "token: 'abcdefghijklmnop'", secret: false },
    { text: 'password=abcdefghijklmnop', secret: true },
    { text: 'password=Namespace1.password', secret: false },
    { text: 'password=/tmp/canary123', secret: false },
    { text: 'password=~/canary123', secret: false },
    { text: 'token=process.env.API_TOKEN123', secret: false },
    { text: 'sessionid=newToken', secret: false },
    { text: "sessionid='tokenValue'", secret: false },
    { text: 'sessionid=decoded.sub', secret: false },
    { text: 'sessionid=/tmp/canary123', secret: false },
    { text: 'sessionid=abc-def', secret: false },
    { text: 'sessionid=abc-defg', secret: true },
    { text: 'sessionid=canary123', secret: true },
  ])('F1 false-positive fix: applies credential value thresholds: $text', ({ text, secret }) => {
    expect(looksSecret(text)).toBe(secret);
  });

  it('F1 false-positive fix: keeps short strong literals in every quote style', () => {
    for (const key of ['password', 'passwd', 'api_key', 'client_secret', 'secret_key', 'private_key', 'access_key', 'access_token', 'refresh_token', 'id_token', 'aws_secret_access_key']) {
      for (const quote of ["'", '"', '`']) {
        expect(looksSecret(`${key}: ${quote}p${quote}`)).toBe(true);
        expect(looksSecret(`${key}: ${quote}hunter2${quote}`)).toBe(true);
      }
    }
  });

  it('F1: leaves placeholders alone for every assignment quote and separator', () => {
    for (const key of ['password', 'api_key', 'token', 'auth', 'sessionid']) {
      for (const keyQuote of ['', "'", '"', '`']) for (const valueQuote of ['', "'", '"', '`']) {
        for (const separator of ['=', ':', ': ', '=>']) for (const value of ['<redacted>', '***', 'xxx', 'changeme', '${PASSWORD}', '$API_KEY']) {
          const text = `${keyQuote}${key}${keyQuote} ${separator} ${valueQuote}${value}${valueQuote}`;
          expect(looksSecret(text), text).toBe(false);
        }
      }
    }
    expect(looksSecret('password="<redacted>"; api_key="canary-key-456"')).toBe(true);
  });

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
