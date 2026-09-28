import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validateEmail } from '../src/email.mjs';

test('email: rejects an empty list', () => {
  assert.equal(validateEmail({ emails: [] }).ok, false);
});
test('email: accepts a populated list', () => {
  assert.equal(validateEmail({ emails: ['x'] }).ok, true);
});
