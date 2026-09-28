import { strict as assert } from 'node:assert';
import test from 'node:test';

import { validateEmail } from '../src/email.mjs';

test('accepts a populated list', () => {
  assert.equal(validateEmail({ emails: ['a@b.c'] }).ok, true);
});
