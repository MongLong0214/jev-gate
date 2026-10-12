import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvLine } from '../src/csv-parse.mjs';
import { slugify } from '../src/slugify.mjs';
import { uniqueSlug } from '../src/unique-slug.mjs';

test('korean is kept', () => {
  assert.equal(slugify('안녕 세상! 2026'), '안녕-세상-2026');
});

test('long slugs are cut at a boundary', () => {
  const s = slugify('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda');
  assert.ok(s.length <= 50 && !s.endsWith('-'));
  assert.equal(s, 'alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota');
});

test('quoted csv fields', () => {
  assert.deepEqual(parseCsvLine('a,"b,c","d""e"'), ['a', 'b,c', 'd"e']);
});

test('uniqueSlug takes the smallest free number', () => {
  assert.equal(uniqueSlug('Hello World', new Set()), 'hello-world');
  assert.equal(uniqueSlug('Hello World', new Set(['hello-world', 'hello-world-2'])), 'hello-world-3');
  assert.equal(uniqueSlug('Hello World', new Set(['hello-world', 'hello-world-3'])), 'hello-world-2');
});
