import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueSlug } from '../src/unique-slug.mjs';

test('existing may be an array', () => {
  assert.equal(uniqueSlug('Hello World', ['hello-world']), 'hello-world-2');
});
