import { describe, expect, it } from 'vitest';

import { estimateTokens, looksSecret } from '../src/outbound-text.js';
import { looksSecret as routerLooksSecret } from '../src/router-secret.js';

import { ASSIGNMENT_CONTEXTS, CREDENTIAL_WORDS, KEY_SPELLINGS } from './fixtures/credential-corpus.js';

// Each exclusion has a whole-value negative and a value with literal material beside the same shape.
// Already anchored masks/thresholds are preservation cases; the partial reference/path/call cases reproduce J1.
const PLACEHOLDER_VALUES = [
  { branch: 'empty', whole: '', partial: 's3cure123' },
  { branch: 'dollar name prefix', whole: '$PASSWORD', partial: '$uperS3cret!' },
  { branch: 'dollar brace infix', whole: '${PASSWORD}', partial: 's3cure${literal}' },
  { branch: 'dollar default prefix', whole: '${PASSWORD:-}', partial: '${PASSWORD:-default}s3cure123' },
  { branch: 'percent name suffix', whole: '%PASSWORD%', partial: 's3cure%HOME%' },
  { branch: 'angle prefix', whole: '<redacted>', partial: '<a1b2c3d4e5f6>x' },
  { branch: 'double brace prefix', whole: '{{password}}', partial: '{{password}}s3cure123' },
  { branch: 'single brace prefix', whole: '{password}', partial: '{s3cret}pass' },
  { branch: 'bracket word prefix', whole: '[REDACTED]', partial: '[REDACTED]s3cure123' },
  { branch: 'all stars prefix', whole: '***', partial: '***s3cure123' },
  { branch: 'all x suffix', whole: 'xxxxxxxxxxxxxxxx', partial: 's3cure123xxxxxxxxxxxxxxxx' },
  { branch: 'changeme prefix', whole: 'changeme', partial: 'changemes3cure123' },
  { branch: 'printf slot prefix', whole: '%s', partial: '%ss3cure123' },
  { branch: 'named printf slot prefix', whole: '%(pw)s', partial: '%(pw)ss3cure123' },
  { branch: 'separator-only references', whole: '${USER}:${PASS}', partial: '${USER}:s3cure123${PASS}' },
];
const EXCLUSION_CASES = [
  ...PLACEHOLDER_VALUES.flatMap(row => [
    { ...row, context: 'assignment', render: (value: string) => `password="${value}"` },
    { ...row, context: 'header', render: (value: string) => `Authorization: Basic ${value}` },
    { ...row, context: 'URL', render: (value: string) => `postgres://u:${value}@host/app` },
  ]),
  ...[
    { branch: 'absolute path', whole: '/tmp/canary123', partial: '/tmp/canary123!' },
    { branch: 'home path', whole: '~/canary123', partial: '~s3cure123' },
    { branch: 'call suffix', whole: 'readPassword()', partial: 'canary-123()' },
    { branch: 'call followed by literal', whole: 'readPassword ()', partial: 'readPassword()s3cure123' },
    { branch: 'member suffix', whole: 'Namespace1.password', partial: 'canary-123 .value' },
    { branch: 'subscript suffix', whole: 'readPassword[index]', partial: 'canary-123[index]' },
    { branch: 'optional member suffix', whole: 'readPassword?.value', partial: 'canary-123?.value' },
    { branch: 'strong primitive', whole: 'undefined', partial: 'undefined123' },
  ].map(row => ({ ...row, context: 'unquoted assignment', render: (value: string) => `password=${value}` })),
  { branch: 'generic identifier', whole: 'tokenValue', partial: 'tokenValue123', context: 'generic assignment', render: (value: string) => `token=${value}` },
  { branch: 'cookie identifier', whole: 'tokenValue', partial: 'tokenValue123', context: 'cookie assignment', render: (value: string) => `sessionid="${value}"` },
  { branch: 'cookie minimum', whole: 'abc-def', partial: 'abc-def123', context: 'cookie assignment', render: (value: string) => `sessionid=${value}` },
  { branch: 'strong unquoted minimum', whole: 'abcdefg', partial: 'abcdefg123', context: 'unquoted assignment', render: (value: string) => `password=${value}` },
  { branch: 'generic digit minimum', whole: 'canary1', partial: 'canary123', context: 'generic assignment', render: (value: string) => `token=${value}` },
  { branch: 'generic nondigit minimum', whole: 'abc-defg', partial: 'abc-defghijklmno', context: 'generic assignment', render: (value: string) => `token=${value}` },
  { branch: 'concatenated name', whole: 'token', partial: "token + 's3cure123'", context: 'header concatenation', render: (value: string) => `headers: { Authorization: 'Basic ' + ${value} }` },
  { branch: 'adjacent concatenated names', whole: 'token+other', partial: "token+other+'s3cure123'", context: 'header concatenation', render: (value: string) => `headers: { Authorization: 'Basic '+${value} }` },
  { branch: 'concatenated quoted template', whole: "'${TOKEN}'", partial: "'${TOKEN}s3cure123'", context: 'header concatenation', render: (value: string) => `headers: { Authorization: 'Basic ' + ${value} }` },
  { branch: 'unrelated key rescan', whole: 'ordinary note', partial: "password='s3cure${literal}'", context: 'nested assignment', render: (value: string) => `note="${value}"` },
  { branch: 'cookie key ownership', whole: 'include', partial: 'canary123', context: 'generic assignment', render: (value: string) => `auth="${value}"` },
  ...['btoa', 'Buffer.from'].map(call => ({ branch: 'Basic template password', whole: '${USER}:${PASS}', partial: '${USER}:s3cure${PASS}', context: call, render: (value: string) => `${call}(\`${value}\`)` })),
].flatMap(({ render, ...row }) => [
  { ...row, form: 'whole negative', text: render(row.whole), secret: false },
  { ...row, form: 'partial positive', text: render(row.partial), secret: true },
]);

// Synthetic values only. Stable group/row/variant names make the baseline and fixed JSON reports comparable.
const FORMAT_PLACEHOLDERS = ['<password>', '${X}', '${X:-}', '***', 'xxx', 'changeme', '{{ secrets.X }}', '$X', '%X%', '[REDACTED]'];
const HEADER_FORMATS = [
  { syntax: 'bare', render: (key: string, value: string) => `${key}: ${value}` },
  ...["'", '"', '`'].map(quote => ({ syntax: `quoted ${quote}`, render: (key: string, value: string) => `${quote}${key}${quote}: ${quote}${value}${quote}` })),
  { syntax: 'JSON compact', render: (key: string, value: string) => `{"${key}":"${value}"}` },
  { syntax: 'JSON spaced', render: (key: string, value: string) => `{ "${key}" \t : \t "${value}" }` },
  { syntax: 'YAML', render: (key: string, value: string) => `headers:\n  ${key}: ${value}` },
  { syntax: 'Python dict', render: (key: string, value: string) => `headers = {'${key}': '${value}'}` },
  { syntax: 'JS dict', render: (key: string, value: string) => `const headers = { ${key}: '${value}' };` },
  { syntax: 'HTTP raw', render: (key: string, value: string) => `GET / HTTP/1.1\r\n${key}: ${value}\r\n` },
  { syntax: 'curl', render: (key: string, value: string) => `curl -H '${key}: ${value}' https://example.test` },
  { syntax: 'fetch', render: (key: string, value: string) => `fetch(url, { headers: { "${key}": "${value}" } })` },
  { syntax: 'requests', render: (key: string, value: string) => `requests.get(url, headers={'${key}': '${value}'})` },
];
const FORMAT_LITERAL = 'review-canary-12345678';
const CREDENTIAL_FORMAT_CORPUS = [
  ...[
    { label: 'env', render: (value: string) => `API_KEY=${value}` },
    { label: '.env', render: (value: string) => `# fixture .env\nDB_PASSWORD="${value}"\n` },
    { label: 'export', render: (value: string) => `export API_KEY=${value}` },
    { label: 'Dockerfile ENV equals', render: (value: string) => `ENV API_KEY=${value}` },
    { label: 'Dockerfile ENV space', render: (value: string) => `ENV API_KEY ${value}` },
    { label: 'Dockerfile ARG', render: (value: string) => `ARG DB_PASSWORD=${value}` },
    { label: 'compose list', render: (value: string) => `environment:\n  - DB_PASSWORD=${value}` },
    { label: 'compose map', render: (value: string) => `environment:\n  DB_PASSWORD: "${value}"` },
    { label: 'Kubernetes stringData', render: (value: string) => `kind: Secret\nstringData:\n  password: "${value}"` },
    { label: 'Kubernetes data base64', value: 'cmV2aWV3LWNhbmFyeS0xMjM0NTY3OA==', render: (value: string) => `kind: Secret\ndata:\n  password: ${value}` },
    { label: 'GitHub Actions env', render: (value: string) => `env:\n  API_KEY: ${value}` },
    { label: 'GitHub Actions secrets twin', placeholder: '${{ secrets.X }}', render: (value: string) => `env:\n  API_KEY: "${value}"` },
  ].map(row => ({ ...row, group: 'config' })),
  ...[
    ...['postgres', 'postgresql+psycopg', 'mysql', 'mongodb+srv', 'amqp'].map(scheme => ({
      label: scheme, value: 'pass', render: (value: string) => `${scheme}://user:${value}@host/db`,
    })),
    { label: 'redis empty user', value: 'pass', render: (value: string) => `redis://:${value}@host` },
    { label: 'JDBC query', value: 'p', render: (value: string) => `jdbc:postgresql://host/db?user=u&password=${value}` },
    { label: 'ADO.NET', value: 'p', render: (value: string) => `Server=host;User Id=u;Password=${value};` },
    { label: 'Azure AccountKey', render: (value: string) => `DefaultEndpointsProtocol=https;AccountName=fixture;AccountKey=${value};` },
    { label: 'Azure SAS', render: (value: string) => `SharedAccessSignature=sv=2026-01-01&sig=${value}` },
  ].map(row => ({ ...row, group: 'connections' })),
  ...[
    { label: '.npmrc', render: (value: string) => `//registry.npmjs.org/:_authToken=${value}` },
    { label: '.pypirc', render: (value: string) => `[pypi]\nusername = review\npassword = ${value}` },
    { label: 'pip.conf', render: (value: string) => `[global]\nindex-url = https://user:${value}@packages.example.test/simple` },
    { label: 'docker auth base64', value: 'dTpw', render: (value: string) => `{"auths":{"registry.example.test":{"auth":"${value}"}}}` },
    { label: 'AWS credentials', render: (value: string) => `[fixture]\naws_secret_access_key = ${value}` },
    { label: 'GCP service account PEM', value: '-----BEGIN PRIVATE KEY-----\\nSYNTHETIC\\n-----END PRIVATE KEY-----', render: (value: string) => `{"type":"service_account","private_key":"${value}"}` },
    { label: '.netrc', render: (value: string) => `machine example.test\nlogin review\npassword ${value}\n` },
    { label: '.netrc inline', render: (value: string) => `machine example.test login review password ${value}` },
    { label: 'git remote', render: (value: string) => `git remote add origin https://user:${value}@github.com/org/repo.git` },
  ].map(row => ({ ...row, group: 'credential-files' })),
  ...[
    { name: 'Authorization', value: `Bearer ${FORMAT_LITERAL}`, wrap: (value: string) => `Bearer ${value}` },
    { name: 'Proxy-Authorization', value: `Basic ${FORMAT_LITERAL}`, wrap: (value: string) => `Basic ${value}` },
    { name: 'Cookie', value: `custom_login=${FORMAT_LITERAL}`, wrap: (value: string) => `custom_login=${value}` },
    { name: 'Set-Cookie', value: `custom_login=${FORMAT_LITERAL}; HttpOnly`, wrap: (value: string) => `custom_login=${value}; HttpOnly` },
    { name: 'X-Api-Key', value: FORMAT_LITERAL, wrap: (value: string) => value },
  ].flatMap(header => KEY_SPELLINGS.flatMap(spelling => HEADER_FORMATS.map(format => ({
    group: 'headers', label: `${header.name} / ${spelling.spelling} / ${format.syntax}`, value: header.value,
    render: (value: string) => format.render(spelling.key(header.name), value), wrap: header.wrap,
  })))),
  ...[
    { name: 'Authorization token', value: 'ghp_' + 'a1'.repeat(20), wrap: (value: string) => `token ${value}` },
    { name: 'Authorization Basic', value: 'dTpw', wrap: (value: string) => `Basic ${value}` },
  ].flatMap(header => HEADER_FORMATS.map(format => ({
    group: 'header-schemes', label: `${header.name} / ${format.syntax}`, value: header.value,
    render: (value: string) => format.render('Authorization', header.wrap(value)),
  }))),
  ...[
    ...['sk-', 'sk-ant-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-',
      'npm_', 'sk_live_', 'rk_live_', 'jv_live_', 'ya29.'].map(prefix => ({ name: prefix, value: prefix + 'a1'.repeat(20) })),
    ...['AKIA', 'ASIA'].map(prefix => ({ name: prefix, value: prefix + 'A1'.repeat(8) })),
    { name: 'AIza', value: 'AIza' + 'a'.repeat(35) },
    { name: 'JWT', value: 'eyJhbGciOiJIUzI1NiJ9.e30.c3ludGhldGlj' },
    { name: 'PEM', value: '-----BEGIN PRIVATE KEY-----\\nSYNTHETIC\\n-----END PRIVATE KEY-----' },
  ].flatMap(token => [
    { syntax: 'JSON string', render: (value: string) => `{"message":"${value}"}` },
    { syntax: 'URL path', render: (value: string) => `https://example.test/${value}` },
    { syntax: 'query', render: (value: string) => `https://example.test/?value=${value}` },
    { syntax: 'prose', render: (value: string) => `Observed ${value} during review.` },
  ].map(format => ({ group: 'provider-tokens', label: `${token.name} / ${format.syntax}`, value: token.value, render: format.render }))),
  ...[
    { label: 'Slack', render: (value: string) => `https://hooks.slack.com/services/T000REVIEW/B000REVIEW/${value}` },
    { label: 'Discord', render: (value: string) => `https://discord.com/api/webhooks/123456789012345678/${value}` },
  ].map(row => ({ ...row, group: 'webhooks' })),
  ...[':-', '-', ':=', '=', ':?', ':+'].flatMap(operator => [
    { syntax: 'assignment', render: (value: string) => `password="\${PASSWORD${operator}${value}}"` },
    { syntax: 'header', render: (value: string) => `Authorization: Bearer \${TOKEN${operator}${value}}` },
    { syntax: 'URL', render: (value: string) => `postgres://user:\${PASSWORD${operator}${value}}@host/db` },
    { syntax: 'Basic input', render: (value: string) => `btoa('user:\${PASSWORD${operator}${value}}')` },
  ].flatMap(context => [
    { label: `${operator} / ${context.syntax}`, render: context.render },
    { label: `${operator} / ${context.syntax} / nested`, render: (value: string) => context.render(`\${INNER:-${value}}`) },
    { label: `${operator} / ${context.syntax} / literal beside references`, render: (value: string) => context.render(`\${PREFIX}${value}\${SUFFIX}`) },
  ].map(row => ({ ...row, group: 'shell-defaults' })))),
  ...[
    { label: 'L1 dotted password', value: 'correct.horse.battery.staple', render: (value: string) => `PASSWORD=${value}` },
    { label: 'L1 OAuth access token', value: 'ya29.a0AfH6SMBsynthetic1234567890', render: (value: string) => `access_token=${value}` },
    { label: 'K1 quoted JSON Cookie', value: 'a1b2c3d4e5f6g7h8', render: (value: string) => `{"Cookie":"custom_login=${value}"}` },
    { label: 'K2 quoted password default', value: 'hunter2', render: (value: string) => `password="\${PASSWORD:-${value}}"` },
    { label: 'K2 Bearer default', value: 'abc123def456ghi789', render: (value: string) => `Authorization: Bearer \${TOKEN:-${value}}` },
  ].map(row => ({ ...row, group: 'reproductions' })),
].map(row => ({ value: FORMAT_LITERAL, wrap: (value: string) => value, placeholder: undefined as string | undefined, ...row }));
const CREDENTIAL_FORMAT_CASES = CREDENTIAL_FORMAT_CORPUS.flatMap(row => [
  { ...row, variant: 'literal', text: row.render(row.value), secret: true },
  ...[...FORMAT_PLACEHOLDERS, ...(row.placeholder ? [row.placeholder] : [])].map((value, i) => ({
    ...row, variant: `placeholder ${i + 1}`, text: row.render(row.wrap(value)), secret: false,
  })),
]);

// Synthetic, approximately 100 KB cases cover overlapping keys, failed suffixes and each connection format.
const PERFORMANCE_CASES = [
  { label: 'dotted literal', text: 'password=' + 'ordinary.'.repeat(11_111) + 'value', secret: true },
  { label: 'dotted failed camelCase', text: 'password=unrecognised.' + 'aA'.repeat(50_000) + '_', secret: true },
  { label: 'assignment chain', text: 'a='.repeat(50_000), secret: false },
  { label: 'URL userinfo', text: 'https://' + 'u:'.repeat(50_000) + '@h', secret: false },
  { label: 'key suffixes', text: 'password_'.repeat(11_111) + '=x', secret: false },
  { label: 'quoted assignments', text: '"password":"'.repeat(8_333), secret: false },
  { label: 'nested shell defaults', text: '${A:-'.repeat(20_000), secret: false },
  { label: 'balanced shell defaults', text: '${A:-'.repeat(16_666) + 'x' + '}'.repeat(16_666), secret: false },
  { label: 'CLI key', text: '--a-'.repeat(25_000), secret: false },
  { label: 'cookie pairs', text: 'Cookie: ' + 'a=b; '.repeat(20_000), secret: true },
  { label: 'camel boundaries', text: 'aB'.repeat(50_000) + 'Password=x', secret: false },
  { label: 'key whitespace', text: 'password' + ' '.repeat(100_000) + '=x', secret: false },
  { label: 'unfinished netrc whitespace', text: 'password' + ' '.repeat(100_000), secret: false },
  { label: 'netrc machine whitespace', text: 'machine ' + ' '.repeat(100_000), secret: false },
  { label: 'netrc value suffix', text: 'password ' + 'a .b'.repeat(25_000) + '>', secret: false },
  { label: 'query pairs', text: 'k=v&'.repeat(25_000), secret: false },
  { label: 'JDBC prefixes', text: 'jdbc:'.repeat(20_000), secret: false },
  { label: 'connection prefixes', text: 'Server='.repeat(14_286), secret: false },
  { label: 'SAS prefixes', text: 'SharedAccessSignature='.repeat(4_762), secret: false },
  { label: 'Docker prefixes', text: '"auths":{'.repeat(11_111), secret: false },
  { label: 'realistic query', text: ('https://example.test/?' + Array.from({ length: 2_000 }, (_, i) => `item${i}=ordinary${i}`).join('&')).slice(0, 40_000), secret: false },
  { label: 'minified bundle', text: '(()=>{const a=1,b="ordinary";function f(x){return x+a}window.result=f(b.length)})();'.repeat(1_400).slice(0, 106_000), secret: false },
];

describe.each([['core', looksSecret], ['router', routerLooksSecret]] as const)('outbound text — %s credential screen', (_screen, looksSecret) => {
  it.each(PERFORMANCE_CASES)('performance: screens $label without rescanning overlapping values', ({ text, secret }) => {
    const started = performance.now();
    const result = looksSecret(text);
    const elapsed = performance.now() - started;
    expect(result).toBe(secret);
    expect(elapsed).toBeLessThan(200);
  });

  it.each([
    ...[
      'a=password="p"', '--a=password="p"', 'ENV a password="p"', 'machine  password "p"',
      'Server=jdbc:x?password=ref(Server=s;Password=p)', 'Server=nope\nServer=host;Password=p',
      'jdbc:jdbc:host?pwd=p', 'SharedAccessSignature=SharedAccessSignature=x&sig=p',
      '"auths":{"auths":{"auth":"p"}}',
      'Server=jdbc:x?password=ref() Server=s;Password=p',
      'Server=no-password; jdbc:x?password=ref(Server=s;Password=p)',
    ].map(text => ({ text, secret: true })),
    ...[
      'Server=not-password\npassword=p', 'jdbc:x no?password=p',
      'SharedAccessSignature=x" &sig=p', '"auths":{} "auth":"p"',
    ].map(text => ({ text, secret: false })),
  ])('preserves nested keys, earliest connection matches and format boundaries: $text', ({ text, secret }) => {
    expect(looksSecret(text)).toBe(secret);
  });

  it.each(CREDENTIAL_FORMAT_CASES)('credential-format corpus | $group | $label | $variant', ({ text, secret }) => {
    expect(looksSecret(text)).toBe(secret);
  });

  it.each([
    ...['correct.horse.battery.staple', 'unrecognised.lowercase.path', 'UPPER.CASE.LITERAL',
      'process.env.secret1234', 'Namespace1234.password', 'library.readPassword1234', 'process.1234.value',
      'process.abc1234def', 'ya29.QkSzXDbKjobkPTn'].map(value => ({ value, secret: true })),
    ...['process.env.API_TOKEN', 'decoded.sub', 'Namespace1.password', 'library.readPassword', 'Library.password',
      'process.env.API_TOKEN123', 'library.readPassword123'].map(value => ({ value, secret: false })),
  ])('L1: distinguishes whole dotted code references from literals: $value', ({ value, secret }) => {
    for (const key of ['password', 'access_token', 'token', 'sessionid']) expect(looksSecret(`${key}=${value}`), key).toBe(secret);
    // Quoted strong-key values remain literals even when the text names a code reference.
    for (const quote of ['"', "'", '`']) expect(looksSecret(`password=${quote}${value}${quote}`)).toBe(true);
  });

  it.each([0, 15, 16, 64])('L1: requires at least sixteen OAuth suffix characters (length=%s)', length => {
    expect(looksSecret('Observed ya29.' + 'a'.repeat(length) + ' during review.')).toBe(length >= 16);
  });

  it.each(['synthetic-re', 'readPassword()', 'correct.corr', 'ya29.QkSzXDbKjobkPTn'])(
    'L1 differential: retains quoted Authorization literals from twelve characters: %s', value => {
      for (const quote of ['"', "'", '`']) expect(looksSecret(`authorization=${quote}${value}${quote}`)).toBe(true);
    },
  );

  it.each([':-', '-', ':=', '=', ':?', ':+'])('K2: applies the existing key thresholds to %s operator text', operator => {
    const reference = (value: string) => `\${PASSWORD${operator}${value}}`;
    for (const [value, bare, quoted, generic] of [
      ['hunter2', false, true, false], ['abcdefgh', true, true, false], ['canary123', true, true, true],
      ['', false, false, false], ['<redacted>x', false, true, false],
    ] as const) {
      expect(looksSecret(`password=${reference(value)}`)).toBe(bare);
      expect(looksSecret(`password="${reference(value)}"`)).toBe(quoted);
      expect(looksSecret(`token="${reference(value)}"`)).toBe(generic);
    }
  });

  it('K2: recursively screens nested operator text and preserves reference-only defaults', () => {
    for (const [literal, secret] of [['canary123', true], ['${REFERENCE}', false]] as const) {
      let value: string = literal;
      for (let i = 0; i < 32; i++) value = `\${LEVEL${i}:-${value}}`;
      expect(looksSecret(`password="${value}"`)).toBe(secret);
      expect(looksSecret(`Authorization: Basic ${value}`)).toBe(secret);
      expect(looksSecret(`postgres://u:${value}@host/db`)).toBe(secret);
    }
    // These nonempty defaults were previously accepted as references; their literals are now screened.
    for (const text of ['password="${PASSWORD:-default}"', 'Authorization: Basic ${DB_USER:-user}:${DB_PASS:-default}']) {
      expect(looksSecret(text)).toBe(true);
    }
  });

  it.each(EXCLUSION_CASES)('J1 exclusion: $context / $branch / $form', ({ text, secret }) => {
    expect(looksSecret(text), text).toBe(secret);
  });

  it.each(['${DB_USER}:${DB_PASS}', '${DB_USER:-}:${DB_PASS:-}', '$HOST:$PORT', '$HOST.$PORT', '<user>:<password>', '<user>@<password>', '{{user}}:{password}', '[USER]:[PASSWORD]'])(
    'J1: keeps separator-only reference combinations: %s', value => {
      for (const quote of ['', "'", '"', '`']) expect(looksSecret(`password=${quote}${value}${quote}`)).toBe(false);
      expect(looksSecret(`Authorization: Basic ${value}`)).toBe(false);
      expect(looksSecret(`postgres://u:${value}@host/app`)).toBe(false);
      expect(looksSecret(`btoa(\`${value}\`)`)).toBe(false);
    },
  );

  it.each([':', '.', '_', '/', '+', '=', '@', '!', '***s3cure123', 's3cure123xxx', 'changemes3cure123'])(
    'J1: preserves quoted strong literals that are not whole placeholders: %s', value => {
      expect(looksSecret(`password="${value}"`)).toBe(true);
    },
  );

  it.each([
    { value: '${PASSWORD}a', generic: false, strongBare: false },
    { value: '${PASSWORD}abcdefgh', generic: false, strongBare: true },
    { value: '${PASSWORD}1234567', generic: false, strongBare: false },
    { value: '${PASSWORD}12345678', generic: true, strongBare: true },
  ])('J1: applies thresholds to the literal remainder, not the reference length: $value', ({ value, generic, strongBare }) => {
    expect(looksSecret(`password="${value}"`)).toBe(true);
    expect(looksSecret(`password=${value}`)).toBe(strongBare);
    expect(looksSecret(`token="${value}"`)).toBe(generic);
    expect(looksSecret(`token=${value}`)).toBe(generic);
    expect(looksSecret(`sessionid=${value}`)).toBe(generic);
  });

  it.each(['password=', '--password ', 'password '])('J1: shares complete-value screening with CLI and netrc: %s', prefix => {
    for (const quote of ['', "'", '"', '`']) {
      expect(looksSecret(prefix + quote + '${PASSWORD}' + quote)).toBe(false);
      expect(looksSecret(prefix + quote + '${PASSWORD}s3cure123' + quote)).toBe(true);
    }
  });

  it.each(KEY_SPELLINGS.flatMap(spelling => ASSIGNMENT_CONTEXTS.map(context => ({ ...spelling, ...context }))))(
    'I1 key-name matrix: $spelling / $context', ({ key, render }) => {
      for (const { word, strong } of CREDENTIAL_WORDS) for (const quote of ['', "'", '"', '`']) {
        for (const value of ['canary-pw-123', '<redacted>', '***', 'xxx', 'changeme', '${PASSWORD}', '$API_KEY', '{{password}}', '%PASSWORD%']) {
          const text = render(key(word), quote + value + quote);
          expect(looksSecret(text), text).toBe(value === 'canary-pw-123');
        }
        // The terminal credential word owns the threshold, including when a cookie-like prefix is present.
        const alphabetic = render(key(word), quote + 'reviewonlypassword' + quote);
        expect(looksSecret(alphabetic), alphabetic).toBe(strong);
        const short = render(key(word), quote + 'p' + quote);
        expect(looksSecret(short), short).toBe(strong && quote !== '');
        if (!quote) for (const value of ['process.env.API_TOKEN', 'readPassword()', 'readPassword ()']) {
          const text = render(key(word), value);
          expect(looksSecret(text), text).toBe(false);
        }
      }
    },
  );

  it.each([
    'DB_PASSWORD', 'db_password', 'db.password', 'db-password', 'dbPassword', 'DbPassword', 'DBPassword', '9_password', '.db.password',
    'MY_API_KEY', 'x-api-key', 'X-Api-Key', 'stripeSecretKey', 'githubAccessToken', 'confirm_password',
    'AWS_SECRET_ACCESS_KEY', 'client.secret', 'csrf_token', 'session.token',
  ])('I1: recognizes the complete terminal credential key %s inline', key => {
    expect(looksSecret(`Observed {"${key}":"canary-pw-123"} during review.`)).toBe(true);
  });

  it.each(['csrf_token', 'session.token', 'my_auth', 'dbSecret', 'UserCredentials', 'APP_PWD', 'myAuthorization'])('I1: preserves generic thresholds for %s', key => {
    for (const value of ['reviewonlypassword', 'include', 'authValue', 'abc-defg']) {
      expect(looksSecret(`${key}='${value}'`)).toBe(false);
    }
    expect(looksSecret(`${key}='Bearer canary123'`)).toBe(true);
  });

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
    'input_tokens: 1234',
    'cache_creation_input_tokens: 45000',
    'token_count: 12',
    'password_reset_flow: enabled',
    '"author": "Isaac Kim 2026"',
    'authority: central-bank-01',
    'secretary: Jane Doe 2026',
    '--password-file ./pw.txt',
    '--api-key-env API_KEY',
    'const { password } = req.body;',
    'user.password = await hash(input.password)',
    '"Cookie": cookieHeader',
    'headers: { Cookie: jar.header() }',
    'Set-Cookie handling in middleware',
    'postgres://localhost:5432/db',
    'postgres://user@localhost/db',
    'redis://localhost:6379',
    'https://github.com/org/repo.git',
    'type Config = { apiKey?: string; token: number }',
  ])('F1 false-positive fix: keeps ordinary prose and references: %s', text => {
    expect(looksSecret(text)).toBe(false);
  });

  it.each(['password_reset_flow', 'tokens', 'input_tokens', 'cache_creation_input_tokens', 'token_count', 'secretary', 'authority', 'author', 'password-file', 'api-key-env'])(
    'I1: rejects nonterminal credential words regardless of value shape: %s', key => {
      for (const quote of ['', "'", '"', '`']) {
        expect(looksSecret(`${key}: ${quote}canary-pw-123${quote}`)).toBe(false);
        expect(looksSecret(`--${key}=${quote}canary-pw-123${quote}`)).toBe(false);
      }
    },
  );

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
