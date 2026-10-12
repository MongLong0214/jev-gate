import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../src/report.mjs';

test('plain rows', () => {
  assert.equal(toCsv([{ sku: 'A-1', qty: 3 }]), 'sku,qty\nA-1,3');
});
