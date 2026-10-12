import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.mjs';

test('english titles', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
});
