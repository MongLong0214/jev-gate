import { describe, expect, it } from 'vitest';

import { looksSecret } from '../src/outbound-text.js';
import { looksSecret as routerLooksSecret } from '../mods/router/hooks/secret.ts';
import { ASSIGNMENT_CONTEXTS, CLI_CREDENTIAL_CASES, CLI_CREDENTIAL_NEGATIVES, CREDENTIAL_WORDS, KEY_SPELLINGS } from './fixtures/credential-corpus.js';
import { looksSecret as baselineLooksSecret } from './fixtures/looks-secret-0.8.31.js';

// Match the seeded generator used by the benchmark runner, without depending on its CLI entry point.
const random = (() => {
  let a = 0x0832;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const sample = (alphabet: string, length: number) => Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]!).join('');
const VALUES = Array.from({ length: 57 }, (_, i) => {
  const length = i + 8;
  const words = ['correct', 'horse', 'battery', 'staple', 'synthetic', 'review'];
  const joined = (separator: string) => Array.from({ length: 12 }, () => words[Math.floor(random() * words.length)]!).join(separator).slice(0, length);
  return [
    sample('abcdefghijklmnopqrstuvwxyz', length), sample('0123456789', length),
    sample('0123456789abcdef', length), sample('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-', length),
    Buffer.from(sample('abcdefghijklmnopqrstuvwxyz0123456789', length)).toString('base64').slice(0, length),
    ...['.', '-', '_'].map(joined),
    // Dots with digit runs, including digit-leading segments that cannot be code identifiers.
    `review.${sample('0123456789', 1 + i % 10)}.${sample('abcdefghijklmnopqrstuvwxyz', length)}`,
    ...['ya29.', 'sk-', 'ghp_', 'xoxb-', 'AKIA', 'jv_live_'].map(prefix => prefix + sample('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', length)),
    `eyJ${sample('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-', length)}.e30.c3ludGhldGlj`,
  ];
}).flat();

const ROOTS = ['process', 'this', 'self', 'cls', 'config', 'conf', 'settings', 'env', 'os', 'req', 'request', 'res', 'response',
  'ctx', 'context', 'options', 'opts', 'args', 'argv', 'params', 'input', 'data', 'body', 'props', 'state', 'user', 'session',
  'window', 'globalThis', 'import', 'module', 'exports', 'app', 'client', 'secrets', 'vars', 'inputs', 'matrix', 'github',
  'decoded', 'payload', 'claims', 'token', 'credentials', 'creds', 'auth', 'keys', 'cfg'];
const CODE_REFERENCES = [...ROOTS.map(root => `${root}.value`), 'process.env.API_TOKEN', 'process.env.API_TOKEN123', 'decoded.sub',
  'Namespace1.password', 'library.readPassword', 'Library.password'];
const CALLS = ['readPassword()', 'readPassword ()', 'resolveAccessToken(input)', 'readPassword[index]', 'readPassword?.value'];
const TYPES = ['string', 'number', 'bigint', 'boolean', 'symbol', 'object', 'undefined', 'null', 'any', 'unknown', 'never', 'void'];
const PATHS = ['/tmp/syntheticcanary123', '~/syntheticcanary123'];
const MASKS = ['xxxxxxxxxxxxxxxx', '${SYNTHETIC_PASSWORD}', '%SYNTHETIC_PASSWORD%', '{{password}}', '${USER}:${PASS}'];
const SPECIAL_VALUES = [
  'correct.horse.battery.staple', 'ya29.a0AfH6SMBsynthetic1234567890',
  'process.env.secret1234', 'Namespace1234.password', 'library.readPassword1234',
  'process.1234.value', 'process.abc1234def', 'unrecognised.lowercase.path',
  ...CODE_REFERENCES, ...CALLS, ...TYPES, ...PATHS, ...MASKS,
];
const WORDS = [...CREDENTIAL_WORDS, ...['account_key', 'cookie', 'set_cookie'].map(word => ({ word, strong: true }))];
const SPELLINGS = [...KEY_SPELLINGS,
  ...['_', '-', '.', ''].map(separator => ({ spelling: `unprefixed ${separator || 'joined'}`, key: (word: string) => word.replaceAll('_', separator) })),
  { spelling: 'unprefixed uppercase', key: (word: string) => word.toUpperCase() },
  { spelling: 'unprefixed camelCase', key: (word: string) => word.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase()) },
  { spelling: 'unprefixed PascalCase', key: (word: string) => word.split('_').map(part => part[0]!.toUpperCase() + part.slice(1)).join('') },
];
type Row = { label: string; text: string; word: string; quote: string; value: string };
const CORPUS: Row[] = WORDS.flatMap(({ word }) => SPELLINGS.flatMap(spelling => ASSIGNMENT_CONTEXTS.flatMap(context =>
  ['', '"', "'", '`'].flatMap(quote => Array.from({ length: 3 }, () => {
    const value = VALUES[Math.floor(random() * VALUES.length)]!;
    return { label: `${word} / ${spelling.spelling} / ${context.context} / ${quote || 'bare'}`, word, quote, value,
      text: context.render(spelling.key(word), quote + value + quote) };
  })),
)));
for (const { word } of WORDS) for (const context of ASSIGNMENT_CONTEXTS) for (const quote of ['', '"', "'", '`']) {
  for (const value of SPECIAL_VALUES) CORPUS.push({ label: `${word} / ${context.context} / ${quote || 'bare'} / ${value}`, word, quote, value,
    text: context.render(word, quote + value + quote) });
}

// Exceptions describe inputs, never the screen's result. Only documented false-positive classes are allowed;
// each lists existing expectation rows and a concrete witness tested below on BOTH screens. No dotted literal
// or arbitrary baseline loss may be added here to make this assertion pass.
const EXCEPTIONS = [
  { name: 'code references', rows: ['F1 ordinary prose: id_token: decoded.sub; set token: process.env.API_TOKEN',
    'G1 strong-key references: Namespace1.password', 'F1 value thresholds: token=process.env.API_TOKEN123'],
    witness: { word: 'password', quote: '', value: 'process.env.API_TOKEN' },
    matches: (row: Row) => (!row.quote || row.word === 'authorization') && CODE_REFERENCES.includes(row.value) },
  { name: 'calls and computed references', rows: ['F1 computed password; G1 strong-key references: readPassword()',
    'J1 exclusion: call suffix, call followed by literal, subscript suffix, optional member suffix'],
    witness: { word: 'password', quote: '', value: 'resolveAccessToken(input)' },
    matches: (row: Row) => !row.quote && CALLS.includes(row.value) },
  { name: 'generic-key identifiers', rows: ['F1 value thresholds: token: abcdefghijklmnop (quoted)',
    'F1 ordinary prose: authorization: authValue; pass token: tokenValue to helper', 'I1 generic thresholds: reviewonlypassword'],
    witness: { word: 'authorization', quote: '"', value: 'abcdefghijklmnop' },
    matches: (row: Row) => /^(?:authorization|auth|pwd|secret|token|credentials?)$/.test(row.word) && /^[A-Za-z_$][A-Za-z_$]*$/.test(row.value) },
  { name: 'primitive type names', rows: ['G1 strong-key references: string, number, bigint, boolean, symbol, object, undefined, null, any, unknown, never, void'],
    witness: { word: 'password', quote: '', value: 'undefined' },
    matches: (row: Row) => !row.quote && TYPES.includes(row.value) },
  { name: 'filesystem references', rows: ['J1 exclusion: absolute path, home path', 'F1 value thresholds: password=/tmp/canary123'],
    witness: { word: 'password', quote: '', value: '/tmp/syntheticcanary123' },
    matches: (row: Row) => !row.quote && PATHS.includes(row.value) },
  { name: 'whole placeholders', rows: ['J1 exclusion: all x suffix, dollar brace infix, percent name suffix, separator-only references',
    'F1 placeholders for every assignment quote and separator'],
    witness: { word: 'password', quote: '"', value: 'xxxxxxxxxxxxxxxx' },
    matches: (row: Row) => MASKS.includes(row.value) },
];

describe.each([['core', looksSecret], ['router', routerLooksSecret]] as const)('0.8.31 differential closure — %s', (screen, current) => {
  it.each(CLI_CREDENTIAL_CASES)('M1 CLI credential corpus | $tool | $label | $variant', ({ text, secret }) => {
    expect(current(text)).toBe(secret);
  });

  it.each(CLI_CREDENTIAL_NEGATIVES)('M1 CLI exclusion | %s', text => {
    expect(current(text)).toBe(false);
  });

  it.each(['PASSWORD=correct.horse.battery.staple', 'access_token=ya29.a0AfH6SMBsynthetic1234567890'])(
    'L1: preserves the baseline positive %s', text => {
      expect(baselineLooksSecret(text)).toBe(true);
      expect(current(text)).toBe(true);
    },
  );

  it.each(EXCEPTIONS)('keeps the documented $name witnesses negative', ({ rows, witness, matches }) => {
    expect(rows.length).toBeGreaterThan(0);
    const row = { ...witness, label: rows.join('; '), text: `${witness.word}=${witness.quote}${witness.value}${witness.quote}` };
    expect(matches(row)).toBe(true);
    expect(current(row.text), row.label).toBe(false);
  });

  it('loses no baseline positive outside the named false-positive classes', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(20_000);
    expect(new Set(CORPUS.map(row => row.text)).size).toBeGreaterThanOrEqual(20_000);
    let baselinePositives = 0, headPositives = 0;
    const exceptions = Object.fromEntries(EXCEPTIONS.map(({ name }) => [name, 0]));
    const losses: Row[] = [];
    for (const row of CORPUS) {
      const baseline = baselineLooksSecret(row.text), head = current(row.text);
      if (baseline) baselinePositives++;
      if (head) headPositives++;
      if (baseline && !head) {
        const exception = EXCEPTIONS.find(exception => exception.matches(row));
        if (exception) exceptions[exception.name]!++;
        else losses.push(row);
      }
    }
    console.info(JSON.stringify({ screen, seed: '0x0832', inputs: CORPUS.length, baselinePositives, headPositives,
      losses: losses.length, exceptedRows: Object.values(exceptions).reduce((sum, count) => sum + count, 0), exceptions }));
    expect(losses.slice(0, 20)).toEqual([]);
    expect(losses).toHaveLength(0);
  });
});
